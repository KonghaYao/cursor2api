import { jwtClaims, randomId, sha256Hex } from "./bytes.ts";
import { jwtL1Get, jwtL1Set } from "./jwt_l1_cache.ts";
import { kvGetJwt, kvSetJwt, type Kv } from "./kv.ts";

export const CURSOR_BASE = "https://api2.cursor.sh";
export const CLIENT_VERSION = "sdk-1.0.30";

export type GatewayCtx = {
  kv: Kv;
};

export function sdkHeaders(accessToken: string, requestId = randomId()): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "x-cursor-client-type": "sdk",
    "x-cursor-client-version": CLIENT_VERSION,
    "x-ghost-mode": "false",
    "x-cursor-streaming": "true",
    "x-request-id": requestId,
    "connect-protocol-version": "1",
  };
}

export function incomingCredential(headers: Headers): string | undefined {
  const auth = headers.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const xApi = (headers.get("x-api-key") || headers.get("x-cursor-api-key") || "").trim();
  const raw = bearer || xApi;
  if (!raw || isPlaceholder(raw)) return undefined;
  return raw;
}

function isPlaceholder(raw: string): boolean {
  const k = raw.trim().toLowerCase();
  return (
    !k ||
    k === "sk-local" ||
    k === "unused" ||
    k === "any" ||
    k === "none" ||
    k === "changeme" ||
    k === "your-api-key"
  );
}

function isJwt(token: string): boolean {
  return token.startsWith("eyJ") && token.split(".").length === 3;
}

export async function credentialFingerprint(credential: string): Promise<string> {
  return (await sha256Hex(credential)).slice(0, 16);
}

export async function exchangeApiKey(apiKey: string): Promise<{ accessToken: string; refreshToken: string | null }> {
  const res = await fetch(`${CURSOR_BASE}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  if (!res.ok) throw new Error(`exchange_user_api_key ${res.status}: ${text.slice(0, 400)}`);
  const accessToken = String(json?.accessToken || json?.access_token || "");
  if (!accessToken) throw new Error("exchange_user_api_key returned no accessToken");
  return {
    accessToken,
    refreshToken: (json?.refreshToken || json?.refresh_token || null) as string | null,
  };
}

export class AuthError extends Error {
  status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

function resolveCredential(headers: Headers): string {
  const incoming = incomingCredential(headers);
  if (!incoming) throw new AuthError("missing Cursor API key (Authorization: Bearer crsr_… or x-api-key)");
  return incoming;
}

/**
 * Resolve upstream Bearer for Inference/Agent RPC.
 *
 * Production: client sends `crsr_…` on every request → L1 → KV → exchange (once per TTL).
 * Optional: client sends JWT → use as-is, no cache (not the hosted client contract).
 */
export async function getAccessToken(ctx: GatewayCtx, headers: Headers): Promise<{ accessToken: string; tenant: string }> {
  const credential = resolveCredential(headers);
  const tenant = await credentialFingerprint(credential);

  if (isJwt(credential)) {
    return { accessToken: credential, tenant };
  }

  const cacheKey = `jwt:${tenant}`;
  const l1 = jwtL1Get(cacheKey);
  if (l1) return { accessToken: l1.accessToken, tenant };

  const cached = await kvGetJwt(ctx.kv, cacheKey);
  if (cached) {
    jwtL1Set(cacheKey, cached);
    return { accessToken: cached.accessToken, tenant };
  }

  const exchanged = await exchangeApiKey(credential);
  const accessToken = exchanged.accessToken;
  const now = Date.now() / 1000;
  const exp = Number(jwtClaims(accessToken)?.exp) || now + 3600;
  const row = { accessToken, exp };
  await kvSetJwt(ctx.kv, cacheKey, row);
  jwtL1Set(cacheKey, row);
  return { accessToken, tenant };
}

export async function connectUnary(
  path: string,
  accessToken: string,
  body: unknown,
  requestId = randomId(),
): Promise<{ status: number; ok: boolean; json: Record<string, unknown> | null; text: string }> {
  const res = await fetch(`${CURSOR_BASE}${path}`, {
    method: "POST",
    headers: {
      ...sdkHeaders(accessToken, requestId),
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = { _raw: text.slice(0, 800) };
  }
  return { status: res.status, ok: res.ok, json, text };
}

export function modelsFrom(json: Record<string, unknown> | null): string[] {
  const list = (json?.models as Array<Record<string, unknown>> | undefined) || [];
  return list
    .map((m) => String(m.modelId || m.model_id || m.displayModelId || m.display_name || ""))
    .filter(Boolean);
}
