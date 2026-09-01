# cursor2api

把 Cursor `InferenceService/Stream` 转成 OpenAI / Anthropic 形接口。网关**不执行工具**：客户端带 `tools[]`，模型回 `tool_calls`。

鉴权只看请求：`Authorization: Bearer <crsr_… 或 JWT>` 或 `x-api-key`。没有服务端 API key，每个人用自己的 Cursor token，互不串会话。换出的 JWT 按 token 指纹缓存在 KV 里，**KV 条目 TTL 最长 5 分钟**（仅 JWT 换票缓存）。

## 生产环境

已部署：**`https://cursor2api.freetavily.deno.net/v1`**（推送 `main` 后由 Deno Deploy 自动发布。）

```text
baseURL  → https://cursor2api.freetavily.deno.net/v1
apiKey   → <你的 Cursor token>
```

```bash
curl -sS https://cursor2api.freetavily.deno.net/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer crsr_your_key_here' \
  -d '{"model":"composer-2.5-fast","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
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

可选 `PORT`。Cloudflare 可绑 `KV` 做跨 isolate 的 JWT 缓存；不绑则用内存。Deno 入口使用 **`Deno.openKv()`** 仅用于 JWT（`deno task start` 需 `--allow-read --allow-write`）。会话 **fingerprint 不算 KV**。

## 接口

| | |
|---|---|
| `GET /health` | 存活检查 |
| `GET /v1/models` | Cursor 可用模型（原生 route id） |
| `POST /v1/chat/completions` | OpenAI Chat Completions（含 `stream`） |
| `POST /v1/messages` | Anthropic Messages（含 `stream`） |

### 模型 id（简写）

客户端可用 **简写 id**，网关映射为 Cursor flat route（详见 **[docs/models.md](docs/models.md)**）：

| 系列 | 简写示例 | 要点 |
|------|----------|------|
| **Composer** | `composer-2.5`、`composer-2.5-fast` | Fast 为独立 route；也可用 `composer-2.5` + `fast: true` |
| **Grok** | `grok-4.6`、`grok-4.6-fast`（`4.5` 同理） | 映射为 `cursor-grok-4.6-{effort}` 或 `…-{effort}-fast` |
| **Grok effort** | `reasoning_effort` | `low` / `medium` / `high`；**`max` → `xhigh`（Fast 时为 `xhigh-fast`）**；省略时默认 `high` |

响应 JSON 的 `model` 多为客户端传入名；服务端日志中的 **`cursorRoute`** 为实际发给 Cursor 的 id。

### 消息与工具

Cursor 会丢掉 `role: system`，网关会折进 `<system>…</system>` user 消息。**带 `tools[]` 时**会拆成 `<tools-rules>`（固定 agent 约束，可缓存）与 `<tools-catalog>`（按工具名排序的稳定 schema 列表，随工具集变化），并仍传 `body.tools`；`<tools-rules>` 与 `<system>` 会各打 prompt cache 断点。不需要注入时可设 `inject_tools_prompt: false`。

`tool_choice`：`none` 不传 tools；`required` / Anthropic `any` 注入必须调工具的约束；`{type:"function",function:{name}}` 只保留该工具。`parallel_tool_calls: false` 约束本轮最多一个 tool_call。非 `function` 的 OpenAI tool（如 `web_search_preview`）以及 `provider_defined_tools` 会写入 Cursor `providerDefinedTools`。

`response_format`：`json_object` / `json_schema` 折进 `<output-format>` user 消息（Cursor 无原生 JSON mode）。`n > 1` 返回 400。`max_completion_tokens` 作为 `max_tokens` 别名。`top_p` / `stop` 写入 `modelConfig`。

### 图片 / 文件输入

`POST /v1/chat/completions` 与 `POST /v1/messages` 都把多模态 content 转成 Cursor `InferenceContentPart`（`parts.parts[]` 的 `text` / `image` / `file`）。**不能**压成纯文本。

| 客户端 | 网关 |
|--------|------|
| OpenAI `image_url` / `input_image`（data URI 或 http(s)） | `image.data` 裸 base64 + `mimeType` |
| Anthropic `{type:"image", source:{type:"base64"}}` | 同上 |
| OpenAI `file` / Anthropic `document` | `file.data` + `mediaType` + `filename` |
| `role: tool` / `tool_result` 里的图 | `experimentalContent`（文本仍在 `result`） |

http(s) 由网关拉取（最大 10MB）。非法 URL 返回 **400**。`image_url.detail` 无对应字段，忽略。上游若回 `image_descriptions`，会出现在响应 JSON（流式在最后一包）。

```bash
curl -sS "$BASE/chat/completions" -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" \
  -d '{
    "model": "composer-2.5-fast",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "这张图里有什么？"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}}
      ]
    }]
  }'
```

### Composer Max

`requestedModel.maxMode`（与 Fast route 独立）。任选：`max` / `max_mode` / `maxMode`、`metadata.max`、`extra_body.max_mode`。

### 未提供的 OpenAI 表面

Cursor Inference **没有** embeddings / TTS / STT / Images API / Responses API。对应路径返回 **501**（生图像素仍需 Agent 执行 `generate_image` tool_call，见下文实验脚本）。`n`、`seed`、`logprobs`、penalty 字段无 proto 对应：`n>1` 拒绝，其余忽略。

### 多轮会话（内容指纹，默认无 KV）

客户端每轮带**全量** `messages`；网关 pipeline 后发往上游，**`conversationId` / `x-session-id` = `tenant:session_fp`**（**fg 变 = 新 thread**）。公式见 **[docs/canonical-session-fingerprint.md](docs/canonical-session-fingerprint.md)**。

| `SESSION_MODE` | 行为 |
|----------------|------|
| （未设置） | **fingerprint**（默认） |
| `fingerprint` / `sticky`（遗留名） | 同上 |
| `random` | 调试：不算 fg，不 `messagesPipelined` |

集成验证：`bash scripts/verify-fingerprint-session.sh`

### 生图（实验）

`src/lib/cursor_generate_image.ts` + `src/lib/cursor_credentials.ts`：优先 `CURSOR_API_KEY`（`crsr_…`），否则读本机 Cursor `state.vscdb` JWT。可稳定请求 `generate_image` tool_call（默认 `grok-4.6`，经网关映射为 `cursor-grok-4.6-high`）；像素数据需 IDE Agent 或带 `bcId` 的 Background Composer artifact 下载。

```bash
CURSOR_API_KEY=crsr_xxx node --experimental-strip-types src/lib/cursor_generate_image.ts "a red circle icon"
```

## 测试

```bash
npm test
deno task test   # 或 npm run test:deno — handler 集成（mock Cursor，无需 API key）
```

模型映射、图片/文件与 tool_choice 用例见 `src/lib/inference.model.test.ts`、`src/lib/inference.compat.test.ts`；流式 SSE 见 `src/lib/connect_stream.test.ts`。
