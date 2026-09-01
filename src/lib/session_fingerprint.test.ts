import assert from "node:assert/strict";
import test from "node:test";
import { ROLE, runCanonicalMessagePipeline, type CursorMessage } from "./inference.ts";
import {
  appendOnlyMerge,
  CanonConflictError,
  computeSessionFp,
  extractFCTR,
  prefixThroughFirstTool,
} from "./session_fingerprint.ts";

const body = { model: "composer-2.5-fast" };
const tools = [{ name: "f", description: "", parameters: { type: "object" } }];

test("appendOnlyMerge accepts tail append and rejects prefix tamper", () => {
  const u: CursorMessage = { role: ROLE.user, text: "a" };
  const a: CursorMessage = { role: ROLE.assistant, text: "b" };
  assert.deepEqual(appendOnlyMerge([u], [u, a], []), [u, a]);
  assert.throws(() => appendOnlyMerge([u], [{ role: ROLE.user, text: "tampered" }, a], []), CanonConflictError);
});

test("prefixThroughFirstTool stops at first tool message", () => {
  const msgs: CursorMessage[] = [
    { role: ROLE.user, text: "u" },
    { role: ROLE.assistant, text: "", toolCalls: [{ toolCallId: "c1" }] },
    { role: ROLE.tool, toolContent: { parts: [{ toolCallId: "c1" }] } },
    { role: ROLE.user, text: "again" },
  ];
  const p = prefixThroughFirstTool(msgs);
  assert.equal(p.length, 3);
  assert.equal(extractFCTR(msgs).complete, true);
});

test("session_fp is stable after first tool when later turns append", async () => {
  const withTool = [
    { role: "user", content: "one" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const later = [...withTool, { role: "user", content: "two" }, { role: "assistant", content: "hi" }];
  const p1 = await runCanonicalMessagePipeline(withTool, body, tools);
  const p2 = await runCanonicalMessagePipeline(later, body, tools);
  const f1 = await computeSessionFp(body, p1.tools, { pipelined: p1.messages, rawMessages: withTool });
  const f2 = await computeSessionFp(body, p2.tools, { pipelined: p2.messages, rawMessages: later });
  assert.equal(f1, f2);
});

test("session_fp pending (no tool yet) changes when user text grows", async () => {
  const t1 = [{ role: "user", content: "one" }];
  const t2 = [{ role: "user", content: "one" }, { role: "assistant", content: "a" }, { role: "user", content: "two" }];
  const p1 = await runCanonicalMessagePipeline(t1, body, []);
  const p2 = await runCanonicalMessagePipeline(t2, body, []);
  const f1 = await computeSessionFp(body, [], { pipelined: p1.messages, rawMessages: t1 });
  const f2 = await computeSessionFp(body, [], { pipelined: p2.messages, rawMessages: t2 });
  assert.notEqual(f1, f2);
});

test("model change alters session_fp", async () => {
  const msgs = [{ role: "user", content: "hi" }];
  const p = await runCanonicalMessagePipeline(msgs, body, []);
  const a = await computeSessionFp({ model: "composer-2.5-fast" }, [], { pipelined: p.messages, rawMessages: msgs });
  const b = await computeSessionFp({ model: "composer-2.5" }, [], { pipelined: p.messages, rawMessages: msgs });
  assert.notEqual(a, b);
});

test("reasoning_effort change alters session_fp", async () => {
  const msgs = [{ role: "user", content: "hi" }];
  const p = await runCanonicalMessagePipeline(msgs, body, []);
  const a = await computeSessionFp({ model: "grok-4.6-fast", reasoning_effort: "low" }, [], {
    pipelined: p.messages,
    rawMessages: msgs,
  });
  const b = await computeSessionFp({ model: "grok-4.6-fast", reasoning_effort: "high" }, [], {
    pipelined: p.messages,
    rawMessages: msgs,
  });
  assert.notEqual(a, b);
});

test("tools catalog change alters session_fp", async () => {
  const msgs = [{ role: "user", content: "x" }];
  const p = await runCanonicalMessagePipeline(msgs, body, []);
  const tA = [{ name: "alpha", description: "A", parameters: { type: "object" } }];
  const tB = [{ name: "beta", description: "B", parameters: { type: "object" } }];
  const a = await computeSessionFp(body, tA as never, { pipelined: p.messages, rawMessages: msgs });
  const b = await computeSessionFp(body, tB as never, { pipelined: p.messages, rawMessages: msgs });
  assert.notEqual(a, b);
});
