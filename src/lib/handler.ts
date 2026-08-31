import { connectUnary, getAccessToken, modelsFrom, AuthError, type GatewayCtx } from "./auth.ts";
import { corsResponse, jsonResponse, randomId, sseResponse } from "./bytes.ts";
import {
  anthropicToCursor,
  anthropicToolsToCursor,
  cursorBody,
  extractReasoningEffort,
  inferenceStream,
  openaiMessagesToCursor,
  openaiSseBody,
  openaiToolsToCursor,
  resolveModel,
  toAnthropicMessage,
  toOpenAICompletion,
  toolCallsToOpenAI,
  type CursorMessage,
  type CursorTool,
} from "./inference.ts";

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

function resolveChatIdentity(headers: Headers, body: Record<string, unknown>, tenant: string) {
  const periSession = incomingSessionId(headers, body);
  const clientId = String(
    body.conversation_id ||
      body.conversationId ||
      (body.metadata as Record<string, unknown> | undefined)?.conversation_id ||
      periSession ||
      randomId(),
  );
  const cursorId = `${tenant}:${clientId}`;
  return {
    clientId,
    conversationId: cursorId,
    conversationGroupId: periSession ? `${tenant}:${periSession}` : cursorId,
    sessionId: cursorId,
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function runInference(
  ctx: GatewayCtx,
  headers: Headers,
  body: Record<string, unknown>,
  { messages, tools }: { messages: CursorMessage[]; tools: CursorTool[] },
) {
  const { accessToken, tenant } = await getAccessToken(ctx, headers);
  const { clientId, conversationId, conversationGroupId, sessionId } = resolveChatIdentity(headers, body, tenant);
  const turn = await inferenceStream(
    accessToken,
    cursorBody({
      messages,
      tools,
      model: body.model,
      conversationId,
      conversationGroupId,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      reasoningEffort: extractReasoningEffort(body),
    }),
    { sessionId },
  );
  return { turn, conversationId: clientId, sessionId: clientId };
}

export async function handleGatewayRequest(request: Request, ctx: GatewayCtx): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
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

    if (method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      const body = await readJson(request);
      const messages = anthropicToCursor(body);
      const tools = anthropicToolsToCursor(body.tools);
      if ((body.thinking as Record<string, unknown> | undefined)?.type === "enabled" && body.reasoning_effort == null) {
        body.reasoning_effort = "high";
      }
      console.log(`  messages n=${messages.length} tools=${tools.length} model=${resolveModel(body.model)}`);
      const { turn, conversationId, sessionId } = await runInference(ctx, request.headers, body, { messages, tools });
      if (turn.error) console.log(`  infer error ${JSON.stringify(turn.error).slice(0, 200)}`);
      if (turn.toolCalls?.length) {
        for (const c of toolCallsToOpenAI(turn.toolCalls, tools)) {
          console.log(`  ${c.function.name} ${c.function.arguments.slice(0, 280)}`);
        }
      }
      return jsonResponse(200, toAnthropicMessage({ model: body.model, turn, conversationId, tools }), sessionId);
    }

    if (method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      const body = await readJson(request);
      const messages = openaiMessagesToCursor((body.messages as unknown[]) || []);
      const tools = openaiToolsToCursor(body.tools);
      console.log(
        `  chat n=${messages.length} tools=${tools.length} stream=${Boolean(body.stream)} model=${resolveModel(body.model)}`,
      );
      const { turn, conversationId, sessionId } = await runInference(ctx, request.headers, body, { messages, tools });
      if (turn.error) console.log(`  infer error ${JSON.stringify(turn.error).slice(0, 200)}`);
      if (turn.toolCalls?.length) {
        for (const c of toolCallsToOpenAI(turn.toolCalls, tools)) {
          console.log(`  ${c.function.name} ${c.function.arguments.slice(0, 280)}`);
        }
      }
      if (body.stream) {
        return sseResponse(openaiSseBody({ model: body.model, turn, conversationId, tools }), sessionId);
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
    const status = err instanceof AuthError ? 401 : 500;
    console.log(`  -> ${status} ${message}`);
    return jsonResponse(status, {
      error: { message, type: status === 401 ? "authentication_error" : "server_error" },
    });
  }
}
