import assert from "node:assert/strict";
import test from "node:test";
import { bytesBody, encodeConnectFrame } from "./bytes.ts";
import { streamOpenAiChatCompletion } from "./inference.ts";
import { resolveSessionForRequest } from "./session.ts";

test("fingerprint upstream sessionId matches tenant-scoped conversationId (not bare session_fp)", async () => {
  const tenant = "a".repeat(16);
  const body = { model: "composer-2.5-fast" };
  const messages = [{ role: "user", content: "hello" }];
  const session = await resolveSessionForRequest(tenant, messages, { body, tools: [] });
  assert.equal(session.mode, "fingerprint");
  if (session.mode !== "fingerprint") return;

  const conversationId = `${tenant}:${session.session_fp}`;
  assert.equal(session.clientId, session.session_fp);
  assert.notEqual(session.clientId, conversationId);
  // Regression: stream/non-stream upstream must use this, not clientId alone.
  assert.equal(conversationId, `${tenant}:${session.clientId}`);
});

test("streamOpenAiChatCompletion keeps sessionId internal to upstream", async () => {
  const upstreamSessionId = `${"b".repeat(16)}:${"c".repeat(64)}`;
  const frame = encodeConnectFrame({ textPart: { text: "ok" } });
  let seenSessionHeader: string | null = null;

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers as HeadersInit);
    seenSessionHeader = headers.get("x-session-id");
    return new Response(bytesBody(frame), { status: 200 });
  };

  try {
    const res = await streamOpenAiChatCompletion({
      accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig",
      body: {
        messages: [{ role: "INFERENCE_MESSAGE_ROLE_USER", text: "hi" }],
        conversationId: upstreamSessionId,
        conversationGroupId: upstreamSessionId,
        modelId: "composer-2.5-fast",
        requestedModel: { modelId: "composer-2.5-fast", maxMode: false, builtInModel: true },
      },
      model: "composer-2.5-fast",
      conversationId: upstreamSessionId.slice(-16),
      sessionId: upstreamSessionId,
      tools: [],
    });
    assert.equal(res.status, 200);
    assert.equal(seenSessionHeader, upstreamSessionId);
    assert.equal(res.headers.get("x-session-id"), null);
    const text = await res.text();
    assert.ok(text.includes("data:"));
  } finally {
    globalThis.fetch = prevFetch;
  }
});
