/**
 * CustomToolAgentHost backed by agent.v1.AgentService/Run (no @cursor/sdk,
 * no agent binary, no Cursor-hosted Cloud Agents sandbox VM).
 * MCP family only on the wire allowlist; upstream mcpTools catalog is empty.
 * Residual mcpArgs from upstream → mcpError (text-only run), not execute/park.
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
  parseKvBlob,
  parseServerMessage,
  readMcpResourceNotFound,
  requestContextResult,
  type AgentInlineImage,
  type AgentTurnUsage,
  type JsonObject,
} from "./agent_json.ts";
import { abortAgentDuplex, closeAgentDuplex, openAgentRun, type OpenAgentRun } from "./agent_run.ts";
import type { CustomToolAgentHandle, CustomToolAgentHost } from "./custom_tool_chat.ts";

const HEARTBEAT_MS = 15_000;
/** `AbortController.abort(reason)` used by release() — close the Run, do not cancelAction. */
const RELEASE_REASON = "release";

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

async function resolveAccessToken(
  apiKey: string,
  exchange: typeof exchangeApiKey,
): Promise<string> {
  if (isJwt(apiKey)) return apiKey;
  const exchanged = await exchange(apiKey);
  return exchanged.accessToken;
}

const TEXT_ONLY_MCP_ERROR = "text-only run: custom tools are not registered";

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
      const blobs = new Map<string, string>();
      let conversationState: JsonObject | undefined = createOpts.conversationState;
      let closed = false;

      const handle: CustomToolAgentHandle = {
        agentId,
        async send(prompt: string, sendOpts?: { images?: AgentInlineImage[]; onDelta?: (chunk: { text?: string; thinking?: string }) => void; signal?: AbortSignal; systemPrompt?: string }) {
          if (closed) throw new Error("agent is closed");
          const abort = new AbortController();
          const onClientAbort = () => abort.abort();
          const clientSignal = sendOpts?.signal;
          if (clientSignal) {
            if (clientSignal.aborted) abort.abort();
            else clientSignal.addEventListener("abort", onClientAbort, { once: true });
          }
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
            signal: abort.signal,
            systemPrompt: sendOpts?.systemPrompt,
            blobs,
            conversationState,
            onCheckpoint: (state) => {
              conversationState = state;
              createOpts.onCheckpoint?.(state);
            },
          });
          void run.finally(() => clientSignal?.removeEventListener("abort", onClientAbort));
          return {
            wait: () => run,
            abort: () => {
              if (!abort.signal.aborted) abort.abort();
            },
            release: () => {
              if (!abort.signal.aborted) abort.abort(RELEASE_REASON);
            },
          };
        },
        async close() {
          closed = true;
        },
      };
      return handle;
    },
  };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "AbortError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /aborted|AbortError/i.test(message);
}

function isReleaseAbort(signal?: AbortSignal): boolean {
  return signal?.reason === RELEASE_REASON;
}

function stopDuplex(duplex: NonNullable<Awaited<ReturnType<OpenAgentRun>>>, signal?: AbortSignal): Promise<void> {
  if (isReleaseAbort(signal)) {
    closeAgentDuplex(duplex);
    return Promise.resolve();
  }
  return abortAgentDuplex(duplex);
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
  signal?: AbortSignal;
  systemPrompt?: string;
  blobs: Map<string, string>;
  conversationState?: JsonObject;
  onCheckpoint: (state: JsonObject) => void;
}): Promise<{ text: string; thinking?: string; error?: string; usage?: AgentTurnUsage }> {
  let duplex: Awaited<ReturnType<OpenAgentRun>> | undefined;
  let cancelled = false;
  let aborting: Promise<void> | undefined;
  const stopOnce = () => {
    if (cancelled) return;
    cancelled = true;
    if (!duplex) return;
    aborting = stopDuplex(duplex, opts.signal);
  };
  opts.signal?.addEventListener("abort", stopOnce, { once: true });
  if (opts.signal?.aborted) stopOnce();

  let text = "";
  let thinking = "";
  let error: string | undefined;
  let usage: AgentTurnUsage | undefined;
  const inflight = new Set<Promise<void>>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const track = (work: Promise<void>) => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  };

  try {
    duplex = await opts.openRun({
      accessToken: opts.accessToken,
      conversationId: opts.conversationId,
      signal: opts.signal,
    });
    if (cancelled) {
      await stopDuplex(duplex, opts.signal);
      return { text: "", thinking: undefined, error: undefined };
    }

    const runId = randomId();
    heartbeat = setInterval(() => {
      void duplex!.send(clientHeartbeatMessage()).catch(() => {
        /* stream may already be closed */
      });
    }, HEARTBEAT_MS);

    await duplex.send(
      clientRunMessage(
        buildRunRequest({
          prompt: opts.prompt,
          modelId: opts.modelId,
          modelParameters: opts.modelParameters,
          conversationId: opts.conversationId,
          runId,
          agentSessionId: opts.agentSessionId,
          tools: [],
          conversationState: opts.conversationState,
          cwd: opts.cwd,
          images: opts.images,
          systemPrompt: opts.systemPrompt,
        }),
      ),
    );

    while (true) {
      if (cancelled) break;
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
        if (!cancelled) error = "AgentService aborted the run";
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
          await duplex.send(requestContextResult(id, execId, { cwd: opts.cwd, tools: [] }));
          continue;
        }
        if (kind === "mcpStateExecArgs" || kind === "mcp_state_exec_args") {
          await duplex.send(mcpStateResult(id, execId, []));
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
          track(
            (async () => {
              if (cancelled) return;
              await duplex!.send(mcpErrorResult(id, execId, TEXT_ONLY_MCP_ERROR));
            })(),
          );
          continue;
        }
        await duplex.send(execThrow(id, `unsupported exec ${kind}`));
      }
    }

    if (inflight.size) await Promise.allSettled([...inflight]);
  } catch (err) {
    if (!cancelled && !isAbortError(err)) {
      error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    opts.signal?.removeEventListener("abort", stopOnce);
    if (heartbeat) clearInterval(heartbeat);
    if (aborting) await aborting;
    else duplex?.close();
  }
  return { text, thinking: thinking || undefined, error, usage };
}

/** Default host used by the chat path. */
export function defaultSdkAgentHost(): CustomToolAgentHost {
  return createSdkAgentHost();
}

export type { CustomToolSpec } from "./agent_json.ts";
