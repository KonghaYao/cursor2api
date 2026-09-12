import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { customToolsClearForTests, openaiToolsToCustom } from "./custom_tools.ts";
import {
  agentImagesFromCursorParts,
  customToolChatClearForTests,
  cwdFromClientSystem,
  handleCustomToolChatCompletions,
  handleCustomToolMessages,
  setCustomToolAgentHostForTests,
} from "./custom_tool_chat.ts";
import type { AgentInlineImage, JsonObject } from "./agent_json.ts";
import { asObject, field } from "./agent_json.ts";
import { createMemoryKv } from "./kv.ts";
import type { CustomToolAgentCreateOpts, CustomToolSendOpts } from "./custom_tool_chat.ts";
import { createSdkAgentHost } from "./sdk_agent_host.ts";
import type { AgentDuplex, OpenAgentRun } from "./agent_run.ts";
import { decodeRootPromptText, spliceConversationFromClient, utf8FromBlobData } from "./conversation_state.ts";

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

test("cwdFromClientSystem extracts the absolute working directory from env context", () => {
  assert.equal(
    cwdFromClientSystem({
      messages: [
        {
          role: "system",
          content: "<env>\nWorking directory: /Users/mino/code/project with spaces\nIs directory a git repo: Yes\n</env>",
        },
      ],
    }),
    "/Users/mino/code/project with spaces",
  );
  assert.equal(cwdFromClientSystem({ system: "Working directory: relative/path" }), undefined);
});

test("OpenAI chat passes the system working directory to AgentService host", async () => {
  let created: CustomToolAgentCreateOpts | undefined;
  setCustomToolAgentHostForTests({
    async create(opts) {
      created = opts;
      return {
        agentId: "agent-cwd",
        async send() {
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: {
      model: "composer-2.5",
      messages: [
        { role: "system", content: "<env>\nWorking directory: /workspace/repo\n</env>" },
        { role: "user", content: "what is my pwd?" },
      ],
    },
    tools: [],
  });
  assert.equal(res.status, 200);
  assert.equal(created?.cwd, "/workspace/repo");
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

test("Anthropic messages emit thinking with an empty echo-safe signature", async () => {
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
  assert.deepEqual(body.content[0], { type: "thinking", thinking: "17*19", signature: "" });
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
  const headers = new Headers({ authorization: "Bearer crsr_test" });
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
  assert.equal(prompts[0] || "", "hi");
  assert.doesNotMatch(prompts[0] || "", /<system>/);

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

test("isolate hop with Write catalog still attaches Write on create and send", async () => {
  const kv = createMemoryKv();
  const catalog = [
    { type: "custom" as const, name: "Write" },
    { type: "function" as const, function: { name: "Edit" } },
    { type: "function" as const, function: { name: "Bash" } },
  ];
  const tools = openaiToolsToCustom(catalog);
  const creates: CustomToolAgentCreateOpts[] = [];
  const sendTools: Array<string[] | undefined> = [];
  setCustomToolAgentHostForTests({
    async create(opts) {
      creates.push(opts);
      return {
        agentId: opts.agentSessionId || "agent-hop-write",
        async send(_prompt, sendOpts) {
          sendTools.push(Object.keys(sendOpts?.customTools || opts.customTools || {}));
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const user = { role: "user", content: "write a.ts" };
  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [user], tools: catalog },
    tools,
    kv,
  });
  assert.equal(first.status, 200);
  const body1 = await first.json();
  assert.deepEqual(Object.keys(creates[0]?.customTools || {}), ["Write", "Edit", "Bash"]);
  assert.deepEqual(sendTools[0], ["Write", "Edit", "Bash"]);

  customToolChatClearForTests();
  setCustomToolAgentHostForTests({
    async create(opts) {
      creates.push(opts);
      return {
        agentId: opts.agentSessionId || "agent-hop-write-2",
        async send(_prompt, sendOpts) {
          sendTools.push(Object.keys(sendOpts?.customTools || {}));
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
      tools: catalog,
      messages: [user, { role: "assistant", content: "ok" }, { role: "user", content: "edit again" }],
    },
    tools,
    kv,
  });
  const body2 = await second.json();
  assert.equal(second.status, 200);
  assert.equal(body2.conversation_id, body1.conversation_id);
  assert.equal(creates.length, 2);
  assert.deepEqual(Object.keys(creates[1]?.customTools || {}), ["Write", "Edit", "Bash"]);
  assert.deepEqual(sendTools[1], ["Write", "Edit", "Bash"]);
});

test("same first user reuses AgentService conversation even with different x-session-id", async () => {
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
  const first = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test", "x-session-id": "sess-a" }),
    body,
    tools: [],
    kv,
  });
  const second = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test", "x-session-id": "sess-b" }),
    body,
    tools: [],
    kv,
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(ids.length, 1);
  const json = await first.json();
  assert.equal(json.conversation_id, ids[0]);
  assert.match(String(json.conversation_id), /:[0-9a-f]{64}$/);
});

test("different first user starts a new AgentService conversation", async () => {
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
  await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: { model: "composer-2.5", messages: [{ role: "user", content: "alpha" }] },
    tools: [],
    kv,
  });
  await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: { model: "composer-2.5", messages: [{ role: "user", content: "beta" }] },
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
  const headers = new Headers({ authorization: "Bearer crsr_test" });
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
  const headers = new Headers({ authorization: "Bearer crsr_test" });
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

test("follow-up user always sends conversationState (upstream requires it)", async () => {
  const sendOpts: Array<CustomToolSendOpts | undefined> = [];
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-state-required",
        async send(_prompt, opts) {
          sendOpts.push(opts);
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const kv = createMemoryKv();
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [{ role: "user", content: "你的工具有什么" }] },
    tools: [],
    kv,
  });
  assert.equal(first.status, 200);
  const second = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      messages: [
        { role: "user", content: "你的工具有什么" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "调用一下" },
      ],
    },
    tools: [],
    kv,
  });
  assert.equal(second.status, 200);
  assert.equal(sendOpts.length, 2);
  assert.ok(sendOpts[0]?.conversationState);
  assert.ok(sendOpts[1]?.conversationState, "omitting conversationState yields invalid_argument: Conversation state is required");
  const roots = decodeRootPromptText(sendOpts[1]!.conversationState!, sendOpts[1]!.blobs!);
  assert.match(roots, /你的工具有什么/);
  assert.doesNotMatch(JSON.stringify(sendOpts[1]!.conversationState), /"turns":\[\]/);
});

test("park_miss with a full transcript splices tool history into conversationState", async () => {
  const kv = createMemoryKv();
  const prompts: string[] = [];
  const sends: Array<{ prompt: string; opts?: CustomToolSendOpts }> = [];
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-full",
        async send(prompt, opts) {
          prompts.push(prompt);
          sends.push({ prompt, opts });
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [{ role: "user", content: "weather in tokyo?" }] },
    tools: [],
    kv,
  });
  customToolChatClearForTests();
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-full-2",
        async send(prompt, opts) {
          prompts.push(prompt);
          sends.push({ prompt, opts });
          return { wait: async () => ({ text: "ok2" }) };
        },
        async close() {},
      };
    },
  });
  const full = [
    { role: "user", content: "weather in tokyo?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":22}' },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_2", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_2", content: '{"humidity":40}' },
  ];
  const res = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: full },
    tools: [],
    kv,
  });
  assert.equal(res.status, 200);
  assert.equal(prompts.length, 2);
  assert.equal(sends[1]?.opts?.resume, false);
  assert.match(prompts[1], /The client executed your custom tools/);
  assert.match(prompts[1], /call_2/);
  assert.match(prompts[1], /40/);
  assert.doesNotMatch(prompts[1], /call_1/);
  const roots = decodeRootPromptText(sends[1]!.opts!.conversationState!, sends[1]!.opts!.blobs!);
  assert.match(roots, /weather in tokyo/);
  assert.match(roots, /call_1/);
  assert.match(roots, /22/);
  assert.match(roots, /Already invoked client tool lookup \(id call_2\)/);
  assert.doesNotMatch(roots, /\[Tool Call\]|\[tool_call\]/);
  assert.doesNotMatch(roots, /humidity/);
});

