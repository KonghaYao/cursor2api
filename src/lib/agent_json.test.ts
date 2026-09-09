import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_ALLOWED_PROTO_TOOLS,
  buildRunRequest,
  connectErrorMessage,
  gatewayAgentModelId,
  gatewayAgentModelSelection,
  mcpArgsToRecord,
  mcpSuccessResult,
  mcpToolDefinitions,
  parseMcpArgs,
  parseServerMessage,
} from "./agent_json.ts";

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

test("connectErrorMessage reads Connect error envelopes", () => {
  assert.equal(connectErrorMessage({ code: "unauthenticated", message: "nope" }), "unauthenticated: nope");
  assert.equal(connectErrorMessage(null, 401), "AgentService HTTP 401");
});
