import { randomId } from "./bytes.ts";
import type { Kv } from "./kv.ts";

export type StickySessionRow = {
  clientSessionId: string;
  updatedAt: number;
};

function envGet(name: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env?.[name]) return process.env[name];
  } catch {
    /* empty */
  }
  try {
    const deno = (globalThis as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno;
    return deno?.env.get(name);
  } catch {
    /* empty */
  }
  return undefined;
}

export function stickySessionEnabled(): boolean {
  const v = envGet("SESSION_STICKY")?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

export function stickySessionTtlSeconds(): number {
  const n = Number(envGet("SESSION_STICKY_TTL_SECONDS"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3600;
}

function conversationRole(role: unknown): string {
  return String(role || "").toLowerCase();
}

/** True when the payload looks like the first turn (one user turn, no assistant/tool yet). System/developer messages are ignored. */
export function isNewConversationMessages(messages: unknown[]): boolean {
  const conv = (messages || []).filter((m) => {
    const role = conversationRole((m as Record<string, unknown>).role);
    return role === "user" || role === "assistant" || role === "tool";
  });
  let users = 0;
  let replies = 0;
  for (const m of conv) {
    const role = conversationRole((m as Record<string, unknown>).role);
    if (role === "user") users += 1;
    else replies += 1;
  }
  return users === 1 && replies === 0;
}

function kvKey(tenant: string): string {
  return `active-session:${tenant}`;
}

export async function resolveStickyClientId(kv: Kv, tenant: string, messages: unknown[]): Promise<string> {
  const ttl = stickySessionTtlSeconds();
  const key = kvKey(tenant);

  if (isNewConversationMessages(messages)) {
    const clientSessionId = randomId();
    await kv.setItem(key, { clientSessionId, updatedAt: Date.now() } satisfies StickySessionRow, { ttl });
    return clientSessionId;
  }

  const row = await kv.getItem<StickySessionRow>(key);
  if (row?.clientSessionId) {
    await kv.setItem(key, { clientSessionId: row.clientSessionId, updatedAt: Date.now() } satisfies StickySessionRow, {
      ttl,
    });
    return row.clientSessionId;
  }

  const clientSessionId = randomId();
  await kv.setItem(key, { clientSessionId, updatedAt: Date.now() } satisfies StickySessionRow, { ttl });
  return clientSessionId;
}

export type SessionResolveSource = "explicit" | "sticky_new" | "sticky_continue" | "sticky_miss" | "random";

export async function resolveClientSessionId(
  kv: Kv,
  tenant: string,
  messages: unknown[],
  explicitId: string | undefined,
): Promise<{ clientId: string; source: SessionResolveSource }> {
  if (explicitId) {
    return { clientId: explicitId, source: "explicit" };
  }
  if (!stickySessionEnabled()) {
    return { clientId: randomId(), source: "random" };
  }
  const key = kvKey(tenant);
  const isNew = isNewConversationMessages(messages);
  if (isNew) {
    const clientId = await resolveStickyClientId(kv, tenant, messages);
    return { clientId, source: "sticky_new" };
  }
  const before = await kv.getItem<StickySessionRow>(key);
  const clientId = await resolveStickyClientId(kv, tenant, messages);
  if (before?.clientSessionId && before.clientSessionId === clientId) {
    return { clientId, source: "sticky_continue" };
  }
  return { clientId, source: "sticky_miss" };
}
