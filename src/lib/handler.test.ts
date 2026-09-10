import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { incomingCredential } from "./auth.ts";
import { customToolChatClearForTests, setCustomToolAgentHostForTests } from "./custom_tool_chat.ts";
import { customToolsClearForTests } from "./custom_tools.ts";
import { handleGatewayRequest, validateAnthropicRequest } from "./handler.ts";
import { createMemoryKv } from "./kv.ts";

afterEach(() => {
  customToolsClearForTests();
  customToolChatClearForTests();
  setCustomToolAgentHostForTests(undefined);
});

test("incomingCredential treats Authorization: Bearer with no token as missing", () => {
  assert.equal(incomingCredential(new Headers()), undefined);
  assert.equal(incomingCredential(new Headers({ authorization: "Bearer" })), undefined);
  assert.equal(incomingCredential(new Headers({ authorization: "Bearer " })), undefined);
  assert.equal(incomingCredential(new Headers({ authorization: "Bearer crsr_live" })), "crsr_live");
});

test("validateAnthropicRequest accepts thinking without signature", () => {
  assert.doesNotThrow(() =>
    validateAnthropicRequest({
      model: "composer-2.5-fast",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "ok" }] },
        { role: "user", content: "again" },
      ],
    }),
  );
});

test("validateAnthropicRequest still requires thinking text", () => {
  assert.throws(
    () =>
      validateAnthropicRequest({
        model: "composer-2.5-fast",
        max_tokens: 64,
        messages: [{ role: "assistant", content: [{ type: "thinking", signature: "sig" }] }],
      }),
    /thinking is required/,
  );
});

test("missing Authorization on /v1/chat/completions is 401 JSON", async () => {
  const res = await handleGatewayRequest(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "composer-2.5-fast", messages: [{ role: "user", content: "hi" }] }),
    }),
    { kv: createMemoryKv(), upstream: "cloud" },
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(String(body.error?.message || ""), /API key/);
  assert.equal(body.error?.type, "authentication_error");
});

test("empty Authorization: Bearer on /v1/chat/completions is 401 JSON", async () => {
  const res = await handleGatewayRequest(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer", "content-type": "application/json" },
      body: JSON.stringify({ model: "composer-2.5-fast", messages: [{ role: "user", content: "hi" }] }),
    }),
    { kv: createMemoryKv(), upstream: "cloud" },
  );
  assert.equal(res.status, 401);
});

test("Anthropic follow-up can echo unsigned thinking from the previous turn", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-anth-follow",
        async send() {
          return { wait: async () => ({ text: "second", thinking: "later" }) };
        },
        async close() {},
      };
    },
  });
  const res = await handleGatewayRequest(
    new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "crsr_test", "content-type": "application/json" },
      body: JSON.stringify({
        model: "composer-2.5-fast",
        max_tokens: 64,
        messages: [
          { role: "user", content: "你的工具有什么" },
          { role: "assistant", content: [{ type: "thinking", thinking: "list tools" }, { type: "text", text: "get_weather" }] },
          { role: "user", content: "调用一下" },
        ],
      }),
    }),
    { kv: createMemoryKv(), upstream: "cloud" },
  );
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.deepEqual(body.content, [{ type: "text", text: "second" }]);
});
