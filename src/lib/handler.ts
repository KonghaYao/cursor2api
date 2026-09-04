import { connectUnary, getAccessToken, modelsFrom, AuthError, type GatewayCtx } from "./auth.ts";
import { corsResponse, jsonResponse } from "./bytes.ts";
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

function headerValue(headers: Headers, name: string): string | undefined {
  const raw = headers.get(name);
  return raw?.trim() || undefined;
}

function incomingSessionId(headers: Headers, body: Record<string, unknown>): string | undefined {
  const meta = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};
  const raw =
    headerValue(headers, "x-session-id") ||
    headerValue(headers, "x-cursor-session-id") ||
    meta.session_id ||
    meta.sessionId ||
    body.session_id ||
    body.sessionId;
  const id = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).trim();
  return id || undefined;
}

function explicitConversationId(headers: Headers, body: Record<string, unknown>): string | undefined {
  const periSession = incomingSessionId(headers, body);
  const meta = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};
  const id = String(
    body.conversation_id || body.conversationId || meta.conversation_id || periSession || "",
  ).trim();
  return id || undefined;
}

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
  ctx: GatewayCtx,
  headers: Headers,
  body: Record<string, unknown>,
  tenant: string,
  rawMessages: unknown[],
  tools: CursorTool[],
  preconvertedMessages?: CursorMessage[],
): Promise<PreparedChat> {
  const periSession = incomingSessionId(headers, body);
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
    conversationGroupId: periSession ? `${tenant}:${periSession}` : cursorId,
    sessionId: cursorId,
    clientId: session.clientId,
    messagesPipelined: false,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
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
  const prepared = await prepareChatTurn(ctx, headers, body, tenant, rawMessages, tools, preconvertedMessages);
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
  const anthropicRequest = url.pathname === "/v1/messages" || url.pathname === "/messages";
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
      const ids = modelsFrom(r.json);
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
      const body = await readJson(request);
      const unsupported = rejectUnsupportedChatOptions(body);
      if (unsupported) return unsupported;
      const messages = await anthropicToCursor(body);
      const tools = anthropicToolsToCursor(body.tools);
      if ((body.thinking as Record<string, unknown> | undefined)?.type === "enabled" && body.reasoning_effort == null) {
        body.reasoning_effort = "high";
      }
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
          ctx,
          request.headers,
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
        });
      }
      const { turn, conversationId, sessionId } = await runInference(ctx, request.headers, body, {
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
        return jsonResponse(turn.status === 200 ? 502 : turn.status, toAnthropicError(error), sessionId);
      }
      return jsonResponse(turn.status, toAnthropicMessage({ model: body.model, turn, conversationId, tools }), sessionId);
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
          ctx,
          request.headers,
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
      const { turn, conversationId, sessionId } = await runInference(ctx, request.headers, body, {
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
        sessionId,
      );
    }

    console.log("  -> 404");
    return jsonResponse(404, { error: { message: `Unknown ${method} ${url.pathname}`, type: "invalid_request_error" } });
  } catch (err) {
    const message = String((err as Error)?.message || err);
    const status = err instanceof AuthError ? 401 : err instanceof ImageInputError ? 400 : 500;
    console.log(`  -> ${status} ${message}`);
    const error = {
      message,
      type: status === 401 ? "authentication_error" : status === 400 ? "invalid_request_error" : "server_error",
    };
    return jsonResponse(status, anthropicRequest ? { type: "error", error } : { error });
  }
}
