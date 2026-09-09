#!/usr/bin/env node
/**
 * Live OpenAI Chat Completions probe against a running gateway.
 *
 * Covers: system prompt, prompt-cache / sticky session, tool_calls park/resume,
 * stream=true complete tool_calls, and session isolation.
 *
 * Does not print credentials. Pass CURSOR_API_KEY in the environment.
 *
 * Inference (usage.cached_tokens):
 *   GATEWAY_UPSTREAM=inference bun src/node.ts
 *
 * Cloud Agents (Dashboard crsr_ keys; sticky x-session-id):
 *   bun src/node.ts
 *
 *   CURSOR_API_KEY=crsr_… BASE=http://127.0.0.1:8789 \
 *     bun scripts/probe-openai-chat.ts
 */
import { randomBytes } from "node:crypto";

const BASE = (process.env.BASE || "http://127.0.0.1:8789").replace(/\/$/, "");
const MODEL = process.env.PROBE_MODEL || "composer-2.5-fast";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180_000);
const WARM_HIT_MIN = Number(process.env.PROBE_WARM_HIT_MIN || 0.85);

function loadKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) throw new Error("missing CURSOR_API_KEY");
  return key;
}

function keyPrefix(key: string): string {
  if (key.startsWith("crsr_")) return "crsr_";
  if (key.startsWith("cursor_")) return "cursor_";
  if (key.startsWith("eyJ")) return "jwt";
  return `other:${key.slice(0, 4)}`;
}

type ChatJson = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{ id: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  conversation_id?: string;
  cursor_agent_id?: string;
  error?: { message?: string; type?: string; code?: string };
};

type CaseResult = { name: string; pass: boolean; detail: Record<string, unknown> };

