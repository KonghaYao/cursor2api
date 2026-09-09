import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { customToolsClearForTests, openaiToolsToCustom } from "./custom_tools.ts";
import {
  agentImagesFromCursorParts,
  customToolChatClearForTests,
  handleCustomToolChatCompletions,
  handleCustomToolMessages,
  setCustomToolAgentHostForTests,
} from "./custom_tool_chat.ts";
import type { AgentInlineImage, JsonObject } from "./agent_json.ts";
import { asObject, field } from "./agent_json.ts";
import { createMemoryKv } from "./kv.ts";
import type { CustomToolAgentCreateOpts } from "./custom_tool_chat.ts";
import { createSdkAgentHost } from "./sdk_agent_host.ts";
import type { AgentDuplex, OpenAgentRun } from "./agent_run.ts";

afterEach(() => {
  customToolsClearForTests();
  customToolChatClearForTests();
  setCustomToolAgentHostForTests(undefined);
});

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function gwToolCallText(name: string, args: Record<string, unknown> = {}): string {
  return `<gw_tool_call>${JSON.stringify({ name, arguments: args })}</gw_tool_call>`;
}

function mdCatalogCall(name: string, args: Record<string, unknown> = {}): string {
  return ["```json", JSON.stringify({ name, arguments: args }), "```"].join("\n");
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const CATALOG_GET_WEATHER = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Current temperature in Celsius for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const CATALOG_LOOKUP = {
  type: "function" as const,
  function: {
    name: "lookup",
    description: "Look up a named fact. q is a slug such as tokyo_humidity.",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  },
};

type CatalogToolRound =
  | {
      kind: "tool";
      emit: string;
      expectName: string;
      expectArgs: Record<string, unknown>;
      result: string;
    }
  | { kind: "text"; emit: string; expect: RegExp };

/** Full-transcript OpenAI chat: defined catalog tools, then another tool, then text. */
async function runOpenAiCatalogScript(opts: {
  user: string;
  openaiTools: Array<typeof CATALOG_GET_WEATHER>;
  rounds: CatalogToolRound[];
}): Promise<{ prompts: string[]; conversationIds: string[]; created: number; aborts: number }> {
  const prompts: string[] = [];
  const conversationIds: string[] = [];
  let created = 0;
  let aborts = 0;
  let sends = 0;
  const kv = createMemoryKv();
  const catalog = openaiToolsToCustom(opts.openaiTools);
  setCustomToolAgentHostForTests({
    async create() {
      created += 1;
      return {
        agentId: `agent-catalog-${created}`,
        async send(prompt) {
          prompts.push(prompt);
          const i = sends++;
          const round = opts.rounds[i];
          if (!round) throw new Error(`unexpected send ${i}`);
          return {
            wait: async () => ({ text: round.emit }),
            abort: () => {
              aborts += 1;
            },
            release: () => {},
          };
        },
        async close() {},
      };
    },
  });
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: opts.user }];
  for (const round of opts.rounds) {
    const res = await handleCustomToolChatCompletions({
      headers,
      body: {
        model: "composer-2.5",
        tool_choice: "auto",
        messages,
        tools: opts.openaiTools,
      },
      tools: catalog,
      kv,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    conversationIds.push(String(body.conversation_id || ""));
    if (round.kind === "tool") {
      assert.equal(body.choices[0].finish_reason, "tool_calls");
      const tc = body.choices[0].message.tool_calls;
      assert.equal(tc.length, 1, JSON.stringify(tc));
      assert.equal(tc[0].function.name, round.expectName);
      assert.deepEqual(parseToolArgs(tc[0].function.arguments), round.expectArgs);
      const content = String(body.choices[0].message.content || "");
      assert.doesNotMatch(content, /<gw_tool_call>/);
      assert.doesNotMatch(content, /```/);
      messages.push({ role: "assistant", content: content || null, tool_calls: tc });
      messages.push({ role: "tool", tool_call_id: tc[0].id, content: round.result });
    } else {
      assert.notEqual(body.choices[0].finish_reason, "tool_calls");
      assert.match(String(body.choices[0].message.content || ""), round.expect);
    }
  }
  return { prompts, conversationIds, created, aborts };
}

function assertStableCatalogThread(opts: {
  prompts: string[];
  conversationIds: string[];
  created: number;
  aborts: number;
  firstUser: string;
  followUps: Array<{ has: RegExp; missing?: RegExp }>;
}): void {
  assert.equal(opts.created, 1);
  assert.equal(opts.aborts, 0);
  assert.ok(opts.conversationIds.length >= 2);
  assert.ok(opts.conversationIds.every((id) => id && id === opts.conversationIds[0]));
  assert.match(opts.prompts[0] || "", /<gw_tool_call>/);
  assert.ok((opts.prompts[0] || "").includes(opts.firstUser));
  assert.equal(opts.prompts.length, 1 + opts.followUps.length);
  for (let i = 0; i < opts.followUps.length; i++) {
    const p = opts.prompts[i + 1] || "";
    assert.match(p, /<gw_tool_results>/);
    assert.match(p, opts.followUps[i]!.has);
    assert.doesNotMatch(p, /<gw_tool_call>/);
    assert.doesNotMatch(p, /<system>/);
    assert.equal(p.includes(opts.firstUser), false);
    if (opts.followUps[i]!.missing) assert.doesNotMatch(p, opts.followUps[i]!.missing);
  }
}

test("agentImagesFromCursorParts maps Inference image parts to AgentService images", () => {
  const images = agentImagesFromCursorParts([{ image: { data: "aaaa", mimeType: "image/jpeg" } }]);
  assert.equal(images.length, 1);
  assert.equal(images[0]?.data, "aaaa");
  assert.equal(images[0]?.mimeType, "image/jpeg");
  assert.match(images[0]?.path || "", /\.jpg$/);
});

test("first shot with tools folds replacement system into the user prompt by default", async () => {
  let sentPrompt: string | undefined;
  let sentSystem: string | undefined;
  setCustomToolAgentHostForTests({
    async create(opts) {
      assert.equal(opts.systemPrompt, undefined);
      return {
        agentId: "agent-sys",
        async send(prompt, opts) {
          sentPrompt = prompt;
          sentSystem = opts?.systemPrompt;
          return { wait: async () => ({ text: "ok" }) };
        },
        async close() {},
      };
    },
  });
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup", description: "d" } }]);
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: {
      model: "composer-2.5",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "weather?" },
      ],
    },
    tools,
  });
  assert.equal(res.status, 200);
  assert.match(sentPrompt || "", /<system>/);
  assert.match(sentPrompt || "", /be brief/);
  assert.match(sentPrompt || "", /weather\?/);
  assert.match(sentPrompt || "", /<gw_tool_call>/);
  assert.match(sentPrompt || "", /ListMcpResources/);
  assert.match(sentPrompt || "", /try other tools/);
  assert.equal(sentSystem, undefined);
});

test("GATEWAY_FOLD_SYSTEM=0 sends replacement systemPrompt instead of folding", async () => {
  const prev = process.env.GATEWAY_FOLD_SYSTEM;
  process.env.GATEWAY_FOLD_SYSTEM = "0";
  try {
    let sentPrompt: string | undefined;
    let sentSystem: string | undefined;
    setCustomToolAgentHostForTests({
      async create() {
        return {
          agentId: "agent-sys-replace",
          async send(prompt, opts) {
            sentPrompt = prompt;
            sentSystem = opts?.systemPrompt;
            return { wait: async () => ({ text: "ok" }) };
          },
          async close() {},
        };
      },
    });
    const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup", description: "d" } }]);
    const res = await handleCustomToolChatCompletions({
      headers: new Headers({ authorization: "Bearer crsr_test" }),
      body: {
        model: "composer-2.5",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "weather?" },
        ],
      },
      tools,
    });
    assert.equal(res.status, 200);
    assert.equal(sentPrompt, "weather?");
    assert.doesNotMatch(sentPrompt || "", /<system>/);
    assert.match(sentSystem || "", /be brief/);
    assert.match(sentSystem || "", /lookup/);
  } finally {
    if (prev === undefined) delete process.env.GATEWAY_FOLD_SYSTEM;
    else process.env.GATEWAY_FOLD_SYSTEM = prev;
  }
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
  const sendSystemPrompts: (string | undefined)[] = [];
  setCustomToolAgentHostForTests({
    async create(opts) {
      creates.push(opts);
      return {
        agentId: opts.agentSessionId || "agent-hop",
        async send(prompt, opts) {
          prompts.push(prompt);
          sendSystemPrompts.push(opts?.systemPrompt);
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
  assert.match(prompts[0] || "", /<system>/);
  assert.match(prompts[0] || "", /be brief/);
  assert.equal(sendSystemPrompts[0], undefined);

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

test("park_miss with a full transcript only forwards the latest tool round", async () => {
  const kv = createMemoryKv();
  const prompts: string[] = [];
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-full",
        async send(prompt) {
          prompts.push(prompt);
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
        async send(prompt) {
          prompts.push(prompt);
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
  assert.match(prompts[1] || "", /call_2/);
  assert.match(prompts[1] || "", /humidity/);
  assert.doesNotMatch(prompts[1] || "", /call_1/);
  assert.doesNotMatch(prompts[1] || "", /weather in tokyo/);
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
  assert.match(sse, /text_delta/);
  assert.match(sse, /"text":"ok"/);
});

test("role:tool opens a new send; tool_calls closes the previous AgentService run", async () => {
  const prompts: string[] = [];
  let aborts = 0;
  let releases = 0;
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-scoped",
        async send(prompt) {
          prompts.push(prompt);
          const wait = (async () => {
            if (prompt.includes("<gw_tool_results>") || prompt.includes("gw_tool_results")) {
              return { text: "22c" };
            }
            return { text: gwToolCallText("lookup", {}), usage: { inputTokens: 10, outputTokens: 5 } };
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
  assert.ok(body.usage?.prompt_tokens);
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
  assert.match(prompts[1] || "", /<gw_tool_results>/);
  assert.match(prompts[1] || "", /22/);
  assert.doesNotMatch(prompts[1] || "", /weather\?/);
  assert.equal(aborts, 0);
});

test("markdown json catalog call becomes OpenAI tool_calls without leaking the fence", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-md-json",
        async send() {
          return {
            wait: async () => ({
              text: [
                "I sent a lookup request for tokyo_temp via the catalog.",
                "```json",
                '{"name":"lookup","arguments":{"q":"tokyo_temp"}}',
                "```",
              ].join("\n"),
            }),
          };
        },
        async close() {},
      };
    },
  });
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: {
      model: "composer-2.5",
      messages: [{ role: "user", content: "I ran bash (exit 127). Try other tools. Look up tokyo_temp." }],
    },
    tools,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  const tc = body.choices[0].message.tool_calls;
  assert.equal(tc[0].function.name, "lookup");
  assert.match(tc[0].function.arguments, /tokyo_temp/);
  const content = String(body.choices[0].message.content || "");
  assert.doesNotMatch(content, /```/);
  assert.doesNotMatch(content, /<gw_tool_call>/);
  assert.doesNotMatch(content, /"name":"lookup"/);
});

test("stream=true markdown json catalog call does not leak into delta.content", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-md-sse",
        async send() {
          return {
            wait: async () => ({
              text: '```json\n{"name":"lookup","arguments":{"q":"tokyo_temp"}}\n```',
            }),
            abort: () => {},
            release: () => {},
          };
        },
        async close() {},
      };
    },
  });
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: {
      model: "composer-2.5",
      stream: true,
      messages: [{ role: "user", content: "Try other tools. lookup tokyo_temp." }],
    },
    tools,
  });
  assert.equal(res.status, 200);
  const sse = await consumeSse(res.body, () => {}, (buf) => buf.includes("data: [DONE]"));
  assert.match(sse, /"finish_reason":"tool_calls"/);
  const tc = lastOpenAiSseToolCalls(sse);
  assert.equal(tc[0]?.function.name, "lookup");
  assert.doesNotMatch(sse, /```/);
  assert.doesNotMatch(sse, /<gw_tool_call>/);
});

