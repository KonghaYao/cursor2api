#!/usr/bin/env node
/**
 * Live acceptance probe: three user turns in one session.
 *
 *   你的工具有什么
 *   调用一下
 *   我的第一句话是什么
 *
 *   set -a && source .env && set +a
 *   BASE=http://127.0.0.1:8793 node --experimental-strip-types scripts/probe-session-memory.ts
 */
const BASE = (process.env.BASE || "http://127.0.0.1:8789").replace(/\/$/, "");
const MODEL = process.env.PROBE_MODEL || "composer-2.5-fast";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180_000);

const FIRST = "你的工具有什么";
const SECOND = "调用一下";
const THIRD = "我的第一句话是什么";

function loadKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) throw new Error("missing CURSOR_API_KEY");
  return key;
}

type ToolCall = { id: string; type?: string; function?: { name?: string; arguments?: string } };
type ChatJson = {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: ToolCall[] };
  }>;
  conversation_id?: string;
  error?: { message?: string; type?: string };
};

type Row = { name: string; pass: boolean; detail: Record<string, unknown> };
const results: Row[] = [];

function record(row: Row): void {
  results.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.name}  ${JSON.stringify(row.detail)}`);
}

function errOf(json: ChatJson): string | undefined {
  const m = json.error?.message;
  return m ? String(m).slice(0, 400) : undefined;
}

function contentOf(json: ChatJson): string {
  return String(json.choices?.[0]?.message?.content || "");
}

function toolCallsOf(json: ChatJson): ToolCall[] {
  return json.choices?.[0]?.message?.tool_calls || [];
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current temperature in Celsius for a city.",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup",
      description: "Look up a named fact.",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    },
  },
];

function fakeToolResult(call: ToolCall): string {
  const name = String(call.function?.name || "");
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(String(call.function?.arguments || "{}")) as Record<string, unknown>;
  } catch {
    args = {};
  }
  if (name === "get_weather") return JSON.stringify({ city: args.city || "Tokyo", temp_c: 22 });
  return JSON.stringify({ q: args.q || "", value: "ok" });
}

async function chat(key: string, messages: unknown[]): Promise<{ status: number; json: ChatJson; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: "auto" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: { message } }), { status: 599 });
  });
  const raw = await res.text();
  let json: ChatJson = {};
  try {
    json = JSON.parse(raw) as ChatJson;
  } catch {
    json = { error: { message: raw.slice(0, 400) } };
  }
  return { status: res.status, json, ms: Date.now() - started };
}

async function completeTurn(
  key: string,
  messages: unknown[],
  label: string,
): Promise<{ messages: unknown[]; json: ChatJson; conversationId?: string }> {
  let json: ChatJson = {};
  for (let i = 0; i < 4; i++) {
    const res = await chat(key, messages);
    json = res.json;
    const err = errOf(json);
    const content = contentOf(json).slice(0, 240);
    const calls = toolCallsOf(json);
    console.log(`  ${label}#${i} status=${res.status} ${res.ms}ms finish=${json.choices?.[0]?.finish_reason || "-"} tools=${calls.map((c) => c.function?.name).join(",") || "-"} text=${JSON.stringify(content)}`);
    if (res.status !== 200 || err) {
      record({ name: `${label} http`, pass: false, detail: { status: res.status, err, ms: res.ms } });
      return { messages, json, conversationId: json.conversation_id };
    }
    if (calls.length) {
      messages = [
        ...messages,
        { role: "assistant", content: json.choices?.[0]?.message?.content ?? null, tool_calls: calls },
        ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: fakeToolResult(c) })),
      ];
      continue;
    }
    messages = [...messages, { role: "assistant", content: json.choices?.[0]?.message?.content || "" }];
    return { messages, json, conversationId: json.conversation_id };
  }
  record({ name: `${label} tool loop`, pass: false, detail: { err: "too many tool rounds" } });
  return { messages, json, conversationId: json.conversation_id };
}

async function main(): Promise<void> {
  const key = loadKey();
  const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  if (!health || health.status !== 200) throw new Error(`gateway not healthy at ${BASE}`);

  let messages: unknown[] = [
    { role: "system", content: "用简体中文回答。工具在时先用工具，不要编造。" },
    { role: "user", content: FIRST },
  ];

  const t1 = await completeTurn(key, messages, "turn1");
  messages = t1.messages;
  const text1 = contentOf(t1.json);
  const listed = /get_weather|lookup|天气|工具/.test(text1) && !/没有工具|don't have (any )?tools|no tools/i.test(text1);
  record({
    name: "turn1 lists tools",
    pass: Boolean(t1.json.choices?.[0] && !errOf(t1.json) && listed),
    detail: { conversation_id: t1.conversationId, text: text1.slice(0, 180) },
  });

  messages = [...messages, { role: "user", content: SECOND }];
  const t2 = await completeTurn(key, messages, "turn2");
  messages = t2.messages;
  const called = messages.some((m) => m && typeof m === "object" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls));
  const sameId2 = t2.conversationId === t1.conversationId;
  record({
    name: "turn2 calls a tool in the same session",
    pass: Boolean(sameId2 && called && !errOf(t2.json)),
    detail: { conversation_id: t2.conversationId, same: sameId2, called, text: contentOf(t2.json).slice(0, 180) },
  });

  messages = [...messages, { role: "user", content: THIRD }];
  const t3 = await completeTurn(key, messages, "turn3");
  const text3 = contentOf(t3.json);
  const recalled = text3.includes(FIRST) || text3.includes("工具有什么");
  const abnormal = /不知道|不记得|没有上文|new conversation|start of (our )?session|没有听到/i.test(text3);
  const sameId3 = t3.conversationId === t1.conversationId;
  record({
    name: "turn3 recalls the first sentence",
    pass: Boolean(sameId3 && recalled && !abnormal && !errOf(t3.json)),
    detail: { conversation_id: t3.conversationId, same: sameId3, recalled, abnormal, text: text3.slice(0, 240) },
  });

  const failed = results.filter((r) => !r.pass);
  console.log(failed.length ? `FAILED ${failed.length}/${results.length}` : `OK ${results.length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
