/**
 * Cursor 生图（稳定接口层）
 *
 * 实测（2026-08，api2 + 本机 Cursor 登录 JWT）：
 * - **无**独立可用的 `GenerateImage` Unary（`/agent.v1.AgentService/GenerateImage` → 464）。
 * - **可稳定拿到** `generate_image` tool_call：`InferenceService/Stream` + `grok-4.6`（或 composer 系）+ tools。
 * - **服务端执行生图**仍在 Cursor Agent 运行时内；仅 Inference 回传 tool_call，不会自动返回 image bytes。
 * - **云产物下载**（Background Composer artifact）：`BackgroundComposerService/*`，需有效 `bcId` + `absolutePath`。
 *
 * 鉴权：`resolveCursorAccessToken({ preferApiKey: true })` — 优先 `CURSOR_API_KEY`，否则读 `state.vscdb`。
 */

import { connectUnary } from "./auth.ts";
import {
  cursorBody,
  inferenceStream,
  parseArgs,
  ROLE,
  collectTurn,
  type CursorTool,
  type MergedToolCall,
} from "./inference.ts";
import { resolveCursorAccessToken, type ResolvedCursorAccess } from "./cursor_credentials.ts";
import { generateImagePipeline } from "./cursor_generate_image_pipeline.ts";
import { buildIdeClientContext, ideConnectHeaders } from "./cursor_ide_client.ts";
import { CURSOR_BASE } from "./auth.ts";
import { encodeConnectFrame, decodeConnectFrames, bytesBody } from "./bytes.ts";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";
export const CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE = 53;
export const DEFAULT_IMAGE_MODEL = "grok-4.6";

export type GenerateImageArgs = {
  description: string;
  filePath?: string;
  referenceImagePaths?: string[];
};

export type GenerateImageSuccess = {
  filePath?: string;
  imageDataBase64?: string;
  mimeType?: string;
};

export type ImageGenerateStatus =
  | "tool_call"
  | "completed"
  | "artifact_pending"
  | "failed";

export type GenerateImageResult = {
  status: ImageGenerateStatus;
  conversationId: string;
  toolCall?: MergedToolCall;
  args?: GenerateImageArgs;
  success?: GenerateImageSuccess;
  artifact?: { bcId: string; absolutePath: string; downloadUrl?: string };
  error?: string;
  credentialSource?: ResolvedCursorAccess["source"];
};

export function normalizeGenerateImageArgs(raw: Record<string, unknown>): GenerateImageArgs {
  const description = String(
    raw.description ?? raw.prompt ?? raw.text ?? "",
  ).trim();
  const filePath = raw.file_path ?? raw.filePath ?? raw.path ?? raw.filename;
  const refs = raw.reference_image_paths ?? raw.referenceImagePaths ?? raw.reference_images;
  const referenceImagePaths = Array.isArray(refs)
    ? refs.map((x) => String(x))
    : refs
      ? [String(refs)]
      : undefined;
  return {
    description,
    filePath: filePath != null ? String(filePath) : undefined,
    referenceImagePaths,
  };
}

export function generateImageToolDefinition(): CursorTool {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    description:
      "Generate an image from a text description. Use for icons, mockups, diagrams. Args: description (required), file_path optional under assets/.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "What to draw" },
        prompt: { type: "string", description: "Alias for description" },
        file_path: { type: "string", description: "e.g. assets/out.png" },
        filePath: { type: "string" },
      },
      required: ["description"],
    },
  };
}

function buildUserPrompt(args: GenerateImageArgs): string {
  const path = args.filePath ? ` Save to ${args.filePath}.` : "";
  return `Use the ${GENERATE_IMAGE_TOOL_NAME} tool only: ${args.description}.${path}`;
}

function assistantToolMessage(call: MergedToolCall) {
  return {
    role: ROLE.assistant,
    toolCalls: [
      {
        toolCallId: call.id,
        toolName: call.name,
        args: parseArgs(call.args),
      },
    ],
  };
}

function scanFramesForImagePayload(frames: { json: Record<string, unknown> | null }[]): GenerateImageSuccess | undefined {
  for (const frame of frames) {
    const j = frame.json;
    if (!j) continue;
    const blob = JSON.stringify(j);
    const m = blob.match(/"imageData"\s*:\s*"([^"]{100,})"/) || blob.match(/"image_data"\s*:\s*"([^"]{100,})"/);
    if (m) {
      return { imageDataBase64: m[1], filePath: undefined };
    }
    const fp = blob.match(/"filePath"\s*:\s*"([^"]+)"/) || blob.match(/"file_path"\s*:\s*"([^"]+)"/);
    if (fp && (blob.includes("generate") || blob.includes("image"))) {
      return { filePath: fp[1] };
    }
  }
  return undefined;
}

