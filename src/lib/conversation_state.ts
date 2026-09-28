/**
 * Splice Cursor `ConversationStateStructure` from the client's full transcript.
 *
 * AgentService builds the model-visible prompt from `rootPromptMessagesJson`
 * (SHA-256 blob ids of Vercel-AI-SDK-shaped JSON). Client system text is a
 * synthetic first user root: AgentService ignores `role: system` roots, while
 * this shape keeps the full prompt visible and stable across HTTP turns.
 * `turns[]` is UI metadata and must be omitted — we are not the IDE. The active
 * user turn stays in `userMessageAction`. A follow-up user action repeats the
 * short tool catalog: the first-root list sits under the client system and
 * Composer then treats Write/Edit/Bash as absent. A `role: tool` follow-up
 * carries SDK `tool-result` objects. The previous duplex is already closed,
 * so empty `resumeAction` has no in-flight MCP exec. History tool calls stay
 * in roots as `tool-call` / `tool-result` parts.
 */
import {
  extractLatestClientToolResults,
  lastTurnIsToolResult,
  latestToolResultStart,
  toolPolicyPrompt,
  withWorkspaceAccess,
  type CustomToolDef,
} from "./custom_tools.ts";
import { bytesBody } from "./bytes.ts";
import type { JsonObject } from "./agent_json.ts";

const utf8 = new TextEncoder();
const utf8Dec = new TextDecoder();

const DEFAULT_SYSTEM = "You are a helpful assistant.";

export type ConversationBlobStore = Map<string, string>;

export type SplicedConversation = {
  conversationState: JsonObject;
  blobs: ConversationBlobStore;
  resume: boolean;
  prompt: string;
};

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8FromBlobData(blobData: string): string {
  return utf8Dec.decode(b64ToBytes(blobData));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytesBody(data)));
}

/** Index a blob under proto-JSON base64, URL-safe base64, and hex ids. */
export function indexConversationBlob(store: ConversationBlobStore, idBytes: Uint8Array, dataB64: string): string {
  const id = bytesToB64(idBytes);
  store.set(id, dataB64);
  store.set(bytesToB64Url(idBytes), dataB64);
  store.set(bytesToHex(idBytes), dataB64);
  return id;
}

export async function storeJsonBlob(store: ConversationBlobStore, value: unknown): Promise<string> {
  const bytes = utf8.encode(JSON.stringify(value));
  const idBytes = await sha256(bytes);
  return indexConversationBlob(store, idBytes, bytesToB64(bytes));
}

function asRec(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isToolResultUser(rec: Record<string, unknown>): boolean {
  return Array.isArray(rec.content) && rec.content.some((b) => b && typeof b === "object" && String((b as Record<string, unknown>).type || "") === "tool_result");
}

function lastRealUserIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const rec = asRec(messages[i]);
    if (!rec) continue;
    if (rec.role !== "user") continue;
    if (isToolResultUser(rec)) continue;
    return i;
  }
  return -1;
}

/** First real user at or after `start` (exclusive end for replay). Skips assistant echoes. */
function firstRealUserIndexFrom(messages: unknown[], start: number): number {
  const begin = Math.max(0, start);
  for (let i = begin; i < messages.length; i++) {
    const rec = asRec(messages[i]);
    if (!rec) continue;
    if (rec.role !== "user") continue;
    if (isToolResultUser(rec)) continue;
    return i;
  }
  return messages.length;
}

