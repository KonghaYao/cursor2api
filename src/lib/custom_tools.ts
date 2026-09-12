/**
 * OpenAI/Anthropic function tools → in-process Cursor customTools.
 *
 * customTools.execute() runs in this process (AgentService MCP executor). We park it and
 * return OpenAI tool_calls so the gateway client executes the real tool.
 * This is not HTTP MCP: Cloud VMs never call us back.
 *
 * stream=true: complete tool_calls in one delta (Cursor Agent, 2026-08-31).
 */
import { randomId } from "./bytes.ts";

export const CUSTOM_TOOL_PARK_TIMEOUT_MS = 9 * 60 * 1000;
export const CUSTOM_TOOL_PARALLEL_DEBOUNCE_MS = 50;

export type CustomToolDef = {
  name: string;
  openaiName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type CustomToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type ParkedClientTool = {
  id: string;
  name: string;
  openaiName: string;
  args: Record<string, unknown>;
  offered: boolean;
  resolve?: (value: CustomToolResult) => void;
};

export type ClientToolSession = {
  tenant: string;
  sessionId: string;
  tools: CustomToolDef[];
  parked: ParkedClientTool[];
  agentId?: string;
};

const sessions = new Map<string, ClientToolSession>();
const waiters = new Map<string, Set<() => void>>();

function sessionKey(tenant: string, sessionId: string): string {
  return `${tenant}:${sessionId}`;
}

function notify(key: string): void {
  const set = waiters.get(key);
  if (!set) return;
  for (const fn of [...set]) fn();
}

function waitNotified(key: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const set = waiters.get(key) ?? new Set();
    waiters.set(key, set);
    const onNotify = () => {
      set.delete(onNotify);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      set.delete(onNotify);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    set.add(onNotify);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function sanitizeCustomToolName(raw: string): string {
  const trimmed = String(raw || "").trim();
  const mapped = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return mapped || "tool";
}

function asSchema(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { type: "object", properties: {} };
}

/** Provider-defined OpenAI types that are not client-executable function tools. */
const SKIP_OPENAI_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "computer",
  "computer_use",
  "code_interpreter",
  "image_generation",
]);

function openaiToolRecordName(rec: Record<string, unknown>): string {
  const fn = rec.function && typeof rec.function === "object" ? (rec.function as Record<string, unknown>) : rec;
  return String(fn.name || rec.name || rec.server_label || rec.serverLabel || "").trim();
}

export function openaiToolsToCustom(tools: unknown): CustomToolDef[] {
  if (!Array.isArray(tools)) return [];
  const used = new Set<string>();
  const out: CustomToolDef[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const rec = t as Record<string, unknown>;
    const type = String(rec.type || "function").toLowerCase();
    if (SKIP_OPENAI_TOOL_TYPES.has(type)) continue;
    const fn = (rec.function && typeof rec.function === "object" ? rec.function : rec) as Record<string, unknown>;
    const openaiName = openaiToolRecordName(rec);
    if (!openaiName) continue;
    let name = sanitizeCustomToolName(openaiName);
    let n = 2;
    while (used.has(name)) {
      name = `${sanitizeCustomToolName(openaiName).slice(0, 60)}_${n}`;
      n += 1;
    }
    used.add(name);
    out.push({
      name,
      openaiName,
      description: String(fn.description || rec.description || ""),
      inputSchema: asSchema(fn.parameters ?? rec.input_schema ?? rec.inputSchema),
    });
  }
  return out;
}

export function anthropicToolsToCustom(tools: unknown): CustomToolDef[] {
  if (!Array.isArray(tools)) return [];
  const used = new Set<string>();
  const out: CustomToolDef[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const rec = t as Record<string, unknown>;
    const type = String(rec.type || "custom").toLowerCase();
    if (type && type !== "custom" && type !== "function") continue;
    const openaiName = String(rec.name || "").trim();
    if (!openaiName) continue;
    let name = sanitizeCustomToolName(openaiName);
    let n = 2;
    while (used.has(name)) {
      name = `${sanitizeCustomToolName(openaiName).slice(0, 60)}_${n}`;
      n += 1;
    }
    used.add(name);
    out.push({
      name,
      openaiName,
      description: String(rec.description || ""),
      inputSchema: asSchema(rec.input_schema ?? rec.inputSchema ?? rec.parameters),
    });
  }
  return out;
}

export function clientToolsDisabled(body: Record<string, unknown>): boolean {
  const choice = body.tool_choice ?? body.toolChoice;
  if (choice === "none") return true;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    return String((choice as Record<string, unknown>).type || "").toLowerCase() === "none";
  }
  return false;
}

