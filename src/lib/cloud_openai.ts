/**
 * OpenAI / Anthropic surface. Chat always goes through in-process
 * customTools on AgentService/Run (builtins off except MCP). Cloud REST is
 * models-only. InferenceService/Stream is dead for Dashboard keys.
 */
import { encodeSseData, encodeSseEvent, jsonResponse, sseStreamResponse } from "./bytes.ts";
import { credentialFingerprint } from "./auth.ts";
import {
  cloudApiKeyFromHeaders,
  listCloudModels,
  type CloudMcpServer,
  type CloudPrompt,
  type CloudRepo,
} from "./cloud_agents.ts";
import { startCloudRunWatch, watchOnDelta, type CloudRunWatch } from "./cloud_run_watch.ts";
import { extractCloudSessionRef, startCloudTurn } from "./cloud_session.ts";
import { handleCustomToolChatCompletions, handleCustomToolMessages, customToolChatClearForTests } from "./custom_tool_chat.ts";
import {
  anthropicToolsToCustom,
  clientToolsDisabled,
  customToolsClearForTests,
  openaiToolsToCustom,
  type CustomToolDef,
} from "./custom_tools.ts";
import { toAnthropicError } from "./inference.ts";
import type { Kv } from "./kv.ts";
import { resolveSessionMode } from "./session.ts";

const runWatches = new Map<string, CloudRunWatch>();

function watchKey(tenant: string, sessionId: string): string {
  return `${tenant}:${sessionId}`;
}

/** Test-only: drop parked customTools and Cloud run watches. */
export function cloudClientToolsClearForTests(): void {
  for (const watch of runWatches.values()) watch.abort();
  runWatches.clear();
  customToolsClearForTests();
  customToolChatClearForTests();
}

export function extractCloudAgentId(
  body: Record<string, unknown> | null | undefined,
  headers?: Headers,
): string | undefined {
  const ref = extractCloudSessionRef(body, headers);
  return ref?.kind === "agent" ? ref.agentId : undefined;
}

export function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec.role !== "user") continue;
    if (Array.isArray(rec.content) && rec.content.some((b) => b && typeof b === "object" && String((b as Record<string, unknown>).type || "") === "tool_result")) {
      continue;
    }
    const text = contentToText(rec.content);
    if (text) return text;
  }
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (!p || typeof p !== "object") return "";
      const rec = p as Record<string, unknown>;
      if (typeof rec.text === "string") return rec.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function flattenMessagesForCreate(messages: unknown[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = String(rec.role || "");
    if (role === "tool" || role === "function") continue;
    if (Array.isArray(rec.content) && rec.content.every((b) => b && typeof b === "object" && String((b as Record<string, unknown>).type || "") === "tool_result")) {
      continue;
    }
    const text = contentToText(rec.content);
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }
  return lines.join("\n\n") || lastUserText(messages);
}

export function extractCloudPromptImages(messages: unknown[]): NonNullable<CloudPrompt["images"]> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (String(rec.role || "") !== "user" || !Array.isArray(rec.content)) continue;
    const images: NonNullable<CloudPrompt["images"]> = [];
    for (const part of rec.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const type = String(p.type || "");
      if (type === "image_url" || type === "input_image") {
        const imageUrl = p.image_url;
        const url =
          typeof imageUrl === "string"
            ? imageUrl
            : imageUrl && typeof imageUrl === "object"
              ? String((imageUrl as Record<string, unknown>).url || "")
              : String(p.url || "");
        const parsed = parseImageRef(url);
        if (parsed) images.push(parsed);
      } else if (type === "image") {
        const source = p.source && typeof p.source === "object" ? (p.source as Record<string, unknown>) : p;
        const srcType = String(source.type || "");
        if (srcType === "url" || source.url) {
          const parsed = parseImageRef(String(source.url || ""));
          if (parsed) images.push(parsed);
        } else if (srcType === "base64" || source.data) {
          const mime = String(source.media_type || source.mediaType || source.mimeType || "image/png");
          const data = String(source.data || "").replace(/^data:[^;]+;base64,/, "");
          if (data) images.push({ data, mimeType: mime });
        }
      }
    }
    if (images.length) return images;
  }
  return undefined;
}

function parseImageRef(raw: string): { url: string } | { data: string; mimeType: string } | undefined {
  const url = raw.trim();
  if (!url) return undefined;
  const data = /^data:([^;]+);base64,(.+)$/i.exec(url);
  if (data) {
    if (data[2].length > 14_000_000) return undefined;
    return { data: data[2], mimeType: data[1] };
  }
  if (/^https?:\/\//i.test(url)) return { url };
  return undefined;
}

export function promptFromMessages(messages: unknown[], followUp: boolean, policy = ""): CloudPrompt {
  const text = followUp ? lastUserText(messages) : flattenMessagesForCreate(messages);
  const body = [policy, text || "(empty)"].filter(Boolean).join("\n\n");
  const images = extractCloudPromptImages(messages);
  return images?.length ? { text: body, images } : { text: body };
}

export function extractMcpServers(body: Record<string, unknown>): CloudMcpServer[] | undefined {
  const bags = [body, body.extra_body, body.metadata];
  for (const bag of bags) {
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
    const rec = bag as Record<string, unknown>;
    const raw = rec.mcpServers ?? rec.mcp_servers;
    if (Array.isArray(raw) && raw.length) return raw as CloudMcpServer[];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return Object.entries(raw as Record<string, CloudMcpServer>).map(([name, cfg]) => ({ ...cfg, name: cfg.name || name }));
    }
  }
  return undefined;
}