function lastUserPrompt(messages: unknown[]): string {
  const i = lastRealUserIndex(messages);
  if (i < 0) return "(empty)";
  const rec = asRec(messages[i]);
  const text = messageText(rec?.content);
  return text || "(empty)";
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

function systemPromptFromClient(body: Record<string, unknown>): string {
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
    const rec = asRec(m);
    if (!rec) continue;
    if (rec.role !== "system" && rec.role !== "developer") continue;
    const text = messageText(rec.content);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function joinUserPrompts(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const rec = asRec(m);
    if (!rec || rec.role !== "user" || isToolResultUser(rec)) continue;
    const text = messageText(rec.content);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function assistantVisibleText(rec: Record<string, unknown>): string {
  if (typeof rec.content === "string") return rec.content.trim();
  if (!Array.isArray(rec.content)) return "";
  return rec.content
    .map((block) => {
      if (typeof block === "string") return block;
      const b = asRec(block);
      if (!b) return "";
      const type = String(b.type || "");
      if (type === "tool_use" || type === "tool_call") return "";
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function toolCallArgsText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return JSON.stringify(raw);
  return "";
}

function assistantToolCalls(rec: Record<string, unknown>): Array<{ id: string; name: string; args: string }> {
  const out: Array<{ id: string; name: string; args: string }> = [];
  if (Array.isArray(rec.tool_calls)) {
    for (const raw of rec.tool_calls) {
      const tc = asRec(raw);
      if (!tc) continue;
      const fn = asRec(tc.function) ?? tc;
      const id = String(tc.id || "").trim();
      const name = String(fn.name || tc.name || "").trim();
      if (!id && !name) continue;
      out.push({
        id,
        name,
        args: toolCallArgsText(fn.arguments ?? fn.args ?? tc.arguments ?? tc.input),
      });
    }
  }
  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      const b = asRec(block);
      if (!b || String(b.type || "") !== "tool_use") continue;
      const id = String(b.id || "").trim();
      const name = String(b.name || "").trim();
      if (!id && !name) continue;
      out.push({
        id,
        name,
        args: toolCallArgsText(b.input ?? b.arguments),
      });
    }
  }
  return out;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* arguments were not a JSON object */
  }
  return {};
}

function toolResultMessage(opts: { id: string; name: string; content: string; isError?: boolean }): {
  role: "tool";
  id: string;
  content: Array<{ type: "tool-result"; toolName: string; toolCallId: string; result: string; isError?: boolean }>;
} {
  const part: { type: "tool-result"; toolName: string; toolCallId: string; result: string; isError?: boolean } = {
    type: "tool-result",
    toolName: opts.name,
    toolCallId: opts.id,
    result: opts.content,
  };
  if (opts.isError) part.isError = true;
  return { role: "tool", id: opts.id, content: [part] };
}

function assistantRootMessage(rec: Record<string, unknown>): { role: "assistant"; content: Array<Record<string, unknown>> } | undefined {
  const content: Array<Record<string, unknown>> = [];
  const text = assistantVisibleText(rec);
  if (text) content.push({ type: "text", text });
  for (const call of assistantToolCalls(rec)) {
    content.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      args: parseToolArgs(call.args),
    });
  }
  if (!content.length) return undefined;
  return { role: "assistant", content };
}

/** Latest tool results as the action payload. History keeps the matching tool-call. */
export function formatLatestToolResultAction(messages: unknown[]): string {
  const names = toolNamesById(messages);
  const latest = extractLatestClientToolResults(messages);
  return JSON.stringify(
    latest.map((result) =>
      toolResultMessage({
        id: result.id,
        name: names.get(result.id) || "",
        content: result.content,
        isError: result.isError,
      }),
    ),
  );
}

function toolNamesById(messages: unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    const rec = asRec(m);
    if (!rec || rec.role !== "assistant") continue;
    if (Array.isArray(rec.tool_calls)) {
      for (const raw of rec.tool_calls) {
        const tc = asRec(raw);
        if (!tc) continue;
        const id = String(tc.id || "").trim();
        const fn = asRec(tc.function) ?? tc;
        const name = String(fn.name || tc.name || "").trim();
        if (id && name) names.set(id, name);
      }
    }
    if (!Array.isArray(rec.content)) continue;
    for (const block of rec.content) {
      const b = asRec(block);
      if (!b || String(b.type || "") !== "tool_use") continue;
      const id = String(b.id || "").trim();
      const name = String(b.name || "").trim();
      if (id && name) names.set(id, name);
    }
  }
  return names;
}

function rootUserText(text: string): { role: "user"; content: Array<{ type: "text"; text: string }> } {
  return { role: "user", content: [{ type: "text", text }] };
}

function rootClientSystemText(text: string): { role: "user"; content: Array<{ type: "text"; text: string }> } {
  return rootUserText(`<system>\n${text}\n</system>`);
}

async function pushRoot(store: ConversationBlobStore, ids: string[], value: unknown): Promise<void> {
  ids.push(await storeJsonBlob(store, value));
}

async function pushToolResult(
  store: ConversationBlobStore,
  ids: string[],
  opts: { id: string; name?: string; content: string; isError?: boolean },
): Promise<void> {
  await pushRoot(
    store,
    ids,
    toolResultMessage({
      id: opts.id,
      name: opts.name || "",
      content: opts.content,
      isError: opts.isError,
    }),
  );
}

