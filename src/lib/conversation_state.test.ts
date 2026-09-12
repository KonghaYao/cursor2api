import assert from "node:assert/strict";
import test from "node:test";
import { openaiToolsToCustom } from "./custom_tools.ts";
import {
  decodeRootPromptText,
  spliceConversationFromClient,
  storeJsonBlob,
  utf8FromBlobData,
} from "./conversation_state.ts";

const tools = openaiToolsToCustom([
  { type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } },
  { type: "function", function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } },
  { type: "function", function: { name: "search", parameters: { type: "object", properties: { q: { type: "string" } } } } },
]);

test("first shot puts system in a model-visible root and user in the action prompt", async () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "weather in tokyo?" },
  ];
  const spliced = await spliceConversationFromClient({
    body: { messages, tool_choice: "auto" },
    tools,
    messages,
  });
  assert.equal(spliced.resume, false);
  assert.equal(spliced.prompt, "weather in tokyo?");
  assert.doesNotMatch(spliced.prompt, /<system>/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /"role":"user"/);
  assert.match(roots, /<system>/);
  assert.match(roots, /be brief/);
  assert.match(roots, /get_weather/);
  assert.match(roots, /Tools: get_weather/);
  assert.ok(roots.indexOf("Tools:") < roots.indexOf("be brief"));
  assert.doesNotMatch(roots, /"role":"system"/);
  assert.doesNotMatch(roots, /weather in tokyo/);
  const ids = spliced.conversationState.rootPromptMessagesJson as string[];
  assert.equal(ids.length, 2);
  const policyRoot = utf8FromBlobData(spliced.blobs.get(String(ids[0]))!);
  const systemRoot = utf8FromBlobData(spliced.blobs.get(String(ids[1]))!);
  assert.match(policyRoot, /Tools: get_weather/);
  assert.doesNotMatch(policyRoot, /MCP|custom-user-tools|unavailable/i);
  assert.doesNotMatch(policyRoot, /be brief/);
  assert.match(systemRoot, /be brief/);
  assert.doesNotMatch(systemRoot, /\bTools:/);
  for (const id of ids) assert.ok(spliced.blobs.has(id));
});

test("tool follow-up puts latest results in userMessageAction, not empty resume", async () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "weather in tokyo then humidity then news" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":22}' },
  ];
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools,
    messages,
  });
  assert.equal(spliced.resume, false);
  assert.match(spliced.prompt, /call_1/);
  assert.match(spliced.prompt, /22/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /weather in tokyo then humidity then news/);
  assert.match(roots, /Already invoked client tool get_weather/);
  assert.doesNotMatch(roots, /\[Tool Call\]|\[tool_call\]/);
  assert.doesNotMatch(roots, /"temp":22/);
});

test("three sequential user tool rounds keep the full catalog history in roots", async () => {
  const messages = [
    { role: "user", content: "tokyo weather, humidity, then a headline" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_wx", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
    },
    { role: "tool", tool_call_id: "call_wx", content: '{"temp":22}' },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_hum", type: "function", function: { name: "lookup", arguments: '{"q":"tokyo_humidity"}' } }],
    },
    { role: "tool", tool_call_id: "call_hum", content: '{"humidity":40}' },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_news", type: "function", function: { name: "search", arguments: '{"q":"tokyo"}' } }],
    },
    { role: "tool", tool_call_id: "call_news", content: '{"headline":"rain later"}' },
  ];
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools,
    messages,
  });
  assert.equal(spliced.resume, false);
  assert.match(spliced.prompt, /rain later/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /tokyo weather, humidity, then a headline/);
  assert.match(roots, /call_wx/);
  assert.match(roots, /call_hum/);
  assert.match(roots, /Already invoked client tool get_weather/);
  assert.match(roots, /Already invoked client tool lookup/);
  assert.doesNotMatch(roots, /\[Tool Call\]|\[tool_call\]/);
  assert.match(roots, /22/);
  assert.match(roots, /40/);
  assert.doesNotMatch(roots, /rain later/);
});

