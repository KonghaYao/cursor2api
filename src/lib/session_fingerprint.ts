import { sha256Hex } from "./bytes.ts";
import { KV_TTL_SECONDS, type Kv } from "./kv.ts";
import {
  ROLE,
  applyToolPolicy,
  canonicalSerialize,
  extractFastMode,
  extractMaxMode,
  extractReasoningEffort,
  flattenContent,
  normalizeToolArguments,
  openaiMessagesToCursor,
  parseArgs,
  resolveCursorModelRoute,
  schemaForTool,
  stableStringify,
  toolsCatalogText,
  upgradeGrokRouteForTools,
  type CursorMessage,
  type CursorTool,
} from "./inference.ts";

const RS = "\x1e";

export class CanonConflictError extends Error {
  constructor(message = "canonical transcript conflict") {
    super(message);
    this.name = "CanonConflictError";
  }
}

/** KV stores only fingerprint metadata — never full CursorMessage[] (Deno KV 64KB limit). */
export type CanonRow = {
  canon_len: number;
  canon_hash: string;
  updatedAt: number;
  turnCount: number;
};

type ActivePendingRow = CanonRow & { anchor_fp: string };

export type ThreadTokenRow = {
  env_fp: string;
  anchor_fp: string;
};

export type CanonicalMergeResult = "miss" | "hit";

function canonKey(tenant: string, env_fp: string, anchor_fp: string): string {
  return `canon:${tenant}:${env_fp}:${anchor_fp}`;
}

/** Single in-flight pending thread per tenant+env (pending anchor hash rotates each turn). */
function activePendingKey(tenant: string, env_fp: string): string {
  return `canon:${tenant}:${env_fp}:active_pending`;
}

function threadTokenKey(tenant: string, token: string): string {
  return `thread_token:${tenant}:${token}`;
}

function isPrefixTaggedUser(m: CursorMessage): boolean {
  if (m.role !== ROLE.user) return false;
  const text = typeof m.text === "string" ? m.text.trim() : "";
  return (
    text.startsWith("<tools-rules>") ||
    text.startsWith("<tools-catalog>") ||
    text.startsWith("<system>") ||
    text.startsWith("<tool-policy>") ||
    text.startsWith("<output-format>")
  );
}

/** Dialogue messages after injectToolsPrompt — strip leading injected prefixes. */
export function extractDialogueMessages(pipelined: CursorMessage[]): CursorMessage[] {
  const out: CursorMessage[] = [];
  let skipping = true;
  for (const m of pipelined || []) {
    if (skipping && isPrefixTaggedUser(m)) continue;
    skipping = false;
    out.push(m);
  }
  return out;
}

function assistantHasToolCalls(m: CursorMessage): boolean {
  const calls = m.toolCalls as unknown[] | undefined;
  return Array.isArray(calls) && calls.length > 0;
}

