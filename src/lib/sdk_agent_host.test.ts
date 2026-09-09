import assert from "node:assert/strict";
import test from "node:test";
import { customToolsClearForTests, openaiToolsToCustom, toSdkCustomTools, upsertClientToolSession } from "./custom_tools.ts";
import { createSdkAgentHost } from "./sdk_agent_host.ts";
import type { AgentDuplex, OpenAgentRun } from "./agent_run.ts";
import type { JsonObject } from "./agent_json.ts";
import { asObject, field } from "./agent_json.ts";

afterEachClear();

function afterEachClear(): void {
  test.afterEach(() => {
    customToolsClearForTests();
  });
}

class InteractiveDuplex implements AgentDuplex {
  sent: JsonObject[] = [];
  private readonly pending: Array<JsonObject | null> = [];
  private waiters: Array<(value: JsonObject | null) => void> = [];
  onSend?: (message: JsonObject) => void;

  push(message: JsonObject | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.pending.push(message);
  }

  async send(message: JsonObject): Promise<void> {
    this.sent.push(message);
    this.onSend?.(message);
  }

  next(): Promise<JsonObject | null> {
    if (this.pending.length) return Promise.resolve(this.pending.shift() ?? null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.push(null);
  }
}

test("in-repo host parks customTools.execute and finishes after the tool result", async () => {
  const tools = openaiToolsToCustom([{ type: "function", function: { name: "get_weather" } }]);
  const session = upsertClientToolSession("t", "s", tools);
  const customTools = toSdkCustomTools(session);
  const duplex = new InteractiveDuplex();

  duplex.onSend = (message) => {
    if (field(message, "runRequest", "run_request")) {
      duplex.push({ execServerMessage: { id: 1, execId: "ctx", requestContextArgs: {} } });
      return;
    }
    const exec = asObject(field(message, "execClientMessage", "exec_client_message"));
    if (field(exec, "requestContextResult", "request_context_result")) {
      duplex.push({
        execServerMessage: {
          id: 2,
          execId: "mcp-1",
          mcpArgs: {
            name: "custom-user-tools-get_weather",
            providerIdentifier: "custom-user-tools",
            toolName: "get_weather",
            toolCallId: "call_weather",
            args: { city: { stringValue: "Tokyo" } },
          },
        },
      });
      return;
    }
    if (field(exec, "mcpResult", "mcp_result")) {
      duplex.push({ interactionUpdate: { textDelta: { text: "22c in Tokyo" } } });
      duplex.push({ interactionUpdate: { turnEnded: {} } });
    }
  };

  const openRun: OpenAgentRun = async () => duplex;
  const host = createSdkAgentHost({
    openRun,
    exchange: async () => ({ accessToken: "tok", refreshToken: null }),
  });
  const agent = await host.create({ apiKey: "crsr_test", model: "composer-2.5-fast", customTools });
  const run = await agent.send("weather in Tokyo?");

  const parked = await waitFor(() => session.parked.find((p) => !p.offered));
  assert.equal(parked?.name, "get_weather");
  assert.equal(parked?.args.city, "Tokyo");
  parked!.resolve?.({ content: [{ type: "text", text: '{"temp":22}' }] });

  const result = await run.wait();
  assert.equal(result.error, undefined);
  assert.equal(result.text, "22c in Tokyo");
  assert.ok(
    duplex.sent.some((m) => field(asObject(field(m, "execClientMessage")), "mcpResult", "mcp_result")),
  );
  await agent.close();
});

test("JWT credentials skip exchange_user_api_key", async () => {
  const jwt = "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.test";
  let exchanged = false;
  const duplex = new InteractiveDuplex();
  duplex.onSend = (message) => {
    if (field(message, "runRequest")) {
      duplex.push({ interactionUpdate: { textDelta: { text: "PONG" } } });
      duplex.push({ interactionUpdate: { turnEnded: {} } });
    }
  };
  const host = createSdkAgentHost({
    openRun: async (opts) => {
      assert.equal(opts.accessToken, jwt);
      return duplex;
    },
    exchange: async () => {
      exchanged = true;
      return { accessToken: "nope", refreshToken: null };
    },
  });
  const agent = await host.create({ apiKey: jwt, model: "composer-2.5", customTools: {} });
  const result = await (await agent.send("ping")).wait();
  assert.equal(exchanged, false);
  assert.equal(result.text, "PONG");
  await agent.close();
});

test("AgentService requestedModel sends explicit fast for composer standard vs fast", async () => {
  async function requestedModelFor(
    model: string,
    customTools: Record<string, unknown> = {},
    extra?: { reasoningEffort?: unknown },
  ) {
    const duplex = new InteractiveDuplex();
    duplex.onSend = (message) => {
      if (field(message, "runRequest")) {
        duplex.push({ interactionUpdate: { textDelta: { text: "PONG" } } });
        duplex.push({ interactionUpdate: { turnEnded: {} } });
      }
    };
    const host = createSdkAgentHost({
      openRun: async () => duplex,
      exchange: async () => ({ accessToken: "tok", refreshToken: null }),
    });
    const agent = await host.create({
      apiKey: "crsr_test",
      model,
      reasoningEffort: extra?.reasoningEffort,
      customTools: customTools as never,
    });
    await (await agent.send("ping")).wait();
    await agent.close();
    const run = asObject(field(duplex.sent[0], "runRequest"));
    return asObject(field(run, "requestedModel"));
  }

  const standard = await requestedModelFor("composer-2.5", { lookup: { description: "x", inputSchema: {} } });
  assert.equal(standard?.modelId, "composer-2.5");
  assert.deepEqual(standard?.parameters, [{ id: "fast", value: "false" }]);

  const fast = await requestedModelFor("composer-2.5-fast");
  assert.equal(fast?.modelId, "composer-2.5");
  assert.deepEqual(fast?.parameters, [{ id: "fast", value: "true" }]);

  const grok = await requestedModelFor("grok-4.6", { lookup: { description: "x", inputSchema: {} } });
  assert.equal(grok?.modelId, "grok-4.6");
  assert.deepEqual(grok?.parameters, [
    { id: "fast", value: "false" },
    { id: "effort", value: "high" },
  ]);

  const grokFast = await requestedModelFor("grok-4.6-fast");
  assert.equal(grokFast?.modelId, "grok-4.6");
  assert.deepEqual(grokFast?.parameters, [
    { id: "fast", value: "true" },
    { id: "effort", value: "high" },
  ]);

  const grokMax = await requestedModelFor("grok-4.6-fast", {}, { reasoningEffort: "max" });
  assert.deepEqual(grokMax?.parameters, [
    { id: "fast", value: "true" },
    { id: "effort", value: "xhigh" },
  ]);
});

test("in-repo host returns turnEnded usage to wait()", async () => {
  const duplex = new InteractiveDuplex();
  duplex.onSend = (message) => {
    if (field(message, "runRequest")) {
      duplex.push({ interactionUpdate: { textDelta: { text: "PONG" } } });
      duplex.push({
        interactionUpdate: {
          turnEnded: { inputTokens: 40, outputTokens: 4, cacheReadTokens: 30, cacheWriteTokens: 2 },
        },
      });
    }
  };
  const host = createSdkAgentHost({
    openRun: async () => duplex,
    exchange: async () => ({ accessToken: "tok", refreshToken: null }),
  });
  const agent = await host.create({ apiKey: "crsr_test", model: "composer-2.5", customTools: {} });
  const result = await (await agent.send("ping")).wait();
  assert.equal(result.text, "PONG");
  assert.deepEqual(result.usage, {
    inputTokens: 40,
    outputTokens: 4,
    cacheReadTokens: 30,
    cacheWriteTokens: 2,
    reasoningTokens: undefined,
  });
  await agent.close();
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = fn();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}
