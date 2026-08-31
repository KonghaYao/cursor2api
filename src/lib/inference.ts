import { CLIENT_VERSION, CURSOR_BASE, sdkHeaders } from "./auth.ts";
import { decodeConnectFrames, encodeConnectFrame, bytesBody, randomId, type ConnectFrame } from "./bytes.ts";

export function resolveModel(model: unknown): string {
  return String(model ?? "");
}

/**
 * Cursor Composer Fast/Standard are distinct GetUsableModels route ids (e.g. `composer-2.5-fast`).
 * Grok public ids (`grok-4.6-fast`) map to flat routes (`cursor-grok-4.6-high-fast`); max effort → xhigh(-fast).
 */
function parsePublicGrokModel(clientModel: string): { family: "4.6" | "4.5"; fast: boolean } | null {
  const id = clientModel.toLowerCase().trim();
  let m = id.match(/^grok-4\.6(?:-fast)?$/);
  if (m) return { family: "4.6", fast: id.endsWith("-fast") };
  m = id.match(/^grok-4\.5(?:-fast)?$/);
  if (m) return { family: "4.5", fast: id.endsWith("-fast") };
  return null;
}

function grokCursorFlatRoute(family: "4.6" | "4.5", effort: string, fast: boolean): string {
  const ver = family;
  return `cursor-grok-${ver}-${effort}${fast ? "-fast" : ""}`;
}

export function resolveCursorModelRoute(
  model: unknown,
  opts?: { fast?: boolean; reasoningEffort?: unknown },
): { routeId: string; clientModel: string } {
  const clientModel = String(model ?? "").trim();
  let routeId = clientModel;

  if (/^cursor-grok-/i.test(routeId)) {
    return { routeId, clientModel: clientModel || routeId };
  }

  const grok = parsePublicGrokModel(routeId);
  if (grok) {
    const fast = grok.fast || Boolean(opts?.fast);
    const familyKey = grok.family === "4.6" ? "grok-4.6" : "grok-4.5";
    const effort = mapGrokEffort(familyKey, opts?.reasoningEffort) ?? "high";
    routeId = grokCursorFlatRoute(grok.family, effort, fast);
    return { routeId, clientModel: clientModel || routeId };
  }

  const alreadyFast = /-fast$/i.test(routeId);
  if (!alreadyFast && opts?.fast && /^composer-[\d.]+$/i.test(routeId)) {
    routeId = `${routeId}-fast`;
  }
  return { routeId, clientModel: clientModel || routeId };
}

export function extractFastMode(body: Record<string, unknown> | null | undefined): boolean {
  if (!body || typeof body !== "object") return false;
  if (body.fast === true || body.fast_mode === true || body.fastMode === true) return true;
  const extra = body.extra_body as Record<string, unknown> | undefined;
  if (extra?.fast === true || extra?.fast_mode === true || extra?.fastMode === true) return true;
  const meta = body.metadata as Record<string, unknown> | undefined;
  if (meta?.fast === true || meta?.fast_mode === true || meta?.fastMode === true) return true;
  return false;
}

export const ROLE = {
  user: "INFERENCE_MESSAGE_ROLE_USER",
  assistant: "INFERENCE_MESSAGE_ROLE_ASSISTANT",
  tool: "INFERENCE_MESSAGE_ROLE_TOOL",
  system: "INFERENCE_MESSAGE_ROLE_SYSTEM",
} as const;

const GROK_EFFORT: Record<string, string[]> = {
  "grok-4.6": ["low", "medium", "high", "xhigh"],
  "grok-4.5": ["low", "medium", "high"],
};
const OPENAI_EFFORT_ALIAS: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  extrahigh: "xhigh",
  max: "max",
};

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type CursorTool = { name: string; description: string; parameters: JsonObject };
export type CursorMessage = Record<string, unknown>;
export type MergedToolCall = { id: string; name: string; args: string; complete: boolean; index?: number };

