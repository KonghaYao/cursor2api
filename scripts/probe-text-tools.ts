#!/usr/bin/env node
/**
 * Live multi-round `<gw_tool_call>` probe against a running gateway.
 *
 *   set -a && source .env && set +a
 *   BASE=http://127.0.0.1:8792 node --experimental-strip-types scripts/probe-text-tools.ts
 *
 * Does not print credentials.
 */
const BASE = (process.env.BASE || "http://127.0.0.1:8789").replace(/\/$/, "");
const MODEL = process.env.PROBE_MODEL || "composer-2.5-fast";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180_000);

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
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
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

const LOOKUP = {
  type: "function",
  function: {
    name: "lookup",
    description: "Look up a named fact. q is a slug such as tokyo_temp or tokyo_humidity.",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  },
};

async function chat(key: string, body: Record<string, unknown>): Promise<{
  status: number;
  json: ChatJson;
  raw: string;
  ms: number;
}> {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => new Response(JSON.stringify({ error: { message: String(e) } }), { status: 599 }));
  const raw = await res.text();
  let json: ChatJson = {};
  try {
    json = JSON.parse(raw) as ChatJson;
  } catch {
    json = { error: { message: raw.slice(0, 400) } };
  }
  return { status: res.status, json, raw, ms: Date.now() - started };
}

async function chatRetry(key: string, body: Record<string, unknown>, attempts = 3) {
  let last = await chat(key, body);
  for (let i = 1; i < attempts; i++) {
    const msg = errOf(last.json) || "";
    if (last.status === 200 && !/HTTP 502|Bad Gateway/i.test(msg)) return last;
    console.log(`  retry ${i} after upstream 502`);
    await new Promise((r) => setTimeout(r, 2000 * i));
    last = await chat(key, body);
  }
  return last;
}

async function chatStream(key: string, body: Record<string, unknown>): Promise<{
  status: number;
  text: string;
  ms: number;
}> {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => new Response(String(e), { status: 599 }));
  return { status: res.status, text: await res.text(), ms: Date.now() - started };
}

function systemPromptRejected(json: ChatJson, raw: string): boolean {
  const blob = `${errOf(json) || ""} ${raw}`.toLowerCase();
  return blob.includes("system-prompt") || blob.includes("customsystemprompt");
}

