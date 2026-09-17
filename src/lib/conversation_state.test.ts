import assert from "node:assert/strict";
import test from "node:test";
import { openaiToolsToCustom } from "./custom_tools.ts";
import {
  decodeRootPromptText,
  spliceConversationFromClient,
  splicedUserPrompt,
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
  assert.doesNotMatch(spliced.prompt, /full read and write access/);
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
  assert.match(roots2, /我有 get_weather 和 lookup/);
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
  assert.match(s3.prompt, /Tools: get_weather, lookup/);
  assert.match(s3.prompt, new RegExp(third));
  const roots3 = decodeRootPromptText(s3.conversationState, s3.blobs);
  assert.match(roots3, /你的工具有什么/);
  assert.match(roots3, /调用一下/);
  assert.match(roots3, /22/);
  assert.doesNotMatch(roots3, /我的第一句话是什么/);
});

test("policy stays its own first root ahead of a large Cursor Agent system", async () => {
  const harness = `You are Cursor Grok 4.6. Native tools: Read, Write, Edit, Bash, Grep.\n${"x".repeat(8000)}`;
  const catalog = [
    { type: "function" as const, function: { name: "Read" } },
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
  assert.match(policyRoot, /Tools: Read, Write, Edit, Bash/);
  assert.match(policyRoot, /Use Read to inspect files; use Write or Edit to change them/);
  assert.match(policyRoot, /You have full read and write access/);
  assert.doesNotMatch(policyRoot, /MCP|custom-user-tools|unavailable|tool list changed|Native /i);
  assert.doesNotMatch(policyRoot, /You are Cursor Grok/);
  assert.match(systemRoot, /You are Cursor Grok/);
  assert.doesNotMatch(systemRoot, /\bTools:/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /Already invoked client tool Write/);
  assert.doesNotMatch(roots, /\[Tool Call\]|\[tool_call\]/);
  assert.match(roots, /wrote a\.ts/);
  assert.doesNotMatch(roots, /edit again/);
  assert.match(spliced.prompt, /You have full read and write access/);
  assert.match(spliced.prompt, /Use Read to inspect files/);
  assert.match(spliced.prompt, /Tools: Read, Write, Edit, Bash/);
  assert.match(spliced.prompt, /edit again/);
});

test("long writer sessions re-inject tool policy in replayed roots", async () => {
  const catalog = [
    { type: "function" as const, function: { name: "Read" } },
    { type: "custom" as const, name: "Write" },
    { type: "function" as const, function: { name: "Edit" } },
    { type: "function" as const, function: { name: "Bash" } },
  ];
  const tools = openaiToolsToCustom(catalog);
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: "be brief" }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "user", content: `task ${i}` });
    messages.push({ role: "assistant", content: `done ${i}` });
  }
  messages.push({ role: "user", content: "write the patch now" });
  const spliced = await spliceConversationFromClient({
    body: { messages, tools: catalog },
    tools,
    messages,
    priorMessageCount: messages.length - 1,
  });
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  const policyHits = roots.match(/Tools: Read, Write, Edit, Bash\./g) ?? [];
  assert.ok(policyHits.length >= 2, `expected periodic root reminders, got ${policyHits.length}`);
  assert.match(spliced.prompt, /Apply file changes with Write or Edit immediately/);
  assert.match(spliced.prompt, /write the patch now/);
});

test("KV-length follow-up keeps assistant echo in roots, not in userMessageAction", async () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "UNIQUE_ASSISTANT_ECHO" },
    { role: "user", content: "second question" },
  ];
  const slice = splicedUserPrompt({ messages, priorMessageCount: 2 });
  assert.equal(slice.historyEnd, 3);
  assert.equal(slice.prompt, "second question");
  assert.equal(slice.resume, false);

  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools,
    messages,
    priorMessageCount: 2,
  });
  assert.equal(spliced.prompt, "second question");
  assert.doesNotMatch(spliced.prompt, /first question|UNIQUE_ASSISTANT_ECHO/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /first question/);
  assert.match(roots, /UNIQUE_ASSISTANT_ECHO/);
  assert.doesNotMatch(roots, /second question/);
});

