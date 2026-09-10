/**
 * Connect JSON shapes for agent.v1.AgentService/Run (camelCase proto3 JSON).
 * In-repo stand-in for the @cursor/sdk local Agent + custom-user-tools MCP executor.
 */

import { mapGrokEffort, parseAgentGrokModel } from "./inference.ts";

export const CUSTOM_USER_TOOLS_SERVER = "custom-user-tools";

/** Proto tool names for SDK public group `"mcp"`. */
export const MCP_ALLOWED_PROTO_TOOLS = [
  "mcp_tool_call",
  "get_mcp_tools_tool_call",
  "list_mcp_resources_tool_call",
  "read_mcp_resource_tool_call",
  "mcp_auth_tool_call",
] as const;

export const ALLOWED_TOOLS_HEADER_NAME = "x-cursor-agent-allowed-tools";

export type JsonObject = Record<string, unknown>;

export type CustomToolSpec = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export function asObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

export function field(obj: JsonObject | undefined, ...names: string[]): unknown {
  if (!obj) return undefined;
  for (const name of names) {
    if (obj[name] !== undefined) return obj[name];
  }
  return undefined;
}

export type AgentModelParam = { id: string; value: string };

/** Inline image on AgentService UserMessage.selectedContext (Connect JSON bytes = base64). */
export type AgentInlineImage = {
  uuid: string;
  path: string;
  mimeType: string;
  data: string;
};

export type AgentModelSelection = {
  modelId: string;
  parameters?: AgentModelParam[];
};

/**
 * AgentService family ids omit `-fast` and Grok effort suffixes. SDK/AgentService
 * default omitted `fast` to true, so Composer and Grok always get an explicit
 * true/false. Grok also always gets `effort` (default `high`, same as Inference).
 * Fast is on only for a `-fast` suffix or `fast: true`; tools do not upgrade Grok.
 */
export function gatewayAgentModelSelection(
  model: unknown,
  opts?: { fast?: boolean; reasoningEffort?: unknown },
): AgentModelSelection {
  const raw = typeof model === "string" && model.trim() && model !== "auto" ? model.trim() : "composer-2.5";
  const grok = parseAgentGrokModel(raw);
  if (grok) {
    const familyKey = grok.family === "4.6" ? "grok-4.6" : "grok-4.5";
    const hasBodyEffort = opts?.reasoningEffort != null && String(opts.reasoningEffort).trim() !== "";
    const effort =
      (hasBodyEffort ? mapGrokEffort(familyKey, opts?.reasoningEffort) : undefined) ?? grok.effort ?? "high";
    const fast = grok.fast || Boolean(opts?.fast);
    return {
      modelId: familyKey,
      parameters: [
        { id: "fast", value: fast ? "true" : "false" },
        { id: "effort", value: effort },
      ],
    };
  }

  const suffixFast = /-fast$/i.test(raw);
  const modelId = raw.replace(/-fast$/i, "");
  const composer = /^composer-/i.test(modelId);
  const fast = suffixFast || Boolean(opts?.fast);
  if (composer || suffixFast || opts?.fast) {
    return { modelId, parameters: [{ id: "fast", value: fast ? "true" : "false" }] };
  }
  return { modelId };
}

export function gatewayAgentModelId(model: unknown): string {
  return gatewayAgentModelSelection(model).modelId;
}

export function mcpToolDefinitions(tools: CustomToolSpec[]): JsonObject[] {
  return tools.map((tool) => ({
    name: `${CUSTOM_USER_TOOLS_SERVER}-${tool.name}`,
    providerIdentifier: CUSTOM_USER_TOOLS_SERVER,
    toolName: tool.name,
    description: tool.description || tool.name,
    inputSchemaJson: JSON.stringify(tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} }),
  }));
}

