/**
 * Process-isolate L1 for exchanged JWT (crsr_ → accessToken). Not used for client-supplied JWT.
 */
import type { CachedJwt } from "./kv.ts";
import { jwtTtlSeconds, kvEntryTtlSeconds } from "./kv.ts";

const store = new Map<string, { value: CachedJwt; expiresAt: number }>();

function isExpired(row: CachedJwt): boolean {
  return row.exp - 60 <= Date.now() / 1000;
}

export function jwtL1Get(key: string): CachedJwt | null {
  const row = store.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now() || isExpired(row.value)) {
    store.delete(key);
    return null;
  }
  return row.value;
}

export function jwtL1Set(key: string, value: CachedJwt): void {
  const ttlSec = kvEntryTtlSeconds(jwtTtlSeconds(value.exp));
  store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

/** Test-only: reset module L1 between cases. */
export function jwtL1ClearForTests(): void {
  store.clear();
}
