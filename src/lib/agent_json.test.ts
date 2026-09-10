import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_ALLOWED_PROTO_TOOLS,
  buildRunRequest,
  clientCancelMessage,
  connectErrorMessage,
  gatewayAgentModelId,
  gatewayAgentModelSelection,
  mcpArgsToRecord,
  mcpSuccessResult,
  mcpToolDefinitions,
  parseMcpArgs,
  parseServerMessage,
  mergeAgentTurnUsage,
  promptCacheHitPercent,
  aggregatePromptCacheHitPercent,
} from "./agent_json.ts";

test("promptCacheHitPercent matches Team Usage CR/(CR+in_wo)", () => {
  assert.equal(promptCacheHitPercent({ inputTokens: 3672, outputTokens: 91, cacheReadTokens: 3616 }), 98.47);
  assert.equal(promptCacheHitPercent({ inputTokens: 1000, outputTokens: 1, cacheReadTokens: 0 }), 0);
});

test("aggregatePromptCacheHitPercent avoids cache_read/input_tokens session bug", () => {
  const row = { inputTokens: 1600, outputTokens: 10, cacheReadTokens: 1200 };
  const wrong = (1200 * 3) / (400 * 3);
  assert.ok(wrong > 2.9, "naive sum(cr)/sum(in_wo) can exceed 100%");
  assert.equal(aggregatePromptCacheHitPercent([row, row, row]), 75);
});

test("mergeAgentTurnUsage replaces cumulative snapshots", () => {
  const a = { inputTokens: 40, outputTokens: 4, cacheReadTokens: 30 };
  const b = { inputTokens: 40, outputTokens: 4, cacheReadTokens: 30 };
  assert.deepEqual(mergeAgentTurnUsage(a, b), {
    inputTokens: 40,
    outputTokens: 4,
    cacheReadTokens: 30,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
  });
});

test("mergeAgentTurnUsage adds segment deltas", () => {
  const a = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 };
  const b = { inputTokens: 50, outputTokens: 3, cacheReadTokens: 40 };
  assert.deepEqual(mergeAgentTurnUsage(a, b), {
    inputTokens: 150,
    outputTokens: 8,
    cacheReadTokens: 40,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
  });
});

test("mergeAgentTurnUsage keeps cache when a later snapshot omits it", () => {
  const snap = { inputTokens: 3672, outputTokens: 80, cacheReadTokens: 3616, cacheWriteTokens: 0 };
  const ended = { inputTokens: 3672, outputTokens: 91 };
  assert.deepEqual(mergeAgentTurnUsage(snap, ended), {
    inputTokens: 3672,
    outputTokens: 91,
    cacheReadTokens: 3616,
    cacheWriteTokens: 0,
    reasoningTokens: undefined,
  });
});
test("gatewayAgentModelId strips trailing -fast and defaults composer-2.5", () => {
  assert.equal(gatewayAgentModelId("composer-2.5-fast"), "composer-2.5");
  assert.equal(gatewayAgentModelId("grok-4.6-high-fast"), "grok-4.6");
  assert.equal(gatewayAgentModelId("auto"), "composer-2.5");
  assert.equal(gatewayAgentModelId(""), "composer-2.5");
});

test("gatewayAgentModelSelection sends explicit fast=false for composer-2.5", () => {
  assert.deepEqual(gatewayAgentModelSelection("composer-2.5"), {
    modelId: "composer-2.5",
    parameters: [{ id: "fast", value: "false" }],
  });
  assert.deepEqual(gatewayAgentModelSelection("composer-2.5-fast"), {
    modelId: "composer-2.5",
    parameters: [{ id: "fast", value: "true" }],
  });
  assert.deepEqual(gatewayAgentModelSelection("composer-2.5", { fast: true }), {
    modelId: "composer-2.5",
    parameters: [{ id: "fast", value: "true" }],
  });
  assert.deepEqual(gatewayAgentModelSelection("grok-4.6"), {
    modelId: "grok-4.6",
    parameters: [
      { id: "fast", value: "false" },
      { id: "effort", value: "high" },
    ],
  });
  assert.deepEqual(gatewayAgentModelSelection("grok-4.6-fast"), {
    modelId: "grok-4.6",
    parameters: [
      { id: "fast", value: "true" },
      { id: "effort", value: "high" },
    ],
  });
  assert.deepEqual(gatewayAgentModelSelection("grok-4.6-low"), {
    modelId: "grok-4.6",
    parameters: [
      { id: "fast", value: "false" },
      { id: "effort", value: "low" },
    ],
  });
  assert.deepEqual(gatewayAgentModelSelection("grok-4.6-fast", { reasoningEffort: "max" }), {
    modelId: "grok-4.6",
    parameters: [
      { id: "fast", value: "true" },
      { id: "effort", value: "xhigh" },
    ],
  });
  assert.deepEqual(gatewayAgentModelSelection("cursor-grok-4.6-medium-fast"), {
    modelId: "grok-4.6",
    parameters: [
      { id: "fast", value: "true" },
      { id: "effort", value: "medium" },
    ],
  });
  assert.deepEqual(gatewayAgentModelSelection("grok-4.5-fast", { reasoningEffort: "max" }), {
    modelId: "grok-4.5",
    parameters: [
      { id: "fast", value: "true" },
      { id: "effort", value: "high" },
    ],
  });
  assert.deepEqual(gatewayAgentModelSelection("gpt-5.6-luna"), { modelId: "gpt-5.6-luna" });
});