function toolCallIdsFromAssistant(m: CursorMessage): string[] {
  const calls = (m.toolCalls as Array<Record<string, unknown>> | undefined) || [];
  return calls
    .map((c) => String(c.toolCallId || c.id || "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function toolCallIdsFromToolMessage(m: CursorMessage): string[] {
  const bag = m.toolContent as { parts?: Array<Record<string, unknown>> } | undefined;
  const parts = bag?.parts || [];
  return parts
    .map((p) => String(p.toolCallId || "").trim())
    .filter(Boolean);
}

export type FctrResult = {
  complete: boolean;
  closure: CursorMessage[];
};

/** First Complete Tool Round on dialogue messages (post-prefix strip). */
export function extractFCTR(dialogue: CursorMessage[]): FctrResult {
  let u1 = -1;
  for (let i = 0; i < dialogue.length; i++) {
    if (dialogue[i]?.role === ROLE.user) {
      u1 = i;
      break;
    }
  }
  if (u1 < 0) return { complete: false, closure: [] };

  let a1 = -1;
  for (let i = u1 + 1; i < dialogue.length; i++) {
    if (dialogue[i]?.role === ROLE.assistant && assistantHasToolCalls(dialogue[i]!)) {
      a1 = i;
      break;
    }
  }
  if (a1 < 0) return { complete: false, closure: dialogue.slice(u1) };

  const wantIds = new Set(toolCallIdsFromAssistant(dialogue[a1]!));
  const found = new Map<string, CursorMessage>();
  for (let i = a1 + 1; i < dialogue.length; i++) {
    const m = dialogue[i]!;
    if (m.role !== ROLE.tool) continue;
    for (const id of toolCallIdsFromToolMessage(m)) {
      if (wantIds.has(id) && !found.has(id)) found.set(id, m);
    }
    if (found.size >= wantIds.size) break;
  }
  if (found.size < wantIds.size) return { complete: false, closure: dialogue.slice(u1) };

  let lastIdx = a1;
  for (let i = a1 + 1; i < dialogue.length; i++) {
    const m = dialogue[i]!;
    if (m.role === ROLE.tool) {
      for (const id of toolCallIdsFromToolMessage(m)) {
        if (wantIds.has(id)) lastIdx = i;
      }
    }
  }
  return { complete: true, closure: dialogue.slice(u1, lastIdx + 1) };
}

export function normalizeMessagesForCanon(messages: CursorMessage[], tools: CursorTool[]): CursorMessage[] {
  return (messages || []).map((m) => normalizeOneMessageForCanon(m, tools));
}

function normalizeOneMessageForCanon(m: CursorMessage, tools: CursorTool[]): CursorMessage {
  if (m.role !== ROLE.assistant || !Array.isArray(m.toolCalls)) return m;
  const sorted = [...(m.toolCalls as Array<Record<string, unknown>>)].sort((a, b) =>
    String(a.toolCallId || a.id || "").localeCompare(String(b.toolCallId || b.id || "")),
  );
  const toolCalls = sorted.map((c) => {
    const name = String(c.toolName || c.name || "");
    const schema = schemaForTool(tools, name);
    const rawArgs = c.args ?? c.arguments;
    const parsed = parseArgs(rawArgs);
    const args = normalizeToolArguments(parsed, schema);
    return { ...c, args: JSON.parse(args) };
  });
  return { ...m, toolCalls };
}

export function canonicalSerializeForFingerprint(messages: CursorMessage[], tools: CursorTool[]): string {
  return canonicalSerialize(normalizeMessagesForCanon(messages, tools));
}

export function foldSystemFromRawMessages(messages: unknown[]): string {
  const parts: string[] = [];
  for (const msg of messages || []) {
    const rec = msg as Record<string, unknown>;
    const role = String(rec.role || "").toLowerCase();
    if (role !== "system" && role !== "developer") continue;
    const text = flattenContent(rec.content);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function toolPolicySalt(messages: CursorMessage[]): string {
  const first = messages[0];
  if (first?.role === ROLE.user && typeof first.text === "string" && first.text.trim().startsWith("<tool-policy>")) {
    return first.text.trim();
  }
  return "";
}

export async function computeEnvFp(
  body: Record<string, unknown>,
  tools: CursorTool[],
  opts: { rawMessages?: unknown[]; baseMessages?: CursorMessage[]; foldSystem?: string } = {},
): Promise<string> {
  const base =
    opts.baseMessages ??
    (opts.rawMessages ? await openaiMessagesToCursor(opts.rawMessages) : await openaiMessagesToCursor([]));
  const policy = applyToolPolicy(base, tools, body);
  const foldSystem =
    opts.foldSystem ?? (opts.rawMessages ? foldSystemFromRawMessages(opts.rawMessages) : "");
  const { routeId } = resolveCursorModelRoute(body.model, {
    fast: extractFastMode(body),
    reasoningEffort: extractReasoningEffort(body),
  });
  const hasTools = policy.tools.length > 0;
  const modelId = upgradeGrokRouteForTools(routeId, hasTools);
  const injectFlag = body.inject_tools_prompt !== false && body.injectToolsPrompt !== false;
  const flags = stableStringify({
    inject_tools_prompt: injectFlag && policy.tools.length > 0,
    maxMode: extractMaxMode(body),
    reasoning_effort: extractReasoningEffort(body),
    fast: extractFastMode(body),
  });
  const salt = toolPolicySalt(policy.messages);
  const saltHash = salt ? await sha256Hex(salt) : "";
  const payload = [modelId, toolsCatalogText(policy.tools), foldSystem, flags, saltHash].join(RS);
  return sha256Hex(payload);
}

export async function computeAnchorFp(
  pipelinedMessages: CursorMessage[],
  tools: CursorTool[],
): Promise<string> {
  const dialogue = extractDialogueMessages(pipelinedMessages);
  const fctr = extractFCTR(dialogue);
  const slice = fctr.complete ? fctr.closure : dialogue;
  const serialized = canonicalSerializeForFingerprint(slice, tools);
  if (!fctr.complete) return `pending:${await sha256Hex(serialized)}`;
  return sha256Hex(serialized);
}

export async function computeCanonHash(messages: CursorMessage[], tools: CursorTool[]): Promise<string> {
  return sha256Hex(canonicalSerializeForFingerprint(messages, tools));
}

/** Verify client full history extends stored canon; returns incoming as upstream canon. */
export async function verifyAppendOnly(
  storedLen: number,
  storedHash: string,
  incoming: CursorMessage[],
  tools: CursorTool[],
): Promise<CursorMessage[]> {
  if (storedLen > incoming.length) throw new CanonConflictError("incoming shorter than canon");
  if (storedLen === 0) return incoming;
  const prefixHash = await computeCanonHash(incoming.slice(0, storedLen), tools);
  if (prefixHash !== storedHash) throw new CanonConflictError("canon prefix mismatch");
  return incoming;
}

/** @deprecated Tests only — production uses verifyAppendOnly + hash in KV. */
export function appendOnlyMerge(stored: CursorMessage[], incoming: CursorMessage[], tools: CursorTool[]): CursorMessage[] {
  if (stored.length > incoming.length) throw new CanonConflictError("incoming shorter than canon");
  for (let i = 0; i < stored.length; i++) {
    const a = canonicalSerializeForFingerprint([stored[i]!], tools);
    const b = canonicalSerializeForFingerprint([incoming[i]!], tools);
    if (a !== b) throw new CanonConflictError("canon prefix mismatch");
  }
  return incoming;
}

type CanonRowLegacy = CanonRow & { canon?: CursorMessage[] };

async function canonMetaFromRow(
  row: CanonRowLegacy | null | undefined,
  tools: CursorTool[],
): Promise<{ canon_len: number; canon_hash: string } | null> {
  if (!row) return null;
  if (row.canon_len > 0 && row.canon_hash) {
    return { canon_len: row.canon_len, canon_hash: row.canon_hash };
  }
  const legacy = row.canon;
  if (legacy?.length) {
    return {
      canon_len: legacy.length,
      canon_hash: await computeCanonHash(legacy, tools),
    };
  }
  return null;
}

async function writeCanonRow(
  kv: Kv,
  key: string,
  messages: CursorMessage[],
  tools: CursorTool[],
  turnCount: number,
  ttl: number,
  extra?: Partial<ActivePendingRow>,
): Promise<void> {
  const { canon_len, canon_hash } = await canonMetaFromMessages(messages, tools);
  await kv.setItem(
    key,
    {
      canon_len,
      canon_hash,
      updatedAt: Date.now(),
      turnCount,
      ...extra,
    } satisfies CanonRow | ActivePendingRow,
    { ttl },
  );
}

async function canonMetaFromMessages(
  messages: CursorMessage[],
  tools: CursorTool[],
): Promise<{ canon_len: number; canon_hash: string }> {
  return { canon_len: messages.length, canon_hash: await computeCanonHash(messages, tools) };
}

export async function resolveCanonicalThread(
  kv: Kv,
  tenant: string,
  env_fp: string,
  anchor_fp: string,
  cursorMessages: CursorMessage[],
  tools: CursorTool[],
  threadToken?: string,
): Promise<{ canon: CursorMessage[]; merge: CanonicalMergeResult; turnCount: number; threadToken?: string }> {
  let env = env_fp;
  let anchor = anchor_fp;
  if (threadToken) {
    const tok = await kv.getItem<ThreadTokenRow>(threadTokenKey(tenant, threadToken));
    if (tok?.env_fp && tok.anchor_fp) {
      env = tok.env_fp;
      anchor = tok.anchor_fp;
    }
  }

  const key = canonKey(tenant, env, anchor);
  const ttl = KV_TTL_SECONDS;
  const pendingSlot = activePendingKey(tenant, env);

  if (anchor.startsWith("pending:")) {
    const slot = await kv.getItem<ActivePendingRow>(pendingSlot);
    const meta = await canonMetaFromRow(slot, tools);
    if (!meta) {
      const canon = cursorMessages;
      await writeCanonRow(kv, pendingSlot, canon, tools, 1, ttl, { anchor_fp: anchor });
      return { canon, merge: "miss", turnCount: 1 };
    }
    try {
      const canon = await verifyAppendOnly(meta.canon_len, meta.canon_hash, cursorMessages, tools);
      const turnCount = (slot?.turnCount || 0) + 1;
      await writeCanonRow(kv, pendingSlot, canon, tools, turnCount, ttl, { anchor_fp: anchor });
      return { canon, merge: "hit", turnCount };
    } catch (e) {
      if (!(e instanceof CanonConflictError)) throw e;
      if ((slot?.turnCount || 0) > 1) throw e;
      const canon = cursorMessages;
      await writeCanonRow(kv, pendingSlot, canon, tools, 1, ttl, { anchor_fp: anchor });
      return { canon, merge: "miss", turnCount: 1 };
    }
  }

  let row = await kv.getItem<CanonRow>(key);
  let rowMeta = await canonMetaFromRow(row, tools);
  if (!rowMeta) {
    const pendingRow = await kv.getItem<ActivePendingRow>(pendingSlot);
    const pendingMeta = await canonMetaFromRow(pendingRow, tools);
    if (pendingMeta) {
      try {
        const canon = await verifyAppendOnly(
          pendingMeta.canon_len,
          pendingMeta.canon_hash,
          cursorMessages,
          tools,
        );
        const turnCount = (pendingRow?.turnCount || 0) + 1;
        await writeCanonRow(kv, key, canon, tools, turnCount, ttl);
        await kv.removeItem(pendingSlot);
        return { canon, merge: "hit", turnCount };
      } catch (e) {
        if (e instanceof CanonConflictError) throw e;
        throw e;
      }
    }
  }

  if (!rowMeta) {
    const canon = cursorMessages;
    const turnCount = 1;
    await writeCanonRow(kv, key, canon, tools, turnCount, ttl);
    return { canon, merge: "miss", turnCount };
  }

  try {
    const canon = await verifyAppendOnly(rowMeta.canon_len, rowMeta.canon_hash, cursorMessages, tools);
    const turnCount = (row?.turnCount || 0) + 1;
    await writeCanonRow(kv, key, canon, tools, turnCount, ttl);
    return { canon, merge: "hit", turnCount };
  } catch (e) {
    if (e instanceof CanonConflictError) throw e;
    throw e;
  }
}
