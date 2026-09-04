import { connectUnary, getAccessToken, modelsFrom, AuthError, type GatewayCtx } from "./auth.ts";
import { corsResponse, jsonResponse, randomId } from "./bytes.ts";
import {
  anthropicToCursor,
  anthropicToolsToCursor,
  countCursorMediaParts,
  cursorBodyFromClient,
  extractFastMode,
  extractReasoningEffort,
  resolveCursorModelRoute,
  upgradeGrokRouteForTools,
  openaiProviderDefinedTools,
  inferenceStream,
  ImageInputError,
  openaiMessagesToCursor,
  openaiToolsToCursor,
  streamOpenAiChatCompletion,
  streamAnthropicMessage,
  toAnthropicError,
  toAnthropicMessage,
  toOpenAICompletion,
  toolCallsToOpenAI,
  type CursorMessage,
  type CursorTool,
} from "./inference.ts";
import { resolveSessionForRequest } from "./session.ts";

type PreparedChat = {
  messages: CursorMessage[];
  tools: CursorTool[];
  conversationId: string;
  conversationGroupId: string;
  sessionId: string;
  clientId: string;
  messagesPipelined: boolean;
};

async function prepareChatTurn(
  body: Record<string, unknown>,
  tenant: string,
  rawMessages: unknown[],
  tools: CursorTool[],
  preconvertedMessages?: CursorMessage[],
): Promise<PreparedChat> {
  const session = await resolveSessionForRequest(tenant, rawMessages, {
    body,
    tools,
    preconvertedMessages,
  });

  if (session.mode === "fingerprint") {
    console.log(
      `  session_mode=fingerprint session_fp=${session.session_fp.slice(0, 16)}… canon_len=${session.canon_len}`,
    );
    const cursorId = `${tenant}:${session.session_fp}`;
    return {
      messages: session.canon,
      tools: session.tools,
      conversationId: cursorId,
      conversationGroupId: cursorId,
      sessionId: cursorId,
      clientId: session.session_fp,
      messagesPipelined: true,
    };
  }

  const messages = preconvertedMessages ?? (await openaiMessagesToCursor(rawMessages));
  console.log(`  session_mode=random id=${session.clientId.slice(0, 8)}…`);
  const cursorId = `${tenant}:${session.clientId}`;
  return {
    messages,
    tools,
    conversationId: cursorId,
    conversationGroupId: cursorId,
    sessionId: cursorId,
    clientId: session.clientId,
    messagesPipelined: false,
  };
}

class RequestInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RequestInputError";
  }
}

const ANTHROPIC_MAX_BODY_BYTES = 32 * 1024 * 1024;

async function readJson(request: Request, maxBytes?: number): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (maxBytes != null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestInputError("Request exceeds the 32 MB Messages API limit", 413);
  }
  const text = await request.text();
  if (maxBytes != null && new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RequestInputError("Request exceeds the 32 MB Messages API limit", 413);
  }
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RequestInputError("Request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof RequestInputError) throw err;
    throw new RequestInputError("Request body contains invalid JSON");
  }
}

function anthropicReasoningEffort(body: Record<string, unknown>): string | undefined {
  const thinking = body.thinking as Record<string, unknown> | undefined;
  if (!thinking || thinking.type === "disabled") return undefined;
  const configured = extractReasoningEffort(body);
  if (configured != null) return String(configured);
  const budget = Number(thinking.budget_tokens ?? thinking.budgetTokens);
  if (!Number.isFinite(budget)) return thinking.type === "enabled" || thinking.type === "adaptive" ? "high" : undefined;
  if (budget < 4_096) return "low";
  if (budget < 12_000) return "medium";
  if (budget < 32_000) return "high";
  return "xhigh";
}

