/**
 * Connect JSON shapes for agent.v1.AgentService/Run (camelCase proto3 JSON).
 * In-repo stand-in for the @cursor/sdk local Agent + custom-user-tools MCP executor.
 */

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

export function gatewayAgentModelId(model: unknown): string {
  const raw = typeof model === "string" && model.trim() && model !== "auto" ? model.trim() : "composer-2.5";
  return raw.replace(/-fast$/i, "");
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
  conversationId: string;
  conversationGroupId?: string;
  runId: string;
  agentSessionId: string;
  tools: CustomToolSpec[];
  conversationState?: JsonObject;
  cwd?: string;
}): JsonObject {
  const messageId = crypto.randomUUID();
  const mcpTools = mcpToolDefinitions(opts.tools);
  return {
    conversationState: opts.conversationState ?? {},
    action: {
      userMessageAction: {
        userMessage: {
          text: opts.prompt,
          messageId,
        },
      },
    },
    requestedModel: {
      modelId: opts.modelId,
      builtInModel: true,
    },
    mcpTools: { mcpTools },
    conversationId: opts.conversationId,
    conversationGroupId: opts.conversationGroupId || opts.conversationId,
    excludeWorkspaceContext: true,
    runId: opts.runId,
    agentSessionId: opts.agentSessionId,
    mcpFileSystemOptions: {
      enabled: false,
      workspaceProjectDir: opts.cwd || "",
    },
  };
}

export function clientRunMessage(runRequest: JsonObject): JsonObject {
  return { runRequest };
}

export function clientHeartbeatMessage(): JsonObject {
  return { clientHeartbeat: {} };
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

export type ServerCase =
  | { kind: "textDelta"; text: string }
  | { kind: "turnEnded" }
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
    if (field(inner, "turnEnded", "turn_ended") !== undefined) return { kind: "turnEnded" };
    if (field(inner, "heartbeat") !== undefined) return { kind: "heartbeat" };
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
  if (checkpoint) return { kind: "checkpoint", state: checkpoint };

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
