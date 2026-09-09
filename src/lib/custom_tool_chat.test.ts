import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { customToolsClearForTests } from "./custom_tools.ts";
import {
  agentImagesFromCursorParts,
  customToolChatClearForTests,
  handleCustomToolChatCompletions,
  handleCustomToolMessages,
  setCustomToolAgentHostForTests,
} from "./custom_tool_chat.ts";
import type { AgentInlineImage } from "./agent_json.ts";
import { createMemoryKv } from "./kv.ts";
import type { CustomToolAgentCreateOpts } from "./custom_tool_chat.ts";

afterEach(() => {
  customToolsClearForTests();
  customToolChatClearForTests();
  setCustomToolAgentHostForTests(undefined);
});

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("agentImagesFromCursorParts maps Inference image parts to AgentService images", () => {
  const images = agentImagesFromCursorParts([{ image: { data: "aaaa", mimeType: "image/jpeg" } }]);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.data, "aaaa");
  assert.equal(images[0]?.mimeType, "image/jpeg");
  assert.match(images[0]?.path || "", /\.jpg$/);
});

test("OpenAI chat returns reasoning_content and forwards image bytes", async () => {
  let sent: { prompt: string; images?: AgentInlineImage[] } | undefined;
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-think",
        async send(prompt, opts) {
          sent = { prompt, images: opts?.images };
          return {
            wait: async () => ({ text: "a cat", thinking: "the pixels look like a cat" }),
          };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test", "x-session-id": "sess-img" }),
    body: {
      model: "composer-2.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
          ],
        },
      ],
    },
    tools: [],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "a cat");
  assert.equal(body.choices[0].message.reasoning_content, "the pixels look like a cat");
  assert.equal(sent?.images?.length, 1);
  assert.equal(sent?.images?.[0]?.mimeType, "image/png");
  assert.equal(sent?.images?.[0]?.data, PNG_B64);
  assert.match(sent?.prompt || "", /what is this\?/);
});

test("Anthropic messages return a thinking content block", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-anth",
        async send() {
          return { wait: async () => ({ text: "42", thinking: "17*19" }) };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolMessages({
    headers: new Headers({ "x-api-key": "crsr_test", "x-session-id": "sess-think" }),
    body: {
      model: "grok-4.6-fast",
      max_tokens: 64,
      messages: [{ role: "user", content: "17*19" }],
    },
    tools: [],
    requestId: "req_test",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.content[0], { type: "thinking", thinking: "17*19" });
  assert.deepEqual(body.content[1], { type: "text", text: "42" });
});

test("Anthropic image blocks are forwarded as AgentService selectedImages", async () => {
  let sent: AgentInlineImage[] | undefined;
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-aimg",
        async send(_prompt, opts) {
          sent = opts?.images;
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolMessages({
    headers: new Headers({ "x-api-key": "crsr_test", "x-session-id": "sess-aimg" }),
    body: {
      model: "composer-2.5",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          ],
        },
      ],
    },
    tools: [],
    requestId: "req_img",
  });
  assert.equal(res.status, 200);
  assert.equal(sent?.length, 1);
  assert.equal(sent?.[0]?.data, PNG_B64);
});

test("AgentService conversationId survives an isolate hop via KV", async () => {
  const kv = createMemoryKv();
  const creates: CustomToolAgentCreateOpts[] = [];
  const prompts: string[] = [];
  setCustomToolAgentHostForTests({
    async create(opts) {
      creates.push(opts);
      return {
        agentId: opts.agentSessionId || "agent-hop",
        async send(prompt) {
          prompts.push(prompt);
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const headers = new Headers({ authorization: "Bearer crsr_test", "x-session-id": "sess-hop" });
  const firstBody = {
    model: "composer-2.5",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
  };
  const first = await handleCustomToolChatCompletions({ headers, body: firstBody, tools: [], kv });
  assert.equal(first.status, 200);
  assert.equal(creates.length, 1);
  assert.ok(creates[0]?.conversationId);
  assert.match(prompts[0] || "", /<system>/);

  customToolChatClearForTests();
  setCustomToolAgentHostForTests({
    async create(opts) {
      creates.push(opts);
      return {
        agentId: opts.agentSessionId || "agent-hop-2",
        async send(prompt) {
          prompts.push(prompt);
          return { wait: async () => ({ text: "ok2" }) };
        },
        async close() {},
      };
    },
  });
  const second = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "again" },
      ],
    },
    tools: [],
    kv,
  });
  assert.equal(second.status, 200);
  assert.equal(creates.length, 2);
  assert.equal(creates[1]?.conversationId, creates[0]?.conversationId);
  assert.equal(creates[1]?.agentSessionId, creates[0]?.agentSessionId);
  assert.doesNotMatch(prompts[1] || "", /<system>/);
  assert.match(prompts[1] || "", /again/);
});

test("same isolate keeps two client sessions on different AgentService conversation ids", async () => {
  const kv = createMemoryKv();
  const ids: string[] = [];
  setCustomToolAgentHostForTests({
    async create(opts) {
      ids.push(String(opts.conversationId));
      return {
        agentId: opts.agentSessionId || "agent",
        async send() {
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const body = { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] };
  await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test", "x-session-id": "sess-a" }),
    body,
    tools: [],
    kv,
  });
  await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test", "x-session-id": "sess-b" }),
    body,
    tools: [],
    kv,
  });
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("model change starts a new AgentService conversation", async () => {
  const kv = createMemoryKv();
  const ids: string[] = [];
  setCustomToolAgentHostForTests({
    async create(opts) {
      ids.push(String(opts.conversationId));
      return {
        agentId: opts.agentSessionId || "agent",
        async send() {
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const headers = new Headers({ authorization: "Bearer crsr_test", "x-session-id": "sess-model" });
  await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] },
    tools: [],
    kv,
  });
  await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5-fast", messages: [{ role: "user", content: "hi" }] },
    tools: [],
    kv,
  });
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("same session follow-up reuses the in-process agent", async () => {
  let creates = 0;
  setCustomToolAgentHostForTests({
    async create(opts) {
      creates += 1;
      return {
        agentId: opts.agentSessionId || "agent-reuse",
        async send() {
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const kv = createMemoryKv();
  const headers = new Headers({ authorization: "Bearer crsr_test", "x-session-id": "sess-reuse" });
  await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [{ role: "user", content: "one" }] },
    tools: [],
    kv,
  });
  await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "two" },
      ],
    },
    tools: [],
    kv,
  });
  assert.equal(creates, 1);
});
