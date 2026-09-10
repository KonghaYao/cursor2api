#!/usr/bin/env node
/**
 * Probe Cursor InferenceService/Stream thinking frames for Grok variants.
 * Prints only frame keys / short text — never dumps credentials.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLIENT_VERSION, CURSOR_BASE, exchangeApiKey, sdkHeaders } from "../src/lib/auth.ts";
import { bytesBody, decodeConnectFrames, encodeConnectFrame, randomId } from "../src/lib/bytes.ts";
import { collectTurn, cursorBody } from "../src/lib/inference.ts";

function loadEnvKey(): string {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith("CURSOR_API_KEY="));
  if (!line) throw new Error("missing CURSOR_API_KEY");
  return line.slice("CURSOR_API_KEY=".length).trim();
}

function summarize(label: string, status: number, frames: Awaited<ReturnType<typeof decodeConnectFrames>>) {
  const turn = collectTurn(frames);
  const keys = new Map<string, number>();
  const extra: string[] = [];
  for (const frame of frames) {
    const j = frame.json;
    if (!j) continue;
    for (const k of Object.keys(j)) keys.set(k, (keys.get(k) || 0) + 1);
    const tp = j.thinkingPart as Record<string, unknown> | undefined;
    if (tp) extra.push(`thinkingPartKeys=${Object.keys(tp).join(",")} textLen=${String(tp.text || "").length} sigLen=${String(tp.signature || "").length}`);
    const ri = j.responseInfo as Record<string, unknown> | undefined;
    if (ri) {
      extra.push(`responseInfoKeys=${Object.keys(ri).join(",")}`);
      if (ri.inferenceExtraData) extra.push(`extra=${JSON.stringify(ri.inferenceExtraData).slice(0, 300)}`);
      for (const m of (ri.messages as Array<Record<string, unknown>> | undefined) || []) {
        const parts = (m.reasoningParts as Array<Record<string, unknown>> | undefined) || [];
        extra.push(
          `msgKeys=${Object.keys(m).join(",")} reasoningN=${parts.length} texts=${parts.map((p) => String(p.text || "").length).join(",")} redacted=${parts.map((p) => p.isRedacted).join(",")}`,
        );
      }
    }
    if (j.error) extra.push(`error=${JSON.stringify(j.error).slice(0, 180)}`);
    if (j.usage) extra.push(`usage=${JSON.stringify(j.usage)}`);
  }
  console.log(`\n=== ${label} status=${status} frames=${frames.length} thinking=${turn.thinking.length} text=${turn.text.length} redacted=${Boolean(turn.thinkingRedacted)} ===`);
  console.log("keys", Object.fromEntries(keys));
  console.log("thinkingHead", JSON.stringify(turn.thinking.slice(0, 80)));
  console.log("textHead", JSON.stringify(turn.text.slice(0, 80)));
  if (extra.length) console.log(extra.join("\n"));
}

async function run(accessToken: string, label: string, body: Record<string, unknown>, headerExtra: Record<string, string> = {}) {
  const sessionId = String(body.conversationId || randomId());
  console.log(`\n>> ${label} modelId=${body.modelId} headerExtra=${JSON.stringify(headerExtra)}`);
  const res = await fetch(`${CURSOR_BASE}/aiserver.v1.InferenceService/Stream`, {
    method: "POST",
    headers: {
      ...sdkHeaders(accessToken),
      "x-session-id": sessionId,
      "content-type": "application/connect+json",
      "connect-accept-encoding": "gzip",
      ...headerExtra,
    },
    body: bytesBody(encodeConnectFrame(body)),
  });
  const frames = await decodeConnectFrames(new Uint8Array(await res.arrayBuffer()));
  summarize(label, res.status, frames);
}

const key = loadEnvKey();
const { accessToken } = await exchangeApiKey(key);
const prompt = "Think step by step: what is 17*19? Reply with the product only after reasoning.";

const cases: Array<{ label: string; model: string; extra?: Parameters<typeof cursorBody>[0] }> = [
  { label: "composer-fast", model: "composer-2.5-fast" },
  { label: "grok-std", model: "grok-4.6" },
  { label: "grok-fast", model: "grok-4.6-fast" },
];

for (const c of cases) {
  const conversationId = `probe-${c.label}-${Date.now()}`;
  const body = cursorBody({
    messages: [{ role: "INFERENCE_MESSAGE_ROLE_USER", text: prompt }],
    conversationId,
    model: c.model,
    maxTokens: 1024,
    reasoningEffort: c.extra?.reasoningEffort,
    maxMode: c.extra?.maxMode,
  });
  await run(accessToken, c.label, body);
}

console.log("clientVersion", CLIENT_VERSION);
