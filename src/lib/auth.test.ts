import assert from "node:assert/strict";
import test from "node:test";
import { getAccessToken, modelsFrom } from "./auth.ts";
import { jwtL1ClearForTests } from "./jwt_l1_cache.ts";
import { createMemoryKv, type Kv } from "./kv.ts";

function countingKv(): Kv & { gets: number; sets: number } {
  const inner = createMemoryKv();
  const stats = { gets: 0, sets: 0 };
  return {
    get gets() {
      return stats.gets;
    },
    get sets() {
      return stats.sets;
    },
    async getItem<T>(key: string) {
      stats.gets += 1;
      return inner.getItem<T>(key);
    },
    async setItem(key: string, value: unknown, opts?: { ttl?: number }) {
      stats.sets += 1;
      await inner.setItem(key, value, opts);
    },
    async removeItem(key: string) {
      await inner.removeItem(key);
    },
  };
}

function fakeJwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

test("modelsFrom accepts Cursor and generic model id fields", () => {
  assert.deepEqual(
    modelsFrom({
      models: [
        { modelId: "composer-2.5-fast" },
        { displayModelId: "cursor-grok-4.6-high-fast" },
        { id: "third-party-id" },
        { name: "fallback-name" },
      ],
    }),
    ["composer-2.5-fast", "cursor-grok-4.6-high-fast", "third-party-id", "fallback-name"],
  );
});
test("getAccessToken: client JWT bypasses KV and L1 persistence", async () => {
  jwtL1ClearForTests();
  const kv = countingKv();
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const jwt = fakeJwt(exp);
  const headers = new Headers({ authorization: `Bearer ${jwt}` });

  const a = await getAccessToken({ kv }, headers);
  const b = await getAccessToken({ kv }, headers);

  assert.equal(a.accessToken, jwt);
  assert.equal(b.accessToken, jwt);
  assert.equal(a.tenant, b.tenant);
  assert.equal(kv.gets, 0);
  assert.equal(kv.sets, 0);
});

test("getAccessToken: crsr_ uses L1 after first exchange (no second KV read)", async () => {
  jwtL1ClearForTests();
  const kv = countingKv();
  const apiKey = "crsr_test_key_l1";
  const exchangedJwt = fakeJwt(Math.floor(Date.now() / 1000) + 7200);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/auth/exchange_user_api_key")) {
      return new Response(JSON.stringify({ accessToken: exchangedJwt }), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const headers = new Headers({ authorization: `Bearer ${apiKey}` });
    const first = await getAccessToken({ kv }, headers);
    assert.equal(first.accessToken, exchangedJwt);
    assert.equal(kv.gets, 1);
    assert.equal(kv.sets, 1);

    const second = await getAccessToken({ kv }, headers);
    assert.equal(second.accessToken, exchangedJwt);
    assert.equal(kv.gets, 1, "L1 hit must not read KV again");
    assert.equal(kv.sets, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