function record(results: CaseResult[], row: CaseResult): void {
  results.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.name}  ${JSON.stringify(row.detail)}`);
}

function contentOf(json: ChatJson): string {
  return String(json.choices?.[0]?.message?.content || "");
}

function cacheStats(json: ChatJson) {
  const prompt = Number(json.usage?.prompt_tokens || 0);
  const cached = Number(json.usage?.prompt_tokens_details?.cached_tokens || 0);
  const hit = prompt > 0 ? cached / prompt : 0;
  return { prompt, cached, hit: Number(hit.toFixed(4)), model: json.model, id: json.id };
}

function chatError(json: ChatJson): string | undefined {
  const err = json.error;
  if (!err) return undefined;
  if (typeof err === "string") return err;
  return String(err.message || JSON.stringify(err)).slice(0, 400);
}

async function chat(
  key: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: ChatJson; headers: Headers; raw: string; ms: number; err?: string }> {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
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
  return { status: res.status, json, headers: res.headers, raw, ms: Date.now() - started, err: chatError(json) };
}

async function chatRetry(
  key: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  attempts = 3,
): Promise<Awaited<ReturnType<typeof chat>>> {
  let last!: Awaited<ReturnType<typeof chat>>;
  for (let i = 0; i < attempts; i++) {
    last = await chat(key, body, extraHeaders);
    if (!last.err || !/stream_unavailable/i.test(last.err || "")) return last;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return last;
}

async function chatStream(
  key: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: { message } }), { status: 599 });
  });
  return { status: res.status, text: await res.text(), ms: Date.now() - started };
}

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city. Always call this instead of guessing.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

async function main() {
  const key = loadKey();
  const nonce = randomBytes(4).toString("hex");
  const results: CaseResult[] = [];
  console.log("base", BASE, "model", MODEL, "key_prefix", keyPrefix(key), "len", key.length, "nonce", nonce);

  const healthRes = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) });
  const health = (await healthRes.json()) as { rpc?: string; tools?: string; ok?: boolean };
  const inference = String(health.rpc || "").includes("InferenceService");
  console.log("health", JSON.stringify(health));
  record(results, {
    name: "health",
    pass: healthRes.ok && Boolean(health.ok),
    detail: { rpc: health.rpc, tools: health.tools, inference },
  });

  const modelsRes = await fetch(`${BASE}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  const modelsJson = (await modelsRes.json()) as { data?: Array<{ id: string }>; error?: unknown };
  const modelIds = (modelsJson.data || []).map((m) => m.id);
  record(results, {
    name: "models",
    pass: modelsRes.ok && modelIds.length > 0,
    detail: { status: modelsRes.status, n: modelIds.length, sample: modelIds.slice(0, 8) },
  });

  const skipText = process.env.PROBE_SKIP_TEXT === "1";
  if (!skipText) {
  const sysToken = `ZEBRA_SYS_${nonce}`;
  console.log(">> system_prompt");
  const systemTurn = await chat(
    key,
    {
      model: MODEL,
      max_tokens: 128,
      messages: [
        {
          role: "system",
          content: `Reply with exactly ${sysToken} and nothing else.`,
        },
        { role: "user", content: "hi" },
      ],
    },
    { "x-session-id": `sys-${nonce}` },
  );
  const sysText = contentOf(systemTurn.json);
  record(results, {
    name: "system_prompt",
    pass: systemTurn.status === 200 && !systemTurn.err && sysText.includes(sysToken),
    detail: {
      status: systemTurn.status,
      ms: systemTurn.ms,
      text: sysText.slice(0, 240),
      error: systemTurn.err,
    },
  });

  const pad = `Background notes (ignore except as context): ${"cache-pad ".repeat(120)}`;
  const cacheMessages: Array<Record<string, unknown>> = [
    { role: "system", content: `${pad}\nYou are a cache probe. Keep replies to one short sentence.` },
    { role: "user", content: `Round 1 ${nonce}: reply with exactly CACHE_R1_${nonce}` },
  ];
  const cacheHeaders = { "x-session-id": `cache-${nonce}` };
  console.log(">> cache turn 1");
  const cache1 = await chat(key, { model: MODEL, max_tokens: 64, messages: cacheMessages }, cacheHeaders);
  const a1 = contentOf(cache1.json);
  cacheMessages.push({ role: "assistant", content: a1 || `CACHE_R1_${nonce}` });
  cacheMessages.push({ role: "user", content: `Round 2 ${nonce}: reply with exactly CACHE_R2_${nonce}` });
  console.log(">> cache turn 2");
  await new Promise((r) => setTimeout(r, 4000));
  const cache2 = await chatRetry(key, { model: MODEL, max_tokens: 64, messages: cacheMessages }, cacheHeaders);
  const a2 = contentOf(cache2.json);
  cacheMessages.push({ role: "assistant", content: a2 || `CACHE_R2_${nonce}` });
  cacheMessages.push({ role: "user", content: `Round 3 ${nonce}: reply with exactly CACHE_R3_${nonce}` });
  console.log(">> cache turn 3");
  await new Promise((r) => setTimeout(r, 4000));
  const cache3 = await chatRetry(key, { model: MODEL, max_tokens: 64, messages: cacheMessages }, cacheHeaders);
  const s1 = cacheStats(cache1.json);
  const s2 = cacheStats(cache2.json);
  const s3 = cacheStats(cache3.json);
  const cacheHttpOk = cache1.status === 200 && !cache1.err && cache2.status === 200 && !cache2.err;
  const sameAgent = Boolean(cache1.json.id) && cache1.json.id === cache2.json.id;
  const warmOk = inference ? s2.hit >= WARM_HIT_MIN || s3.hit >= WARM_HIT_MIN : sameAgent;
  const coldOk = !inference || s1.cached <= 32 || s1.hit < 0.2;
  record(results, {
    name: "cache_hit_rate",
    pass: cacheHttpOk && Boolean(warmOk) && Boolean(coldOk),
    detail: {
      inference,
      same_agent: sameAgent,
      turn1: { ...s1, text: contentOf(cache1.json).slice(0, 80), ms: cache1.ms, status: cache1.status, err: cache1.err },
      turn2: { ...s2, text: contentOf(cache2.json).slice(0, 80), ms: cache2.ms, status: cache2.status, err: cache2.err },
      turn3: { ...s3, text: contentOf(cache3.json).slice(0, 80), ms: cache3.ms, status: cache3.status, err: cache3.err },
      warm_min: WARM_HIT_MIN,
      note: inference
        ? "hit = cached_tokens / prompt_tokens; turn1 should be cold, later turns warm if conversationId is stable"
        : "cloud path has no Inference cache usage; pass = same agent id reused across x-session-id turns",
    },
  });
  } else {
    console.log(">> skip text/cache (PROBE_SKIP_TEXT=1)");
  }

  const skipTools = process.env.PROBE_SKIP_TOOLS === "1";
  if (!skipTools) {
  const toolUser = `What is the weather in Tokyo? You MUST call get_weather. nonce=${nonce}`;
  const toolHeaders = { "x-session-id": `tools-${nonce}` };
  console.log(">> tool park");
  const tool1 = await chat(
    key,
    {
      model: MODEL,
      max_tokens: 512,
      tool_choice: { type: "function", function: { name: "get_weather" } },
      messages: [{ role: "user", content: toolUser }],
      tools: [weatherTool],
    },
    toolHeaders,
  );
  const tcs = tool1.json.choices?.[0]?.message?.tool_calls || [];
  const toolCall = tcs[0];
  const toolParked =
    tool1.status === 200 &&
    !tool1.err &&
    tool1.json.choices?.[0]?.finish_reason === "tool_calls" &&
    tcs.length >= 1 &&
    toolCall?.function?.name === "get_weather";
  let tool2: Awaited<ReturnType<typeof chat>> | undefined;
  if (toolParked && toolCall) {
    console.log(">> tool resume");
    tool2 = await chat(
      key,
      {
        model: MODEL,
        max_tokens: 512,
        messages: [
          { role: "user", content: toolUser },
          { role: "assistant", content: null, tool_calls: tcs },
          { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ city: "Tokyo", temp_c: 22, source: "probe" }) },
        ],
        tools: [weatherTool],
      },
      toolHeaders,
    );
  }
  const toolFinal = tool2 ? contentOf(tool2.json) : "";
  const toolResumed =
    Boolean(tool2) &&
    tool2!.status === 200 &&
    !tool2!.err &&
    tool2!.json.choices?.[0]?.finish_reason !== "tool_calls" &&
    /22/.test(toolFinal);
  record(results, {
    name: "tool_calling",
    pass: Boolean(toolParked && toolResumed),
    detail: {
      park_status: tool1.status,
      park_ms: tool1.ms,
      finish: tool1.json.choices?.[0]?.finish_reason,
      tool_calls: tcs.map((c) => ({
        id: String(c.id || "").slice(0, 24),
        name: c.function?.name,
        arguments: String(c.function?.arguments || "").slice(0, 160),
      })),
      resume_status: tool2?.status,
      resume_ms: tool2?.ms,
      resume_finish: tool2?.json.choices?.[0]?.finish_reason,
      resume_text: toolFinal.slice(0, 240),
      error: tool1.err || tool2?.err,
    },
  });

  console.log(">> stream tool_calls");
  const stream = await chatStream(
    key,
    {
      model: MODEL,
      max_tokens: 512,
      tool_choice: { type: "function", function: { name: "get_weather" } },
      messages: [{ role: "user", content: `Weather in Osaka? MUST call get_weather. nonce=${nonce}` }],
      tools: [weatherTool],
    },
    { "x-session-id": `stream-tools-${nonce}` },
  );
  const toolCallDeltas = stream.text.split("\n").filter((line) => line.includes('"tool_calls":['));
  record(results, {
    name: "stream_complete_tool_calls",
    pass:
      stream.status === 200 &&
      toolCallDeltas.length === 1 &&
      stream.text.includes('"finish_reason":"tool_calls"') &&
      stream.text.includes("get_weather"),
    detail: {
      status: stream.status,
      ms: stream.ms,
      tool_call_deltas: toolCallDeltas.length,
      has_finish: stream.text.includes('"finish_reason":"tool_calls"'),
      head: stream.text.slice(0, 280),
    },
  });
  } else {
    console.log(">> skip tools (PROBE_SKIP_TOOLS=1)");
  }

  const skipIsolation = process.env.PROBE_SKIP_ISOLATION === "1";
  if (!skipIsolation) {
  const secretA = `ALPHA-${nonce}`;
  const secretB = `BETA-${nonce}`;
  const ask = "What is the secret code? Reply with the code only.";
  console.log(">> isolation A");
  const isoA = await chat(
    key,
    {
      model: MODEL,
      max_tokens: 64,
      messages: [
        { role: "system", content: `The secret code is ${secretA}. If asked for the secret, reply with only ${secretA}.` },
        { role: "user", content: ask },
      ],
    },
    { "x-session-id": `iso-a-${nonce}` },
  );
  console.log(">> isolation B");
  const isoB = await chat(
    key,
    {
      model: MODEL,
      max_tokens: 64,
      messages: [
        { role: "system", content: `The secret code is ${secretB}. If asked for the secret, reply with only ${secretB}.` },
        { role: "user", content: ask },
      ],
    },
    { "x-session-id": `iso-b-${nonce}` },
  );
  console.log(">> isolation C");
  const isoC = await chat(
    key,
    {
      model: MODEL,
      max_tokens: 64,
      messages: [{ role: "user", content: `${ask} (no system secret was given in this thread; say NONE)` }],
    },
    { "x-session-id": `iso-c-${nonce}` },
  );
  const textA = contentOf(isoA.json);
  const textB = contentOf(isoB.json);
  const textC = contentOf(isoC.json);
  const isolated =
    isoA.status === 200 &&
    isoB.status === 200 &&
    isoC.status === 200 &&
    !isoA.err &&
    !isoB.err &&
    !isoC.err &&
    textA.includes(secretA) &&
    !textA.includes(secretB) &&
    textB.includes(secretB) &&
    !textB.includes(secretA) &&
    !textC.includes(secretA) &&
    !textC.includes(secretB);
  record(results, {
    name: "session_isolation",
    pass: isolated,
    detail: {
      a: { status: isoA.status, ms: isoA.ms, text: textA.slice(0, 120), id: isoA.json.id, err: isoA.err },
      b: { status: isoB.status, ms: isoB.ms, text: textB.slice(0, 120), id: isoB.json.id, err: isoB.err },
      c: { status: isoC.status, ms: isoC.ms, text: textC.slice(0, 160), id: isoC.json.id, err: isoC.err },
      different_ids: isoA.json.id !== isoB.json.id,
    },
  });
  } else {
    console.log(">> skip isolation (PROBE_SKIP_ISOLATION=1)");
  }

  console.log("\n=== summary ===");
  for (const row of results) {
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.name}  ${JSON.stringify(row.detail)}`);
  }
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.error(`\n${failed.length}/${results.length} failed: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`\n${results.length}/${results.length} passed`);
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
