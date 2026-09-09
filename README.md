# cursor2api

Cursor **AgentService/Run** 的 OpenAI Chat Completions 与 Anthropic Messages 兼容网关。

**2026-09-09 起**：Dashboard `crsr_` 打 `InferenceService/Stream` 会 `ERROR_NOT_LOGGED_IN`（换票 / `GetUsableModels` 仍可能 200）。聊天一律 `POST https://api2.cursor.sh/agent.v1.AgentService/Run` + 进程内 customTools。

## 硬约束（不是 SDK local，也不是 Cloud VM）

不要按 [Cursor TypeScript SDK](https://cursor.com/cn/docs/sdk/typescript) 的 `Agent.create({ local })` / `{ cloud }` 来理解本仓库。那两套运行时都 **禁止** 接到本网关。

| 禁止 | 说明 |
|------|------|
| **npm `@cursor/sdk`** | `package.json` 不依赖它。聊天是仓库内 Connect JSON 客户端（`src/lib/sdk_agent_host.ts`），不要 `import("@cursor/sdk")` |
| **SDK / agent 二进制** | 不要平台包（`@cursor/sdk--*`）、不要本机 agent 可执行文件、不要 `local: { cwd }` 沙盒 / ripgrep。Deno Deploy 也跑不了这些 |
| **Cloud Agents 托管 sandbox VM** | 不要 `POST https://api.cursor.com/v1/agents`、不要 `bc-…` run。Cursor 云端 VM 自带 shell/edit，没有 OpenAI 式 park `tool_calls` |

本网关实际做的是：在 **本进程** 里跑 Agent 循环的 MCP 子集（合成 server `custom-user-tools`），把 `execute()` park 成客户端 `tool_calls`。模型推理仍走 Cursor 托管模型（SDK 文档里的「local ≠ 本地模型」），但 **智能体循环和工具执行不在 Cursor sandbox VM 里**。

代码和日志里的 `GATEWAY_UPSTREAM=cloud`、`cloud_openai.ts`、`CloudChatError`、测试名 `cloud OpenAI…` **只表示「不是已死的 Inference」**，不是 Cloud Agents。启动日志和 `GET /health` 写的是 `agent.v1.AgentService/Run`。

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

推荐默认使用 `composer-2.5`，成本低于 Fast；只有明确需要更低延迟时再使用 `composer-2.5-fast`。

AgentService / SDK **没有** Inference 那种 `composer-2.5-fast` / `cursor-grok-4.6-high-fast` route id。家族 id 永远是 `composer-2.5` / `grok-4.6`，档位写在 `requestedModel.parameters`。**省略参数时 Cursor 默认 Fast**，所以网关会显式传 `fast=true|false`。Grok 的思考强度同样显式传 `effort`（省略则与 Inference 一样默认 `high`）。

| 客户端 `model` | 额外字段 | AgentService |
|----------------|----------|--------------|
| `composer-2.5` | — | `composer-2.5` + `fast=false` |
| `composer-2.5-fast` 或 `fast: true` | — | `composer-2.5` + `fast=true` |
| `grok-4.6` | — | `grok-4.6` + `fast=false` + `effort=high` |
| `grok-4.6-fast` | — | `grok-4.6` + `fast=true` + `effort=high` |
| `grok-4.6-low` / `grok-4.6-medium` | — | `fast=false`，effort 取 id 里的档位 |
| `grok-4.6-fast` | `reasoning_effort: max` | `fast=true` + `effort=xhigh` |
| `gpt-5.6-luna` 等 Other Models | — | 原样透传，不塞 `fast` / `effort` |

思考强度读取顺序：`reasoning_effort` → `reasoningEffort` → `effort` → `reasoning.effort`。`low` / `medium` / `high` 原样；`max` / `xhigh` 在 4.6 上是 `xhigh`，4.5 没有 xhigh 落到 `high`。Composer **不用** `reasoning_effort`；Max 仍是请求体 `max` / `max_mode`（当前 AgentService 路径未映射）。

`GET /v1/models` 往往不列出 Luna；能否打通取决于账号额度与地区，不是网关丢了 id。详表见 `docs/models.md`。

```bash
BASE=https://cursor2api.freetavily.deno.net/v1
KEY=crsr_your_key_here

# Composer 标准档（显式 fast=false，避免被默认成 Fast）
curl -sS "$BASE/chat/completions" -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"hi"}]}'

# Grok Fast + 思考强度 max → effort=xhigh
curl -sS "$BASE/chat/completions" -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" \
  -d '{"model":"grok-4.6-fast","reasoning_effort":"max","messages":[{"role":"user","content":"hi"}],"max_tokens":256}'
```

## 协议兼容性（2026-09-09 后）

本表面仍是 OpenAI / Anthropic HTTP。上游是 Agent 循环，不是 Inference Chat Completions。

OpenAI `/v1/chat/completions`：

- 支持文本消息与 SSE 流式输出
- 支持 `tools[].function`、`tool_choice` 和 `parallel_tool_calls`
- 工具调用通过 `message.tool_calls` 或 **一条完整** `delta.tool_calls` 返回（Cursor Agent 不接受增量分片）
- 工具结果使用 `role: "tool"` 和 `tool_call_id`；网关 **park** `customTools.execute()`，等客户端回灌后再继续同一条 Agent 流
- `usage`：OpenAI 为 `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`；Anthropic 为互斥的 uncached / cache read / cache write。来自 AgentService `turnEnded`。**2026-09-09 实机已打通非零值**（见「会话与 cache」）
- `system` / `developer` **只在该 session 首轮**折进 user 文本（`<system>…</system>`）；跟进只送最新一条 user。**不要**指望上游 `customSystemPrompt`（会被当成 CLI `--system-prompt` 拒掉）
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
| 响应里的 usage | `usage.prompt_tokens` + `prompt_tokens_details.cached_tokens` | 从 AgentService `turnEnded` 映射。`tool_calls` 那一枪 turn 尚未结束，usage 常为 0；最终文本那一枪带上整轮。Team Usage CSV 仍是计费真源 |

### 实测（2026-09-09）

本机 Deno 当前代码、Dashboard `crsr_`、`composer-2.5-fast`、无 tools、system「Reply with exactly PONG.」、user「hi」。HTTP 200，正文 `PONG.`。`turnEnded` 与 OpenAI `usage` 一致：

| 字段 | 值 |
|------|-----|
| `prompt_tokens` / `inputTokens` | 3672 |
| `completion_tokens` / `outputTokens` | 91 |
| `total_tokens` | 3763 |
| `prompt_tokens_details.cached_tokens` / `cacheReadTokens` | 3616 |
| `cache_write_tokens` / `cacheWriteTokens` | 0 |

首轮 Cache Read 高是 Composer **前缀缓存**，不是空 usage。不要用这一枪判断会话级 cache 是否粘住。

客户端仍应每轮发送完整 messages（含 tool 历史）。网关首轮取 system + 最新 user；**跟进只取最新 user**。历史在 Cursor 的 `conversationState` 里，不要再 flatten 整段上文。

## 运行时

`AgentService/Run` 必须是双向 Connect 流。

- **Deno**（含 Deploy）：WHATWG `fetch` + `ReadableStream` 请求体，全双工。不要设 `duplex: "half"`。
- **Node / Bun**：`node:http2`。undici `fetch({ duplex: "half" })` 不能跑这条 RPC。
- **Cloudflare Workers**：fetch 半双工，聊天会失败。

`GATEWAY_UPSTREAM=inference` 仅留给测试；生产 Dashboard key 不要走。

## 明确限制

- 不要安装 `@cursor/sdk`，不要任何 agent / sandbox / ripgrep 二进制依赖
- 不要 Cursor 托管的 Cloud Agents sandbox VM（`POST /v1/agents`、`bc-…`）；`GET /v1/models` 可以打 `https://api.cursor.com/v1/models`，对话不行
- `InferenceService/Stream`：Dashboard `crsr_` 已死，禁止再接 chat / tools
- `AgentRunRequest.excludeWorkspaceContext = true`：上游 `invalid_argument`
- `customSystemPrompt`：上游 `unknown option '--system-prompt'`
- Anthropic server tools、citations、`top_k`、`n > 1`
- embeddings、audio、Images API、Responses API
- 图 / 文件 / 明文 thinking：当前 AgentService 路径未按 Inference 时代完整映射
- `response_format` 不是服务端 JSON Schema 强制

## 关键更新与事故

- **2026-09-09 — Inference 上游事故（L）**：Cursor 对 Dashboard `crsr_` 的 `aiserver.v1.InferenceService/Stream` 回 `ERROR_NOT_LOGGED_IN`。换票和模型列表仍可能成功，因此不能用 `/v1/models` 判断推理是否还能打。聊天已改到 `agent.v1.AgentService/Run` + 进程内 customTools（**无** `@cursor/sdk`、**无** agent 二进制、**无** Cloud sandbox VM）。本机 Deno 实机：OpenAI probe 7/7、Anthropic `system`、Grok Fast `PONG`。同日再测：无 tools `composer-2.5-fast` PONG 的 `usage` 非零（prompt 3672 / cached 3616 / completion 91）。详见 `CLAUDE.md` **INC-2026-09-09**。
- **2026-09-09 — AgentService 模型参数**：SDK 省略 `fast` 时默认 Fast。网关显式传 `parameters.fast`（`composer-2.5` / `grok-4.6` 为 false，带 `-fast` 后缀才是 true），Grok 思考强度显式传 `parameters.effort`（默认 `high`，`reasoning_effort: max` → `xhigh`）。不因 tools 给 Grok 升 Fast。
- **2026-09-01 — Prompt cache 事故**：上游 `conversationId` 曾被改成每请求随机值，导致长会话 Cache Read 几乎为 0。Inference 路径已恢复为 `tenant:session_fp`。AgentService 路径目前是进程内粘滞，**尚未**绑回 `session_fp`。
- **2026-09-02 — 鉴权缓存**：`crsr_…` 换取 JWT 改为进程内 L1、KV L2，再访问 Cursor exchange；会话内容不写 KV。
- **2026-09-03 — Thinking 与 Grok**：只输出明文 thinking；Grok 加密 signature 不泄露。Grok 带 tools 时（Inference 时代）自动升级 Fast route。
- **2026-09-04 — Anthropic 兼容**：补齐 system、tool use/result、流式错误、Models 响应、usage 和请求校验。
- **2026-09-04 — Session 边界**：Inference 路径不把客户端 session id 当作 Cursor conversation id。AgentService 路径为 park tools **会**使用客户端 `x-session-id`。
- **2026-09-04 — Cache usage 修复**：Anthropic `input_tokens` 改为未缓存输入，避免与 cache read/write 重复计数导致客户端命中率显示错误。
