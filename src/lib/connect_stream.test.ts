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
    encodeConnectFrame({ thinkingPart: { text: "hmm" } }),
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
  assert.ok(text.includes('"stop_reason":"tool_use"'), text);
  assert.ok(text.includes("event: message_stop"), text);
  const toolStarts = text.split("event: content_block_start").filter((s) => s.includes("tool_use"));
  assert.equal(toolStarts.length, 1, "expected one complete tool_use block");
});