test("mcp allowlist is the MCP proto family, not shell/edit", () => {
  assert.ok(MCP_ALLOWED_PROTO_TOOLS.includes("mcp_tool_call"));
  assert.ok(MCP_ALLOWED_PROTO_TOOLS.includes("get_mcp_tools_tool_call"));
  assert.ok(!MCP_ALLOWED_PROTO_TOOLS.some((n) => n.includes("shell")));
  assert.ok(!MCP_ALLOWED_PROTO_TOOLS.some((n) => n.includes("edit")));
});

test("mcp tool definitions use custom-user-tools wire names", () => {
  const defs = mcpToolDefinitions([{ name: "get_weather", description: "wx", inputSchema: { type: "object" } }]);
  assert.equal(defs[0]?.name, "custom-user-tools-get_weather");
  assert.equal(defs[0]?.providerIdentifier, "custom-user-tools");
  assert.equal(defs[0]?.toolName, "get_weather");
  assert.match(String(defs[0]?.inputSchemaJson), /object/);
});

test("buildRunRequest omits excludeWorkspaceContext and only carries mcp tools", () => {
  const req = buildRunRequest({
    prompt: "hi",
    modelId: "composer-2.5",
    conversationId: "c1",
    runId: "r1",
    agentSessionId: "a1",
    tools: [{ name: "lookup" }],
  });
  assert.equal(req.excludeWorkspaceContext, undefined);
  assert.equal((req.mcpFileSystemOptions as { enabled: boolean }).enabled, false);
  const rm = req.requestedModel as { modelId: string; parameters?: Array<{ id: string; value: string }> };
  assert.equal(rm.modelId, "composer-2.5");
  assert.deepEqual(rm.parameters, [{ id: "fast", value: "false" }]);
  const tools = (req.mcpTools as { mcpTools: Array<{ toolName: string }> }).mcpTools;
  assert.equal(tools[0]?.toolName, "lookup");
});

test("buildRunRequest does not send customSystemPrompt", () => {
  const req = buildRunRequest({
    prompt: "hi",
    modelId: "composer-2.5",
    conversationId: "c1",
    runId: "r1",
    agentSessionId: "a1",
    tools: [],
  });
  assert.equal(req.customSystemPrompt, undefined);
});

test("buildRunRequest sends trimmed customSystemPrompt when provided", () => {
  const req = buildRunRequest({
    prompt: "hi",
    modelId: "composer-2.5",
    conversationId: "c1",
    runId: "r1",
    agentSessionId: "a1",
    tools: [],
    customSystemPrompt: "  You are ProbeOverride.  ",
  });
  assert.equal(req.customSystemPrompt, "You are ProbeOverride.");
});

test("buildRunRequest omits empty conversationState and uses resumeAction", () => {
  const plain = buildRunRequest({
    prompt: "hi",
    modelId: "composer-2.5",
    conversationId: "c1",
    runId: "r1",
    agentSessionId: "a1",
    tools: [{ name: "lookup" }],
  });
  assert.equal(plain.conversationState, undefined);
  assert.ok((plain.action as { userMessageAction?: unknown }).userMessageAction);
  const resumed = buildRunRequest({
    prompt: "",
    modelId: "composer-2.5",
    conversationId: "c1",
    runId: "r1",
    agentSessionId: "a1",
    tools: [{ name: "lookup" }],
    resume: true,
    conversationState: { rootPromptMessagesJson: ["abc"] },
  });
  assert.deepEqual((resumed.action as { resumeAction?: unknown }).resumeAction, {});
  assert.equal((resumed.action as { userMessageAction?: unknown }).userMessageAction, undefined);
  assert.deepEqual(resumed.conversationState, { rootPromptMessagesJson: ["abc"] });
  const tools = (resumed.mcpTools as { mcpTools: Array<{ toolName: string }> }).mcpTools;
  assert.equal(tools[0]?.toolName, "lookup");
});

test("parseServerMessage reads camelCase and snake_case interaction updates", () => {
  assert.deepEqual(
    parseServerMessage({ interactionUpdate: { textDelta: { text: "Hello" } } }),
    { kind: "textDelta", text: "Hello" },
  );
  assert.equal(parseServerMessage({ interaction_update: { turn_ended: {} } }).kind, "turnEnded");
  assert.equal(
    parseServerMessage({ execServerMessage: { id: 1, execId: "e", mcpArgs: { name: "x" } } }).kind,
    "exec",
  );
});