test("KV message length cursor forwards every new user after an isolate hop", async () => {
  const kv = createMemoryKv();
  const prompts: string[] = [];
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-len",
        async send(prompt) {
          prompts.push(prompt);
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [{ role: "user", content: "one" }] },
    tools: [],
    kv,
  });
  assert.equal(first.status, 200);

  customToolChatClearForTests();
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-len-2",
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
        { role: "user", content: "one" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "two" },
        { role: "user", content: "three" },
      ],
    },
    tools: [],
    kv,
  });
  assert.equal(second.status, 200);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] || "", /two/);
  assert.match(prompts[1] || "", /three/);
  assert.doesNotMatch(prompts[1] || "", /<system>/);
  assert.doesNotMatch(prompts[1] || "", /^one$/m);
  assert.doesNotMatch(prompts[1] || "", /^ok$/m);
});

function lastOpenAiSseToolCalls(sse: string): Array<{ id: string; function: { name: string; arguments: string } }> {
  for (const line of sse.split("\n").reverse()) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    try {
      const json = JSON.parse(line.slice(6));
      const tc = json?.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(tc) && tc.length) return tc;
    } catch {
      /* skip malformed */
    }
  }
  throw new Error(`no tool_calls in SSE: ${sse.slice(0, 400)}`);
}

async function consumeSse(
  body: ReadableStream<Uint8Array> | null,
  afterRole: () => void,
  until: (buf: string) => boolean,
): Promise<string> {
  if (!body) throw new Error("missing body");
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let kicked = false;
  while (true) {
    if (!kicked && buf.includes('"role":"assistant"')) {
      kicked = true;
      afterRole();
    }
    if (until(buf)) return buf;
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    if (done) {
      if (!kicked) afterRole();
      return buf;
    }
  }
}

test("OpenAI stream=true forwards AgentService thinking and text deltas", async () => {
  let onDelta: ((chunk: { text?: string; thinking?: string }) => void) | undefined;
  let finish!: (result: { text: string; thinking: string }) => void;
  const finished = new Promise<{ text: string; thinking: string }>((resolve) => {
    finish = resolve;
  });
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-sse",
        async send(_prompt, opts) {
          onDelta = opts?.onDelta;
          return { wait: () => finished };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: {
      model: "composer-2.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
    tools: [],
  });
  assert.equal(res.status, 200);
  const sse = await consumeSse(
    res.body,
    () => {
      assert.ok(onDelta, "send() should pass onDelta");
      onDelta!({ thinking: "hmm" });
      onDelta!({ text: "hel" });
      onDelta!({ text: "lo" });
      finish({ text: "hello", thinking: "hmm" });
    },
    (buf) => buf.includes("data: [DONE]"),
  );
  assert.match(sse, /"reasoning_content":"hmm"/);
  assert.match(sse, /"content":"hel"/);
  assert.match(sse, /"content":"lo"/);
  assert.equal(sse.includes('"content":"hello"'), false);
  assert.match(sse, /"finish_reason":"stop"/);
});

test("OpenAI stream=true returns SSE before AgentService open", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish!: (result: { text: string }) => void;
  const finished = new Promise<{ text: string }>((resolve) => {
    finish = resolve;
  });
  setCustomToolAgentHostForTests({
    async create() {
      await gate;
      return {
        agentId: "agent-late",
        async send() {
          return {
            wait: () => finished,
            abort() {
              finish({ text: "" });
            },
          };
        },
        async close() {},
      };
    },
  });
  const res = await Promise.race([
    handleCustomToolChatCompletions({
      headers: new Headers({ authorization: "Bearer crsr_test" }),
      body: {
        model: "composer-2.5",
        stream: true,
        messages: [{ role: "user", content: "sse-headers-before-open" }],
      },
      tools: [],
    }),
    new Promise<Response>((_, reject) => {
      setTimeout(() => reject(new Error("SSE headers waited for AgentService open")), 80);
    }),
  ]);
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get("content-type") || ""), /text\/event-stream/);
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /:\s*connected/);
  release();
  await reader.cancel();
});

