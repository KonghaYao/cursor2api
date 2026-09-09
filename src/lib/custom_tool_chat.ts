/**
 * Custom-tools chat path: OpenAI tools → in-process `customTools.execute`.
 * The agent loop is AgentService/Run (MCP family only). execute() is parked
 * for the gateway client. Not HTTP MCP, not @cursor/sdk, not SDK/agent
 * binaries, not a Cursor-hosted Cloud Agents sandbox VM.
 *
 * Built-in agent tools stay off except the `mcp` capability group, which is
 * required for customTools to be offered. An empty allowlist also kills MCP.
 */
import { encodeSseData, encodeSseEvent, jsonResponse, sseStreamResponse } from "./bytes.ts";
import { CloudChatError } from "./cloud_errors.ts";
import { cloudApiKeyFromHeaders } from "./cloud_agents.ts";
import { credentialFingerprint } from "./auth.ts";
import { extractFastMode, extractReasoningEffort, toAnthropicError, toAnthropicUsage, toOpenAIUsage, normalizeCursorUsage } from "./inference.ts";
import { resolveSessionKvId } from "./cloud_session.ts";
import {
  clientToolsToAnthropic,
  clientToolsToOpenAi,
  composeToolResultPrompt,
  extractClientToolResults,
  failParkedClientTools,
  lastTurnIsToolResult,
  offerClientToolBatch,
  resolveClientToolResults,
  toSdkCustomTools,
  toolPolicyPrompt,
  upsertClientToolSession,
  waitForClientToolBatch,
  type ClientToolSession,
  type CustomToolDef,
  type ParkedClientTool,
} from "./custom_tools.ts";
import { gatewayAgentModelSelection, type AgentTurnUsage } from "./agent_json.ts";
import { defaultSdkAgentHost } from "./sdk_agent_host.ts";
import { resolveSessionMode } from "./session.ts";

export type SdkCustomToolMap = ReturnType<typeof toSdkCustomTools>;

/** Public name of the only builtin capability group we allow (MCP / customTools). */
export const SDK_CUSTOM_ONLY_BUILTIN_TOOLS = ["mcp"] as const;

/** Test/docs shape of MCP-only allowlist. Runtime never calls Agent.create({ local }). */
export function sdkLocalAgentCreateOptions(opts: {
  apiKey: string;
  model: unknown;
  fast?: boolean;
  reasoningEffort?: unknown;
  customTools: SdkCustomToolMap;
  cwd?: string;
}): Record<string, unknown> {
  const cwd = opts.cwd || readEnv("GATEWAY_AGENT_CWD") || "/tmp";
  const selection = gatewayAgentModelSelection(opts.model, {
    fast: opts.fast,
    reasoningEffort: opts.reasoningEffort,
  });
  return {
    apiKey: opts.apiKey,
    model: selection.parameters?.length
      ? { id: selection.modelId, params: selection.parameters }
      : { id: selection.modelId },
    tools: [...SDK_CUSTOM_ONLY_BUILTIN_TOOLS],
    local: {
      cwd,
      settingSources: [],
      customTools: opts.customTools,
    },
  };
}

function lastUserPrompt(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec.role !== "user") continue;
    if (Array.isArray(rec.content) && rec.content.some((b) => b && typeof b === "object" && String((b as Record<string, unknown>).type || "") === "tool_result")) {
      continue;
    }
    const content = rec.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? String((p as { text: string }).text) : ""))
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return "(empty)";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map(messageText).filter(Boolean).join("\n").trim();
  }
  if (content && typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text.trim();
    if (rec.content !== undefined) return messageText(rec.content);
  }
  return "";
}