export function customToolsInstruction(tools: { name?: string; openaiName?: string }[]): string {
  const names = tools.map((t) => t.openaiName || t.name || "").filter(Boolean);
  if (!names.length) return "Call listed custom tools via MCP.";
  return [
    `Client tools available this turn: ${names.join(", ")}.`,
    "Call them by those exact names through MCP custom-user-tools.",
    "Native Cursor Edit/Write/Bash/Shell/Read/Grep are disabled in this runtime.",
    "If Write, Edit, StrReplace, Shell, Bash, Read, or similar names are listed, you have them — do not say they are unavailable.",
  ].join(" ");
}

export function toolPolicyPrompt(body: Record<string, unknown>, tools: CustomToolDef[]): string {
  if (!tools.length) return "";
  const extra: string[] = [
    customToolsInstruction(tools),
    "When a listed tool applies, call it instead of only describing the steps in prose.",
  ];
  const choice = body.tool_choice ?? body.toolChoice;
  const rec = choice && typeof choice === "object" && !Array.isArray(choice) ? (choice as Record<string, unknown>) : undefined;
  const type = typeof choice === "string" ? choice : String(rec?.type || rec?.mode || "auto");
  const fn = rec?.function && typeof rec.function === "object" ? (rec.function as Record<string, unknown>) : rec;
  if (type === "required" || type === "any") {
    extra.push("You MUST call at least one listed custom tool. Do not respond with only text.");
  }
  if (type === "function" || type === "tool") {
    const name = String(fn?.name || rec?.name || "");
    if (name) extra.push(`You MUST call the tool named ${name}. Do not call any other custom tool.`);
  }
  const parallel = body.parallel_tool_calls ?? body.parallelToolCalls;
  if (parallel === false || rec?.disable_parallel_tool_use === true) {
    extra.push("Call at most one custom tool in this turn.");
  }
  return extra.join(" ");
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
      if (Array.isArray(rec.content)) return contentToText(rec.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export type ClientToolResult = { id: string; content: string; isError?: boolean };

export function composeToolResultPrompt(results: ClientToolResult[]): string {
  const lines = results.map((r) => (r.isError ? `- ${r.id} ERROR: ${r.content}` : `- ${r.id}: ${r.content}`));
  return [
    "The client executed your custom tools. Results:",
    ...lines,
    "Continue from these results. Do not call the same tools again unless you need new data.",
  ].join("\n");
}

export function extractClientToolResults(messages: unknown[]): ClientToolResult[] {
  const out: ClientToolResult[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = String(rec.role || "").toLowerCase();
    if (role === "tool" || role === "function") {
      const id = String(rec.tool_call_id || rec.toolCallId || rec.id || "").trim();
      if (!id) continue;
      out.push({
        id,
        content: contentToText(rec.content) || "",
        isError: Boolean(rec.is_error || rec.isError),
      });
      continue;
    }
    if (role !== "user" || !Array.isArray(rec.content)) continue;
    for (const block of rec.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (String(b.type || "") !== "tool_result") continue;
      const id = String(b.tool_use_id || b.toolUseId || "").trim();
      if (!id) continue;
      out.push({
        id,
        content: contentToText(b.content ?? b.text) || "",
        isError: Boolean(b.is_error || b.isError),
      });
    }
  }
  return out;
}

function assistantHasToolCalls(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const rec = message as Record<string, unknown>;
  if (String(rec.role || "").toLowerCase() !== "assistant") return false;
  if (Array.isArray(rec.tool_calls) && rec.tool_calls.length) return true;
  if (!Array.isArray(rec.content)) return false;
  return rec.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    return String((block as Record<string, unknown>).type || "") === "tool_use";
  });
}

/** Index of the first tool result after the latest assistant tool_calls / tool_use. */
export function latestToolResultStart(messages: unknown[]): number {
  let from = 0;
  for (let i = 0; i < messages.length; i++) {
    if (assistantHasToolCalls(messages[i])) from = i + 1;
  }
  return from;
}

export function extractLatestClientToolResults(messages: unknown[]): ClientToolResult[] {
  return extractClientToolResults(messages.slice(latestToolResultStart(messages)));
}

export function lastTurnIsToolResult(messages: unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = String(rec.role || "").toLowerCase();
    if (role === "tool" || role === "function") return true;
    if (role === "assistant") return false;
    if (role === "user") {
      if (Array.isArray(rec.content) && rec.content.some((b) => b && typeof b === "object" && String((b as Record<string, unknown>).type || "") === "tool_result")) {
        return true;
      }
      return false;
    }
  }
  return false;
}

export function getClientToolSession(tenant: string, sessionId: string): ClientToolSession | undefined {
  return sessions.get(sessionKey(tenant, sessionId));
}

