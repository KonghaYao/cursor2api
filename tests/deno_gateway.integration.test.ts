/**
 * Deno integration tests: full handler stack with mocked Cursor upstream (no live API).
 *
 *   deno task test
 */

import { encodeConnectFrame } from "../src/lib/bytes.ts";
import { handleGatewayRequest } from "../src/lib/handler.ts";
import { createMemoryKv } from "../src/lib/kv.ts";
import { cloudClientToolsClearForTests } from "../src/lib/cloud_openai.ts";
import { setCustomToolAgentHostForTests, type SdkCustomToolMap } from "../src/lib/custom_tool_chat.ts";

/** JWT-shaped test credential (skips exchange_user_api_key). */
const TEST_JWT = "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.test";

type FetchFn = typeof fetch;

function installMockFetch(handlers: {
  onStream?: (init?: RequestInit) => Response | Promise<Response>;
  onModels?: (init?: RequestInit) => Response | Promise<Response>;
}): FetchFn {
  const original = globalThis.fetch;
  const mock: FetchFn = (input, init) => {
    const url = String(input);
    if (url.includes("/aiserver.v1.InferenceService/Stream") && handlers.onStream) {
      return Promise.resolve(handlers.onStream(init));
    }
    if (url.includes("/agent.v1.AgentService/GetUsableModels") && handlers.onModels) {
      return Promise.resolve(handlers.onModels(init));
    }
    if (url.includes("/auth/exchange_user_api_key")) {
      return Promise.resolve(
        new Response(JSON.stringify({ accessToken: TEST_JWT }), { status: 200 }),
      );
    }
    return original(input, init);
  };
  globalThis.fetch = mock;
  return original;
}

Deno.test("GET /health", async () => {
  const kv = createMemoryKv();
  const res = await handleGatewayRequest(new Request("http://127.0.0.1/health"), { kv });
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  const body = await res.json();
  if (body?.ok !== true) throw new Error(`unexpected body: ${JSON.stringify(body)}`);
});

