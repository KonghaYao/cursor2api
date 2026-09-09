import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_ALLOWED_PROTO_TOOLS,
  buildRunRequest,
  connectErrorMessage,
  gatewayAgentModelId,
  mcpArgsToRecord,
  mcpSuccessResult,
  mcpToolDefinitions,
  parseMcpArgs,
  parseServerMessage,
} from "./agent_json.ts";

test("gatewayAgentModelId strips trailing -fast and defaults composer-2.5", () => {
  assert.equal(gatewayAgentModelId("composer-2.5-fast"), "composer-2.5");
  assert.equal(gatewayAgentModelId("auto"), "composer-2.5");
  assert.equal(gatewayAgentModelId(""), "composer-2.5");
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
  assert.equal((req.requestedModel as { modelId: string }).modelId, "composer-2.5");
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