test("MCP/shell unavailable essay without a catalog JSON call stays text", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-mcp-essay",
        async send() {
          return {
            wait: async () => ({
              text:
                "Current environment only has MCP. ListMcpResources listed nothing under custom-user-tools. " +
                "Shell/Read/Grep/Glob returned Tool not found. lookup is unavailable.",
            }),
          };
        },
        async close() {},
      };
    },
  });
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const res = await handleCustomToolChatCompletions({
    headers: new Headers({ authorization: "Bearer crsr_test" }),
    body: {
      model: "composer-2.5",
      messages: [{ role: "user", content: "Try other tools. Look up tokyo_temp." }],
    },
    tools,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.tool_calls, undefined);
  assert.match(body.choices[0].message.content, /ListMcpResources/);
});

test("example: get_weather then lookup then text stays on one conversation", async () => {
  const user =
    "Use get_weather for Tokyo, then lookup q=tokyo_humidity. One catalog tool per turn. Do not invent numbers.";
  const played = await runOpenAiCatalogScript({
    user,
    openaiTools: [CATALOG_GET_WEATHER, CATALOG_LOOKUP],
    rounds: [
      {
        kind: "tool",
        emit: gwToolCallText("get_weather", { city: "Tokyo" }),
        expectName: "get_weather",
        expectArgs: { city: "Tokyo" },
        result: JSON.stringify({ city: "Tokyo", temp_c: 22 }),
      },
      {
        kind: "tool",
        emit: gwToolCallText("lookup", { q: "tokyo_humidity" }),
        expectName: "lookup",
        expectArgs: { q: "tokyo_humidity" },
        result: JSON.stringify({ q: "tokyo_humidity", humidity: 40 }),
      },
      { kind: "text", emit: "Tokyo is 22°C with 40% humidity.", expect: /22.*40|40.*22/ },
    ],
  });
  assertStableCatalogThread({
    ...played,
    firstUser: user,
    followUps: [
      { has: /get_weather/, missing: /tokyo_humidity/ },
      { has: /tokyo_humidity/, missing: /temp_c/ },
    ],
  });
  assert.match(played.prompts[0] || "", /get_weather/);
  assert.match(played.prompts[0] || "", /lookup/);
});

