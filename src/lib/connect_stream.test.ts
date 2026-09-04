import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectFrameParser,
  encodeConnectFrame,
  encodeSseData,
} from "./bytes.ts";
import { buildOpenAiSseStreamFromFramePayloads, buildAnthropicSseStreamFromFramePayloads, upstreamAbortFromClient } from "./inference.ts";

test("ConnectFrameParser parses two frames split across chunk boundaries", async () => {
  const f1 = encodeConnectFrame({ textPart: { text: "hello" } });
  const f2 = encodeConnectFrame({ textPart: { text: " world" } });
  const combined = new Uint8Array(f1.length + f2.length);
  combined.set(f1, 0);
  combined.set(f2, f1.length);

  const parser = new ConnectFrameParser();
  const splitAt = 3;
  parser.push(combined.subarray(0, splitAt));
  let frames = await parser.drainAvailableFrames();
  assert.equal(frames.length, 0);

  parser.push(combined.subarray(splitAt));
  frames = await parser.drainAvailableFrames();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].json?.textPart, { text: "hello" });
  assert.deepEqual(frames[1].json?.textPart, { text: " world" });
});

test("encodeSseData formats SSE line", () => {
  const line = new TextDecoder().decode(encodeSseData({ a: 1 }));
  assert.equal(line, 'data: {"a":1}\n\n');
});

