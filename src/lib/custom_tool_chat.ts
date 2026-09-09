/**
 * Custom-tools chat path: OpenAI tools → in-process `customTools.execute`.
 * The agent loop is AgentService/Run (MCP family only). execute() is parked
 * for the gateway client. Not HTTP MCP, not @cursor/sdk, not SDK/agent
 * binaries, not a Cursor-hosted Cloud Agents sandbox VM.
 *
 * Built-in agent tools stay off except the `mcp` capability group, which is
 * required for customTools to be offered. An empty allowlist also kills MCP.
 *
 * Conversation id is `tenant:agentRunFp` (model / effort / tools / system /
 * first user). Client `x-session-id` / `conversation_id` are ignored. KV
 * `agent-run:` restores ids after a Deno isolate hop (TTL 24h). KV
 * `agent-run-len:` stores the last successful `messages.length` (TTL 5 min)
 * so the next request can slice only the new suffix. `liveTurns` only parks
 * in-process `execute()`; it is not a serverless session store.
 *
 * Client contract (the normal path, not an edge case): every request carries
 * the full OpenAI/Anthropic transcript, and the client keeps that prefix
 * stable (append-only). The gateway must slice the delta off that full list
 * — never assume the client sent only the latest turn, and never reship the
 * whole history into AgentService `userMessageAction`.
 */
import { encodeSseData, encodeSseEvent, jsonResponse, sseStreamResponse } from "./bytes.ts";
import { CloudChatError } from "./cloud_errors.ts";
import { cloudApiKeyFromHeaders } from "./cloud_agents.ts";
import { credentialFingerprint } from "./auth.ts";
import {
  anthropicToolsToCursor,
  extractFastMode,
  extractReasoningEffort,
  flattenContent,
  openaiToolsToCursor,
  toAnthropicError,
  toAnthropicUsage,
  toOpenAIUsage,
  normalizeCursorUsage,
} from "./inference.ts";
import { kvGetAgentRun, kvGetAgentRunLen, kvSetAgentRun, kvSetAgentRunLen, type Kv } from "./kv.ts";
import { agentRunIds, resolveSessionMode } from "./session.ts";
import { computeAgentRunFp } from "./session_fingerprint.ts";
import {
  clientToolsToAnthropic,
  clientToolsToOpenAi,
  composeToolResultPrompt,
  extractClientToolResults,
  extractLatestClientToolResults,
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
import { gatewayAgentModelSelection, promptCacheHitPercent, type AgentInlineImage, type AgentTurnUsage } from "./agent_json.ts";
import { openaiContentToCursorParts } from "./content_parts.ts";
import { defaultSdkAgentHost } from "./sdk_agent_host.ts";

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

function promptFromUserContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? String((p as { text: string }).text) : ""))
      .filter(Boolean)
      .join("\n");
    return text;
  }
  return "";
}

function lastUserPrompt(messages: unknown[]): string {
  const content = lastUserContent(messages);
  if (content == null) return "(empty)";
  return promptFromUserContent(content) || (typeof content === "string" ? "(empty)" : "");
}

function isToolResultUser(rec: Record<string, unknown>): boolean {
  return Array.isArray(rec.content) && rec.content.some((b) => b && typeof b === "object" && String((b as Record<string, unknown>).type || "") === "tool_result");
}

/** User texts in `messages`, skipping assistant echoes and Anthropic tool_result users. */
export function joinUserPrompts(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec.role !== "user" || isToolResultUser(rec)) continue;
    const text = promptFromUserContent(rec.content);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function lastUserContent(messages: unknown[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec.role !== "user") continue;
    if (isToolResultUser(rec)) continue;
    return rec.content;
  }
  return undefined;
}

function extForMime(mime: string): string {
  const t = mime.toLowerCase();
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("webp")) return "webp";
  if (t.includes("gif")) return "gif";
  if (t.includes("png")) return "png";
  return "png";
}

export function agentImagesFromCursorParts(parts: Array<Record<string, unknown>>): AgentInlineImage[] {
  const out: AgentInlineImage[] = [];
  for (const part of parts) {
    const image = part.image as { data?: string; mimeType?: string } | undefined;
    if (!image?.data) continue;
    const mimeType = image.mimeType || "image/png";
    const uuid = crypto.randomUUID();
    out.push({
      uuid,
      path: `image-${uuid}.${extForMime(mimeType)}`,
      mimeType,
      data: image.data,
    });
  }
  return out;
}

