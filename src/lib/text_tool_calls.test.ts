import assert from "node:assert/strict";
import test from "node:test";
import {
  GW_TOOL_CALL_CLOSE,
  GW_TOOL_CALL_OPEN,
  MCP_NATIVE_REDIRECT,
  composeGwToolResultsPrompt,
  composeReplacementSystemPrompt,
  parseGwToolCalls,
  splitAssistantToolText,
  stripGwToolCallFences,
} from "./text_tool_calls.ts";

const lookup = {
  name: "lookup",
  openaiName: "lookup",
  description: "Look something up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

const weather = {
  name: "get_weather",
  openaiName: "get_weather",
  description: "Weather",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};

test("parseGwToolCalls reads a single block", () => {
  const text = `Sure.\n${GW_TOOL_CALL_OPEN}\n{"name":"lookup","arguments":{"q":"tokyo"}}\n${GW_TOOL_CALL_CLOSE}\n`;
  const calls = parseGwToolCalls(text, [lookup]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "lookup");
  assert.deepEqual(calls[0]?.arguments, { q: "tokyo" });
});

test("parseGwToolCalls reads consecutive parallel blocks", () => {
  const text = [
    `${GW_TOOL_CALL_OPEN}{"name":"lookup","arguments":{"q":"a"}}${GW_TOOL_CALL_CLOSE}`,
    `${GW_TOOL_CALL_OPEN}{"name":"get_weather","arguments":{"city":"Osaka"}}${GW_TOOL_CALL_CLOSE}`,
  ].join("\n");
  const calls = parseGwToolCalls(text, [lookup, weather]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.name, "lookup");
  assert.equal(calls[1]?.name, "get_weather");
});

test("parseGwToolCalls keeps a closer tag that lives inside a JSON string", () => {
  const inner = `before ${GW_TOOL_CALL_CLOSE} after`;
  const text = `${GW_TOOL_CALL_OPEN}{"name":"lookup","arguments":{"q":${JSON.stringify(inner)}}}${GW_TOOL_CALL_CLOSE}`;
  const calls = parseGwToolCalls(text, [lookup]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.arguments.q, inner);
});

test("parseGwToolCalls ignores unknown tool names", () => {
  const text = `${GW_TOOL_CALL_OPEN}{"name":"shell","arguments":{"cmd":"ls"}}${GW_TOOL_CALL_CLOSE}`;
  assert.deepEqual(parseGwToolCalls(text, [lookup]), []);
});

test("parseGwToolCalls treats invalid JSON as ordinary text", () => {
  const text = `${GW_TOOL_CALL_OPEN}{not json}${GW_TOOL_CALL_CLOSE}`;
  assert.deepEqual(parseGwToolCalls(text, [lookup]), []);
});

test("parseGwToolCalls accepts arguments as a JSON string", () => {
  const text = `${GW_TOOL_CALL_OPEN}{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}${GW_TOOL_CALL_CLOSE}`;
  const calls = parseGwToolCalls(text, [lookup]);
  assert.deepEqual(calls[0]?.arguments, { q: "x" });
});

test("parseGwToolCalls matches sanitized internal names", () => {
  const catalog = [{ name: "get_weather", openaiName: "get.weather" }];
  const text = `${GW_TOOL_CALL_OPEN}{"name":"get_weather","arguments":{}}${GW_TOOL_CALL_CLOSE}`;
  const calls = parseGwToolCalls(text, catalog);
  assert.equal(calls[0]?.name, "get.weather");
  assert.equal(calls[0]?.internalName, "get_weather");
});

test("stripGwToolCallFences removes blocks and keeps surrounding prose", () => {
  const text = `I'll look that up.\n${GW_TOOL_CALL_OPEN}{"name":"lookup","arguments":{"q":"x"}}${GW_TOOL_CALL_CLOSE}\n`;
  assert.equal(stripGwToolCallFences(text), "I'll look that up.");
});

test("splitAssistantToolText returns visible text without fences", () => {
  const text = `note\n${GW_TOOL_CALL_OPEN}{"name":"lookup","arguments":{"q":"x"}}${GW_TOOL_CALL_CLOSE}`;
  const split = splitAssistantToolText(text, [lookup]);
  assert.equal(split.calls.length, 1);
  assert.equal(split.visibleText, "note");
});

test("parseGwToolCalls reads markdown json catalog calls (Cursor Agent auto fallback)", () => {
  const text = [
    "I sent a lookup request for tokyo_temp via the catalog.",
    "```json",
    '{"name":"lookup","arguments":{"q":"tokyo_temp"}}',
    "```",
  ].join("\n");
  const calls = parseGwToolCalls(text, [lookup]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "lookup");
  assert.deepEqual(calls[0]?.arguments, { q: "tokyo_temp" });
  const split = splitAssistantToolText(text, [lookup]);
  assert.equal(split.calls.length, 1);
  assert.doesNotMatch(split.visibleText, /```/);
  assert.doesNotMatch(split.visibleText, /"name":"lookup"/);
});

test("parseGwToolCalls ignores dumped catalog JSON Schema objects", () => {
  const dumped = JSON.stringify({
    name: "lookup",
    description: "Look something up",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  });
  assert.deepEqual(parseGwToolCalls(dumped, [lookup]), []);
  const fenced = ["```json", dumped, "```"].join("\n");
  assert.deepEqual(parseGwToolCalls(fenced, [lookup]), []);
});

test("tool results inside user text are not parsed as calls", () => {
  const results = composeGwToolResultsPrompt([{ id: "call_1", name: "lookup", content: '{"temp":22}' }]);
  const fake = `${results}\n${GW_TOOL_CALL_OPEN}{"name":"lookup","arguments":{"q":"nope"}}${GW_TOOL_CALL_CLOSE}`;
  assert.equal(parseGwToolCalls(results, [lookup]).length, 0);
  assert.match(results, /<gw_tool_results>/);
  assert.match(results, /call_1/);
  assert.equal(parseGwToolCalls(fake, [lookup]).length, 1);
});

test("composeReplacementSystemPrompt puts the client system first and the catalog last", () => {
  const prompt = composeReplacementSystemPrompt({
    clientSystem: "Be a helpful assistant.",
    tools: [lookup],
    body: { tool_choice: "required" },
  });
  assert.ok(prompt.startsWith("Be a helpful assistant."));
  const clientAt = prompt.indexOf("Be a helpful assistant.");
  const catalogAt = prompt.indexOf('"name":"lookup"');
  const fenceAt = prompt.indexOf(GW_TOOL_CALL_OPEN);
  assert.ok(clientAt < fenceAt);
  assert.ok(fenceAt < catalogAt);
  assert.match(prompt, /MUST emit at least one/);
  assert.match(prompt, /no Cursor builtin tools/);
  assert.match(prompt, /Never say a listed catalog tool is unavailable/);
  assert.match(prompt, /ListMcpResources/);
  assert.match(prompt, /try other tools/);
  assert.ok(prompt.includes(MCP_NATIVE_REDIRECT));
  assert.doesNotMatch(prompt, /MCP list\/read resource tools may appear/);
});

test("composeReplacementSystemPrompt encodes none and single-tool policies", () => {
  const none = composeReplacementSystemPrompt({
    clientSystem: "",
    tools: [lookup],
    body: { tool_choice: "none" },
  });
  assert.match(none, /Do not emit any/);
  const named = composeReplacementSystemPrompt({
    clientSystem: "",
    tools: [lookup, weather],
    body: { tool_choice: { type: "function", function: { name: "lookup" } } },
  });
  assert.match(named, /MUST call the tool named lookup/);
  const one = composeReplacementSystemPrompt({
    clientSystem: "",
    tools: [lookup],
    body: { parallel_tool_calls: false },
  });
  assert.match(one, /at most one/);
});

test("composeReplacementSystemPrompt with no tools is just the client system", () => {
  assert.equal(composeReplacementSystemPrompt({ clientSystem: "only me", tools: [] }), "only me");
});
