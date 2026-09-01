import { randomId } from "./bytes.ts";
import {
  CanonConflictError,
  computeAnchorFp,
  computeEnvFp,
  resolveCanonicalThread,
  type CanonicalMergeResult,
} from "./session_fingerprint.ts";
import {
  flattenContent,
  runCanonicalMessagePipeline,
  runCanonicalMessagePipelineFromCursor,
  type CursorMessage,
  type CursorTool,
} from "./inference.ts";
import type { Kv } from "./kv.ts";

/** `random` skips KV canon (debug only). Default is always `fingerprint`. */
export type SessionMode = "fingerprint" | "random";

function envGet(name: string): string | undefined {
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

/** Always fingerprint unless `SESSION_MODE=random`. Legacy `sticky` / `SESSION_STICKY` are ignored. */
export function resolveSessionMode(): SessionMode {
  const mode = envGet("SESSION_MODE")?.trim().toLowerCase();
  if (mode === "random") return "random";
  if (mode === "sticky" || mode === "fingerprint") return "fingerprint";
  return "fingerprint";
}

function conversationRole(role: unknown): string {
  return String(role || "").toLowerCase();
}

/** True when the payload looks like the first turn (one user turn, no assistant/tool yet). System/developer messages are ignored. */
export function isNewConversationMessages(messages: unknown[]): boolean {
  const conv = (messages || []).filter((m) => {
    const role = conversationRole((m as Record<string, unknown>).role);
    return role === "user" || role === "assistant" || role === "tool";
  });
  let users = 0;
  let replies = 0;
  for (const m of conv) {
    const role = conversationRole((m as Record<string, unknown>).role);
    if (role === "user") users += 1;
    else replies += 1;
  }
  return users === 1 && replies === 0;
}

export type FingerprintSessionResult = {
  mode: "fingerprint";
  canon: CursorMessage[];
  tools: CursorTool[];
  upstreamConversationId: string;
  clientId: string;
  env_fp: string;
  anchor_fp: string;
  merge: CanonicalMergeResult;
  canon_len: number;
};

export type RandomSessionResult = {
  mode: "random";
  clientId: string;
};

export type SessionForRequestResult = FingerprintSessionResult | RandomSessionResult;

export async function resolveSessionForRequest(
  kv: Kv,
  tenant: string,
  rawMessages: unknown[],
  options: {
    body: Record<string, unknown>;
    tools: CursorTool[];
    preconvertedMessages?: CursorMessage[];
    threadToken?: string;
  },
): Promise<SessionForRequestResult> {
  const mode = resolveSessionMode();
  if (mode === "random") {
    return { mode: "random", clientId: randomId() };
  }

  const pipelined = options.preconvertedMessages
    ? await runCanonicalMessagePipelineFromCursor(options.preconvertedMessages, options.body, options.tools)
    : await runCanonicalMessagePipeline(rawMessages, options.body, options.tools);

  const foldSystem = options.preconvertedMessages
    ? flattenContent(options.body.system)
    : undefined;
  const env_fp = await computeEnvFp(options.body, options.tools, {
    rawMessages: options.preconvertedMessages ? undefined : rawMessages,
    baseMessages: options.preconvertedMessages,
    foldSystem,
  });
  const anchor_fp = await computeAnchorFp(pipelined.messages, pipelined.tools);
  const { canon, merge } = await resolveCanonicalThread(
    kv,
    tenant,
    env_fp,
    anchor_fp,
    pipelined.messages,
    pipelined.tools,
    options.threadToken,
  );

  const upstreamConversationId = randomId();
  return {
    mode: "fingerprint",
    canon,
    tools: pipelined.tools,
    upstreamConversationId,
    clientId: upstreamConversationId,
    env_fp,
    anchor_fp,
    merge,
    canon_len: canon.length,
  };
}

export { CanonConflictError };