export function validateAnthropicRequest(body: Record<string, unknown>): void {
  if (typeof body.model !== "string" || !body.model.trim()) throw new RequestInputError("model is required");
  if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    throw new RequestInputError("max_tokens is required and must be a positive integer; cache prewarming with 0 is not supported");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestInputError("messages is required and must be a non-empty array");
  }
  if (body.stream != null && typeof body.stream !== "boolean") throw new RequestInputError("stream must be a boolean");
  if (body.stop_sequences != null && (!Array.isArray(body.stop_sequences) || body.stop_sequences.some((value) => typeof value !== "string"))) {
    throw new RequestInputError("stop_sequences must be an array of strings");
  }
  if (body.system != null && typeof body.system !== "string" && !Array.isArray(body.system)) {
    throw new RequestInputError("system must be a string or content block array");
  }
  if (Array.isArray(body.system)) {
    for (const [index, rawBlock] of body.system.entries()) {
      if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) {
        throw new RequestInputError(`system.${index} must be an object`);
      }
      const block = rawBlock as Record<string, unknown>;
      if (block.type !== "text" || typeof block.text !== "string") {
        throw new RequestInputError(`system.${index} must be a text block`);
      }
    }
  }
  const thinking = body.thinking;
  if (thinking != null) {
    if (typeof thinking !== "object" || Array.isArray(thinking)) throw new RequestInputError("thinking must be an object");
    const thinkingRecord = thinking as Record<string, unknown>;
    const type = String(thinkingRecord.type || "");
    if (!["enabled", "adaptive", "disabled"].includes(type)) throw new RequestInputError("thinking.type must be enabled, adaptive, or disabled");
    if (thinkingRecord.budget_tokens != null && (!Number.isInteger(Number(thinkingRecord.budget_tokens)) || Number(thinkingRecord.budget_tokens) < 1_024)) {
      throw new RequestInputError("thinking.budget_tokens must be an integer of at least 1024");
    }
  }
  const toolChoice = body.tool_choice;
  if (toolChoice != null) {
    if (typeof toolChoice !== "object" || Array.isArray(toolChoice)) throw new RequestInputError("tool_choice must be an object");
    const choiceRecord = toolChoice as Record<string, unknown>;
    const type = String(choiceRecord.type || "");
    if (!["auto", "any", "tool", "none"].includes(type)) throw new RequestInputError("tool_choice.type must be auto, any, tool, or none");
    if (type === "tool" && (typeof choiceRecord.name !== "string" || !choiceRecord.name)) {
      throw new RequestInputError("tool_choice.name is required when type is tool");
    }
  }
  for (const [key, min, max] of [["temperature", 0, 1], ["top_p", 0, 1]] as const) {
    if (body[key] == null) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new RequestInputError(`${key} must be between ${min} and ${max}`);
    }
  }
  if (body.n != null) throw new RequestInputError("n is not a valid Anthropic Messages API field");
  if (body.top_k != null) throw new RequestInputError("top_k is not supported by Cursor Inference");
  for (const key of ["container", "context_management", "service_tier"] as const) {
    if (body[key] != null) throw new RequestInputError(`${key} is not supported by Cursor Inference`);
  }
  for (const [index, raw] of body.messages.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RequestInputError(`messages.${index} must be an object`);
    const message = raw as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") {
      throw new RequestInputError(`messages.${index}.role must be user or assistant`);
    }
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      throw new RequestInputError(`messages.${index}.content must be a string or content block array`);
    }
    if (!Array.isArray(message.content)) continue;
    for (const [blockIndex, rawBlock] of message.content.entries()) {
      if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) {
        throw new RequestInputError(`messages.${index}.content.${blockIndex} must be an object`);
      }
      const block = rawBlock as Record<string, unknown>;
      const type = String(block.type || "");
      const path = `messages.${index}.content.${blockIndex}`;
      const allowed = message.role === "assistant"
        ? ["text", "tool_use", "thinking", "redacted_thinking"]
        : ["text", "image", "document", "tool_result"];
      if (!allowed.includes(type)) {
        throw new RequestInputError(`${path} type ${type || "<missing>"} is not supported by Cursor Inference`);
      }
      if (type === "text" && typeof block.text !== "string") throw new RequestInputError(`${path}.text is required`);
      if (type === "tool_use") {
        if (typeof block.id !== "string" || !block.id) throw new RequestInputError(`${path}.id is required`);
        if (typeof block.name !== "string" || !block.name) throw new RequestInputError(`${path}.name is required`);
        if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) throw new RequestInputError(`${path}.input must be an object`);
      }
      if (type === "tool_result") {
        if (typeof block.tool_use_id !== "string" || !block.tool_use_id) {
          throw new RequestInputError(`${path}.tool_use_id is required`);
        }
        if (block.content != null && typeof block.content !== "string" && !Array.isArray(block.content)) {
          throw new RequestInputError(`${path}.content must be a string or content block array`);
        }
        if (Array.isArray(block.content)) {
          for (const [innerIndex, rawInner] of block.content.entries()) {
            if (!rawInner || typeof rawInner !== "object" || Array.isArray(rawInner)) {
              throw new RequestInputError(`${path}.content.${innerIndex} must be an object`);
            }
            const inner = rawInner as Record<string, unknown>;
            const innerType = String(inner.type || "");
            const innerPath = `${path}.content.${innerIndex}`;
            if (!["text", "image", "document"].includes(innerType)) {
              throw new RequestInputError(`${innerPath} type ${innerType || "<missing>"} is not supported by Cursor Inference`);
            }
            if (innerType === "text" && typeof inner.text !== "string") throw new RequestInputError(`${innerPath}.text is required`);
            if ((innerType === "image" || innerType === "document") && (!inner.source || typeof inner.source !== "object" || Array.isArray(inner.source))) {
              throw new RequestInputError(`${innerPath}.source is required`);
            }
          }
        }
      }
      if ((type === "image" || type === "document") && (!block.source || typeof block.source !== "object" || Array.isArray(block.source))) {
        throw new RequestInputError(`${path}.source is required`);
      }
      if (type === "thinking" && (typeof block.thinking !== "string" || typeof block.signature !== "string")) {
        throw new RequestInputError(`${path} must include thinking and signature strings`);
      }
      if (type === "redacted_thinking" && typeof block.data !== "string") throw new RequestInputError(`${path}.data is required`);
    }
  }
  if (body.tools != null && !Array.isArray(body.tools)) throw new RequestInputError("tools must be an array");
  if (Array.isArray(body.tools)) {
    const toolNames = new Set<string>();
    for (const [index, raw] of body.tools.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RequestInputError(`tools.${index} must be an object`);
      const tool = raw as Record<string, unknown>;
      const type = String(tool.type || "custom").toLowerCase();
      if (type !== "custom" && type !== "function") {
        throw new RequestInputError(`Anthropic server tool ${type} is not supported because Cursor does not expose its result blocks`);
      }
      if (typeof tool.name !== "string" || !tool.name) throw new RequestInputError(`tools.${index}.name is required`);
      toolNames.add(tool.name);
      if (!tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema)) {
        throw new RequestInputError(`tools.${index}.input_schema is required`);
      }
    }
    if (toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
      const choice = toolChoice as Record<string, unknown>;
      if (choice.type === "tool" && !toolNames.has(String(choice.name))) {
        throw new RequestInputError(`tool_choice.name ${String(choice.name)} does not match a declared tool`);
      }
    }
  } else if (toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const choice = toolChoice as Record<string, unknown>;
    if (choice.type === "tool") throw new RequestInputError(`tool_choice.name ${String(choice.name)} does not match a declared tool`);
  }
}

