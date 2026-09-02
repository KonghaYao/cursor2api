# cursor2api

把 Cursor `InferenceService/Stream` 转成 OpenAI / Anthropic 形接口。网关**不执行工具**：客户端带 `tools[]`，模型回 `tool_calls`。

鉴权只看请求：`Authorization: Bearer <crsr_…>` 或 `x-api-key`（**生产约定：客户端只传 Cursor Dashboard 的 API key**，不传已换好的 JWT）。没有服务端共享 API key，每人一把，互不串会话。网关对 `crsr_…` 调 `exchange_user_api_key` 换 JWT：**进程内 L1** → **KV L2**（跨 isolate，TTL ≤5min），同 key 在 TTL 内不重复换票。若有人直接传 `eyJ…` JWT（自测/脚本），网关**不读写 KV**，原样作 Bearer。会话 **fingerprint 不算 KV**。

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

## 技术迭代与事故时间线

按 `git log` 归纳（详因与约束见 **[CLAUDE.md](CLAUDE.md)**）。

| 日期 | 主题 | 代表 commit | 摘要 |
|------|------|-------------|------|
| **2026-08-31** | 网关雏形 | `4475a90` | OpenAI/Anthropic → `InferenceService/Stream`；客户端执行 `tool_calls` |
| | 多轮与工具 | `3b08cb2` → `95e2841` | 租户粘性会话；`<tools-rules>` / `<tools-catalog>` 与 cache 断点 |
| | 运行时 | `461d776` | Deno `openKv`；JWT 换票 KV **TTL ≤5min**（仅鉴权，非会话） |
| | 模型 | `0a8fc5c` | Composer/Grok 简写 → Cursor flat route |
| | 流式 | `d85819d` → `42f8e85` | 真 SSE；**`stream:true` 时 tool_calls 须在流末一次性下发**（Agent 协议） |
| | Grok / 多模态 | `5ad529b` → `df8c1ce` | Grok `max_tokens` 下限；带 tools 时非 fast route 升 `-fast` |
| | 协议补全 | `27023de` → `997a0ec` | `image_url` → `InferenceImagePart`；OpenAI/Anthropic 字段映射 |
| **2026-09-01** | 会话指纹 | `41e7376` → `6dc1abc` | 默认 `session_fp`；KV 只存 canon 哈希（仍易与无状态目标冲突） |
| | **事故** | `0ccb04b` | 去 KV canon 时误用 **每轮 random `conversationId`** → Team Usage **连续 15～50 枪 Cache Read≈0** |
| | **修复** | `22376ac` | `conversationId` / `x-session-id` = **`tenant:session_fp`**，恢复 prompt cache |
| | 文档 | `b8ddef5` / `8523c65` | 事故与两次发版窗口记入 CLAUDE |
| **2026-09-02** | 鉴权成本 | `b5de214` | `crsr_`：**L1 → KV → exchange**；生产不传 JWT；**不动会话/cache** |
| | 可观测 | `scripts/analyze_team_usage.py` | Team Usage CSV → 命中率/冷启动/异常簇 HTML（方法见 CLAUDE） |

**事故一句话**：9/1 晚把「无状态」理解成「每轮新 conversation id」，Cursor 侧 prompt cache 绑稳定 id，导致长会话几乎 **0% Cache Read**；`22376ac` 后用 fingerprint 当 id，9/2 用量全局命中约 **94%**（见 Team Usage 分析）。

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

可选 `PORT`。Cloudflare 可绑 `KV` 做 **crsr_ 换票** 的 L2（不绑则仅 isolate 内 L1 + 内存 KV）。Deno 入口 `Deno.openKv()` 作 L2（`deno task start` 需 `--allow-read --allow-write`）。

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

客户端每轮带**全量** `messages`；网关 pipeline 后发往上游。**`session_fp` 就是 Cursor conversation id**：`conversationId` / `x-session-id` = `tenant:session_fp`（**fg 变 = 新 thread**）。公式见 **[docs/canonical-session-fingerprint.md](docs/canonical-session-fingerprint.md)**。

**2026-09-01 大 bug**：`0ccb04b` 曾把上游 id 做成每轮 `randomId()`，Agent 多轮 **Cache Read 全 0**。`22376ac` 起必须用 `session_fp`，禁止 fingerprint 路径随机 id。详见 `CLAUDE.md`。

| `SESSION_MODE` | 行为 |
|----------------|------|
| （未设置） | **fingerprint**（默认） |
| `fingerprint` / `sticky`（遗留名） | 同上 |
| `random` | 调试：随机 id，**预期无 prompt cache** |

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
