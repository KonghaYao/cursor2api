import assert from "node:assert/strict";
import test from "node:test";
import { KV_TTL_SECONDS, CLOUD_AGENT_KV_TTL_SECONDS, cloudAgentKvKey, createMemoryKv, kvEntryTtlSeconds, kvGetCloudAgent, kvSetCloudAgent } from "./kv.ts";

test("kvEntryTtlSeconds caps at 5 minutes", () => {
  assert.equal(KV_TTL_SECONDS, 300);
  assert.equal(kvEntryTtlSeconds(), 300);
  assert.equal(kvEntryTtlSeconds(60), 60);
  assert.equal(kvEntryTtlSeconds(3600), 300);
});

test("kvEntryTtlSeconds honors a higher cap for cloud agent bindings", () => {
  assert.equal(kvEntryTtlSeconds(CLOUD_AGENT_KV_TTL_SECONDS, CLOUD_AGENT_KV_TTL_SECONDS), CLOUD_AGENT_KV_TTL_SECONDS);
});

test("cloud agent KV binding round-trips and ignores garbage", async () => {
  const kv = createMemoryKv();
  assert.equal(await kvGetCloudAgent(kv, "t1", "sess-a"), null);
  await kvSetCloudAgent(kv, "t1", "sess-a", "bc-11111111-1111-1111-1111-111111111111");
  assert.equal(await kvGetCloudAgent(kv, "t1", "sess-a"), "bc-11111111-1111-1111-1111-111111111111");
  assert.equal(await kvGetCloudAgent(kv, "t1", "sess-b"), null);
  await kv.removeItem(cloudAgentKvKey("t1", "sess-a"));
  await kv.setItem(cloudAgentKvKey("t1", "sess-a"), { agentId: "not-an-agent" });
  assert.equal(await kvGetCloudAgent(kv, "t1", "sess-a"), null);
});
