/**
 * Deno entry.
 *
 * Local:
 *   deno task start
 *
 * Chat uses AgentService/Run + in-process customTools. Deno fetch is
 * full-duplex (HTTP/2). InferenceService is dead for Dashboard keys.
 */

import { handleGatewayRequest } from "./lib/handler.ts";
import { createDenoKv, createMemoryKv, type Kv } from "./lib/kv.ts";
import type { GatewayUpstream } from "./lib/auth.ts";

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(
    options:
      | ((req: Request) => Response | Promise<Response>)
      | {
          hostname?: string;
          port?: number;
          onListen?: (local: { hostname: string; port: number }) => void;
        },
    handler?: (req: Request) => Response | Promise<Response>,
  ): unknown;
};

const PORT = Number(Deno.env.get("PORT") || 8789);
const upstream: GatewayUpstream = Deno.env.get("GATEWAY_UPSTREAM") === "inference" ? "inference" : "cloud";
const isDeploy = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));

const kv: Kv = await (async () => {
  try {
    return await createDenoKv();
  } catch {
    return createMemoryKv();
  }
})();
const ctx = { kv, upstream };

const handler = (request: Request) => handleGatewayRequest(request, ctx);

if (isDeploy) {
  Deno.serve(handler);
} else {
  Deno.serve(
    {
      hostname: "127.0.0.1",
      port: PORT,
      onListen: ({ hostname, port }) => {
        console.log(`gateway  http://${hostname}:${port}`);
      },
    },
    handler,
  );
}

if (upstream === "cloud") {
  console.log("  deno  chat → AgentService/Run customTools (fetch duplex / HTTP/2)");
  console.log("  models GET https://api.cursor.com/v1/models");
  console.log("  tools    MCP family only; client function tools as customTools");
} else {
  console.log("  deno  InferenceService/Stream  (dead for Dashboard crsr_ keys)");
}
console.log("  GET  /health");
console.log("  GET  /v1/models");
console.log("  POST /v1/chat/completions");
console.log("  POST /v1/messages");