test("example: lookup tokyo_temp then lookup tokyo_humidity (same defined tool, two turns)", async () => {
  const user = "Look up tokyo_temp then tokyo_humidity with lookup. One call per turn.";
  const played = await runOpenAiCatalogScript({
    user,
    openaiTools: [CATALOG_LOOKUP],
    rounds: [
      {
        kind: "tool",
        emit: gwToolCallText("lookup", { q: "tokyo_temp" }),
        expectName: "lookup",
        expectArgs: { q: "tokyo_temp" },
        result: JSON.stringify({ q: "tokyo_temp", temp_c: 22 }),
      },
      {
        kind: "tool",
        emit: gwToolCallText("lookup", { q: "tokyo_humidity" }),
        expectName: "lookup",
        expectArgs: { q: "tokyo_humidity" },
        result: JSON.stringify({ q: "tokyo_humidity", humidity: 40 }),
      },
      { kind: "text", emit: "22°C and 40% humidity.", expect: /22/ },
    ],
  });
  assertStableCatalogThread({
    ...played,
    firstUser: user,
    followUps: [
      { has: /tokyo_temp/, missing: /tokyo_humidity/ },
      { has: /tokyo_humidity/, missing: /tokyo_temp/ },
    ],
  });
});

test("example: markdown get_weather then xml lookup across turns", async () => {
  const user = "I ran bash (exit 127). Try other tools. get_weather Tokyo, then lookup tokyo_humidity.";
  const played = await runOpenAiCatalogScript({
    user,
    openaiTools: [CATALOG_GET_WEATHER, CATALOG_LOOKUP],
    rounds: [
      {
        kind: "tool",
        emit: mdCatalogCall("get_weather", { city: "Tokyo" }),
        expectName: "get_weather",
        expectArgs: { city: "Tokyo" },
        result: JSON.stringify({ city: "Tokyo", temp_c: 22 }),
      },
      {
        kind: "tool",
        emit: gwToolCallText("lookup", { q: "tokyo_humidity" }),
        expectName: "lookup",
        expectArgs: { q: "tokyo_humidity" },
        result: JSON.stringify({ q: "tokyo_humidity", humidity: 40 }),
      },
      { kind: "text", emit: "22c / 40%.", expect: /22/ },
    ],
  });
  assertStableCatalogThread({
    ...played,
    firstUser: user,
    followUps: [
      { has: /get_weather/, missing: /tokyo_humidity/ },
      { has: /tokyo_humidity/, missing: /temp_c/ },
    ],
  });
});

