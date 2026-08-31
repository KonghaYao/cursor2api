/**
 * Deno integration tests: full handler stack with mocked Cursor upstream (no live API).
 *
 *   deno task test
 */

import { encodeConnectFrame } from "../src/lib/bytes.ts";
import { handleGatewayRequest } from "../src/lib/handler.ts";
import { createMemoryKv } from "../src/lib/kv.ts";

/** JWT-shaped test credential (skips exchange_user_api_key). */
const TEST_JWT = "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.test";

type FetchFn = typeof fetch;

function installMockFetch(handlers: {
  onStream?: (init?: RequestInit) => Response | Promise<Response>;
}): FetchFn {
  const original = globalThis.fetch;
  const mock: FetchFn = (input, init) => {
    const url = String(input);
    if (url.includes("/aiserver.v1.InferenceService/Stream") && handlers.onStream) {
      return Promise.resolve(handlers.onStream(init));
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