test("OpenAI SSE stream emits multiple data lines for incremental text frames", async () => {
  const payloads = [
    encodeConnectFrame({ textPart: { text: "hel" } }),
    encodeConnectFrame({ textPart: { text: "lo" } }),
  ];
  const stream = buildOpenAiSseStreamFromFramePayloads({
    frameChunks: payloads,
    model: "composer-2.5",
    conversationId: "sess-abc12345",
  });
  const text = await new Response(stream).text();
  const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
  assert.ok(dataLines.length >= 4, `expected multiple SSE chunks, got ${dataLines.length}`);
  assert.ok(text.includes('"content":"hel"'));
  assert.ok(text.includes('"content":"lo"'));
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("OpenAI SSE stream emits error field from Connect error frame", async () => {
  const err = { message: "rate limited", code: "RESOURCE_EXHAUSTED" };
  const payloads = [encodeConnectFrame({ error: err }), encodeConnectFrame({ textPart: { text: "x" } })];
  const stream = buildOpenAiSseStreamFromFramePayloads({
    frameChunks: payloads,
    model: "composer-2.5",
    conversationId: "sess-err1234",
  });
  const text = await new Response(stream).text();
  assert.ok(text.includes('"error":'), text);
  assert.ok(text.includes("rate limited"), text);
  const finishLine = text.split("\n").find((l) => l.includes('"finish_reason":"stop"'));
  assert.ok(finishLine?.includes('"error":'), finishLine);
});

test("OpenAI SSE stream emits complete tool_calls delta at end (not incremental fragments)", async () => {
  const payloads = [
    encodeConnectFrame({
      toolCallPart: {
        toolCallId: "call_abc",
        toolIndex: 0,
        toolName: "get_weather",
        args: '{"city":',
      },
    }),
    encodeConnectFrame({
      toolCallPart: {
        toolCallId: "call_abc",
        toolIndex: 0,
        args: '"SF"}',
        isComplete: true,
      },
    }),
  ];
  const stream = buildOpenAiSseStreamFromFramePayloads({
    frameChunks: payloads,
    model: "composer-2.5-fast",
    conversationId: "sess-tool123",
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
  });
  const text = await new Response(stream).text();
  assert.ok(text.includes('"tool_calls"'), text);
  assert.ok(text.includes('"name":"get_weather"'), text);
  assert.ok(text.includes('"arguments":"{\\"city\\":\\"SF\\"}"'), text);
  assert.ok(text.includes('"finish_reason":"tool_calls"'), text);
  const toolCallChunks = text.split("\n").filter((l) => l.includes('"delta":{"tool_calls"'));
  assert.equal(toolCallChunks.length, 1, `expected one tool_calls delta chunk, got ${toolCallChunks.length}`);
});

test("upstreamAbortFromClient aborts when client signal aborts", () => {
  const client = new AbortController();
  const upstream = upstreamAbortFromClient(client.signal);
  assert.equal(upstream.signal.aborted, false);
  client.abort("bye");
  assert.equal(upstream.signal.aborted, true);
  assert.equal(upstream.signal.reason, "bye");
});

test("Anthropic SSE stream emits event-named text deltas and complete tool_use at end", async () => {
  const payloads = [
    encodeConnectFrame({ thinkingPart: { text: "hmm", signature: "verified-signature" } }),
    encodeConnectFrame({ textPart: { text: "hi" } }),
    encodeConnectFrame({
      toolCallPart: { toolCallId: "call_1", toolIndex: 0, toolName: "lookup", args: '{"q":"a"}', isComplete: true },
    }),
  ];
  const stream = buildAnthropicSseStreamFromFramePayloads({
    frameChunks: payloads,
    model: "composer-2.5-fast",
    conversationId: "sess-ant123",
    tools: [{ name: "lookup", description: "", parameters: { type: "object", properties: { q: { type: "string" } } } }],
  });
  const text = await new Response(stream).text();
  assert.ok(text.includes("event: message_start"), text);
  assert.ok(text.includes("event: content_block_delta"), text);
  assert.ok(text.includes('"thinking":"hmm"'), text);
  assert.ok(text.includes('"text":"hi"'), text);
  assert.ok(text.includes('"type":"tool_use"'), text);
  assert.ok(text.includes('"name":"lookup"'), text);
  assert.ok(text.includes('"content_block":{"type":"tool_use","id":"call_1","name":"lookup","input":{}}'), text);
  assert.ok(text.includes('"type":"input_json_delta","partial_json":"{\\"q\\":\\"a\\"}"'), text);
  assert.ok(text.includes('"stop_reason":"tool_use"'), text);
  assert.ok(text.includes("event: message_stop"), text);
  const toolStarts = text.split("event: content_block_start").filter((s) => s.includes("tool_use"));
  assert.equal(toolStarts.length, 1, "expected one complete tool_use block");
});

test("Anthropic SSE stream emits full usage and max_tokens stop reason", async () => {
  const stream = buildAnthropicSseStreamFromFramePayloads({
    frameChunks: [
      encodeConnectFrame({
        textPart: { text: "cut" },
        usage: { promptTokens: 20, completionTokens: 3 },
        extendedUsage: { cacheReadTokens: 12, cacheWriteTokens: 5 },
      }),
    ],
    model: "composer-2.5-fast",
    conversationId: "sess-ant-usage",
    maxTokens: 3,
  });
  const text = await new Response(stream).text();
  assert.ok(text.includes('"stop_reason":"max_tokens"'), text);
  assert.ok(text.includes('"input_tokens":3'), text);
  assert.ok(text.includes('"output_tokens":3'), text);
  assert.ok(text.includes('"cache_creation_input_tokens":5'), text);
  assert.ok(text.includes('"cache_read_input_tokens":12'), text);
});

test("Anthropic SSE stream emits signature_delta only for plaintext thinking", async () => {
  const stream = buildAnthropicSseStreamFromFramePayloads({
    frameChunks: [
      encodeConnectFrame({ thinkingPart: { text: "hmm", signature: "verified-signature" } }),
      encodeConnectFrame({ textPart: { text: "ok" } }),
    ],
    model: "composer-2.5-fast",
    conversationId: "sess-ant-signature",
  });
  const text = await new Response(stream).text();
  const events = text.split("\n\n").filter(Boolean);
  const thinkingStop = events.findIndex((event) => event.includes('"type":"content_block_stop","index":0'));
  const textStart = events.findIndex((event) => event.includes('"content_block":{"type":"text"'));
  assert.ok(thinkingStop >= 0 && textStart > thinkingStop, text);
  assert.ok(text.includes('"type":"signature_delta","signature":"verified-signature"'), text);
  assert.ok(text.indexOf("signature_delta") < text.indexOf('content_block_stop\ndata: {"type":"content_block_stop","index":0}'), text);
});

test("Anthropic SSE stream omits unsigned or late thinking without overlapping blocks", async () => {
  const unsigned = buildAnthropicSseStreamFromFramePayloads({
    frameChunks: [encodeConnectFrame({ thinkingPart: { text: "unsigned" } }), encodeConnectFrame({ textPart: { text: "ok" } })],
    model: "composer-2.5-fast",
    conversationId: "sess-ant-unsigned",
  });
  const unsignedText = await new Response(unsigned).text();
  assert.equal(unsignedText.includes("thinking_delta"), false, unsignedText);
  assert.ok(unsignedText.includes('"text":"ok"'), unsignedText);

  const late = buildAnthropicSseStreamFromFramePayloads({
    frameChunks: [
      encodeConnectFrame({ textPart: { text: "first" } }),
      encodeConnectFrame({ thinkingPart: { text: "late", signature: "late-signature" } }),
    ],
    model: "composer-2.5-fast",
    conversationId: "sess-ant-late",
  });
  const lateText = await new Response(late).text();
  assert.equal(lateText.includes("thinking_delta"), false, lateText);
  assert.equal(lateText.includes("signature_delta"), false, lateText);
});

test("Anthropic SSE stream emits an Anthropic error event and no successful stop", async () => {
  const stream = buildAnthropicSseStreamFromFramePayloads({
    frameChunks: [
      encodeConnectFrame({ error: { code: "RESOURCE_EXHAUSTED", message: "rate limited" } }),
    ],
    model: "composer-2.5-fast",
    conversationId: "sess-ant-error",
  });
  const text = await new Response(stream).text();
  assert.ok(text.includes("event: error"), text);
  assert.ok(text.includes('"type":"rate_limit_error"'), text);
  assert.ok(text.includes("rate limited"), text);
  assert.equal(text.includes("event: message_stop"), false, text);
});

test("OpenAI SSE stream emits reasoning_content only for plaintext thinking", async () => {
  const stream = buildOpenAiSseStreamFromFramePayloads({
    frameChunks: [
      encodeConnectFrame({ thinkingPart: { text: "hmm", signature: "verified-signature" } }),
      encodeConnectFrame({ textPart: { text: "ok" } }),
    ],
    model: "composer-2.5-fast",
    conversationId: "sess-think-plain",
  });
  const text = await new Response(stream).text();
  assert.ok(text.includes('"reasoning_content":"hmm"'), text);
  assert.ok(text.includes('"content":"ok"'), text);
});

test("OpenAI SSE stream omits ciphertext thinking signature", async () => {
  const stream = buildOpenAiSseStreamFromFramePayloads({
    frameChunks: [
      encodeConnectFrame({ thinkingPart: { text: "", signature: "enc-blob-do-not-emit" } }),
      encodeConnectFrame({ textPart: { text: "323" } }),
    ],
    model: "grok-4.6",
    conversationId: "sess-think-cipher",
  });
  const text = await new Response(stream).text();
  assert.equal(text.includes("reasoning_content"), false, text);
  assert.equal(text.includes("enc-blob-do-not-emit"), false, text);
  assert.ok(text.includes('"content":"323"'), text);
});

test("Anthropic SSE stream omits ciphertext thinking signature", async () => {
  const stream = buildAnthropicSseStreamFromFramePayloads({
    frameChunks: [
      encodeConnectFrame({ thinkingPart: { signature: "enc-blob-do-not-emit" } }),
      encodeConnectFrame({ textPart: { text: "323" } }),
    ],
    model: "grok-4.6",
    conversationId: "sess-ant-cipher",
  });
  const text = await new Response(stream).text();
  assert.equal(text.includes("thinking_delta"), false, text);
  assert.equal(text.includes("signature_delta"), false, text);
  assert.equal(text.includes("enc-blob-do-not-emit"), false, text);
  assert.ok(text.includes('"text":"323"'), text);
});