test("Anthropic stream=true forwards thinking then text deltas", async () => {
  let onDelta: ((chunk: { text?: string; thinking?: string }) => void) | undefined;
  let finish!: (result: { text: string; thinking: string }) => void;
  const finished = new Promise<{ text: string; thinking: string }>((resolve) => {
    finish = resolve;
  });
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-asyn",
        async send(_prompt, opts) {
          onDelta = opts?.onDelta;
          return { wait: () => finished };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolMessages({
    headers: new Headers({ "x-api-key": "crsr_test" }),
    body: {
      model: "grok-4.6-fast",
      stream: true,
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    },
    tools: [],
    requestId: "req_sse",
  });
  assert.equal(res.status, 200);
  const sse = await consumeSse(
    res.body,
    () => {
      assert.ok(onDelta);
      onDelta!({ thinking: "plan" });
      onDelta!({ text: "ok" });
      finish({ text: "ok", thinking: "plan" });
    },
    (buf) => buf.includes("message_stop"),
  );
  assert.match(sse, /thinking_delta/);
  assert.match(sse, /"thinking":"plan"/);
  assert.match(sse, /signature_delta/);
  assert.match(sse, /text_delta/);
  assert.match(sse, /"text":"ok"/);
});

test("role:tool opens a new send; tool_calls closes the previous AgentService run", async () => {
  const prompts: string[] = [];
  const sendOpts: Array<CustomToolSendOpts | undefined> = [];
  let aborts = 0;
  let releases = 0;
  setCustomToolAgentHostForTests({
    async create({ customTools }) {
      return {
        agentId: "agent-scoped",
        async send(prompt, opts) {
          prompts.push(prompt);
          sendOpts.push(opts);
          const wait = (async () => {
            if (String(prompt).includes("The client executed your custom tools")) return { text: "22c" };
            const tool = Object.values(customTools)[0];
            if (!tool) return { text: "no-tools" };
            await tool.execute({}, {});
            return { text: "should-not-reach-client" };
          })();
          return {
            wait: () => wait,
            abort: () => {
              aborts += 1;
            },
            release: () => {
              releases += 1;
            },
          };
        },
        async close() {},
      };
    },
  });
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [{ role: "user", content: "weather?" }] },
    tools,
  });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  const tc = body.choices[0].message.tool_calls;
  assert.equal(releases, 1);
  assert.equal(aborts, 0);
  const second = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: tc },
        { role: "tool", tool_call_id: tc[0].id, content: '{"temp":22}' },
      ],
    },
    tools,
  });
  assert.equal(second.status, 200);
  const body2 = await second.json();
  assert.equal(body2.choices[0].message.content, "22c");
  assert.equal(prompts.length, 2);
  assert.equal(sendOpts[1]?.resume, false);
  assert.match(prompts[1], /The client executed your custom tools/);
  assert.match(prompts[1], /22/);
  assert.match(decodeRootPromptText(sendOpts[1]!.conversationState!, sendOpts[1]!.blobs!), /weather\?/);
  assert.doesNotMatch(decodeRootPromptText(sendOpts[1]!.conversationState!, sendOpts[1]!.blobs!), /"temp":22/);
  assert.equal(aborts, 0);
});

test("three sequential catalog tools: get_weather then lookup then search then text", async () => {
  const prompts: string[] = [];
  const sendOpts: Array<CustomToolSendOpts | undefined> = [];
  let sends = 0;
  let aborts = 0;
  let releases = 0;
  const kv = createMemoryKv();
  setCustomToolAgentHostForTests({
    async create({ customTools }) {
      return {
        agentId: "agent-multi",
        async send(prompt, opts) {
          const round = sends++;
          prompts.push(prompt);
          sendOpts.push(opts);
          const wait = (async () => {
            if (round >= 3) return { text: "all three tools done" };
            const names = ["get_weather", "lookup", "search"];
            const tool = customTools[names[round]!] || Object.values(customTools)[0];
            if (!tool) return { text: "no-tools" };
            await tool.execute({ round }, {});
            return { text: "should-not-reach-client" };
          })();
          return {
            wait: () => wait,
            abort: () => {
              aborts += 1;
            },
            release: () => {
              releases += 1;
            },
          };
        },
        async close() {},
      };
    },
  });
  const catalog = [
    { type: "function" as const, function: { name: "get_weather" } },
    { type: "function" as const, function: { name: "lookup" } },
    { type: "function" as const, function: { name: "search" } },
  ];
  const tools = openaiToolsToCustom(catalog);
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const user = { role: "user", content: "tokyo weather, humidity, then a headline" };

  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [user], tools: catalog },
    tools,
    kv,
  });
  assert.equal(first.status, 200);
  const body1 = await first.json();
  assert.equal(body1.choices[0].finish_reason, "tool_calls");
  const tc1 = body1.choices[0].message.tool_calls;
  assert.equal(tc1[0].function.name, "get_weather");
  assert.equal(releases, 1);
  assert.equal(aborts, 0);
  assert.equal(sendOpts[0]?.resume, false);
  assert.equal(prompts[0], "tokyo weather, humidity, then a headline");

  const second = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      tools: catalog,
      messages: [
        user,
        { role: "assistant", content: null, tool_calls: tc1 },
        { role: "tool", tool_call_id: tc1[0].id, content: '{"temp":22}' },
      ],
    },
    tools,
    kv,
  });
  assert.equal(second.status, 200);
  const body2 = await second.json();
  assert.equal(body2.choices[0].finish_reason, "tool_calls");
  const tc2 = body2.choices[0].message.tool_calls;
  assert.equal(tc2[0].function.name, "lookup");
  assert.equal(releases, 2);
  assert.equal(body2.conversation_id, body1.conversation_id);
  assert.equal(sendOpts[1]?.resume, false);
  assert.match(prompts[1], /The client executed your custom tools/);
  assert.match(prompts[1], /22/);
  const roots2 = decodeRootPromptText(sendOpts[1]!.conversationState!, sendOpts[1]!.blobs!);
  assert.match(roots2, /tokyo weather, humidity, then a headline/);
  assert.doesNotMatch(roots2, /"temp":22/);

  const third = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      tools: catalog,
      messages: [
        user,
        { role: "assistant", content: null, tool_calls: tc1 },
        { role: "tool", tool_call_id: tc1[0].id, content: '{"temp":22}' },
        { role: "assistant", content: null, tool_calls: tc2 },
        { role: "tool", tool_call_id: tc2[0].id, content: '{"humidity":40}' },
      ],
    },
    tools,
    kv,
  });
  assert.equal(third.status, 200);
  const body3 = await third.json();
  assert.equal(body3.choices[0].finish_reason, "tool_calls");
  const tc3 = body3.choices[0].message.tool_calls;
  assert.equal(tc3[0].function.name, "search");
  assert.equal(releases, 3);
  assert.equal(sendOpts[2]?.resume, false);
  assert.match(prompts[2], /40/);
  const roots3 = decodeRootPromptText(sendOpts[2]!.conversationState!, sendOpts[2]!.blobs!);
  assert.match(roots3, /temp/);
  assert.doesNotMatch(roots3, /"humidity":40/);

  const fourth = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      tools: catalog,
      messages: [
        user,
        { role: "assistant", content: null, tool_calls: tc1 },
        { role: "tool", tool_call_id: tc1[0].id, content: '{"temp":22}' },
        { role: "assistant", content: null, tool_calls: tc2 },
        { role: "tool", tool_call_id: tc2[0].id, content: '{"humidity":40}' },
        { role: "assistant", content: null, tool_calls: tc3 },
        { role: "tool", tool_call_id: tc3[0].id, content: '{"headline":"rain later"}' },
      ],
    },
    tools,
    kv,
  });
  assert.equal(fourth.status, 200);
  const body4 = await fourth.json();
  assert.equal(body4.choices[0].message.content, "all three tools done");
  assert.equal(body4.conversation_id, body1.conversation_id);
  assert.equal(prompts.length, 4);
  assert.equal(sendOpts[3]?.resume, false);
  assert.match(prompts[3], /rain later/);
  const roots4 = decodeRootPromptText(sendOpts[3]!.conversationState!, sendOpts[3]!.blobs!);
  assert.match(roots4, /humidity/);
  assert.match(roots4, /temp/);
  assert.doesNotMatch(roots4, /rain later/);
  assert.equal(aborts, 0);
});