export type InferenceTurn = {
  status: number;
  frames: ConnectFrame[];
  text: string;
  thinking: string;
  thinkingSignature?: string;
  usage: unknown;
  extendedUsage: unknown;
  providerMetadata: unknown;
  error: unknown;
  toolCalls: MergedToolCall[];
};

function grokEffortFamily(modelId: string): string | null {
  const id = String(modelId || "").toLowerCase();
  if (id.includes("grok-4.6") || id.includes("grok-4-6")) return "grok-4.6";
  if (id.includes("grok-4.5") || id.includes("grok-4-5")) return "grok-4.5";
  return id.includes("grok") ? "grok-4.6" : null;
}

export function extractReasoningEffort(body: Record<string, unknown> | null | undefined): unknown {
  if (!body || typeof body !== "object") return undefined;
  const reasoning = body.reasoning as Record<string, unknown> | undefined;
  return body.reasoning_effort ?? body.reasoningEffort ?? body.effort ?? reasoning?.effort;
}

export function mapGrokEffort(modelId: string, openaiEffort: unknown): string | undefined {
  const family = grokEffortFamily(modelId);
  if (!family) return undefined;
  const levels = GROK_EFFORT[family];
  if (openaiEffort == null || openaiEffort === "") return "high";
  const key = String(openaiEffort).toLowerCase().replace(/[-_\s]/g, "");
  const mapped = OPENAI_EFFORT_ALIAS[key];
  if (!mapped || mapped === "max" || !levels.includes(mapped)) return levels[levels.length - 1];
  return mapped;
}

export function flattenContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const p = part as Record<string, unknown>;
      if (p.type === "text") return String(p.text || "");
      if (p.type === "thinking") return "";
      if (typeof p.text === "string") return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function tryJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function sanitizeToolCallId(id: unknown): string {
  return String(id || "").replace(/[\r\n\t]+/g, "").trim();
}

function isJsonObjectOrArray(text: string): boolean {
  const parsed = tryJsonParse(text);
  return parsed.ok && parsed.value != null && typeof parsed.value === "object";
}

function chunkAsArgsString(args: unknown): string {
  if (args == null || args === "") return "";
  if (typeof args === "string") return args;
  if (typeof args === "object") return JSON.stringify(args);
  return String(args);
}

export function absorbArgsChunk(current: string, chunk: unknown, { complete = false } = {}): string {
  const next = chunkAsArgsString(chunk);
  if (!next) return current || "";
  if ((complete || isJsonObjectOrArray(next)) && isJsonObjectOrArray(next)) return next;
  const combined = `${current || ""}${next}`;
  if (isJsonObjectOrArray(combined)) return combined;
  if (isJsonObjectOrArray(current)) return current;
  return combined;
}

export function repairArgsJson(text: unknown): string {
  const t = String(text || "").trim();
  if (!t) return "{}";
  if (isJsonObjectOrArray(t)) return t;
  const candidates: string[] = [];
  if (!t.startsWith("{") && t.includes(":")) {
    candidates.push(`{${t}}`, `{${t}`);
  }
  for (const candidate of candidates) {
    if (isJsonObjectOrArray(candidate)) return candidate;
  }
  return t;
}

export function parseArgs(raw: unknown): JsonObject {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw as JsonObject;
  let text = repairArgsJson(String(raw).trim());
  for (let i = 0; i < 4; i++) {
    const parsed = tryJsonParse(text);
    if (parsed.ok) {
      if (typeof parsed.value === "string") {
        text = parsed.value;
        continue;
      }
      return parsed.value && typeof parsed.value === "object" ? (parsed.value as JsonObject) : {};
    }
    const repaired = text.replace(/,\s*([}\]])/g, "$1");
    if (repaired === text) break;
    text = repaired;
  }
  return { _raw: String(raw) };
}