export function buildRunRequest(opts: {
  prompt: string;
  modelId: string;
  modelParameters?: AgentModelParam[];
  conversationId: string;
  conversationGroupId?: string;
  runId: string;
  agentSessionId: string;
  tools: CustomToolSpec[];
  conversationState?: JsonObject;
  cwd?: string;
  images?: AgentInlineImage[];
  /** Tool-result follow-up: history is already in conversationState roots. */
  resume?: boolean;
}): JsonObject {
  const messageId = crypto.randomUUID();
  const mcpTools = mcpToolDefinitions(opts.tools);
  const selection = gatewayAgentModelSelection(opts.modelId);
  const parameters = opts.modelParameters ?? selection.parameters;
  const requestedModel: JsonObject = {
    modelId: selection.modelId,
    builtInModel: true,
  };
  if (parameters?.length) requestedModel.parameters = parameters;
  const images = opts.images?.filter((img) => img.data) ?? [];
  const userMessage: JsonObject = {
    text: opts.prompt,
    messageId,
  };
  if (images.length) {
    userMessage.selectedContext = {
      selectedImages: images.map((img) => ({
        uuid: img.uuid,
        path: img.path,
        mimeType: img.mimeType,
        data: img.data,
      })),
    };
  }
  const req: JsonObject = {
    action: opts.resume
      ? { resumeAction: {} }
      : { userMessageAction: { userMessage } },
    requestedModel,
    mcpTools: { mcpTools },
    conversationId: opts.conversationId,
    conversationGroupId: opts.conversationGroupId || opts.conversationId,
    // Do not set excludeWorkspaceContext or customSystemPrompt: Dashboard
    // crsr_ rejects both (`Workspace context exclusion is not allowed…` /
    // `unknown option '--system-prompt'`). Client system lives in spliced
    // rootPromptMessagesJson. Builtins stay off via MCP-only allowlist.
    runId: opts.runId,
    agentSessionId: opts.agentSessionId,
    mcpFileSystemOptions: {
      enabled: false,
      workspaceProjectDir: opts.cwd || "/tmp",
    },
  };
  if (opts.conversationState && Object.keys(opts.conversationState).length > 0) {
    req.conversationState = opts.conversationState;
  }
  // Cursor only honours SelectedImage.data when this is true.
  if (images.length) req.clientSupportsInlineImages = true;
  return req;
}

export function clientRunMessage(runRequest: JsonObject): JsonObject {
  return { runRequest };
}

export function clientHeartbeatMessage(): JsonObject {
  return { clientHeartbeat: {} };
}

/** Official in-band stop: `ConversationAction.cancel_action` on the live Run stream. */
export function clientCancelMessage(): JsonObject {
  return { conversationAction: { cancelAction: {} } };
}

function execReply(id: unknown, execId: unknown, body: JsonObject): JsonObject {
  const msg: JsonObject = { ...body };
  if (id !== undefined) msg.id = id;
  if (execId !== undefined && execId !== "") msg.execId = execId;
  return { execClientMessage: msg };
}

export function execIds(exec: JsonObject): { id: unknown; execId: unknown } {
  return {
    id: field(exec, "id"),
    execId: field(exec, "execId", "exec_id"),
  };
}

export function mcpStateResult(id: unknown, execId: unknown, tools: CustomToolSpec[]): JsonObject {
  const defs = mcpToolDefinitions(tools);
  return execReply(id, execId, {
    mcpStateExecResult: {
      success: {
        servers: [
          {
            serverName: CUSTOM_USER_TOOLS_SERVER,
            serverIdentifier: CUSTOM_USER_TOOLS_SERVER,
            status: "ready",
            tools: defs,
            instructions: [
              {
                serverName: CUSTOM_USER_TOOLS_SERVER,
                serverIdentifier: CUSTOM_USER_TOOLS_SERVER,
                instructions: "In-process OpenAI/Anthropic function tools offered through GetMcpTools / CallMcpTool.",
              },
            ],
          },
        ],
      },
    },
  });
}

export function requestContextResult(id: unknown, execId: unknown, opts: { cwd: string; tools: CustomToolSpec[] }): JsonObject {
  const defs = mcpToolDefinitions(opts.tools);
  const cwd = opts.cwd || "/tmp";
  return execReply(id, execId, {
    requestContextResult: {
      success: {
        requestContext: {
          env: {
            osVersion: "darwin",
            workspacePaths: [cwd],
            shell: "/bin/zsh",
            sandboxEnabled: false,
            timeZone: "UTC",
            projectFolder: cwd,
            processWorkingDirectory: cwd,
            envInfoComplete: true,
          },
          tools: defs,
          mcpInstructions: [
            {
              serverName: CUSTOM_USER_TOOLS_SERVER,
              serverIdentifier: CUSTOM_USER_TOOLS_SERVER,
              instructions: "Call listed custom tools via MCP.",
            },
          ],
          webSearchEnabled: false,
          webFetchEnabled: false,
          supportsMcpAuth: false,
          gitRepoInfoComplete: true,
          mcpInfoComplete: true,
          rulesInfoComplete: true,
          envInfoComplete: true,
          repositoryInfoComplete: true,
          customSubagentsInfoComplete: true,
          agentSkillsInfoComplete: true,
          mcpFileSystemInfoComplete: true,
          gitStatusInfoComplete: true,
          readLintsEnabled: false,
        },
      },
    },
  });
}

