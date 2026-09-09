/**
 * CustomToolAgentHost backed by agent.v1.AgentService/Run (no @cursor/sdk,
 * no agent binary, no Cursor-hosted Cloud Agents sandbox VM).
 * MCP family only; customTools.execute stays in-process (parked by custom_tools.ts).
 */
import { exchangeApiKey } from "./auth.ts";
import { randomId } from "./bytes.ts";
import {
  mergeAgentTurnUsage,
  buildRunRequest,
  clientHeartbeatMessage,
  clientRunMessage,
  execIds,
  execThrow,
  gatewayAgentModelSelection,
  type AgentModelParam,
  kvGetBlobResult,
  kvSetBlobResult,
  listMcpResourcesResult,
  mcpAllowlistResult,
  mcpErrorResult,
  mcpStateResult,
  mcpSuccessResult,
  parseKvBlob,
  parseMcpArgs,
  parseServerMessage,
  readMcpResourceNotFound,
  requestContextResult,
  type AgentInlineImage,
  type AgentTurnUsage,
  type CustomToolSpec,
  type JsonObject,
} from "./agent_json.ts";
import { openAgentRun, type OpenAgentRun } from "./agent_run.ts";
import type { CustomToolAgentHandle, CustomToolAgentHost, SdkCustomToolMap } from "./custom_tool_chat.ts";

const HEARTBEAT_MS = 15_000;

function isJwt(token: string): boolean {
  return token.startsWith("eyJ") && token.split(".").length === 3;
}

function readEnv(name: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env?.[name]) return process.env[name];
  } catch {
    /* empty */
  }
  try {
    const deno = (globalThis as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno;
    return deno?.env.get(name);
  } catch {
    /* empty */
  }
  return undefined;
}