export function extractRepos(body: Record<string, unknown>): CloudRepo[] | undefined {
  const extra = body.extra_body;
  const rec =
    extra && typeof extra === "object" && !Array.isArray(extra)
      ? (extra as Record<string, unknown>)
      : body;
  const repos = rec.repos;
  if (!Array.isArray(repos) || repos.length === 0) return undefined;
  return repos as CloudRepo[];
}

export function cloudModelSelection(
  model: unknown,
  body?: Record<string, unknown>,
  hasClientTools = false,
): { id: string; params?: Array<{ id: string; value: string }> } | undefined {
  const id = String(model ?? "").trim();
  if (!id || id === "default" || id === "auto") return undefined;
  const suffixFast = /(-fast)$/i.test(id) || body?.fast === true;
  const base = id.replace(/-fast$/i, "");
  const grok = /grok/i.test(base);
  const composer = /^composer-/i.test(base);
  const fast = suffixFast || (hasClientTools && grok);
  // Composer’s omitted `fast` param defaults to true on Agent/Cloud APIs.
  if (composer || grok || suffixFast) {
    return { id: base, params: [{ id: "fast", value: fast ? "true" : "false" }] };
  }
  return { id };
}

function clientToolDefs(body: Record<string, unknown>, anthropic: boolean): CustomToolDef[] {
  if (clientToolsDisabled(body)) return [];
  return anthropic ? anthropicToolsToCustom(body.tools) : openaiToolsToCustom(body.tools);
}

function openAiCompletion(opts: {
  model: unknown;
  agentId: string;
  sessionId?: string;
  text: string;
  error?: string;
  thinking?: string;
}) {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: opts.text || "",
  };
  if (opts.thinking) message.reasoning_content = opts.thinking;
  return {
    id: opts.agentId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(opts.model || "composer-2.5"),
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
    cursor_agent_id: opts.agentId,
    conversation_id: opts.sessionId || opts.agentId,
    error: opts.error ? { message: opts.error, type: "api_error" } : undefined,
  };
}

function attachWatch(tenant: string, sessionId: string, apiKey: string, agentId: string, runId: string): CloudRunWatch {
  const key = watchKey(tenant, sessionId);
  const prev = runWatches.get(key);
  if (prev && prev.runId === runId) return prev;
  prev?.abort();
  const watch = startCloudRunWatch({ apiKey, agentId, runId });
  runWatches.set(key, watch);
  void watch.waitFinished().then(() => {
    if (runWatches.get(key) === watch) runWatches.delete(key);
  });
  return watch;
}

async function startCloudTurnFromBody(
  apiKey: string,
  kv: Kv,
  body: Record<string, unknown>,
  headers: Headers,
  signal?: AbortSignal,
): Promise<{
  agentId: string;
  runId: string;
  sessionId?: string;
  reused: boolean;
  tenant: string;
  watch: CloudRunWatch;
}> {
  const tenant = await credentialFingerprint(apiKey);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const turn = await startCloudTurn({
    apiKey,
    kv,
    body,
    headers,
    promptCreate: promptFromMessages(messages, false),
    promptFollowUp: promptFromMessages(messages, true),
    mcpServers: extractMcpServers(body),
    model: cloudModelSelection(body.model, body, false),
    repos: extractRepos(body),
    signal,
  });
  const sid = turn.sessionId || turn.agentId;
  const watch = attachWatch(tenant, sid, apiKey, turn.agentId, turn.runId);
  console.log(
    `  cloud_session ${turn.reused ? "hit" : "miss"} session=${(turn.sessionId || "none").slice(0, 24)} agent=${turn.agentId.slice(0, 14)}`,
  );
  return { ...turn, tenant, watch, sessionId: turn.sessionId || sid };
}

export { CloudChatError, isCloudChatError } from "./cloud_errors.ts";

export async function handleCloudModels(
  headers: Headers,
  anthropic: boolean,
  requestId: string,
  signal?: AbortSignal,
): Promise<Response> {
  const apiKey = cloudApiKeyFromHeaders(headers);
  const listed = await listCloudModels(apiKey, signal);
  const ids = (listed.items || []).map((m) => m.id).filter(Boolean);
  if (anthropic) {
    return jsonResponse(
      200,
      {
        data: ids.map((id) => ({
          id,
          created_at: "1970-01-01T00:00:00Z",
          display_name: id,
          type: "model",
        })),
        first_id: ids[0] ?? null,
        has_more: false,
        last_id: ids.at(-1) ?? null,
      },
      requestId,
    );
  }
  return jsonResponse(200, {
    object: "list",
    data: ids.map((id) => ({ id, object: "model", owned_by: "cursor" })),
  });
}