test("mutating the first user on a tool follow-up starts a new conversation", async () => {
  const kv = createMemoryKv();
  const catalog = openaiToolsToCustom([CATALOG_GET_WEATHER]);
  let sends = 0;
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: `agent-prefix-${sends}`,
        async send() {
          sends += 1;
          return {
            wait: async () =>
              sends === 1
                ? { text: gwToolCallText("get_weather", { city: "Tokyo" }) }
                : { text: "osaka 19c" },
          };
        },
        async close() {},
      };
    },
  });
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const tools = [CATALOG_GET_WEATHER];
  const first = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      messages: [{ role: "user", content: "weather in tokyo?" }],
      tools,
    },
    tools: catalog,
    kv,
  });
  const body1 = await first.json();
  const tc = body1.choices[0].message.tool_calls;
  const second = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      messages: [
        { role: "user", content: "weather in osaka?" },
        { role: "assistant", content: null, tool_calls: tc },
        { role: "tool", tool_call_id: tc[0].id, content: '{"temp_c":22}' },
      ],
      tools,
    },
    tools: catalog,
    kv,
  });
  const body2 = await second.json();
  assert.notEqual(body2.conversation_id, body1.conversation_id);
});

test("two tool rounds: each HTTP request is a new send; prompts are latest results only", async () => {
  const prompts: string[] = [];
  let sends = 0;
  let aborts = 0;
  let releases = 0;
  const kv = createMemoryKv();
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-multi",
        async send(prompt) {
          const round = sends++;
          prompts.push(prompt);
          const wait = (async () => {
            if (round >= 2) return { text: "humidity 40 after two lookups" };
            if (prompt.includes("<gw_tool_results>") || prompt.includes("gw_tool_results")) {
              return { text: gwToolCallText("lookup", { round }), usage: { inputTokens: 20, outputTokens: 8 } };
            }
            return { text: gwToolCallText("lookup", { round }), usage: { inputTokens: 20, outputTokens: 8 } };
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
  const user = { role: "user", content: "weather and humidity?" };

  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [user] },
    tools,
    kv,
  });
  assert.equal(first.status, 200);
  const body1 = await first.json();
  assert.equal(body1.choices[0].finish_reason, "tool_calls");
  const tc1 = body1.choices[0].message.tool_calls;
  assert.ok(body1.usage?.prompt_tokens);
  assert.equal(aborts, 0);

  const second = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
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
  assert.equal(aborts, 0);
  assert.equal(body2.conversation_id, body1.conversation_id);
  assert.match(prompts[1] || "", /<gw_tool_results>/);
  assert.match(prompts[1] || "", /22/);
  assert.doesNotMatch(prompts[1] || "", /weather and humidity/);

  const third = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
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
  assert.equal(body3.choices[0].message.content, "humidity 40 after two lookups");
  assert.equal(body3.conversation_id, body1.conversation_id);
  assert.equal(prompts.length, 3);
  assert.match(prompts[2] || "", /humidity/);
  assert.doesNotMatch(prompts[2] || "", /weather and humidity/);
  assert.doesNotMatch(prompts[2] || "", /temp/);
  assert.equal(aborts, 0);
});