test("three user turns keep the first sentence in roots for the last question", async () => {
  const first = "你的工具有什么";
  const second = "调用一下";
  const third = "我的第一句话是什么";
  const catalog = [
    { type: "function", function: { name: "get_weather", description: "Current weather" } },
    { type: "function", function: { name: "lookup", description: "Look up a fact" } },
  ];
  const tools = openaiToolsToCustom(catalog);

  const turn1 = [{ role: "system", content: "be brief" }, { role: "user", content: first }];
  const s1 = await spliceConversationFromClient({ body: { messages: turn1, tools: catalog }, tools, messages: turn1 });
  assert.equal(s1.resume, false);
  assert.equal(s1.prompt, first);
  assert.doesNotMatch(decodeRootPromptText(s1.conversationState, s1.blobs), /你的工具有什么/);
  assert.deepEqual(Object.keys(s1.conversationState), ["rootPromptMessagesJson"]);

  const turn2 = [
    ...turn1,
    { role: "assistant", content: "我有 get_weather 和 lookup。" },
    { role: "user", content: second },
  ];
  const s2 = await spliceConversationFromClient({
    body: { messages: turn2, tools: catalog },
    tools,
    messages: turn2,
    priorMessageCount: turn1.length,
  });
  assert.equal(s2.resume, false);
  assert.equal(s2.prompt, second);
  assert.doesNotMatch(s2.prompt, new RegExp(first));
  const roots2 = decodeRootPromptText(s2.conversationState, s2.blobs);
  assert.match(roots2, /你的工具有什么/);
  assert.match(roots2, /get_weather/);

  const turn3 = [
    ...turn2,
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_wx", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
    },
    { role: "tool", tool_call_id: "call_wx", content: '{"temp":22}' },
    { role: "assistant", content: "东京 22 度。" },
    { role: "user", content: third },
  ];
  const s3 = await spliceConversationFromClient({
    body: { messages: turn3, tools: catalog },
    tools,
    messages: turn3,
    priorMessageCount: turn3.length - 1,
  });
  assert.equal(s3.resume, false);
  assert.equal(s3.prompt, third);
  const roots3 = decodeRootPromptText(s3.conversationState, s3.blobs);
  assert.match(roots3, /你的工具有什么/);
  assert.match(roots3, /调用一下/);
  assert.match(roots3, /22/);
  assert.doesNotMatch(roots3, /我的第一句话是什么/);
});

test("policy stays its own first root ahead of a large Cursor Agent system", async () => {
  const harness = `You are Cursor Grok 4.6. Native tools: Read, Write, Edit, Bash, Grep.\n${"x".repeat(8000)}`;
  const catalog = [
    { type: "custom" as const, name: "Write" },
    { type: "function" as const, function: { name: "Edit" } },
    { type: "function" as const, function: { name: "Bash" } },
  ];
  const tools = openaiToolsToCustom(catalog);
  const messages = [
    { role: "system", content: harness },
    { role: "user", content: "edit the file" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_w", type: "function", function: { name: "Write", arguments: '{"path":"a.ts"}' } }],
    },
    { role: "tool", tool_call_id: "call_w", content: "wrote a.ts" },
    { role: "assistant", content: "wrote it" },
    { role: "user", content: "edit again" },
  ];
  const spliced = await spliceConversationFromClient({
    body: { messages, tools: catalog },
    tools,
    messages,
  });
  const ids = spliced.conversationState.rootPromptMessagesJson as string[];
  assert.ok(ids.length >= 2);
  const policyRoot = utf8FromBlobData(spliced.blobs.get(String(ids[0]))!);
  const systemRoot = utf8FromBlobData(spliced.blobs.get(String(ids[1]))!);
  assert.match(policyRoot, /Tools: Write, Edit, Bash/);
  assert.match(policyRoot, /File changes require Write or Edit/);
  assert.doesNotMatch(policyRoot, /MCP|custom-user-tools|unavailable|tool list changed|Native /i);
  assert.doesNotMatch(policyRoot, /You are Cursor Grok/);
  assert.match(systemRoot, /You are Cursor Grok/);
  assert.doesNotMatch(systemRoot, /\bTools:/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /Already invoked client tool Write/);
  assert.doesNotMatch(roots, /\[Tool Call\]|\[tool_call\]/);
  assert.match(roots, /wrote a\.ts/);
  assert.doesNotMatch(roots, /edit again/);
});

test("blob ids are SHA-256 of the JSON bytes (Connect JSON base64)", async () => {
  const store = new Map<string, string>();
  const value = { role: "system", content: "x" };
  const id = await storeJsonBlob(store, value);
  const data = store.get(id);
  assert.ok(data);
  assert.equal(utf8FromBlobData(data!), JSON.stringify(value));
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let b64 = "";
  for (const b of digest) b64 += String.fromCharCode(b);
  assert.equal(id, btoa(b64));
});