async function lastUserAgentImages(messages: unknown[]): Promise<AgentInlineImage[]> {
  const content = lastUserContent(messages);
  if (content == null || typeof content === "string") return [];
  const converted = await openaiContentToCursorParts(content);
  return agentImagesFromCursorParts(converted.parts);
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
  const user = lastUserPrompt(opts.messages);
  // Follow-ups: Cursor already has system, tool policy, and prior turns in
  // conversationState. Re-folding any of that into every userMessageAction
  // looks like a huge new prompt and fights prompt cache.
  if (opts.followUp) return user;
  const policy = toolPolicyPrompt(opts.body, opts.tools);
  const system = systemPromptFromClient(opts.body);
  const wrapped = system ? `<system>\n${system}\n</system>` : "";
  return [policy, wrapped, user].filter(Boolean).join("\n\n");
}

/**
 * Prompt for one AgentService userMessageAction.
 * Clients send the full OpenAI/Anthropic transcript every time; only the
 * delta belongs on the wire. Older tool rounds stay in conversationState.
 *
 * `priorMessageCount` is the last successful `messages.length` (KV, 5 min).
 * Slice from there so one request can carry multiple new user turns.
 */
export function composeCustomToolTurnPrompt(opts: {
  body: Record<string, unknown>;
  tools: CustomToolDef[];
  messages: unknown[];
  hadPriorTurn: boolean;
  priorMessageCount?: number;
}): string {
  const prior = opts.priorMessageCount;
  const canSlice = prior != null && Number.isInteger(prior) && prior > 0 && opts.messages.length > prior;
  if (canSlice) {
    const slice = opts.messages.slice(prior);
    const latest = extractLatestClientToolResults(slice);
    const toolFollowUp = lastTurnIsToolResult(opts.messages) && latest.length > 0;
    if (toolFollowUp) return composeToolResultPrompt(latest);
    const users = joinUserPrompts(slice);
    if (users) return users;
  }
  const latest = extractLatestClientToolResults(opts.messages);
  const toolFollowUp = lastTurnIsToolResult(opts.messages) && latest.length > 0;
  if (!toolFollowUp) {
    return composeCustomToolPrompt({
      body: opts.body,
      tools: opts.tools,
      messages: opts.messages,
      followUp: opts.hadPriorTurn,
    });
  }
  // Cold start (no live agent, no KV): Cursor has no conversationState, so
  // fold system + the original user question and every tool result we have.
  // Warm thread: only the latest round — reshipping history is a cache miss.
  const results = composeToolResultPrompt(opts.hadPriorTurn ? latest : extractClientToolResults(opts.messages));
  if (opts.hadPriorTurn) return results;
  return [composeCustomToolPrompt({
    body: opts.body,
    tools: opts.tools,
    messages: opts.messages,
    followUp: false,
  }), results].filter(Boolean).join("\n\n");
}

export type CustomToolTurnResult = { text: string; thinking?: string; error?: string; usage?: AgentTurnUsage };

export type CustomToolAgentHandle = {
  agentId: string;
  send: (
    prompt: string,
    opts?: { images?: AgentInlineImage[] },
  ) => Promise<{ wait: () => Promise<CustomToolTurnResult> }>;
  close: () => Promise<void>;
};

export type CustomToolAgentCreateOpts = {
  apiKey: string;
  model: unknown;
  fast?: boolean;
  reasoningEffort?: unknown;
  customTools: SdkCustomToolMap;
  cwd?: string;
  conversationId?: string;
  agentSessionId?: string;
  conversationState?: Record<string, unknown>;
  onCheckpoint?: (state: Record<string, unknown>) => void;
};

export type CustomToolAgentHost = {
  create: (opts: CustomToolAgentCreateOpts) => Promise<CustomToolAgentHandle>;
};