function collectSchemaTypes(schema: unknown, acc: Set<string>, depth: number): Set<string> {
  if (!schema || typeof schema !== "object" || depth > 6) return acc;
  const obj = schema as JsonObject;
  const t = obj.type;
  if (typeof t === "string") acc.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") acc.add(x);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const union = obj[key];
    if (!Array.isArray(union)) continue;
    for (const inner of union) collectSchemaTypes(inner, acc, depth + 1);
  }
  return acc;
}

function schemaTypes(schema: unknown): Set<string> {
  return collectSchemaTypes(schema, new Set(), 0);
}

function childSchema(schema: unknown, key: string): JsonObject {
  if (!schema || typeof schema !== "object") return {};
  const obj = schema as JsonObject;
  const props = obj.properties as JsonObject | undefined;
  if (props && Object.prototype.hasOwnProperty.call(props, key)) return (props[key] as JsonObject) || {};
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    return obj.additionalProperties as JsonObject;
  }
  for (const union of ["anyOf", "oneOf"]) {
    const list = obj[union];
    if (!Array.isArray(list)) continue;
    for (const inner of list) {
      const child = childSchema(inner, key);
      if (child && Object.keys(child).length) return child;
    }
  }
  return {};
}

function itemSchema(schema: unknown): JsonObject {
  const obj = schema as JsonObject | undefined;
  if (obj?.items && !Array.isArray(obj.items) && typeof obj.items === "object") return obj.items as JsonObject;
  for (const union of ["anyOf", "oneOf"]) {
    const list = obj?.[union];
    if (!Array.isArray(list)) continue;
    for (const inner of list) {
      const item = (inner as JsonObject)?.items;
      if (item && !Array.isArray(item) && typeof item === "object") return item as JsonObject;
    }
  }
  return {};
}

function stringOnlySchema(types: Set<string>): boolean {
  return (
    types.has("string") &&
    !types.has("integer") &&
    !types.has("number") &&
    !types.has("boolean") &&
    !types.has("array") &&
    !types.has("object")
  );
}

export function coerceJsonBySchema(value: unknown, schema: unknown, depth = 0): unknown {
  if (value == null || depth > 8) return value;
  if (typeof value === "string") {
    const text = value.trim();
    const types = schemaTypes(schema);
    if (text.startsWith("{") || text.startsWith("[")) {
      const parsed = tryJsonParse(text);
      if (parsed.ok) return coerceJsonBySchema(parsed.value, schema, depth + 1);
    }
    if (!stringOnlySchema(types)) {
      const parsed = tryJsonParse(text);
      if (parsed.ok && typeof parsed.value === "number" && Number.isFinite(parsed.value)) {
        if (types.has("integer") && !types.has("number") && !Number.isInteger(parsed.value)) return value;
        return parsed.value;
      }
      if (parsed.ok && typeof parsed.value === "boolean") return parsed.value;
      if (parsed.ok && typeof parsed.value === "string" && parsed.value !== value) {
        const inner = parsed.value.trim();
        if (inner.startsWith("{") || inner.startsWith("[")) {
          return coerceJsonBySchema(parsed.value, schema, depth + 1);
        }
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = itemSchema(schema);
    return value.map((item) => coerceJsonBySchema(item, items, depth + 1));
  }
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value as JsonObject)) {
      out[key] = coerceJsonBySchema(child, childSchema(schema, key), depth + 1) as Json;
    }
    return out;
  }
  return value;
}

export function schemaForTool(tools: CursorTool[] | undefined, name: string): JsonObject {
  const want = String(name || "").toLowerCase();
  const tool = (tools || []).find((t) => String(t?.name || "").toLowerCase() === want);
  return (tool?.parameters || {}) as JsonObject;
}

