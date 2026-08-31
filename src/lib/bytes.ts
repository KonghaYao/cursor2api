const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(): string {
  return crypto.randomUUID();
}


export function bytesBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const body = new Response(bytesBody(bytes)).body;
  if (!body) return bytes;
  const stream = body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function encodeConnectFrame(obj: unknown): Uint8Array {
  const payload = encoder.encode(JSON.stringify(obj));
  const out = new Uint8Array(5 + payload.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

export type ConnectFrame = {
  flags: number;
  end: boolean;
  json: Record<string, unknown> | null;
};

export async function decodeConnectFrames(buffer: Uint8Array): Promise<ConnectFrame[]> {
  const frames: ConnectFrame[] = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0);
    if (offset + 5 + length > buffer.length) break;
    let payload = buffer.subarray(offset + 5, offset + 5 + length);
    if (flags & 1) payload = await gunzipBytes(payload);
    const text = decoder.decode(payload);
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = { _unparsed: text.slice(0, 400) };
    }
    frames.push({ flags, end: Boolean(flags & 2), json });
    offset += 5 + length;
  }
  return frames;
}

export function jwtClaims(token: string): { exp?: number; [key: string]: unknown } | null {
  try {
    const payload = token.split(".")[1];
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json) as { exp?: number };
  } catch {
    return null;
  }
}

export function jsonResponse(status: number, obj: unknown, sessionId?: string): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  if (sessionId) headers.set("x-session-id", sessionId);
  return new Response(JSON.stringify(obj), { status, headers });
}

export function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "authorization, content-type, x-api-key, anthropic-version, x-session-id, x-request-id, x-cursor-session-id",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });
}

export function sseResponse(body: string, sessionId: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
      "x-session-id": sessionId,
    },
  });
}