test("stream=true two tool rounds emit complete tool_calls then final text", async () => {
  const prompts: string[] = [];
  let sends = 0;
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-multi-sse",
        async send(prompt) {
          const round = sends++;
          prompts.push(prompt);
          const wait = (async () => {
            if (round >= 2) return { text: "done-sse" };
            return { text: gwToolCallText("lookup", { round }) };
          })();
          return {
            wait: () => wait,
            abort: () => {},
            release: () => {},
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
  assert.doesNotMatch(sse1, /<gw_tool_call>/);

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
  assert.match(prompts[1] || "", /22/);
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
  assert.match(prompts[2] || "", /humidity/);
});

test("Anthropic two tool_use rounds then end_turn", async () => {
  const prompts: string[] = [];
  let sends = 0;
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-multi-anth",
        async send(prompt) {
          const round = sends++;
          prompts.push(prompt);
          const wait = (async () => {
            if (round >= 2) return { text: "40 percent" };
            return { text: gwToolCallText("lookup", { round }) };
          })();
          return {
            wait: () => wait,
            abort: () => {},
            release: () => {},
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
  assert.equal(body2.conversation_id, body1.conversation_id);
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
  assert.match(prompts[2] || "", /humidity/);
  assert.doesNotMatch(prompts[2] || "", /temp/);
});

test("example: Anthropic get_weather then lookup stays on one conversation", async () => {
  const prompts: string[] = [];
  let sends = 0;
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-anth-catalog",
        async send(prompt) {
          prompts.push(prompt);
          const i = sends++;
          if (i === 0) return { wait: async () => ({ text: gwToolCallText("get_weather", { city: "Tokyo" }) }) };
          if (i === 1) return { wait: async () => ({ text: gwToolCallText("lookup", { q: "tokyo_humidity" }) }) };
          return { wait: async () => ({ text: "Tokyo is 22°C with 40% humidity." }) };
        },
        async close() {},
      };
    },
  });
  const tools = openaiToolsToCustom([CATALOG_GET_WEATHER, CATALOG_LOOKUP]);
  const headers = new Headers({ "x-api-key": "crsr_test" });
  const user = { role: "user", content: "Tokyo weather then humidity. One catalog tool per turn." };

  const first = await handleCustomToolMessages({
    headers,
    body: { model: "composer-2.5", max_tokens: 64, messages: [user] },
    tools,
    requestId: "req_cat_1",
  });
  assert.equal(first.status, 200);
  const body1 = await first.json();
  assert.equal(body1.stop_reason, "tool_use");
  const use1 = body1.content.find((b: { type?: string; name?: string }) => b.type === "tool_use");
  assert.equal(use1?.name, "get_weather");
  assert.deepEqual(use1?.input, { city: "Tokyo" });

  const second = await handleCustomToolMessages({
    headers,
    body: {
      model: "composer-2.5",
      max_tokens: 64,
      messages: [
        user,
        { role: "assistant", content: [use1] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use1.id, content: '{"city":"Tokyo","temp_c":22}' }] },
      ],
    },
    tools,
    requestId: "req_cat_2",
  });
  const body2 = await second.json();
  assert.equal(body2.stop_reason, "tool_use");
  const use2 = body2.content.find((b: { type?: string; name?: string }) => b.type === "tool_use");
  assert.equal(use2?.name, "lookup");
  assert.deepEqual(use2?.input, { q: "tokyo_humidity" });
  assert.equal(body2.conversation_id, body1.conversation_id);
  assert.match(prompts[1] || "", /<gw_tool_results>/);
  assert.match(prompts[1] || "", /get_weather/);
  assert.doesNotMatch(prompts[1] || "", /Tokyo weather then humidity/);

  const third = await handleCustomToolMessages({
    headers,
    body: {
      model: "composer-2.5",
      max_tokens: 64,
      messages: [
        user,
        { role: "assistant", content: [use1] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use1.id, content: '{"city":"Tokyo","temp_c":22}' }] },
        { role: "assistant", content: [use2] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use2.id, content: '{"q":"tokyo_humidity","humidity":40}' }] },
      ],
    },
    tools,
    requestId: "req_cat_3",
  });
  const body3 = await third.json();
  assert.equal(body3.stop_reason, "end_turn");
  assert.match(body3.content.find((b: { type?: string; text?: string }) => b.type === "text")?.text || "", /22/);
  assert.equal(body3.conversation_id, body1.conversation_id);
  assert.match(prompts[2] || "", /humidity/);
  assert.doesNotMatch(prompts[2] || "", /temp_c/);
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

