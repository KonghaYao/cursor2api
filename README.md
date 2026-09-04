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
| **2026-09-03** | Thinking / Fast | `a81208c` | 明文 `reasoning_content`；Grok 密文不下发。`grok-4.6` 无 tools 走标准档；**有 tools 必须 Fast（2 倍价），`fast:false` 盖不住** |

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

### OpenAI / Anthropic 端点兼容性

两个端点共用同一套 Cursor Inference pipeline、稳定 `session_fp`、模型路由、tools、图片/文件、thinking、usage 和上游错误处理。Cursor 能表达的能力保持对等，但响应格式遵循各自协议，不应混用客户端解析器。

| 能力 | OpenAI `/v1/chat/completions` | Anthropic `/v1/messages` |
|------|--------------------------------|--------------------------|
| 鉴权 | `Authorization: Bearer …`（也接受 `x-api-key`） | `x-api-key` 或 `Authorization: Bearer …`；接受 `anthropic-version` |
| 文本流 | `data:` chunk，结束为 `[DONE]` | `message_start` → `content_block_*` → `message_delta` → `message_stop` |
| 工具定义 | `tools[].function`；非 function tool 转 `providerDefinedTools` | custom tool 的 `name` / `input_schema`；`web_search_*` 等 server tool 转 `providerDefinedTools` |
| 工具结果 | `role: "tool"` + `tool_call_id` | user content 中的 `tool_result` + `tool_use_id` |
| 工具响应 | `message.tool_calls` / `delta.tool_calls` | `tool_use` content block，`stop_reason: "tool_use"` |
| Structured output | `response_format` | `output_config.format`；两者都通过 `<output-format>` 提示约束，非服务端强制 JSON schema |
| Thinking | `reasoning_content` | `thinking` content block；密文 signature 不对外泄露 |
| Cache usage | `prompt_tokens_details.cached_tokens`、`cache_write_tokens` | `cache_read_input_tokens`、`cache_creation_input_tokens` |
| 非流式错误 | HTTP 状态 + `{error:{…}}` | HTTP 状态 + `{type:"error",error:{…}}` |
| 流式错误 | 带 `error` 的 SSE data | `event: error`；错误后不伪造成功的 `message_stop` |

此前 Anthropic 端点存在几处不对等问题：Connect 错误会被包装成 HTTP 200 空消息、流式错误没有 `error` event、server tools 被误当 custom tools、`output_config.format` / `disable_parallel_tool_use` 未生效，以及同一 user message 内 `text → tool_result → text` 会被重排。现已统一修复，并由 Node 单测和 Deno handler 集成测试覆盖。

**协议边界**：Cursor Agent 不接受增量 tool 参数分片，所以两个端点都先缓冲上游 `toolCallPart`，在流结束前一次性发出完整工具调用。OpenAI 是一条完整 `delta.tool_calls`；Anthropic 是完整 `tool_use` block，而不是逐段 `input_json_delta`。文本和明文 thinking 仍实时增量下发。

### 模型 id（简写）

客户端可用 **简写 id**，网关映射为 Cursor flat route（详见 **[docs/models.md](docs/models.md)**）：

| 系列 | 简写示例 | 要点 |
|------|----------|------|
| **Composer** | `composer-2.5`、`composer-2.5-fast` | Fast 为独立 route；也可用 `composer-2.5` + `fast: true` |
| **Grok** | `grok-4.6`、`grok-4.6-fast`（`4.5` 同理） | 映射为 `cursor-grok-4.6-{effort}` 或 `…-{effort}-fast`；**无 tools 时 `grok-4.6` 不是 fast** |
| **Grok effort** | `reasoning_effort` | `low` / `medium` / `high`；**`max` → `xhigh`（Fast 时为 `xhigh-fast`）**；省略时默认 `high` |

响应 JSON 的 `model` 多为客户端传入名；服务端日志中的 **`cursorRoute`** 为实际发给 Cursor 的 id。

**`grok-4.6` 不会默认走 fast。** 只有下面几种情况才会变成 `-fast` route：

| 请求 | 实际上游 route |
|------|----------------|
| `grok-4.6`（无 `tools`） | `cursor-grok-4.6-high` |
| `grok-4.6-fast` 或 `fast: true` | `cursor-grok-4.6-high-fast` |
| `grok-4.6` **且带 `tools[]`** | `cursor-grok-4.6-high-fast`（自动升级） |

