/**
 * Official Cloud Agents REST client (`https://api.cursor.com/v1/*`).
 * Deno/Node compatible: fetch only, no @cursor/sdk native binaries.
 *
 * Auth is the Dashboard API key as Basic `key:` (Bearer also accepted).
 * Conversation state lives on Cursor (`bc-…` agent id), not in this process.
 */
import { incomingCredential, AuthError } from "./auth.ts";

export const CLOUD_API_BASE = "https://api.cursor.com";

export const CLOUD_AGENT_ID_RE = /^bc-[a-zA-Z0-9-]+$/;

export type CloudMcpServer = {
  name: string;
  type?: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export type CloudRepo = {
  url: string;
  startingRef?: string;
  prUrl?: string;
};

export type CloudPrompt = {
  text: string;
  images?: Array<
    | { url: string; dimension?: { width: number; height: number } }
    | { data: string; mimeType: string; dimension?: { width: number; height: number } }
  >;
};

export type CloudModelSelection = {
  id: string;
  params?: Array<{ id: string; value: string }>;
};

export type CloudAgent = {
  id: string;
  name?: string;
  status?: string;
  url?: string;
  latestRunId?: string;
};

export type CloudRun = {
  id: string;
  agentId: string;
  status: string;
  result?: string;
  error?: unknown;
  durationMs?: number;
};

export type CloudSseEvent = {
  event: string;
  data: Record<string, unknown>;
  id?: string;
};

export class CloudAgentsError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CloudAgentsError";
    this.status = status;
    this.code = code;
  }
}

export function cloudApiKeyFromHeaders(headers: Headers): string {
  const key = incomingCredential(headers);
  if (!key) throw new AuthError("missing Cursor API key (Authorization: Bearer … or x-api-key)");
  return key;
}

export function cloudAuthHeaders(apiKey: string): Record<string, string> {
  const bytes = new TextEncoder().encode(`${apiKey}:`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return {
    authorization: `Basic ${btoa(bin)}`,
    "content-type": "application/json",
  };
}

export function isCloudAgentId(id: unknown): id is string {
  return typeof id === "string" && CLOUD_AGENT_ID_RE.test(id);
}

async function cloudJson<T>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${CLOUD_API_BASE}${path}`, {
    method,
    headers: cloudAuthHeaders(apiKey),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = { _raw: text.slice(0, 800) };
  }
  if (!res.ok) {
    const err = json?.error;
    const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : json;
    const message = String(rec?.message || rec?.detail || text.slice(0, 400) || `Cloud Agents ${res.status}`);
    const code = rec?.code != null ? String(rec.code) : undefined;
    throw new CloudAgentsError(message, res.status, code);
  }
  return (json || {}) as T;
}

export async function listCloudModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ items: Array<{ id: string; displayName?: string }> }> {
  return cloudJson(apiKey, "GET", "/v1/models", undefined, signal);
}

export async function createCloudAgent(
  apiKey: string,
  req: {
    prompt: CloudPrompt;
    model?: CloudModelSelection;
    mcpServers?: CloudMcpServer[];
    repos?: CloudRepo[];
    mode?: "agent" | "plan";
    name?: string;
  },
  signal?: AbortSignal,
): Promise<{ agent: CloudAgent; run: CloudRun }> {
  return cloudJson(apiKey, "POST", "/v1/agents", req, signal);
}

export async function createCloudRun(
  apiKey: string,
  agentId: string,
  req: {
    prompt: CloudPrompt;
    mcpServers?: CloudMcpServer[];
    model?: CloudModelSelection;
    mode?: "agent" | "plan";
  },
  signal?: AbortSignal,
): Promise<{ run: CloudRun }> {
  return cloudJson(apiKey, "POST", `/v1/agents/${encodeURIComponent(agentId)}/runs`, req, signal);
}

export async function getCloudRun(
  apiKey: string,
  agentId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<CloudRun> {
  return cloudJson(
    apiKey,
    "GET",
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    undefined,
    signal,
  );
}

export async function streamCloudRun(
  apiKey: string,
  agentId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(
    `${CLOUD_API_BASE}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`,
    {
      method: "GET",
      headers: {
        ...cloudAuthHeaders(apiKey),
        accept: "text/event-stream",
      },
      signal,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new CloudAgentsError(text.slice(0, 400) || `Cloud Agents stream ${res.status}`, res.status);
  }
  return res;
}

export function parseSseBlock(raw: string): CloudSseEvent | null {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed || trimmed.startsWith(":")) continue;
    if (trimmed.startsWith("event:")) event = trimmed.slice(6).trim();
    else if (trimmed.startsWith("id:")) id = trimmed.slice(3).trim();
    else if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trimStart());
  }
  if (!dataLines.length) return event === "heartbeat" || event === "done" ? { event, data: {} } : null;
  const joined = dataLines.join("\n");
  let data: Record<string, unknown> = {};
  if (joined && joined !== "{}") {
    try {
      const parsed = JSON.parse(joined) as unknown;
      data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      data = { text: joined };
    }
  }
  return { event, data, id };
}

export async function* iterateSse(res: Response): AsyncGenerator<CloudSseEvent> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    buf += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    buf = buf.replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSseBlock(raw);
      if (ev) yield ev;
    }
    if (done) break;
  }
}

export async function collectCloudRunResult(
  apiKey: string,
  agentId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<{ status: string; text: string; error?: string }> {
  try {
    const res = await streamCloudRun(apiKey, agentId, runId, signal);
    let text = "";
    let status = "RUNNING";
    let error: string | undefined;
    for await (const ev of iterateSse(res)) {
      if (ev.event === "assistant") text += String(ev.data.text || "");
      if (ev.event === "status") status = String(ev.data.status || status);
      if (ev.event === "result") {
        status = String(ev.data.status || status);
        if (ev.data.text != null) text = String(ev.data.text);
      }
      if (ev.event === "error") error = String(ev.data.message || ev.data.code || "cloud run error");
      if (ev.event === "done") break;
    }
    return { status, text, error };
  } catch (err) {
    if (err instanceof CloudAgentsError && (err.status === 410 || err.status === 404)) {
      const run = await getCloudRun(apiKey, agentId, runId, signal);
      const error =
        run.error == null
          ? undefined
          : typeof run.error === "string"
            ? run.error
            : JSON.stringify(run.error).slice(0, 400);
      return { status: run.status, text: String(run.result || ""), error };
    }
    throw err;
  }
}
