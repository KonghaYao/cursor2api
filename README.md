# cursor2api

Cursor **AgentService/Run** 的 OpenAI Chat Completions 与 Anthropic Messages 兼容网关。

**2026-09-09 起**：Dashboard `crsr_` 打 `InferenceService/Stream` 会 `ERROR_NOT_LOGGED_IN`（换票 / `GetUsableModels` 仍可能 200）。聊天不再走 Inference，也不走 Cloud Agents VM，一律 `POST https://api2.cursor.sh/agent.v1.AgentService/Run` + 进程内 customTools。

## API 配置

生产地址：`https://cursor2api.freetavily.deno.net`

使用 Cursor Dashboard 提供的 `crsr_…` API key。生产客户端不应传已换取的 JWT，也不要在配置文件或代码中保存明文凭证。

### OpenAI-compatible

```text
baseURL = https://cursor2api.freetavily.deno.net/v1
apiKey  = <Cursor crsr_… API key>
model   = composer-2.5
```

- Chat Completions：`POST /v1/chat/completions`
- Models：`GET /v1/models`（上游 `https://api.cursor.com/v1/models`）
- 鉴权：`Authorization: Bearer <key>`，也接受 `x-api-key`
- 流式：请求体设置 `stream: true`
- 带 tools：**必须**稳定的 `x-session-id`（或 `conversation_id`），用于 park `execute()`

### Anthropic-compatible

```text
baseURL = https://cursor2api.freetavily.deno.net
apiKey  = <Cursor crsr_… API key>
model   = composer-2.5
```

- Messages：`POST /v1/messages`，别名为 `POST /messages`
- Models：`GET /v1/models`
- 鉴权：`x-api-key: <key>`，也接受 `Authorization: Bearer <key>`
- 协议版本：接受 `anthropic-version`
- 流式：请求体设置 `stream: true`
- 必填字段：`model`、正整数 `max_tokens`、`messages`
- 请求带 `anthropic-version` 时，Models 端点返回 Anthropic Models 分页格式

Anthropic SDK 通常会自动追加 `/v1/messages`，因此其 `baseURL` 使用站点根地址，不要重复添加 `/v1`。

## 模型

推荐默认使用 `composer-2.5`，成本低于 Fast route；只有明确需要更低延迟时再使用 `composer-2.5-fast`。

- `composer-2.5`：Composer 标准档
- `composer-2.5-fast`：Composer Fast
- `grok-4.6` / `grok-4.6-fast`：AgentService 会去掉末尾 `-fast` 再交给上游；带 tools 时请用 Fast
- `gpt-5.6-luna` 等 Other Models：`/v1/models` 往往不列出；能否打通取决于账号额度与地区，不是网关丢了 id

## 协议兼容性（2026-09-09 后）

本表面仍是 OpenAI / Anthropic HTTP。上游是 Agent 循环，不是 Inference Chat Completions。

OpenAI `/v1/chat/completions`：

- 支持文本消息与 SSE 流式输出
- 支持 `tools[].function`、`tool_choice` 和 `parallel_tool_calls`
- 工具调用通过 `message.tool_calls` 或 **一条完整** `delta.tool_calls` 返回（Cursor Agent 不接受增量分片）
- 工具结果使用 `role: "tool"` 和 `tool_call_id`；网关 **park** `customTools.execute()`，等客户端回灌后再继续同一条 Agent 流
- `system` / `developer` 会折进当轮 user 文本（`<system>…</system>`）；**不要**指望上游 `customSystemPrompt`（会被当成 CLI `--system-prompt` 拒掉）
- 流结束标记为 `[DONE]`

Anthropic `/v1/messages`：

- 支持 messages 和顶层 `system`（同样折进 user 文本）
- 支持标准 `message_*`、`content_block_*` SSE events
- 支持 custom tools、`tool_choice` 和 `disable_parallel_tool_use`
- 工具调用使用 `tool_use` block，工具结果使用 `tool_result`
- 非流式错误使用 `{type:"error",error:{…}}`
- 流式错误使用 `event: error`

网关不执行客户端工具。收到 tool call 后必须在本地执行，并把 result 放入下一次请求。`POST /mcp` 为 **404**（不是 HTTP MCP，Cloud VM 不会回调本网关）。

