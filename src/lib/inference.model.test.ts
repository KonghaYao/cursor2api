import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorBody,
  extractFastMode,
  GROK_MIN_MAX_TOKENS,
  isGrokModel,
  normalizeMaxTokensForModel,
  resolveCursorModelRoute,
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
