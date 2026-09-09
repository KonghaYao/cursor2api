import assert from "node:assert/strict";
import test from "node:test";
import { encodeConnectFrame } from "./bytes.ts";
import { MCP_ALLOWED_PROTO_TOOLS } from "./agent_json.ts";
import {
  agentRunHeaders,
  agentRunUrl,
  isDenoRuntime,
  openFetchAgentRun,
} from "./agent_run.ts";

test("isDenoRuntime is false under Node", () => {
  assert.equal(isDenoRuntime(), false);
});

test("agentRunHeaders allowlists only the MCP proto family", () => {
  const headers = agentRunHeaders("tok", "conv-1");
  assert.equal(headers["content-type"], "application/connect+json");
  assert.equal(headers["x-session-id"], "conv-1");
  assert.equal(headers["x-cursor-agent-allowed-tools"], MCP_ALLOWED_PROTO_TOOLS.join(","));
  assert.match(agentRunUrl(), /\/agent\.v1\.AgentService\/Run$/);
});

test("fetch transport reads server frames while the request body stays open", async () => {
  const server = new TransformStream<Uint8Array, Uint8Array>();
  const serverWriter = server.writable.getWriter();

  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = init?.body;
    if (!(body instanceof ReadableStream)) throw new Error("expected streaming request body");
    void (async () => {
      const reader = body.getReader();
      const first = await reader.read();
      if (!first.value?.byteLength) throw new Error("expected a Connect frame");
      await serverWriter.write(encodeConnectFrame({ interactionUpdate: { textDelta: { text: "hi" } } }));
      await serverWriter.write(encodeConnectFrame({ interactionUpdate: { turnEnded: {} } }));
      await serverWriter.close();
    })();
    return new Response(server.readable, { status: 200 });
  };

  const duplex = await openFetchAgentRun({
    accessToken: "tok",
    conversationId: "c1",
    fetchImpl,
  });
  await duplex.send({ runRequest: { conversationId: "c1" } });
  assert.deepEqual(await duplex.next(), { interactionUpdate: { textDelta: { text: "hi" } } });
  assert.deepEqual(await duplex.next(), { interactionUpdate: { turnEnded: {} } });
  duplex.close();
});
