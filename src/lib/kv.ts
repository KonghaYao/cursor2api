/**
 * unstorage-shaped KV (getItem / setItem / removeItem).
 * Swap the backend per runtime: memory here, Cloudflare KV in src/cf.ts, Redis via unstorage, etc.
 */

export type KvSetOpts = {
  ttl?: number;
  /** Override the default 5-minute cap (JWT). Cloud agent bindings use a longer cap. */
  cap?: number;
};

export type Kv = {
  getItem<T = unknown>(key: string): Promise<T | null>;
  setItem(key: string, value: unknown, opts?: KvSetOpts): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type CachedJwt = {
  accessToken: string;
  exp: number;
};

/** Default cap for JWT / short-lived rows. */
export const KV_TTL_SECONDS = 300;

/** Cloud session → agent bindings. Cursor agents outlive JWT exchange cache. */
export const CLOUD_AGENT_KV_TTL_SECONDS = 7 * 24 * 60 * 60;

/** AgentService conversation id + compact checkpoint for Deno isolate hops. */
export const AGENT_RUN_KV_TTL_SECONDS = 24 * 60 * 60;
/** Keep the KV value small: ids always; conversationState only under this cap. */
export const AGENT_RUN_STATE_MAX_BYTES = 24 * 1024;

/** Seconds to store in KV; capped at `cap` (default {@link KV_TTL_SECONDS}). */
export function kvEntryTtlSeconds(preferred?: number, cap = KV_TTL_SECONDS): number {
  const max = cap > 0 ? cap : KV_TTL_SECONDS;
  if (preferred == null || !Number.isFinite(preferred) || preferred <= 0) return max;
  return Math.min(Math.floor(preferred), max);
}

export type CloudAgentBinding = {
  agentId: string;
};

export function cloudAgentKvKey(tenant: string, sessionId: string): string {
  return `cloud-agent:${tenant}:${sessionId}`;
}

export async function kvGetCloudAgent(kv: Kv, tenant: string, sessionId: string): Promise<string | null> {
  const row = await kv.getItem<CloudAgentBinding>(cloudAgentKvKey(tenant, sessionId));
  const agentId = row?.agentId;
  if (typeof agentId !== "string" || !agentId.startsWith("bc-")) return null;
  return agentId;
}

export async function kvSetCloudAgent(kv: Kv, tenant: string, sessionId: string, agentId: string): Promise<void> {
  await kv.setItem(
    cloudAgentKvKey(tenant, sessionId),
    { agentId } satisfies CloudAgentBinding,
    { ttl: CLOUD_AGENT_KV_TTL_SECONDS, cap: CLOUD_AGENT_KV_TTL_SECONDS },
  );
}

export async function kvRemoveCloudAgent(kv: Kv, tenant: string, sessionId: string): Promise<void> {
  await kv.removeItem(cloudAgentKvKey(tenant, sessionId));
}

export type AgentRunBinding = {
  fp: string;
  conversationId: string;
  agentSessionId: string;
  conversationState?: Record<string, unknown>;
};

export function agentRunKvKey(tenant: string, sessionId: string): string {
  return `agent-run:${tenant}:${sessionId}`;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function compactAgentRunBinding(row: AgentRunBinding): AgentRunBinding {
  const base: AgentRunBinding = {
    fp: row.fp,
    conversationId: row.conversationId,
    agentSessionId: row.agentSessionId,
  };
  if (!row.conversationState) return base;
  const withState = { ...base, conversationState: row.conversationState };
  try {
    if (utf8Bytes(JSON.stringify(withState)) <= AGENT_RUN_STATE_MAX_BYTES) return withState;
  } catch {
    /* circular / non-JSON */
  }
  return base;
}

export async function kvGetAgentRun(kv: Kv, tenant: string, sessionId: string, fp: string): Promise<AgentRunBinding | null> {
  const row = await kv.getItem<AgentRunBinding>(agentRunKvKey(tenant, sessionId));
  if (!row || typeof row.fp !== "string" || typeof row.conversationId !== "string" || typeof row.agentSessionId !== "string") {
    return null;
  }
  if (row.fp !== fp) return null;
  if (row.conversationState != null && (typeof row.conversationState !== "object" || Array.isArray(row.conversationState))) {
    return { fp: row.fp, conversationId: row.conversationId, agentSessionId: row.agentSessionId };
  }
  return row;
}

export async function kvSetAgentRun(kv: Kv, tenant: string, sessionId: string, row: AgentRunBinding): Promise<void> {
  await kv.setItem(agentRunKvKey(tenant, sessionId), compactAgentRunBinding(row), {
    ttl: AGENT_RUN_KV_TTL_SECONDS,
    cap: AGENT_RUN_KV_TTL_SECONDS,
  });
}

/** Seconds until JWT refresh (60s before exp). */
export function jwtTtlSeconds(exp: number, now = Date.now() / 1000): number {
  return Math.max(1, Math.floor(exp - now - 60));
}

/** Persistent KV via Deno.openKv (Deno runtime only). */
export async function createDenoKv(): Promise<Kv> {
  const openKv = (globalThis as unknown as { Deno?: { openKv: () => Promise<DenoKvLike> } }).Deno?.openKv;
  if (!openKv) throw new Error("Deno.openKv is not available");
  const store = await openKv();
  return {
    async getItem<T = unknown>(key: string): Promise<T | null> {
      const entry = await store.get([key]);
      return (entry.value ?? null) as T | null;
    },
    async setItem(key: string, value: unknown, opts?: KvSetOpts) {
      const ttl = kvEntryTtlSeconds(opts?.ttl, opts?.cap);
      await store.set([key], value, { expireIn: ttl * 1000 });
    },
    async removeItem(key: string) {
      await store.delete([key]);
    },
  };
}

type DenoKvLike = {
  get: (key: [string]) => Promise<{ value: unknown }>;
  set: (key: [string], value: unknown, options?: { expireIn?: number }) => Promise<void>;
  delete: (key: [string]) => Promise<void>;
};

export function createMemoryKv(): Kv {
  const map = new Map<string, { value: unknown; expiresAt?: number }>();
  return {
    async getItem<T = unknown>(key: string): Promise<T | null> {
      const row = map.get(key);
      if (!row) return null;
      if (row.expiresAt != null && row.expiresAt <= Date.now()) {
        map.delete(key);
        return null;
      }
      return row.value as T;
    },
    async setItem(key: string, value: unknown, opts?: KvSetOpts) {
      const ttl = kvEntryTtlSeconds(opts?.ttl, opts?.cap);
      const expiresAt = Date.now() + ttl * 1000;
      map.set(key, { value, expiresAt });
    },
    async removeItem(key: string) {
      map.delete(key);
    },
  };
}

export async function kvGetJwt(kv: Kv, key: string): Promise<CachedJwt | null> {
  const row = await kv.getItem<CachedJwt>(key);
  if (!row?.accessToken || !row.exp) return null;
  if (row.exp - 60 <= Date.now() / 1000) {
    await kv.removeItem(key);
    return null;
  }
  return row;
}

export async function kvSetJwt(kv: Kv, key: string, value: CachedJwt): Promise<void> {
  await kv.setItem(key, value, { ttl: kvEntryTtlSeconds(jwtTtlSeconds(value.exp)) });
}