test("stream=true two tool rounds emit complete tool_calls then final text", async () => {
  const prompts: string[] = [];
  let sends = 0;
  let releases = 0;
  setCustomToolAgentHostForTests({
    async create({ customTools }) {
      return {
        agentId: "agent-multi-sse",
        async send(prompt) {
          const round = sends++;
          prompts.push(prompt);
          const wait = (async () => {
            if (round >= 2) return { text: "done-sse" };
            const tool = Object.values(customTools)[0];
            if (!tool) return { text: "no-tools" };
            await tool.execute({ round }, {});
            return { text: "should-not-reach-client" };
          })();
          return {
            wait: () => wait,
            abort: () => {},
            release: () => {
              releases += 1;
            },
          };
        },
        async close() {},
      };
    },
  });
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const user = { role: "user", content: "weather?" };

  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", stream: true, messages: [user] },
    tools,
  });
  assert.equal(first.status, 200);
  const sse1 = await consumeSse(first.body, () => {}, (buf) => buf.includes("data: [DONE]"));
  assert.match(sse1, /"finish_reason":"tool_calls"/);
  const tc1 = lastOpenAiSseToolCalls(sse1);
  assert.equal(releases, 1);

  const second = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      stream: true,
      messages: [
        user,
        { role: "assistant", content: null, tool_calls: tc1 },
        { role: "tool", tool_call_id: tc1[0].id, content: '{"temp":22}' },
      ],
    },
    tools,
  });
  const sse2 = await consumeSse(second.body, () => {}, (buf) => buf.includes("data: [DONE]"));
  assert.match(sse2, /"finish_reason":"tool_calls"/);
  const tc2 = lastOpenAiSseToolCalls(sse2);
  assert.equal(releases, 2);
  assert.match(prompts[1], /The client executed your custom tools/);
  assert.match(prompts[1], /22/);
  assert.doesNotMatch(prompts[1] || "", /weather\?/);

  const third = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      stream: true,
      messages: [
        user,
        { role: "assistant", content: null, tool_calls: tc1 },
        { role: "tool", tool_call_id: tc1[0].id, content: '{"temp":22}' },
        { role: "assistant", content: null, tool_calls: tc2 },
        { role: "tool", tool_call_id: tc2[0].id, content: '{"humidity":40}' },
      ],
    },
    tools,
  });
  const sse3 = await consumeSse(third.body, () => {}, (buf) => buf.includes("data: [DONE]"));
  assert.match(sse3, /done-sse/);
  assert.match(sse3, /"finish_reason":"stop"/);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2], /The client executed your custom tools/);
  assert.match(prompts[2], /40/);
});

test("Anthropic two tool_use rounds then end_turn", async () => {
  const prompts: string[] = [];
  let sends = 0;
  let releases = 0;
  setCustomToolAgentHostForTests({
    async create({ customTools }) {
      return {
        agentId: "agent-multi-anth",
        async send(prompt) {
          const round = sends++;
          prompts.push(prompt);
          const wait = (async () => {
            if (round >= 2) return { text: "40 percent" };
            const tool = Object.values(customTools)[0];
            if (!tool) return { text: "no-tools" };
            await tool.execute({ round }, {});
            return { text: "should-not-reach-client" };
          })();
          return {
            wait: () => wait,
            abort: () => {},
            release: () => {
              releases += 1;
            },
          };
        },
        async close() {},
      };
    },
  });
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const headers = new Headers({ "x-api-key": "crsr_test" });
  const user = { role: "user", content: "weather?" };

  const first = await handleCustomToolMessages({
    headers,
    body: { model: "composer-2.5", messages: [user], max_tokens: 64 },
    tools,
    requestId: "req_multi_1",
  });
  assert.equal(first.status, 200);
  const body1 = await first.json();
  assert.equal(body1.stop_reason, "tool_use");
  const use1 = body1.content.find((b: { type?: string }) => b.type === "tool_use");
  assert.ok(use1);

  const second = await handleCustomToolMessages({
    headers,
    body: {
      model: "composer-2.5",
      max_tokens: 64,
      messages: [
        user,
        { role: "assistant", content: [use1] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use1.id, content: '{"temp":22}' }] },
      ],
    },
    tools,
    requestId: "req_multi_2",
  });
  const body2 = await second.json();
  assert.equal(body2.stop_reason, "tool_use");
  const use2 = body2.content.find((b: { type?: string }) => b.type === "tool_use");
  assert.ok(use2);
  assert.equal(releases, 2);
  assert.equal(body2.conversation_id, body1.conversation_id);
  assert.match(prompts[1], /The client executed your custom tools/);
  assert.match(prompts[1], /22/);
  assert.doesNotMatch(prompts[1] || "", /weather\?/);

  const third = await handleCustomToolMessages({
    headers,
    body: {
      model: "composer-2.5",
      max_tokens: 64,
      messages: [
        user,
        { role: "assistant", content: [use1] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use1.id, content: '{"temp":22}' }] },
        { role: "assistant", content: [use2] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use2.id, content: '{"humidity":40}' }] },
      ],
    },
    tools,
    requestId: "req_multi_3",
  });
  const body3 = await third.json();
  assert.equal(body3.stop_reason, "end_turn");
  assert.equal(body3.content.find((b: { type?: string; text?: string }) => b.type === "text")?.text, "40 percent");
  assert.match(prompts[2], /The client executed your custom tools/);
  assert.match(prompts[2], /40/);
});

class ChatInteractiveDuplex implements AgentDuplex {
  sent: JsonObject[] = [];
  private readonly pending: Array<JsonObject | null> = [];
  private waiters: Array<(value: JsonObject | null) => void> = [];
  onSend?: (message: JsonObject) => void;

  push(message: JsonObject | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.pending.push(message);
  }

  async send(message: JsonObject): Promise<void> {
    this.sent.push(message);
    this.onSend?.(message);
  }

