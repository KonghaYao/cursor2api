# cursor2api

把 Cursor `InferenceService/Stream` 转成 OpenAI / Anthropic 形接口。网关**不执行工具**：客户端带 `tools[]`，模型回 `tool_calls`。

鉴权只看请求：`Authorization: Bearer <crsr_… 或 JWT>` 或 `x-api-key`。没有服务端 API key，每个人用自己的 Cursor token，互不串会话。换出的 JWT 按 token 指纹缓存在 KV 里，**KV 条目 TTL 最长 5 分钟**（含 JWT 缓存与粘性会话，到期后重新换票或续绑会话）。

## 生产环境

已部署：**`https://cursor2api.freetavily.deno.net/v1`**

客户端只需配置 `baseURL` 和你的 Cursor API key（`crsr_…` 或已换好的 JWT），无需自建网关。

```text
baseURL  → https://cursor2api.freetavily.deno.net/v1
apiKey   → <你的 Cursor token>
```

```bash
curl -s https://cursor2api.freetavily.deno.net/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer crsr_your_key_here' \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
```

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

可选 `PORT`。Cloudflare 可绑 `KV` 做跨 isolate 的 JWT / 粘性会话；不绑则用内存。Deno 入口使用 **`Deno.openKv()`** 本地持久化（`deno task start` 需 `--allow-read --allow-write`）。

## 接口

| | |
|---|---|
| `GET /health` | 存活检查 |
| `GET /v1/models` | Cursor 可用模型 |
| `POST /v1/chat/completions` | OpenAI Chat Completions（含 `stream`） |
| `POST /v1/messages` | Anthropic Messages |

客户端传什么 `model` 就原样交给 Cursor。Grok 的 `reasoning_effort`：`low` / `medium` / `high` / `xhigh`。Cursor 会丢掉 `role: system`，网关会折进 `<system>…</system>` user 消息；**带 `tools[]` 时**会拆成 `<tools-rules>`（固定 agent 约束，可缓存）与 `<tools-catalog>`（按工具名排序的稳定 schema 列表，随工具集变化），并仍传 `body.tools`；`<tools-rules>` 与 `<system>` 会各打 prompt cache 断点。不需要注入时可设 `inject_tools_prompt: false`。

### 多轮会话（无 client session id）

客户端**不传** `x-session-id` / `conversation_id` 且每轮带**全量** `messages` 时，网关按 API key 指纹在 KV 里做**粘性会话**（默认开启）：

- 判定「新会话」：`messages` 里仅有 **1 条 `user`**（忽略 `system` / `developer`）→ 生成新 `conversation_id`
- 否则复用该 key 下最近一次会话 id（**TTL 5 分钟**，与全局 KV 上限一致）
- 显式传入 `conversation_id` 或 `x-session-id` 时优先使用；`SESSION_STICKY=0` 可关闭（恢复每请求随机 id）

同一 API key 下**并行多条对话**且都不传 id 时会共用一条 Cursor 会话；生产多实例请绑共享 KV（见 Cloudflare `KV`）。响应头 `x-session-id` 与 JSON 里的 `conversation_id` / `session_id` 仍会返回，便于调试。

### 生图（实验）

`src/lib/cursor_generate_image.ts` + `src/lib/cursor_credentials.ts`：优先 `CURSOR_API_KEY`（`crsr_…`），否则读本机 Cursor `state.vscdb` JWT。可稳定请求 `generate_image` tool_call（默认 `grok-4.6`）；像素数据需 IDE Agent 或带 `bcId` 的 Background Composer artifact 下载。

```bash
CURSOR_API_KEY=crsr_xxx node --experimental-strip-types src/lib/cursor_generate_image.ts "a red circle icon"
```

```bash
curl -s http://127.0.0.1:8789/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer crsr_your_key_here' \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
```