function duplexUserText(duplex: ChatInteractiveDuplex): string {
  const runMsg = duplex.sent.find((m) => field(m, "runRequest"));
  const run = asObject(field(runMsg, "runRequest"));
  const user = asObject(field(asObject(field(asObject(field(run, "action")), "userMessageAction")), "userMessage"));
  return String(user?.text || "");
}

function duplexSentCancel(duplex: ChatInteractiveDuplex): boolean {
  return duplex.sent.some((m) => field(m, "conversationAction", "conversation_action"));
}

function duplexSentMcpResult(duplex: ChatInteractiveDuplex): boolean {
  return duplex.sent.some((m) => field(asObject(field(m, "execClientMessage")), "mcpResult", "mcp_result"));
}

test("in-repo host: two text gw_tool_call turns then text; must not cancelAction", async () => {
  const duplexes: ChatInteractiveDuplex[] = [];
  const openRun: OpenAgentRun = async () => {
    const duplex = new ChatInteractiveDuplex();
    const i = duplexes.length;
    duplexes.push(duplex);
    duplex.onSend = (message) => {
      if (!field(message, "runRequest")) return;
      if (i === 0) {
        duplex.push({
          interactionUpdate: {
            textDelta: { text: gwToolCallText("get_weather", { city: "Tokyo" }) },
          },
        });
        duplex.push({ interactionUpdate: { turnEnded: {} } });
        return;
      }
      if (i === 1) {
        duplex.push({
          interactionUpdate: {
            textDelta: { text: gwToolCallText("lookup", { q: "tokyo_humidity" }) },
          },
        });
        duplex.push({ interactionUpdate: { turnEnded: {} } });
        return;
      }
      duplex.push({ interactionUpdate: { textDelta: { text: "Tokyo is 22°C with 40% humidity." } } });
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
  const tools = openaiToolsToCustom([CATALOG_GET_WEATHER, CATALOG_LOOKUP]);
  const headers = new Headers({ authorization: "Bearer crsr_test" });
  const kv = createMemoryKv();
  const user = { role: "user", content: "Tokyo weather then humidity. One catalog tool per turn." };

  const first = await handleCustomToolChatCompletions({
    headers,
    body: { model: "composer-2.5", messages: [user], tools: [CATALOG_GET_WEATHER, CATALOG_LOOKUP] },
    tools,
    kv,
  });
  const body1 = await first.json();
  assert.equal(body1.choices[0].finish_reason, "tool_calls");
  const tc1 = body1.choices[0].message.tool_calls;
  assert.equal(tc1[0].function.name, "get_weather");
  assert.deepEqual(parseToolArgs(tc1[0].function.arguments), { city: "Tokyo" });
  assert.equal(duplexes.length, 1);
  assert.equal(duplexSentCancel(duplexes[0]!), false);
  assert.equal(duplexSentMcpResult(duplexes[0]!), false);

  const second = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      messages: [
        user,
        { role: "assistant", content: null, tool_calls: tc1 },
        { role: "tool", tool_call_id: tc1[0].id, content: JSON.stringify({ city: "Tokyo", temp_c: 22 }) },
      ],
      tools: [CATALOG_GET_WEATHER, CATALOG_LOOKUP],
    },
    tools,
    kv,
  });
  const body2 = await second.json();
  assert.equal(body2.choices[0].finish_reason, "tool_calls");
  const tc2 = body2.choices[0].message.tool_calls;
  assert.equal(tc2[0].function.name, "lookup");
  assert.deepEqual(parseToolArgs(tc2[0].function.arguments), { q: "tokyo_humidity" });
  assert.equal(duplexes.length, 2);
  assert.equal(duplexSentCancel(duplexes[1]!), false);
  assert.match(duplexUserText(duplexes[1]!), /<gw_tool_results>/);
  assert.match(duplexUserText(duplexes[1]!), /get_weather/);
  assert.doesNotMatch(duplexUserText(duplexes[1]!), /Tokyo weather then humidity/);
  assert.equal(body2.conversation_id, body1.conversation_id);

  const third = await handleCustomToolChatCompletions({
    headers,
    body: {
      model: "composer-2.5",
      messages: [
        user,
        { role: "assistant", content: null, tool_calls: tc1 },
        { role: "tool", tool_call_id: tc1[0].id, content: JSON.stringify({ city: "Tokyo", temp_c: 22 }) },
        { role: "assistant", content: null, tool_calls: tc2 },
        { role: "tool", tool_call_id: tc2[0].id, content: JSON.stringify({ q: "tokyo_humidity", humidity: 40 }) },
      ],
      tools: [CATALOG_GET_WEATHER, CATALOG_LOOKUP],
    },
    tools,
    kv,
  });
  const body3 = await third.json();
  assert.match(body3.choices[0].message.content, /22/);
  assert.match(body3.choices[0].message.content, /40/);
  assert.equal(body3.conversation_id, body1.conversation_id);
  assert.equal(duplexes.length, 3);
  assert.match(duplexUserText(duplexes[2]!), /humidity/);
  assert.doesNotMatch(duplexUserText(duplexes[2]!), /temp_c/);
  assert.equal(duplexSentCancel(duplexes[2]!), false);
});