  next(): Promise<JsonObject | null> {
    if (this.pending.length) return Promise.resolve(this.pending.shift() ?? null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.push(null);
  }
}

function duplexRunRequest(duplex: ChatInteractiveDuplex): JsonObject | undefined {
  const runMsg = duplex.sent.find((m) => field(m, "runRequest"));
  return asObject(field(runMsg, "runRequest"));
}

function duplexUserText(duplex: ChatInteractiveDuplex): string {
  const run = duplexRunRequest(duplex);
  const user = asObject(field(asObject(field(asObject(field(run, "action")), "userMessageAction")), "userMessage"));
  return String(user?.text || "");
}

function duplexIsResume(duplex: ChatInteractiveDuplex): boolean {
  const run = duplexRunRequest(duplex);
  return Boolean(field(asObject(field(run, "action")), "resumeAction"));
}

function duplexSentCancel(duplex: ChatInteractiveDuplex): boolean {
  return duplex.sent.some((m) => field(m, "conversationAction", "conversation_action"));
}

function duplexSentMcpResult(duplex: ChatInteractiveDuplex): boolean {
  return duplex.sent.some((m) => field(asObject(field(m, "execClientMessage")), "mcpResult", "mcp_result"));
}

function duplexMcpToolNames(duplex: ChatInteractiveDuplex): string[] {
  return ((duplexRunRequest(duplex)?.mcpTools as { mcpTools?: Array<{ toolName: string }> })?.mcpTools || []).map(
    (t) => t.toolName,
  );
}

function duplexRequestContextToolNames(duplex: ChatInteractiveDuplex): string[] {
  for (const message of duplex.sent) {
    const exec = asObject(field(message, "execClientMessage"));
    const result = asObject(field(exec, "requestContextResult"));
    const success = asObject(field(result, "success"));
    const context = asObject(field(success, "requestContext"));
    const tools = context?.tools as Array<{ toolName?: string }> | undefined;
    if (Array.isArray(tools) && tools.length) return tools.map((t) => String(t.toolName || ""));
  }
  return [];
}

function duplexMcpStateToolNames(duplex: ChatInteractiveDuplex): string[] {
  for (const message of duplex.sent) {
    const exec = asObject(field(message, "execClientMessage"));
    const result = asObject(field(exec, "mcpStateExecResult"));
    const success = asObject(field(result, "success"));
    const servers = success?.servers as Array<{ tools?: Array<{ toolName?: string }> }> | undefined;
    const tools = (servers || []).flatMap((s) => s.tools || []);
    if (tools.length) return tools.map((t) => String(t.toolName || ""));
  }
  return [];
}

function attachCatalogDiscovery(duplex: ChatInteractiveDuplex, onReady: () => void): void {
  duplex.onSend = (message) => {
    if (field(message, "runRequest")) {
      duplex.push({ execServerMessage: { id: 1, execId: "ctx", requestContextArgs: {} } });
      return;
    }
    const exec = asObject(field(message, "execClientMessage"));
    if (field(exec, "requestContextResult")) {
      duplex.push({ execServerMessage: { id: 2, execId: "mcp-state", mcpStateExecArgs: {} } });
      return;
    }
    if (field(exec, "mcpStateExecResult")) {
      onReady();
    }
  };
}

test("in-repo host: three sequential MCP parks then text; resume splices conversationState", async () => {
  const names = ["get_weather", "lookup", "search"];
  const duplexes: ChatInteractiveDuplex[] = [];
  const openRun: OpenAgentRun = async () => {
    const duplex = new ChatInteractiveDuplex();
    const i = duplexes.length;
    duplexes.push(duplex);
    duplex.onSend = (message) => {
      if (!field(message, "runRequest")) return;
      if (i < 3) {
        duplex.push({
          execServerMessage: {
            id: i + 1,
            execId: `mcp-${i}`,
            mcpArgs: {
              name: `custom-user-tools-${names[i]}`,
              providerIdentifier: "custom-user-tools",
              toolName: names[i],
              toolCallId: `call_${i}`,
              args: { round: { stringValue: String(i) } },
            },
          },
        });
        return;
      }
      duplex.push({ interactionUpdate: { textDelta: { text: "all done" } } });
      duplex.push({ interactionUpdate: { turnEnded: {} } });
    };
    return duplex;
  };
  setCustomToolAgentHostForTests(
    createSdkAgentHost({
      openRun,
      exchange: async () => ({ accessToken: "tok", refreshToken: null }),
    }),
  );
  const openaiTools = names.map((name) => ({ type: "function" as const, function: { name } }));
  const tools = openaiToolsToCustom(openaiTools);
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const kv = createMemoryKv();
  const user = { role: "user", content: "tokyo weather, humidity, then a headline" };

  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [user] },
    tools,
    kv,
  });
  const body1 = await first.json();
  assert.equal(body1.choices[0].finish_reason, "tool_calls");
  const tc1 = body1.choices[0].message.tool_calls;
  assert.equal(tc1[0].function.name, "get_weather");
  assert.equal(duplexes.length, 1);
  assert.equal(duplexSentCancel(duplexes[0]!), false);
  assert.equal(duplexSentMcpResult(duplexes[0]!), false);
  assert.equal(duplexIsResume(duplexes[0]!), false);
  assert.equal(duplexUserText(duplexes[0]!), "tokyo weather, humidity, then a headline");
  const mcp1 = ((duplexRunRequest(duplexes[0]!)?.mcpTools as { mcpTools?: Array<{ toolName: string }> })?.mcpTools || []).map((t) => t.toolName);
  assert.deepEqual(mcp1, names);

  const secondMessages = [
    user,
    { role: "assistant", content: null, tool_calls: tc1 },
    { role: "tool", tool_call_id: tc1[0].id, content: '{"temp":22}' },
  ];
  const second = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: secondMessages },
    tools,
    kv,
  });
  const body2 = await second.json();
  assert.equal(body2.choices[0].finish_reason, "tool_calls");
  const tc2 = body2.choices[0].message.tool_calls;
  assert.equal(tc2[0].function.name, "lookup");
  assert.equal(duplexes.length, 2);
  assert.equal(duplexSentCancel(duplexes[1]!), false);
  assert.equal(duplexIsResume(duplexes[1]!), false);
  assert.match(duplexUserText(duplexes[1]!), /The client executed your custom tools/);
  assert.match(duplexUserText(duplexes[1]!), /22/);
  const spliced2 = await spliceConversationFromClient({ body: { messages: secondMessages }, tools, messages: secondMessages });
  assert.deepEqual(
    duplexRunRequest(duplexes[1]!)?.conversationState,
    spliced2.conversationState,
  );
  const roots2 = decodeRootPromptText(spliced2.conversationState, spliced2.blobs);
  assert.match(roots2, /tokyo weather, humidity, then a headline/);
  assert.doesNotMatch(roots2, /"temp":22/);
  assert.equal(body2.conversation_id, body1.conversation_id);

  const thirdMessages = [
    ...secondMessages,
    { role: "assistant", content: null, tool_calls: tc2 },
    { role: "tool", tool_call_id: tc2[0].id, content: '{"humidity":40}' },
  ];
  const third = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: thirdMessages },
    tools,
    kv,
  });
  const body3 = await third.json();
  assert.equal(body3.choices[0].finish_reason, "tool_calls");
  const tc3 = body3.choices[0].message.tool_calls;
  assert.equal(tc3[0].function.name, "search");
  assert.equal(duplexIsResume(duplexes[2]!), false);
  assert.match(duplexUserText(duplexes[2]!), /40/);

  const fourthMessages = [
    ...thirdMessages,
    { role: "assistant", content: null, tool_calls: tc3 },
    { role: "tool", tool_call_id: tc3[0].id, content: '{"headline":"rain later"}' },
  ];
  const fourth = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: fourthMessages },
    tools,
    kv,
  });
  const body4 = await fourth.json();
  assert.equal(body4.choices[0].message.content, "all done");
  assert.equal(duplexes.length, 4);
  assert.equal(duplexIsResume(duplexes[3]!), false);
  assert.match(duplexUserText(duplexes[3]!), /rain later/);
  const spliced4 = await spliceConversationFromClient({ body: { messages: fourthMessages }, tools, messages: fourthMessages });
  assert.deepEqual(duplexRunRequest(duplexes[3]!)?.conversationState, spliced4.conversationState);
  assert.doesNotMatch(decodeRootPromptText(spliced4.conversationState, spliced4.blobs), /rain later/);
  assert.match(decodeRootPromptText(spliced4.conversationState, spliced4.blobs), /humidity/);
  assert.equal(duplexSentCancel(duplexes[3]!), false);
});