export function normalizeToolArguments(raw: unknown, schema: JsonObject): string {
  const parsed = parseArgs(raw);
  if (parsed && typeof parsed === "object" && parsed._raw && Object.keys(parsed).length === 1) {
    const recovered = coerceJsonBySchema(String(raw), schema || {});
    if (recovered && typeof recovered === "object" && !(recovered as JsonObject)._raw) {
      return JSON.stringify(recovered);
    }
    return typeof raw === "string" ? raw : JSON.stringify(parsed);
  }
  return JSON.stringify(coerceJsonBySchema(parsed, schema || {}));
}

function cachedTextContent(text: string) {
  return {
    parts: {
      parts: [
        {
          text: {
            text,
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
        },
      ],
    },
  };
}

function markCacheBreakpoint(message: CursorMessage): CursorMessage {
  if (!message?.text || message.parts || message.toolContent) return message;
  const { text, ...rest } = message;
  return { ...rest, ...cachedTextContent(String(text)) };
}

function applyPromptCache(messages: CursorMessage[]): CursorMessage[] {
  if (!messages?.length) return messages;
  let marked = false;
  const out = messages.map((m) => {
    if (m.role === ROLE.system) {
      marked = true;
      return markCacheBreakpoint(m);
    }
    const text = typeof m.text === "string" ? m.text.trim() : "";
    if (m.role === ROLE.user && text && (text.startsWith("<tools-rules>") || text.startsWith("<system>"))) {
      marked = true;
      return markCacheBreakpoint(m);
    }
    return m;
  });
  if (!marked && out[0]) out[0] = markCacheBreakpoint(out[0]);
  return out;
}

export function openaiToolsToCursor(tools: unknown): CursorTool[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      const fn = (t as Record<string, unknown>)?.function || t;
      const rec = fn as Record<string, unknown>;
      if (!rec?.name) return null;
      return {
        name: String(rec.name),
        description: String(rec.description || ""),
        parameters: (rec.parameters as JsonObject) || { type: "object", properties: {} },
      };
    })
    .filter((t): t is CursorTool => t != null);
}

export function anthropicToolsToCursor(tools: unknown): CursorTool[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      const rec = t as Record<string, unknown>;
      if (!rec?.name) return null;
      return {
        name: String(rec.name),
        description: String(rec.description || ""),
        parameters: (rec.input_schema || rec.inputSchema || { type: "object", properties: {} }) as JsonObject,
      };
    })
    .filter((t): t is CursorTool => t != null);
}

function systemAsUser(texts: string[]): CursorMessage | null {
  const text = texts.filter(Boolean).join("\n\n").trim();
  if (!text) return null;
  return { role: ROLE.user, text: `<system>\n${text}\n</system>` };
}

const AGENT_TOOL_USE_PREAMBLE = `## Tool use (agent)

You may ONLY call tools listed in the <tools-catalog> message. Do NOT invent, rename, or invoke any other tool names (including tools you have seen in other products, docs, or prior conversations). If no listed tool can do the job, say so in text—do not fabricate a tool_call.

When a listed tool applies, you MUST respond with tool_calls using the exact tool name and JSON arguments that match the schema. Do not only describe steps in prose when a tool can do the work. After tool results arrive, continue with more tool_calls or a final answer as appropriate.`;

function stableSortJson(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableSortJson);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = stableSortJson(obj[key]);
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortJson(value));
}