test("OpenAI JSON forwards AgentService errors in error field and visible content", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-err",
        async send() {
          return { wait: async () => ({ text: "", error: "Provider exceeded max output tokens." }) };
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
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error?.message, "Provider exceeded max output tokens.");
  assert.equal(body.error?.type, "api_error");
  assert.equal(body.choices[0].message.content, "Provider exceeded max output tokens.");
  assert.equal(body.choices[0].finish_reason, "stop");
});

test("OpenAI stream=true forwards AgentService errors as content and error field", async () => {
  setCustomToolAgentHostForTests({
    async create() {
      return {
        agentId: "agent-err-sse",
        async send() {
          return { wait: async () => ({ text: "", error: "AgentService aborted the run" }) };
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
  const sse = await consumeSse(res.body, () => {}, (buf) => buf.includes("data: [DONE]"));
  assert.match(sse, /"content":"AgentService aborted the run"/);
  assert.match(sse, /"error":\{"message":"AgentService aborted the run","type":"api_error"\}/);
});

test("Anthropic JSON error-only responses use the error envelope", async () => {
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
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, "error");
  assert.equal(body.error?.message, "ERROR_NOT_LOGGED_IN: not logged in");
});

test("Anthropic stream=true emits error event and visible text for AgentService errors", async () => {
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
  const sse = await consumeSse(res.body, () => {}, (buf) => buf.includes("event: error") || buf.includes("message_stop"));
  assert.match(sse, /event: error/);
  assert.match(sse, /rate limited/);
  assert.match(sse, /text_delta/);
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
    body: { model: "composer-2.5", stream: true, messages: [{ role: "user", content: "hi" }] },
    tools: [],
  });
  assert.equal(res.status, 200);
  await res.body?.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(aborts >= 1, `expected SSE cancel to abort AgentService, got ${aborts}`);
});

