import assert from "node:assert/strict";
import test from "node:test";
import {
  countCursorImageParts,
  cursorBody,
  extractFastMode,
  GROK_MIN_MAX_TOKENS,
  ImageInputError,
  isGrokModel,
  normalizeMaxTokensForModel,
  openaiMessagesToCursor,
  parseImageDataUrl,
  ROLE,
  resolveCursorModelRoute,
  upgradeGrokRouteForTools,
} from "./inference.ts";

test("resolveCursorModelRoute passes composer-2.5-fast unchanged", () => {
  const r = resolveCursorModelRoute("composer-2.5-fast");
  assert.equal(r.routeId, "composer-2.5-fast");
  assert.equal(r.clientModel, "composer-2.5-fast");
});

test("resolveCursorModelRoute maps composer-2.5 + fast flag to fast route", () => {
  const r = resolveCursorModelRoute("composer-2.5", { fast: true });
  assert.equal(r.routeId, "composer-2.5-fast");
});

test("grok-4.6-fast defaults to cursor-grok-4.6-high-fast", () => {
  const r = resolveCursorModelRoute("grok-4.6-fast");
  assert.equal(r.routeId, "cursor-grok-4.6-high-fast");
});

test("grok-4.6-fast + low maps to cursor-grok-4.6-low-fast", () => {
  const r = resolveCursorModelRoute("grok-4.6-fast", { reasoningEffort: "low" });
  assert.equal(r.routeId, "cursor-grok-4.6-low-fast");
});

test("grok-4.5-fast + max maps to high-fast (no xhigh on 4.5)", () => {
  const r = resolveCursorModelRoute("grok-4.5-fast", { reasoningEffort: "max" });
  assert.equal(r.routeId, "cursor-grok-4.5-high-fast");
});

test("grok-4.6-fast + max maps to cursor-grok-4.6-xhigh-fast", () => {
  const r = resolveCursorModelRoute("grok-4.6-fast", { reasoningEffort: "max" });
  assert.equal(r.routeId, "cursor-grok-4.6-xhigh-fast");
});

test("grok-4.6 + fast flag maps to high-fast", () => {
  const r = resolveCursorModelRoute("grok-4.6", { fast: true });
  assert.equal(r.routeId, "cursor-grok-4.6-high-fast");
});

test("grok-4.6-high-fast maps to cursor flat route", () => {
  const r = resolveCursorModelRoute("grok-4.6-high-fast");
  assert.equal(r.routeId, "cursor-grok-4.6-high-fast");
});

test("grok-4.6-xhigh-fast maps to cursor flat route", () => {
  const r = resolveCursorModelRoute("grok-4.6-xhigh-fast");
  assert.equal(r.routeId, "cursor-grok-4.6-xhigh-fast");
});

test("grok-4.6-medium maps to cursor flat route", () => {
  const r = resolveCursorModelRoute("grok-4.6-medium");
  assert.equal(r.routeId, "cursor-grok-4.6-medium");
});

test("grok-4.6-high-fast + reasoning_effort overrides embedded effort", () => {
  const r = resolveCursorModelRoute("grok-4.6-high-fast", { reasoningEffort: "low" });
  assert.equal(r.routeId, "cursor-grok-4.6-low-fast");
});

test("upgradeGrokRouteForTools appends -fast for tool calls on standard Grok routes", () => {
  assert.equal(upgradeGrokRouteForTools("cursor-grok-4.6-high", true), "cursor-grok-4.6-high-fast");
  assert.equal(upgradeGrokRouteForTools("cursor-grok-4.6-high", false), "cursor-grok-4.6-high");
  assert.equal(upgradeGrokRouteForTools("cursor-grok-4.6-high-fast", true), "cursor-grok-4.6-high-fast");
});

test("cursorBody upgrades grok-4.6 to fast route when tools are present", () => {
  const body = cursorBody({
    messages: [{ role: "INFERENCE_MESSAGE_ROLE_USER", text: "hi" }],
    conversationId: "c1",
    model: "grok-4.6",
    tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
  });
  assert.equal(body.modelId, "cursor-grok-4.6-high-fast");
});

test("cursorBody keeps grok-4.6 standard route without tools", () => {
  const body = cursorBody({
    messages: [{ role: "INFERENCE_MESSAGE_ROLE_USER", text: "hi" }],
    conversationId: "c1",
    model: "grok-4.6",
  });
  assert.equal(body.modelId, "cursor-grok-4.6-high");
});