type LiveTurn = {
  agent: CustomToolAgentHandle;
  session: ClientToolSession;
  wait: () => Promise<CustomToolTurnResult>;
  done: boolean;
  text: string;
  thinking?: string;
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

function liveKey(tenant: string, sessionFp: string): string {
  return `${tenant}:${sessionFp}`;
}

/** Anthropic `thinking.budget_tokens` → fingerprint `reasoning_effort` (same bands as /v1/messages). */
function foldAnthropicReasoningEffort(body: Record<string, unknown>): void {
  if (body.reasoning_effort != null && String(body.reasoning_effort).trim() !== "") return;
  const thinking = body.thinking as Record<string, unknown> | undefined;
  if (!thinking || thinking.type === "disabled") return;
  const budget = Number(thinking.budget_tokens ?? thinking.budgetTokens);
  if (!Number.isFinite(budget)) {
    if (thinking.type === "enabled" || thinking.type === "adaptive") body.reasoning_effort = "high";
    return;
  }
  if (budget < 4_096) body.reasoning_effort = "low";
  else if (budget < 12_000) body.reasoning_effort = "medium";
  else if (budget < 32_000) body.reasoning_effort = "high";
  else body.reasoning_effort = "xhigh";
}

async function sessionFpForCustomTools(
  body: Record<string, unknown>,
  protocol: "openai" | "anthropic",
): Promise<string> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (protocol === "anthropic") {
    foldAnthropicReasoningEffort(body);
    return computeAgentRunFp(body, anthropicToolsToCursor(body.tools), {
      foldSystem: flattenContent(body.system),
      rawMessages: messages,
    });
  }
  return computeAgentRunFp(body, openaiToolsToCursor(body.tools), { rawMessages: messages });
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
    live.thinking = result.thinking;
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
  tools: CustomToolDef[];
  signal?: AbortSignal;
  kv?: Kv;
  protocol?: "openai" | "anthropic";
}): Promise<{ live: LiveTurn; session: ClientToolSession; sessionId: string; continued: boolean }> {
  const tenant = await credentialFingerprint(opts.apiKey);
  if (resolveSessionMode() === "random") {
    throw new CloudChatError("SESSION_MODE=random cannot park customTools.execute across turns.", 400);
  }
  const protocol = opts.protocol ?? "openai";
  const sessionFp = await sessionFpForCustomTools(opts.body, protocol);
  const computedIds = agentRunIds(tenant, sessionFp);
  const session = upsertClientToolSession(tenant, sessionFp, opts.tools);
  const messages = Array.isArray(opts.body.messages) ? opts.body.messages : [];
  const toolResults = extractLatestClientToolResults(messages);
  const key = liveKey(tenant, sessionFp);
  const existing = liveTurns.get(key);
  const canResumePark =
    Boolean(existing) &&
    !existing!.done &&
    session.parked.some((p) => p.resolve);

  const persistCommittedLength = async () => {
    if (!opts.kv) return;
    await kvSetAgentRunLen(opts.kv, tenant, sessionFp, messages.length);
  };

  if (lastTurnIsToolResult(messages) && toolResults.length && canResumePark) {
    const n = resolveClientToolResults(session, toolResults);
    if (!n) throw new CloudChatError("tool results did not match a parked custom tool call", 400);
    console.log(`  custom_tools resume session=${computedIds.conversationId.slice(0, 24)} agent=${existing!.agent.agentId.slice(0, 14)}`);
    await persistCommittedLength();
    return { live: existing!, session, sessionId: computedIds.conversationId, continued: true };
  }

  if (session.parked.length) failParkedClientTools(session, "cancelled: new user turn");

  const binding = opts.kv ? await kvGetAgentRun(opts.kv, tenant, sessionFp, sessionFp) : null;
  const priorMessageCount = opts.kv ? await kvGetAgentRunLen(opts.kv, tenant, sessionFp) : null;
  const ids = binding
    ? { conversationId: binding.conversationId, agentSessionId: binding.agentSessionId }
    : computedIds;
  const sessionId = ids.conversationId;
  const checkpoint: { state?: Record<string, unknown> } = { state: binding?.conversationState };
  const persistBinding = async (state?: Record<string, unknown>) => {
    if (!opts.kv) return;
    await kvSetAgentRun(opts.kv, tenant, sessionFp, {
      fp: sessionFp,
      conversationId: ids.conversationId,
      agentSessionId: ids.agentSessionId,
      conversationState: state,
    });
  };

  const host = await resolveHost();
  const customTools = toSdkCustomTools(session);
  const agent = existing?.agent ?? (await host.create({
    apiKey: opts.apiKey,
    model: opts.body.model,
    fast: extractFastMode(opts.body),
    reasoningEffort: extractReasoningEffort(opts.body),
    customTools,
    conversationId: ids.conversationId,
    agentSessionId: ids.agentSessionId,
    conversationState: checkpoint.state,
    onCheckpoint: (state) => {
      checkpoint.state = state;
      void persistBinding(state);
    },
  }));
  const hadPriorTurn = Boolean(existing) || Boolean(binding);
  const toolFollowUp = lastTurnIsToolResult(messages) && toolResults.length > 0;
  if (toolFollowUp) {
    console.log(
      `  custom_tools park_miss session=${sessionId.slice(0, 24)} existing=${Boolean(existing)} kv=${Boolean(binding)} done=${Boolean(existing?.done)} — continuing as follow-up prompt`,
    );
  }
  const prompt = composeCustomToolTurnPrompt({
    body: opts.body,
    tools: opts.tools,
    messages,
    hadPriorTurn,
    priorMessageCount: priorMessageCount ?? undefined,
  });
  const images = toolFollowUp ? [] : await lastUserAgentImages(messages);
  if (!existing) await persistBinding(checkpoint.state);
  if (priorMessageCount && messages.length > priorMessageCount) {
    console.log(`  custom_tools slice prior=${priorMessageCount} n=${messages.length}`);
  }
  const run = await agent.send(prompt, images.length ? { images } : undefined);
  await persistCommittedLength();
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
    live.thinking = result.thinking;
    live.error = result.error;
    live.usage = result.usage;
    void persistBinding(checkpoint.state);
  });
  const origin = existing ? "follow" : binding ? "kv_hit" : "create";
  console.log(`  custom_tools ${origin} session=${sessionId.slice(0, 24)} agent=${agent.agentId.slice(0, 14)} tools=${opts.tools.length} images=${images.length}`);
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
  const hit = promptCacheHitPercent(usage);
  const hitPart = hit == null ? "" : ` hit=${hit}%`;
  console.log(
    `  custom_tools usage in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadTokens ?? 0} cache_write=${usage.cacheWriteTokens ?? 0}${hitPart}`,
  );
}