/** OpenAI system/developer messages plus Anthropic `body.system`. */
export function systemPromptFromClient(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const sys = body.system;
  if (typeof sys === "string" && sys.trim()) parts.push(sys.trim());
  else if (Array.isArray(sys)) {
    for (const block of sys) {
      const text = messageText(block);
      if (text) parts.push(text);
    }
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec.role !== "system" && rec.role !== "developer") continue;
    const text = messageText(rec.content);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

export function composeCustomToolPrompt(opts: {
  body: Record<string, unknown>;
  tools: CustomToolDef[];
  messages: unknown[];
  followUp?: boolean;
}): string {
  const policy = toolPolicyPrompt(opts.body, opts.tools);
  const user = lastUserPrompt(opts.messages);
  // Follow-ups: Cursor already has system + prior turns in conversationState.
  // Re-folding system into every userMessageAction looks like a huge new prompt
  // and fights prompt cache. Only the latest user text is the delta.
  if (opts.followUp) return [policy, user].filter(Boolean).join("\n\n");
  const system = systemPromptFromClient(opts.body);
  const wrapped = system ? `<system>\n${system}\n</system>` : "";
  return [policy, wrapped, user].filter(Boolean).join("\n\n");
}

export type CustomToolAgentHandle = {
  agentId: string;
  send: (prompt: string) => Promise<{ wait: () => Promise<{ text: string; error?: string; usage?: AgentTurnUsage }> }>;
  close: () => Promise<void>;
};

export type CustomToolAgentHost = {
  create: (opts: {
    apiKey: string;
    model: unknown;
    fast?: boolean;
    reasoningEffort?: unknown;
    customTools: SdkCustomToolMap;
    cwd?: string;
  }) => Promise<CustomToolAgentHandle>;
};

type LiveTurn = {
  agent: CustomToolAgentHandle;
  session: ClientToolSession;
  wait: () => Promise<{ text: string; error?: string; usage?: AgentTurnUsage }>;
  done: boolean;
  text: string;
  error?: string;
  usage?: AgentTurnUsage;
};

const liveTurns = new Map<string, LiveTurn>();
let testHost: CustomToolAgentHost | undefined;

export function setCustomToolAgentHostForTests(host: CustomToolAgentHost | undefined): void {
  testHost = host;
}

export function customToolChatClearForTests(): void {
  for (const live of liveTurns.values()) void live.agent.close();
  liveTurns.clear();
}

function liveKey(tenant: string, sessionId: string): string {
  return `${tenant}:${sessionId}`;
}

function readEnv(name: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env?.[name]) return process.env[name];
  } catch {
    /* empty */
  }
  try {
    const deno = (globalThis as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno;
    return deno?.env.get(name);
  } catch {
    /* empty */
  }
  return undefined;
}

async function defaultHost(): Promise<CustomToolAgentHost> {
  return defaultSdkAgentHost();
}

async function resolveHost(): Promise<CustomToolAgentHost> {
  if (testHost) return testHost;
  try {
    return await defaultHost();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CloudChatError(
      `In-process customTools need AgentService/Run (${message}). HTTP MCP is not used.`,
      501,
    );
  }
}

async function settleCustomTools(
  session: ClientToolSession,
  live: LiveTurn,
): Promise<{ kind: "tools"; batch: ParkedClientTool[] } | { kind: "text" }> {
  // Do not subscribe to HTTP request.signal. Deno.serve (legacy) aborts it
  // after a successful response, which would look like the client hanging up
  // and would tear down a parked AgentService/Run between tool_calls and role:tool.
  const gate = new AbortController();
  const stop = () => gate.abort();
  void live.wait().then((result) => {
    live.done = true;
    live.text = result.text;
    live.error = result.error;
    live.usage = result.usage;
    stop();
  });
  try {
    while (!live.done) {
      const batch = await waitForClientToolBatch(session, gate.signal);
      if (batch.length) return { kind: "tools", batch };
      if (live.done) break;
    }
  } catch {
    /* gate abort when the run finishes */
  }
  const leftover = session.parked.filter((p) => !p.offered);
  if (leftover.length) return { kind: "tools", batch: leftover };
  return { kind: "text" };
}

