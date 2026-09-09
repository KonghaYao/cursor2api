/**
 * Gateway-owned text tool protocol for AgentService/Run with empty upstream tools.
 * Models emit `<gw_tool_call>` JSON blocks; the gateway parses them into
 * OpenAI / Anthropic tool_calls. No npm parser deps.
 */
import { randomId } from "./bytes.ts";

export const GW_TOOL_CALL_OPEN = "<gw_tool_call>";
export const GW_TOOL_CALL_CLOSE = "</gw_tool_call>";
export const GW_TOOL_RESULTS_OPEN = "<gw_tool_results>";
export const GW_TOOL_RESULTS_CLOSE = "</gw_tool_results>";
export const MAX_GW_TOOL_CALL_BLOCK_BYTES = 256 * 1024;

export type GwToolCatalogItem = {
  name: string;
  openaiName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type ParsedGwToolCall = {
  name: string;
  internalName: string;
  arguments: Record<string, unknown>;
};

export type GwToolResult = {
  id: string;
  name?: string;
  content: string;
  isError?: boolean;
};

function skipWs(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i]!)) i += 1;
  return i;
}

/** Brace-aware JSON object scanner; strings may contain the closer tag. */
export function extractJsonObject(src: string, start: number): { end: number; raw: string } | undefined {
  const from = skipWs(src, start);
  if (src[from] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = from; i < src.length; i++) {
    if (i - from > MAX_GW_TOOL_CALL_BLOCK_BYTES) return undefined;
    const c = src[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return { end: i + 1, raw: src.slice(from, i + 1) };
    }
  }
  return undefined;
}

type LocatedBlock = { open: number; closeEnd: number; json: string };

function locateGwToolCallBlocks(text: string): LocatedBlock[] {
  const out: LocatedBlock[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const open = text.indexOf(GW_TOOL_CALL_OPEN, searchFrom);
    if (open < 0) break;
    const jsonStart = open + GW_TOOL_CALL_OPEN.length;
    const extracted = extractJsonObject(text, jsonStart);
    if (!extracted) {
      searchFrom = jsonStart;
      continue;
    }
    const closeAt = skipWs(text, extracted.end);
    if (!text.startsWith(GW_TOOL_CALL_CLOSE, closeAt)) {
      searchFrom = jsonStart;
      continue;
    }
    out.push({ open, closeEnd: closeAt + GW_TOOL_CALL_CLOSE.length, json: extracted.raw });
    searchFrom = closeAt + GW_TOOL_CALL_CLOSE.length;
  }
  return out;
}