async function main(): Promise<void> {
  const key = loadKey();
  const nonce = Math.random().toString(16).slice(2, 10);
  console.log("base", BASE, "model", MODEL, "nonce", nonce);

  const healthRes = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) });
  const health = (await healthRes.json()) as { ok?: boolean; rpc?: string; tools?: string };
  record({
    name: "health",
    pass: healthRes.ok && Boolean(health.ok) && String(health.rpc || "").includes("AgentService"),
    detail: { rpc: health.rpc, tools: String(health.tools || "").slice(0, 180) },
  });

  const pong = await chat(key, {
    model: MODEL,
    max_tokens: 64,
    messages: [
      { role: "system", content: "Reply with exactly PONG." },
      { role: "user", content: `hi ${nonce}` },
    ],
  });
  const pongText = contentOf(pong.json);
  record({
    name: "pong_no_tools",
    pass: pong.status === 200 && !errOf(pong.json) && /PONG/i.test(pongText),
    detail: {
      status: pong.status,
      ms: pong.ms,
      text: pongText.slice(0, 120),
      error: errOf(pong.json),
      system_prompt_rejected: systemPromptRejected(pong.json, pong.raw),
      usage: pong.json.usage,
    },
  });

  const user = {
    role: "user",
    content:
      `You must look up two facts with the lookup tool, one call per turn, in this order: ` +
      `first q=tokyo_temp then q=tokyo_humidity. Do not invent numbers. nonce=${nonce}`,
  };
  const tools = [LOOKUP];
  const toolBody = {
    model: MODEL,
    max_tokens: 512,
    parallel_tool_calls: false,
    tool_choice: { type: "function", function: { name: "lookup" } },
    tools,
  };

  console.log(">> tool round 1");
  const r1 = await chatRetry(key, { ...toolBody, messages: [user] });
  const tc1 = toolCallsOf(r1.json);
  const r1Content = contentOf(r1.json);
  const r1Ok =
    r1.status === 200 &&
    !errOf(r1.json) &&
    r1.json.choices?.[0]?.finish_reason === "tool_calls" &&
    tc1.length >= 1 &&
    tc1[0]?.function?.name === "lookup" &&
    !r1Content.includes("<gw_tool_call>");
  record({
    name: "tool_round_1",
    pass: r1Ok,
    detail: {
      status: r1.status,
      ms: r1.ms,
      finish: r1.json.choices?.[0]?.finish_reason,
      conversation_id: r1.json.conversation_id,
      usage: r1.json.usage,
      prompt_tokens: r1.json.usage?.prompt_tokens,
      content: r1Content.slice(0, 160),
      n_calls: tc1.length,
      tool_calls: tc1.map((c) => ({
        id: String(c.id || "").slice(0, 28),
        name: c.function?.name,
        arguments: String(c.function?.arguments || "").slice(0, 160),
      })),
      error: errOf(r1.json),
      system_prompt_rejected: systemPromptRejected(r1.json, r1.raw),
      fence_leaked: r1Content.includes("<gw_tool_call>"),
    },
  });
  if (!r1Ok) console.log("round1_raw_head", r1.raw.slice(0, 800));

  if (r1Ok && tc1[0]) {
    console.log(">> tool round 2 (role=tool, full transcript)");
    await new Promise((r) => setTimeout(r, 1500));
    const r2 = await chatRetry(key, {
      ...toolBody,
      messages: [
        user,
        { role: "assistant", content: r1Content || null, tool_calls: tc1 },
        { role: "tool", tool_call_id: tc1[0].id, content: JSON.stringify({ q: "tokyo_temp", temp_c: 22 }) },
      ],
    });
    const tc2 = toolCallsOf(r2.json);
    const r2Content = contentOf(r2.json);
    const r2Tool = r2.json.choices?.[0]?.finish_reason === "tool_calls" && tc2.length >= 1 && tc2[0]?.function?.name === "lookup";
    const r2Final = r2.json.choices?.[0]?.finish_reason !== "tool_calls" && /22/.test(r2Content);
    const r2Ok =
      r2.status === 200 &&
      !errOf(r2.json) &&
      r2.json.conversation_id === r1.json.conversation_id &&
      !r2Content.includes("<gw_tool_call>") &&
      (r2Tool || r2Final);
    record({
      name: "tool_round_2",
      pass: r2Ok,
      detail: {
        status: r2.status,
        ms: r2.ms,
        finish: r2.json.choices?.[0]?.finish_reason,
        conversation_id: r2.json.conversation_id,
        same_conversation: r2.json.conversation_id === r1.json.conversation_id,
        usage: r2.json.usage,
        content: r2Content.slice(0, 160),
        n_calls: tc2.length,
        tool_calls: tc2.map((c) => ({
          id: String(c.id || "").slice(0, 28),
          name: c.function?.name,
          arguments: String(c.function?.arguments || "").slice(0, 160),
        })),
        error: errOf(r2.json),
        fence_leaked: r2Content.includes("<gw_tool_call>"),
      },
    });
    if (!r2Ok) console.log("round2_raw_head", r2.raw.slice(0, 800));

    if (r2Ok && r2Tool && tc2[0]) {
      console.log(">> final text after two tool rounds");
      await new Promise((r) => setTimeout(r, 1500));
      const r3 = await chatRetry(key, {
        model: MODEL,
        max_tokens: 256,
        messages: [
          user,
          { role: "assistant", content: r1Content || null, tool_calls: tc1 },
          { role: "tool", tool_call_id: tc1[0].id, content: JSON.stringify({ q: "tokyo_temp", temp_c: 22 }) },
          { role: "assistant", content: r2Content || null, tool_calls: tc2 },
          { role: "tool", tool_call_id: tc2[0].id, content: JSON.stringify({ q: "tokyo_humidity", humidity: 40 }) },
        ],
        tools,
      });
      const r3Text = contentOf(r3.json);
      const r3Ok =
        r3.status === 200 &&
        !errOf(r3.json) &&
        r3.json.choices?.[0]?.finish_reason !== "tool_calls" &&
        r3.json.conversation_id === r1.json.conversation_id &&
        /22/.test(r3Text) &&
        /40/.test(r3Text);
      record({
        name: "tool_final_text",
        pass: r3Ok,
        detail: {
          status: r3.status,
          ms: r3.ms,
          finish: r3.json.choices?.[0]?.finish_reason,
          conversation_id: r3.json.conversation_id,
          same_conversation: r3.json.conversation_id === r1.json.conversation_id,
          usage: r3.json.usage,
          text: r3Text.slice(0, 240),
          error: errOf(r3.json),
        },
      });
      if (!r3Ok) console.log("round3_raw_head", r3.raw.slice(0, 800));
    }
  }

  console.log(">> stream tool_calls");
  const stream = await chatStream(key, {
    ...toolBody,
    messages: [{ role: "user", content: `Call lookup with q=osaka_temp now. Do not invent the number. nonce=${nonce}` }],
  });
  const toolCallDeltas = stream.text.split("\n").filter((line) => line.includes('"tool_calls":['));
  record({
    name: "stream_complete_tool_calls",
    pass:
      stream.status === 200 &&
      toolCallDeltas.length === 1 &&
      stream.text.includes('"finish_reason":"tool_calls"') &&
      stream.text.includes("lookup") &&
      !stream.text.includes("<gw_tool_call>"),
    detail: {
      status: stream.status,
      ms: stream.ms,
      tool_call_deltas: toolCallDeltas.length,
      has_finish: stream.text.includes('"finish_reason":"tool_calls"'),
      fence_leaked: stream.text.includes("<gw_tool_call>"),
      has_error: stream.text.includes('"error"'),
      head: stream.text.replace(/\s+/g, " ").slice(0, 420),
    },
  });

  const failed = results.filter((r) => !r.pass);
  console.log(`summary ${results.length - failed.length}/${results.length} pass`);
  if (failed.length) process.exit(1);
}

await main();
