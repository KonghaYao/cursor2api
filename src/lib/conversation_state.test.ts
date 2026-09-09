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
