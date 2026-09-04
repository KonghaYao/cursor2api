import { randomId } from "./bytes.ts";
import { computeSessionFp } from "./session_fingerprint.ts";
import {
  runCanonicalMessagePipeline,
  runCanonicalMessagePipelineFromCursor,
  flattenContent,
  type CursorMessage,
  type CursorTool,
} from "./inference.ts";

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

export function resolveSessionMode(): SessionMode {
  const mode = envGet("SESSION_MODE")?.trim().toLowerCase();
  if (mode === "random") return "random";
  return "fingerprint";
}

function conversationRole(role: unknown): string {
  return String(role || "").toLowerCase();
}

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
  session_fp: string;
  canon_len: number;
};

export type RandomSessionResult = {
  mode: "random";
  clientId: string;
};

export type SessionForRequestResult = FingerprintSessionResult | RandomSessionResult;

export async function resolveSessionForRequest(
  tenant: string,
  rawMessages: unknown[],
  options: {
    body: Record<string, unknown>;
    tools: CursorTool[];
    preconvertedMessages?: CursorMessage[];
  },
): Promise<SessionForRequestResult> {
  const mode = resolveSessionMode();
  if (mode === "random") {
    return { mode: "random", clientId: randomId() };
  }

  const pipelined = options.preconvertedMessages
    ? await runCanonicalMessagePipelineFromCursor(options.preconvertedMessages, options.body, options.tools)
    : await runCanonicalMessagePipeline(rawMessages, options.body, options.tools);

  const session_fp = await computeSessionFp(options.body, pipelined.tools, {
    pipelined: pipelined.messages,
    rawMessages: options.preconvertedMessages ? undefined : rawMessages,
    foldSystem: options.preconvertedMessages ? flattenContent(options.body.system) : undefined,
  });

  return {
    mode: "fingerprint",
    canon: pipelined.messages,
    tools: pipelined.tools,
    upstreamConversationId: session_fp,
    clientId: session_fp,
    session_fp,
    canon_len: pipelined.messages.length,
  };
}
