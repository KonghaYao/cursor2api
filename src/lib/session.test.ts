import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryKv } from "./kv.ts";
import { isNewConversationMessages, resolveSessionForRequest, resolveSessionMode } from "./session.ts";

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

test("resolveSessionMode defaults to fingerprint", () => {
  const prev = process.env.SESSION_MODE;
  const prevSticky = process.env.SESSION_STICKY;
  delete process.env.SESSION_MODE;
  delete process.env.SESSION_STICKY;
  assert.equal(resolveSessionMode(), "fingerprint");
  process.env.SESSION_MODE = "sticky";
  assert.equal(resolveSessionMode(), "fingerprint");
  process.env.SESSION_MODE = "random";
  assert.equal(resolveSessionMode(), "random");
  if (prev === undefined) delete process.env.SESSION_MODE;
  else process.env.SESSION_MODE = prev;
  if (prevSticky === undefined) delete process.env.SESSION_STICKY;
  else process.env.SESSION_STICKY = prevSticky;
});

test("fingerprint session merges canon across turns without client id", async () => {
  const kv = createMemoryKv();
  const tenant = "t1";
  const body = { model: "grok-4.6-fast", messages: [] };
  const turn1 = [{ role: "user", content: "sticky-replacement-a" }];
  const turn2 = [
    { role: "user", content: "sticky-replacement-a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];

  const r1 = await resolveSessionForRequest(kv, tenant, turn1, { body, tools: [] });
  const r2 = await resolveSessionForRequest(kv, tenant, turn2, { body, tools: [] });
  assert.equal(r1.mode, "fingerprint");
  assert.equal(r2.mode, "fingerprint");
  assert.equal(r2.merge, "hit");
  assert.ok(r2.canon_len >= r1.canon_len);
});