内置 Agent 工具（shell / edit / grep / task / webSearch）保持关闭。请求头只允许 MCP 家族，客户端 function tools 映射为合成 MCP `custom-user-tools`。

## 会话与 cache

带 tools 的多轮 **必须** 稳定 `x-session-id`（`SESSION_MODE=random` 无法 park）。同一进程内，相同 session 会 `follow` 同一个 in-memory agent，并把 AgentService `conversationState` 送回上游。

与 9/1 之后的 Inference 路径不同：

| | Inference（已对 `crsr_` 失效） | 现在 AgentService |
|--|--|--|
| 上游会话 id | 确定性 `tenant:session_fp` | 进程内 `create()` 时随机，跟 session 粘在内存里 |
| 同进程多轮 | 粘 | 粘（已实测 follow 同一 agent） |
| Deno 发版 / 重启 | id 仍稳定 | **换轨**，checkpoint 丢失 |
| 响应里的 Cache Read | `usage.prompt_tokens_details.cached_tokens` | **没有**；`usage` 常为 0。真命中率看 Team Usage CSV |

客户端仍应每轮发送完整 messages（含 tool 历史）。网关跟进只取最新 user（外加折进去的 system），历史靠上游 conversation state。

## 运行时

`AgentService/Run` 必须是双向 Connect 流。

- **Deno**（含 Deploy）：WHATWG `fetch` + `ReadableStream` 请求体，全双工。不要设 `duplex: "half"`。
- **Node / Bun**：`node:http2`。undici `fetch({ duplex: "half" })` 不能跑这条 RPC。
- **Cloudflare Workers**：fetch 半双工，聊天会失败。

`GATEWAY_UPSTREAM=inference` 仅留给测试；生产 Dashboard key 不要走。

## 明确限制

- `InferenceService/Stream`：Dashboard `crsr_` 已死，禁止再接 chat / tools
- Cloud REST `POST /v1/agents`：不用于对话（VM 自带 shell/edit，且没有 OpenAI 式 park `tool_calls`）
- `AgentRunRequest.excludeWorkspaceContext = true`：上游 `invalid_argument`
- `customSystemPrompt`：上游 `unknown option '--system-prompt'`
- 无 `@cursor/sdk`、无本地 agent 二进制
- Anthropic server tools、citations、`top_k`、`n > 1`
- embeddings、audio、Images API、Responses API
- 图 / 文件 / 明文 thinking：当前 AgentService 路径未按 Inference 时代完整映射
- `response_format` 不是服务端 JSON Schema 强制

## 关键更新与事故

- **2026-09-09 — Inference 上游事故（L）**：Cursor 对 Dashboard `crsr_` 的 `aiserver.v1.InferenceService/Stream` 回 `ERROR_NOT_LOGGED_IN`。换票和模型列表仍可能成功，因此不能用 `/v1/models` 判断推理是否还能打。聊天已改到 `agent.v1.AgentService/Run` + 进程内 customTools（无 npm SDK）。本机 Deno 实机：OpenAI probe 7/7、Anthropic `system`、Grok Fast `PONG`。详见 `CLAUDE.md` **INC-2026-09-09**。
- **2026-09-01 — Prompt cache 事故**：上游 `conversationId` 曾被改成每请求随机值，导致长会话 Cache Read 几乎为 0。Inference 路径已恢复为 `tenant:session_fp`。AgentService 路径目前是进程内粘滞，**尚未**绑回 `session_fp`。
- **2026-09-02 — 鉴权缓存**：`crsr_…` 换取 JWT 改为进程内 L1、KV L2，再访问 Cursor exchange；会话内容不写 KV。
- **2026-09-03 — Thinking 与 Grok**：只输出明文 thinking；Grok 加密 signature 不泄露。Grok 带 tools 时（Inference 时代）自动升级 Fast route。
- **2026-09-04 — Anthropic 兼容**：补齐 system、tool use/result、流式错误、Models 响应、usage 和请求校验。
- **2026-09-04 — Session 边界**：Inference 路径不把客户端 session id 当作 Cursor conversation id。AgentService 路径为 park tools **会**使用客户端 `x-session-id`。
- **2026-09-04 — Cache usage 修复**：Anthropic `input_tokens` 改为未缓存输入，避免与 cache read/write 重复计数导致客户端命中率显示错误。