test("parseServerMessage reads thinkingDelta (proto oneof and SDK type)", () => {
  assert.deepEqual(
    parseServerMessage({ interactionUpdate: { thinkingDelta: { text: "step 1" } } }),
    { kind: "thinkingDelta", text: "step 1" },
  );
  assert.deepEqual(
    parseServerMessage({ interaction_update: { thinking_delta: { text: "step 2" } } }),
    { kind: "thinkingDelta", text: "step 2" },
  );
  assert.deepEqual(
    parseServerMessage({ interactionUpdate: { type: "thinking-delta", text: "step 3" } }),
    { kind: "thinkingDelta", text: "step 3" },
  );
  assert.deepEqual(
    parseServerMessage({ interactionUpdate: { type: "text-delta", text: "Hello" } }),
    { kind: "textDelta", text: "Hello" },
  );
});

test("buildRunRequest attaches inline images and clientSupportsInlineImages", () => {
  const req = buildRunRequest({
    prompt: "what is this?",
    modelId: "composer-2.5",
    conversationId: "c1",
    runId: "r1",
    agentSessionId: "a1",
    tools: [],
    images: [{ uuid: "u1", path: "image-u1.png", mimeType: "image/png", data: "aaaa" }],
  });
  assert.equal(req.clientSupportsInlineImages, true);
  const user = (req.action as { userMessageAction: { userMessage: Record<string, unknown> } }).userMessageAction.userMessage;
  assert.equal(user.text, "what is this?");
  const images = (user.selectedContext as { selectedImages: Array<{ data: string; mimeType: string }> }).selectedImages;
  assert.equal(images.length, 1);
  assert.equal(images[0]?.data, "aaaa");
  assert.equal(images[0]?.mimeType, "image/png");
  const plain = buildRunRequest({
    prompt: "hi",
    modelId: "composer-2.5",
    conversationId: "c1",
    runId: "r1",
    agentSessionId: "a1",
    tools: [],
  });
  assert.equal(plain.clientSupportsInlineImages, undefined);
});

test("parseServerMessage reads turnEnded usage (proto JSON + nested SDK shape)", () => {
  const flat = parseServerMessage({
    interactionUpdate: {
      turnEnded: { inputTokens: "1200", outputTokens: "80", cacheReadTokens: "1100", cacheWriteTokens: "0" },
    },
  });
  assert.equal(flat.kind, "turnEnded");
  if (flat.kind !== "turnEnded") throw new Error("expected turnEnded");
  assert.deepEqual(flat.usage, {
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: 1100,
    cacheWriteTokens: 0,
    reasoningTokens: undefined,
  });
  const nested = parseServerMessage({
    interaction_update: {
      turn_ended: { usage: { input_tokens: 20, output_tokens: 3, cache_read_tokens: 12, reasoning_tokens: 2 } },
    },
  });
  assert.equal(nested.kind, "turnEnded");
  if (nested.kind !== "turnEnded") throw new Error("expected turnEnded");
  assert.equal(nested.usage?.inputTokens, 20);
  assert.equal(nested.usage?.cacheReadTokens, 12);
  assert.equal(nested.usage?.reasoningTokens, 2);
});

test("mcp args unwrap protobuf Value JSON and plain JSON", () => {
  assert.deepEqual(mcpArgsToRecord({ city: { stringValue: "Tokyo" } }), { city: "Tokyo" });
  assert.deepEqual(mcpArgsToRecord({ city: "Osaka" }), { city: "Osaka" });
  const parsed = parseMcpArgs({
    mcpArgs: {
      name: "custom-user-tools-get_weather",
      providerIdentifier: "custom-user-tools",
      args: { city: { stringValue: "Tokyo" } },
      toolCallId: "call_1",
    },
  });
  assert.equal(parsed?.toolName, "get_weather");
  assert.equal(parsed?.args.city, "Tokyo");
  assert.equal(parsed?.toolCallId, "call_1");
});

test("mcpSuccessResult is a complete exec client message", () => {
  const msg = mcpSuccessResult(3, "exec-1", '{"ok":true}', false);
  const exec = msg.execClientMessage as { id: number; mcpResult: { success: { isError: boolean } } };
  assert.equal(exec.id, 3);
  assert.equal(exec.mcpResult.success.isError, false);
});

test("clientCancelMessage is ConversationAction.cancelAction", () => {
  const msg = clientCancelMessage();
  assert.deepEqual(msg, { conversationAction: { cancelAction: {} } });
});

test("connectErrorMessage reads Connect error envelopes", () => {
  assert.equal(connectErrorMessage({ code: "unauthenticated", message: "nope" }), "unauthenticated: nope");
  assert.equal(connectErrorMessage(null, 401), "AgentService HTTP 401");
});
