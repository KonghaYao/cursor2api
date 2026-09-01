import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryKv } from "./kv.ts";
import { ROLE, runCanonicalMessagePipeline, stableStringify, type CursorMessage } from "./inference.ts";
import {
  appendOnlyMerge,
  CanonConflictError,
  canonicalSerializeForFingerprint,
  computeAnchorFp,
  computeCanonHash,
  computeEnvFp,
  extractFCTR,
  resolveCanonicalThread,
  verifyAppendOnly,
} from "./session_fingerprint.ts";

const toolsA = [
  {
    name: "lookup",
    description: "search",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
];

const toolsB = [
  {
    name: "lookup",
    description: "search",
    parameters: { type: "object", properties: { q: { type: "string" }, limit: { type: "number" } } },
  },
];

test("same OpenAI input yields stable env_fp and anchor_fp", async () => {
  const body = { model: "composer-2.5-fast", messages: [{ role: "user", content: "hi" }] };
  const raw = body.messages;
  const e1 = await computeEnvFp(body, toolsA, { rawMessages: raw });
  const e2 = await computeEnvFp(body, toolsA, { rawMessages: raw });
  assert.equal(e1, e2);
  const p1 = await runCanonicalMessagePipeline(raw, body, toolsA);
  const p2 = await runCanonicalMessagePipeline(raw, body, toolsA);
  const a1 = await computeAnchorFp(p1.messages, toolsA);
  const a2 = await computeAnchorFp(p2.messages, toolsA);
  assert.equal(a1, a2);
});

test("tool schema change alters env_fp", async () => {
  const body = { model: "composer-2.5-fast" };
  const raw = [{ role: "user", content: "x" }];
  const e1 = await computeEnvFp(body, toolsA, { rawMessages: raw });
  const e2 = await computeEnvFp(body, toolsB, { rawMessages: raw });
  assert.notEqual(e1, e2);
});

test("anchor_fp pending before FCTR then final after tool round", async () => {
  const body = { model: "composer-2.5-fast", tool_choice: "required" };
  const turn1 = [{ role: "user", content: "go" }];
  const p1 = await runCanonicalMessagePipeline(turn1, body, toolsA);
  const pending = await computeAnchorFp(p1.messages, toolsA);
  assert.ok(pending.startsWith("pending:"));

  const turn2 = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "calling",
      tool_calls: [{ id: "call_b", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } }],
    },
    { role: "tool", tool_call_id: "call_b", content: "ok" },
  ];
  const p2 = await runCanonicalMessagePipeline(turn2, body, toolsA);
  const final = await computeAnchorFp(p2.messages, toolsA);
  assert.ok(!final.startsWith("pending:"));
  assert.notEqual(pending, final);
});

test("appendOnlyMerge accepts tail append and rejects prefix tamper", () => {
  const u: CursorMessage = { role: ROLE.user, text: "a" };
  const a: CursorMessage = { role: ROLE.assistant, text: "b" };
  const stored = [u];
  const extended = [u, a];
  assert.deepEqual(appendOnlyMerge(stored, extended, []), extended);
  const bad = [{ role: ROLE.user, text: "tampered" }, a];
  assert.throws(() => appendOnlyMerge(stored, bad, []), CanonConflictError);
});

test("verifyAppendOnly matches appendOnlyMerge semantics", async () => {
  const u: CursorMessage = { role: ROLE.user, text: "a" };
  const a: CursorMessage = { role: ROLE.assistant, text: "b" };
  const stored = [u];
  const extended = [u, a];
  const hash = await computeCanonHash(stored, []);
  const verified = await verifyAppendOnly(1, hash, extended, []);
  assert.deepEqual(verified, extended);
  const bad = [{ role: ROLE.user, text: "tampered" }, a];
  await assert.rejects(() => verifyAppendOnly(1, hash, bad, []), CanonConflictError);
});

test("KV row is hash-only (small payload)", async () => {
  const kv = createMemoryKv();
  const tenant = "t-small";
  const body = { model: "composer-2.5-fast" };
  const msgs = Array.from({ length: 50 }, (_, i) => ({
    role: "user" as const,
    content: `msg-${i}-${"x".repeat(200)}`,
  }));
  const pipelined = await runCanonicalMessagePipeline(msgs, body, []);
  const env = await computeEnvFp(body, [], { rawMessages: msgs });
  const anchor = await computeAnchorFp(pipelined.messages, []);
  await resolveCanonicalThread(kv, tenant, env, anchor, pipelined.messages, []);
  const slotKey = anchor.startsWith("pending:")
    ? `canon:${tenant}:${env}:active_pending`
    : `canon:${tenant}:${env}:${anchor}`;
  const raw = await kv.getItem<Record<string, unknown>>(slotKey);
  assert.ok(raw?.canon_hash && typeof raw.canon_hash === "string");
  assert.equal((raw.canon_hash as string).length, 64);
  assert.ok(!(raw as { canon?: unknown }).canon);
  const serialized = JSON.stringify(raw);
  assert.ok(serialized.length < 500, `KV row should be tiny, got ${serialized.length}`);
});

test("canonicalSerialize is stable under key reordering", () => {
  const a = { z: 1, a: { y: 2, b: 3 } };
  const b = { a: { b: 3, y: 2 }, z: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(canonicalSerializeForFingerprint([{ role: ROLE.user, text: "x", meta: b }], []), canonicalSerializeForFingerprint([{ role: ROLE.user, text: "x", meta: a }], []));
});

test("resolveCanonicalThread merges canon on second turn", async () => {
  const kv = createMemoryKv();
  const tenant = "t-fp";
  const body = { model: "composer-2.5-fast" };
  const turn1 = [{ role: "user", content: "one" }];
  const p1 = await runCanonicalMessagePipeline(turn1, body, []);
  const env = await computeEnvFp(body, [], { rawMessages: turn1 });
  const anchor = await computeAnchorFp(p1.messages, []);
  const r1 = await resolveCanonicalThread(kv, tenant, env, anchor, p1.messages, []);
  assert.equal(r1.merge, "miss");
  assert.equal(r1.canon.length, p1.messages.length);

  const turn2 = [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ];
  const p2 = await runCanonicalMessagePipeline(turn2, body, []);
  const r2 = await resolveCanonicalThread(kv, tenant, env, await computeAnchorFp(p2.messages, []), p2.messages, []);
  assert.equal(r2.merge, "hit");
  assert.ok(r2.canon.length >= r1.canon.length);
});

test("extractFCTR marks complete when tool results present", () => {
  const dialogue: CursorMessage[] = [
    { role: ROLE.user, text: "u" },
    {
      role: ROLE.assistant,
      text: "think",
      toolCalls: [{ toolCallId: "id2", toolName: "lookup", args: { q: "x" } }],
    },
    {
      role: ROLE.tool,
      toolContent: { parts: [{ toolCallId: "id2", toolName: "lookup", result: "ok", isError: false }] },
    },
  ];
  const f = extractFCTR(dialogue);
  assert.equal(f.complete, true);
  assert.equal(f.closure.length, 3);
});
