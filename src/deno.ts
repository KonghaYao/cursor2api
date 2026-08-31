/**
 * Deno entry.
 *
 *   deno task start
 */

import { handleGatewayRequest } from "./lib/handler.ts";
import { createMemoryKv } from "./lib/kv.ts";

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(
    options: {
      hostname?: string;
      port: number;
      onListen?: (local: { hostname: string; port: number }) => void;
    },
    handler: (req: Request) => Response | Promise<Response>,
  ): unknown;
};

const PORT = Number(Deno.env.get("PORT") || 8789);
const kv = createMemoryKv();

Deno.serve(
  {
    hostname: "127.0.0.1",
    port: PORT,
    onListen: ({ hostname, port }) => {
      console.log(`gateway  http://${hostname}:${port}`);
    },
  },
  (request) => handleGatewayRequest(request, { kv }),
);

console.log("  deno  InferenceService/Stream  (client executes tool_calls)");
console.log("  GET  /health");
console.log("  GET  /v1/models");
console.log("  POST /v1/chat/completions");
console.log("  POST /v1/messages");