Deno.test("GET /v1/models returns Anthropic pagination shape when requested", async () => {
  const original = installMockFetch({
    onModels: () => new Response(JSON.stringify({ models: [{ modelId: "composer-2.5-fast" }, { id: "other-model" }] })),
  });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/models?limit=1", {
        headers: { "x-api-key": TEST_JWT, "anthropic-version": "2023-06-01" },
      }),
      { kv: createMemoryKv() },
    );
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    if (!res.headers.get("request-id")) throw new Error("missing request-id");
    const body = await res.json();
    if (body?.data?.[0]?.type !== "model" || body?.data?.[0]?.id !== "composer-2.5-fast") {
      throw new Error(`unexpected Anthropic models body: ${JSON.stringify(body)}`);
    }
    if (body.first_id !== "composer-2.5-fast" || body.last_id !== "composer-2.5-fast" || body.has_more !== true) {
      throw new Error(`unexpected pagination: ${JSON.stringify(body)}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("GET /v1/models propagates upstream failure", async () => {
  const original = installMockFetch({ onModels: () => new Response("unavailable", { status: 503 }) });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/models", {
        headers: { "x-api-key": TEST_JWT, "anthropic-version": "2023-06-01" },
      }),
      { kv: createMemoryKv() },
    );
    if (res.status !== 503) throw new Error(`expected 503, got ${res.status}`);
    const body = await res.json();
    if (body?.type !== "error" || body?.error?.type !== "api_error") {
      throw new Error(`unexpected error body: ${JSON.stringify(body)}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("POST /v1/chat/completions stream=true returns incremental SSE", async () => {
  const kv = createMemoryKv();
  const frames = [
    encodeConnectFrame({ textPart: { text: "hel" } }),
    encodeConnectFrame({ textPart: { text: "lo" } }),
  ];
  const original = installMockFetch({
    onStream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const f of frames) controller.enqueue(f);
            controller.close();
          },
        }),
        { status: 200 },
      ),
  });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_JWT}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5-fast",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { kv },
    );
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) throw new Error(`expected SSE content-type, got ${ct}`);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    if (dataLines.length < 4) {
      throw new Error(`expected multiple SSE data lines, got ${dataLines.length}`);
    }
    if (!text.includes('"content":"hel"') || !text.includes('"content":"lo"')) {
      throw new Error(`missing incremental content chunks: ${text.slice(0, 500)}`);
    }
    if (!text.endsWith("data: [DONE]\n\n")) throw new Error("missing [DONE]");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("stream abort propagates to upstream fetch signal", async () => {
  const kv = createMemoryKv();
  let upstreamSignal: AbortSignal | undefined;
  const original = installMockFetch({
    onStream: (init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(encodeConnectFrame({ textPart: { text: "x" } }));
          },
        }),
        { status: 200 },
      );
    },
  });
  const client = new AbortController();
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        signal: client.signal,
        headers: {
          authorization: `Bearer ${TEST_JWT}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5-fast",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { kv },
    );
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const reader = res.body!.getReader();
    await reader.read();
    client.abort();
    try {
      await reader.read();
    } catch {
      /* reader may error after abort */
    }
    await new Promise((r) => setTimeout(r, 20));
    if (!upstreamSignal?.aborted) throw new Error("upstream fetch signal was not aborted");
  } finally {
    globalThis.fetch = original;
  }
});

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function decodeConnectJson(body: unknown): Record<string, unknown> {
  let bytes: Uint8Array;
  if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (body instanceof Uint8Array) bytes = body;
  else throw new Error(`unexpected body type: ${typeof body}`);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(5))) as Record<string, unknown>;
}

Deno.test("POST /v1/chat/completions forwards OpenAI image_url as Cursor image parts", async () => {
  const kv = createMemoryKv();
  let upstream: Record<string, unknown> | undefined;
  const original = installMockFetch({
    onStream: (init) => {
      upstream = decodeConnectJson(init?.body ?? null);
      const frame = encodeConnectFrame({ textPart: { text: "a red pixel" } });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame);
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_JWT}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5-fast",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what color?" },
                { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
              ],
            },
          ],
        }),
      }),
      { kv },
    );
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    const messages = (upstream?.messages as Array<Record<string, unknown>>) || [];
    const user = messages.find((m) => {
      const parts = (m.parts as { parts?: Array<Record<string, unknown>> } | undefined)?.parts;
      return Array.isArray(parts) && parts.some((p) => p.image);
    });
    if (!user) throw new Error(`no image part in upstream messages: ${JSON.stringify(upstream).slice(0, 800)}`);
    const image = ((user.parts as { parts: Array<Record<string, unknown>> }).parts.find((p) => p.image) as {
      image: { data: string; mimeType: string };
    }).image;
    if (image.data !== TINY_PNG_B64) throw new Error("image data mismatch");
    if (image.mimeType !== "image/png") throw new Error(`mime ${image.mimeType}`);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("POST /v1/messages stream=true returns Anthropic SSE", async () => {
  const kv = createMemoryKv();
  const original = installMockFetch({
    onStream: () => {
      const frame = encodeConnectFrame({ textPart: { text: "hello" } });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame);
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_JWT}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5-fast",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { kv },
    );
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    const text = await res.text();
    if (!text.includes("event: message_start")) throw new Error(`missing message_start: ${text.slice(0, 400)}`);
    if (!text.includes('"text":"hello"')) throw new Error(`missing text: ${text.slice(0, 400)}`);
    if (!text.includes("event: message_stop")) throw new Error("missing message_stop");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("POST /v1/messages maps inference errors to Anthropic errors", async () => {
  const kv = createMemoryKv();
  const original = installMockFetch({
    onStream: () => {
      const frame = encodeConnectFrame({ error: { code: "RESOURCE_EXHAUSTED", message: "rate limited" } });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame);
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_JWT}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5-fast",
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { kv },
    );
    if (res.status !== 429) throw new Error(`expected 429, got ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (body?.type !== "error" || body?.error?.type !== "rate_limit_error") {
      throw new Error(`unexpected Anthropic error: ${JSON.stringify(body)}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("POST /v1/messages stream=true maps inference errors to Anthropic error events", async () => {
  const kv = createMemoryKv();
  const original = installMockFetch({
    onStream: () => {
      const frame = encodeConnectFrame({ error: { code: "ERROR_BAD_MODEL_NAME", message: "bad model" } });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame);
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_JWT}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "bad-model",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { kv },
    );
    const text = await res.text();
    if (!text.includes("event: error") || !text.includes('"type":"invalid_request_error"')) {
      throw new Error(`missing Anthropic error event: ${text}`);
    }
    if (text.includes("event: message_stop")) throw new Error(`unexpected successful stop: ${text}`);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("POST /v1/messages validates request before calling upstream", async () => {
  const kv = createMemoryKv();
  const cases = [
    {
      name: "missing max_tokens",
      body: { model: "composer-2.5-fast", messages: [{ role: "user", content: "hi" }] },
      message: "max_tokens",
    },
    {
      name: "unsupported top_k",
      body: { model: "composer-2.5-fast", max_tokens: 128, top_k: 5, messages: [{ role: "user", content: "hi" }] },
      message: "top_k",
    },
    {
      name: "unsupported content block",
      body: {
        model: "composer-2.5-fast",
        max_tokens: 128,
        messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {} }] }],
      },
      message: "server_tool_use",
    },
  ];
  for (const item of cases) {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_JWT}`, "content-type": "application/json" },
        body: JSON.stringify(item.body),
      }),
      { kv },
    );
    if (res.status !== 400) throw new Error(`${item.name}: expected 400, got ${res.status}`);
    if (!res.headers.get("request-id")) throw new Error(`${item.name}: missing request-id`);
    const body = await res.json();
    if (body?.type !== "error" || body?.error?.type !== "invalid_request_error" || !String(body.error.message).includes(item.message)) {
      throw new Error(`${item.name}: unexpected body ${JSON.stringify(body)}`);
    }
    if (body.request_id !== res.headers.get("request-id")) throw new Error(`${item.name}: request id mismatch`);
  }
});

