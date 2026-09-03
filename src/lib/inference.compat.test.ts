import assert from "node:assert/strict";
import test from "node:test";
import {
  absorbThinkingPart,
  anthropicToCursor,
  applyToolPolicy,
  collectTurn,
  cursorBody,
  cursorBodyFromClient,
  extractMaxMode,
  extractMaxTokens,
  extractStopSequences,
  extractTopP,
  openaiMessagesToCursor,
  openaiProviderDefinedTools,
  openaiToolsToCursor,
  openAiReasoningFields,
  ROLE,
  toOpenAICompletion,
} from "./inference.ts";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("extractMaxMode reads body/extra_body/metadata", () => {
  assert.equal(extractMaxMode({ max_mode: true }), true);
  assert.equal(extractMaxMode({ extra_body: { maxMode: true } }), true);
  assert.equal(extractMaxMode({ metadata: { max: true } }), true);
  assert.equal(extractMaxMode({ model: "composer-2.5" }), false);
});

test("extractMaxTokens reads max_tokens then max_completion_tokens", () => {
  assert.equal(extractMaxTokens({ max_completion_tokens: 2048 }), 2048);
  assert.equal(extractMaxTokens({ max_tokens: 100, max_completion_tokens: 300 }), 100);
});

test("extractTopP and stop sequences", () => {
  assert.equal(extractTopP({ top_p: 0.8 }), 0.8);
  assert.deepEqual(extractStopSequences({ stop: "END" }), ["END"]);
  assert.deepEqual(extractStopSequences({ stop: ["A", "B"] }), ["A", "B"]);
});

test("cursorBody sets maxMode, topP, stopSequences, invocationId", () => {
  const body = cursorBody({
    messages: [{ role: ROLE.user, text: "hi" }],
    conversationId: "c1",
    model: "composer-2.5",
    maxMode: true,
    topP: 0.9,
    stopSequences: ["END"],
    invocationId: "inv-1",
    temperature: 0.2,
  });
  const rm = body.requestedModel as Record<string, unknown>;
  assert.equal(rm.maxMode, true);
  const cfg = body.modelConfig as Record<string, unknown>;
  assert.equal(cfg.topP, 0.9);
  assert.deepEqual(cfg.stopSequences, ["END"]);
  assert.equal(cfg.temperature, 0.2);
  assert.equal(body.invocationId, "inv-1");
});

test("tool_choice none drops tools", () => {
  const tools = [{ name: "x", description: "", parameters: { type: "object", properties: {} } }];
  const out = applyToolPolicy([{ role: ROLE.user, text: "hi" }], tools, { tool_choice: "none" });
  assert.equal(out.tools.length, 0);
  assert.equal(out.injectToolsPrompt, false);
});

test("tool_choice required injects policy and keeps tools", () => {
  const tools = [{ name: "x", description: "", parameters: { type: "object", properties: {} } }];
  const out = applyToolPolicy([{ role: ROLE.user, text: "hi" }], tools, { tool_choice: "required", parallel_tool_calls: false });
  assert.equal(out.tools.length, 1);
  assert.equal(out.injectToolsPrompt, true);
  assert.ok(String(out.messages[0]?.text).includes("MUST call"));
  assert.ok(String(out.messages[0]?.text).includes("at most one"));
});

test("openaiProviderDefinedTools splits non-function tools", () => {
  const tools = [
    { type: "function", function: { name: "fn", parameters: { type: "object", properties: {} } } },
    { type: "web_search_preview" },
  ];
  assert.equal(openaiToolsToCursor(tools).map((t) => t.name).join(","), "fn");
  assert.equal(openaiProviderDefinedTools(tools)[0]?.type, "web_search_preview");
});

test("cursorBodyFromClient applies json_object response_format", () => {
  const body = cursorBodyFromClient(
    { model: "composer-2.5", response_format: { type: "json_object" } },
    { messages: [{ role: ROLE.user, text: "hi" }], tools: [], conversationId: "c1" },
  );
  const msgs = body.messages as Array<Record<string, unknown>>;
  assert.ok(JSON.stringify(msgs).includes("<output-format>"));
});

