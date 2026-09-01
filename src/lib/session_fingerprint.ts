import { sha256Hex } from "./bytes.ts";
import {
  ROLE,
  canonicalSerialize,
  extractFastMode,
  extractMaxMode,
  extractReasoningEffort,
  flattenContent,
  normalizeToolArguments,
  parseArgs,
  resolveCursorModelRoute,
  schemaForTool,
  stableStringify,
  toolsCatalogText,
  upgradeGrokRouteForTools,
  type CursorMessage,
  type CursorTool,
} from "./inference.ts";

/** Record separator (ASCII RS, U+001E). */
export const FINGERPRINT_RS = "\x1e";

export class CanonConflictError extends Error {
  constructor(message = "canonical transcript conflict") {
    super(message);
    this.name = "CanonConflictError";
  }
}

function isToolMessage(m: CursorMessage): boolean {
  return m.role === ROLE.tool;
}

/** Pipeline prefix: messages[0..first tool] inclusive. No tool yet → entire list (pending). */
export function prefixThroughFirstTool(pipelined: CursorMessage[]): CursorMessage[] {
  const list = pipelined || [];
  const idx = list.findIndex(isToolMessage);
  return idx < 0 ? list : list.slice(0, idx + 1);
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

function resolvedModelId(body: Record<string, unknown>, tools: CursorTool[]): string {
  const { routeId } = resolveCursorModelRoute(body.model, {
    fast: extractFastMode(body),
    reasoningEffort: extractReasoningEffort(body),
  });
  return upgradeGrokRouteForTools(routeId, tools.length > 0);
}

/**
 * Single session fingerprint (no KV).
 *
 *   SHA256( modelId ⟂ effort ⟂ {fast,maxMode} ⟂ toolsCatalog ⟂ system ⟂ serialize(messages[0..first tool]) )
 *
 * model / effort / fast / maxMode change the Cursor requestedModel — they belong in the hash.
 * After the first tool result, later turns do not change the prefix slice.
 */
export async function computeSessionFp(
  body: Record<string, unknown>,
  tools: CursorTool[],
  opts: {
    pipelined: CursorMessage[];
    rawMessages?: unknown[];
    foldSystem?: string;
  },
): Promise<string> {
  const modelId = resolvedModelId(body, tools);
  const effort = extractReasoningEffort(body);
  const flags = stableStringify({
    fast: extractFastMode(body),
    maxMode: extractMaxMode(body),
  });
  const catalog = toolsCatalogText(tools);
  const system =
    opts.foldSystem ??
    [flattenContent(body.system), opts.rawMessages ? foldSystemFromRawMessages(opts.rawMessages) : ""]
      .filter(Boolean)
      .join("\n\n");
  const prefix = prefixThroughFirstTool(opts.pipelined);
  const transcript = canonicalSerializeForFingerprint(prefix, tools);
  const payload = [modelId, String(effort ?? ""), flags, catalog, system, transcript].join(FINGERPRINT_RS);
  return sha256Hex(payload);
}

/** @deprecated use computeSessionFp */
export async function computeEnvFp(
  body: Record<string, unknown>,
  tools: CursorTool[],
  opts: { rawMessages?: unknown[]; baseMessages?: CursorMessage[]; foldSystem?: string } = {},
): Promise<string> {
  return computeSessionFp(body, tools, {
    pipelined: opts.baseMessages ?? [],
    rawMessages: opts.rawMessages,
    foldSystem: opts.foldSystem,
  });
}

/** @deprecated use computeSessionFp */
export async function computeAnchorFp(pipelinedMessages: CursorMessage[], tools: CursorTool[]): Promise<string> {
  const prefix = prefixThroughFirstTool(pipelinedMessages);
  const pending = !pipelinedMessages.some(isToolMessage);
  const hex = await sha256Hex(canonicalSerializeForFingerprint(prefix, tools));
  return pending ? `pending:${hex}` : hex;
}

export async function computeCanonHash(messages: CursorMessage[], tools: CursorTool[]): Promise<string> {
  return sha256Hex(canonicalSerializeForFingerprint(messages, tools));
}

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

export function appendOnlyMerge(stored: CursorMessage[], incoming: CursorMessage[], tools: CursorTool[]): CursorMessage[] {
  if (stored.length > incoming.length) throw new CanonConflictError("incoming shorter than canon");
  for (let i = 0; i < stored.length; i++) {
    const a = canonicalSerializeForFingerprint([stored[i]!], tools);
    const b = canonicalSerializeForFingerprint([incoming[i]!], tools);
    if (a !== b) throw new CanonConflictError("canon prefix mismatch");
  }
  return incoming;
}

/** First tool-round slice for tests / logs. */
export function extractFCTR(dialogue: CursorMessage[]): { complete: boolean; closure: CursorMessage[] } {
  const idx = dialogue.findIndex(isToolMessage);
  if (idx < 0) return { complete: false, closure: dialogue };
  return { complete: true, closure: dialogue.slice(0, idx + 1) };
}

export function extractDialogueMessages(pipelined: CursorMessage[]): CursorMessage[] {
  return pipelined || [];
}