export function listMcpResourcesResult(id: unknown, execId: unknown): JsonObject {
  return execReply(id, execId, {
    listMcpResourcesExecResult: { success: { resources: [] } },
  });
}

export function readMcpResourceNotFound(id: unknown, execId: unknown): JsonObject {
  return execReply(id, execId, {
    readMcpResourceExecResult: { notFound: {} },
  });
}

export function mcpAllowlistResult(id: unknown, execId: unknown, allowlisted = true): JsonObject {
  return execReply(id, execId, {
    mcpAllowlistPrecheckResult: { allowlisted },
  });
}

export function mcpSuccessResult(
  id: unknown,
  execId: unknown,
  text: string,
  isError = false,
): JsonObject {
  return execReply(id, execId, {
    mcpResult: {
      success: {
        content: [{ text: { text } }],
        isError,
      },
    },
  });
}

export function mcpErrorResult(id: unknown, execId: unknown, error: string): JsonObject {
  return execReply(id, execId, {
    mcpResult: { error: { error } },
  });
}

export function execThrow(id: unknown, error: string): JsonObject {
  return {
    execClientControlMessage: {
      throw: { id, error },
    },
  };
}

export function kvGetBlobResult(id: unknown, blobData?: string, error?: string): JsonObject {
  const getBlobResult: JsonObject = {};
  if (blobData !== undefined) getBlobResult.blobData = blobData;
  if (error) getBlobResult.error = { message: error };
  return { kvClientMessage: { id, getBlobResult } };
}

export function kvSetBlobResult(id: unknown, error?: string): JsonObject {
  const setBlobResult: JsonObject = {};
  if (error) setBlobResult.error = { message: error };
  return { kvClientMessage: { id, setBlobResult } };
}

function protoValueToJson(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(protoValueToJson);
  const obj = value as JsonObject;
  if ("stringValue" in obj || "string_value" in obj) return field(obj, "stringValue", "string_value");
  if ("numberValue" in obj || "number_value" in obj) return field(obj, "numberValue", "number_value");
  if ("boolValue" in obj || "bool_value" in obj) return field(obj, "boolValue", "bool_value");
  if ("nullValue" in obj || "null_value" in obj) return null;
  const struct = asObject(field(obj, "structValue", "struct_value"));
  if (struct) {
    const fields = asObject(field(struct, "fields") ?? struct);
    if (!fields) return {};
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(fields)) out[key] = protoValueToJson(entry);
    return out;
  }
  const list = asObject(field(obj, "listValue", "list_value"));
  if (list) {
    const values = field(list, "values");
    return Array.isArray(values) ? values.map(protoValueToJson) : [];
  }
  if ("kind" in obj && asObject(obj.kind)) return protoValueToJson(obj.kind);
  return value;
}

export function mcpArgsToRecord(args: unknown): Record<string, unknown> {
  const obj = asObject(args);
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = protoValueToJson(value);
  }
  return out;
}

export type ParsedMcpCall = {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId?: string;
  providerIdentifier: string;
};

export function parseMcpArgs(exec: JsonObject): ParsedMcpCall | undefined {
  const raw = asObject(field(exec, "mcpArgs", "mcp_args"));
  if (!raw) return undefined;
  const providerIdentifier = String(field(raw, "providerIdentifier", "provider_identifier") || "");
  const wireName = String(field(raw, "name") || "");
  const prefix = `${CUSTOM_USER_TOOLS_SERVER}-`;
  const toolName =
    String(field(raw, "toolName", "tool_name") || "") ||
    (wireName.startsWith(prefix) ? wireName.slice(prefix.length) : wireName);
  const toolCallId = String(field(raw, "toolCallId", "tool_call_id") || "") || undefined;
  return {
    toolName,
    args: mcpArgsToRecord(field(raw, "args")),
    toolCallId,
    providerIdentifier: providerIdentifier || CUSTOM_USER_TOOLS_SERVER,
  };
}

export type AgentTurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

function pickToken(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const rec = v as JsonObject;
      const wrapped = rec.numberValue ?? rec.number_value ?? rec.intValue ?? rec.int_value;
      if (typeof wrapped === "number" && Number.isFinite(wrapped) && wrapped >= 0) return wrapped;
      if (typeof wrapped === "string" && wrapped.trim() !== "" && Number.isFinite(Number(wrapped)) && Number(wrapped) >= 0) {
        return Number(wrapped);
      }
    }
  }
  return undefined;
}