async function startCustomToolTurn(opts: {
  apiKey: string;
  body: Record<string, unknown>;
  headers: Headers;
  tools: CustomToolDef[];
  signal?: AbortSignal;
}): Promise<{ live: LiveTurn; session: ClientToolSession; sessionId: string; continued: boolean }> {
  const tenant = await credentialFingerprint(opts.apiKey);
  const resolved = await resolveSessionKvId(opts.body, opts.headers);
  if ("ephemeral" in resolved || resolveSessionMode() === "random") {
    throw new CloudChatError("Client custom tools require a stable x-session-id / conversation_id (not SESSION_MODE=random).", 400);
  }
  const sessionId = resolved.sessionId;
  const session = upsertClientToolSession(tenant, sessionId, opts.tools);
  const messages = Array.isArray(opts.body.messages) ? opts.body.messages : [];
  const toolResults = extractClientToolResults(messages);
  const key = liveKey(tenant, sessionId);
  const existing = liveTurns.get(key);
  const canResumePark =
    Boolean(existing) &&
    !existing!.done &&
    session.parked.some((p) => p.resolve);

  if (lastTurnIsToolResult(messages) && toolResults.length && canResumePark) {
    const n = resolveClientToolResults(session, toolResults);
    if (!n) throw new CloudChatError("tool results did not match a parked custom tool call", 400);
    console.log(`  custom_tools resume session=${sessionId.slice(0, 24)} agent=${existing!.agent.agentId.slice(0, 14)}`);
    return { live: existing!, session, sessionId, continued: true };
  }

  if (session.parked.length) failParkedClientTools(session, "cancelled: new user turn");

  const host = await resolveHost();
  const customTools = toSdkCustomTools(session);
  const agent = existing?.agent ?? (await host.create({
    apiKey: opts.apiKey,
    model: opts.body.model,
    fast: extractFastMode(opts.body),
    reasoningEffort: extractReasoningEffort(opts.body),
    customTools,
  }));
  const toolFollowUp = lastTurnIsToolResult(messages) && toolResults.length > 0;
  if (toolFollowUp) {
    console.log(
      `  custom_tools park_miss session=${sessionId.slice(0, 24)} existing=${Boolean(existing)} done=${Boolean(existing?.done)} — continuing as follow-up prompt`,
    );
  }
  const prompt = toolFollowUp
    ? [
        existing
          ? [toolPolicyPrompt(opts.body, opts.tools), lastUserPrompt(messages)].filter(Boolean).join("\n\n")
          : composeCustomToolPrompt({
              body: opts.body,
              tools: opts.tools,
              messages,
              followUp: false,
            }),
        composeToolResultPrompt(toolResults),
      ]
        .filter(Boolean)
        .join("\n\n")
    : composeCustomToolPrompt({
        body: opts.body,
        tools: opts.tools,
        messages,
        followUp: Boolean(existing),
      });
  const run = await agent.send(prompt);
  const live: LiveTurn = {
    agent,
    session,
    wait: run.wait,
    done: false,
    text: "",
  };
  session.agentId = agent.agentId;
  liveTurns.set(key, live);
  void live.wait().then((result) => {
    live.done = true;
    live.text = result.text;
    live.error = result.error;
    live.usage = result.usage;
  });
  console.log(`  custom_tools ${existing ? "follow" : "create"} session=${sessionId.slice(0, 24)} agent=${agent.agentId.slice(0, 14)} tools=${opts.tools.length}`);
  return { live, session, sessionId, continued: false };
}

function cursorTurnFromAgentUsage(usage?: AgentTurnUsage) {
  if (!usage) return {};
  return {
    usage: {
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
    },
    extendedUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
    },
  };
}

function openaiUsageFromAgent(usage?: AgentTurnUsage) {
  return toOpenAIUsage(normalizeCursorUsage(cursorTurnFromAgentUsage(usage)));
}

function anthropicUsageFromAgent(usage?: AgentTurnUsage) {
  return toAnthropicUsage(cursorTurnFromAgentUsage(usage));
}

function logAgentUsage(usage?: AgentTurnUsage) {
  if (!usage) return;
  console.log(
    `  custom_tools usage in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadTokens ?? 0} cache_write=${usage.cacheWriteTokens ?? 0}`,
  );
}

function liveResult(live: LiveTurn): { text: string; error?: string; usage?: AgentTurnUsage } {
  return { text: live.text, error: live.error, usage: live.usage };
}