export function upsertClientToolSession(tenant: string, sessionId: string, tools: CustomToolDef[]): ClientToolSession {
  const key = sessionKey(tenant, sessionId);
  let session = sessions.get(key);
  if (!session) {
    session = { tenant, sessionId, tools, parked: [] };
    sessions.set(key, session);
  } else {
    session.tools = tools;
  }
  return session;
}

export function parkClientToolCall(
  session: ClientToolSession,
  name: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): Promise<CustomToolResult> {
  const def = session.tools.find((t) => t.name === name || t.openaiName === name);
  const openaiName = def?.openaiName || name;
  const id = String(toolCallId || "").trim() || `call_${randomId().replace(/-/g, "")}`;
  const result = new Promise<CustomToolResult>((resolve) => {
    const timer = setTimeout(() => {
      parked.resolve = undefined;
      resolve({
        content: [{ type: "text", text: "client tool timed out waiting for the OpenAI/Anthropic client" }],
        isError: true,
      });
    }, CUSTOM_TOOL_PARK_TIMEOUT_MS);
    const parked: ParkedClientTool = {
      id,
      name: def?.name || name,
      openaiName,
      args: args && typeof args === "object" ? args : {},
      offered: false,
      resolve: (value) => {
        clearTimeout(timer);
        parked.resolve = undefined;
        resolve(value);
      },
    };
    session.parked.push(parked);
    notify(sessionKey(session.tenant, session.sessionId));
  });
  return result;
}

export async function waitForClientToolBatch(session: ClientToolSession, signal?: AbortSignal): Promise<ParkedClientTool[]> {
  const key = sessionKey(session.tenant, session.sessionId);
  while (!signal?.aborted) {
    const pending = session.parked.filter((p) => !p.offered);
    if (pending.length) {
      try {
        await sleep(CUSTOM_TOOL_PARALLEL_DEBOUNCE_MS, signal);
      } catch {
        return session.parked.filter((p) => !p.offered);
      }
      return session.parked.filter((p) => !p.offered);
    }
    const tick = new AbortController();
    const onParent = () => tick.abort();
    signal?.addEventListener("abort", onParent, { once: true });
    const timer = setTimeout(() => tick.abort(), 40);
    try {
      await waitNotified(key, tick.signal);
    } catch {
      /* timeout or parent abort */
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParent);
    }
  }
  return [];
}

export function offerClientToolBatch(session: ClientToolSession, batch: ParkedClientTool[]): void {
  for (const p of batch) p.offered = true;
}

export function clientToolsToOpenAi(batch: ParkedClientTool[]) {
  return batch.map((p, i) => ({
    id: p.id,
    type: "function" as const,
    index: i,
    function: {
      name: p.openaiName,
      arguments: JSON.stringify(p.args ?? {}),
    },
  }));
}

export function clientToolsToAnthropic(batch: ParkedClientTool[]) {
  return batch.map((p) => ({
    type: "tool_use" as const,
    id: p.id,
    name: p.openaiName,
    input: p.args ?? {},
  }));
}

export function resolveClientToolResults(session: ClientToolSession, results: ClientToolResult[]): number {
  const byId = new Map(results.map((r) => [r.id, r]));
  let n = 0;
  for (const parked of session.parked) {
    const hit = byId.get(parked.id);
    if (!hit) continue;
    const value: CustomToolResult = {
      content: [{ type: "text", text: hit.content || "" }],
      isError: hit.isError,
    };
    parked.resolve?.(value);
    parked.resolve = undefined;
    n += 1;
  }
  session.parked = session.parked.filter((p) => p.resolve);
  return n;
}

export function failParkedClientTools(session: ClientToolSession, message: string): void {
  const value: CustomToolResult = { content: [{ type: "text", text: message }], isError: true };
  for (const parked of session.parked) parked.resolve?.(value);
  session.parked = [];
}

export function toSdkCustomTools(
  session: ClientToolSession,
): Record<
  string,
  {
    description?: string;
    inputSchema?: Record<string, unknown>;
    execute: (args: Record<string, unknown>, ctx: { toolCallId?: string }) => Promise<CustomToolResult>;
  }
> {
  const out: Record<string, { description?: string; inputSchema?: Record<string, unknown>; execute: (args: Record<string, unknown>, ctx: { toolCallId?: string }) => Promise<CustomToolResult> }> = {};
  for (const t of session.tools) {
    out[t.name] = {
      description: t.description || t.openaiName,
      inputSchema: t.inputSchema,
      execute: (args, ctx) => parkClientToolCall(session, t.name, args || {}, ctx?.toolCallId),
    };
  }
  return out;
}

/** Test-only. */
export function customToolsClearForTests(): void {
  for (const session of sessions.values()) failParkedClientTools(session, "cleared");
  sessions.clear();
  waiters.clear();
}
