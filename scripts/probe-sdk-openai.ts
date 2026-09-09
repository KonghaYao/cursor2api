#!/usr/bin/env node
/**
 * Probe: wrap published @cursor/sdk as OpenAI Chat Completions.
 * Does not print credentials. Expects CURSOR_API_KEY in env or .env.
 *
 * Run:
 *   node --experimental-strip-types scripts/probe-sdk-openai.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const SDK_ROOT = "/tmp/sdk-openai-probe/node_modules/@cursor/sdk";

function loadEnvKey(): string {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith("CURSOR_API_KEY="));
  if (!line) throw new Error("missing CURSOR_API_KEY");
  return line.slice("CURSOR_API_KEY=".length).trim();
}

function sdkImportUrl(): string {
  const req = createRequire(resolve(SDK_ROOT, "package.json"));
  const pkg = req("./package.json") as { version: string; exports?: unknown };
  const js = resolve(SDK_ROOT, "dist/esm/index.js");
  return pathToFileURL(js).href + `#v=${pkg.version}`;
}

type OpenAiTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

type OpenAiMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
};

type OpenAiRequest = {
  model?: string;
  messages: OpenAiMessage[];
  tools?: OpenAiTool[];
};

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAiResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason: "stop" | "tool_calls" | "error";
  }>;
  usage?: unknown;
  _probe?: Record<string, unknown>;
};

function lastUserText(messages: OpenAiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
        .filter(Boolean)
        .join("\n");
    }
  }
  throw new Error("no user message");
}

function hasToolResultMessages(messages: OpenAiMessage[]): boolean {
  return messages.some((m) => m.role === "tool" || m.role === "function");
}

function summarizeResponse(label: string, res: OpenAiResponse) {
  const msg = res.choices[0]?.message;
  const tcs = msg?.tool_calls ?? [];
  console.log(`\n=== ${label} ===`);
  console.log(
    JSON.stringify(
      {
        model: res.model,
        finish_reason: res.choices[0]?.finish_reason,
        content: (msg?.content || "").slice(0, 240),
        tool_calls: tcs.map((c) => ({
          id: c.id.slice(0, 24),
          name: c.function.name,
          arguments: c.function.arguments.slice(0, 160),
        })),
        probe: res._probe,
      },
      null,
      2,
    ),
  );
}

type ParkedCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
};

class DeferredToolBridge {
  readonly parked: ParkedCall[] = [];
  private notify: (() => void) | undefined;
  readonly firstBatch = new Promise<void>((resolve) => {
    this.notify = resolve;
  });

  park(name: string, args: Record<string, unknown>, toolCallId?: string): Promise<unknown> {
    return new Promise((resolve) => {
      this.parked.push({
        id: toolCallId || `call_${this.parked.length + 1}`,
        name,
        args,
        resolve,
      });
      this.notify?.();
    });
  }

  toOpenAiToolCalls(): OpenAiToolCall[] {
    return this.parked.map((p) => ({
      id: p.id,
      type: "function" as const,
      function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) },
    }));
  }

  resolveAll(result: unknown) {
    for (const p of this.parked) p.resolve(result);
  }
}

function openaiToolsToCustom(
  tools: OpenAiTool[],
  execute: (name: string, args: Record<string, unknown>, toolCallId?: string) => unknown | Promise<unknown>,
) {
  const customTools: Record<string, {
    description?: string;
    inputSchema?: Record<string, unknown>;
    execute: (args: Record<string, unknown>, ctx: { toolCallId?: string }) => unknown | Promise<unknown>;
  }> = {};
  for (const t of tools) {
    const name = t.function.name;
    customTools[name] = {
      description: t.function.description,
      inputSchema: t.function.parameters as Record<string, unknown> | undefined,
      execute: (args, ctx) => execute(name, args, ctx.toolCallId),
    };
  }
  return customTools;
}

async function main() {
  const apiKey = loadEnvKey();
  const { Agent, CursorAgentError } = await import(sdkImportUrl()) as {
    Agent: {
      create: (opts: Record<string, unknown>) => Promise<{
        send: (text: string, opts?: Record<string, unknown>) => Promise<{
          stream: () => AsyncIterable<{ type: string; status?: string; name?: string; call_id?: string; args?: unknown }>;
          wait: () => Promise<{ status: string; result?: string; error?: { message: string; code?: string } }>;
          supports: (op: string) => boolean;
          cancel?: () => Promise<void>;
        }>;
        [Symbol.asyncDispose]?: () => Promise<void>;
        close?: () => Promise<void>;
      }>;
      prompt: (message: string, options: Record<string, unknown>) => Promise<{
        status: string;
        result?: string;
        error?: { message: string; code?: string };
      }>;
    };
    CursorAgentError: new (...args: unknown[]) => Error & { isRetryable?: boolean };
  };

  const keyPrefix = apiKey.startsWith("crsr_")
    ? "crsr_"
    : apiKey.startsWith("cursor_")
      ? "cursor_"
      : apiKey.startsWith("eyJ")
        ? "jwt"
        : `other:${apiKey.slice(0, 4)}`;
  console.log("sdk", SDK_ROOT, "import", sdkImportUrl().split("#")[0]);
  console.log("key_prefix", keyPrefix, "len", apiKey.length);

  const { Cursor } = await import(sdkImportUrl()) as {
    Cursor?: { models?: { list: (opts: { apiKey: string }) => Promise<Array<{ id: string }>> } };
  };
  try {
    const models = await Cursor?.models?.list({ apiKey });
    const ids = Array.isArray(models)
      ? models.map((m) => m.id)
      : models && typeof models === "object"
        ? Object.keys(models as object)
        : [];
    console.log("models.list", ids.slice(0, 16), "kind", Array.isArray(models) ? "array" : typeof models);
  } catch (err) {
    console.log("models.list_error", err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400));
  }

  const cwd = mkdtempSync(resolve(tmpdir(), "sdk-openai-"));
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  console.log("workspace", cwd);

  try {
    const smoke = await Agent.prompt("Reply with exactly PONG and nothing else.", {
      apiKey,
      model: { id: "composer-2.5" },
      local: { cwd },
    });
    console.log(
      "prompt_smoke",
      JSON.stringify({
        status: smoke.status,
        result: (smoke.result || "").slice(0, 200),
        error: smoke.error,
      }),
    );
  } catch (err) {
    console.log("prompt_smoke_throw", err instanceof Error ? `${err.name}: ${err.message.slice(0, 400)}` : String(err).slice(0, 400));
  }

  const model = "composer-2.5";
  const weatherTool: OpenAiTool = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city. Always use this instead of guessing.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  };

  async function runTurn(opts: {
    label: string;
    messages: OpenAiMessage[];
    tools?: OpenAiTool[];
    mode: "none" | "in_process" | "deferred";
  }): Promise<OpenAiResponse> {
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-sdk-${created}`;
    const toolEvents: Array<{ type: string; status?: string; name?: string }> = [];
    const bridge = new DeferredToolBridge();

    if (hasToolResultMessages(opts.messages) && opts.mode !== "in_process") {
      return {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                "SDK adapter cannot accept OpenAI tool-result messages on a new Agent. Tool results must resolve the still-running customTools.execute() from the previous send().",
            },
            finish_reason: "error",
          },
        ],
        _probe: { unsupported: "openai_tool_result_messages", hasToolResults: true },
      };
    }

    const customTools =
      opts.tools?.length && opts.mode !== "none"
        ? openaiToolsToCustom(opts.tools, (name, args, toolCallId) => {
            if (opts.mode === "in_process") {
              return { city: args.city, temp_c: 22, source: "in_process_execute" };
            }
            return bridge.park(name, args, toolCallId);
          })
        : undefined;

    const agent = await Agent.create({
      apiKey,
      model: { id: model },
      tools: customTools ? ["mcp"] : undefined,
      local: {
        cwd,
        customTools,
      },
    });

    try {
      const prompt = lastUserText(opts.messages);
      const run = await agent.send(prompt);
      const events: string[] = [];
      let statusMessage: string | undefined;

      if (opts.mode === "deferred") {
        const timeout = AbortSignal.timeout(45_000);
        await Promise.race([
          bridge.firstBatch,
          run.wait().then((result) => {
            events.push(
              `wait_before_park:${result.status}:${result.error?.code || ""}:${(result.error?.message || "").slice(0, 240)}`,
            );
          }),
          new Promise((_, reject) => {
            timeout.addEventListener("abort", () => reject(new Error("timeout waiting for customTools.execute")));
          }),
        ]);

        if (bridge.parked.length > 0) {
          const toolCalls = bridge.toOpenAiToolCalls();
          const openai: OpenAiResponse = {
            id,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null, tool_calls: toolCalls },
                finish_reason: "tool_calls",
              },
            ],
            _probe: {
              mode: opts.mode,
              parked: bridge.parked.length,
              note: "Agent.send() is still running; execute() is blocked until the client returns a tool result",
            },
          };
          summarizeResponse(opts.label, openai);

          console.log(`--- ${opts.label}: simulating OpenAI client tool result ---`);
          bridge.resolveAll({ city: "Tokyo", temp_c: 22, source: "openai_client_tool_result" });
          const result = await run.wait();
          const final: OpenAiResponse = {
            id: `${id}-final`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: String(result.result || "") },
                finish_reason: result.status === "error" ? "error" : "stop",
              },
            ],
            _probe: { mode: "deferred_after_tool_result", runStatus: result.status },
          };
          summarizeResponse(`${opts.label} after client tool result`, final);
          return openai;
        }
      }

      for await (const event of run.stream()) {
        const rec = event as {
          type: string;
          status?: string;
          name?: string;
          message?: string;
          text?: string;
        };
        events.push(
          `${rec.type}${rec.status ? `:${rec.status}` : ""}${rec.name ? `:${rec.name}` : ""}${rec.message ? `:${String(rec.message).slice(0, 120)}` : ""}`,
        );
        if (rec.type === "status" && rec.message) statusMessage = rec.message;
        if (rec.type === "status") {
          events.push(`status_raw:${JSON.stringify(event).slice(0, 300)}`);
        }
        if (event.type === "tool_call") toolEvents.push({ type: event.type, status: event.status, name: event.name });
      }
      const result = await run.wait();
      const openai: OpenAiResponse = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: String(result.result || "") },
            finish_reason: result.status === "error" ? "error" : "stop",
          },
        ],
        _probe: {
          mode: opts.mode,
          runStatus: result.status,
          runError: result.error,
          statusMessage,
          stream: events.slice(0, 24),
          toolEvents,
          parked: bridge.parked.length,
        },
      };
      summarizeResponse(opts.label, openai);
      return openai;
    } catch (err) {
      const e = err as Error & { isRetryable?: boolean };
      const openai: OpenAiResponse = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `${e.name || "Error"}: ${e.message}`,
            },
            finish_reason: "error",
          },
        ],
        _probe: {
          mode: opts.mode,
          error: e.message.slice(0, 400),
          isRetryable: e.isRetryable,
          cursorAgentError: err instanceof CursorAgentError,
        },
      };
      summarizeResponse(opts.label, openai);
      return openai;
    } finally {
      if (typeof agent.close === "function") await agent.close();
      else if (typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
    }
  }

  const text = await runTurn({
    label: "A text-only OpenAI request",
    messages: [{ role: "user", content: "Reply with exactly PONG and nothing else." }],
    mode: "none",
  });

  const inProcess = await runTurn({
    label: "B OpenAI tools + in-process customTools.execute (NOT client tools)",
    messages: [{ role: "user", content: "What is the weather in Tokyo? Use get_weather. Then answer in one short sentence." }],
    tools: [weatherTool],
    mode: "in_process",
  });

  const deferred = await runTurn({
    label: "C OpenAI client-tools protocol (park execute, return tool_calls)",
    messages: [{ role: "user", content: "What is the weather in Tokyo? You must call get_weather." }],
    tools: [weatherTool],
    mode: "deferred",
  });

  const statelessFollowup = await runTurn({
    label: "D second OpenAI request with role=tool (new Agent, no parked execute)",
    messages: [
      { role: "user", content: "What is the weather in Tokyo?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "{\"temp_c\":22}" },
    ],
    tools: [weatherTool],
    mode: "deferred",
  });

  console.log("\n=== summary ===");
  console.log(
    JSON.stringify(
      {
        text_finish: text.choices[0]?.finish_reason,
        in_process_finish: inProcess.choices[0]?.finish_reason,
        in_process_has_tool_calls: Boolean(inProcess.choices[0]?.message.tool_calls?.length),
        deferred_finish: deferred.choices[0]?.finish_reason,
        deferred_has_tool_calls: Boolean(deferred.choices[0]?.message.tool_calls?.length),
        stateless_tool_followup: statelessFollowup.choices[0]?.finish_reason,
        stateless_unsupported: statelessFollowup._probe?.unsupported ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