function openAiCompletion(opts: {
  model: unknown;
  agentId: string;
  sessionId: string;
  text: string;
  error?: string;
  usage?: AgentTurnUsage;
  toolCalls?: ReturnType<typeof clientToolsToOpenAi>;
}) {
  const toolCalls = opts.toolCalls?.length ? opts.toolCalls : undefined;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: opts.text || (toolCalls ? null : ""),
  };
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id: opts.agentId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(opts.model || "composer-2.5"),
    choices: [{ index: 0, message, finish_reason: opts.error ? "stop" : toolCalls ? "tool_calls" : "stop" }],
    usage: openaiUsageFromAgent(opts.usage),
    cursor_agent_id: opts.agentId,
    conversation_id: opts.sessionId,
    error: opts.error ? { message: opts.error, type: "api_error" } : undefined,
  };
}

export async function handleCustomToolChatCompletions(opts: {
  headers: Headers;
  body: Record<string, unknown>;
  tools: CustomToolDef[];
  signal?: AbortSignal;
}): Promise<Response> {
  const apiKey = cloudApiKeyFromHeaders(opts.headers);
  const started = await startCustomToolTurn({ apiKey, body: opts.body, headers: opts.headers, tools: opts.tools, signal: opts.signal });
  const agentId = started.live.agent.agentId;
  if (opts.body.stream) {
    return streamCustomOpenAi({ ...started, model: opts.body.model, agentId, signal: opts.signal });
  }
  const settled = await settleCustomTools(started.session, started.live);
  if (settled.kind === "tools") {
    offerClientToolBatch(started.session, settled.batch);
    const toolCalls = clientToolsToOpenAi(settled.batch);
    console.log(`  custom_tools park ${toolCalls.map((c) => c.function.name).join(",")}`);
    return jsonResponse(
      200,
      openAiCompletion({
        model: opts.body.model,
        agentId,
        sessionId: started.sessionId,
        text: started.live.text,
        usage: started.live.usage,
        toolCalls,
      }),
    );
  }
  const result = started.live.done ? liveResult(started.live) : await started.live.wait();
  logAgentUsage(result.usage);
  return jsonResponse(
    200,
    openAiCompletion({
      model: opts.body.model,
      agentId,
      sessionId: started.sessionId,
      text: result.text,
      error: result.error,
      usage: result.usage,
    }),
  );
}