function asArgs(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      return asArgs(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export function parseGwToolCalls(text: string, catalog: GwToolCatalogItem[]): ParsedGwToolCall[] {
  const allowed = new Map<string, GwToolCatalogItem>();
  for (const item of catalog) {
    if (item.openaiName) allowed.set(item.openaiName, item);
    if (item.name) allowed.set(item.name, item);
  }
  const out: ParsedGwToolCall[] = [];
  for (const block of locateGwToolCallBlocks(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const rec = parsed as Record<string, unknown>;
    const name = String(rec.name || "").trim();
    if (!name) continue;
    const def = allowed.get(name);
    if (!def) continue;
    const args = asArgs(rec.arguments ?? rec.parameters ?? rec.input);
    if (!args) continue;
    out.push({ name: def.openaiName, internalName: def.name, arguments: args });
  }
  return out;
}

export function stripGwToolCallFences(text: string): string {
  const blocks = locateGwToolCallBlocks(text);
  if (!blocks.length) return text;
  let out = "";
  let cursor = 0;
  for (const block of blocks) {
    out += text.slice(cursor, block.open);
    cursor = block.closeEnd;
  }
  out += text.slice(cursor);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function splitAssistantToolText(
  text: string,
  catalog: GwToolCatalogItem[],
): { calls: ParsedGwToolCall[]; visibleText: string } {
  const calls = parseGwToolCalls(text, catalog);
  return { calls, visibleText: stripGwToolCallFences(text) };
}

export function gwToolCallsToOpenAi(calls: ParsedGwToolCall[]) {
  return calls.map((call, i) => ({
    id: `call_${randomId().replace(/-/g, "")}`,
    type: "function" as const,
    index: i,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  }));
}

export function gwToolCallsToAnthropic(calls: ParsedGwToolCall[]) {
  return calls.map((call) => ({
    type: "tool_use" as const,
    id: `call_${randomId().replace(/-/g, "")}`,
    name: call.name,
    input: call.arguments ?? {},
  }));
}

function toolChoicePolicy(body: Record<string, unknown>, tools: GwToolCatalogItem[]): string {
  if (!tools.length) return "";
  const extra: string[] = [];
  const choice = body.tool_choice ?? body.toolChoice;
  const rec = choice && typeof choice === "object" && !Array.isArray(choice)
    ? (choice as Record<string, unknown>)
    : undefined;
  const type = typeof choice === "string" ? choice : String(rec?.type || rec?.mode || "auto");
  const fn = rec?.function && typeof rec.function === "object" ? (rec.function as Record<string, unknown>) : rec;
  if (type === "none") {
    extra.push("Do not emit any <gw_tool_call> blocks. Reply with text only.");
  } else if (type === "required" || type === "any") {
    extra.push("You MUST emit at least one <gw_tool_call> block. Do not respond with only text.");
  } else if (type === "function" || type === "tool") {
    const name = String(fn?.name || rec?.name || "");
    if (name) extra.push(`You MUST call the tool named ${name}. Do not call any other tool.`);
  } else {
    extra.push("When a listed tool applies, emit <gw_tool_call> instead of only describing the steps in prose.");
  }
  const parallel = body.parallel_tool_calls ?? body.parallelToolCalls;
  if (parallel === false || rec?.disable_parallel_tool_use === true) {
    extra.push("Emit at most one <gw_tool_call> block in this turn.");
  }
  return extra.join(" ");
}

export function composeReplacementSystemPrompt(opts: {
  clientSystem: string;
  tools: GwToolCatalogItem[];
  body?: Record<string, unknown>;
}): string {
  const client = (opts.clientSystem || "").trim();
  if (!opts.tools.length) return client;
  const catalog = opts.tools.map((t) => ({
    name: t.openaiName,
    description: t.description || t.openaiName,
    parameters: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
  }));
  const policy = toolChoicePolicy(opts.body || {}, opts.tools);
  const appendix = [
    "You have no Cursor builtin tools (no shell / edit / grep / MCP).",
    "MCP list/read resource tools may appear in the session; they cannot run client functions and cannot look up catalog facts.",
    "The catalog below IS available. Never say a listed tool is unavailable. Do not call MCP for these functions.",
    "If you need a client function, write one or more of the following blocks in your reply and then stop.",
    "You may write one or two sentences before the blocks. Do not put calls in thinking.",
    "",
    `${GW_TOOL_CALL_OPEN}`,
    `{"name":"<exact catalog name>","arguments":{}}`,
    `${GW_TOOL_CALL_CLOSE}`,
    "",
    "Parallel: consecutive <gw_tool_call> blocks.",
    "Catalog (JSON Schema; names must match exactly):",
    JSON.stringify(catalog),
    policy ? `Policy: ${policy}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return [client, appendix].filter(Boolean).join("\n\n");
}

export function composeGwToolResultsPrompt(results: GwToolResult[]): string {
  const payload = results.map((r) => ({
    id: r.id,
    name: r.name || "",
    content: r.content,
    is_error: Boolean(r.isError),
  }));
  return [
    GW_TOOL_RESULTS_OPEN,
    JSON.stringify(payload),
    GW_TOOL_RESULTS_CLOSE,
    "Continue from these results. Do not call the same tools again unless you need new data.",
  ].join("\n");
}