function specsFromCustomTools(customTools: SdkCustomToolMap): CustomToolSpec[] {
  return Object.entries(customTools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

async function resolveAccessToken(
  apiKey: string,
  exchange: typeof exchangeApiKey,
): Promise<string> {
  if (isJwt(apiKey)) return apiKey;
  const exchanged = await exchange(apiKey);
  return exchanged.accessToken;
}

function contentToText(result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }): string {
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  if (text) return text;
  return result.isError ? "custom tool failed" : "";
}

export function createSdkAgentHost(opts?: {
  openRun?: OpenAgentRun;
  exchange?: typeof exchangeApiKey;
}): CustomToolAgentHost {
  const openRun = opts?.openRun ?? openAgentRun;
  const exchange = opts?.exchange ?? exchangeApiKey;

  return {
    async create(createOpts) {
      const accessToken = await resolveAccessToken(createOpts.apiKey, exchange);
      const agentId = createOpts.agentSessionId || randomId();
      const conversationId = createOpts.conversationId || randomId();
      const selection = gatewayAgentModelSelection(createOpts.model, {
        fast: createOpts.fast,
        reasoningEffort: createOpts.reasoningEffort,
      });
      const cwd = createOpts.cwd || readEnv("GATEWAY_AGENT_CWD") || "/tmp";
      const tools = specsFromCustomTools(createOpts.customTools);
      const blobs = new Map<string, string>();
      let conversationState: JsonObject | undefined = createOpts.conversationState;
      let closed = false;

      const handle: CustomToolAgentHandle = {
        agentId,
        async send(prompt: string, sendOpts?: { images?: AgentInlineImage[]; onDelta?: (chunk: { text?: string; thinking?: string }) => void }) {
          if (closed) throw new Error("agent is closed");
          const run = runTurn({
            openRun,
            accessToken,
            conversationId,
            agentSessionId: agentId,
            modelId: selection.modelId,
            modelParameters: selection.parameters,
            cwd,
            prompt,
            images: sendOpts?.images,
            onDelta: sendOpts?.onDelta,
            tools,
            customTools: createOpts.customTools,
            blobs,
            conversationState,
            onCheckpoint: (state) => {
              conversationState = state;
              createOpts.onCheckpoint?.(state);
            },
          });
          return { wait: () => run };
        },
        async close() {
          closed = true;
        },
      };
      return handle;
    },
  };
}

async function runTurn(opts: {
  openRun: OpenAgentRun;
  accessToken: string;
  conversationId: string;
  agentSessionId: string;
  modelId: string;
  modelParameters?: AgentModelParam[];
  cwd: string;
  prompt: string;
  images?: AgentInlineImage[];
  onDelta?: (chunk: { text?: string; thinking?: string }) => void;
  tools: CustomToolSpec[];
  customTools: SdkCustomToolMap;
  blobs: Map<string, string>;
  conversationState?: JsonObject;
  onCheckpoint: (state: JsonObject) => void;
}): Promise<{ text: string; thinking?: string; error?: string; usage?: AgentTurnUsage }> {
  const duplex = await opts.openRun({
    accessToken: opts.accessToken,
    conversationId: opts.conversationId,
  });
  const runId = randomId();
  let text = "";
  let thinking = "";
  let error: string | undefined;
  let usage: AgentTurnUsage | undefined;
  const inflight = new Set<Promise<void>>();

  const heartbeat = setInterval(() => {
    void duplex.send(clientHeartbeatMessage()).catch(() => {
      /* stream may already be closed */
    });
  }, HEARTBEAT_MS);

  const track = (work: Promise<void>) => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  };

  try {
    await duplex.send(
      clientRunMessage(
        buildRunRequest({
          prompt: opts.prompt,
          modelId: opts.modelId,
          modelParameters: opts.modelParameters,
          conversationId: opts.conversationId,
          runId,
          agentSessionId: opts.agentSessionId,
          tools: opts.tools,
          conversationState: opts.conversationState,
          cwd: opts.cwd,
          images: opts.images,
        }),
      ),
    );

    while (true) {
      const raw = await duplex.next();
      if (!raw) break;
      const parsed = parseServerMessage(raw);
      if (parsed.kind === "error") {
        error = parsed.message;
        break;
      }
      if (parsed.kind === "textDelta") {
        text += parsed.text;
        if (parsed.text) opts.onDelta?.({ text: parsed.text });
        continue;
      }
      if (parsed.kind === "thinkingDelta") {
        thinking += parsed.text;
        if (parsed.text) opts.onDelta?.({ thinking: parsed.text });
        continue;
      }
      if (parsed.kind === "checkpoint") {
        opts.onCheckpoint(parsed.state);
        continue;
      }
      if (parsed.kind === "usage") {
        usage = mergeAgentTurnUsage(usage, parsed.usage);
        continue;
      }
      if (parsed.kind === "turnEnded") {
        usage = mergeAgentTurnUsage(usage, parsed.usage);
        break;
      }
      if (parsed.kind === "abort") {
        error = "AgentService aborted the run";
        break;
      }
      if (parsed.kind === "heartbeat" || parsed.kind === "ignore" || parsed.kind === "query") {
        continue;
      }
      if (parsed.kind === "kv") {
        const kv = parseKvBlob(parsed.kv);
        if (kv.op === "get") {
          const data = kv.blobId ? opts.blobs.get(kv.blobId) : undefined;
          await duplex.send(kvGetBlobResult(kv.id, data, data === undefined ? "not found" : undefined));
        } else if (kv.op === "set") {
          if (kv.blobId && kv.blobData !== undefined) opts.blobs.set(kv.blobId, kv.blobData);
          await duplex.send(kvSetBlobResult(kv.id));
        }
        continue;
      }
      if (parsed.kind === "exec") {
        const { id, execId } = execIds(parsed.exec);
        const kind = parsed.execKind;
        if (kind === "requestContextArgs" || kind === "request_context_args") {
          await duplex.send(requestContextResult(id, execId, { cwd: opts.cwd, tools: opts.tools }));
          continue;
        }
        if (kind === "mcpStateExecArgs" || kind === "mcp_state_exec_args") {
          await duplex.send(mcpStateResult(id, execId, opts.tools));
          continue;
        }
        if (kind === "listMcpResourcesExecArgs" || kind === "list_mcp_resources_exec_args") {
          await duplex.send(listMcpResourcesResult(id, execId));
          continue;
        }
        if (kind === "readMcpResourceExecArgs" || kind === "read_mcp_resource_exec_args") {
          await duplex.send(readMcpResourceNotFound(id, execId));
          continue;
        }
        if (kind === "mcpAllowlistPrecheckArgs" || kind === "mcp_allowlist_precheck_args") {
          await duplex.send(mcpAllowlistResult(id, execId, true));
          continue;
        }
        if (kind === "mcpArgs" || kind === "mcp_args") {
          const call = parseMcpArgs(parsed.exec);
          track(
            (async () => {
              if (!call?.toolName) {
                await duplex.send(mcpErrorResult(id, execId, "missing MCP tool name"));
                return;
              }
              const tool = opts.customTools[call.toolName];
              if (!tool) {
                await duplex.send(mcpErrorResult(id, execId, `Unknown custom tool: ${call.toolName}`));
                return;
              }
              try {
                const result = await tool.execute(call.args || {}, { toolCallId: call.toolCallId });
                await duplex.send(
                  mcpSuccessResult(id, execId, contentToText(result), Boolean(result.isError)),
                );
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await duplex.send(mcpErrorResult(id, execId, message));
              }
            })(),
          );
          continue;
        }
        await duplex.send(execThrow(id, `unsupported exec ${kind}`));
      }
    }

    if (inflight.size) await Promise.allSettled([...inflight]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(heartbeat);
    duplex.close();
  }
  return { text, thinking: thinking || undefined, error, usage };
}

/** Default host used by the chat path. */
export function defaultSdkAgentHost(): CustomToolAgentHost {
  return createSdkAgentHost();
}

export type { CustomToolSpec };
