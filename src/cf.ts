/**
 * Cloudflare Workers entry.
 *
 *   wrangler kv namespace create TOKEN_CACHE   # optional, multi-isolate JWT cache
 *   wrangler dev / wrangler deploy
 *
 * Cursor API keys come from each request (Authorization / x-api-key), not Worker secrets.
 */

import { createStorage } from "unstorage";
import cloudflareKVBindingDriver from "unstorage/drivers/cloudflare-kv-binding";
import { handleGatewayRequest } from "./lib/handler.ts";
import { createMemoryKv, type Kv } from "./lib/kv.ts";

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export type CfEnv = {
  KV?: KVNamespace;
};

function kvFor(env: CfEnv): Kv {
  if (!env.KV) return createMemoryKv();
  const storage = createStorage({ driver: cloudflareKVBindingDriver({ binding: env.KV }) });
  return {
    getItem: async (key) => (await storage.getItem(key)) as never,
    setItem: async (key, value, opts) => {
      await storage.setItem(key, value as never, opts);
    },
    removeItem: async (key) => {
      await storage.removeItem(key);
    },
  };
}

export default {
  async fetch(request: Request, env: CfEnv): Promise<Response> {
    return handleGatewayRequest(request, { kv: kvFor(env) });
  },
};