/** 第一步：Inference 请求，拿到 generate_image tool_call */
export async function requestGenerateImageToolCall(
  accessToken: string,
  args: GenerateImageArgs,
  opts?: { model?: string; conversationId?: string },
): Promise<{ conversationId: string; toolCall: MergedToolCall }> {
  const conversationId = opts?.conversationId || crypto.randomUUID();
  const tools = [generateImageToolDefinition()];
  const body = cursorBody({
    messages: [{ role: ROLE.user, text: buildUserPrompt(args) }],
    tools,
    conversationId,
    model: opts?.model || DEFAULT_IMAGE_MODEL,
    injectToolsPrompt: false,
  });
  const turn = await inferenceStream(accessToken, body, { sessionId: conversationId });
  const toolCall = (turn.toolCalls || []).find((c) => c.name === GENERATE_IMAGE_TOOL_NAME);
  if (!toolCall) {
    throw new Error(
      `Model did not return ${GENERATE_IMAGE_TOOL_NAME} (model=${opts?.model || DEFAULT_IMAGE_MODEL}, text=${(turn.text || "").slice(0, 120)})`,
    );
  }
  return { conversationId, toolCall };
}

/**
 * 尝试第二轮 Inference（提交 assistant tool_call + 空 tool result），探测服务端是否回填 image。
 * 目前多数账号仍只返回再次 tool_call → status `tool_call`。
 */
export async function continueAfterToolCall(
  accessToken: string,
  conversationId: string,
  userPrompt: string,
  toolCall: MergedToolCall,
  opts?: { model?: string },
): Promise<GenerateImageResult> {
  const tools = [generateImageToolDefinition()];
  const body = cursorBody({
    messages: [
      { role: ROLE.user, text: userPrompt },
      assistantToolMessage(toolCall),
      {
        role: ROLE.tool,
        toolContent: {
          parts: [
            {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: "",
              isError: false,
            },
          ],
        },
      },
    ],
    tools,
    conversationId,
    model: opts?.model || DEFAULT_IMAGE_MODEL,
    injectToolsPrompt: false,
  });
  const turn = await inferenceStream(accessToken, body, { sessionId: conversationId });
  const err = turn.frames?.find((f) => f.json?.error);
  if (err?.json?.error) {
    return {
      status: "failed",
      conversationId,
      toolCall,
      error: JSON.stringify(err.json.error),
    };
  }
  const success = scanFramesForImagePayload(turn.frames || []);
  if (success?.imageDataBase64 || success?.filePath) {
    return { status: "completed", conversationId, toolCall, success };
  }
  const again = (turn.toolCalls || []).find((c) => c.name === GENERATE_IMAGE_TOOL_NAME);
  return {
    status: "tool_call",
    conversationId,
    toolCall: again || toolCall,
    args: normalizeGenerateImageArgs(parseArgs((again || toolCall).args)),
  };
}

// --- Background Composer artifact（逆向确认，需 bcId）---

export const BACKGROUND_COMPOSER_RPC = {
  listArtifacts: "/aiserver.v1.BackgroundComposerService/ListBackgroundComposerArtifacts",
  getArtifactUrl: "/aiserver.v1.BackgroundComposerService/GetBackgroundComposerArtifact",
  getArtifactBytes: "/aiserver.v1.BackgroundComposerService/GetBackgroundComposerArtifactBytes",
} as const;

function artifactBodies(bcId: string, absolutePath: string): Record<string, string>[] {
  return [
    { bcId, absolutePath },
    { bc_id: bcId, absolute_path: absolutePath },
  ];
}

async function connectFirstOk(
  path: string,
  accessToken: string,
  bodies: Record<string, string>[],
) {
  let last = await connectUnary(path, accessToken, bodies[0]);
  for (let i = 1; i < bodies.length && !last.ok; i++) {
    last = await connectUnary(path, accessToken, bodies[i]);
  }
  return last;
}

export async function getBackgroundComposerArtifactUrl(
  accessToken: string,
  bcId: string,
  absolutePath: string,
): Promise<{ status: number; url?: string }> {
  const r = await connectFirstOk(
    BACKGROUND_COMPOSER_RPC.getArtifactUrl,
    accessToken,
    artifactBodies(bcId, absolutePath),
  );
  const url = String(r.json?.url ?? r.json?.presignedUrl ?? "");
  return { status: r.status, url: url || undefined };
}

export async function getBackgroundComposerArtifactBytes(
  accessToken: string,
  bcId: string,
  absolutePath: string,
): Promise<{ status: number; contentType?: string; bytes?: Uint8Array }> {
  const r = await connectFirstOk(
    BACKGROUND_COMPOSER_RPC.getArtifactBytes,
    accessToken,
    artifactBodies(bcId, absolutePath),
  );
  const content = r.json?.content;
  const contentType = r.json?.contentType != null ? String(r.json.contentType) : undefined;
  let bytes: Uint8Array | undefined;
  if (typeof content === "string") {
    bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  }
  return { status: r.status, contentType, bytes };
}