Deno.test("POST /v1/chat/completions without Authorization is 401 JSON", async () => {
  const res = await handleGatewayRequest(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "composer-2.5-fast", messages: [{ role: "user", content: "hi" }] }),
    }),
    { kv: createMemoryKv(), upstream: "cloud" },
  );
  if (res.status !== 401) throw new Error(`expected 401, got ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body?.error?.type !== "authentication_error") throw new Error(`unexpected body ${JSON.stringify(body)}`);
});

Deno.test("POST /v1/messages returns malformed JSON as Anthropic 400", async () => {
  const res = await handleGatewayRequest(
    new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_JWT}`, "content-type": "application/json" },
      body: "{",
    }),
    { kv: createMemoryKv() },
  );
  if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  const body = await res.json();
  if (body?.error?.type !== "invalid_request_error") throw new Error(`unexpected body ${JSON.stringify(body)}`);
});

Deno.test("POST /v1/messages forwards Anthropic image blocks", async () => {
  const kv = createMemoryKv();
  let upstream: Record<string, unknown> | undefined;
  const original = installMockFetch({
    onStream: (init) => {
      upstream = decodeConnectJson(init?.body ?? null);
      const frame = encodeConnectFrame({ textPart: { text: "ok" } });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame);
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_JWT}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5-fast",
          max_tokens: 128,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "look" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 } },
              ],
            },
          ],
        }),
      }),
      { kv },
    );
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    const blob = JSON.stringify(upstream);
    if (!blob.includes(TINY_PNG_B64)) throw new Error(`image not forwarded: ${blob.slice(0, 500)}`);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("POST /v1/chat/completions n>1 is 400", async () => {
  const kv = createMemoryKv();
  const res = await handleGatewayRequest(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_JWT}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "composer-2.5-fast",
        n: 2,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    { kv },
  );
  if (res.status !== 400) throw new Error(`expected 400, got ${res.status}: ${await res.text()}`);
});

Deno.test("POST /v1/embeddings is 501", async () => {
  const kv = createMemoryKv();
  const res = await handleGatewayRequest(
    new Request("http://127.0.0.1/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_JWT}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "composer-2.5-fast", input: "hi" }),
    }),
    { kv },
  );
  if (res.status !== 501) throw new Error(`expected 501, got ${res.status}`);
});