test("reused handle still offers Write/Edit/Bash on the next Run", async () => {
  const duplexes: ChatInteractiveDuplex[] = [];
  const openRun: OpenAgentRun = async () => {
    const duplex = new ChatInteractiveDuplex();
    duplexes.push(duplex);
    attachCatalogDiscovery(duplex, () => {
      duplex.push({ interactionUpdate: { textDelta: { text: "ok" } } });
      duplex.push({ interactionUpdate: { turnEnded: {} } });
    });
    return duplex;
  };
  setCustomToolAgentHostForTests(
    createSdkAgentHost({
      openRun,
      exchange: async () => ({ accessToken: "tok", refreshToken: null }),
    }),
  );
  const catalog = [
    { type: "custom" as const, name: "Write", description: "write a file" },
    { type: "function" as const, function: { name: "Edit" } },
    { type: "function" as const, function: { name: "Bash" } },
  ];
  const tools = openaiToolsToCustom(catalog);
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const kv = createMemoryKv();
  const harness = `You are Cursor Grok 4.6. Native tools: Read, Write, Edit, Bash.\n${"x".repeat(4000)}`;
  const system = { role: "system", content: harness };
  const user = { role: "user", content: "edit the file" };

  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [system, user], tools: catalog },
    tools,
    kv,
  });
  assert.equal(first.status, 200);
  const body1 = await first.json();
  assert.deepEqual(duplexMcpToolNames(duplexes[0]!), ["Write", "Edit", "Bash"]);
  assert.deepEqual(duplexRequestContextToolNames(duplexes[0]!), ["Write", "Edit", "Bash"]);
  assert.deepEqual(duplexMcpStateToolNames(duplexes[0]!), ["Write", "Edit", "Bash"]);

  const turn2 = [system, user, { role: "assistant", content: "ok" }, { role: "user", content: "again" }];
  const second = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", tools: catalog, messages: turn2 },
    tools,
    kv,
  });
  assert.equal(second.status, 200);
  const body2 = await second.json();
  assert.equal(body2.conversation_id, body1.conversation_id);
  assert.equal(duplexes.length, 2);
  assert.deepEqual(duplexMcpToolNames(duplexes[1]!), ["Write", "Edit", "Bash"]);
  assert.deepEqual(duplexRequestContextToolNames(duplexes[1]!), ["Write", "Edit", "Bash"]);
  assert.deepEqual(duplexMcpStateToolNames(duplexes[1]!), ["Write", "Edit", "Bash"]);
  const spliced = await spliceConversationFromClient({ body: { messages: turn2, tools: catalog }, tools, messages: turn2 });
  const ids = spliced.conversationState.rootPromptMessagesJson as string[];
  const policyRoot = utf8FromBlobData(spliced.blobs.get(String(ids[0]))!);
  const systemRoot = utf8FromBlobData(spliced.blobs.get(String(ids[1]))!);
  assert.match(policyRoot, /Tools: Write, Edit, Bash/);
  assert.doesNotMatch(policyRoot, /MCP|custom-user-tools|unavailable|tool list changed|Native /i);
  assert.doesNotMatch(policyRoot, /You are Cursor Grok/);
  assert.match(systemRoot, /You are Cursor Grok/);
  assert.doesNotMatch(systemRoot, /\bTools:/);
});

