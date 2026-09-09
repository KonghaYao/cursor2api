import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUN_LEN_KV_TTL_SECONDS,
  AGENT_RUN_STATE_MAX_BYTES,
  CLOUD_AGENT_KV_TTL_SECONDS,
  KV_TTL_SECONDS,
  compactAgentRunBinding,
  cloudAgentKvKey,
  createMemoryKv,
  kvEntryTtlSeconds,
  kvGetAgentRun,
  kvGetAgentRunLen,
  kvGetCloudAgent,
  kvSetAgentRun,
  kvSetAgentRunLen,
  kvSetCloudAgent,
} from "./kv.ts";

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

test("agent-run KV binding round-trips and ignores fp mismatch", async () => {
  const kv = createMemoryKv();
  await kvSetAgentRun(kv, "t1", "sess-a", {
    fp: "fp-1",
    conversationId: "t1:abc",
    agentSessionId: "abc",
    conversationState: { cursor: 1 },
  });
  const hit = await kvGetAgentRun(kv, "t1", "sess-a", "fp-1");
  assert.equal(hit?.conversationId, "t1:abc");
  assert.deepEqual(hit?.conversationState, { cursor: 1 });
  assert.equal(await kvGetAgentRun(kv, "t1", "sess-a", "fp-other"), null);
});

test("agent-run-len stores a 5-minute message cursor, not the transcript", async () => {
  assert.equal(AGENT_RUN_LEN_KV_TTL_SECONDS, 300);
  const kv = createMemoryKv();
  assert.equal(await kvGetAgentRunLen(kv, "t1", "fp-1"), null);
  await kvSetAgentRunLen(kv, "t1", "fp-1", 3);
  assert.equal(await kvGetAgentRunLen(kv, "t1", "fp-1"), 3);
  await kvSetAgentRunLen(kv, "t1", "fp-1", 0);
  assert.equal(await kvGetAgentRunLen(kv, "t1", "fp-1"), 3);
  assert.equal(await kvGetAgentRunLen(kv, "t1", "fp-other"), null);
});

test("compactAgentRunBinding drops oversized conversationState", () => {
  const row = compactAgentRunBinding({
    fp: "fp",
    conversationId: "c",
    agentSessionId: "a",
    conversationState: { blob: "x".repeat(AGENT_RUN_STATE_MAX_BYTES) },
  });
  assert.equal(row.conversationState, undefined);
  assert.equal(row.conversationId, "c");
});