Deno.test("POST /v1/chat/completions forwards maxMode and top_p", async () => {
  const kv = createMemoryKv();
  let upstream: Record<string, unknown> | undefined;
  const original = installMockFetch({
    onStream: (init) => {
      upstream = decodeConnectJson(init?.body ?? null);
      const frame = encodeConnectFrame({ textPart: { text: "x" } });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame);
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_JWT}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5",
          max_mode: true,
          top_p: 0.5,
          stop: ["END"],
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      { kv },
    );
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    const rm = upstream?.requestedModel as Record<string, unknown>;
    if (rm?.maxMode !== true) throw new Error(`maxMode not set: ${JSON.stringify(rm)}`);
    const cfg = upstream?.modelConfig as Record<string, unknown>;
    if (cfg?.topP !== 0.5) throw new Error(`topP ${cfg?.topP}`);
    const stops = cfg?.stopSequences as string[];
    if (!stops?.includes("END")) throw new Error(`stop ${JSON.stringify(cfg)}`);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("cloud gateway has no HTTP MCP callback endpoint", async () => {
  const res = await handleGatewayRequest(
    new Request("http://127.0.0.1/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    { kv: createMemoryKv(), upstream: "cloud" },
  );
  if (res.status !== 404) throw new Error(`expected 404 for /mcp, got ${res.status}: ${await res.text()}`);
});

Deno.test("cloud health advertises AgentService customTools only, not Cloud REST chat or HTTP MCP", async () => {
  const res = await handleGatewayRequest(new Request("http://127.0.0.1/health"), {
    kv: createMemoryKv(),
    upstream: "cloud",
  });
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  const body = await res.json();
  if (!String(body?.rpc || "").includes("AgentService")) {
    throw new Error(`unexpected health: ${JSON.stringify(body)}`);
  }
  if (!String(body?.tools || "").includes('["mcp"]') && !String(body?.tools || "").includes("customTools")) {
    throw new Error(`health should advertise mcp-only customTools: ${JSON.stringify(body)}`);
  }
  if (String(body?.tools || "").includes("/mcp") || String(body?.rpc || "").includes("api.cursor.com/v1/agents")) {
    throw new Error(`health must not advertise HTTP MCP or Cloud REST chat: ${JSON.stringify(body)}`);
  }
});

Deno.test("cloud GET /v1/models uses api.cursor.com", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url === "https://api.cursor.com/v1/models") {
      const auth = new Headers(init?.headers).get("authorization") || "";
      if (!auth.startsWith("Basic ")) return Promise.resolve(new Response("bad auth", { status: 401 }));
      return Promise.resolve(new Response(JSON.stringify({ items: [{ id: "composer-2.5" }] })));
    }
    return original(input, init);
  };
  try {
    const res = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer crsr_test" } }),
      { kv: createMemoryKv(), upstream: "cloud" },
    );
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (body?.data?.[0]?.id !== "composer-2.5") throw new Error(`unexpected ${JSON.stringify(body)}`);
  } finally {
    globalThis.fetch = original;
  }
});

function installFakeCustomToolHost(created: string[] = []) {
  const usage = { inputTokens: 40, outputTokens: 4, cacheReadTokens: 30, cacheWriteTokens: 2 };
  setCustomToolAgentHostForTests({
    async create({ customTools }: { customTools: SdkCustomToolMap }) {
      const names = Object.keys(customTools);
      const agentId = `local-test-agent-${created.length + 1}`;
      created.push(agentId);
      return {
        agentId,
        async send(prompt: string, opts?: { resume?: boolean }) {
          const wait = (async () => {
            if (opts?.resume || prompt.includes("executed your custom tools")) {
              return { text: "done:22c from tool results", usage };
            }
            const first = names[0];
            if (!first) return { text: "no-tools", usage };
            const result = await customTools[first]!.execute({ city: "Tokyo" }, {});
            const rec = result as { content?: Array<{ text?: string }> };
            const text = rec?.content?.[0]?.text || JSON.stringify(result);
            return { text: `done:${text}`, usage };
          })();
          return { wait: () => wait };
        },
        async close() {},
      };
    },
  });
}

Deno.test("cloud OpenAI tools park customTools.execute and resume with client results", async () => {
  cloudClientToolsClearForTests();
  installFakeCustomToolHost();
  const kv = createMemoryKv();
  const ctx = { kv, upstream: "cloud" as const };
  const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
  try {
    const chat = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer crsr_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "weather in tokyo?" }],
          tools,
        }),
      }),
      ctx,
    );
    if (chat.status !== 200) throw new Error(`chat ${chat.status}: ${await chat.text()}`);
    const chatBody = await chat.json();
    if (chatBody?.choices?.[0]?.finish_reason !== "tool_calls") {
      throw new Error(`expected tool_calls, got ${JSON.stringify(chatBody)}`);
    }
    const tc = chatBody.choices[0].message.tool_calls;
    if (Array.isArray(tc) && Number(chatBody?.usage?.prompt_tokens || 0) !== 0) {
      throw new Error(`tool_calls response should not have turnEnded usage yet: ${JSON.stringify(chatBody.usage)}`);
    }
    if (!Array.isArray(tc) || tc.length !== 1 || tc[0]?.function?.name !== "get_weather") {
      throw new Error(`expected one complete get_weather tool_call, got ${JSON.stringify(tc)}`);
    }
    const chat2 = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer crsr_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            { role: "user", content: "weather in tokyo?" },
            { role: "assistant", content: null, tool_calls: tc },
            { role: "tool", tool_call_id: tc[0].id, content: '{"temp_c":22}' },
          ],
          tools,
        }),
      }),
      ctx,
    );
    if (chat2.status !== 200) throw new Error(`chat2 ${chat2.status}: ${await chat2.text()}`);
    const chat2Body = await chat2.json();
    if (!String(chat2Body?.choices?.[0]?.message?.content || "").includes("22")) {
      throw new Error(`expected final text from customTools.execute, got ${JSON.stringify(chat2Body)}`);
    }
    if (chat2Body?.usage?.prompt_tokens !== 40 || chat2Body?.usage?.prompt_tokens_details?.cached_tokens !== 30) {
      throw new Error(`expected AgentService usage on final turn, got ${JSON.stringify(chat2Body.usage)}`);
    }
  } finally {
    setCustomToolAgentHostForTests(undefined);
    cloudClientToolsClearForTests();
  }
});