test("Write park then a later user turn still offers Write and keeps the call in roots", async () => {
  const duplexes: ChatInteractiveDuplex[] = [];
  const openRun: OpenAgentRun = async () => {
    const duplex = new ChatInteractiveDuplex();
    const i = duplexes.length;
    duplexes.push(duplex);
    attachCatalogDiscovery(duplex, () => {
      if (i === 0) {
        duplex.push({
          execServerMessage: {
            id: 3,
            execId: "mcp-write",
            mcpArgs: {
              name: "custom-user-tools-Write",
              providerIdentifier: "custom-user-tools",
              toolName: "Write",
              toolCallId: "call_w",
              args: { path: { stringValue: "a.ts" } },
            },
          },
        });
        return;
      }
      duplex.push({ interactionUpdate: { textDelta: { text: i === 1 ? "wrote it" : "editing again" } } });
      duplex.push({ interactionUpdate: { turnEnded: {} } });
    });
    return duplex;
  };
  setCustomToolAgentHostForTests(
    createSdkAgentHost({
      openRun,
      exchange: async () => ({ accessToken: "tok", refreshToken: null }),
    }),
  );
  const catalog = [
    { type: "custom" as const, name: "Write", description: "write a file" },
    { type: "function" as const, function: { name: "Edit" } },
    { type: "function" as const, function: { name: "Bash" } },
  ];
  const tools = openaiToolsToCustom(catalog);
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const kv = createMemoryKv();
  const harness = `You are Cursor Grok 4.6. Native tools: Read, Write, Edit, Bash.\n${"x".repeat(4000)}`;
  const system = { role: "system", content: harness };
  const user = { role: "user", content: "write a.ts" };

  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [system, user], tools: catalog },
    tools,
    kv,
  });
  const body1 = await first.json();
  assert.equal(body1.choices[0].finish_reason, "tool_calls");
  const tc = body1.choices[0].message.tool_calls;
  assert.equal(tc[0].function.name, "Write");
  assert.deepEqual(duplexMcpToolNames(duplexes[0]!), ["Write", "Edit", "Bash"]);

  const afterWrite = [
    system,
    user,
    { role: "assistant", content: null, tool_calls: tc },
    { role: "tool", tool_call_id: tc[0].id, content: "wrote a.ts" },
  ];
  const second = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", tools: catalog, messages: afterWrite },
    tools,
    kv,
  });
  const body2 = await second.json();
  assert.equal(body2.conversation_id, body1.conversation_id);
  assert.equal(body2.choices[0].message.content, "wrote it");

  const later = [...afterWrite, { role: "assistant", content: "wrote it" }, { role: "user", content: "edit again" }];
  const third = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", tools: catalog, messages: later },
    tools,
    kv,
  });
  const body3 = await third.json();
  assert.equal(third.status, 200);
  assert.equal(body3.conversation_id, body1.conversation_id);
  assert.equal(duplexes.length, 3);
  assert.deepEqual(duplexMcpToolNames(duplexes[2]!), ["Write", "Edit", "Bash"]);
  assert.deepEqual(duplexRequestContextToolNames(duplexes[2]!), ["Write", "Edit", "Bash"]);
  assert.deepEqual(duplexMcpStateToolNames(duplexes[2]!), ["Write", "Edit", "Bash"]);
  const spliced = await spliceConversationFromClient({ body: { messages: later, tools: catalog }, tools, messages: later });
  const ids = spliced.conversationState.rootPromptMessagesJson as string[];
  const policyRoot = utf8FromBlobData(spliced.blobs.get(String(ids[0]))!);
  const systemRoot = utf8FromBlobData(spliced.blobs.get(String(ids[1]))!);
  assert.match(policyRoot, /Tools: Write, Edit, Bash/);
  assert.doesNotMatch(policyRoot, /MCP|custom-user-tools|unavailable|tool list changed|Native /i);
  assert.doesNotMatch(policyRoot, /You are Cursor Grok/);
  assert.match(systemRoot, /You are Cursor Grok/);
  assert.doesNotMatch(systemRoot, /\bTools:/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /Already invoked client tool Write/);
  assert.doesNotMatch(roots, /\[Tool Call\]|\[tool_call\]/);
  assert.match(roots, /wrote a\.ts/);
  assert.doesNotMatch(roots, /edit again/);
});

test("dropping Write from the offered catalog starts a new AgentService conversation", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-tools-fp",
        async send() {
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const writeCatalog = [{ type: "custom" as const, name: "Write" }, { type: "function" as const, function: { name: "lookup" } }];
  const lookupOnly = [{ type: "function" as const, function: { name: "lookup" } }];
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const kv = createMemoryKv();
  const user = { role: "user", content: "hi" };
  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [user], tools: writeCatalog },
    tools: openaiToolsToCustom(writeCatalog),
    kv,
  });
  const second = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [user, { role: "assistant", content: "ok" }, { role: "user", content: "next" }], tools: lookupOnly },
    tools: openaiToolsToCustom(lookupOnly),
    kv,
  });
  const body1 = await first.json();
  const body2 = await second.json();
  assert.notEqual(body2.conversation_id, body1.conversation_id);
});

test("OpenAI JSON maps AgentService resource_exhausted to HTTP 429", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-err",
        async send() {
          return { wait: async () => ({ text: "", error: "resource_exhausted: Error" }) };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] },
    tools: [],
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  const body = await res.json();
  assert.equal(body.error?.message, "resource_exhausted: Error");
  assert.equal(body.error?.type, "rate_limit_error");
  assert.equal(body.error?.code, "resource_exhausted");
  assert.equal("choices" in body, false);
});

test("OpenAI stream=true emits only a structured AgentService error", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-err-sse",
        async send() {
          return { wait: async () => ({ text: "", error: "resource_exhausted: Error" }) };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: {
      model: "composer-2.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
    tools: [],
  });
  assert.equal(res.status, 200);
  const sse = await new Response(res.body).text();
  assert.match(sse, /"error":\{"message":"resource_exhausted: Error","type":"rate_limit_error","code":"resource_exhausted"\}/);
  assert.doesNotMatch(sse, /"content":"resource_exhausted: Error"/);
  assert.doesNotMatch(sse, /"finish_reason":"stop"/);
  assert.doesNotMatch(sse, /data: \[DONE\]/);
});

test("Anthropic JSON maps AgentService authentication errors to HTTP 401", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-aerr",
        async send() {
          return { wait: async () => ({ text: "", error: "ERROR_NOT_LOGGED_IN: not logged in" }) };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolMessages({
    headers: new Headers({ "x-api-key": "crsr_test" }),
    body: { model: "composer-2.5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    tools: [],
    requestId: "req_err",
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.type, "error");
  assert.equal(body.error?.type, "authentication_error");
  assert.equal(body.error?.message, "ERROR_NOT_LOGGED_IN: not logged in");
});

test("Anthropic stream=true emits a structured AgentService error without visible text", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-aerr-sse",
        async send() {
          return { wait: async () => ({ text: "", error: "rate limited" }) };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolMessages({
    headers: new Headers({ "x-api-key": "crsr_test" }),
    body: {
      model: "composer-2.5",
      stream: true,
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    },
    tools: [],
    requestId: "req_err_sse",
  });
  assert.equal(res.status, 200);
  const sse = await new Response(res.body).text();
  assert.match(sse, /event: error/);
  assert.match(sse, /rate_limit_error/);
  assert.match(sse, /rate limited/);
  assert.doesNotMatch(sse, /text_delta/);
  assert.doesNotMatch(sse, /message_stop/);
});

test("client abort calls AgentService abort while the turn is in flight", async () => {
  let aborts = 0;
  let finishWait: (value: { text: string }) => void = () => {};
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-abort",
        async send(_prompt, opts) {
          const wait = new Promise<{ text: string }>((resolve) => {
            finishWait = resolve;
          });
          const abort = () => {
            aborts += 1;
            finishWait({ text: "" });
          };
          opts?.signal?.addEventListener("abort", abort, { once: true });
          return { wait: () => wait, abort };
        },
        async close() {},
      };
    },
  });
  const client = new AbortController();
  const pending = handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: { model: "composer-2.5", messages: [{ role: "user", content: "hi" }] },
    tools: [],
    signal: client.signal,
  });
  await new Promise((r) => setTimeout(r, 20));
  client.abort();
  const res = await pending;
  assert.equal(res.status, 200);
  assert.ok(aborts >= 1, `expected AgentService abort, got ${aborts}`);
});

