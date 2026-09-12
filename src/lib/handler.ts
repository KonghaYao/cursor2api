import { AuthError, type GatewayCtx } from "./auth.ts";
import { corsResponse, jsonResponse, randomId } from "./bytes.ts";
import { CloudAgentsError } from "./cloud_agents.ts";
import {
  CloudChatError,
  cloudHealthBody,
  handleCloudChatCompletions,
  handleCloudMessages,
  handleCloudModels,
} from "./cloud_openai.ts";
import { ImageInputError, toAnthropicError } from "./inference.ts";

class RequestInputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RequestInputError";
    this.status = status;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
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
  if (body.top_k != null) throw new RequestInputError("top_k is not supported");
  for (const key of ["container", "context_management", "service_tier"] as const) {
    if (body[key] != null) throw new RequestInputError(`${key} is not supported`);
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
        throw new RequestInputError(`${path} type ${type || "<missing>"} is not supported`);
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
              throw new RequestInputError(`${innerPath} type ${innerType || "<missing>"} is not supported`);
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
      if (type === "thinking") {
        if (typeof block.thinking !== "string") throw new RequestInputError(`${path}.thinking is required`);
        // AgentService thinkingDelta has no signature. Clients echo whatever we
        // returned; requiring signature here 400s the next /v1/messages turn.
        if (block.signature != null && typeof block.signature !== "string") {
          throw new RequestInputError(`${path}.signature must be a string`);
        }
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

function rejectUnsupportedChatOptions(body: Record<string, unknown>): Response | null {
  const n = Number(body.n);
  if (Number.isFinite(n) && n > 1) {
    return jsonResponse(400, {
      error: { message: "n > 1 is not supported; the gateway returns a single completion", type: "invalid_request_error" },
    });
  }
  return null;
}

function notImplemented(feature: string): Response {
  return jsonResponse(501, {
    error: {
      message: `${feature} is not available on this gateway`,
      type: "invalid_request_error",
      code: "not_implemented",
    },
  });
}

function mapGatewayError(err: unknown, anthropicRequest: boolean, requestId: string): Response {
  const message = String((err as Error)?.message || err);
  const status =
    err instanceof AuthError
      ? 401
      : err instanceof CloudAgentsError
        ? err.status
        : err instanceof CloudChatError
          ? err.status
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
        : status === 400 || status === 409
          ? "invalid_request_error"
          : status === 413
            ? "request_too_large"
            : "server_error",
  };
  const payload = anthropicRequest ? { ...toAnthropicError(error, requestId) } : { error };
  return jsonResponse(status, payload, anthropicRequest ? requestId : undefined);
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
      return jsonResponse(200, cloudHealthBody());
    }

    if (method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return await handleCloudModels(request.headers, anthropicModelsRequest, requestId, request.signal);
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
      return notImplemented("Images API (use chat tools / generate_image tool_call)");
    }
    if (method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      return notImplemented("OpenAI Responses API");
    }

    if (method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      const body = await readJson(request);
      validateAnthropicRequest(body);
      const unsupported = rejectUnsupportedChatOptions(body);
      if (unsupported) return unsupported;
      // Do not `return await` a streaming Response: Deno.serve treats the
      // handler as finished and legacy-aborts request.signal, which
      // cancelAction's the in-flight SSE. Adopt the promise; map errors
      // without buffering the body. Stream path must not bind request.signal
      // to cancelAction (legacy abort after 200); SSE cancel() owns abort.
      return handleCloudMessages(request.headers, body, requestId, ctx.kv, {
        signal: body.stream ? undefined : request.signal,
      }).catch((err) => mapGatewayError(err, anthropicRequest, requestId));
    }

    if (method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      const body = await readJson(request);
      const unsupported = rejectUnsupportedChatOptions(body);
      if (unsupported) return unsupported;
      return handleCloudChatCompletions(request.headers, body, ctx.kv, {
        signal: body.stream ? undefined : request.signal,
      }).catch((err) => mapGatewayError(err, anthropicRequest, requestId));
    }

    console.log("  -> 404");
    return jsonResponse(404, { error: { message: `Unknown ${method} ${url.pathname}`, type: "invalid_request_error" } });
  } catch (err) {
    return mapGatewayError(err, anthropicRequest, requestId);
  }
}
