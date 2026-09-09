/**
 * Bidirectional AgentService/Run over Connect JSON.
 *
 * Deno: WHATWG fetch + ReadableStream body. Deno's fetch is full-duplex on
 * HTTP/1.1 and HTTP/2 (docs.deno.com web platform APIs) — the response can
 * start while the request body is still open. Do not pass `duplex: "half"`
 * (that's Chromium/undici half-duplex and would stall exec round-trips).
 *
 * Node/Bun: `node:http2` (undici `duplex: "half"` is not full-duplex).
 */
import { CLIENT_VERSION, CURSOR_BASE, sdkHeaders } from "./auth.ts";
import { ConnectFrameParser, encodeConnectFrame, type ConnectFrame } from "./bytes.ts";
import {
  ALLOWED_TOOLS_HEADER_NAME,
  MCP_ALLOWED_PROTO_TOOLS,
  connectErrorMessage,
  type JsonObject,
} from "./agent_json.ts";

export type AgentDuplex = {
  send(message: JsonObject): Promise<void>;
  next(): Promise<JsonObject | null>;
  close(): void;
};

export type OpenAgentRun = (opts: {
  accessToken: string;
  conversationId: string;
  signal?: AbortSignal;
}) => Promise<AgentDuplex>;

type Http2Session = {
  request: (headers: Record<string, string>) => Http2Stream;
  close: () => void;
  destroyed?: boolean;
  once: (event: string, listener: (...args: never[]) => void) => Http2Session;
};

type Http2Stream = {
  write: (chunk: Uint8Array, cb?: (err?: Error | null) => void) => boolean;
  end: (chunk?: Uint8Array) => void;
  destroy: (err?: Error) => void;
  on: (event: string, listener: (...args: never[]) => void) => Http2Stream;
  once: (event: string, listener: (...args: never[]) => void) => Http2Stream;
};

function agentServiceUrl(): URL {
  const raw = CURSOR_BASE.replace(/\/+$/, "");
  return new URL(raw.includes("://") ? raw : `https://${raw}`);
}

export function agentRunUrl(): string {
  const url = agentServiceUrl();
  return `${url.origin}/agent.v1.AgentService/Run`;
}

export function isDenoRuntime(): boolean {
  return typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";
}

export function agentRunHeaders(accessToken: string, conversationId: string): Record<string, string> {
  return {
    ...sdkHeaders(accessToken),
    "content-type": "application/connect+json",
    [ALLOWED_TOOLS_HEADER_NAME]: MCP_ALLOWED_PROTO_TOOLS.join(","),
    "x-session-id": conversationId,
    "x-cursor-client-version": CLIENT_VERSION,
  };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

class ConnectInbox {
  private readonly parser = new ConnectFrameParser();
  private readonly pending: Array<JsonObject | null> = [];
  private waiters: Array<(value: JsonObject | null) => void> = [];
  closed = false;
  httpStatus?: number;
  lastError?: Error;

  async pushBytes(chunk: Uint8Array): Promise<void> {
    this.parser.push(chunk);
    await this.drainFrames();
  }

  private async drainFrames(): Promise<void> {
    let frames: ConnectFrame[];
    try {
      frames = await this.parser.drainAvailableFrames();
    } catch (err) {
      this.fail(toError(err));
      return;
    }
    for (const frame of frames) {
      const json = frame.json;
      if (!json) continue;
      const connectErr = connectErrorMessage(json, this.httpStatus);
      if (frame.end && connectErr) {
        this.fail(new Error(connectErr));
        return;
      }
      this.push(json);
    }
  }

  private push(value: JsonObject | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.pending.push(value);
  }

  fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.lastError = err;
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
  }

  async finish(err?: Error): Promise<void> {
    await this.drainFrames();
    if (err) {
      this.fail(err);
      return;
    }
    if (this.httpStatus && this.httpStatus >= 400 && !this.pending.length) {
      this.fail(new Error(`AgentService HTTP ${this.httpStatus}`));
      return;
    }
    this.push(null);
    this.closed = true;
  }

  next(): Promise<JsonObject | null> {
    if (this.lastError) return Promise.reject(this.lastError);
    if (this.pending.length) return Promise.resolve(this.pending.shift() ?? null);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.waiters.push((value) => {
        if (this.lastError) reject(this.lastError);
        else resolve(value);
      });
    });
  }

  endWaiters(): void {
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
  }
}

class Http2ConnectDuplex implements AgentDuplex {
  private readonly inbox = new ConnectInbox();
  private sendQueue: Promise<void> = Promise.resolve();
  private readonly stream: Http2Stream;
  private readonly sessionCloser: () => void;

