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