async function replayMessages(
  store: ConversationBlobStore,
  messages: unknown[],
  endExclusive: number,
  names: Map<string, string>,
): Promise<string[]> {
  const ids: string[] = [];
  const limit = Math.min(endExclusive, messages.length);
  for (let i = 0; i < limit; i++) {
    const rec = asRec(messages[i]);
    if (!rec) continue;
    const role = String(rec.role || "").toLowerCase();
    if (role === "system" || role === "developer") continue;
    if (role === "user") {
      if (isToolResultUser(rec)) {
        for (const block of rec.content as unknown[]) {
          const b = asRec(block);
          if (!b || String(b.type || "") !== "tool_result") continue;
          const id = String(b.tool_use_id || b.toolUseId || "").trim();
          if (!id) continue;
          await pushToolResult(store, ids, {
            id,
            name: names.get(id),
            content: messageText(b.content ?? b.text),
            isError: Boolean(b.is_error || b.isError),
          });
        }
        continue;
      }
      const text = messageText(rec.content);
      if (text) await pushRoot(store, ids, rootUserText(text));
      continue;
    }
    if (role === "assistant") {
      const message = assistantRootMessage(rec);
      if (message) await pushRoot(store, ids, message);
      continue;
    }
    if (role === "tool" || role === "function") {
      const id = String(rec.tool_call_id || rec.toolCallId || rec.id || "").trim();
      if (!id) continue;
      await pushToolResult(store, ids, {
        id,
        name: String(rec.name || names.get(id) || ""),
        content: messageText(rec.content),
        isError: Boolean(rec.is_error || rec.isError),
      });
    }
  }
  return ids;
}

export function conversationStateFromRoots(rootPromptMessagesJson: string[]): JsonObject {
  // Only roots. Empty `turns: []` / maps tell Cursor this conversation has no
  // history even when root blobs are present (or fail to hydrate).
  return { rootPromptMessagesJson };
}

export function decodeRootPromptText(state: JsonObject, blobs: ConversationBlobStore): string {
  const ids = Array.isArray(state.rootPromptMessagesJson) ? state.rootPromptMessagesJson : [];
  const parts: string[] = [];
  for (const id of ids) {
    const data = blobs.get(String(id));
    if (!data) continue;
    parts.push(utf8FromBlobData(data));
  }
  return parts.join("\n");
}

/**
 * Prompt for `userMessageAction` once history lives in root blobs.
 * Latest tool results stay off the roots and go in this prompt as SDK
 * `tool-result` objects — a new Run cannot `resumeAction` a closed duplex.
 *
 * `historyEnd` is exclusive for root replay. On a KV-length user follow-up it
 * is the first new real user, not `priorMessageCount` (that index often lands
 * on the assistant echo the client appended).
 */
export function splicedUserPrompt(opts: {
  messages: unknown[];
  priorMessageCount?: number;
  tools?: CustomToolDef[];
}): { resume: boolean; prompt: string; historyEnd: number } {
  if (lastTurnIsToolResult(opts.messages)) {
    return {
      resume: false,
      prompt: formatLatestToolResultAction(opts.messages),
      historyEnd: latestToolResultStart(opts.messages),
    };
  }
  const tools = opts.tools || [];
  const prior = opts.priorMessageCount;
  const canSlice = prior != null && Number.isInteger(prior) && prior > 0 && opts.messages.length > prior;
  if (canSlice) {
    const users = joinUserPrompts(opts.messages.slice(prior));
    if (users) {
      return {
        resume: false,
        prompt: withWorkspaceAccess(users, tools, opts.messages),
        // KV length is the previous HTTP transcript. The client then appends
        // assistant (and maybe tool_calls) before the new user; that echo is
        // history, not the delta. Exclusive end must be the first new user.
        historyEnd: firstRealUserIndexFrom(opts.messages, prior),
      };
    }
  }
  const last = lastRealUserIndex(opts.messages);
  return {
    resume: false,
    prompt: withWorkspaceAccess(lastUserPrompt(opts.messages), tools, opts.messages),
    historyEnd: last < 0 ? opts.messages.length : last,
  };
}

export async function spliceConversationFromClient(opts: {
  body: Record<string, unknown>;
  tools: CustomToolDef[];
  messages: unknown[];
  priorMessageCount?: number;
}): Promise<SplicedConversation> {
  const blobs: ConversationBlobStore = new Map();
  const rootIds: string[] = [];
  // Short catalog as its own first root. Do not lecture about MCP or missing
  // tools — that text becomes the model's tool-anxiety script.
  const policy = toolPolicyPrompt(opts.body, opts.tools);
  if (policy.trim()) await pushRoot(blobs, rootIds, rootClientSystemText(policy.trim()));
  const clientSystem = systemPromptFromClient(opts.body);
  if (clientSystem.trim()) await pushRoot(blobs, rootIds, rootClientSystemText(clientSystem.trim()));
  if (!rootIds.length) await pushRoot(blobs, rootIds, rootClientSystemText(DEFAULT_SYSTEM));

  const { resume, prompt, historyEnd } = splicedUserPrompt({
    messages: opts.messages,
    priorMessageCount: opts.priorMessageCount,
    tools: opts.tools,
  });
  const names = toolNamesById(opts.messages);
  const historyIds = await replayMessages(blobs, opts.messages, historyEnd, names);
  rootIds.push(...historyIds);

  return {
    conversationState: conversationStateFromRoots(rootIds),
    blobs,
    resume,
    prompt,
  };
}