  constructor(stream: Http2Stream, sessionCloser: () => void) {
    this.stream = stream;
    this.sessionCloser = sessionCloser;
    stream.on("response", ((headers: Record<string, unknown>) => {
      this.inbox.httpStatus = Number(headers[":status"] || 0);
    }) as (...args: never[]) => void);
    stream.on("data", ((chunk: Uint8Array | string) => {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      void this.inbox.pushBytes(bytes);
    }) as (...args: never[]) => void);
    stream.on("end", (() => {
      void this.inbox.finish();
    }) as (...args: never[]) => void);
    stream.on("error", ((err: Error) => {
      void this.inbox.finish(toError(err));
    }) as (...args: never[]) => void);
  }

  async send(message: JsonObject): Promise<void> {
    if (this.inbox.closed) throw this.inbox.lastError ?? new Error("AgentService stream is closed");
    this.sendQueue = this.sendQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.write(encodeConnectFrame(message), (err) => {
            if (err) reject(toError(err));
            else resolve();
          });
        }),
    );
    await this.sendQueue;
  }

  next(): Promise<JsonObject | null> {
    return this.inbox.next();
  }

  close(): void {
    if (this.inbox.closed) {
      this.sessionCloser();
      return;
    }
    this.inbox.closed = true;
    try {
      this.stream.end();
    } catch {
      /* empty */
    }
    this.sessionCloser();
    this.inbox.endWaiters();
  }
}

class FetchConnectDuplex implements AgentDuplex {
  private readonly inbox = new ConnectInbox();
  private sendQueue: Promise<void> = Promise.resolve();
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>, responseBody: ReadableStream<Uint8Array>, httpStatus: number) {
    this.writer = writer;
    this.inbox.httpStatus = httpStatus;
    void this.readResponse(responseBody);
  }

  private async readResponse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          await this.inbox.finish();
          return;
        }
        if (value?.byteLength) await this.inbox.pushBytes(value);
      }
    } catch (err) {
      this.inbox.fail(toError(err));
    }
  }

  async send(message: JsonObject): Promise<void> {
    if (this.inbox.closed) throw this.inbox.lastError ?? new Error("AgentService stream is closed");
    this.sendQueue = this.sendQueue.then(() => this.writer.write(encodeConnectFrame(message)));
    await this.sendQueue;
  }

  next(): Promise<JsonObject | null> {
    return this.inbox.next();
  }

  close(): void {
    this.inbox.closed = true;
    void this.writer.close().catch(() => {
      /* empty */
    });
    this.inbox.endWaiters();
  }
}

let testOpenAgentRun: OpenAgentRun | undefined;

export function setOpenAgentRunForTests(open: OpenAgentRun | undefined): void {
  testOpenAgentRun = open;
}

export async function openAgentRun(opts: {
  accessToken: string;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<AgentDuplex> {
  if (testOpenAgentRun) return testOpenAgentRun(opts);
  if (isDenoRuntime()) return openFetchAgentRun(opts);
  return openHttp2AgentRun(opts);
}

export async function openFetchAgentRun(opts: {
  accessToken: string;
  conversationId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<AgentDuplex> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("AgentService/Run fetch transport needs global fetch");
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const init: RequestInit = {
    method: "POST",
    headers: agentRunHeaders(opts.accessToken, opts.conversationId),
    body: readable,
    signal: opts.signal,
  };
  // Deno defaults ReadableStream bodies to duplex:full (response headers
  // arrive while the request is still open). Chromium/undici require
  // duplex:"half", which is NOT full-duplex — do not set it here.
  const res = await fetchImpl(agentRunUrl(), init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    void writer.close().catch(() => {
      /* empty */
    });
    throw new Error(`AgentService HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) {
    void writer.close().catch(() => {
      /* empty */
    });
    throw new Error("AgentService/Run returned an empty body");
  }
  const duplex = new FetchConnectDuplex(writer, res.body, res.status);
  const onAbort = () => duplex.close();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) duplex.close();
  return duplex;
}

export async function openHttp2AgentRun(opts: {
  accessToken: string;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<AgentDuplex> {
  let http2: { connect: (authority: string) => Http2Session };
  try {
    http2 = (await import("node:http2")) as unknown as { connect: (authority: string) => Http2Session };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`AgentService/Run needs HTTP/2 (node:http2) on Node/Bun (${message}).`);
  }

  const url = agentServiceUrl();
  const session = http2.connect(`${url.protocol}//${url.host}`);
  await new Promise<void>((resolve, reject) => {
    const onConnect = () => resolve();
    const onError = (err: unknown) => reject(toError(err));
    session.once("connect", onConnect as (...args: never[]) => void);
    session.once("error", onError as (...args: never[]) => void);
  });
  const headers: Record<string, string> = {
    ":method": "POST",
    ":scheme": url.protocol.replace(":", "") || "https",
    ":authority": url.host,
    ":path": "/agent.v1.AgentService/Run",
    ...agentRunHeaders(opts.accessToken, opts.conversationId),
  };
  const stream = session.request(headers);
  const duplex = new Http2ConnectDuplex(stream, () => {
    try {
      session.close();
    } catch {
      /* empty */
    }
  });
  const onAbort = () => duplex.close();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) duplex.close();
  return duplex;
}
