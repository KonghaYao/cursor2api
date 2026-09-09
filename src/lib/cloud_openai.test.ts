import assert from "node:assert/strict";
import test from "node:test";
import { cloudAuthHeaders, isCloudAgentId, parseSseBlock } from "./cloud_agents.ts";
import {
  cloudModelSelection,
  extractCloudAgentId,
  extractCloudPromptImages,
  flattenMessagesForCreate,
  lastUserText,
  promptFromMessages,
} from "./cloud_openai.ts";
import { extractCloudSessionRef } from "./cloud_session.ts";

test("isCloudAgentId only accepts Cursor bc- ids", () => {
  assert.equal(isCloudAgentId("bc-00000000-0000-0000-0000-000000000001"), true);
  assert.equal(isCloudAgentId("tenant:session_fp"), false);
  assert.equal(isCloudAgentId("chatcmpl-abc"), false);
  assert.equal(isCloudAgentId("550e8400-e29b-41d4-a716-446655440000"), false);
});

test("extractCloudAgentId ignores Inference-style session ids", () => {
  assert.equal(
    extractCloudAgentId({ conversation_id: "tenant:deadbeef" }),
    undefined,
  );
  assert.equal(
    extractCloudAgentId({ conversation_id: "bc-11111111-1111-1111-1111-111111111111" }),
    "bc-11111111-1111-1111-1111-111111111111",
  );
  assert.equal(
    extractCloudAgentId(
      { extra_body: { agent_id: "bc-22222222-2222-2222-2222-222222222222" } },
      new Headers(),
    ),
    "bc-22222222-2222-2222-2222-222222222222",
  );
  assert.equal(
    extractCloudAgentId({}, new Headers({ "x-cursor-agent-id": "bc-33333333-3333-3333-3333-333333333333" })),
    "bc-33333333-3333-3333-3333-333333333333",
  );
});

test("extractCloudSessionRef uses client session id when it is not a bc- agent", () => {
  assert.deepEqual(extractCloudSessionRef({ conversation_id: "sess-1" }), {
    kind: "session",
    sessionId: "sess-1",
  });
  assert.deepEqual(
    extractCloudSessionRef({}, new Headers({ "x-session-id": "thread-abc" })),
    { kind: "session", sessionId: "thread-abc" },
  );
  assert.deepEqual(
    extractCloudSessionRef({ conversation_id: "bc-11111111-1111-1111-1111-111111111111" }),
    { kind: "agent", agentId: "bc-11111111-1111-1111-1111-111111111111" },
  );
});

test("follow-up prompt uses only the last user turn", () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
  ];
  assert.equal(lastUserText(messages), "second");
  assert.equal(promptFromMessages(messages, true).text, "second");
  assert.ok(flattenMessagesForCreate(messages).includes("system: be brief"));
  assert.ok(flattenMessagesForCreate(messages).includes("user: second"));
});

test("cloudModelSelection maps -fast to model.params", () => {
  assert.deepEqual(cloudModelSelection("composer-2.5-fast"), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  });
  assert.deepEqual(cloudModelSelection("composer-2.5"), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "false" }],
  });
  assert.equal(cloudModelSelection("auto"), undefined);
});

test("cloudModelSelection upgrades Grok to fast when client tools are present", () => {
  assert.deepEqual(cloudModelSelection("grok-4.6", {}, true), {
    id: "grok-4.6",
    params: [{ id: "fast", value: "true" }],
  });
  assert.deepEqual(cloudModelSelection("grok-4.6", {}), {
    id: "grok-4.6",
    params: [{ id: "fast", value: "false" }],
  });
});

test("extractCloudPromptImages reads OpenAI data URLs and https URLs", () => {
  const images = extractCloudPromptImages([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aaaa" } },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    },
  ]);
  assert.deepEqual(images, [
    { data: "aaaa", mimeType: "image/png" },
    { url: "https://example.com/a.png" },
  ]);
});

test("cloudAuthHeaders uses Basic key:", () => {
  const headers = cloudAuthHeaders("crsr_test");
  assert.ok(headers.authorization.startsWith("Basic "));
  const decoded = Buffer.from(headers.authorization.slice(6), "base64").toString("utf8");
  assert.equal(decoded, "crsr_test:");
});

test("parseSseBlock reads Cloud Agents assistant events", () => {
  const ev = parseSseBlock('id: 1-0\nevent: assistant\ndata: {"text":"hello"}');
  assert.equal(ev?.event, "assistant");
  assert.equal(ev?.data.text, "hello");
  assert.equal(ev?.id, "1-0");
});
