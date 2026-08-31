/**
 * Cursor IDE 风格请求头（checksum / session），用于 StreamUnifiedChatWithTools 等。
 */
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, release, arch } from "node:os";
import { join } from "node:path";
import { CURSOR_BASE } from "./auth.ts";

export type IdeClientContext = {
  accessToken: string;
  sessionId: string;
  clientKey: string;
  checksum: string;
  clientVersion: string;
};

function sha256Hex(input: string, salt = ""): string {
  return createHash("sha256").update(input + salt, "utf8").digest("hex");
}

/** DNS namespace UUID v5，与 eisbaw cursor_proper_protobuf 一致 */
export function cursorSessionId(accessToken: string): string {
  const hash = createHash("sha1");
  const namespace = Buffer.from("6ba7b810-9dad-11d1-80b4-00c04fd430c8".replace(/-/g, ""), "hex");
  hash.update(namespace);
  hash.update(accessToken, "utf8");
  const digest = hash.digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function readServiceMachineId(): string | undefined {
  const db = join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  if (!existsSync(db)) return undefined;
  try {
    const row = execSync(
      `sqlite3 "file:${db}?mode=ro" "SELECT value FROM ItemTable WHERE key = 'storage.serviceMachineId' LIMIT 1;"`,
      { encoding: "utf8" },
    ).trim();
    return row || undefined;
  } catch {
    return undefined;
  }
}

/** Jyh 风格 checksum（eisbaw TASK-18） */
export function generateCursorChecksum(accessToken: string, machineId?: string): string {
  const mid = machineId || readServiceMachineId() || sha256Hex(accessToken, "machineId");
  const timestamp = Math.floor(Date.now() / 1_000_000);
  const byteArray = new Uint8Array([
    (timestamp >> 40) & 255,
    (timestamp >> 32) & 255,
    (timestamp >> 24) & 255,
    (timestamp >> 16) & 255,
    (timestamp >> 8) & 255,
    timestamp & 255,
  ]);
  let t = 165;
  for (let i = 0; i < byteArray.length; i++) {
    byteArray[i] = ((byteArray[i]! ^ t) + (i % 256)) & 255;
    t = byteArray[i]!;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let i = 0; i < byteArray.length; i += 3) {
    const a = byteArray[i]!;
    const b = byteArray[i + 1] ?? 0;
    const c = byteArray[i + 2] ?? 0;
    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < byteArray.length) encoded += alphabet[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < byteArray.length) encoded += alphabet[c & 63];
  }
  return `${encoded}${mid}`;
}

export function detectInstalledCursorVersion(): string {
  const paths = [
    "/Applications/Cursor.app/Contents/Resources/app/product.json",
    join(homedir(), "Applications/Cursor.app/Contents/Resources/app/product.json"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (j.version) return j.version;
    } catch {
      /* ignore */
    }
  }
  return process.env.CURSOR_CLIENT_VERSION || "3.18.9";
}

function normalizeOs(): string {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "win32") return "win32";
  return "linux";
}

function normalizeArch(): string {
  const a = arch();
  if (a === "x64") return "x64";
  if (a === "arm64") return "arm64";
  return a;
}

export function buildIdeClientContext(accessToken: string): IdeClientContext {
  const sessionId = cursorSessionId(accessToken);
  const clientKey = sha256Hex(accessToken, "clientKey");
  const checksum = generateCursorChecksum(accessToken);
  return {
    accessToken,
    sessionId,
    clientKey,
    checksum,
    clientVersion: detectInstalledCursorVersion(),
  };
}

export function ideConnectHeaders(
  ctx: IdeClientContext,
  extra?: Record<string, string>,
): Record<string, string> {
  const requestId = randomUUID();
  const host = new URL(CURSOR_BASE).host;
  return {
    authorization: `Bearer ${ctx.accessToken}`,
    "connect-protocol-version": "1",
    "user-agent": "connect-es/1.6.1",
    "x-amzn-trace-id": `Root=${requestId}`,
    "x-client-key": ctx.clientKey,
    "x-cursor-checksum": ctx.checksum,
    "x-cursor-client-version": ctx.clientVersion,
    "x-cursor-client-type": "ide",
    "x-cursor-client-os": normalizeOs(),
    "x-cursor-client-arch": normalizeArch(),
    "x-cursor-client-os-version": release() || "unknown",
    "x-cursor-client-device-type": "desktop",
    "x-cursor-config-version": randomUUID(),
    "x-cursor-timezone": process.env.TZ || "Asia/Shanghai",
    "x-ghost-mode": "false",
    "x-new-onboarding-completed": "false",
    "x-request-id": requestId,
    "x-session-id": ctx.sessionId,
    host,
    ...extra,
  };
}
