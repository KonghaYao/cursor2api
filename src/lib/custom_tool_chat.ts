/**
 * Custom-tools chat path: OpenAI/Anthropic function tools → text `<gw_tool_call>`
 * fences parsed after turnEnded. One HTTP request = one AgentService/Run.
 * Client tools stay OpenAI / Anthropic function tools; upstream has empty
 * MCP tools and no default shell/edit toolset.
 *
 * Conversation id is `tenant:agentRunFp` (model / effort / tools / system /
 * first user). Client `x-session-id` / `conversation_id` are ignored. KV
 * `agent-run:` restores ids after a Deno isolate hop (TTL 24h). KV
 * `agent-run-len:` stores the last successful `messages.length` (TTL 5 min)
 * so the next request can slice only the new suffix.
 *
 * Each HTTP request opens and closes one AgentService/Run. Returning
 * `tool_calls` closes that duplex **without** `cancelAction` (that would
 * drop the turn from conversationState). The next `role: tool` is a new Run
 * with the latest tool results flattened into `userMessageAction`.
 * Client disconnect / SSE cancel sends `conversationAction.cancelAction`
 * on the in-flight Run, then closes the duplex.
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
  clientToolsDisabled,
  composeToolResultPrompt,
  extractClientToolResults,
  extractLatestClientToolResults,
  lastTurnIsToolResult,
  type CustomToolDef,
} from "./custom_tools.ts";
import {
  composeReplacementSystemPrompt,
  gwToolCallsToAnthropic,
  gwToolCallsToOpenAi,
  splitAssistantToolText,
  stripGwToolCallFences,
} from "./text_tool_calls.ts";
import { gatewayAgentModelSelection, promptCacheHitPercent, type AgentInlineImage, type AgentTurnUsage } from "./agent_json.ts";
import { openaiContentToCursorParts } from "./content_parts.ts";
import { defaultSdkAgentHost } from "./sdk_agent_host.ts";

export type SdkCustomToolMap = Record<
  string,
  {
    description?: string;
    inputSchema?: Record<string, unknown>;
    execute: (args: Record<string, unknown>, ctx: { toolCallId?: string }) => Promise<unknown>;
  }
>;

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

/** Default on: Dashboard `crsr_` still rejects Connect `customSystemPrompt`. Set `GATEWAY_FOLD_SYSTEM=0` to try the SDK replacement field. */
function gatewayFoldSystemEnabled(): boolean {
  const raw = (readEnv("GATEWAY_FOLD_SYSTEM") || "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function replacementSystemPrompt(body: Record<string, unknown>, tools: CustomToolDef[]): string {
  return composeReplacementSystemPrompt({
    clientSystem: systemPromptFromClient(body),
    tools,
    body,
  });
}

export function composeCustomToolPrompt(opts: {
  body: Record<string, unknown>;
  tools: CustomToolDef[];
  messages: unknown[];
  followUp?: boolean;
}): string {
  const user = lastUserPrompt(opts.messages);
  if (opts.followUp) return user;
  if (!gatewayFoldSystemEnabled()) return user;
  const system = replacementSystemPrompt(opts.body, opts.tools);
  if (!system.trim()) return user;
  return `<system>\n${system}\n</system>\n\n${user}`;
}

/** Whether this turn should pass systemPrompt on agent.send (not folded into user). */
export function shouldSendReplacementSystemPrompt(opts: {
  hadPriorTurn: boolean;
  toolFollowUp: boolean;
  foldSystem: boolean;
}): boolean {
  if (opts.foldSystem) return false;
  if (opts.toolFollowUp && opts.hadPriorTurn) return false;
  if (opts.toolFollowUp && !opts.hadPriorTurn) return true;
  if (opts.hadPriorTurn) return false;
  return true;
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
  // fold the original user question and every tool result we have.
  // Warm thread: only the latest round — reshipping history is a cache miss.
  const results = composeToolResultPrompt(opts.hadPriorTurn ? latest : extractClientToolResults(opts.messages));
  if (opts.hadPriorTurn) return results;
  return [
    composeCustomToolPrompt({
      body: opts.body,
      tools: opts.tools,
      messages: opts.messages,
      followUp: false,
    }),
    results,
  ].filter(Boolean).join("\n\n");
}

export type CustomToolTurnResult = { text: string; thinking?: string; error?: string; usage?: AgentTurnUsage };

export type AgentStreamDelta = { text?: string; thinking?: string };

export type CustomToolSendOpts = {
  images?: AgentInlineImage[];
  onDelta?: (chunk: AgentStreamDelta) => void;
  signal?: AbortSignal;
  /** First-shot replacement system prompt (SDK systemPrompt). Omit on follow-ups. */
  systemPrompt?: string;
};

export type CustomToolAgentHandle = {
  agentId: string;
  send: (
    prompt: string,
    opts?: CustomToolSendOpts,
  ) => Promise<{ wait: () => Promise<CustomToolTurnResult>; abort?: () => void; release?: () => void }>;
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
  /** Optional first-shot replacement system prompt; also passed per send(). */
  systemPrompt?: string;
  onCheckpoint?: (state: Record<string, unknown>) => void;
};

export type CustomToolAgentHost = {
  create: (opts: CustomToolAgentCreateOpts) => Promise<CustomToolAgentHandle>;
};

type TextDeltaHub = {
  streamedText: string;
  streamedThinking: string;
  ackedText: number;
  ackedThinking: number;
  push: (chunk: AgentStreamDelta) => void;
  subscribe: (fn: () => void) => () => void;
};

function createTextDeltaHub(): TextDeltaHub {
  let streamedText = "";
  let streamedThinking = "";
  let ackedText = 0;
  let ackedThinking = 0;
  const waiters = new Set<() => void>();
  return {
    get streamedText() {
      return streamedText;
    },
    get streamedThinking() {
      return streamedThinking;
    },
    get ackedText() {
      return ackedText;
    },
    set ackedText(value: number) {
      ackedText = value;
    },
    get ackedThinking() {
      return ackedThinking;
    },
    set ackedThinking(value: number) {
      ackedThinking = value;
    },
    push(chunk: AgentStreamDelta) {
      let changed = false;
      if (chunk.text) {
        streamedText += chunk.text;
        changed = true;
      }
      if (chunk.thinking) {
        streamedThinking += chunk.thinking;
        changed = true;
      }
      if (changed) for (const fn of waiters) fn();
    },
    subscribe(fn: () => void) {
      waiters.add(fn);
      return () => {
        waiters.delete(fn);
      };
    },
  };
}

function longerText(a?: string, b?: string): string {
  const x = a || "";
  const y = b || "";
  return x.length >= y.length ? x : y;
}

function ackLiveDeltas(live: LiveTurn, thinking?: string, text?: string): void {
  live.deltas.ackedThinking = Math.max(
    live.deltas.ackedThinking,
    (thinking || "").length,
    live.deltas.streamedThinking.length,
  );
  live.deltas.ackedText = Math.max(
    live.deltas.ackedText,
    (text || "").length,
    live.deltas.streamedText.length,
  );
}

type LiveTurn = {
  agent: CustomToolAgentHandle;
  wait: () => Promise<CustomToolTurnResult>;
  abort?: () => void;
  release?: () => void;
  detachClientAbort?: () => void;
  done: boolean;
  text: string;
  thinking?: string;
  error?: string;
  usage?: AgentTurnUsage;
  deltas: TextDeltaHub;
  bufferText: boolean;
};

function attachClientAbort(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    abort();
    return () => {};
  }
  const onAbort = () => {
    console.log("  custom_tools client_abort — AgentService cancelAction");
    abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Close this HTTP request's AgentService/Run after returning tool_calls.
 * Close-only: `cancelAction` would void the turn and break the next `role: tool`. */
function releaseUpstreamAfterTurn(live: LiveTurn): void {
  live.release?.();
}

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

async function settleTextTurn(
  live: LiveTurn,
  tools: CustomToolDef[],
  body: Record<string, unknown>,
): Promise<
  | {
      kind: "tools";
      openAiToolCalls: ReturnType<typeof gwToolCallsToOpenAi>;
      anthropicToolUses: ReturnType<typeof gwToolCallsToAnthropic>;
      visibleText: string;
      thinking?: string;
      usage?: AgentTurnUsage;
    }
  | { kind: "text"; result: CustomToolTurnResult }
> {
  const result = live.done ? liveResult(live) : await live.wait();
  live.done = true;
  live.text = result.text;
  live.thinking = result.thinking;
  live.error = result.error;
  live.usage = result.usage;
  if (tools.length && !clientToolsDisabled(body)) {
    const { calls, visibleText } = splitAssistantToolText(result.text, tools);
    if (calls.length) {
      return {
        kind: "tools",
        openAiToolCalls: gwToolCallsToOpenAi(calls),
        anthropicToolUses: gwToolCallsToAnthropic(calls),
        visibleText,
        thinking: result.thinking ? stripGwToolCallFences(result.thinking, tools) : result.thinking,
        usage: result.usage,
      };
    }
  }
  return { kind: "text", result };
}

async function startCustomToolTurn(opts: {
  apiKey: string;
  body: Record<string, unknown>;
  tools: CustomToolDef[];
  signal?: AbortSignal;
  kv?: Kv;
  protocol?: "openai" | "anthropic";
}): Promise<{ live: LiveTurn; sessionId: string; continued: boolean }> {
  const tenant = await credentialFingerprint(opts.apiKey);
  if (resolveSessionMode() === "random") {
    throw new CloudChatError(
      "SESSION_MODE=random breaks stable conversationId; text gw_tool_call tools need tenant:agentRunFp.",
      400,
    );
  }
  const protocol = opts.protocol ?? "openai";
  const sessionFp = await sessionFpForCustomTools(opts.body, protocol);
  const computedIds = agentRunIds(tenant, sessionFp);
  const messages = Array.isArray(opts.body.messages) ? opts.body.messages : [];
  const toolResults = extractLatestClientToolResults(messages);
  const toolFollowUp = lastTurnIsToolResult(messages) && toolResults.length > 0;
  const key = liveKey(tenant, sessionFp);
  const existing = liveTurns.get(key);

  const persistCommittedLength = async () => {
    if (!opts.kv) return;
    await kvSetAgentRunLen(opts.kv, tenant, sessionFp, messages.length);
  };

  if (existing && !existing.done) {
    if (toolFollowUp) {
      existing.release?.();
    } else {
      existing.abort?.();
    }
    try {
      await existing.wait();
    } catch {
      /* previous AgentService/Run closed */
    }
  }

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
  const hadPriorTurn = Boolean(existing) || Boolean(binding);
  const foldSystem = gatewayFoldSystemEnabled();
  const sendSystem = shouldSendReplacementSystemPrompt({ hadPriorTurn, toolFollowUp, foldSystem });
  const systemPrompt = sendSystem ? replacementSystemPrompt(opts.body, opts.tools) : undefined;
  const agent = existing?.agent ?? (await host.create({
    apiKey: opts.apiKey,
    model: opts.body.model,
    fast: extractFastMode(opts.body),
    reasoningEffort: extractReasoningEffort(opts.body),
    customTools: {},
    conversationId: ids.conversationId,
    agentSessionId: ids.agentSessionId,
    conversationState: checkpoint.state,
    ...(systemPrompt ? { systemPrompt } : {}),
    onCheckpoint: (state) => {
      checkpoint.state = state;
      void persistBinding(state);
    },
  }));
  if (toolFollowUp) {
    console.log(
      `  custom_tools follow_tool session=${sessionId.slice(0, 24)} existing=${Boolean(existing)} kv=${Boolean(binding)} — new AgentService/Run`,
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
  const deltas = createTextDeltaHub();
  const bufferText = opts.tools.length > 0 && !clientToolsDisabled(opts.body);
  const run = await agent.send(prompt, {
    ...(images.length ? { images } : {}),
    ...(sendSystem && systemPrompt ? { systemPrompt } : {}),
    onDelta: (chunk) => deltas.push(chunk),
    // Do not pass HTTP request.signal into send(): Deno.serve aborts it after
    // 200, which would cancelAction a completed Run. Client abort is attachClientAbort.
  });
  await persistCommittedLength();
  const abortRun = () => run.abort?.();
  const releaseRun = () => run.release?.();
  const detachClientAbort = attachClientAbort(opts.signal, abortRun);
  const live: LiveTurn = {
    agent,
    wait: run.wait,
    abort: abortRun,
    release: releaseRun,
    detachClientAbort,
    done: false,
    text: "",
    deltas,
    bufferText,
  };
  liveTurns.set(key, live);
  void live.wait().then((result) => {
    live.done = true;
    live.text = result.text;
    live.thinking = result.thinking;
    live.error = result.error;
    live.usage = result.usage;
    void persistBinding(checkpoint.state);
    detachClientAbort();
  });
  const origin = existing ? "follow" : binding ? "kv_hit" : "create";
  console.log(`  custom_tools ${origin} session=${sessionId.slice(0, 24)} agent=${agent.agentId.slice(0, 14)} tools=${opts.tools.length} images=${images.length}`);
  return { live, sessionId, continued: false };
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

function trimAgentError(error?: string): string | undefined {
  const msg = String(error || "").trim();
  return msg || undefined;
}

function logCustomToolError(error?: string): void {
  const msg = trimAgentError(error);
  if (!msg) return;
  console.log(`  custom_tools error ${msg.slice(0, 300)}`);
}

/** Cursor Agent often ignores a lone `error` field; keep the message in visible text too. */
function agentVisibleText(text?: string, error?: string): string {
  const t = text || "";
  const e = trimAgentError(error);
  if (!e) return t;
  if (!t) return e;
  if (t.includes(e)) return t;
  return `${t}\n${e}`;
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
  toolCalls?: ReturnType<typeof gwToolCallsToOpenAi>;
}) {
  const toolCalls = opts.toolCalls?.length ? opts.toolCalls : undefined;
  const err = trimAgentError(opts.error);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls ? opts.text || null : agentVisibleText(opts.text, err),
  };
  if (opts.thinking) message.reasoning_content = opts.thinking;
  if (toolCalls) message.tool_calls = toolCalls;
  if (err) logCustomToolError(err);
  return {
    id: opts.agentId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(opts.model || "composer-2.5"),
    choices: [{ index: 0, message, finish_reason: err ? "stop" : toolCalls ? "tool_calls" : "stop" }],
    usage: openaiUsageFromAgent(opts.usage),
    cursor_agent_id: opts.agentId,
    conversation_id: opts.sessionId,
    error: err ? { message: err, type: "api_error" } : undefined,
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
    return streamCustomOpenAi({ ...started, model: opts.body.model, agentId, tools: opts.tools, body: opts.body, signal: opts.signal });
  }
  const settled = await settleTextTurn(started.live, opts.tools, opts.body);
  started.live.detachClientAbort?.();
  if (settled.kind === "tools") {
    releaseUpstreamAfterTurn(started.live);
    const toolCalls = settled.openAiToolCalls;
    console.log(`  custom_tools text ${toolCalls.map((c) => c.function.name).join(",")}`);
    ackLiveDeltas(started.live, settled.thinking, settled.visibleText);
    return jsonResponse(
      200,
      openAiCompletion({
        model: opts.body.model,
        agentId,
        sessionId: started.sessionId,
        text: settled.visibleText,
        thinking: settled.thinking,
        usage: settled.usage,
        toolCalls,
      }),
    );
  }
  const result = settled.result;
  logAgentUsage(result.usage);
  ackLiveDeltas(started.live, result.thinking, result.text);
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
    return streamCustomAnthropic({
      ...started,
      model: opts.body.model,
      agentId,
      tools: opts.tools,
      body: opts.body,
      requestId: opts.requestId,
      signal: opts.signal,
    });
  }
  const settled = await settleTextTurn(started.live, opts.tools, opts.body);
  started.live.detachClientAbort?.();
  if (settled.kind === "tools") {
    releaseUpstreamAfterTurn(started.live);
    const toolUses = settled.anthropicToolUses;
    ackLiveDeltas(started.live, settled.thinking, settled.visibleText);
    return jsonResponse(200, {
      id: `msg_${agentId}`,
      type: "message",
      role: "assistant",
      model: String(opts.body.model || "composer-2.5"),
      content: anthropicContentBlocks({ thinking: settled.thinking, text: settled.visibleText, toolUses }),
      stop_reason: "tool_use",
      usage: anthropicUsageFromAgent(settled.usage),
      cursor_agent_id: agentId,
      conversation_id: started.sessionId,
    }, opts.requestId);
  }
  const result = settled.result;
  logAgentUsage(result.usage);
  ackLiveDeltas(started.live, result.thinking, result.text);
  const err = trimAgentError(result.error);
  logCustomToolError(err);
  if (err && !result.text && !result.thinking) {
    return jsonResponse(200, toAnthropicError({ message: err, type: "api_error" }, opts.requestId), opts.requestId);
  }
  return jsonResponse(200, {
    id: `msg_${agentId}`,
    type: "message",
    role: "assistant",
    model: String(opts.body.model || "composer-2.5"),
    content: anthropicContentBlocks({ thinking: result.thinking, text: agentVisibleText(result.text, err) }),
    stop_reason: "end_turn",
    usage: anthropicUsageFromAgent(result.usage),
    cursor_agent_id: agentId,
    conversation_id: started.sessionId,
  }, opts.requestId);
}

function streamCustomOpenAi(opts: {
  live: LiveTurn;
  sessionId: string;
  model: unknown;
  agentId: string;
  tools: CustomToolDef[];
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> {
  const { live, sessionId, model, agentId, tools, body } = opts;
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
      let emittedThinking = live.deltas.ackedThinking;
      let emittedText = live.deltas.ackedText;
      const flushThinking = () => {
        if (live.bufferText) return;
        const thinking = longerText(live.thinking, live.deltas.streamedThinking);
        if (thinking.length > emittedThinking) {
          controller.enqueue(chunk({ reasoning_content: thinking.slice(emittedThinking) }));
          emittedThinking = thinking.length;
        }
      };
      const flushText = (text: string) => {
        if (live.bufferText) return;
        if (text.length > emittedText) {
          controller.enqueue(chunk({ content: text.slice(emittedText) }));
          emittedText = text.length;
        }
      };
      try {
        controller.enqueue(chunk({ role: "assistant" }));
        const unsub = live.deltas.subscribe(() => {
          flushThinking();
          flushText(longerText(live.text, live.deltas.streamedText));
        });
        flushThinking();
        flushText(longerText(live.text, live.deltas.streamedText));
        const settled = await settleTextTurn(live, tools, body);
        unsub();
        flushThinking();
        live.deltas.ackedThinking = emittedThinking;
        if (settled.kind === "tools") {
          releaseUpstreamAfterTurn(live);
          const toolCalls = settled.openAiToolCalls;
          console.log(`  custom_tools text ${toolCalls.map((c) => c.function.name).join(",")}`);
          const thinking = stripGwToolCallFences(settled.thinking || "", tools);
          if (thinking.length > emittedThinking) {
            controller.enqueue(chunk({ reasoning_content: thinking.slice(emittedThinking) }));
            emittedThinking = thinking.length;
          }
          live.deltas.ackedThinking = emittedThinking;
          const visible = settled.visibleText;
          if (visible.length > emittedText) {
            controller.enqueue(chunk({ content: visible.slice(emittedText) }));
            emittedText = visible.length;
          }
          live.deltas.ackedText = emittedText;
          const usage = openaiUsageFromAgent(settled.usage);
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
        const result = settled.result;
        logAgentUsage(result.usage);
        const thinking = stripGwToolCallFences(result.thinking || "", tools);
        if (thinking.length > emittedThinking) {
          controller.enqueue(chunk({ reasoning_content: thinking.slice(emittedThinking) }));
          emittedThinking = thinking.length;
        }
        live.deltas.ackedThinking = emittedThinking;
        const visible = agentVisibleText(result.text, result.error);
        if (visible.length > emittedText) {
          controller.enqueue(chunk({ content: visible.slice(emittedText) }));
          emittedText = visible.length;
        }
        live.deltas.ackedText = emittedText;
        const usage = openaiUsageFromAgent(result.usage);
        const err = trimAgentError(result.error);
        if (err) {
          logCustomToolError(err);
          controller.enqueue(
            encodeSseData({
              id: agentId,
              object: "chat.completion.chunk",
              created,
              model: String(model || "composer-2.5"),
              choices: [],
              error: { message: err, type: "api_error" },
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
        live.detachClientAbort?.();
        controller.close();
      }
    },
    cancel() {
      live.detachClientAbort?.();
      live.abort?.();
    },
  });
  return Promise.resolve(sseStreamResponse(stream));
}

function streamCustomAnthropic(opts: {
  live: LiveTurn;
  sessionId: string;
  model: unknown;
  agentId: string;
  tools: CustomToolDef[];
  body: Record<string, unknown>;
  requestId: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { live, model, agentId, requestId, tools, body } = opts;
  const msgId = `msg_${agentId}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let index = 0;
      let open: "thinking" | "text" | null = null;
      let emittedThinking = live.deltas.ackedThinking;
      let emittedText = live.deltas.ackedText;
      const closeOpen = () => {
        if (!open) return;
        controller.enqueue(encodeSseEvent("content_block_stop", { type: "content_block_stop", index }));
        index += 1;
        open = null;
      };
      const flushThinking = () => {
        if (live.bufferText) return;
        const thinking = longerText(live.thinking, live.deltas.streamedThinking);
        if (thinking.length > emittedThinking) {
          if (open !== "thinking") {
            closeOpen();
            controller.enqueue(
              encodeSseEvent("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "thinking", thinking: "" },
              }),
            );
            open = "thinking";
          }
          controller.enqueue(
            encodeSseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: thinking.slice(emittedThinking) },
            }),
          );
          emittedThinking = thinking.length;
        }
      };
      const flushText = (text: string) => {
        if (live.bufferText) return;
        if (text.length > emittedText) {
          if (open !== "text") {
            closeOpen();
            controller.enqueue(
              encodeSseEvent("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "text", text: "" },
              }),
            );
            open = "text";
          }
          controller.enqueue(
            encodeSseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: text.slice(emittedText) },
            }),
          );
          emittedText = text.length;
        }
      };
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
        const unsub = live.deltas.subscribe(() => {
          flushThinking();
          flushText(longerText(live.text, live.deltas.streamedText));
        });
        flushThinking();
        flushText(longerText(live.text, live.deltas.streamedText));
        const settled = await settleTextTurn(live, tools, body);
        unsub();
        const settledThinking = settled.kind === "tools" ? settled.thinking : settled.result.thinking;
        if (live.bufferText) {
          const thinking = stripGwToolCallFences(settledThinking || "", tools);
          if (thinking.length > emittedThinking) {
            if (open !== "thinking") {
              closeOpen();
              controller.enqueue(
                encodeSseEvent("content_block_start", {
                  type: "content_block_start",
                  index,
                  content_block: { type: "thinking", thinking: "" },
                }),
              );
              open = "thinking";
            }
            controller.enqueue(
              encodeSseEvent("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: thinking.slice(emittedThinking) },
              }),
            );
            emittedThinking = thinking.length;
          }
        } else {
          flushThinking();
        }
        closeOpen();
        open = null;
        live.deltas.ackedThinking = emittedThinking;
        if (settled.kind === "tools") {
          releaseUpstreamAfterTurn(live);
          const visible = settled.visibleText;
          if (visible) {
            controller.enqueue(
              encodeSseEvent("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "text", text: "" },
              }),
            );
            controller.enqueue(
              encodeSseEvent("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: visible },
              }),
            );
            controller.enqueue(encodeSseEvent("content_block_stop", { type: "content_block_stop", index }));
            index += 1;
            emittedText = visible.length;
          }
          live.deltas.ackedText = emittedText;
          for (const call of settled.anthropicToolUses) {
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
              usage: anthropicUsageFromAgent(settled.usage),
            }),
          );
          controller.enqueue(encodeSseEvent("message_stop", { type: "message_stop" }));
          return;
        }
        const result = settled.result;
        logAgentUsage(result.usage);
        const err = trimAgentError(result.error);
        const visible = agentVisibleText(result.text, err);
        if (visible.length > emittedText) {
          if (open !== "text") {
            closeOpen();
            controller.enqueue(
              encodeSseEvent("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "text", text: "" },
              }),
            );
            open = "text";
          }
          controller.enqueue(
            encodeSseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: visible.slice(emittedText) },
            }),
          );
          emittedText = visible.length;
        }
        closeOpen();
        live.deltas.ackedText = emittedText;
        const hadModelOutput = emittedText > 0 || emittedThinking > 0;
        if (err) {
          logCustomToolError(err);
          if (!hadModelOutput) {
            controller.enqueue(
              encodeSseEvent("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "text", text: "" },
              }),
            );
            open = "text";
            controller.enqueue(
              encodeSseEvent("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: err },
              }),
            );
          }
          closeOpen();
          controller.enqueue(encodeSseEvent("error", toAnthropicError({ message: err, type: "api_error" }, requestId)));
          if (!hadModelOutput) return;
        }
        controller.enqueue(
          encodeSseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: anthropicUsageFromAgent(result.usage),
          }),
        );
        controller.enqueue(encodeSseEvent("message_stop", { type: "message_stop" }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encodeSseEvent("error", toAnthropicError({ message, type: "api_error" }, requestId)));
      } finally {
        live.detachClientAbort?.();
        controller.close();
      }
    },
    cancel() {
      live.detachClientAbort?.();
      live.abort?.();
    },
  });
  return Promise.resolve(sseStreamResponse(stream, requestId));
}