function sortToolsStable(tools: CursorTool[]): CursorTool[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

function foldUserTag(tag: string, inner: string): CursorMessage {
  return { role: ROLE.user, text: `<${tag}>\n${inner}\n</${tag}>` };
}

export function toolsCatalogText(tools: CursorTool[]): string {
  const sorted = sortToolsStable(tools);
  if (!sorted.length) return "";
  const lines = ["### Tools"];
  for (const t of sorted) {
    const desc = String(t.description || "").trim() || "(no description)";
    lines.push(`- ${t.name}: ${desc}`);
    const schema =
      t.parameters && Object.keys(t.parameters).length ? stableStringify(t.parameters) : "";
    if (schema && schema !== "{}") lines.push(`  schema: ${schema}`);
  }
  lines.push("", `Allowed tool names (complete list): ${sorted.map((t) => t.name).join(", ")}`);
  return lines.join("\n");
}

/** Full tools block (rules + catalog); useful for tests and debugging. */
export function toolsPromptText(tools: CursorTool[]): string {
  const catalog = toolsCatalogText(tools);
  if (!catalog) return "";
  return `${AGENT_TOOL_USE_PREAMBLE}\n\n${catalog}`;
}

/** Fold tool rules + catalog into the message stream (Cursor often ignores bare body.tools for agent behavior). */
export function injectToolsPrompt(messages: CursorMessage[], tools: CursorTool[] | undefined): CursorMessage[] {
  const sorted = sortToolsStable(tools || []);
  if (!sorted.length) return messages || [];
  const catalog = toolsCatalogText(sorted);
  const prefix: CursorMessage[] = [foldUserTag("tools-rules", AGENT_TOOL_USE_PREAMBLE)];
  if (catalog) prefix.push(foldUserTag("tools-catalog", catalog));
  return [...prefix, ...(messages || [])];
}

export function openaiMessagesToCursor(messages: unknown[]): CursorMessage[] {
  const out: CursorMessage[] = [];
  const systems: string[] = [];
  const flushSystem = () => {
    const folded = systemAsUser(systems);
    systems.length = 0;
    if (folded) out.push(folded);
  };
  for (const msg of messages || []) {
    const rec = msg as Record<string, unknown>;
    const role = String(rec.role || "").toLowerCase();
    if (role === "system" || role === "developer") {
      const text = flattenContent(rec.content);
      if (text) systems.push(text);
      continue;
    }
    flushSystem();
    if (role === "user") {
      out.push({ role: ROLE.user, text: flattenContent(rec.content) });
      continue;
    }
    if (role === "assistant") {
      const next: CursorMessage = { role: ROLE.assistant };
      const text = flattenContent(rec.content);
      if (text) next.text = text;
      const calls = (rec.tool_calls as Array<Record<string, unknown>> | undefined) || [];
      if (calls.length) {
        next.toolCalls = calls.map((c) => {
          const fn = (c.function as Record<string, unknown>) || {};
          return {
            toolCallId: c.id,
            toolName: fn.name || c.name,
            args: parseArgs(fn.arguments),
          };
        });
      }
      const thinking = flattenContent(rec.reasoning || rec.reasoning_content);
      if (thinking) {
        next.reasoningParts = [
          { isRedacted: false, text: thinking, signature: rec.reasoning_signature || rec.signature },
        ];
      }
      out.push(next);
      continue;
    }
    if (role === "tool") {
      out.push({
        role: ROLE.tool,
        toolContent: {
          parts: [
            {
              toolCallId: rec.tool_call_id || rec.toolCallId,
              toolName: rec.name || "",
              result: flattenContent(rec.content),
              isError: Boolean(rec.is_error),
            },
          ],
        },
      });
    }
  }
  flushSystem();
  return out;
}

export function anthropicToCursor(body: Record<string, unknown>): CursorMessage[] {
  const messages: CursorMessage[] = [];
  if (body.system) {
    const folded = systemAsUser([flattenContent(body.system)]);
    if (folded) messages.push(folded);
  }
  for (const msg of (body.messages as Array<Record<string, unknown>> | undefined) || []) {
    const role = String(msg.role || "").toLowerCase();
    const content = msg.content;
    if (typeof content === "string") {
      messages.push({ role: role === "assistant" ? ROLE.assistant : ROLE.user, text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (role === "assistant") {
      const next: CursorMessage = { role: ROLE.assistant };
      const texts: string[] = [];
      const calls: unknown[] = [];
      const thinking: unknown[] = [];
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "text") texts.push(String(part.text || ""));
        if (part.type === "tool_use") {
          calls.push({ toolCallId: part.id, toolName: part.name, args: part.input || {} });
        }
        if (part.type === "thinking" || part.type === "redacted_thinking") {
          thinking.push({
            isRedacted: part.type === "redacted_thinking",
            text: part.thinking || part.text || "",
            signature: part.signature,
            redactedData: part.data,
          });
        }
      }
      const text = texts.filter(Boolean).join("\n");
      if (text) next.text = text;
      if (calls.length) next.toolCalls = calls;
      if (thinking.length) next.reasoningParts = thinking;
      messages.push(next);
      continue;
    }
    const texts: string[] = [];
    const results: unknown[] = [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "text") texts.push(String(part.text || ""));
      if (part.type === "tool_result") {
        results.push({
          toolCallId: part.tool_use_id,
          toolName: part.name || "",
          result: flattenContent(part.content) || String(part.content ?? ""),
          isError: Boolean(part.is_error),
        });
      }
    }
    if (texts.filter(Boolean).length) messages.push({ role: ROLE.user, text: texts.filter(Boolean).join("\n") });
    if (results.length) messages.push({ role: ROLE.tool, toolContent: { parts: results } });
  }
  return messages;
}

export function cursorBody(opts: {
  messages: CursorMessage[];
  tools?: CursorTool[];
  injectToolsPrompt?: boolean;
  model?: unknown;
  conversationId: string;
  conversationGroupId?: string;
  maxTokens?: unknown;
  temperature?: unknown;
  reasoningEffort?: unknown;
  fast?: boolean;
}): Record<string, unknown> {
  const { routeId: modelId } = resolveCursorModelRoute(opts.model, {
    fast: opts.fast,
    reasoningEffort: opts.reasoningEffort,
  });
  const requestedModel: Record<string, unknown> = { modelId, maxMode: false, builtInModel: true };
  if (!/^cursor-grok-/i.test(modelId)) {
    const effort = mapGrokEffort(modelId, opts.reasoningEffort);
    if (effort) requestedModel.parameters = [{ id: "effort", value: effort }];
  }
  const injectTools = opts.injectToolsPrompt !== false && Boolean(opts.tools?.length);
  const messages = injectTools ? injectToolsPrompt(opts.messages, opts.tools) : opts.messages;
  const body: Record<string, unknown> = {
    messages: applyPromptCache(messages),
    conversationId: opts.conversationId,
    conversationGroupId: opts.conversationGroupId || opts.conversationId,
    modelId,
    requestedModel,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  const config: Record<string, unknown> = {};
  if (Number.isFinite(Number(opts.maxTokens))) config.maxTokens = Number(opts.maxTokens);
  if (Number.isFinite(Number(opts.temperature))) config.temperature = Number(opts.temperature);
  if (Object.keys(config).length) body.modelConfig = config;
  return body;
}

function mergeToolCallParts(frames: ConnectFrame[]): MergedToolCall[] {
  const byId = new Map<string, MergedToolCall>();
  const order: string[] = [];
  for (const frame of frames) {
    const part = frame.json?.toolCallPart as Record<string, unknown> | undefined;
    if (!part?.toolCallId) continue;
    const id = sanitizeToolCallId(part.toolCallId);
    if (!byId.has(id)) {
      byId.set(id, { id, name: "", args: "", complete: false, index: part.toolIndex as number | undefined });
      order.push(id);
    }
    const row = byId.get(id)!;
    if (part.toolName) row.name = String(part.toolName);
    if (part.args != null && part.args !== "") {
      row.args = absorbArgsChunk(row.args, part.args, { complete: Boolean(part.isComplete) });
    }
    if (part.isComplete) row.complete = true;
    if (Number.isFinite(Number(part.toolIndex))) row.index = Number(part.toolIndex);
  }
  return order
    .map((id) => {
      const row = byId.get(id)!;
      row.args = repairArgsJson(row.args);
      return row;
    })
    .filter((row) => row.name || row.complete);
}

export function collectTurn(frames: ConnectFrame[]) {
  let text = "";
  let thinking = "";
  let thinkingSignature: string | undefined;
  let usage: unknown = null;
  let extendedUsage: unknown = null;
  let providerMetadata: unknown = null;
  let error: unknown = null;
  for (const frame of frames) {
    const j = frame.json;
    if (!j) continue;
    const textPart = j.textPart as Record<string, unknown> | undefined;
    const thinkingPart = j.thinkingPart as Record<string, unknown> | undefined;
    if (textPart?.text) text += String(textPart.text);
    if (thinkingPart?.text) thinking += String(thinkingPart.text);
    if (thinkingPart?.signature) thinkingSignature = String(thinkingPart.signature);
    if (j.usage) usage = j.usage;
    if (j.extendedUsage) extendedUsage = j.extendedUsage;
    if (j.providerMetadata) providerMetadata = j.providerMetadata;
    if (j.error) error = j.error;
  }
  return {
    text,
    thinking,
    thinkingSignature,
    usage,
    extendedUsage,
    providerMetadata,
    error,
    toolCalls: mergeToolCallParts(frames),
  };
}

function pickNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
    if (v && typeof v === "object" && Number.isFinite((v as { numberValue?: number }).numberValue)) {
      return (v as { numberValue: number }).numberValue;
    }
  }
  return undefined;
}

