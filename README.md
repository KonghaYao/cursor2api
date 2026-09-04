# cursor2api

Cursor `InferenceService/Stream` 的 OpenAI Chat Completions 与 Anthropic Messages 兼容网关。

## API 配置

生产地址：`https://cursor2api.freetavily.deno.net`

使用 Cursor Dashboard 提供的 `crsr_…` API key。生产客户端不应传已换取的 JWT，也不要在配置文件或代码中保存明文凭证。

### OpenAI-compatible

```text
baseURL = https://cursor2api.freetavily.deno.net/v1
apiKey  = <Cursor crsr_… API key>
model   = composer-2.5-fast
```

- Chat Completions：`POST /v1/chat/completions`
- Models：`GET /v1/models`
- 鉴权：`Authorization: Bearer <key>`，也接受 `x-api-key`
- 流式：请求体设置 `stream: true`

### Anthropic-compatible

```text
baseURL = https://cursor2api.freetavily.deno.net
apiKey  = <Cursor crsr_… API key>
model   = composer-2.5-fast
```

- Messages：`POST /v1/messages`，别名为 `POST /messages`
- Models：`GET /v1/models`
- 鉴权：`x-api-key: <key>`，也接受 `Authorization: Bearer <key>`
- 协议版本：接受 `anthropic-version`
- 流式：请求体设置 `stream: true`
- 必填字段：`model`、正整数 `max_tokens`、`messages`
- 请求带 `anthropic-version` 时，Models 端点返回 Anthropic Models 分页格式

Anthropic SDK 通常会自动追加 `/v1/messages`，因此其 `baseURL` 使用站点根地址，不要重复添加 `/v1`。如果具体客户端要求填写完整 API base，请遵循该客户端的 URL 拼接规则。

## 模型

推荐默认使用 `composer-2.5-fast`。

- `composer-2.5`：Composer 标准 route
- `composer-2.5-fast`：Composer Fast route
- `grok-4.6`：无 tools 时使用标准 route；带 tools 时自动升级 Fast route
- `grok-4.6-fast`：Grok Fast route
- `gpt-5.6-luna` 等 Other Models：未知 id 原样透传；可能不出现在 `/v1/models`，是否可用取决于账号额度和地区

Cursor 的非 Fast Grok inference route 不支持 tool calling。`grok-4.6` 带 tools 时会自动升级到 `cursor-grok-4.6-high-fast`，`fast: false` 不能关闭该升级。

## 协议兼容性

OpenAI `/v1/chat/completions`：

- 支持文本消息与 SSE 流式输出
- 支持 `tools[].function`、`tool_choice` 和 `parallel_tool_calls`
- 工具调用通过 `message.tool_calls` 或 `delta.tool_calls` 返回
- 工具结果使用 `role: "tool"` 和 `tool_call_id`
- 支持 `image_url`、`input_image` 和文件
- 支持 `response_format`
- 明文 thinking 通过 `reasoning_content` 返回
- `prompt_tokens` 是总输入，cached tokens 是其中的子集
- 流结束标记为 `[DONE]`

Anthropic `/v1/messages`：

- 支持 messages 和顶层 `system`
- 支持标准 `message_*`、`content_block_*` SSE events
- 支持 custom tools、`tool_choice` 和 `disable_parallel_tool_use`
- 工具调用使用 `tool_use` block，工具结果使用 `tool_result`
- 支持 `image` 和 `document` blocks
- 支持 `output_config.format`
- 只有同时取得明文 thinking 和 signature 时才输出 thinking block
- 非流式错误使用 `{type:"error",error:{…}}`
- 流式错误使用 `event: error`，错误后不发送成功的 `message_stop`

网关不执行工具。客户端收到 tool call 后必须执行工具，并把 tool result 放入下一次请求。

流式 tool arguments 会先在网关缓冲：

- OpenAI 在流结束前发送一个完整 `delta.tool_calls`
- Anthropic 发送 `tool_use` start、一个完整 `input_json_delta` 和 block stop

## Cache 与会话兼容

客户端每轮发送完整 messages。网关不读取、不信任或返回客户端提供的 session/conversation ID，包括：

- `x-session-id`
- `x-cursor-session-id`
- `session_id` / `sessionId`
- `conversation_id` / `conversationId`

网关只在内部根据 model、effort、tools、system 和消息锚点计算 `session_fp`，并以 `tenant:session_fp` 作为 Cursor upstream 的 `conversationId`、`conversationGroupId` 和 `x-session-id`，用于维持 Cursor prompt cache。

API 输入中的 `cache_control` 不控制 Cursor cache breakpoint，也不会原样透传；缓存策略由网关决定。

Anthropic cache usage 的三个输入桶互斥：

```text
总输入 = input_tokens
       + cache_creation_input_tokens
       + cache_read_input_tokens

cache hit rate = cache_read_input_tokens / 总输入
```

OpenAI 的 `prompt_tokens` 已是总输入，不要再把 cached tokens 重复加入总量。

## 明确限制

以下能力无法可靠映射到 Cursor Inference，因此拒绝或不提供：

- Anthropic server tools、server-tool results 和 citations
- Anthropic `top_k`
- `container`、`context_management`、`service_tier`
- `max_tokens: 0` cache prewarming
- 精确 thinking token budget
- 可验证的真实 stop sequence
- `n > 1`
- embeddings、audio、Images API、Responses API

`response_format` 和 `output_config.format` 通过提示约束实现，不是 Cursor 服务端强制 JSON Schema。Grok signature-only 的加密 thinking 不会作为明文 reasoning 输出。

## 关键更新与事故

- **2026-09-01 — Prompt cache 事故**：上游 `conversationId` 曾被改成每请求随机值，导致长会话 Cache Read 几乎为 0。现已恢复为稳定的内部 `tenant:session_fp`；禁止再次随机化。
- **2026-09-02 — 鉴权缓存**：`crsr_…` 换取 JWT 改为进程内 L1、KV L2，再访问 Cursor exchange；会话内容不写 KV。
- **2026-09-03 — Thinking 与 Grok**：只输出明文 thinking；Grok 加密 signature 不泄露。Grok 带 tools 时自动升级 Fast route。
- **2026-09-04 — Anthropic 兼容**：补齐 system、tool use/result、流式错误、Models 响应、usage 和请求校验。
- **2026-09-04 — Session 边界**：不再读取或返回客户端 session/conversation ID，只保留网关到 Cursor 的内部稳定 ID。
- **2026-09-04 — Cache usage 修复**：Anthropic `input_tokens` 改为未缓存输入，避免与 cache read/write 重复计数导致客户端命中率显示错误。