function rejectRandomSession(): Response | undefined {
  if (resolveSessionMode() !== "random") return undefined;
  return jsonResponse(400, {
    error: {
      message: "customTools require a stable session id (x-session-id / conversation_id). SESSION_MODE=random cannot park execute() across turns.",
      type: "invalid_request_error",
      code: "session_required_for_client_tools",
    },
  });
}

export async function handleCloudChatCompletions(
  headers: Headers,
  body: Record<string, unknown>,
  _kv: Kv,
  opts: { signal?: AbortSignal },
): Promise<Response> {
  const rejected = rejectRandomSession();
  if (rejected) return rejected;
  const tools = clientToolDefs(body, false);
  return handleCustomToolChatCompletions({ headers, body, tools, signal: opts.signal });
}

export async function handleCloudMessages(
  headers: Headers,
  body: Record<string, unknown>,
  requestId: string,
  _kv: Kv,
  opts: { signal?: AbortSignal },
): Promise<Response> {
  if (resolveSessionMode() === "random") {
    return jsonResponse(
      400,
      toAnthropicError(
        {
          message: "customTools require a stable session id (x-session-id / conversation_id). SESSION_MODE=random cannot park execute() across turns.",
          type: "invalid_request_error",
        },
        requestId,
      ),
      requestId,
    );
  }
  const tools = clientToolDefs(body, true);
  return handleCustomToolMessages({ headers, body, tools, requestId, signal: opts.signal });
}

function streamCloudAsOpenAiSse(opts: {
  watch: CloudRunWatch;
  model: unknown;
  agentId: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { watch, model, agentId, sessionId } = opts;
  const created = Math.floor(Date.now() / 1000);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        encodeSseData({
          id: agentId,
          object: "chat.completion.chunk",
          created,
          model: String(model || "composer-2.5"),
          choices: [{ index: 0, delta, finish_reason: finish }],
          cursor_agent_id: agentId,
          conversation_id: sessionId || agentId,
        });
      const unsub = watchOnDelta(watch, (delta) => {
        if (delta.text) controller.enqueue(chunk({ content: delta.text }));
        if (delta.thinking) controller.enqueue(chunk({ reasoning_content: delta.thinking }));
      });
      try {
        controller.enqueue(chunk({ role: "assistant" }));
        await watch.waitFinished();
        if (watch.error) {
          controller.enqueue(
            encodeSseData({
              id: agentId,
              object: "chat.completion.chunk",
              created,
              model: String(model || "composer-2.5"),
              choices: [],
              error: { message: watch.error, type: "api_error" },
            }),
          );
        }
        controller.enqueue(chunk({}, "stop"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encodeSseData({
            id: agentId,
            object: "chat.completion.chunk",
            created,
            model: String(model || "composer-2.5"),
            choices: [],
            error: { message, type: "api_error" },
          }),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      } finally {
        unsub();
        controller.close();
      }
    },
  });
  return Promise.resolve(sseStreamResponse(stream));
}

function streamCloudAsAnthropicSse(opts: {
  watch: CloudRunWatch;
  model: unknown;
  agentId: string;
  sessionId?: string;
  requestId: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { watch, model, agentId, requestId } = opts;
  const msgId = `msg_${agentId}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let textOpen = false;
      const openText = () => {
        if (textOpen) return;
        textOpen = true;
        controller.enqueue(
          encodeSseEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        );
      };
      const unsub = watchOnDelta(watch, (delta) => {
        if (!delta.text) return;
        openText();
        controller.enqueue(
          encodeSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta.text },
          }),
        );
      });
      try {
        controller.enqueue(
          encodeSseEvent("message_start", {
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              model: String(model || "composer-2.5"),
              content: [],
            },
          }),
        );
        await watch.waitFinished();
        if (textOpen) {
          controller.enqueue(encodeSseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
        }
        controller.enqueue(encodeSseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }));
        controller.enqueue(encodeSseEvent("message_stop", { type: "message_stop" }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encodeSseEvent("error", toAnthropicError({ message, type: "api_error" }, requestId)));
      } finally {
        unsub();
        controller.close();
      }
    },
  });
  return Promise.resolve(sseStreamResponse(stream, requestId));
}

export function cloudHealthBody() {
  return {
    ok: true,
    rpc: "agent.v1.AgentService/Run (customTools only)",
    modes: ["/v1/chat/completions", "/v1/messages"],
    auth: "Authorization Bearer Cursor API key",
    tools: 'AgentService tools: ["mcp"] only — OpenAI/Anthropic function tools as customTools.execute (parked); no shell/edit/grep; not HTTP MCP; not InferenceService; not @cursor/sdk; not SDK/agent binaries; not Cloud Agents sandbox VM',
    models: "GET https://api.cursor.com/v1/models",
    session: "stable x-session-id parks customTools.execute across turns",
  };
}