function liveResult(live: LiveTurn): CustomToolTurnResult {
  return { text: live.text, thinking: live.thinking, error: live.error, usage: live.usage };
}

function anthropicContentBlocks(opts: { thinking?: string; text?: string; toolUses?: unknown[] }): unknown[] {
  const content: unknown[] = [];
  if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
  if (opts.text) content.push({ type: "text", text: opts.text });
  if (opts.toolUses?.length) content.push(...opts.toolUses);
  return content.length ? content : [{ type: "text", text: "" }];
}

function openAiCompletion(opts: {
  model: unknown;
  agentId: string;
  sessionId: string;
  text: string;
  thinking?: string;
  error?: string;
  usage?: AgentTurnUsage;
  toolCalls?: ReturnType<typeof clientToolsToOpenAi>;
}) {
  const toolCalls = opts.toolCalls?.length ? opts.toolCalls : undefined;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: opts.text || (toolCalls ? null : ""),
  };
  if (opts.thinking) message.reasoning_content = opts.thinking;
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
  kv?: Kv;
}): Promise<Response> {
  const apiKey = cloudApiKeyFromHeaders(opts.headers);
  const started = await startCustomToolTurn({
    apiKey,
    body: opts.body,
    tools: opts.tools,
    signal: opts.signal,
    kv: opts.kv,
    protocol: "openai",
  });
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
        thinking: started.live.thinking,
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
      thinking: result.thinking,
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
  kv?: Kv;
}): Promise<Response> {
  const apiKey = cloudApiKeyFromHeaders(opts.headers);
  const started = await startCustomToolTurn({
    apiKey,
    body: opts.body,
    tools: opts.tools,
    signal: opts.signal,
    kv: opts.kv,
    protocol: "anthropic",
  });
  const agentId = started.live.agent.agentId;
  if (opts.body.stream) {
    return streamCustomAnthropic({ ...started, model: opts.body.model, agentId, requestId: opts.requestId, signal: opts.signal });
  }
  const settled = await settleCustomTools(started.session, started.live);
  if (settled.kind === "tools") {
    offerClientToolBatch(started.session, settled.batch);
    const toolUses = clientToolsToAnthropic(settled.batch);
    return jsonResponse(200, {
      id: `msg_${agentId}`,
      type: "message",
      role: "assistant",
      model: String(opts.body.model || "composer-2.5"),
      content: anthropicContentBlocks({ thinking: started.live.thinking, text: started.live.text, toolUses }),
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
    content: anthropicContentBlocks({ thinking: result.thinking, text: result.text || result.error || "" }),
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
        if (live.thinking) controller.enqueue(chunk({ reasoning_content: live.thinking }));
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
        if (live.thinking) {
          controller.enqueue(
            encodeSseEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "thinking", thinking: "" },
            }),
          );
          controller.enqueue(
            encodeSseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: live.thinking },
            }),
          );
          controller.enqueue(encodeSseEvent("content_block_stop", { type: "content_block_stop", index }));
          index += 1;
        }
        if (live.text) {
          controller.enqueue(encodeSseEvent("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
          controller.enqueue(encodeSseEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: live.text } }));
          controller.enqueue(encodeSseEvent("content_block_stop", { type: "content_block_stop", index }));
          index += 1;
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