export async function handleCustomToolMessages(opts: {
  headers: Headers;
  body: Record<string, unknown>;
  tools: CustomToolDef[];
  requestId: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const apiKey = cloudApiKeyFromHeaders(opts.headers);
  const started = await startCustomToolTurn({ apiKey, body: opts.body, headers: opts.headers, tools: opts.tools, signal: opts.signal });
  const agentId = started.live.agent.agentId;
  if (opts.body.stream) {
    return streamCustomAnthropic({ ...started, model: opts.body.model, agentId, requestId: opts.requestId, signal: opts.signal });
  }
  const settled = await settleCustomTools(started.session, started.live);
  if (settled.kind === "tools") {
    offerClientToolBatch(started.session, settled.batch);
    const toolUses = clientToolsToAnthropic(settled.batch);
    const content: unknown[] = [];
    if (started.live.text) content.push({ type: "text", text: started.live.text });
    content.push(...toolUses);
    return jsonResponse(200, {
      id: `msg_${agentId}`,
      type: "message",
      role: "assistant",
      model: String(opts.body.model || "composer-2.5"),
      content,
      stop_reason: "tool_use",
      usage: anthropicUsageFromAgent(started.live.usage),
      cursor_agent_id: agentId,
      conversation_id: started.sessionId,
    }, opts.requestId);
  }
  const result = started.live.done ? liveResult(started.live) : await started.live.wait();
  logAgentUsage(result.usage);
  return jsonResponse(200, {
    id: `msg_${agentId}`,
    type: "message",
    role: "assistant",
    model: String(opts.body.model || "composer-2.5"),
    content: [{ type: "text", text: result.text || result.error || "" }],
    stop_reason: "end_turn",
    usage: anthropicUsageFromAgent(result.usage),
    cursor_agent_id: agentId,
    conversation_id: started.sessionId,
  }, opts.requestId);
}

function streamCustomOpenAi(opts: {
  live: LiveTurn;
  session: ClientToolSession;
  sessionId: string;
  model: unknown;
  agentId: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { live, session, sessionId, model, agentId, signal } = opts;
  const created = Math.floor(Date.now() / 1000);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
        encodeSseData({
          id: agentId,
          object: "chat.completion.chunk",
          created,
          model: String(model || "composer-2.5"),
          choices: [{ index: 0, delta, finish_reason: finish }],
          cursor_agent_id: agentId,
          conversation_id: sessionId,
          ...extra,
        });
      try {
        controller.enqueue(chunk({ role: "assistant" }));
        const settled = await settleCustomTools(session, live);
        if (live.text) controller.enqueue(chunk({ content: live.text }));
        const usage = openaiUsageFromAgent(live.usage);
        if (settled.kind === "tools") {
          offerClientToolBatch(session, settled.batch);
          const toolCalls = clientToolsToOpenAi(settled.batch);
          controller.enqueue(chunk({ tool_calls: toolCalls }));
          controller.enqueue(chunk({}, "tool_calls", { usage }));
          controller.enqueue(
            encodeSseData({
              id: agentId,
              object: "chat.completion.chunk",
              created,
              model: String(model || "composer-2.5"),
              choices: [],
              usage,
            }),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          return;
        }
        logAgentUsage(live.usage);
        if (live.error) {
          controller.enqueue(
            encodeSseData({
              id: agentId,
              object: "chat.completion.chunk",
              created,
              model: String(model || "composer-2.5"),
              choices: [],
              error: { message: live.error, type: "api_error" },
            }),
          );
        }
        controller.enqueue(chunk({}, "stop", { usage }));
        controller.enqueue(
          encodeSseData({
            id: agentId,
            object: "chat.completion.chunk",
            created,
            model: String(model || "composer-2.5"),
            choices: [],
            usage,
          }),
        );
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
        controller.close();
      }
    },
  });
  return Promise.resolve(sseStreamResponse(stream));
}

function streamCustomAnthropic(opts: {
  live: LiveTurn;
  session: ClientToolSession;
  sessionId: string;
  model: unknown;
  agentId: string;
  requestId: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { live, session, model, agentId, requestId, signal } = opts;
  const msgId = `msg_${agentId}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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
              usage: anthropicUsageFromAgent(),
            },
          }),
        );
        const settled = await settleCustomTools(session, live);
        let index = 0;
        if (live.text) {
          controller.enqueue(encodeSseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
          controller.enqueue(encodeSseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: live.text } }));
          controller.enqueue(encodeSseEvent("content_block_stop", { type: "content_block_stop", index: 0 }));
          index = 1;
        }
        if (settled.kind === "tools") {
          offerClientToolBatch(session, settled.batch);
          for (const call of clientToolsToAnthropic(settled.batch)) {
            controller.enqueue(
              encodeSseEvent("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
              }),
            );
            controller.enqueue(
              encodeSseEvent("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
              }),
            );
            controller.enqueue(encodeSseEvent("content_block_stop", { type: "content_block_stop", index }));
            index += 1;
          }
          controller.enqueue(
            encodeSseEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: anthropicUsageFromAgent(live.usage),
            }),
          );
          controller.enqueue(encodeSseEvent("message_stop", { type: "message_stop" }));
          return;
        }
        logAgentUsage(live.usage);
        controller.enqueue(
          encodeSseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: anthropicUsageFromAgent(live.usage),
          }),
        );
        controller.enqueue(encodeSseEvent("message_stop", { type: "message_stop" }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encodeSseEvent("error", toAnthropicError({ message, type: "api_error" }, requestId)));
      } finally {
        controller.close();
      }
    },
  });
  return Promise.resolve(sseStreamResponse(stream, requestId));
}
