import assert from "node:assert/strict";
import test from "node:test";
import { KV_TTL_SECONDS, kvEntryTtlSeconds } from "./kv.ts";

test("kvEntryTtlSeconds caps at 5 minutes", () => {
  assert.equal(KV_TTL_SECONDS, 300);
  assert.equal(kvEntryTtlSeconds(), 300);
  assert.equal(kvEntryTtlSeconds(60), 60);
  assert.equal(kvEntryTtlSeconds(3600), 300);
});