test("openaiMessagesToCursor maps file parts", async () => {
  const msgs = await openaiMessagesToCursor([
    {
      role: "user",
      content: [
        { type: "text", text: "read this" },
        { type: "file", file: { filename: "a.pdf", file_data: `data:application/pdf;base64,${TINY_PNG_B64}` } },
      ],
    },
  ]);
  const parts = (msgs[0]?.parts as { parts: Array<Record<string, unknown>> }).parts;
  const file = parts.find((p) => p.file) as { file: { data: string; mediaType: string; filename: string } };
  assert.equal(file.file.filename, "a.pdf");
  assert.equal(file.file.mediaType, "application/pdf");
  assert.equal(file.file.data, TINY_PNG_B64);
});

test("openaiMessagesToCursor maps tool result images to experimentalContent", async () => {
  const msgs = await openaiMessagesToCursor([
    {
      role: "tool",
      tool_call_id: "call_1",
      name: "screenshot",
      content: [
        { type: "text", text: "ok" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
      ],
    },
  ]);
  const part = (msgs[0]?.toolContent as { parts: Array<Record<string, unknown>> }).parts[0];
  assert.equal(part?.result, "ok");
  const exp = part?.experimentalContent as Array<Record<string, unknown>>;
  assert.ok(exp?.some((p) => p.image));
});

test("anthropicToCursor maps image and document blocks", async () => {
  const msgs = await anthropicToCursor({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 } },
        ],
      },
    ],
  });
  const parts = (msgs[0]?.parts as { parts: Array<Record<string, unknown>> }).parts;
  assert.deepEqual(parts[0], { text: { text: "look" } });
  assert.deepEqual(parts[1], { image: { data: TINY_PNG_B64, mimeType: "image/png" } });
});

test("openaiMessagesToCursor maps plaintext reasoning_content to reasoningParts", async () => {
  const msgs = await openaiMessagesToCursor([
    { role: "assistant", content: "323", reasoning_content: "17*19=323" },
  ]);
  assert.deepEqual(msgs[0]?.reasoningParts, [
    { isRedacted: false, text: "17*19=323", signature: undefined },
  ]);
});

test("collectTurn keeps plaintext thinking and drops signature-only ciphertext", () => {
  const plain = collectTurn([
    { flags: 0, end: false, json: { thinkingPart: { text: "step 1" } } },
    { flags: 0, end: false, json: { thinkingPart: { text: " step 2" } } },
    { flags: 0, end: true, json: { textPart: { text: "323" } } },
  ]);
  assert.equal(plain.thinking, "step 1 step 2");
  assert.equal(plain.thinkingRedacted, false);
  assert.deepEqual(openAiReasoningFields(plain), { reasoning_content: "step 1 step 2" });

  const cipher = collectTurn([
    { flags: 0, end: false, json: { thinkingPart: { text: "", signature: "enc-blob" } } },
    { flags: 0, end: true, json: { textPart: { text: "323" } } },
  ]);
  assert.equal(cipher.thinking, "");
  assert.equal(cipher.thinkingSignature, "enc-blob");
  assert.equal(cipher.thinkingRedacted, true);
  assert.deepEqual(openAiReasoningFields(cipher), {});

  const fromInfo = collectTurn([
    {
      flags: 0,
      end: true,
      json: {
        responseInfo: {
          messages: [{ reasoningParts: [{ text: "from info", isRedacted: false }] }],
        },
      },
    },
  ]);
  assert.equal(fromInfo.thinking, "from info");
});

test("toOpenAICompletion exposes reasoning_content not reasoning or signature", () => {
  const completion = toOpenAICompletion({
    model: "grok-4.6",
    conversationId: "sess-think1",
    turn: {
      status: 200,
      frames: [],
      text: "323",
      thinking: "17*19",
      thinkingSignature: "enc-blob",
      thinkingRedacted: false,
      usage: null,
      extendedUsage: null,
      providerMetadata: null,
      error: null,
      toolCalls: [],
      imageDescriptions: [],
    },
  });
  const message = completion.choices[0]?.message as Record<string, unknown>;
  assert.equal(message.reasoning_content, "17*19");
  assert.equal(message.reasoning, undefined);
  assert.equal(message.reasoning_signature, undefined);
});

test("absorbThinkingPart never promotes signature to thinking text", () => {
  const out = absorbThinkingPart({ thinking: "" }, { signature: "cipher", text: "" });
  assert.equal(out.thinking, "");
  assert.equal(out.thinkingSignature, "cipher");
  assert.equal(out.thinkingRedacted, true);
});
