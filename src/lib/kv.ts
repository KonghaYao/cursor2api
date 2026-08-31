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

/** Seconds until JWT refresh (60s before exp). */
export function jwtTtlSeconds(exp: number, now = Date.now() / 1000): number {
  return Math.max(1, Math.floor(exp - now - 60));
}

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
      const expiresAt = opts?.ttl != null ? Date.now() + opts.ttl * 1000 : undefined;
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
  await kv.setItem(key, value, { ttl: jwtTtlSeconds(value.exp) });
}
