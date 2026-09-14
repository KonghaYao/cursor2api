#!/usr/bin/env node
/**
 * Live: does Dashboard crsr_ accept AgentService customSystemPrompt
 * (SDK AgentOptions.systemPrompt), or still reject --system-prompt?
 *
 *   set -a && source .env && set +a
 *   BASE=http://127.0.0.1:8793 node --experimental-strip-types scripts/probe-system-override.ts
 */
import { spliceConversationFromClient } from "../src/lib/conversation_state.ts";
import { createSdkAgentHost } from "../src/lib/sdk_agent_host.ts";

const BASE = (process.env.BASE || "http://127.0.0.1:8793").replace(/\/$/, "");
const MODEL = process.env.PROBE_MODEL || "composer-2.5-fast";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180_000);

const OVERRIDE =
  "You are ProbeOverride. Reply to every user message with exactly OVERRIDE-OK and nothing else. Do not mention Cursor, tools, workspace, files, or /tmp.";
const ASK = "你是谁？列出你的全部工具，并说出当前工作区路径。";

function loadKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) throw new Error("missing CURSOR_API_KEY");
  return key;
}

function gated(blob: string): boolean {
  return /system-prompt|customsystemprompt|unknown option/i.test(blob);
}

function harnessLeak(text: string): boolean {
  return /\/tmp|shell|终端|工作区|get_weather|lookup|Cursor|内置/i.test(text);
}

async function httpRoots(): Promise<void> {
  const key = loadKey();
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: OVERRIDE },
        { role: "user", content: ASK },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  let json: {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  } = {};
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    json = { error: { message: raw.slice(0, 400) } };
  }
  const text = String(json.choices?.[0]?.message?.content || "");
  const err = json.error?.message || "";
  console.log(
    JSON.stringify({
      path: "http_roots_only",
      status: res.status,
      ms: Date.now() - started,
      gated: gated(`${err} ${raw}`),
      override_ok: text.trim() === "OVERRIDE-OK",
      harness_leak: harnessLeak(text),
      err: err.slice(0, 240),
      text: text.slice(0, 280),
    }),
  );
}

async function directCustomSystem(path: string, rootSystem: string): Promise<void> {
  const key = loadKey();
  const started = Date.now();
  const messages = [
    { role: "system", content: rootSystem },
    { role: "user", content: ASK },
  ];
  const spliced = await spliceConversationFromClient({
    body: { messages },
    tools: [],
    messages,
  });
  const host = createSdkAgentHost();
  const agent = await host.create({
    apiKey: key,
    model: MODEL,
    customTools: {},
    customSystemPrompt: OVERRIDE,
  });
  try {
    const result = await (
      await agent.send(spliced.prompt, {
        conversationState: spliced.conversationState,
        blobs: spliced.blobs,
        customSystemPrompt: OVERRIDE,
      })
    ).wait();
    const text = String(result.text || "");
    const err = String(result.error || "");
    console.log(
      JSON.stringify({
        path,
        ms: Date.now() - started,
        gated: gated(`${err} ${text}`),
        override_ok: /^\s*OVERRIDE-OK\s*$/.test(text),
        harness_leak: harnessLeak(text),
        err: err.slice(0, 240),
        text: text.slice(0, 280),
      }),
    );
  } finally {
    await Promise.race([agent.close(), new Promise((r) => setTimeout(r, 1_000))]);
  }
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  if (!health || health.status !== 200) throw new Error(`gateway not healthy at ${BASE}`);
  console.log(`base=${BASE} model=${MODEL}`);
  await httpRoots();
  await directCustomSystem("direct_override_plus_neutral_roots", "You are a helpful assistant.");
  await directCustomSystem("direct_override_plus_same_roots", OVERRIDE);
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