Deno.test("cloud OpenAI two tool rounds then final text (full transcript)", async () => {
  cloudClientToolsClearForTests();
  const usage = { inputTokens: 40, outputTokens: 4, cacheReadTokens: 30, cacheWriteTokens: 2 };
  let sends = 0;
  setCustomToolAgentHostForTests({
    async create({ customTools }: { customTools: SdkCustomToolMap }) {
      return {
        agentId: "local-multi-round",
        async send() {
          const round = sends++;
          const wait = (async () => {
            if (round >= 2) return { text: "humidity 40 after two lookups", usage };
            const first = Object.keys(customTools)[0];
            if (!first) return { text: "no-tools", usage };
            await customTools[first]!.execute({ round }, {});
            return { text: "should-not-reach", usage };
          })();
          return { wait: () => wait, abort() {}, release() {} };
        },
        async close() {},
      };
    },
  });
  const kv = createMemoryKv();
  const ctx = { kv, upstream: "cloud" as const };
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
  const user = { role: "user", content: "weather and humidity?" };
  try {
    const chat = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer crsr_test", "content-type": "application/json" },
        body: JSON.stringify({ model: "composer-2.5", messages: [user], tools }),
      }),
      ctx,
    );
    if (chat.status !== 200) throw new Error(`chat ${chat.status}: ${await chat.text()}`);
    const body1 = await chat.json();
    if (body1?.choices?.[0]?.finish_reason !== "tool_calls") {
      throw new Error(`expected tool_calls, got ${JSON.stringify(body1)}`);
    }
    const tc1 = body1.choices[0].message.tool_calls;
    const chat2 = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer crsr_test", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            user,
            { role: "assistant", content: null, tool_calls: tc1 },
            { role: "tool", tool_call_id: tc1[0].id, content: '{"temp":22}' },
          ],
          tools,
        }),
      }),
      ctx,
    );
    if (chat2.status !== 200) throw new Error(`chat2 ${chat2.status}: ${await chat2.text()}`);
    const body2 = await chat2.json();
    if (body2?.choices?.[0]?.finish_reason !== "tool_calls") {
      throw new Error(`expected second tool_calls, got ${JSON.stringify(body2)}`);
    }
    if (body2.conversation_id !== body1.conversation_id) {
      throw new Error(`conversation_id changed: ${body1.conversation_id} -> ${body2.conversation_id}`);
    }
    const tc2 = body2.choices[0].message.tool_calls;
    const chat3 = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer crsr_test", "content-type": "application/json" },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            user,
            { role: "assistant", content: null, tool_calls: tc1 },
            { role: "tool", tool_call_id: tc1[0].id, content: '{"temp":22}' },
            { role: "assistant", content: null, tool_calls: tc2 },
            { role: "tool", tool_call_id: tc2[0].id, content: '{"humidity":40}' },
          ],
          tools,
        }),
      }),
      ctx,
    );
    if (chat3.status !== 200) throw new Error(`chat3 ${chat3.status}: ${await chat3.text()}`);
    const body3 = await chat3.json();
    if (!String(body3?.choices?.[0]?.message?.content || "").includes("humidity 40")) {
      throw new Error(`expected final text after two tool rounds, got ${JSON.stringify(body3)}`);
    }
  } finally {
    setCustomToolAgentHostForTests(undefined);
    cloudClientToolsClearForTests();
  }
});

