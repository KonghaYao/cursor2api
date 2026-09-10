#!/usr/bin/env node
/**
 * Probe gpt-5.6-luna via GetUsableModels + InferenceService/Stream.
 * Never prints credentials.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CURSOR_BASE, connectUnary, exchangeApiKey, sdkHeaders } from "../src/lib/auth.ts";
import { bytesBody, decodeConnectFrames, encodeConnectFrame, randomId } from "../src/lib/bytes.ts";
import { collectTurn, cursorBody, ROLE } from "../src/lib/inference.ts";

function loadEnvKey(): string {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith("CURSOR_API_KEY="));
  if (!line) throw new Error("missing CURSOR_API_KEY");
  return line.slice("CURSOR_API_KEY=".length).trim();
}

function summarizeModel(m: Record<string, unknown>): string {
  const keys = Object.keys(m);
  const id = m.modelId || m.model_id || m.displayModelId || m.id || m.name;
  return JSON.stringify({ id, keys, sample: Object.fromEntries(keys.slice(0, 12).map((k) => [k, m[k]])) });
}

async function dumpUsable(accessToken: string) {
  const r = await connectUnary("/agent.v1.AgentService/GetUsableModels", accessToken, {});
  const json = r.json || {};
  const topKeys = Object.keys(json);
  const models = (json.models as Array<Record<string, unknown>> | undefined) || [];
  const hits = models.filter((m) => {
    const blob = JSON.stringify(m).toLowerCase();
    return blob.includes("luna") || blob.includes("gpt-5") || blob.includes("terra") || blob.includes("sol");
  });
  console.log(`GetUsableModels status=${r.status} ok=${r.ok} topKeys=${topKeys.join(",")} n=${models.length} lunaHits=${hits.length}`);
  if (models[0]) console.log("firstModel", summarizeModel(models[0]));
  for (const m of hits.slice(0, 20)) console.log("hit", summarizeModel(m));
  for (const k of topKeys) {
    if (k === "models") continue;
    const v = json[k];
    const s = JSON.stringify(v);
    if (s && /luna|gpt-5|terra|sol/i.test(s)) console.log(`extra.${k}`, s.slice(0, 500));
    else console.log(`extra.${k}`, typeof v === "object" ? `type=${Array.isArray(v) ? "array" : "object"} len=${s?.length}` : v);
  }
}

async function infer(
  accessToken: string,
  label: string,
  model: string,
  extra: Partial<Parameters<typeof cursorBody>[0]> = {},
  builtIn?: boolean,
) {
  const conversationId = `probe-luna-${randomId()}`;
  const body = cursorBody({
    messages: [{ role: ROLE.user, text: "Reply with exactly: PONG" }],
    model,
    conversationId,
    maxTokens: 64,
    ...extra,
  });
  if (builtIn === false && body.requestedModel && typeof body.requestedModel === "object") {
    (body.requestedModel as Record<string, unknown>).builtInModel = false;
  }
  const res = await fetch(`${CURSOR_BASE}/aiserver.v1.InferenceService/Stream`, {
    method: "POST",
    headers: {
      ...sdkHeaders(accessToken),
      "x-session-id": conversationId,
      "content-type": "application/connect+json",
      "connect-accept-encoding": "gzip",
    },
    body: bytesBody(encodeConnectFrame(body)),
  });
  const frames = await decodeConnectFrames(new Uint8Array(await res.arrayBuffer()));
  const turn = collectTurn(frames);
  const err = turn.error ? JSON.stringify(turn.error).slice(0, 240) : "";
  console.log(
    `${label} http=${res.status} modelId=${body.modelId} builtIn=${(body.requestedModel as Record<string, unknown>)?.builtInModel} frames=${frames.length} text=${JSON.stringify(turn.text.slice(0, 80))} err=${err}`,
  );
}

const key = loadEnvKey();
const { accessToken } = await exchangeApiKey(key);
await dumpUsable(accessToken);

const models = [
  "gpt-5.6-luna",
  "gpt-5.6-luna-high",
  "gpt-5.6-luna-high-fast",
  "gpt-5.6-luna-medium",
  "gpt-5.6-luna-low",
  "gpt-5.6-luna-none",
  "gpt-5.6-luna-fast",
  "gpt-5.6-luna-max",
];

for (const model of models) {
  await infer(accessToken, model, model);
}

await infer(accessToken, "luna-high-builtin-false", "gpt-5.6-luna-high", {}, false);
await infer(accessToken, "luna-high-effort-param", "gpt-5.6-luna", { reasoningEffort: "high" });
