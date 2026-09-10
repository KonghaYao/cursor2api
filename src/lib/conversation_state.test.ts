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

test("first shot puts system in root blobs and user in the action prompt", async () => {
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
  assert.match(roots, /"role":"system"/);
  assert.match(roots, /be brief/);
  assert.match(roots, /get_weather/);
  assert.doesNotMatch(roots, /weather in tokyo/);
  const ids = spliced.conversationState.rootPromptMessagesJson as string[];
  assert.ok(ids.length >= 2);
  for (const id of ids) assert.ok(spliced.blobs.has(id));
});

test("tool follow-up is resumeAction with prior user and tool results in roots", async () => {
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
  assert.equal(spliced.resume, true);
  assert.equal(spliced.prompt, "");
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /weather in tokyo then humidity then news/);
  assert.match(roots, /call_1/);
  assert.match(roots, /get_weather/);
  assert.match(roots, /temp/);
  assert.match(roots, /22/);
  assert.match(roots, /\[Tool Result\]/);
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
  assert.equal(spliced.resume, true);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /tokyo weather, humidity, then a headline/);
  assert.match(roots, /call_wx/);
  assert.match(roots, /call_hum/);
  assert.match(roots, /call_news/);
  assert.match(roots, /get_weather/);
  assert.match(roots, /lookup/);
  assert.match(roots, /search/);
  assert.match(roots, /rain later/);
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