Deno.test("cloud tool results continue when the parked execute() is gone", async () => {
  cloudClientToolsClearForTests();
  installFakeCustomToolHost();
  const kv = createMemoryKv();
  const ctx = { kv, upstream: "cloud" as const };
  const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
  try {
    const chat = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer crsr_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [{ role: "user", content: "weather in tokyo?" }],
          tools,
        }),
      }),
      ctx,
    );
    if (chat.status !== 200) throw new Error(`chat ${chat.status}: ${await chat.text()}`);
    const chatBody = await chat.json();
    const tc = chatBody.choices[0].message.tool_calls;
    cloudClientToolsClearForTests();
    installFakeCustomToolHost();
    const chat2 = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer crsr_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5",
          messages: [
            { role: "user", content: "weather in tokyo?" },
            { role: "assistant", content: null, tool_calls: tc },
            { role: "tool", tool_call_id: tc[0].id, content: '{"temp_c":22}' },
          ],
          tools,
        }),
      }),
      ctx,
    );
    if (chat2.status !== 200) throw new Error(`chat2 ${chat2.status}: ${await chat2.text()}`);
    const chat2Body = await chat2.json();
    if (String(chat2Body?.error?.message || "").includes("expired")) {
      throw new Error(`park miss should not expire: ${JSON.stringify(chat2Body)}`);
    }
    if (!String(chat2Body?.choices?.[0]?.message?.content || "").includes("22")) {
      throw new Error(`expected follow-up text from tool results, got ${JSON.stringify(chat2Body)}`);
    }
  } finally {
    setCustomToolAgentHostForTests(undefined);
    cloudClientToolsClearForTests();
  }
});

Deno.test("cloud stream=true emits complete tool_calls in one delta", async () => {
  cloudClientToolsClearForTests();
  installFakeCustomToolHost();
  const kv = createMemoryKv();
  const ctx = { kv, upstream: "cloud" as const };
  try {
    const chat = await handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer crsr_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "composer-2.5",
          stream: true,
          messages: [{ role: "user", content: "weather?" }],
          tools: [{ type: "function", function: { name: "lookup" } }],
        }),
      }),
      ctx,
    );
    const text = await chat.text();
    const toolCallDeltas = text.split("\n").filter((l) => l.includes('"tool_calls":['));
    if (toolCallDeltas.length !== 1) {
      throw new Error(`expected one complete tool_calls delta, got ${toolCallDeltas.length}: ${text}`);
    }
    if (!text.includes('"finish_reason":"tool_calls"')) throw new Error(`missing finish_reason tool_calls: ${text}`);
    if (!text.includes('"name":"lookup"')) throw new Error(text);
  } finally {
    setCustomToolAgentHostForTests(undefined);
    cloudClientToolsClearForTests();
  }
});

Deno.test("cloud chat always uses customTools, never Cloud REST agents", async () => {
  cloudClientToolsClearForTests();
  const created: string[] = [];
  installFakeCustomToolHost(created);
  const kv = createMemoryKv();
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    urls.push(`${init?.method || "GET"} ${String(input)}`);
    return original(input, init);
  };
  const chat = (messages: unknown[]) =>
    handleGatewayRequest(
      new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer crsr_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "composer-2.5", messages }),
      }),
      { kv, upstream: "cloud" },
    );
  try {
    const first = await chat([{ role: "user", content: "hello" }]);
    if (first.status !== 200) throw new Error(`first ${first.status}: ${await first.text()}`);
    const firstBody = await first.json();
    if (!String(firstBody?.choices?.[0]?.message?.content || "").includes("no-tools")) {
      throw new Error(`expected SDK text, got ${JSON.stringify(firstBody)}`);
    }
    if (firstBody?.usage?.prompt_tokens !== 40 || firstBody?.usage?.completion_tokens !== 4) {
      throw new Error(`expected usage on no-tools chat, got ${JSON.stringify(firstBody.usage)}`);
    }
    const second = await chat([
      { role: "user", content: "hello" },
      { role: "assistant", content: "no-tools" },
      { role: "user", content: "again" },
    ]);
    if (second.status !== 200) throw new Error(`second ${second.status}: ${await second.text()}`);
    const switched = await chat([{ role: "user", content: "new thread" }]);
    if (switched.status !== 200) throw new Error(`switch ${switched.status}: ${await switched.text()}`);
    if (created.length !== 2) throw new Error(`expected 2 SDK agents, got ${created.join(",")}`);
    if (urls.some((u) => u.includes("api.cursor.com/v1/agents"))) {
      throw new Error(`chat must not hit Cloud REST: ${urls.join(",")}`);
    }
  } finally {
    globalThis.fetch = original;
    setCustomToolAgentHostForTests(undefined);
    cloudClientToolsClearForTests();
  }
});