/** AgentService TurnEnded / nested usage. Proto JSON uint64 is often a string. */
export function parseAgentTurnUsage(raw: unknown): AgentTurnUsage | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;
  const nested = asObject(field(obj, "usage")) ?? obj;
  const inputTokens = pickToken(
    nested.inputTokens,
    nested.input_tokens,
    nested.promptTokens,
    nested.prompt_tokens,
  );
  const outputTokens = pickToken(
    nested.outputTokens,
    nested.output_tokens,
    nested.completionTokens,
    nested.completion_tokens,
  );
  const cacheReadTokens = pickToken(nested.cacheReadTokens, nested.cache_read_tokens);
  const cacheWriteTokens = pickToken(nested.cacheWriteTokens, nested.cache_write_tokens);
  const reasoningTokens = pickToken(nested.reasoningTokens, nested.reasoning_tokens);
  if (
    inputTokens == null &&
    outputTokens == null &&
    cacheReadTokens == null &&
    cacheWriteTokens == null &&
    reasoningTokens == null
  ) {
    return undefined;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

function addOptionalToken(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export function addAgentTurnUsage(a?: AgentTurnUsage, b?: AgentTurnUsage): AgentTurnUsage | undefined {
  if (!b) return a;
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: addOptionalToken(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: addOptionalToken(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: addOptionalToken(a.reasoningTokens, b.reasoningTokens),
  };
}

/** AgentService may emit cumulative usage snapshots or per-segment deltas. */
export function mergeAgentTurnUsage(prev?: AgentTurnUsage, next?: AgentTurnUsage): AgentTurnUsage | undefined {
  if (!next) return prev;
  if (!prev) return next;
  const prevCr = prev.cacheReadTokens ?? 0;
  const nextCr = next.cacheReadTokens ?? 0;
  const cumulative =
    next.inputTokens >= prev.inputTokens &&
    next.outputTokens >= prev.outputTokens &&
    nextCr >= prevCr &&
    (next.cacheWriteTokens ?? 0) >= (prev.cacheWriteTokens ?? 0);
  if (cumulative) return next;
  return addAgentTurnUsage(prev, next);
}

/** Team Usage aligned: CR / (CR + input w/o cache write). inputTokens is total prompt from AgentService. */
export function promptCacheHitPercent(usage?: AgentTurnUsage): number | undefined {
  if (!usage) return undefined;
  const cr = usage.cacheReadTokens ?? 0;
  const cw = usage.cacheWriteTokens ?? 0;
  const totalIn = usage.inputTokens;
  if (totalIn <= 0 && cr <= 0) return undefined;
  const inwo = Math.max(0, totalIn - cr - cw);
  const den = cr + inwo;
  if (den <= 0) return cr > 0 ? 100 : 0;
  return Math.min(100, Math.round((cr / den) * 10000) / 100);
}

/** Sum multiple billing rows (e.g. one agent round with several HTTP completions) without inflating hit rate. */
export function aggregatePromptCacheHitPercent(usages: AgentTurnUsage[]): number | undefined {
  if (!usages.length) return undefined;
  let crSum = 0;
  let inwoSum = 0;
  for (const u of usages) {
    const cr = u.cacheReadTokens ?? 0;
    const cw = u.cacheWriteTokens ?? 0;
    crSum += cr;
    inwoSum += Math.max(0, u.inputTokens - cr - cw);
  }
  const den = crSum + inwoSum;
  if (den <= 0) return undefined;
  return Math.min(100, Math.round((crSum / den) * 10000) / 100);
}

export type ServerCase =
  | { kind: "textDelta"; text: string }
  | { kind: "thinkingDelta"; text: string }
  | { kind: "turnEnded"; usage?: AgentTurnUsage }
  | { kind: "usage"; usage: AgentTurnUsage }
  | { kind: "heartbeat" }
  | { kind: "checkpoint"; state: JsonObject }
  | { kind: "exec"; exec: JsonObject; execKind: string }
  | { kind: "kv"; kv: JsonObject }
  | { kind: "query"; query: JsonObject }
  | { kind: "abort" }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

function firstPresent(obj: JsonObject, names: string[]): string | undefined {
  for (const name of names) {
    if (obj[name] !== undefined) return name;
  }
  return undefined;
}

const EXEC_KIND_NAMES = [
  "mcpArgs",
  "mcp_args",
  "mcpStateExecArgs",
  "mcp_state_exec_args",
  "requestContextArgs",
  "request_context_args",
  "listMcpResourcesExecArgs",
  "list_mcp_resources_exec_args",
  "readMcpResourceExecArgs",
  "read_mcp_resource_exec_args",
  "mcpAllowlistPrecheckArgs",
  "mcp_allowlist_precheck_args",
] as const;

export function parseServerMessage(raw: unknown): ServerCase {
  const obj = asObject(raw);
  if (!obj) return { kind: "ignore" };

  const err = asObject(field(obj, "error"));
  const code = field(obj, "code");
  const message = field(obj, "message");
  if (typeof code === "string" && typeof message === "string") {
    return { kind: "error", message: `${code}: ${message}` };
  }
  if (err && typeof err.message === "string") {
    return { kind: "error", message: String(err.message) };
  }

  const wrapped = asObject(field(obj, "message")) ?? obj;

  const update = asObject(field(wrapped, "interactionUpdate", "interaction_update"));
  if (update) {
    const inner = asObject(field(update, "message")) ?? update;
    const textDelta = asObject(field(inner, "textDelta", "text_delta"));
    if (textDelta) return { kind: "textDelta", text: String(field(textDelta, "text") || "") };
    const thinkingDelta = asObject(field(inner, "thinkingDelta", "thinking_delta"));
    if (thinkingDelta) return { kind: "thinkingDelta", text: String(field(thinkingDelta, "text") || "") };
    const type = String(field(inner, "type") || "");
    if (type === "text-delta" || type === "text_delta") {
      return { kind: "textDelta", text: String(field(inner, "text") || "") };
    }
    if (type === "thinking-delta" || type === "thinking_delta") {
      return { kind: "thinkingDelta", text: String(field(inner, "text") || "") };
    }
    const ended = field(inner, "turnEnded", "turn_ended");
    if (ended !== undefined) {
      return { kind: "turnEnded", usage: parseAgentTurnUsage(ended) ?? parseAgentTurnUsage(inner) };
    }
    if (field(inner, "heartbeat") !== undefined) return { kind: "heartbeat" };
    const usageOnly = parseAgentTurnUsage(field(inner, "usage", "tokenUsage", "token_usage"));
    if (usageOnly) return { kind: "usage", usage: usageOnly };
    return { kind: "ignore" };
  }

  const exec = asObject(field(wrapped, "execServerMessage", "exec_server_message"));
  if (exec) {
    const inner = asObject(field(exec, "message")) ?? exec;
    const execKind = firstPresent(inner, [...EXEC_KIND_NAMES]) || "unknown";
    return { kind: "exec", exec: inner, execKind };
  }

  const control = asObject(field(wrapped, "execServerControlMessage", "exec_server_control_message"));
  if (control) {
    const inner = asObject(field(control, "message")) ?? control;
    if (field(inner, "abort") !== undefined) return { kind: "abort" };
    return { kind: "ignore" };
  }

  const checkpoint = asObject(field(wrapped, "conversationCheckpointUpdate", "conversation_checkpoint_update"));
  if (checkpoint) {
    const inner = asObject(field(checkpoint, "conversationState", "conversation_state"));
    return { kind: "checkpoint", state: inner ?? checkpoint };
  }

  const kv = asObject(field(wrapped, "kvServerMessage", "kv_server_message"));
  if (kv) return { kind: "kv", kv: asObject(field(kv, "message")) ?? kv };

  const query = asObject(field(wrapped, "interactionQuery", "interaction_query"));
  if (query) return { kind: "query", query };

  return { kind: "ignore" };
}

export function parseKvBlob(kv: JsonObject): { op: "get" | "set" | "other"; id: unknown; blobId?: string; blobData?: string } {
  const id = field(kv, "id");
  const getArgs = asObject(field(kv, "getBlobArgs", "get_blob_args"));
  if (getArgs) {
    return { op: "get", id, blobId: String(field(getArgs, "blobId", "blob_id") || "") };
  }
  const setArgs = asObject(field(kv, "setBlobArgs", "set_blob_args"));
  if (setArgs) {
    return {
      op: "set",
      id,
      blobId: String(field(setArgs, "blobId", "blob_id") || ""),
      blobData: field(setArgs, "blobData", "blob_data") == null ? undefined : String(field(setArgs, "blobData", "blob_data")),
    };
  }
  return { op: "other", id };
}

export function connectErrorMessage(json: JsonObject | null | undefined, httpStatus?: number): string | undefined {
  if (!json) {
    return httpStatus && httpStatus >= 400 ? `AgentService HTTP ${httpStatus}` : undefined;
  }
  const err = asObject(field(json, "error")) ?? json;
  const code = field(err, "code");
  const message = field(err, "message");
  if (typeof message === "string" && message.trim()) {
    return typeof code === "string" ? `${code}: ${message}` : message;
  }
  if (typeof code === "string") return code;
  return httpStatus && httpStatus >= 400 ? `AgentService HTTP ${httpStatus}` : undefined;
}