test("two new users after an assistant echo both go in the action", async () => {
  const messages = [
    { role: "user", content: "UNIQUE_ONE" },
    { role: "assistant", content: "UNIQUE_ACK_ONE" },
    { role: "user", content: "UNIQUE_TWO" },
    { role: "user", content: "UNIQUE_THREE" },
  ];
  const slice = splicedUserPrompt({ messages, priorMessageCount: 1 });
  assert.equal(slice.historyEnd, 2);
  assert.equal(slice.prompt, "UNIQUE_TWO\n\nUNIQUE_THREE");
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools: [],
    messages,
    priorMessageCount: 1,
  });
  assert.equal(spliced.prompt, "UNIQUE_TWO\n\nUNIQUE_THREE");
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /UNIQUE_ONE/);
  assert.match(roots, /UNIQUE_ACK_ONE/);
  assert.doesNotMatch(roots, /UNIQUE_TWO|UNIQUE_THREE/);
});

test("missing prior still excludes only the last user and keeps assistant history", async () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "UNIQUE_ASSISTANT_ECHO" },
    { role: "user", content: "second question" },
  ];
  const slice = splicedUserPrompt({ messages });
  assert.equal(slice.historyEnd, 3);
  assert.equal(slice.prompt, "second question");
  const spliced = await spliceConversationFromClient({ body: { messages }, tools, messages });
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /first question/);
  assert.match(roots, /UNIQUE_ASSISTANT_ECHO/);
  assert.doesNotMatch(roots, /second question/);
  assert.doesNotMatch(spliced.prompt, /first question/);
});

test("shorter transcript does not restack history into userMessageAction", async () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "retry first" },
  ];
  const slice = splicedUserPrompt({ messages, priorMessageCount: 4 });
  assert.equal(slice.historyEnd, 1);
  assert.equal(slice.prompt, "retry first");
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools: [],
    messages,
    priorMessageCount: 4,
  });
  assert.equal(spliced.prompt, "retry first");
  assert.doesNotMatch(spliced.prompt, /<system>/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.doesNotMatch(roots, /retry first/);
});

test("same-length last-user edit is a last-user retry, not a no-op", async () => {
  const messages = [
    { role: "user", content: "one" },
    { role: "assistant", content: "ack-one" },
    { role: "user", content: "edited two" },
  ];
  const slice = splicedUserPrompt({ messages, priorMessageCount: 3 });
  assert.equal(slice.historyEnd, 2);
  assert.equal(slice.prompt, "edited two");
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools: [],
    messages,
    priorMessageCount: 3,
  });
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /one/);
  assert.match(roots, /ack-one/);
  assert.doesNotMatch(roots, /edited two/);
});

test("follow-up after a tool round uses the new user, not old tool results", async () => {
  const afterTools = [
    { role: "user", content: "tokyo weather then a follow-up" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":22}' },
  ];
  const messages = [
    ...afterTools,
    { role: "assistant", content: "TOKYO_ASSISTANT_SUMMARY" },
    { role: "user", content: "what was the temp?" },
  ];
  const slice = splicedUserPrompt({ messages, tools, priorMessageCount: afterTools.length });
  assert.equal(slice.historyEnd, afterTools.length + 1);
  assert.match(slice.prompt, /what was the temp\?/);
  assert.doesNotMatch(slice.prompt, /The client executed your custom tools/);
  assert.doesNotMatch(slice.prompt, /TOKYO_ASSISTANT_SUMMARY|"temp":22/);

  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools,
    messages,
    priorMessageCount: afterTools.length,
  });
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /tokyo weather then a follow-up/);
  assert.match(roots, /Already invoked client tool get_weather/);
  assert.match(roots, /22/);
  assert.match(roots, /TOKYO_ASSISTANT_SUMMARY/);
  assert.doesNotMatch(roots, /what was the temp\?/);
});

