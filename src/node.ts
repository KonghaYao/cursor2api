#!/usr/bin/env node
/**
 * Node / Bun entry. Listens on 127.0.0.1 and ::1.
 *
 *   node src/node.ts
 *   bun src/node.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleGatewayRequest } from "./lib/handler.ts";
import { createMemoryKv } from "./lib/kv.ts";

const PORT = Number(process.env.PORT || 8789);
const kv = createMemoryKv();

async function incomingToRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else headers.set(key, value);
  }
  const method = req.method || "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  return new Request(url, { method, headers, body: body.length ? new Uint8Array(body) : undefined });
}

async function writeResponse(res: ServerResponse, response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  res.end(Buffer.from(buf));
}

async function onRequest(req: IncomingMessage, res: ServerResponse) {
  try {
    const request = await incomingToRequest(req);
    const response = await handleGatewayRequest(request, { kv });
    await writeResponse(res, response);
  } catch (err) {
    const message = String((err as Error)?.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { message, type: "server_error" } }));
      return;
    }
    res.end();
  }
}

function listen(host: string) {
  const server = createServer(onRequest);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (host === "::1" && (err.code === "EADDRINUSE" || err.code === "EAFNOSUPPORT")) return;
    console.error(`listen ${host}:${PORT} ${err.code || err.message}`);
  });
  server.listen(PORT, host, () => {
    const pretty = host === "::1" ? "[::1]" : host;
    console.log(`gateway  http://${pretty}:${PORT}`);
  });
}

listen("127.0.0.1");
listen("::1");
console.log("  node  InferenceService/Stream  (client executes tool_calls)");
console.log("  GET  /health");
console.log("  GET  /v1/models");
console.log("  POST /v1/chat/completions");
console.log("  POST /v1/messages");