function metadataBag(providerMetadata: unknown): Record<string, unknown> {
  if (!providerMetadata || typeof providerMetadata !== "object") return {};
  const rec = providerMetadata as Record<string, unknown>;
  if (rec.metadata && typeof rec.metadata === "object") return rec.metadata as Record<string, unknown>;
  return rec;
}

export function normalizeCursorUsage(turn: { usage?: unknown; extendedUsage?: unknown; providerMetadata?: unknown }) {
  const usage = (turn?.usage || {}) as Record<string, unknown>;
  const ext = (turn?.extendedUsage || {}) as Record<string, unknown>;
  const meta = metadataBag(turn?.providerMetadata);
  const promptTokens = pickNum(usage.promptTokens, usage.prompt_tokens, ext.inputTokens, ext.input_tokens) ?? 0;
  const completionTokens = pickNum(usage.completionTokens, usage.completion_tokens, ext.outputTokens, ext.output_tokens) ?? 0;
  const cacheReadTokens = pickNum(ext.cacheReadTokens, ext.cache_read_tokens, usage.cacheReadTokens, meta.cacheReadTokens);
  const cacheWriteTokens = pickNum(ext.cacheWriteTokens, ext.cache_write_tokens, usage.cacheWriteTokens);
  const reasoningTokens = pickNum(usage.reasoningTokens, usage.reasoning_tokens, ext.reasoningTokens, ext.reasoning_tokens);
  const reportedTotal = pickNum(usage.totalTokens, usage.total_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal ?? promptTokens + completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

export function toOpenAIUsage(u: ReturnType<typeof normalizeCursorUsage>) {
  const out: Record<string, unknown> = {
    prompt_tokens: u.promptTokens ?? 0,
    completion_tokens: u.completionTokens ?? 0,
    total_tokens: u.totalTokens ?? 0,
  };
  if (u.cacheReadTokens != null) out.prompt_tokens_details = { cached_tokens: u.cacheReadTokens };
  if (u.reasoningTokens != null) out.completion_tokens_details = { reasoning_tokens: u.reasoningTokens };
  if (u.cacheWriteTokens != null) out.cache_write_tokens = u.cacheWriteTokens;
  return out;
}

export function toolCallsToOpenAI(toolCalls: MergedToolCall[] | undefined, tools?: CursorTool[]) {
  return (toolCalls || []).map((c, i) => ({
    id: c.id,
    type: "function" as const,
    index: Number.isFinite(c.index) ? c.index : i,
    function: { name: c.name, arguments: normalizeToolArguments(c.args, schemaForTool(tools, c.name)) },
  }));
}

export function toOpenAICompletion({
  model,
  turn,
  conversationId,
  tools,
}: {
  model: unknown;
  turn: InferenceTurn;
  conversationId: string;
  tools?: CursorTool[];
}) {
  const toolCalls = toolCallsToOpenAI(turn.toolCalls, tools);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: turn.text || (toolCalls.length ? null : ""),
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (turn.thinking) message.reasoning = turn.thinking;
  if (turn.thinkingSignature) message.reasoning_signature = turn.thinkingSignature;
  return {
    id: `chatcmpl-${conversationId.slice(0, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resolveModel(model),
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: toOpenAIUsage(normalizeCursorUsage(turn)),
    conversation_id: conversationId,
    session_id: conversationId,
    error: turn.error || undefined,
  };
}

export function toAnthropicMessage({
  model,
  turn,
  conversationId,
  tools,
}: {
  model: unknown;
  turn: InferenceTurn;
  conversationId: string;
  tools?: CursorTool[];
}) {
  const content: unknown[] = [];
  if (turn.thinking) {
    content.push({ type: "thinking", thinking: turn.thinking, signature: turn.thinkingSignature });
  }
  if (turn.text) content.push({ type: "text", text: turn.text });
  for (const c of turn.toolCalls || []) {
    content.push({
      type: "tool_use",
      id: c.id,
      name: c.name,
      input: coerceJsonBySchema(parseArgs(c.args), schemaForTool(tools, c.name)),
    });
  }
  const u = toOpenAIUsage(normalizeCursorUsage(turn));
  const details = u.prompt_tokens_details as { cached_tokens?: number } | undefined;
  return {
    id: `msg_${conversationId.slice(0, 8)}`,
    type: "message",
    role: "assistant",
    model: resolveModel(model),
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: (turn.toolCalls || []).length ? "tool_use" : "end_turn",
    usage: {
      input_tokens: u.prompt_tokens,
      output_tokens: u.completion_tokens,
      cache_read_input_tokens: details?.cached_tokens ?? 0,
    },
    conversation_id: conversationId,
    session_id: conversationId,
  };
}

export function openaiSseBody({
  model,
  turn,
  conversationId,
  tools,
}: {
  model: unknown;
  turn: InferenceTurn;
  conversationId: string;
  tools?: CursorTool[];
}): string {
  const id = `chatcmpl-${conversationId.slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const resolved = resolveModel(model);
  const base = { id, object: "chat.completion.chunk", created, model: resolved };
  const chunks: unknown[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }];
  if (turn.thinking) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: turn.thinking }, finish_reason: null }] });
  }
  if (turn.text) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] });
  }
  const oaiCalls = toolCallsToOpenAI(turn.toolCalls, tools);
  if (oaiCalls.length) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: oaiCalls }, finish_reason: null }] });
  }
  const usage = toOpenAIUsage(normalizeCursorUsage(turn));
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: oaiCalls.length ? "tool_calls" : "stop" }],
    usage,
  });
  chunks.push({ ...base, choices: [], usage });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function inferenceHeaders(accessToken: string, sessionId?: string): Record<string, string> {
  return {
    ...sdkHeaders(accessToken),
    "x-session-id": sessionId || randomId(),
  };
}

export async function inferenceStream(
  accessToken: string,
  body: Record<string, unknown>,
  { sessionId }: { sessionId?: string } = {},
): Promise<InferenceTurn> {
  const res = await fetch(`${CURSOR_BASE}/aiserver.v1.InferenceService/Stream`, {
    method: "POST",
    headers: {
      ...inferenceHeaders(accessToken, sessionId),
      "content-type": "application/connect+json",
      "connect-accept-encoding": "gzip",
    },
    body: bytesBody(encodeConnectFrame(body)),
  });
  const frames = await decodeConnectFrames(new Uint8Array(await res.arrayBuffer()));
  const turn = collectTurn(frames);
  return { status: res.status, frames, ...turn };
}