test("parallel tool results stay off roots and all appear in the action", async () => {
  const messages = [
    { role: "user", content: "search three ways" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "get_weather", arguments: "{}" } },
        { id: "call_b", type: "function", function: { name: "lookup", arguments: "{}" } },
        { id: "call_c", type: "function", function: { name: "search", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_a", content: "A-RESULT" },
    { role: "tool", tool_call_id: "call_b", content: "B-RESULT" },
    { role: "tool", tool_call_id: "call_c", content: "C-RESULT" },
  ];
  const slice = splicedUserPrompt({ messages, tools, priorMessageCount: 1 });
  assert.equal(slice.historyEnd, 2);
  assert.match(slice.prompt, /call_a[\s\S]*A-RESULT/);
  assert.match(slice.prompt, /call_b[\s\S]*B-RESULT/);
  assert.match(slice.prompt, /call_c[\s\S]*C-RESULT/);
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools,
    messages,
    priorMessageCount: 1,
  });
  assert.equal(spliced.resume, false);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /search three ways/);
  assert.match(roots, /Already invoked client tool get_weather/);
  assert.doesNotMatch(roots, /A-RESULT|B-RESULT|C-RESULT/);
});

test("Anthropic tool_result users slice like OpenAI role=tool", async () => {
  const messages = [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Tokyo" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"temp":22}' }] },
  ];
  const slice = splicedUserPrompt({ messages, tools, priorMessageCount: 1 });
  assert.equal(slice.historyEnd, 2);
  assert.match(slice.prompt, /tu_1/);
  assert.match(slice.prompt, /22/);
  assert.doesNotMatch(slice.prompt, /weather\?/);
  const spliced = await spliceConversationFromClient({ body: { messages }, tools, messages });
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /weather\?/);
  assert.match(roots, /Already invoked client tool get_weather/);
  assert.doesNotMatch(roots, /"temp":22/);
});

test("Anthropic follow-up user keeps assistant text in roots", async () => {
  const messages = [
    { role: "user", content: "first anthropic" },
    { role: "assistant", content: [{ type: "text", text: "ANTH_ASSISTANT_ECHO" }] },
    { role: "user", content: "second anthropic" },
  ];
  const slice = splicedUserPrompt({ messages, priorMessageCount: 1 });
  assert.equal(slice.historyEnd, 2);
  assert.equal(slice.prompt, "second anthropic");
  const spliced = await spliceConversationFromClient({
    body: { system: "be brief", messages },
    tools: [],
    messages,
    priorMessageCount: 1,
  });
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /first anthropic/);
  assert.match(roots, /ANTH_ASSISTANT_ECHO/);
  assert.doesNotMatch(roots, /second anthropic/);
  assert.doesNotMatch(spliced.prompt, /first anthropic|<system>/);
});

test("system and developer roles count toward length but never enter userMessageAction", async () => {
  const messages = [
    { role: "system", content: "sys-hidden" },
    { role: "developer", content: "dev-hidden" },
    { role: "user", content: "visible user" },
    { role: "assistant", content: "asst-keep" },
    { role: "user", content: "next user" },
  ];
  const slice = splicedUserPrompt({ messages, priorMessageCount: 3 });
  assert.equal(slice.historyEnd, 4);
  assert.equal(slice.prompt, "next user");
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools: [],
    messages,
    priorMessageCount: 3,
  });
  assert.doesNotMatch(spliced.prompt, /sys-hidden|dev-hidden|visible user|asst-keep/);
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /sys-hidden/);
  assert.match(roots, /dev-hidden/);
  assert.match(roots, /visible user/);
  assert.match(roots, /asst-keep/);
  assert.doesNotMatch(roots, /next user/);
});

test("assistant tool_calls with no content still count in the length cursor", async () => {
  const messages = [
    { role: "user", content: "call it" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_z", type: "function", function: { name: "lookup", arguments: "{}" } }],
    },
    { role: "user", content: "never mind" },
  ];
  const slice = splicedUserPrompt({ messages, priorMessageCount: 1 });
  assert.equal(slice.historyEnd, 2);
  assert.equal(slice.prompt, "never mind");
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools,
    messages,
    priorMessageCount: 1,
  });
  const roots = decodeRootPromptText(spliced.conversationState, spliced.blobs);
  assert.match(roots, /Already invoked client tool lookup \(id call_z\)/);
  assert.doesNotMatch(roots, /never mind/);
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
