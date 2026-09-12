import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  anthropicToolsToCustom,
  clientToolsDisabled,
  clientToolsToOpenAi,
  customToolsClearForTests,
  extractClientToolResults,
  extractLatestClientToolResults,
  lastTurnIsToolResult,
  sanitizeCustomToolName,
  openaiToolsToCustom,
  parkClientToolCall,
  resolveClientToolResults,
  toolPolicyPrompt,
  upsertClientToolSession,
  composeToolResultPrompt,
} from "./custom_tools.ts";
import {
  SDK_CUSTOM_ONLY_BUILTIN_TOOLS,
  composeCustomToolPrompt,
  composeCustomToolTurnPrompt,
  joinUserPrompts,
  sdkLocalAgentCreateOptions,
  systemPromptFromClient,
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

test("openai custom/mcp tool payloads still park as client tools", () => {
  const tools = openaiToolsToCustom([
    { type: "custom", name: "Write", description: "write a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    { type: "mcp", name: "lookup", description: "mcp lookup" },
    { type: "web_search_preview" },
  ]);
  assert.deepEqual(tools.map((t) => t.openaiName), ["Write", "lookup"]);
  assert.equal(tools[0]?.inputSchema.properties && typeof tools[0].inputSchema.properties, "object");
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

test("tool policy says listed Write/Edit/Bash are available", () => {
  const tools = openaiToolsToCustom([
    { type: "function", function: { name: "Write" } },
    { type: "custom", name: "Edit" },
    { type: "function", function: { name: "Bash" } },
  ]);
  const text = toolPolicyPrompt({ tool_choice: "auto" }, tools);
  assert.match(text, /Client tools available this turn: Write, Edit, Bash/);
  assert.match(text, /do not say they are unavailable/);
  assert.match(text, /Native Cursor Edit\/Write\/Bash/);
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

test("extractLatestClientToolResults keeps only the last assistant tool round", () => {
  const full = [
    { role: "user", content: "weather in tokyo?" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":22}' },
    { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_2", content: '{"humidity":40}' },
  ];
  assert.deepEqual(
    extractLatestClientToolResults(full).map((r) => r.id),
    ["call_2"],
  );
  assert.deepEqual(
    extractClientToolResults(full).map((r) => r.id),
    ["call_1", "call_2"],
  );
  const anthropic = [
    { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "lookup", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "old" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "u2", name: "lookup", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "new" }] },
  ];
  assert.deepEqual(
    extractLatestClientToolResults(anthropic).map((r) => ({ id: r.id, content: r.content })),
    [{ id: "u2", content: "new" }],
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

test("system and Anthropic body.system are read but not folded into the user prompt", () => {
  const openai = systemPromptFromClient({
    messages: [
      { role: "system", content: "Reply with exactly TOKEN" },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(openai, "Reply with exactly TOKEN");
  const anthropic = systemPromptFromClient({
    system: [{ type: "text", text: "be terse" }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(anthropic, "be terse");
  const prompt = composeCustomToolPrompt({
    body: { messages: [{ role: "system", content: "secret ALPHA" }, { role: "user", content: "code?" }] },
    tools: [],
    messages: [{ role: "system", content: "secret ALPHA" }, { role: "user", content: "code?" }],
  });
  assert.equal(prompt, "code?");
  assert.doesNotMatch(prompt, /<system>/);
  const follow = composeCustomToolPrompt({
    body: {
      messages: [
        { role: "system", content: "secret ALPHA" },
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    },
    tools: [],
    messages: [
      { role: "system", content: "secret ALPHA" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ],
    followUp: true,
  });
  assert.equal(follow, "second");
  assert.equal(follow.includes("secret ALPHA"), false);
  assert.equal(follow.includes("first"), false);
});

test("composeCustomToolTurnPrompt puts latest tool results on the user action", () => {
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "weather in tokyo?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":22}' },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_2", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_2", content: '{"humidity":40}' },
  ];
  const body = { model: "composer-2.5", messages };
  const warm = composeCustomToolTurnPrompt({ body, tools, messages, hadPriorTurn: true });
  assert.match(warm, /call_2/);
  assert.match(warm, /40/);
  assert.doesNotMatch(warm, /call_1/);
  const cold = composeCustomToolTurnPrompt({ body, tools, messages, hadPriorTurn: false });
  assert.match(cold, /call_2/);

  const nextUser = composeCustomToolTurnPrompt({
    body,
    tools,
    messages: [...messages, { role: "assistant", content: "22c 40%" }, { role: "user", content: "and osaka?" }],
    hadPriorTurn: true,
  });
  assert.equal(nextUser, "and osaka?");
});

test("composeCustomToolTurnPrompt slices multiple new users after priorMessageCount", () => {
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "lookup" } }]);
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
    { role: "user", content: "third" },
  ];
  const sliced = composeCustomToolTurnPrompt({
    body: { messages },
    tools,
    messages,
    hadPriorTurn: true,
    priorMessageCount: 2,
  });
  assert.equal(sliced, "second\n\nthird");
  assert.doesNotMatch(sliced, /first/);
  assert.doesNotMatch(sliced, /<system>/);
  assert.equal(joinUserPrompts(messages.slice(2)), "second\n\nthird");

  const sameLen = composeCustomToolTurnPrompt({
    body: { messages: messages.slice(0, 2) },
    tools,
    messages: messages.slice(0, 2),
    hadPriorTurn: true,
    priorMessageCount: 2,
  });
  assert.equal(sameLen, "first");
});

test("composeToolResultPrompt lists client tool output", () => {
  const text = composeToolResultPrompt([{ id: "call_1", content: '{"temp":22}' }]);
  assert.match(text, /call_1/);
  assert.match(text, /22/);
  const failed = composeToolResultPrompt([{ id: "call_2", content: "lookup failed", isError: true }]);
  assert.match(failed, /call_2 ERROR:/);
  assert.match(failed, /lookup failed/);
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
  assert.deepEqual(opts.model, {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  });
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
