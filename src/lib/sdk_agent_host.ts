/**
 * CustomToolAgentHost backed by published `@cursor/sdk` local agents.
 * Client OpenAI/Anthropic tools map to `local.customTools` (MCP family only).
 */
import { Agent, type SDKMessage } from "@cursor/sdk";
import type { TokenUsage } from "@cursor/sdk";
import { gatewayAgentModelSelection, type AgentInlineImage, type AgentTurnUsage } from "./agent_json.ts";
import type {
  CustomToolAgentHandle,
  CustomToolAgentHost,
  CustomToolSendOpts,
  SdkCustomToolMap,
} from "./custom_tool_chat.ts";

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

function isDenoDeploy(): boolean {
  try {
    return Boolean((globalThis as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno?.env.get("DENO_DEPLOYMENT_ID"));
  } catch {
    return false;
  }
}

function sdkModel(model: unknown, opts?: { fast?: boolean; reasoningEffort?: unknown }) {
  const selection = gatewayAgentModelSelection(model, opts);
  return selection.parameters?.length
    ? { id: selection.modelId, params: selection.parameters }
    : { id: selection.modelId };
}

function sdkImages(images?: AgentInlineImage[]) {
  if (!images?.length) return undefined;
  return images.map((img) => ({
    data: img.data,
    mimeType: img.mimeType || "image/png",
  }));
}

function sdkUserMessage(prompt: string, images?: AgentInlineImage[]) {
  const mapped = sdkImages(images);
  if (!mapped?.length) return prompt;
  return { text: prompt, images: mapped };
}

function usageFromTokenUsage(usage?: TokenUsage): AgentTurnUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

function assistantText(event: SDKMessage): string {
  if (event.type !== "assistant") return "";
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => (block && typeof block === "object" && block.type === "text" ? String(block.text || "") : ""))
    .filter(Boolean)
    .join("");
}

function buildAgentOptions(createOpts: {
  apiKey: string;
  model: unknown;
  fast?: boolean;
  reasoningEffort?: unknown;
  customTools: SdkCustomToolMap;
  cwd?: string;
}) {
  const cwd = createOpts.cwd || readEnv("GATEWAY_AGENT_CWD") || "/tmp";
  const hasCustomTools = Object.keys(createOpts.customTools).length > 0;
  return {
    apiKey: createOpts.apiKey,
    model: sdkModel(createOpts.model, { fast: createOpts.fast, reasoningEffort: createOpts.reasoningEffort }),
    tools: hasCustomTools ? (["mcp"] as const) : ([] as const),
    local: {
      cwd,
      settingSources: [] as const,
      customTools: createOpts.customTools,
    },
  };
}

export function createSdkAgentHost(): CustomToolAgentHost {
  if (isDenoDeploy()) {
    throw new Error("Deno Deploy cannot run @cursor/sdk local agents (native executor required). Use Node/Bun.");
  }

  return {
    async create(createOpts) {
      const base = buildAgentOptions(createOpts);
      const resumeId = createOpts.agentSessionId?.trim();
      let agent: Awaited<ReturnType<typeof Agent.create>>;
      if (resumeId && !resumeId.includes(":")) {
        try {
          agent = await Agent.resume(resumeId, base);
        } catch {
          agent = await Agent.create(base);
        }
      } else {
        agent = await Agent.create(base);
      }

      let closed = false;

      const handle: CustomToolAgentHandle = {
        agentId: agent.agentId,
        keepsParkedExecute: true,
        async send(prompt: string, sendOpts?: CustomToolSendOpts) {
          if (closed) throw new Error("agent is closed");

          const abort = new AbortController();
          const onClientAbort = () => abort.abort();
          const clientSignal = sendOpts?.signal;
          if (clientSignal) {
            if (clientSignal.aborted) abort.abort();
            else clientSignal.addEventListener("abort", onClientAbort, { once: true });
          }

          const customTools = sendOpts?.customTools ?? createOpts.customTools;
          const cwd = createOpts.cwd || readEnv("GATEWAY_AGENT_CWD") || "/tmp";
          const hasCustomTools = Object.keys(customTools).length > 0;
          const local = {
            cwd,
            customTools,
          };

          let text = "";
          let thinking = "";
          let usage: AgentTurnUsage | undefined;
          let error: string | undefined;
          let runRef: Awaited<ReturnType<typeof agent.send>> | undefined;

          const work = (async () => {
            try {
              const run = await agent.send(sdkUserMessage(prompt, sendOpts?.images), {
                local: hasCustomTools ? local : undefined,
                onDelta: ({ update }) => {
                  const rec = update as Record<string, unknown>;
                  const type = String(rec.type || "");
                  if (type === "text-delta" && typeof rec.text === "string" && rec.text) {
                    text += rec.text;
                    sendOpts?.onDelta?.({ text: rec.text });
                  } else if (type === "thinking-delta" && typeof rec.text === "string" && rec.text) {
                    thinking += rec.text;
                    sendOpts?.onDelta?.({ thinking: rec.text });
                  }
                },
              });
              runRef = run;

              for await (const event of run.stream()) {
                if (abort.signal.aborted) break;
                if (event.type === "thinking" && event.text) {
                  const delta = event.text.startsWith(thinking) ? event.text.slice(thinking.length) : event.text;
                  if (delta) {
                    thinking += delta;
                    sendOpts?.onDelta?.({ thinking: delta });
                  }
                } else if (event.type === "assistant") {
                  const chunk = assistantText(event);
                  if (chunk) {
                    const delta = chunk.startsWith(text) ? chunk.slice(text.length) : chunk;
                    if (delta) {
                      text += delta;
                      sendOpts?.onDelta?.({ text: delta });
                    }
                  }
                } else if (event.type === "usage") {
                  usage = usageFromTokenUsage(event.usage);
                } else if (event.type === "status" && event.status === "ERROR" && event.message) {
                  error = event.message;
                }
              }

              const result = await run.wait();
              usage = usageFromTokenUsage(result.usage) ?? usage;
              if (result.status === "error") {
                error = result.error?.message || "agent run failed";
              } else if (result.result) {
                text = result.result;
              }
              return { text, thinking: thinking || undefined, error, usage };
            } catch (err) {
              if (abort.signal.aborted) {
                return { text, thinking: thinking || undefined, error, usage };
              }
              error = err instanceof Error ? err.message : String(err);
              return { text, thinking: thinking || undefined, error, usage };
            } finally {
              clientSignal?.removeEventListener("abort", onClientAbort);
            }
          })();

          return {
            wait: () => work,
            abort: () => {
              if (!abort.signal.aborted) abort.abort();
              void runRef?.cancel?.();
            },
            release: () => {
              clientSignal?.removeEventListener("abort", onClientAbort);
            },
          };
        },
        async close() {
          closed = true;
          agent.close();
        },
      };

      return handle;
    },
  };
}

/** Default host used by the chat path. */
export function defaultSdkAgentHost(): CustomToolAgentHost {
  return createSdkAgentHost();
}
