/**
 * Custom-tools chat path: OpenAI tools → in-process `customTools.execute`.
 * The agent loop is AgentService/Run. Client tools stay OpenAI / Anthropic
 * function tools; this gateway is not an MCP server and does not expose
 * HTTP `/mcp`. AgentService's wire allowlist still has to name the MCP
 * family or custom function tools never appear — that is Cursor's constraint,
 * not a product surface.
 *
 * Conversation id is `tenant:agentRunFp` (model / effort / tools / system /
 * first user). Client `x-session-id` / `conversation_id` are ignored. KV
 * `agent-run:` restores ids after a Deno isolate hop (TTL 24h). KV
 * `agent-run-len:` stores the last successful `messages.length` (TTL 5 min)
 * so the next request can slice only the new suffix.
 *
 * Each HTTP request opens and closes one AgentService/Run. Returning
 * `tool_calls` closes that duplex **without** `cancelAction`. The next
 * `role: tool` is a new Run: the gateway splices `conversationState`
 * (`rootPromptMessagesJson` blobs) from the full client transcript and
 * sends `userMessageAction` = `composeToolResultPrompt` (the previous
 * duplex is already closed; empty `resumeAction` ends with blank text).
 * Follow-up user turns send only the new user text in `userMessageAction`.
 * Client disconnect / SSE cancel sends
 * `conversationAction.cancelAction` on the in-flight Run, then closes
 * the duplex.
 *
 * Client contract (the normal path, not an edge case): every request carries
 * the full OpenAI/Anthropic transcript, and the client keeps that prefix
 * stable (append-only). History goes into spliced conversationState — never
 * reship the whole history into AgentService `userMessageAction`.
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
  extractLatestClientToolResults,
  failParkedClientTools,
  lastTurnIsToolResult,
  offerClientToolBatch,
  toSdkCustomTools,
  upsertClientToolSession,
  waitForClientToolBatch,
  type ClientToolSession,
  type CustomToolDef,
  type ParkedClientTool,
} from "./custom_tools.ts";
import { gatewayAgentModelSelection, promptCacheHitPercent, type AgentInlineImage, type AgentTurnUsage } from "./agent_json.ts";
import { openaiContentToCursorParts } from "./content_parts.ts";
import { spliceConversationFromClient } from "./conversation_state.ts";
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

/** Keep AgentService request context aligned with the client system prompt. */
export function cwdFromClientSystem(body: Record<string, unknown>): string | undefined {
  const system = systemPromptFromClient(body);
  const matches = [
    ...system.matchAll(/^\s*(?:Working directory|Current working directory)\s*:\s*(.+?)\s*$/gim),
  ];
  for (let i = matches.length - 1; i >= 0; i--) {
    const raw = String(matches[i]?.[1] || "").trim();
    const quoted = raw.match(/^([`'"])(.*)\1$/);
    const cwd = (quoted?.[2] ?? raw).trim();
    if (!cwd || /[\0\r\n]/.test(cwd)) continue;
    if (cwd.startsWith("/") || /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\")) return cwd;
  }
  return undefined;
}

export function composeCustomToolPrompt(opts: {
  body: Record<string, unknown>;
  tools: CustomToolDef[];
  messages: unknown[];
  followUp?: boolean;
}): string {
  void opts.body;
  void opts.tools;
  void opts.followUp;
  return lastUserPrompt(opts.messages);
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
  void opts.body;
  void opts.tools;
  void opts.hadPriorTurn;
  const latest = extractLatestClientToolResults(opts.messages);
  if (lastTurnIsToolResult(opts.messages) && latest.length > 0) return composeToolResultPrompt(latest);
  const prior = opts.priorMessageCount;
  const canSlice = prior != null && Number.isInteger(prior) && prior > 0 && opts.messages.length > prior;
  if (canSlice) {
    const users = joinUserPrompts(opts.messages.slice(prior));
    if (users) return users;
  }
  return lastUserPrompt(opts.messages);
}

export type CustomToolTurnResult = { text: string; thinking?: string; error?: string; usage?: AgentTurnUsage };

export type AgentStreamDelta = { text?: string; thinking?: string };

export type CustomToolSendOpts = {
  images?: AgentInlineImage[];
  onDelta?: (chunk: AgentStreamDelta) => void;
  signal?: AbortSignal;
  conversationState?: Record<string, unknown>;
  blobs?: Map<string, string>;
  resume?: boolean;
  customSystemPrompt?: string;
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
  customSystemPrompt?: string;
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
  session: ClientToolSession;
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

/** Close this HTTP request's AgentService/Run after offering tool_calls.
 * Close-only: `cancelAction` would void the turn and break the next `role: tool`. */
function releaseUpstreamAfterPark(live: LiveTurn, session: ClientToolSession): void {
  (live.release ?? live.abort)?.();
  failParkedClientTools(session, "released: request-scoped AgentService run");
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

async function settleCustomTools(
  session: ClientToolSession,
  live: LiveTurn,
): Promise<{ kind: "tools"; batch: ParkedClientTool[] } | { kind: "text" }> {
  // HTTP request.signal is bound to this turn's abort() (cancelAction) via
  // attachClientAbort, not send({ signal }). Detach before returning 200 so
  // Deno legacy abort after a successful response cannot fire cancel on a
  // parked or later turn.
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
  /** Passed into AgentService send() — stream cancel, not HTTP request.signal. */
  sendSignal?: AbortSignal;
  /** Bind `signal` to cancelAction after send(). Stream path sets false. */
  attachAbort?: boolean;
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
  const toolFollowUp = lastTurnIsToolResult(messages) && toolResults.length > 0;
  const key = liveKey(tenant, sessionFp);
  const existing = liveTurns.get(key);

  const persistCommittedLength = async () => {
    if (!opts.kv) return;
    await kvSetAgentRunLen(opts.kv, tenant, sessionFp, messages.length);
  };

  if (existing && !existing.done) {
    if (toolFollowUp) {
      (existing.release ?? existing.abort)?.();
      if (session.parked.length) failParkedClientTools(session, "released: previous AgentService run");
    } else {
      existing.abort?.();
      failParkedClientTools(session, "cancelled: new user turn");
    }
    try {
      await existing.wait();
    } catch {
      /* previous AgentService/Run closed */
    }
  } else if (session.parked.length && !toolFollowUp) {
    failParkedClientTools(session, "cancelled: new user turn");
  }

  const binding = opts.kv ? await kvGetAgentRun(opts.kv, tenant, sessionFp, sessionFp) : null;
  const priorMessageCount = opts.kv ? await kvGetAgentRunLen(opts.kv, tenant, sessionFp) : null;
  const ids = binding
    ? { conversationId: binding.conversationId, agentSessionId: binding.agentSessionId }
    : computedIds;
  const sessionId = ids.conversationId;
  const persistBinding = async () => {
    if (!opts.kv) return;
    await kvSetAgentRun(opts.kv, tenant, sessionFp, {
      fp: sessionFp,
      conversationId: ids.conversationId,
      agentSessionId: ids.agentSessionId,
    });
  };

  const spliced = await spliceConversationFromClient({
    body: opts.body,
    tools: opts.tools,
    messages,
    priorMessageCount: priorMessageCount ?? undefined,
  });

  const host = await resolveHost();
  const customTools = toSdkCustomTools(session);
  const agent = existing?.agent ?? (await host.create({
    apiKey: opts.apiKey,
    model: opts.body.model,
    fast: extractFastMode(opts.body),
    reasoningEffort: extractReasoningEffort(opts.body),
    customTools,
    cwd: cwdFromClientSystem(opts.body),
    conversationId: ids.conversationId,
    agentSessionId: ids.agentSessionId,
    onCheckpoint: () => {
      void persistBinding();
    },
  }));
  if (toolFollowUp) {
    console.log(
      `  custom_tools follow_tool session=${sessionId.slice(0, 24)} existing=${Boolean(existing)} kv=${Boolean(binding)} resume=${spliced.resume} roots=${(spliced.conversationState.rootPromptMessagesJson as unknown[] | undefined)?.length ?? 0} — new AgentService/Run`,
    );
  }
  const images = toolFollowUp ? [] : await lastUserAgentImages(messages);
  if (!existing) await persistBinding();
  if (priorMessageCount && messages.length > priorMessageCount) {
    console.log(`  custom_tools slice prior=${priorMessageCount} n=${messages.length}`);
  }
  const rootCount = (spliced.conversationState.rootPromptMessagesJson as unknown[] | undefined)?.length ?? 0;
  if (!toolFollowUp && (existing || binding)) {
    console.log(
      `  custom_tools follow_user session=${sessionId.slice(0, 24)} existing=${Boolean(existing)} kv=${Boolean(binding)} resume=${spliced.resume} roots=${rootCount}`,
    );
  }
  const deltas = createTextDeltaHub();
  const run = await agent.send(spliced.prompt, {
    ...(images.length ? { images } : {}),
    resume: spliced.resume,
    blobs: spliced.blobs,
    // AgentService follow-ups reject a missing field (`Conversation state is
    // required`). Always send spliced roots — never omit, never `{}`, never
    // empty `turns: []`. Do not rely on an in-memory checkpoint: Cursor's
    // echoed roots can be empty placeholders.
    conversationState: spliced.conversationState,
    onDelta: (chunk) => deltas.push(chunk),
    // Do not pass HTTP request.signal into send(): Deno.serve aborts it after
    // 200, which would cancelAction a parked Run. Stream cancel uses sendSignal.
    ...(opts.sendSignal ? { signal: opts.sendSignal } : {}),
  });
  await persistCommittedLength();
  const abortRun = () => run.abort?.();
  const releaseRun = () => (run.release ?? run.abort)?.();
  const detachClientAbort = opts.attachAbort === false ? () => {} : attachClientAbort(opts.signal, abortRun);
  const live: LiveTurn = {
    agent,
    session,
    wait: run.wait,
    abort: abortRun,
    release: releaseRun,
    detachClientAbort,
    done: false,
    text: "",
    deltas,
  };
  session.agentId = agent.agentId;
  liveTurns.set(key, live);
  void live.wait().then((result) => {
    live.done = true;
    live.text = result.text;
    live.thinking = result.thinking;
    live.error = result.error;
    live.usage = result.usage;
    void persistBinding();
    detachClientAbort();
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

function trimAgentError(error?: string): string | undefined {
  const msg = String(error || "").trim();
  return msg || undefined;
}

type MappedAgentError = {
  status: number;
  type: string;
  code: string;
  message: string;
};

function mapAgentError(error?: string): MappedAgentError | undefined {
  const message = trimAgentError(error);
  if (!message) return undefined;
  const normalized = message.toLowerCase();

  if (/resource[_\s-]?exhausted|rate[_\s-]?limit|too many requests|usage limit|quota (?:exceeded|exhausted)/i.test(normalized)) {
    return {
      status: 429,
      type: "rate_limit_error",
      code: normalized.includes("resource_exhausted") ? "resource_exhausted" : "rate_limit_exceeded",
      message,
    };
  }
  if (/error_not_logged_in|not logged in|unauthenticated|authentication/i.test(normalized)) {
    return { status: 401, type: "authentication_error", code: "authentication_error", message };
  }
  if (/permission[_\s-]?denied|forbidden|not supported in your region/i.test(normalized)) {
    return { status: 403, type: "permission_error", code: "permission_denied", message };
  }
  if (/max(?:imum)? output tokens|output_token_limit/i.test(normalized)) {
    return { status: 400, type: "invalid_request_error", code: "max_output_tokens", message };
  }
  if (/invalid[_\s-]?argument|bad[_\s-]?model|bad model|unknown option/i.test(normalized)) {
    return { status: 400, type: "invalid_request_error", code: "invalid_argument", message };
  }
  if (/request[_\s-]?too[_\s-]?large|payload[_\s-]?too[_\s-]?large/i.test(normalized)) {
    return { status: 413, type: "request_too_large", code: "request_too_large", message };
  }
  if (/deadline[_\s-]?exceeded|timed? out|timeout/i.test(normalized)) {
    return { status: 504, type: "timeout_error", code: "upstream_timeout", message };
  }
  if (/overload|stream_unavailable|temporarily unavailable|service unavailable/i.test(normalized)) {
    return { status: 503, type: "overloaded_error", code: "upstream_unavailable", message };
  }
  if (/not[_\s-]?found/i.test(normalized)) {
    return { status: 404, type: "not_found_error", code: "not_found", message };
  }
  if (/conflict|already exists/i.test(normalized)) {
    return { status: 409, type: "conflict_error", code: "conflict", message };
  }
  return { status: 502, type: "server_error", code: "upstream_error", message };
}

function withAgentErrorHeaders(response: Response, error: MappedAgentError): Response {
  if (error.status === 429) response.headers.set("retry-after", "30");
  return response;
}

function openAiAgentErrorResponse(error: MappedAgentError): Response {
  logCustomToolError(error.message);
  return withAgentErrorHeaders(
    jsonResponse(error.status, {
      error: { message: error.message, type: error.type, code: error.code },
    }),
    error,
  );
}

function anthropicAgentErrorResponse(error: MappedAgentError, requestId: string): Response {
  logCustomToolError(error.message);
  return withAgentErrorHeaders(
    jsonResponse(
      error.status,
      toAnthropicError({ message: error.message, type: error.type, code: error.code }, requestId),
      requestId,
    ),
    error,
  );
}

function logCustomToolError(error?: string): void {
  const msg = trimAgentError(error);
  if (!msg) return;
  console.log(`  custom_tools error ${msg.slice(0, 300)}`);
}

/** AgentService thinkingDelta has no real signature. Use "" so clients can echo the block. */
const AGENT_THINKING_SIGNATURE = "";

function anthropicContentBlocks(opts: { thinking?: string; thinkingSignature?: string; text?: string; toolUses?: unknown[] }): unknown[] {
  const content: unknown[] = [];
  // Keep thinking on the wire (Composer streams thinking for a long time
  // before text). Empty signature is echo-safe; inbound validator accepts it.
  if (opts.thinking) {
    content.push({
      type: "thinking",
      thinking: opts.thinking,
      signature: opts.thinkingSignature ?? AGENT_THINKING_SIGNATURE,
    });
  }
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
  usage?: AgentTurnUsage;
  toolCalls?: ReturnType<typeof clientToolsToOpenAi>;
}) {
  const toolCalls = opts.toolCalls?.length ? opts.toolCalls : undefined;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls ? opts.text || null : opts.text,
  };
  if (opts.thinking) message.reasoning_content = opts.thinking;
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id: opts.agentId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(opts.model || "composer-2.5"),
    choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }],
    usage: openaiUsageFromAgent(opts.usage),
    cursor_agent_id: opts.agentId,
    conversation_id: opts.sessionId,
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
  if (opts.body.stream) {
    return streamCustomOpenAi({
      open: (sendSignal) =>
        startCustomToolTurn({
          apiKey,
          body: opts.body,
          tools: opts.tools,
          kv: opts.kv,
          protocol: "openai",
          attachAbort: false,
          sendSignal,
        }),
      model: opts.body.model,
    });
  }
  const started = await startCustomToolTurn({
    apiKey,
    body: opts.body,
    tools: opts.tools,
    signal: opts.signal,
    kv: opts.kv,
    protocol: "openai",
  });
  const agentId = started.live.agent.agentId;
  const settled = await settleCustomTools(started.session, started.live);
  started.live.detachClientAbort?.();
  if (settled.kind === "tools") {
    offerClientToolBatch(started.session, settled.batch);
    releaseUpstreamAfterPark(started.live, started.session);
    const toolCalls = clientToolsToOpenAi(settled.batch);
    console.log(`  custom_tools park ${toolCalls.map((c) => c.function.name).join(",")}`);
    ackLiveDeltas(started.live, started.live.thinking, started.live.text);
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
  ackLiveDeltas(started.live, result.thinking, result.text);
  const error = mapAgentError(result.error);
  if (error) return openAiAgentErrorResponse(error);
  return jsonResponse(
    200,
    openAiCompletion({
      model: opts.body.model,
      agentId,
      sessionId: started.sessionId,
      text: result.text,
      thinking: result.thinking,
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
  if (opts.body.stream) {
    return streamCustomAnthropic({
      open: (sendSignal) =>
        startCustomToolTurn({
          apiKey,
          body: opts.body,
          tools: opts.tools,
          kv: opts.kv,
          protocol: "anthropic",
          attachAbort: false,
          sendSignal,
        }),
      model: opts.body.model,
      requestId: opts.requestId,
    });
  }
  const started = await startCustomToolTurn({
    apiKey,
    body: opts.body,
    tools: opts.tools,
    signal: opts.signal,
    kv: opts.kv,
    protocol: "anthropic",
  });
  const agentId = started.live.agent.agentId;
  const settled = await settleCustomTools(started.session, started.live);
  started.live.detachClientAbort?.();
  if (settled.kind === "tools") {
    offerClientToolBatch(started.session, settled.batch);
    releaseUpstreamAfterPark(started.live, started.session);
    const toolUses = clientToolsToAnthropic(settled.batch);
    ackLiveDeltas(started.live, started.live.thinking, started.live.text);
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
  ackLiveDeltas(started.live, result.thinking, result.text);
  const error = mapAgentError(result.error);
  if (error) return anthropicAgentErrorResponse(error, opts.requestId);
  return jsonResponse(200, {
    id: `msg_${agentId}`,
    type: "message",
    role: "assistant",
    model: String(opts.body.model || "composer-2.5"),
    content: anthropicContentBlocks({ thinking: result.thinking, text: result.text }),
    stop_reason: "end_turn",
    usage: anthropicUsageFromAgent(result.usage),
    cursor_agent_id: agentId,
    conversation_id: started.sessionId,
  }, opts.requestId);
}

const sseBytes = new TextEncoder();
const SSE_CONNECTED = sseBytes.encode(": connected\n\n");
const SSE_KEEPALIVE = sseBytes.encode(": keepalive\n\n");
const SSE_KEEPALIVE_MS = 1_000;

type StartedTurn = { live: LiveTurn; session: ClientToolSession; sessionId: string };

function streamCustomOpenAi(opts: {
  open: (sendSignal: AbortSignal) => Promise<StartedTurn>;
  model: unknown;
}): Promise<Response> {
  const created = Math.floor(Date.now() / 1000);
  const streamAbort = new AbortController();
  let live: LiveTurn | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keep = setInterval(() => {
        try {
          controller.enqueue(SSE_KEEPALIVE);
        } catch {
          /* stream already closed */
        }
      }, SSE_KEEPALIVE_MS);
      try {
        controller.enqueue(SSE_CONNECTED);
        const started = await opts.open(streamAbort.signal);
        live = started.live;
        if (streamAbort.signal.aborted) {
          live.abort?.();
          return;
        }
        const { session, sessionId } = started;
        const agentId = live.agent.agentId;
        const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
          encodeSseData({
            id: agentId,
            object: "chat.completion.chunk",
            created,
            model: String(opts.model || "composer-2.5"),
            choices: [{ index: 0, delta, finish_reason: finish }],
            cursor_agent_id: agentId,
            conversation_id: sessionId,
            ...extra,
          });
        let emittedThinking = live.deltas.ackedThinking;
        let emittedText = live.deltas.ackedText;
        const flush = () => {
          const thinking = longerText(live!.thinking, live!.deltas.streamedThinking);
          const text = longerText(live!.text, live!.deltas.streamedText);
          if (thinking.length > emittedThinking) {
            controller.enqueue(chunk({ reasoning_content: thinking.slice(emittedThinking) }));
            emittedThinking = thinking.length;
          }
          if (text.length > emittedText) {
            controller.enqueue(chunk({ content: text.slice(emittedText) }));
            emittedText = text.length;
          }
        };
        controller.enqueue(chunk({ role: "assistant" }));
        const unsub = live.deltas.subscribe(flush);
        flush();
        const settled = await settleCustomTools(session, live);
        unsub();
        flush();
        live.deltas.ackedThinking = emittedThinking;
        live.deltas.ackedText = emittedText;
        const usage = openaiUsageFromAgent(live.usage);
        if (settled.kind === "tools") {
          offerClientToolBatch(session, settled.batch);
          releaseUpstreamAfterPark(live, session);
          const toolCalls = clientToolsToOpenAi(settled.batch);
          console.log(`  custom_tools park ${toolCalls.map((c) => c.function.name).join(",")}`);
          controller.enqueue(chunk({ tool_calls: toolCalls }));
          controller.enqueue(chunk({}, "tool_calls", { usage }));
          controller.enqueue(
            encodeSseData({
              id: agentId,
              object: "chat.completion.chunk",
              created,
              model: String(opts.model || "composer-2.5"),
              choices: [],
              usage,
            }),
          );
          controller.enqueue(sseBytes.encode("data: [DONE]\n\n"));
          return;
        }
        logAgentUsage(live.usage);
        const error = mapAgentError(live.error);
        if (error) {
          logCustomToolError(error.message);
          controller.enqueue(
            encodeSseData({
              id: agentId,
              object: "chat.completion.chunk",
              created,
              model: String(opts.model || "composer-2.5"),
              choices: [],
              error: { message: error.message, type: error.type, code: error.code },
            }),
          );
          return;
        }
        controller.enqueue(chunk({}, "stop", { usage }));
        controller.enqueue(
          encodeSseData({
            id: agentId,
            object: "chat.completion.chunk",
            created,
            model: String(opts.model || "composer-2.5"),
            choices: [],
            usage,
          }),
        );
        controller.enqueue(sseBytes.encode("data: [DONE]\n\n"));
      } catch (err) {
        const error = mapAgentError(err instanceof Error ? err.message : String(err))!;
        controller.enqueue(
          encodeSseData({
            id: "chatcmpl-error",
            object: "chat.completion.chunk",
            created,
            model: String(opts.model || "composer-2.5"),
            choices: [],
            error: { message: error.message, type: error.type, code: error.code },
          }),
        );
      } finally {
        clearInterval(keep);
        live?.detachClientAbort?.();
        controller.close();
      }
    },
    cancel() {
      streamAbort.abort();
      live?.detachClientAbort?.();
      live?.abort?.();
    },
  });
  return Promise.resolve(sseStreamResponse(stream));
}

function streamCustomAnthropic(opts: {
  open: (sendSignal: AbortSignal) => Promise<StartedTurn>;
  model: unknown;
  requestId: string;
}): Promise<Response> {
  const { model, requestId } = opts;
  const streamAbort = new AbortController();
  let live: LiveTurn | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keep = setInterval(() => {
        try {
          controller.enqueue(SSE_KEEPALIVE);
        } catch {
          /* stream already closed */
        }
      }, SSE_KEEPALIVE_MS);
      let index = 0;
      let open: "thinking" | "text" | null = null;
      let emittedThinking = 0;
      let emittedText = 0;
      const closeOpen = () => {
        if (!open) return;
        if (open === "thinking") {
          controller.enqueue(
            encodeSseEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: AGENT_THINKING_SIGNATURE },
            }),
          );
        }
        controller.enqueue(encodeSseEvent("content_block_stop", { type: "content_block_stop", index }));
        index += 1;
        open = null;
      };
      try {
        controller.enqueue(SSE_CONNECTED);
        const started = await opts.open(streamAbort.signal);
        live = started.live;
        if (streamAbort.signal.aborted) {
          live.abort?.();
          return;
        }
        const { session } = started;
        const agentId = live.agent.agentId;
        const msgId = `msg_${agentId}`;
        emittedThinking = live.deltas.ackedThinking;
        emittedText = live.deltas.ackedText;
        const flush = () => {
        const thinking = longerText(live!.thinking, live!.deltas.streamedThinking);
        const text = longerText(live!.text, live!.deltas.streamedText);
        if (thinking.length > emittedThinking) {
          if (open !== "thinking") {
            closeOpen();
            controller.enqueue(
              encodeSseEvent("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "thinking", thinking: "", signature: AGENT_THINKING_SIGNATURE },
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
        const unsub = live.deltas.subscribe(flush);
        flush();
        const settled = await settleCustomTools(session, live);
        unsub();
        flush();
        closeOpen();
        live.deltas.ackedThinking = emittedThinking;
        live.deltas.ackedText = emittedText;
        if (settled.kind === "tools") {
          offerClientToolBatch(session, settled.batch);
          releaseUpstreamAfterPark(live, session);
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
        const error = mapAgentError(live.error);
        if (error) {
          logCustomToolError(error.message);
          controller.enqueue(
            encodeSseEvent(
              "error",
              toAnthropicError({ message: error.message, type: error.type, code: error.code }, requestId),
            ),
          );
          return;
        }
        controller.enqueue(
          encodeSseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: anthropicUsageFromAgent(live.usage),
          }),
        );
        controller.enqueue(encodeSseEvent("message_stop", { type: "message_stop" }));
      } catch (err) {
        const error = mapAgentError(err instanceof Error ? err.message : String(err))!;
        controller.enqueue(
          encodeSseEvent(
            "error",
            toAnthropicError({ message: error.message, type: error.type, code: error.code }, requestId),
          ),
        );
      } finally {
        clearInterval(keep);
        live?.detachClientAbort?.();
        controller.close();
      }
    },
    cancel() {
      streamAbort.abort();
      live?.detachClientAbort?.();
      live?.abort?.();
    },
  });
  return Promise.resolve(sseStreamResponse(stream, requestId));
}
