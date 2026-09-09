/**
 * Map the gateway's session id → Cursor Cloud Agent id (`bc-…`) in KV.
 *
 * - Session switched / missing in KV → create a new agent, store the binding.
 * - Same session in KV → follow-up run on the stored agent.
 * - Client may pass a raw `bc-…` id and skip KV.
 */
import { credentialFingerprint } from "./auth.ts";
import { sha256Hex } from "./bytes.ts";
import {
  CloudAgentsError,
  createCloudAgent,
  createCloudRun,
  isCloudAgentId,
  type CloudMcpServer,
  type CloudModelSelection,
  type CloudPrompt,
  type CloudRepo,
} from "./cloud_agents.ts";
import { openaiMessagesToCursor } from "./inference.ts";
import { kvGetCloudAgent, kvRemoveCloudAgent, kvSetCloudAgent, type Kv } from "./kv.ts";
import { computeSessionFp } from "./session_fingerprint.ts";
import { resolveSessionMode } from "./session.ts";

const SESSION_HEADERS = ["x-session-id", "x-cursor-session-id", "x-cursor-conversation-id", "x-agent-id", "x-cursor-agent-id"];
const SESSION_BODY_KEYS = ["session_id", "sessionId", "conversation_id", "conversationId", "agent_id", "agentId"];

export type CloudSessionRef =
  | { kind: "agent"; agentId: string }
  | { kind: "session"; sessionId: string };

function asSessionToken(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  if (!id || id.length > 256 || /[\r\n]/.test(id)) return undefined;
  return id;
}

function pickFromRecord(rec: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!rec) return undefined;
  for (const key of keys) {
    const id = asSessionToken(rec[key]);
    if (id) return id;
  }
  return undefined;
}

export function extractCloudSessionRef(
  body: Record<string, unknown> | null | undefined,
  headers?: Headers,
): CloudSessionRef | undefined {
  if (headers) {
    for (const name of SESSION_HEADERS) {
      const id = asSessionToken(headers.get(name));
      if (!id) continue;
      if (isCloudAgentId(id)) return { kind: "agent", agentId: id };
      return { kind: "session", sessionId: id };
    }
  }
  if (!body) return undefined;
  const extra =
    body.extra_body && typeof body.extra_body === "object" && !Array.isArray(body.extra_body)
      ? (body.extra_body as Record<string, unknown>)
      : undefined;
  const id = pickFromRecord(body, SESSION_BODY_KEYS) || pickFromRecord(extra, SESSION_BODY_KEYS);
  if (!id) return undefined;
  if (isCloudAgentId(id)) return { kind: "agent", agentId: id };
  return { kind: "session", sessionId: id };
}

export async function fallbackSessionId(body: Record<string, unknown>): Promise<string> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const pipelined = await openaiMessagesToCursor(messages);
  return computeSessionFp(body, [], { pipelined, rawMessages: messages });
}

export async function resolveSessionKvId(
  body: Record<string, unknown>,
  headers: Headers,
): Promise<{ sessionId: string; directAgentId?: string } | { ephemeral: true }> {
  if (resolveSessionMode() === "random") return { ephemeral: true };
  const ref = extractCloudSessionRef(body, headers);
  if (ref?.kind === "agent") return { sessionId: ref.agentId, directAgentId: ref.agentId };
  if (ref?.kind === "session") {
    const sessionId = ref.sessionId.length > 128 ? (await sha256Hex(ref.sessionId)).slice(0, 32) : ref.sessionId;
    return { sessionId };
  }
  return { sessionId: await fallbackSessionId(body) };
}

export async function startCloudTurn(opts: {
  apiKey: string;
  kv: Kv;
  body: Record<string, unknown>;
  headers: Headers;
  promptCreate: CloudPrompt;
  promptFollowUp: CloudPrompt;
  mcpServers?: CloudMcpServer[];
  model?: CloudModelSelection;
  repos?: CloudRepo[];
  signal?: AbortSignal;
}): Promise<{ agentId: string; runId: string; sessionId?: string; reused: boolean }> {
  const { apiKey, kv, body, headers, promptCreate, promptFollowUp, mcpServers, model, repos, signal } = opts;
  const resolved = await resolveSessionKvId(body, headers);
  if ("ephemeral" in resolved) {
    const created = await createCloudAgent(apiKey, { prompt: promptCreate, model, mcpServers, repos }, signal);
    return { agentId: created.agent.id, runId: created.run.id, reused: false };
  }

  const tenant = await credentialFingerprint(apiKey);
  const { sessionId, directAgentId } = resolved;

  const tryFollowUp = async (agentId: string) => {
    const { run } = await createCloudRun(apiKey, agentId, { prompt: promptFollowUp, mcpServers, model }, signal);
    return { agentId, runId: run.id, sessionId, reused: true as const };
  };

  if (directAgentId) {
    try {
      return await tryFollowUp(directAgentId);
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  } else {
    const stored = await kvGetCloudAgent(kv, tenant, sessionId);
    if (stored) {
      try {
        return await tryFollowUp(stored);
      } catch (err) {
        if (!isGone(err)) throw err;
        await kvRemoveCloudAgent(kv, tenant, sessionId);
      }
    }
  }

  const created = await createCloudAgent(apiKey, { prompt: promptCreate, model, mcpServers, repos }, signal);
  await kvSetCloudAgent(kv, tenant, sessionId, created.agent.id);
  return { agentId: created.agent.id, runId: created.run.id, sessionId, reused: false };
}

function isGone(err: unknown): boolean {
  if (!(err instanceof CloudAgentsError)) return false;
  if (err.status === 404 || err.status === 410) return true;
  const code = (err.code || "").toLowerCase();
  return code.includes("not_found") || code.includes("archived") || code.includes("expired");
}