export type GenerateImageOptions = {
  description: string;
  filePath?: string;
  referenceImagePaths?: string[];
  model?: string;
  apiKey?: string;
  preferApiKey?: boolean;
  /** auto: pipeline → agent → inference */
  mode?: "auto" | "agent" | "inference" | "pipeline";
  bcId?: string;
  tryContinue?: boolean;
};

async function requestGenerateImageToolCallIde(
  accessToken: string,
  args: GenerateImageArgs,
  opts: { model?: string; conversationId?: string } = {},
) {
  const conversationId = opts.conversationId || crypto.randomUUID();
  const ide = buildIdeClientContext(accessToken);
  const body = cursorBody({
    messages: [{ role: ROLE.user, text: buildUserPrompt(args) }],
    tools: [generateImageToolDefinition()],
    model: opts.model || DEFAULT_IMAGE_MODEL,
    conversationId,
  });
  const payload = encodeConnectFrame(body);
  const res = await fetch(`${CURSOR_BASE}/aiserver.v1.InferenceService/Stream`, {
    method: "POST",
    headers: {
      ...ideConnectHeaders(ide),
      "content-type": "application/connect+json",
      "connect-content-encoding": "gzip",
      "connect-accept-encoding": "gzip",
      "x-session-id": conversationId,
    },
    body: bytesBody(payload),
  });
  const frames = await decodeConnectFrames(new Uint8Array(await res.arrayBuffer()));
  const turn = collectTurn(frames);
  const toolCall = (turn.toolCalls || []).find((c) => c.name === GENERATE_IMAGE_TOOL_NAME);
  if (!toolCall) throw new Error("IDE inference stream did not return generate_image tool_call");
  return { conversationId, toolCall, turn, frames };
}

/**
 * 统一入口：凭证 →（可选）Agent 流 → Inference（IDE 头）→ continue 探测 → artifact
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const args = normalizeGenerateImageArgs({
    description: opts.description,
    file_path: opts.filePath,
    reference_image_paths: opts.referenceImagePaths,
  });
  if (!args.description) throw new Error("description is required");

  const mode = opts.mode ?? "auto";

  if (mode === "pipeline" || mode === "auto") {
    try {
      const piped = await generateImagePipeline(opts);
      if (piped.status === "completed" || mode === "pipeline") return piped;
    } catch {
      if (mode === "pipeline") throw new Error("pipeline failed");
    }
  }

  if (mode === "agent" || mode === "auto") {
    const { generateImageViaAgentStream } = await import("./cursor_agent_image.ts");
    const agent = await generateImageViaAgentStream({
      description: args.description,
      filePath: args.filePath,
      model: opts.model,
    });
    if (agent && agent.status !== "failed") return agent;
    if (mode === "agent") return agent || { status: "failed", conversationId: "", error: "agent bridge failed" };
  }

  const { accessToken, source } = await resolveCursorAccessToken({
    apiKey: opts.apiKey,
    preferApiKey: opts.preferApiKey,
  });

  let conversationId: string;
  let toolCall: MergedToolCall;
  try {
    const ideTurn = await requestGenerateImageToolCallIde(accessToken, args, { model: opts.model });
    conversationId = ideTurn.conversationId;
    toolCall = ideTurn.toolCall;
  } catch {
    const sdkTurn = await requestGenerateImageToolCall(accessToken, args, { model: opts.model });
    conversationId = sdkTurn.conversationId;
    toolCall = sdkTurn.toolCall;
  }

  let result: GenerateImageResult = {
    status: "tool_call",
    conversationId,
    toolCall,
    args: normalizeGenerateImageArgs(parseArgs(toolCall.args)),
    credentialSource: source,
  };

  if (opts.tryContinue !== false) {
    result = await continueAfterToolCall(
      accessToken,
      conversationId,
      buildUserPrompt(args),
      toolCall,
      { model: opts.model },
    );
    result.credentialSource = source;
  }

  if (opts.bcId && args.filePath && result.status !== "completed") {
    const art = await getBackgroundComposerArtifactUrl(accessToken, opts.bcId, args.filePath);
    if (art.url) {
      result.status = "artifact_pending";
      result.artifact = { bcId: opts.bcId, absolutePath: args.filePath, downloadUrl: art.url };
    }
  }

  return result;
}

// --- CLI ---

import { fileURLToPath } from "node:url";

async function main() {
  const description = process.argv.slice(2).join(" ") || "a flat red circle icon on white background";
  const res = await generateImage({
    description,
    filePath: "assets/cursor-gen-test.png",
    tryContinue: true,
  });
  console.log(JSON.stringify(res, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
