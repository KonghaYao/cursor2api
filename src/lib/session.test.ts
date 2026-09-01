import assert from "node:assert/strict";
import test from "node:test";
import { isNewConversationMessages, resolveSessionForRequest, resolveSessionMode } from "./session.ts";

test("isNewConversationMessages ignores system", () => {
  assert.equal(
    isNewConversationMessages([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]),
    true,
  );
});

test("resolveSessionMode defaults to fingerprint", () => {
  const prev = process.env.SESSION_MODE;
  delete process.env.SESSION_MODE;
  assert.equal(resolveSessionMode(), "fingerprint");
  process.env.SESSION_MODE = "random";
  assert.equal(resolveSessionMode(), "random");
  if (prev === undefined) delete process.env.SESSION_MODE;
  else process.env.SESSION_MODE = prev;
});

test("fingerprint session_fp is stable after first tool via resolveSessionForRequest", async () => {
  const tenant = "t-stable";
  const body = { model: "composer-2.5-fast" };
  const tools = [{ name: "f", description: "", parameters: { type: "object" } }];
  const withTool = [
    { role: "user", content: "one" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const later = [...withTool, { role: "user", content: "two" }];
  const r1 = await resolveSessionForRequest(tenant, withTool, { body, tools });
  const r2 = await resolveSessionForRequest(tenant, later, { body, tools });
  assert.equal(r1.mode, "fingerprint");
  assert.equal(r2.mode, "fingerprint");
  if (r1.mode !== "fingerprint" || r2.mode !== "fingerprint") return;
  assert.equal(r1.session_fp, r2.session_fp);
  assert.equal(r1.upstreamConversationId, r1.session_fp);
  assert.equal(r2.upstreamConversationId, r1.session_fp);
  assert.ok(r2.canon_len > r1.canon_len);
});