function anthropicErrorStatus(error: unknown, fallbackStatus: number): number {
  if (fallbackStatus !== 200) return fallbackStatus;
  const mapped = toAnthropicError(error).error.type;
  if (mapped === "rate_limit_error") return 429;
  if (mapped === "authentication_error") return 401;
  if (mapped === "permission_error") return 403;
  if (mapped === "not_found_error") return 404;
  if (mapped === "conflict_error") return 409;
  if (mapped === "request_too_large") return 413;
  return 502;
}

function rejectUnsupportedChatOptions(body: Record<string, unknown>): Response | null {
  const n = Number(body.n);
  if (Number.isFinite(n) && n > 1) {
    return jsonResponse(400, {
      error: { message: "n > 1 is not supported; Cursor Inference returns a single completion", type: "invalid_request_error" },
    });
  }
  return null;
}

function anthropicModelsResponse(ids: string[], url: URL) {
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw == null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RequestInputError("limit must be an integer between 1 and 1000");
  }
  const afterId = url.searchParams.get("after_id");
  const beforeId = url.searchParams.get("before_id");
  if (afterId && beforeId) throw new RequestInputError("after_id and before_id cannot be used together");
  let start = 0;
  let end = ids.length;
  if (afterId) {
    const index = ids.indexOf(afterId);
    if (index >= 0) start = index + 1;
  } else if (beforeId) {
    const index = ids.indexOf(beforeId);
    if (index >= 0) end = index;
    start = Math.max(0, end - limit);
  }
  const page = ids.slice(start, Math.min(end, start + limit));
  return {
    data: page.map((id) => ({
      id,
      created_at: "1970-01-01T00:00:00Z",
      display_name: id,
      type: "model",
    })),
    first_id: page[0] ?? null,
    has_more: beforeId ? start > 0 : start + page.length < end,
    last_id: page.at(-1) ?? null,
  };
}

function modelsUpstreamError(status: number, text: string, anthropic: boolean, requestId: string): Response {
  const message = text || `Cursor model discovery failed (${status})`;
  if (anthropic) return jsonResponse(status, toAnthropicError({ message, type: "api_error" }, requestId), requestId);
  return jsonResponse(status, { error: { message, type: "server_error" } });
}

