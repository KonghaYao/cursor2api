#!/usr/bin/env node
/**
 * Live: does AgentService honour `userMessage.mode` plan vs agent?
 *
 *   set -a && source .env && set +a
 *   BASE=http://127.0.0.1:8793 node --experimental-strip-types scripts/probe-plan-mode.ts
 */
import { spliceConversationFromClient } from "../src/lib/conversation_state.ts";
import { createSdkAgentHost } from "../src/lib/sdk_agent_host.ts";

const BASE = (process.env.BASE || "http://127.0.0.1:8793").replace(/\/$/, "");
const MODEL = process.env.PROBE_MODEL || "composer-2.5-fast";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180_000);

function loadKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) throw new Error("missing CURSOR_API_KEY");
  return key;
}

async function directMode(mode: "agent" | "plan", prompt: string): Promise<void> {
  const key = loadKey();
  const started = Date.now();
  const messages = [{ role: "user", content: prompt }];
  const spliced = await spliceConversationFromClient({
    body: { messages, mode },
    tools: [],
    messages,
  });
  const host = createSdkAgentHost();
  const agent = await host.create({ apiKey: key, model: MODEL, customTools: {} });
  try {
    const result = await (
      await agent.send(spliced.prompt, {
        conversationState: spliced.conversationState,
        blobs: spliced.blobs,
        mode,
      })
    ).wait();
    console.log(
      JSON.stringify({
        path: `direct_mode_${mode}`,
        ms: Date.now() - started,
        err: String(result.error || "").slice(0, 240),
        text: String(result.text || "").slice(0, 400),
      }),
    );
  } finally {
    await Promise.race([agent.close(), new Promise((r) => setTimeout(r, 1_000))]);
  }
}

async function httpMode(mode: "agent" | "plan", prompt: string): Promise<void> {
  const key = loadKey();
  const started = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      mode,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  let json: { choices?: Array<{ message?: { content?: string | null } }>; error?: { message?: string } } = {};
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    json = { error: { message: raw.slice(0, 400) } };
  }
  console.log(
    JSON.stringify({
      path: `http_mode_${mode}`,
      status: res.status,
      ms: Date.now() - started,
      err: String(json.error?.message || "").slice(0, 240),
      text: String(json.choices?.[0]?.message?.content || "").slice(0, 400),
    }),
  );
}

async function main(): Promise<void> {
  const planPrompt =
    process.env.PROBE_PLAN_PROMPT ||
    "Outline a 3-step plan to add a /health endpoint. Do not write files yet — planning only.";
  const agentPrompt =
    process.env.PROBE_AGENT_PROMPT || "Reply with exactly PLAN-MODE-PROBE-OK and nothing else.";
  await httpMode("plan", planPrompt);
  await httpMode("agent", agentPrompt);
  await directMode("plan", planPrompt);
  await directMode("agent", agentPrompt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