test("grok-4.6 standard maps to cursor flat route without parameters", () => {
  const body = cursorBody({
    messages: [{ role: "INFERENCE_MESSAGE_ROLE_USER", text: "hi" }],
    conversationId: "c1",
    model: "grok-4.6",
    reasoningEffort: "medium",
  });
  assert.equal(body.modelId, "cursor-grok-4.6-medium");
  const rm = body.requestedModel as Record<string, unknown>;
  assert.equal(rm.modelId, "cursor-grok-4.6-medium");
  assert.equal(rm.parameters, undefined);
});

test("cursorBody composer fast route", () => {
  const body = cursorBody({
    messages: [{ role: "INFERENCE_MESSAGE_ROLE_USER", text: "hi" }],
    conversationId: "c1",
    model: "composer-2.5",
    fast: true,
  });
  assert.equal(body.modelId, "composer-2.5-fast");
});

test("extractFastMode reads metadata.fast", () => {
  assert.equal(extractFastMode({ metadata: { fast: true } }), true);
  assert.equal(extractFastMode({ model: "composer-2.5-fast" }), false);
});

test("isGrokModel detects public and cursor flat routes", () => {
  assert.equal(isGrokModel("cursor-grok-4.6-high-fast"), true);
  assert.equal(isGrokModel("composer-2.5-fast", "composer-2.5-fast"), false);
  assert.equal(isGrokModel("grok-4.6", "grok-4.6"), true);
  assert.equal(isGrokModel("grok-4.6-high-fast", "grok-4.6-high-fast"), true);
});

test("normalizeMaxTokensForModel floors low Grok caps", () => {
  assert.equal(normalizeMaxTokensForModel("cursor-grok-4.6-high-fast", "grok-4.6-fast", 64), GROK_MIN_MAX_TOKENS);
  assert.equal(normalizeMaxTokensForModel("composer-2.5-fast", "composer-2.5-fast", 64), 64);
  assert.equal(normalizeMaxTokensForModel("cursor-grok-4.6-high", "grok-4.6", 1024), 1024);
});

test("cursorBody applies Grok max_tokens floor", () => {
  const body = cursorBody({
    messages: [{ role: "INFERENCE_MESSAGE_ROLE_USER", text: "hi" }],
    conversationId: "c1",
    model: "grok-4.6-fast",
    maxTokens: 64,
  });
  const cfg = body.modelConfig as Record<string, unknown>;
  assert.equal(cfg.maxTokens, GROK_MIN_MAX_TOKENS);
});

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

test("parseImageDataUrl extracts mime and raw base64", () => {
  const parsed = parseImageDataUrl(TINY_PNG_DATA_URL);
  assert.equal(parsed?.mimeType, "image/png");
  assert.equal(parsed?.data, TINY_PNG_B64);
});

test("openaiMessagesToCursor keeps text-only user messages as text", async () => {
  const msgs = await openaiMessagesToCursor([{ role: "user", content: "hello" }]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]?.role, ROLE.user);
  assert.equal(msgs[0]?.text, "hello");
  assert.equal(msgs[0]?.parts, undefined);
});

test("openaiMessagesToCursor maps image_url data URI to InferenceImagePart", async () => {
  const msgs = await openaiMessagesToCursor([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
      ],
    },
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]?.text, undefined);
  const parts = (msgs[0]?.parts as { parts: unknown[] }).parts;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { text: { text: "what is this?" } });
  assert.deepEqual(parts[1], { image: { data: TINY_PNG_B64, mimeType: "image/png" } });
  assert.equal(countCursorImageParts(msgs), 1);
});

test("openaiMessagesToCursor fetches http(s) image_url", async () => {
  const png = Buffer.from(TINY_PNG_B64, "base64");
  const fakeFetch: typeof fetch = async (input) => {
    assert.equal(String(input), "https://example.test/dot.png");
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  };
  const msgs = await openaiMessagesToCursor(
    [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.test/dot.png" } }],
      },
    ],
    { fetch: fakeFetch },
  );
  const parts = (msgs[0]?.parts as { parts: Array<{ image?: { data: string; mimeType: string } }> }).parts;
  assert.equal(parts[0]?.image?.mimeType, "image/png");
  assert.equal(parts[0]?.image?.data, TINY_PNG_B64);
});

test("openaiMessagesToCursor rejects non-http image URLs", async () => {
  await assert.rejects(
    () =>
      openaiMessagesToCursor([
        { role: "user", content: [{ type: "image_url", image_url: { url: "file:///tmp/x.png" } }] },
      ]),
    (err: unknown) => {
      assert.ok(err instanceof ImageInputError);
      return true;
    },
  );
});
