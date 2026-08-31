import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryKv } from "./kv.ts";
import { isNewConversationMessages, resolveClientSessionId } from "./session.ts";

test("isNewConversationMessages ignores system", () => {
  assert.equal(
    isNewConversationMessages([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]),
    true,
  );
  assert.equal(
    isNewConversationMessages([
      { role: "system", content: "x" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]),
    false,
  );
});

test("sticky session continues across turns without client id", async () => {
  const kv = createMemoryKv();
  const tenant = "t1";
  const turn1 = [{ role: "user", content: "a" }];
  const turn2 = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];

  const r1 = await resolveClientSessionId(kv, tenant, turn1, undefined);
  const r2 = await resolveClientSessionId(kv, tenant, turn2, undefined);
  assert.equal(r1.source, "sticky_new");
  assert.equal(r2.source, "sticky_continue");
  assert.equal(r1.clientId, r2.clientId);
});

test("explicit id overrides sticky", async () => {
  const kv = createMemoryKv();
  const r = await resolveClientSessionId(kv, "t1", [{ role: "user", content: "x" }], "fixed-id");
  assert.equal(r.clientId, "fixed-id");
  assert.equal(r.source, "explicit");
});
