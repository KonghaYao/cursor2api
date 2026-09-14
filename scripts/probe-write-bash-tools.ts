#!/usr/bin/env node
/**
 * Live 5-turn Write + Bash + Edit regression against a running gateway.
 * Catches wire catalog loss and Composer "only MCP" essays after multi-round tool use.
 *
 *   set -a && source .env && set +a
 *   BASE=http://127.0.0.1:8793 node --experimental-strip-types scripts/probe-write-bash-tools.ts
 */
const BASE = (process.env.BASE || "http://127.0.0.1:8789").replace(/\/$/, "");
const MODEL = process.env.PROBE_MODEL || "composer-2.5-fast";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180_000);
const PAD_CHARS = Math.max(0, Number(process.env.PROBE_PAD_CHARS || 24_000));

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
  const text = contentOf(json);
  const blob = `${m || ""} ${text}`;
  if (/Conversation state is required/i.test(blob)) return "invalid_argument: Conversation state is required";
  return m ? String(m).slice(0, 400) : undefined;
}

function paddedSystem(): string {
  const pad = "workspace notes. ".repeat(Math.ceil(PAD_CHARS / 17)).slice(0, PAD_CHARS);
  return (
    `You are a coding agent on the user's computer. Native tools: Read, Write, Edit, Bash, Grep.\n` +
    `When asked to change files or run shell commands, call Write/Edit/Bash immediately.\n${pad}`
  );
}

function contentOf(json: ChatJson): string {
  return String(json.choices?.[0]?.message?.content || "");
}

function toolCallsOf(json: ChatJson): ToolCall[] {
  return json.choices?.[0]?.message?.tool_calls || [];
}

const CATALOG = [
  {
    type: "custom",
    name: "Write",
    description: "Write a file path with contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, contents: { type: "string" } },
      required: ["path", "contents"],
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description: "Replace old_string with new_string in a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Run a shell command on the user's computer.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];

function mcpEssay(text: string): boolean {
  return /only mcp|listmcpresources|custom-user-tools|tool list changed|don't have (?:Write|Edit|Bash)/i.test(text);
}

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
    json = { error: { message: raw.slice(0, 200) } };
  }
  return { status: res.status, json, raw, ms: Date.now() - started };
}

async function main(): Promise<void> {
  const key = loadKey();
  const nonce = Date.now();
  const system = { role: "system", content: paddedSystem() };
  const messages: unknown[] = [system];
  let conversationId: string | undefined;

  console.log(`>> probe write-bash-tools base=${BASE} model=${MODEL}`);

  const turns: Array<{ user: string; expectTool?: string; allowText?: boolean }> = [
    { user: `Create /tmp/gw-probe-${nonce}.txt with exactly the line PROBE-${nonce}. Use Write now.`, expectTool: "Write" },
    { user: "Good. Now run Bash: wc -c on that file and report the byte count.", expectTool: "Bash" },
    { user: "Use Edit to change PROBE to DONE in that same file.", expectTool: "Edit" },
    { user: "Run Bash again to cat the file so we see DONE.", expectTool: "Bash" },
    { user: "Summarize what you did in one sentence. Do not call tools.", allowText: true },
  ];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    messages.push({ role: "user", content: turn.user });
    const res = await chat(key, {
      model: MODEL,
      max_tokens: 512,
      tools: CATALOG,
      tool_choice: "auto",
      messages,
    });
    conversationId = conversationId || res.json.conversation_id;
    const tc = toolCallsOf(res.json);
    const text = contentOf(res.json);
    const finish = res.json.choices?.[0]?.finish_reason;
    const err = errOf(res.json);

    if (turn.expectTool) {
      const got = tc[0]?.function?.name;
      const pass =
        res.status === 200 &&
        !err &&
        finish === "tool_calls" &&
        got === turn.expectTool &&
        !mcpEssay(text) &&
        (!conversationId || res.json.conversation_id === conversationId);
      record({
        name: `turn${i + 1}_${turn.expectTool.toLowerCase()}`,
        pass,
        detail: {
          status: res.status,
          ms: res.ms,
          finish,
          got,
          conversation_id: res.json.conversation_id,
          error: err,
          mcp_essay: mcpEssay(text),
          content: text.slice(0, 180),
        },
      });
      if (!pass) {
        console.log(`turn${i + 1}_raw_head`, res.raw.slice(0, 800));
        process.exit(1);
      }
      messages.push({ role: "assistant", content: null, tool_calls: tc });
      messages.push({
        role: "tool",
        tool_call_id: tc[0]!.id,
        content:
          turn.expectTool === "Write"
            ? "wrote file"
            : turn.expectTool === "Edit"
              ? "edited file"
              : "42 /tmp/gw-probe.txt\nDONE",
      });
      continue;
    }

    const pass =
      res.status === 200 &&
      !err &&
      finish !== "tool_calls" &&
      text.trim().length > 0 &&
      !mcpEssay(text) &&
      res.json.conversation_id === conversationId;
    record({
      name: "turn5_summary",
      pass,
      detail: {
        status: res.status,
        ms: res.ms,
        finish,
        conversation_id: res.json.conversation_id,
        error: err,
        mcp_essay: mcpEssay(text),
        content: text.slice(0, 240),
      },
    });
    if (!pass) {
      console.log("turn5_raw_head", res.raw.slice(0, 800));
      process.exit(1);
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`summary ${results.length - failed.length}/${results.length} pass`);
  if (failed.length) process.exit(1);
}

await main();
