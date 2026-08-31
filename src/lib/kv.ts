/**
 * unstorage-shaped KV (getItem / setItem / removeItem).
 * Swap the backend per runtime: memory here, Cloudflare KV in src/cf.ts, Redis via unstorage, etc.
 */

export type Kv = {
  getItem<T = unknown>(key: string): Promise<T | null>;
  setItem(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type CachedJwt = {
  accessToken: string;
  exp: number;
};

/** All KV entries use at most this TTL (5 minutes). */
export const KV_TTL_SECONDS = 300;

/** Seconds to store in KV; always capped at {@link KV_TTL_SECONDS}. */
export function kvEntryTtlSeconds(preferred?: number): number {
  if (preferred == null || !Number.isFinite(preferred) || preferred <= 0) return KV_TTL_SECONDS;
  return Math.min(Math.floor(preferred), KV_TTL_SECONDS);
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
    async setItem(key: string, value: unknown, opts?: { ttl?: number }) {
      const ttl = kvEntryTtlSeconds(opts?.ttl);
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
    async setItem(key: string, value: unknown, opts?: { ttl?: number }) {
      const ttl = kvEntryTtlSeconds(opts?.ttl);
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