test("SSE cancel aborts the in-flight AgentService run", async () => {
  let aborts = 0;
  let finishWait: (value: { text: string }) => void = () => {};
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-sse-abort",
        async send() {
          const wait = new Promise<{ text: string }>((resolve) => {
            finishWait = resolve;
          });
          return {
            wait: () => wait,
            abort: () => {
              aborts += 1;
              finishWait({ text: "" });
            },
          };
        },
        async close() {},
      };
    },
  });
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "sse-cancel" }] },
    tools: [],
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!buf.includes('"role":"assistant"')) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) buf += dec.decode(value, { stream: true });
  }
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(aborts >= 1, `expected SSE cancel to abort AgentService, got ${aborts}`);
});

test("three user sentences stay one session: list tools, call, recall first sentence", async () => {
  const first = "你的工具有什么";
  const second = "调用一下";
  const third = "我的第一句话是什么";
  const catalog = [
    { type: "function" as const, function: { name: "get_weather", description: "Current weather" } },
    { type: "function" as const, function: { name: "lookup", description: "Look up a fact" } },
  ];
  const tools = openaiToolsToCustom(catalog);
  const prompts: string[] = [];
  const sendOpts: Array<CustomToolSendOpts | undefined> = [];
  let sends = 0;
  const kv = createMemoryKv();
  setCustomToolAgentHostForTests({
    async create({ customTools }) {
      return {
        agentId: "agent-three-ask",
        async send(prompt, opts) {
          const round = sends++;
          prompts.push(prompt);
          sendOpts.push(opts);
          const wait = (async () => {
            if (round === 0) return { text: "我有 get_weather 和 lookup。" };
            if (round === 1) {
              const tool = customTools.get_weather || Object.values(customTools)[0];
              if (!tool) return { text: "no-tools" };
              await tool.execute({ city: "Tokyo" }, {});
              return { text: "should-not-reach" };
            }
            if (round === 2) return { text: "东京 22 度。" };
            return { text: `你的第一句话是「${first}」。` };
          })();
          return { wait: () => wait, abort() {}, release() {} };
        },
        async close() {},
      };
    },
  });
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const system = { role: "system", content: "be brief" };

  const r1 = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [system, { role: "user", content: first }], tools: catalog },
    tools,
    kv,
  });
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.error, undefined);
  assert.match(String(b1.choices[0].message.content || ""), /get_weather/);
  assert.equal(prompts[0], first);
  assert.equal(sendOpts[0]?.resume, false);
  assert.ok(sendOpts[0]?.conversationState);

  const r2 = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      tools: catalog,
      messages: [
        system,
        { role: "user", content: first },
        { role: "assistant", content: b1.choices[0].message.content },
        { role: "user", content: second },
      ],
    },
    tools,
    kv,
  });
  assert.equal(r2.status, 200);
  const b2 = await r2.json();
  assert.equal(b2.error, undefined);
  assert.equal(b2.conversation_id, b1.conversation_id);
  assert.equal(b2.choices[0].finish_reason, "tool_calls");
  const tc = b2.choices[0].message.tool_calls;
  assert.equal(tc[0].function.name, "get_weather");
  assert.equal(prompts[1], second);
  assert.ok(sendOpts[1]?.conversationState, "follow-up user must send conversationState (upstream requires it)");
  assert.match(decodeRootPromptText(sendOpts[1]!.conversationState!, sendOpts[1]!.blobs!), /你的工具有什么/);

  const afterTool = [
    system,
    { role: "user", content: first },
    { role: "assistant", content: b1.choices[0].message.content },
    { role: "user", content: second },
    { role: "assistant", content: null, tool_calls: tc },
    { role: "tool", tool_call_id: tc[0].id, content: '{"temp":22}' },
  ];
  const r2b = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", tools: catalog, messages: afterTool },
    tools,
    kv,
  });
  assert.equal(r2b.status, 200);
  const b2b = await r2b.json();
  assert.equal(b2b.error, undefined);
  assert.equal(b2b.conversation_id, b1.conversation_id);
  assert.equal(sendOpts[2]?.resume, false);
  assert.match(prompts[2], /The client executed your custom tools/);
  assert.match(decodeRootPromptText(sendOpts[2]!.conversationState!, sendOpts[2]!.blobs!), /你的工具有什么/);

  const r3 = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      tools: catalog,
      messages: [...afterTool, { role: "assistant", content: b2b.choices[0].message.content }, { role: "user", content: third }],
    },
    tools,
    kv,
  });
  assert.equal(r3.status, 200);
  const b3 = await r3.json();
  assert.equal(b3.error, undefined);
  assert.equal(b3.conversation_id, b1.conversation_id);
  assert.match(String(b3.choices[0].message.content || ""), /你的工具有什么/);
  assert.equal(prompts[3], third);
  assert.ok(sendOpts[3]?.conversationState, "third user turn must send conversationState");
  assert.match(decodeRootPromptText(sendOpts[3]!.conversationState!, sendOpts[3]!.blobs!), /你的工具有什么/);

  customToolChatClearForTests();
  sends = 0;
  const hopPrompts: string[] = [];
  const hopOpts: Array<CustomToolSendOpts | undefined> = [];
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-three-ask-hop",
        async send(prompt, opts) {
          hopPrompts.push(prompt);
          hopOpts.push(opts);
          return { wait: async () => ({ text: `你的第一句话是「${first}」。` }) };
        },
        async close() {},
      };
    },
  });
  const hop = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      tools: catalog,
      messages: [...afterTool, { role: "assistant", content: b2b.choices[0].message.content }, { role: "user", content: third }],
    },
    tools,
    kv,
  });
  assert.equal(hop.status, 200);
  const hopBody = await hop.json();
  assert.equal(hopBody.error, undefined);
  assert.equal(hopBody.conversation_id, b1.conversation_id);
  assert.equal(hopPrompts[0], third);
  assert.match(decodeRootPromptText(hopOpts[0]!.conversationState!, hopOpts[0]!.blobs!), /你的工具有什么/);
  assert.match(String(hopBody.choices[0].message.content || ""), /你的工具有什么/);
});