Cursor 的非 fast Grok route **不支持 tool calling**（上游 `ERROR_PROVIDER_ERROR` / 422）。Agent 几乎必带 tools，所以线上常看到「写了 `grok-4.6` 实际是 fast」——这是有意的，不是把标准档误映射成 fast。不要去掉 `upgradeGrokRouteForTools`，否则 Grok + tools 会无返回。

**`fast: false` 盖不住自动升级，也不能半价用工具。** 网关只认 `fast: true` / `grok-4.6-fast`；`fast: false` 不会关掉 `upgradeGrokRouteForTools`。硬打 `cursor-grok-4.6-high` + `tools[]` 实测无正文、无 `tool_calls`。官方 IDE 关 Fast 仍能用工具，走的是 Agent harness，不是本网关转发的 `InferenceService` + `tools[]`。

工具调用必须留着时，Grok **只能走 Fast**（2 倍价）。要省钱：纯聊天不带 `tools`，或换 Composer。

Cursor 官方标价（每百万 tokens，[Grok 4.6](https://cursor.com/docs/models/grok-4-6) / [定价表](https://cursor.com/docs/models-and-pricing)）：

| | Input | Cache Read | Output |
|---|---|---|---|
| **Grok 4.6** | $2 | $0.50 | $6 |
| **Grok 4.6 Fast** | $4 | $1 | $12 |
| **Grok 4.5** | $2 | $0.50 | $6 |
| **Grok 4.5 Fast** | $4 | $1 | $18 |
| **Composer 2.5** | $0.50 | $0.20 | $2.50 |
| **Composer 2.5 Fast** | $3 | $0.50 | $15 |

Grok 4.6 Fast = 全项 2 倍；4.5 Fast 的 output 是 3 倍。都进 **Cursor Models** 池。Pro 及以上 Fast 是默认 speed；产品名仍是「Grok 4.6」，Fast 是开关不是另一个对外 id。

### Thinking / `reasoning_content`

OpenAI 表面只出**明文** thinking：

- 流式：`choices[0].delta.reasoning_content`
- 非流式：`choices[0].message.reasoning_content`
- 历史回传：`reasoning` / `reasoning_content` → Cursor `reasoningParts`（仅明文）

Composer 的 `thinkingPart.text` 是明文，会原样转出。Grok（`grok-4.6` / `grok-4.6-fast`）上游只给空 `text` + 加密 `signature`（`InferenceReasoningPart` 红acted 形态）。**密文 / signature 不写入 `reasoning_content`**，也不映射成 `reasoning` / `reasoning_signature`。客户端因此看不到 Grok thinking，直到 Cursor 开始下发明文。网关解不了这段密文。

### 消息与工具

Cursor 会丢掉 `role: system`，网关会折进 `<system>…</system>` user 消息。**带 `tools[]` 时**会拆成 `<tools-rules>`（固定 agent 约束，可缓存）与 `<tools-catalog>`（按工具名排序的稳定 schema 列表，随工具集变化），并仍传 `body.tools`；`<tools-rules>` 与 `<system>` 会各打 prompt cache 断点。不需要注入时可设 `inject_tools_prompt: false`。

`tool_choice`：`none` 不传 tools；`required` / Anthropic `any` 注入必须调工具的约束；OpenAI `{type:"function",function:{name}}` / Anthropic `{type:"tool",name}` 只保留指定工具。OpenAI `parallel_tool_calls: false` 或 Anthropic `tool_choice.disable_parallel_tool_use: true` 约束本轮最多一个 tool call。非 `function` 的 OpenAI tool（如 `web_search_preview`）、Anthropic server tool（如 `web_search_*`）以及 `provider_defined_tools` 会写入 Cursor `providerDefinedTools`。

OpenAI `response_format` 与 Anthropic `output_config.format`：`json_object` / `json_schema` 折进 `<output-format>` user 消息（Cursor 无原生 JSON mode）。`n > 1` 返回 400。`max_completion_tokens` 作为 `max_tokens` 别名。`top_p` / `stop`（Anthropic 为 `stop_sequences`）写入 `modelConfig`。

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
