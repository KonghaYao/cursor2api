/**
 * 解析 Cursor access token：优先 API key（crsr_…）换 JWT，否则读本机 Cursor 登录态。
 */
import { exchangeApiKey, incomingCredential, type GatewayCtx } from "./auth.ts";
import { getAccessToken } from "./auth.ts";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type CursorCredentialSource = "api_key" | "local_session" | "request_header";

export type ResolvedCursorAccess = {
  accessToken: string;
  source: CursorCredentialSource;
};

function readLocalAccessTokenFromSqlite(): string | undefined {
  const candidates = [
    join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
    join(homedir(), ".config/Cursor/User/globalStorage/state.vscdb"),
  ];
  for (const db of candidates) {
    if (!existsSync(db)) continue;
    try {
      const raw = execSync(
        `sqlite3 'file:${db.replace(/'/g, "''")}?mode=ro' "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1;"`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      const token = raw.replace(/^"|"$/g, "");
      if (token.length > 20) return token;
    } catch {
      /* locked or missing */
    }
  }
  return undefined;
}

function isApiKeyCredential(raw: string): boolean {
  return raw.trim().startsWith("crsr_");
}

/**
 * @param preferApiKey 默认 true：同时存在 env api key 与本地 JWT 时用 api key
 */
export async function resolveCursorAccessToken(opts?: {
  apiKey?: string;
  preferApiKey?: boolean;
}): Promise<ResolvedCursorAccess> {
  const preferApiKey = opts?.preferApiKey !== false;
  const fromEnv = (opts?.apiKey || process.env.CURSOR_API_KEY || process.env.CRSR_API_KEY || "").trim();
  const local = readLocalAccessTokenFromSqlite();

  if (preferApiKey && fromEnv) {
    const { accessToken } = await exchangeApiKey(fromEnv);
    return { accessToken, source: "api_key" };
  }
  if (local) return { accessToken: local, source: "local_session" };
  if (fromEnv) {
    const { accessToken } = await exchangeApiKey(fromEnv);
    return { accessToken, source: "api_key" };
  }
  throw new Error(
    "No Cursor credential: set CURSOR_API_KEY (crsr_…) or log in to Cursor desktop app",
  );
}

/** 与网关相同的请求头鉴权（用于 handler 内调用生图） */
export async function resolveCursorAccessFromRequest(
  ctx: GatewayCtx,
  headers: Headers,
  opts?: { preferApiKey?: boolean },
): Promise<ResolvedCursorAccess> {
  const incoming = incomingCredential(headers);
  if (incoming) {
    if (isApiKeyCredential(incoming) && opts?.preferApiKey !== false) {
      const { accessToken } = await exchangeApiKey(incoming);
      return { accessToken, source: "api_key" };
    }
    const { accessToken } = await getAccessToken(ctx, headers);
    return {
      accessToken,
      source: incoming.startsWith("eyJ") ? "local_session" : "request_header",
    };
  }
  return resolveCursorAccessToken(opts);
}
