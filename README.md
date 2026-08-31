# cursor2api

把 Cursor `InferenceService/Stream` 转成 OpenAI / Anthropic 形接口。网关**不执行工具**：客户端带 `tools[]`，模型回 `tool_calls`。

鉴权只看请求：`Authorization: Bearer <crsr_… 或 JWT>` 或 `x-api-key`。没有服务端 API key，每个人用自己的 Cursor token，互不串会话。换出的 JWT 按 token 指纹缓存在 unstorage 形 KV 里，TTL 跟 JWT `exp` 走，提前 60s 失效。

共享逻辑在 `src/lib/`：

| 入口 | 启动 |
|---|---|
| Node.js | `node src/node.ts` |
| Bun | `bun src/node.ts` |
| Deno | `deno task start` |
| Cloudflare Workers | `wrangler dev` / `wrangler deploy` |

## 启动

```bash
node src/node.ts
# 或
bun src/node.ts
# 或
deno task start
```

默认 `http://127.0.0.1:8789`。OpenAI SDK：`baseURL` = `http://127.0.0.1:8789/v1`，`apiKey` 填 Cursor Dashboard 的 `crsr_…`（或已换好的 JWT）。Node 绑 `127.0.0.1` 和 `::1`；Deno 绑 `127.0.0.1`。

可选 `PORT`。Cloudflare 可绑 `KV` 做跨 isolate 的 JWT 缓存，不绑则用内存。

## 接口

| | |
|---|---|
| `GET /health` | 存活检查 |
| `GET /v1/models` | Cursor 可用模型 |
| `POST /v1/chat/completions` | OpenAI Chat Completions（含 `stream`） |
| `POST /v1/messages` | Anthropic Messages |

客户端传什么 `model` 就原样交给 Cursor。Grok 的 `reasoning_effort`：`low` / `medium` / `high` / `xhigh`。Cursor 会丢掉 `role: system`，网关会折进第一条 user。

```bash
curl -s http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer crsr_your_key_here' \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
```
