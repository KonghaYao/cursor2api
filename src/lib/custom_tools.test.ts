import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  anthropicToolsToCustom,
  clientToolsDisabled,
  clientToolsToOpenAi,
  customToolsClearForTests,
  extractClientToolResults,
  lastTurnIsToolResult,
  sanitizeCustomToolName,
  openaiToolsToCustom,
  parkClientToolCall,
  resolveClientToolResults,
  toolPolicyPrompt,
  upsertClientToolSession,
} from "./custom_tools.ts";
import {
  SDK_CUSTOM_ONLY_BUILTIN_TOOLS,
  sdkLocalAgentCreateOptions,
} from "./custom_tool_chat.ts";
import { MCP_ALLOWED_PROTO_TOOLS } from "./agent_json.ts";

afterEach(() => {
  customToolsClearForTests();
});

test("openai tools map to custom tool names and schemas", () => {
  const tools = openaiToolsToCustom([
    { type: "function", function: { name: "get_weather", description: "wx", parameters: { type: "object", properties: { city: { type: "string" } } } } },
    { type: "function", function: { name: "get.weather", parameters: { type: "object" } } },
  ]);
  assert.equal(tools[0]?.name, "get_weather");
  assert.equal(tools[0]?.openaiName, "get_weather");
  assert.equal(tools[1]?.name, "get_weather_2");
  assert.equal(sanitizeCustomToolName("foo.bar"), "foo_bar");
});

test("anthropic custom tools map the same way", () => {
  const tools = anthropicToolsToCustom([{ name: "lookup", description: "d", input_schema: { type: "object", properties: {} } }]);
  assert.equal(tools[0]?.name, "lookup");
  assert.equal(tools[0]?.inputSchema.type, "object");
});

test("tool_choice none disables client tools", () => {
  assert.equal(clientToolsDisabled({ tool_choice: "none" }), true);
  assert.equal(clientToolsDisabled({ tool_choice: { type: "none" } }), true);
  assert.equal(clientToolsDisabled({ tool_choice: "auto" }), false);
});

test("tool policy requires a named tool", () => {
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const text = toolPolicyPrompt({ tool_choice: { type: "function", function: { name: "lookup" } } }, tools);
  assert.match(text, /MUST call the tool named lookup/);
});

test("lastTurnIsToolResult and extractClientToolResults", () => {
  assert.equal(lastTurnIsToolResult([{ role: "user", content: "hi" }]), false);
  assert.equal(
    lastTurnIsToolResult([
      { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] },
      { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
    ]),
    true,
  );
  const rows = extractClientToolResults([
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "nope" }] },
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["call_1", "call_2"],
  );
});

test("parked customTools.execute resolves when the client posts tool results", async () => {
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "get_weather" } }]);
  const session = upsertClientToolSession("tenant", "sess-1", tools);
  const parked = parkClientToolCall(session, "get_weather", { city: "Tokyo" });
  const batch = session.parked.filter((p) => !p.offered);
  assert.equal(batch.length, 1);
  const oai = clientToolsToOpenAi(batch);
  assert.equal(oai[0]?.function.name, "get_weather");
  assert.equal(JSON.parse(oai[0]!.function.arguments).city, "Tokyo");
  const n = resolveClientToolResults(session, [{ id: batch[0]!.id, content: "{\"temp\":22}" }]);
  assert.equal(n, 1);
  const result = await parked;
  assert.equal(result.isError, undefined);
  assert.match(result.content[0]!.text, /temp/);
});

test("sdk local agent allowlists only mcp so customTools work and builtins stay off", () => {
  const opts = sdkLocalAgentCreateOptions({
    apiKey: "k",
    model: "composer-2.5-fast",
    customTools: {},
    cwd: "/tmp/gateway-agent-cwd",
  });
  assert.deepEqual(opts.tools, ["mcp"]);
  assert.deepEqual(SDK_CUSTOM_ONLY_BUILTIN_TOOLS, ["mcp"]);
  assert.deepEqual(opts.model, { id: "composer-2.5" });
  const local = opts.local as { cwd: string; settingSources: unknown[]; customTools: unknown };
  assert.equal(local.cwd, "/tmp/gateway-agent-cwd");
  assert.deepEqual(local.settingSources, []);
  assert.equal(opts.cloud, undefined);
  assert.ok(!JSON.stringify(opts.tools).includes("shell"));
  assert.ok(!JSON.stringify(opts.tools).includes("edit"));
  assert.deepEqual([...MCP_ALLOWED_PROTO_TOOLS], [
    "mcp_tool_call",
    "get_mcp_tools_tool_call",
    "list_mcp_resources_tool_call",
    "read_mcp_resource_tool_call",
    "mcp_auth_tool_call",
  ]);
});