function notImplemented(feature: string): Response {
  return jsonResponse(501, {
    error: {
      message: `${feature} is not available on Cursor InferenceService/Stream`,
      type: "invalid_request_error",
      code: "not_implemented",
    },
  });
}

async function runInference(
  ctx: GatewayCtx,
  headers: Headers,
  body: Record<string, unknown>,
  {
    tools,
    rawMessages,
    preconvertedMessages,
  }: { tools: CursorTool[]; rawMessages: unknown[]; preconvertedMessages?: CursorMessage[] },
) {
  const { accessToken, tenant } = await getAccessToken(ctx, headers);
  const prepared = await prepareChatTurn(body, tenant, rawMessages, tools, preconvertedMessages);
  const turn = await inferenceStream(
    accessToken,
    cursorBodyFromClient(body, {
      messages: prepared.messages,
      tools: prepared.tools,
      conversationId: prepared.conversationId,
      conversationGroupId: prepared.conversationGroupId,
      messagesPipelined: prepared.messagesPipelined,
    }),
    { sessionId: prepared.sessionId },
  );
  return { turn, conversationId: prepared.clientId, sessionId: prepared.clientId };
}

export async function handleGatewayRequest(request: Request, ctx: GatewayCtx): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const anthropicMessagesRequest = url.pathname === "/v1/messages" || url.pathname === "/messages";
  const anthropicModelsRequest =
    (url.pathname === "/v1/models" || url.pathname === "/models") && request.headers.has("anthropic-version");
  const anthropicRequest = anthropicMessagesRequest || anthropicModelsRequest;
  const requestId = `req_${randomId().replace(/-/g, "")}`;
  console.log(`${method} ${url.pathname}`);
  try {
    if (method === "OPTIONS") return corsResponse();

    if (method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, {
        ok: true,
        rpc: "/aiserver.v1.InferenceService/Stream",
        modes: ["/v1/chat/completions", "/v1/messages"],
        auth: "Authorization Bearer crsr_… / JWT or x-api-key",
        tools: "client executes tool_calls",
      });
    }

    if (method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      const { accessToken } = await getAccessToken(ctx, request.headers);
      const r = await connectUnary("/agent.v1.AgentService/GetUsableModels", accessToken, {});
      if (!r.ok) return modelsUpstreamError(r.status, r.text, anthropicModelsRequest, requestId);
      const ids = modelsFrom(r.json);
      if (anthropicModelsRequest) return jsonResponse(200, anthropicModelsResponse(ids, url), requestId);
      const data = ids.map((id) => ({
        id,
        object: "model",
        owned_by: "cursor",
      }));
      return jsonResponse(200, { object: "list", data });
    }

    if (method === "POST" && (url.pathname === "/v1/embeddings" || url.pathname === "/embeddings")) {
      return notImplemented("Embeddings");
    }
    if (
      method === "POST" &&
      (url.pathname === "/v1/audio/speech" ||
        url.pathname === "/v1/audio/transcriptions" ||
        url.pathname === "/v1/audio/translations")
    ) {
      return notImplemented("Audio");
    }
    if (
      method === "POST" &&
      (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits" || url.pathname === "/v1/images/variations")
    ) {
      return notImplemented("Images API (use chat tools / generate_image tool_call; Inference does not return pixels)");
    }
    if (method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      return notImplemented("OpenAI Responses API");
    }

    if (method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      const body = await readJson(request, ANTHROPIC_MAX_BODY_BYTES);
      validateAnthropicRequest(body);
      const unsupported = rejectUnsupportedChatOptions(body);
      if (unsupported) return unsupported;
      const messages = await anthropicToCursor(body);
      const tools = anthropicToolsToCursor(body.tools);
      body.reasoning_effort = anthropicReasoningEffort(body);
      const route = resolveCursorModelRoute(body.model, {
        fast: extractFastMode(body),
        reasoningEffort: extractReasoningEffort(body),
      });
      const media = countCursorMediaParts(messages);
      const cursorRoute = upgradeGrokRouteForTools(route.routeId, tools.length > 0);
      console.log(
        `  messages n=${messages.length} tools=${tools.length} images=${media.images} files=${media.files} stream=${Boolean(body.stream)} model=${route.clientModel || route.routeId} cursorRoute=${cursorRoute}`,
      );
      if (body.stream) {
        const { accessToken, tenant } = await getAccessToken(ctx, request.headers);
        const prepared = await prepareChatTurn(
          body,
          tenant,
          (body.messages as unknown[]) || [],
          tools,
          messages,
        );
        return streamAnthropicMessage({
          accessToken,
          body: cursorBodyFromClient(body, {
            messages: prepared.messages,
            tools: prepared.tools,
            conversationId: prepared.conversationId,
            conversationGroupId: prepared.conversationGroupId,
            messagesPipelined: prepared.messagesPipelined,
          }),
          model: body.model,
          conversationId: prepared.clientId,
          sessionId: prepared.sessionId,
          tools: prepared.tools,
          signal: request.signal,
          requestId,
        });
      }
      const { turn, conversationId } = await runInference(ctx, request.headers, body, {
        tools,
        rawMessages: (body.messages as unknown[]) || [],
        preconvertedMessages: messages,
      });
      if (turn.error) console.log(`  infer error ${JSON.stringify(turn.error).slice(0, 200)}`);
      if (turn.toolCalls?.length) {
        for (const c of toolCallsToOpenAI(turn.toolCalls, tools)) {
          console.log(`  ${c.function.name} ${c.function.arguments.slice(0, 280)}`);
        }
      }
      if (turn.error || turn.status !== 200) {
        const error = turn.error || { message: `Inference request failed (${turn.status})`, type: "api_error" };
        return jsonResponse(anthropicErrorStatus(error, turn.status), toAnthropicError(error, requestId), requestId);
      }
      return jsonResponse(
        turn.status,
        toAnthropicMessage({ model: body.model, turn, conversationId, tools, maxTokens: body.max_tokens }),
        requestId,
      );
    }

    if (method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      const body = await readJson(request);
      const unsupported = rejectUnsupportedChatOptions(body);
      if (unsupported) return unsupported;
      const messages = await openaiMessagesToCursor((body.messages as unknown[]) || []);
      const tools = openaiToolsToCursor(body.tools);
      const route = resolveCursorModelRoute(body.model, {
        fast: extractFastMode(body),
        reasoningEffort: extractReasoningEffort(body),
      });
      const media = countCursorMediaParts(messages);
      const hasTools = tools.length > 0 || openaiProviderDefinedTools(body.tools).length > 0;
      const cursorRoute = upgradeGrokRouteForTools(route.routeId, hasTools);
      console.log(
        `  chat n=${messages.length} tools=${tools.length} images=${media.images} files=${media.files} stream=${Boolean(body.stream)} model=${route.clientModel || route.routeId} cursorRoute=${cursorRoute}`,
      );
      if (body.stream) {
        const { accessToken, tenant } = await getAccessToken(ctx, request.headers);
        const prepared = await prepareChatTurn(
          body,
          tenant,
          (body.messages as unknown[]) || [],
          tools,
        );
        return streamOpenAiChatCompletion({
          accessToken,
          body: cursorBodyFromClient(body, {
            messages: prepared.messages,
            tools: prepared.tools,
            conversationId: prepared.conversationId,
            conversationGroupId: prepared.conversationGroupId,
            messagesPipelined: prepared.messagesPipelined,
          }),
          model: body.model,
          conversationId: prepared.clientId,
          sessionId: prepared.sessionId,
          tools: prepared.tools,
          signal: request.signal,
        });
      }
      const { turn, conversationId } = await runInference(ctx, request.headers, body, {
        tools,
        rawMessages: (body.messages as unknown[]) || [],
      });
      if (turn.error) console.log(`  infer error ${JSON.stringify(turn.error).slice(0, 200)}`);
      if (turn.toolCalls?.length) {
        for (const c of toolCallsToOpenAI(turn.toolCalls, tools)) {
          console.log(`  ${c.function.name} ${c.function.arguments.slice(0, 280)}`);
        }
      }
      return jsonResponse(
        turn.status === 200 ? 200 : turn.status,
        toOpenAICompletion({ model: body.model, turn, conversationId, tools }),
      );
    }

    console.log("  -> 404");
    return jsonResponse(404, { error: { message: `Unknown ${method} ${url.pathname}`, type: "invalid_request_error" } });
  } catch (err) {
    const message = String((err as Error)?.message || err);
    const status =
      err instanceof AuthError
        ? 401
        : err instanceof RequestInputError
          ? err.status
          : err instanceof ImageInputError
            ? 400
            : 500;
    console.log(`  -> ${status} ${message}`);
    const error = {
      message,
      type:
        status === 401
          ? "authentication_error"
          : status === 400
            ? "invalid_request_error"
            : status === 413
              ? "request_too_large"
              : "server_error",
    };
    const payload = anthropicRequest ? { ...toAnthropicError(error, requestId) } : { error };
    return jsonResponse(status, payload, anthropicRequest ? requestId : undefined);
  }
}
