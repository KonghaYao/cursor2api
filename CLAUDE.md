# 开发备忘 / 踩坑记录

供后续改网关或接 Cursor Agent 时对照，避免重复踩坑。

---

## 硬约束：无 SDK、无二进制、无 Cloud sandbox VM

后续改聊天路径时 **先对照这一节**。官方文档 [SDK TypeScript](https://cursor.com/cn/docs/sdk/typescript) 的 `local` / `cloud` **都不是本网关的产品形态**。

| 禁止 | 不要做的事 |
|------|------------|
| **不装 `@cursor/sdk`** | 不要写进 `package.json` / `deno.json` / `import("@cursor/sdk")`。聊天实现是仓库内 `src/lib/sdk_agent_host.ts` |
| **不要二进制依赖** | 不要 SDK 平台包（`@cursor/sdk--*`）、不要本机 agent 可执行文件、不要为 `local: { cwd }` 拉 sandbox / ripgrep。Deno Deploy 跑不了这些 |
| **不要 Cloud 托管 sandbox VM** | 不要 `Agent.create({ cloud })`，不要 `POST https://api.cursor.com/v1/agents` 开 `bc-…` 对话。VM 自带 shell/edit，没有 OpenAI 式 park `tool_calls` |

**是什么：** 网关进程内对 `POST https://api2.cursor.sh/agent.v1.AgentService/Run` 的 Connect JSON 客户端；MCP 家族 allowlist 请求头压掉默认 shell/edit；客户端 function tools → 合成 MCP `custom-user-tools`（`mcpTools` + `requestContext` / `mcpState`），`customTools.execute()` 在本进程 park，返回 OpenAI `tool_calls`。每一枪 HTTP 开/关一条 Run（交 `tool_calls` 时 **close 双工、不发 `cancelAction`**）。**每一枪都要带** `conversationState`（缺字段 → `invalid_argument: Conversation state is required`）。从全量 transcript 拼 `rootPromptMessagesJson`（SHA-256 JSON blob + `getBlob`），对象里 **只** 放 roots，**不要**空 `turns: []`。`role: tool` 走 **`userMessageAction` + `composeToolResultPrompt`**（双工已关，空 `resumeAction` 会空白结束）。cwd 默认 `/tmp`（`GATEWAY_AGENT_CWD`）。默认不发 `customSystemPrompt`。模型仍是 Cursor 托管推理，**不在** Cursor sandbox VM。

**日志里的 `cloud`：** 只是旧名：`cloud_openai.ts` / `CloudChatError` / 测试名 `cloud OpenAI…` 指 AgentService 聊天路径，**不是** Cloud Agents。`GATEWAY_UPSTREAM=inference` **已从入口移除**，聊天固定走 AgentService。`GET /health` 的 `rpc` 才是真实路径。

`sdkLocalAgentCreateOptions()` 只是 MCP allowlist 的形状备忘（单测用），**运行时不会** `Agent.create({ local })`。

---

## 2026-09-09：Inference 已死；聊天走 AgentService customTools + 自拼 conversationState（无 `@cursor/sdk`）

台账：**INC-2026-09-09**。Cursor Agent 作为本网关的客户端 **总会带 function `tools`**。「无 tools 走 Cloud REST」不是产品场景，不要再加回那条分流。

网关 **禁止** npm `@cursor/sdk`、禁止 agent 二进制、禁止 Cursor 托管 sandbox VM。聊天实现是仓库内的 `AgentService/Run` Connect JSON 客户端：`src/lib/sdk_agent_host.ts`。线协议与 SDK 文档里 **local 循环用的同一条 RPC**（`AgentService/Run`），但 **不是** 官方 SDK local runtime（无 cwd 沙盒、无默认 shell/edit）。客户端 tools 走合成 MCP `custom-user-tools`；`execute()` 只在**这一枪 Run** 内 park 以收集 `tool_calls`，交卷后关掉双工。下一枪 HTTP 不 resume 旧 duplex。

### 上游怎么选（不要再试 Inference）

| 路径 | 对 Dashboard `crsr_` | 用途 |
|------|----------------------|------|
| `POST https://api2.cursor.sh/aiserver.v1.InferenceService/Stream` | **死了**：换票后 `GetUsableModels` 仍可能 200，Stream 回 `ERROR_NOT_LOGGED_IN` | **禁止**再把 chat / tools 接到这里 |
| `https://api.cursor.com/v1/agents` Cloud REST | 能用 | **仅** `GET /v1/models`；不要用它跑对话（VM 会自带 shell/edit，且没有 OpenAI 那种 park `tool_calls`） |
| `POST https://api2.cursor.sh/agent.v1.AgentService/Run` | 能用（先 `exchange_user_api_key`） | **全部** `/v1/chat/completions` 与 `/v1/messages` |

AgentService **没有** Chat Completions HTTP。客户端 function tools **是**合成 MCP `custom-user-tools`（Connect `mcpTools` + exec `requestContext` / `mcpState`）。模型走 MCP `mcpArgs`；网关 park `execute()`、对客户端返回 OpenAI `tool_calls`，然后 **close 双工（不 `cancelAction`）**。调用方 POST `role: tool` 时**新开** Run：roots = 系统 + 历史（不含本轮最新 tool 结果）；action 为 `userMessageAction` = `composeToolResultPrompt`。空 `resumeAction` 在新双工上没有可续的 MCP exec，会 `finish=stop` 空正文。这不是 HTTP `/mcp`，Cloud VM 不会回调本网关。

### conversationState（自己拼接，`src/lib/conversation_state.ts`）

Cursor 用 `rootPromptMessagesJson`（Vercel-AI 形 JSON 的 SHA-256 blob id）喂模型；`turns[]` 是 UI 元数据。blob 经同一条 Run 的 `getBlobArgs` 取回。

| 本轮 | `conversationState` | action |
|------|---------------------|--------|
| 首轮 | 系统 blob（client system + tool policy；缺省则默认助手句） | `userMessageAction` = 第一条 user 文本。**不要**把 system 再折进 user，**不要**发空 `{}` |
| 跟进 user | **必须带字段**：系统 + 历史（不含本轮新 user）。**禁止省略**（上游 `Conversation state is required`） | `userMessageAction` = 新 user（可 slice 多条） |
| `role: tool` | 系统 + 历史（**不含**本轮最新 tool 结果） | **`userMessageAction`** = `composeToolResultPrompt`。双工已关，空 `resumeAction` 会空白 `stop` |

- blob id = SHA-256(JSON utf8)，Connect JSON 里是标准 base64；`getBlob` 回 `blobData` = JSON 字节的 base64
- **禁止**把 OpenAI `messages` / `tool_calls` 原样塞进 `conversationState`
- **禁止** `conversationState: {}`（等于告诉上游这段对话是空的）
- **禁止** 跟进枪省略 `conversationState`（`invalid_argument: Conversation state is required`）
- **禁止** 跟进枪带空 `turns: []` / 空 map / 空 `{}`（会把上文抹成空会话）
- **不要**把上一枪 checkpoint 的 `rootPromptMessagesJson` 当可信历史（上游回显常把历史 user 换成空占位）
- KV `agent-run:` **只存 ids**（不存 checkpoint / 不存 transcript）。每枪从客户端全量 messages 重拼 roots
- cwd /「工作区路径」默认 **`/tmp`**（`mcpFileSystemOptions.workspaceProjectDir`）。模型说工作区是 `/tmp` 是预期，不是会话丢了。要改用 `GATEWAY_AGENT_CWD`

### 屏蔽自带工具（MCP allowlist 仍开；上游挂 custom-user-tools）

请求头 `x-cursor-agent-allowed-tools` 必须是 MCP 家族（SDK 公开名 `"mcp"` 的展开），**禁止**默认 toolset；**不要**清掉该头：

```
mcp_tool_call,get_mcp_tools_tool_call,list_mcp_resources_tool_call,read_mcp_resource_tool_call,mcp_auth_tool_call
```

- 不设该头 → 默认 toolset（shell / edit / grep / …）会回来 — **禁止**
- 只开 MCP 家族 → 压掉 shell/edit/grep/task/webSearch；Connect body 送 `mcpTools: [custom-user-tools-…]`
- **跨轮次工具**：单测必须覆盖「`get_weather` → `lookup` → `search` → 终轮文本」（用户工具 ×3）；`conversation_id` 不变；跟进枪 `userMessageAction` 带本轮工具结果，roots 含上文。改第一条 user = 新对话。不要用「只发最后一条」当产品场景。**工具结果回来后正文不能空。**
- **跨轮次用户话（产品验收，假 host 不够）**：同一会话三句「你的工具有什么」→「调用一下」→「我的第一句话是什么」，第三句必须能复述第一句、无异常信封。见 **2026-09-10** / `scripts/probe-session-memory.ts`。只绿 `get_weather→lookup→search` 协议单测 **不算** 过关。

**不要**设 `AgentRunRequest.excludeWorkspaceContext = true`（`Workspace context exclusion is not allowed…`）。无 workspace 靠 MCP allowlist + `mcpFileSystemOptions.enabled = false`。

**`customSystemPrompt` / `--system-prompt`：** `@cursor/sdk` 的 `AgentOptions.systemPrompt` **就是**每枪 `customSystemPrompt`，语义是 **整段替换** Cursor harness（身份 / 工具协议 / 沟通规则）。只给 SDK **local**，且 **账号门禁**：没开门时第一枪 `invalid_argument: unknown option '--system-prompt'`。Dashboard `crsr_` **9/9 与 9/10 实机仍拒**（`scripts/probe-system-override.ts`）。产品 **不发** 该字段。客户端 `system` 进 `rootPromptMessagesJson`，**叠在 harness 上面，换不掉** Composer 身份和「Read/Write/终端」话术。不要折进 `userMessageAction`。不要为了覆盖去装 `@cursor/sdk` 或 `Agent.create({ local })`。缺 `conversationState` 时上游先报 `Conversation state is required`，会误判成字段本身坏了。

### 客户端合约（常态）：全量 `messages` + 前缀稳定

这是产品路径，不是边角。Cursor Agent（以及按 OpenAI/Anthropic 标准写的客户端）**每一枪都带完整 transcript**，并自己维持前缀：

| 客户端保证 | 含义 |
|------------|------|
| **全量传递** | 每轮 `messages` = 从第一条 user 到当前的全部 user / assistant / `tool_calls` / `role: tool`（Anthropic 则是 `tool_use` / `tool_result`）。**不要**假设客户端只发 delta。 |
| **前缀稳定** | 只 append。不改第一条 user、不改已出现的 assistant/tool 前缀、不改 `system` / tools catalog。改了 = 新对话（`agentRunFp` 变）。 |

网关职责是 **从全量里抽出本轮 delta** 再打 AgentService（上文在每枪自拼的 roots，字段不能缺）：

| 本轮 | 送给 AgentService |
|------|-------------------|
| 首轮 | roots = 系统 blob；`userMessageAction` = 第一条 user |
| 跟进 user | roots = 系统 + 历史（**必须带** `conversationState`）；`userMessageAction` = 新 user |
| `role: tool` | roots = 系统 + 历史（不含本轮最新 tool 结果）；**`userMessageAction`** = 工具结果摘要 |

`agentRunFp` 锚 **第一条 user** 成立，正是因为客户端保证这条前缀不变。单测多轮必须用**全量 transcript** 复现，不要用「只发最后一条」当产品场景。

### 运行时

`AgentService/Run` 是 **双向 Connect 流**（exec 结果必须在同一条流上回去）。

| 运行时 | 传输 |
|--------|------|
| **Deno**（含 Deploy） | WHATWG `fetch` + `ReadableStream` body。Deno 的 fetch 在 HTTP/1.1 / HTTP/2 上是 **全双工**（响应头可在请求体未结束时到达）。**不要**设 `duplex: "half"`（那是浏览器/undici 半双工，exec 回不去）。 |
| **Node / Bun** | `node:http2`。undici `fetch({ duplex: "half" })` **不是**全双工，不能用来跑 AgentService/Run。 |

Cloudflare Workers 的 fetch 仍是半双工，聊天会失败。不要为了半双工去装 `@cursor/sdk` 或走官方 `local.useHttp1ForAgent`（那是 SDK 的 RunSSE / HTTP/1.1 退路，带二进制）。

`stream: true` 的 `tool_calls` 仍须 **一条完整 delta**（见 2026-08-31）。文本 / thinking 跟 AgentService `textDelta` / `thinkingDelta` 增量转成 SSE。会话 id 由网关内部计算（`tenant:agentRunFp`），**不要**再靠客户端 `x-session-id`；`SESSION_MODE=random` 不行。

客户端 `usage`：从 `interactionUpdate.turnEnded` 读 token 字段（proto JSON 的 `inputTokens` 等，uint64 可能是字符串），映射成 OpenAI `prompt_tokens` / `cached_tokens` 与 Anthropic `input_tokens` / `cache_read_input_tokens`。同一 `send()` 内多段 turnEnded 相加。park `execute()` 的 `tool_calls` 响应在 `turnEnded` 之前交卷，usage 可能为 0；终轮文本可以有非零 usage。不要为了 usage 去调 Cloud `getUsage` 或装 SDK。

**2026-09-09 实机**：Deno + `crsr_` + `composer-2.5-fast` 无 tools PONG，`turnEnded` = `inputTokens=3672` `outputTokens=91` `cacheReadTokens=3616` `cacheWriteTokens=0`，OpenAI `usage` 同数。首轮高 Cache Read 是 Composer 前缀缓存。

Deno.serve 默认会在**成功响应之后** abort `request.signal`（日志里的 legacy abort）。**不要**把这个 signal 接到一条已经交过卷的 Run、或下一枪新开的 Run 上。`tool_calls` 返回时网关自己关后向 `Run`；`role: tool` 本来就是新开的一枪，不再依赖跨请求 park。`deno.json` 仍开 `--unstable-no-legacy-abort`。

**交 `tool_calls` ≠ 用户中断：** 返回 OpenAI `tool_calls` / Anthropic `tool_use` 时只 **close 双工**，**不要**发 `cancelAction`。`cancelAction` 会把这一轮作废，下一枪对不上。HTTP `request.signal` 只通过 `attachClientAbort` 绑到 **cancel**，交卷前摘掉；不要把它传进 `agent.send({ signal })`（Deno 200 后 abort 会误发 cancel）。

**用户端中断（官方 abort）：** 客户端断开 HTTP / 取消 SSE 时，对**这一枪还在飞的** `AgentService/Run` 发 `conversationAction.cancelAction`（proto `CancelAction`），再关双工。不要只停本地 SSE 而让上游继续计费。握手阶段（`fetch` 还没连上）才直接 abort 传输。成功返回 200 之后立刻摘掉 `request.signal`，避免 Deno legacy abort 误发 cancel。`ReadableStream.cancel()`（SSE 客户端丢连接）同样走 `cancelAction`。

**会话 id（Deno isolate / serverless）：** `conversationId` = `tenant:agentRunFp`。`agentRunFp` = model / effort / flags / tools / system / **第一条 user**（不含后续轮次）。客户端 `x-session-id` / `conversation_id` **忽略**。**每一枪 HTTP 开/关一条 `AgentService/Run`**：返回 `tool_calls` 就关掉双工。跟进枪 **必须**带自拼 roots（缺字段会 `Conversation state is required`）。`role: tool` 用 `userMessageAction` 送工具结果，**不要**空 `resumeAction`。KV `agent-run:${tenant}:${fp}` 只存 `{fp, conversationId, agentSessionId}`，TTL 24h，**不要**把 checkpoint / messages 写进 KV。KV `agent-run-len:` 只存上次成功处理的 `messages.length`，TTL **5 分钟**，用来 slice 新 user；**不要**并进 24h 的 `agent-run`。

### 不要做的

- 把 tools 改回 `InferenceService/Stream`
- 无 tools 时改走 Cloud `bc-…` REST 当「简单聊天」（Cursor 托管 sandbox VM）
- 给 Agent 开 `shell` / `edit` / `task` 或默认 toolset
- 把客户端 tools 挂成 HTTP MCP 让 Cloud VM 反调
- 用 `GetUsableModels` / `/v1/models` 判断 Inference 是否还能打
- 再加回 `@cursor/sdk`、SDK 平台二进制、或本机 agent 可执行文件来跑聊天
- 把日志/`cloud_openai.ts` 里的 `cloud` 理解成 Cloud Agents / `Agent.create({ cloud })`（旧名；`GATEWAY_UPSTREAM` 已从入口移除）
- 指纹路径每轮 `randomId()` 当 conversationId（9/1 cache 事故）
- 设 `excludeWorkspaceContext = true`（Dashboard `crsr_` 会 invalid_argument）
- 给 Dashboard `crsr_` 发 `customSystemPrompt`（9/10 仍 `unknown option '--system-prompt'`；SDK 文档里的 `systemPrompt` 是同一字段 + 同一门禁，不是网关漏接）
- 把 root blob 里的客户端 `system` 当成「已替换 harness」（模型仍会自称 Composer、报 `/tmp`、列出 Read/Write；那是 harness 话术，不是 MCP allowlist 漏了 shell/edit）
- 发空 `conversationState: {}`（会抹掉上文）
- 跟进枪省略 `conversationState`（Cursor Agent 大 system 上会 `Conversation state is required`；短 system 探针测不出来）
- Anthropic `/v1/messages` 发出无 `signature` 的 `thinking` 又在跟进枪拒收（400）。AgentService 没有真签名：下发 `signature: ""` 并接受回放，**不要**为了避 400 把 thinking SSE 整段掐掉（Composer 会长时间只在想，界面像没在流）
- `handleGatewayRequest` 对聊天 `return await` 流式 Response（Deno.serve 会当 handler 已结束并 legacy-abort `request.signal`，SSE 被 cancelAction 掐死）。流式路径要 `return promise.catch(...)`，不要 await 掉 body
- `handleGatewayRequest` 里 `return handleCloud…` 不 `await`（`AuthError` 逃出 try/catch，Deno 变成明文 500 而不是 401）
- 跟进枪带空 `turns: []` / 空 `{}`（9/10：第三句忘了第一句）
- 用假 host 或短 system 探针代替 Cursor Agent 大 system 的三句实机验收
- 把 OpenAI `messages` / `tool_calls` JSON 直接塞进 `conversationState`（必须是 blob id + `rootPromptMessagesJson`）
- 只把最后一条 user 丢给 AgentService、却不拼 roots（isolate hop / `role: tool`）
- 把「客户端只发增量 messages」当成产品场景。常态是 **每轮全量 + 前缀稳定**；禁止把整段 history 再叠进 `userMessageAction`
- 跟进轮次再把 system / 工具目录 / 整段 history / **历史** tool results 叠进 `userMessageAction`（应在 spliced roots；本轮最新 tool 结果除外，那是 `composeToolResultPrompt`）
- `role: tool` 发空 `resumeAction`（新双工上没有 in-flight MCP exec，实机 `finish=stop` 空正文）
- 把 HTTP `request.signal` 绑到**已经返回的**或**下一枪** AgentService/Run 上（Deno.serve 成功响应会 abort）。用户取消**当前还在飞的**那一枪必须发 `cancelAction`，不要只关本地 SSE。
- 交 `tool_calls` 时对 AgentService 发 `cancelAction`（那是用户中断，不是关这一枪 HTTP；多轮工具会断）
- 给 AgentService 只送 `modelId: composer-2.5` 而不带 `parameters.fast=false`（上游默认 Fast，Team Usage 记成 `composer-2.5-fast`）
- 给 AgentService 的 Grok 只剥 `-fast`、不传 `parameters.effort`（思考强度会掉回上游默认，而不是客户端的 `reasoning_effort` / id 里的 `low|medium|high|xhigh`）
- 给 AgentService 每轮 `randomId()` 当 conversationId（isolate 一跳就丢 cache；用 `tenant:agentRunFp`，fp **不要**混进整段 pending transcript，只锚第一条 user）
- 再用客户端 `x-session-id` / `conversation_id` 当会话键（已废弃；session 完全内部计算）
- 把 messages / canon / 整段 transcript 写进 KV（`agent-run:` 只允许 ids + 可选小 checkpoint；`agent-run-len:` 只允许整数长度，TTL 5min，不要并进 24h 绑定）

---

## 2026-09-10：conversationState 两头都错（空 turns 抹上文 / 省略字段被拒）

台账：**INC-2026-09-10**。先是 `b97f6d7` 每枪自拼 state 带空 `turns: []`，三句用户话忘上文。接着 `5c5218e` **省略**跟进枪的 `conversationState`，短 system 探针能绿，**Cursor Agent（~10k system）跟进枪直接 `invalid_argument: Conversation state is required`**。

### 验收（假 host + 短 system 都不够）

同一 `conversation_id`、全量 transcript、无 `Conversation state is required`、第三句能复述第一句：

1. 「你的工具有什么」
2. 「调用一下」
3. 「我的第一句话是什么」

```bash
set -a && source .env && set +a
# 默认 PAD≈24k 字符，对齐 Cursor Agent 大 system；短 system 测不出缺字段
BASE=http://127.0.0.1:8793 node --experimental-strip-types scripts/probe-session-memory.ts
```

单测必须断言：**跟进 user 的 `send()` 带非空 `conversationState`**，且 roots 含第一句。只绿三轮 MCP park **不算**过关。

模型说「当前工作区路径是 `/tmp`」是 `mcpFileSystemOptions.workspaceProjectDir` 默认值，不是会话丢了。

### 根因（两步）

1. **空 `turns: []`**：Cursor 当成「这段对话没有 turns」，历史被抹。和发 `{}` 同类。
2. **省略字段**：AgentService 跟进枪 **要求** `conversationState`。短 system / 假 host 不报这个错。Cursor 回显的 checkpoint `rootPromptMessagesJson` 还可能是空占位，不能当历史源。

`Prompt cache coverage 4%`（如 cached 448 / input 10381）常见于 **大 system 首轮**（Composer 前缀只有一点 cache），不要单独当成会话 id 事故。

### 正确做法

| 本轮 | `conversationState` |
|------|---------------------|
| 每一枪 | **必须带**。从客户端全量 transcript 拼 `rootPromptMessagesJson`（不含本轮新 user；tool 轮含 `[Tool Result]`） |
| 形状 | **只** 放 `rootPromptMessagesJson`。禁止省略、禁止 `{}`、禁止空 `turns: []` |
| `role: tool` | roots 不含本轮最新 tool 结果；`userMessageAction` = `composeToolResultPrompt` |

`getBlob` 按标准 base64 / URL-safe / hex 索引。KV 仍只存 ids。

### 约束

| 内容 | 策略 |
|------|------|
| 跟进枪 | **必须**带自拼 roots；不要省略、不要只回传 checkpoint roots |
| 自制 roots | 只放 `rootPromptMessagesJson` |
| 产品验收 | Cursor Agent 大 system + 上面三句；短探针不能替代 |
| `/tmp` | 默认 cwd；不要为此重开 shell/edit |

---

## 2026-09-10：SDK `systemPrompt` 换不掉本网关的 harness

官方 `@cursor/sdk`（1.0.31，[TypeScript 文档](https://cursor.com/docs/sdk/typescript)）已有 `AgentOptions.systemPrompt`：

| 项 | 事实 |
|----|------|
| 语义 | **替换**主循环 harness，不是往上叠一句。调用方要自己重写工具协议；schema / rules / skills 仍在；`task` 子代理用自己的 prompt |
| 线协议 | 每枪 `AgentService/Run.customSystemPrompt`（`executor-types`：*sent as `customSystemPrompt` on every turn*） |
| 范围 | **local only**；和 `cloud` 一起用 SDK 会 `ConfigurationError` |
| 门禁 | 账号没开权限 → `InvalidArgument` 文案带 `--system-prompt` |
| 持久化 | 不跟 agent 走；`Agent.resume` 要再传 |

本网关走同一条 RPC，但 **不是** SDK local runtime。产品路径 **不发** `customSystemPrompt`。

### 实机（本仓库 `crsr_` + `composer-2.5-fast`，`scripts/probe-system-override.ts`）

system = 「只回 `OVERRIDE-OK`，不要提 Cursor / 工具 / `/tmp`」；user = 「你是谁？列出工具和工作区」。

| 路径 | 结果 |
|------|------|
| HTTP 网关：system 只进 root blob | 200。**不是** `OVERRIDE-OK`。自称 Composer，工作区 `/tmp`，列出 Read / Write / StrReplace / …（harness 话术） |
| 直连 Run：`customSystemPrompt`、无 `conversationState` | `Conversation state is required`（先撞缺字段，测不出门禁） |
| 直连 Run：`customSystemPrompt` + 自拼 roots | `invalid_argument: unknown option '--system-prompt'`（与 9/9 相同门禁） |

`buildRunRequest` 仍可 **opt-in** 带该字段（探针用）；聊天 handler **默认不传**。

### 约束

| 内容 | 策略 |
|------|------|
| 产品 `system` | 只进 `rootPromptMessagesJson`；接受叠在 harness 上 |
| `customSystemPrompt` | `crsr_` 上禁止当产品默认；开门前再发也会炸 |
| 模型口中的 Read/Write | 当 harness 话术，不要为此重开默认 toolset |
| `@cursor/sdk` | 仍禁止装进本仓库来「覆盖 system」 |

---

## Team Usage CSV：缓存与成本分析方法

从 Cursor Team 导出的 `team-usage-events-*.csv` 判断 **prompt cache 是否正常**、**成本花在哪**、**有没有事故级回归**。可复现脚本：`scripts/analyze_team_usage.py` → HTML 报告 `reports/usage-<date>-cache-cost.html`。

```bash
python3 scripts/analyze_team_usage.py team-usage-events-29803137-2026-09-02.csv
open reports/usage-2026-09-02-cache-cost.html
```

### 列语义（不要误读）

| 列 | 含义 |
|----|------|
| `Input (w/o Cache Write)` | 本轮**未命中**缓存的 input tokens（新 user/tool 内容，或整段 history 重送） |
| `Cache Read` | 命中缓存的前缀 tokens |
| `Input (w/ Cache Write)` | 本导出常为 0；**不能**当「写了多少 cache」 |
| `Cost` | Team Usage **内部估算**（`Included` 仍显示相对金额），用于对比趋势 |

**单次命中率**（脚本默认）：

```text
hit = Cache Read / (Cache Read + Input (w/o Cache Write))
```

**冷启动**：`Cache Read ≤ 1`（与 Cursor 导出里「几乎没读到缓存」一致）。

**全局命中率（SLO · 跨轮次，2026-09-05 起）**（按 token 加权，**剔除会话首轮**）：

```text
global_hit = Σ CR / (Σ CR + Σ in_wo)   # 仅计入「非首轮」计费行
global_hit_all = 含首轮的旧算法（对照用，summary.global_hit_all）
```

**首轮判定**（CSV 无 conversationId，固定规则）：`Cache Read ≤ 1` **且** `Input (w/o Cache Write) ≤ 25000`（**25k 以下算初始**）。  
`T = 25000` 常量：`scripts/usage_cache_metrics.py` → `FIRST_TURN_INWO_THRESHOLD`。

| 字段 | 含义 |
|------|------|
| `summary.global_hit` | **跨轮次**（M1 SLO） |
| `summary.global_hit_all` | 含首轮 |
| `summary.first_turn_excluded_n` | 剔除行数 |
| `summary.first_turn_threshold` | 固定 `T`（当前 25000） |

**为何改**：多会话并行时大量「首轮 CR=0、in_wo 小」会 **拉低** 旧 `global_hit`，掩盖 **第 2 枪及以后** 的 cache 是否正常。  
**不变**：`cold` / streak / reships / 成本仍用全量行；仅 **命中率聚合** 剔除首轮。

**旧公式（含首轮）**：

```text
global_hit_all = Σ Cache Read / (Σ Cache Read + Σ Input (w/o Cache Write))
```

### 与 9/1 事故对照（是否「网关把 conversationId 打随机」）

| 信号 | 事故日（random id） | 健康日 |
|------|---------------------|--------|
| 同一逻辑会话连续多枪 `Cache Read ≈ 0` | **15～50+** | 通常 **≤7**；且 `in_wo` 常各不相同（多 thread 交错） |
| 滚动 20 请求全局命中 | 长期 **&lt;20%** | 中位 **~98%** |
| 换轨后 | 每轮都冷 | **偶发冷枪**后回到高 `Cache Read` 轨道 |

**整前缀重送**（换 `session_fp` / 新 thread，不是每轮随机）：

- 相邻两枪（时间正序）：上一枪 `Cache Read = R` 且命中高；下一枪 `Cache Read ≤ 1` 且 `Input (w/o Cache Write) ≈ R`（相对误差 &lt;8%）。
- 脚本统计为 `reships` 次数。

### 自动异常检测（HTML 竖线 / 标签）

1. **Token 一致性**：`Total` 是否等于 `in_wo + Cache Read + Output`（允许 ±2 舍入）。
2. **冷启动 streak**：连续 ≥5 次 `CR≤1`（按时间排序）；事故日会出现很长一段，健康日多为并行新 thread。
3. **冷启动 burst**：60 秒滑动窗内 ≥4 次冷启动 → 标为「异常簇」（如 CST 11:08、14:20 批量 subagent）。
4. **计费离群**：Composer 上 `cost / (in_wo+CR)` 在**热路径**（hit≥90%）应稳定；**冷枪**单价约为热路径 **4～6 倍**属定价结构，不是 warm 乱扣。
5. **多 thread 假突变**：30 秒内 `Cache Read` 从 ~120k 跳到 ~24k 且**两边都 &gt;10k、仍高命中** → 多为**并行会话交错**，不是单会话 cache 丢失。

### 监控指标（SLO · 日常告警）

数据源：Team Usage CSV → `analyze_team_usage_chart_group.py`（`D.summary` / `D.perModel.model_summary`）+ `analyze_team_usage.py`（`D.anomalies`）。**时区一律 CST**。计费行定义同脚本：`Cost≠Free` 且 `Input (w/o Cache Write)` 非空。

**健康底线**：**全局 token 加权命中率 &lt; 90% 视为不健康**，必须做根因分析（先查 `composer-2.5` 与并行冷启动，再查网关 `session_fp` / conversationId，对照下文 P0）。

#### 每日流程（建议）

```bash
python3 scripts/analyze_team_usage_chart_group.py team-usage-events-*.csv -o reports/usage-<date>-by-model.html
python3 scripts/analyze_team_usage.py team-usage-events-*.csv -o reports/usage-<date>-cache-cost.html
```

1. 看 by-model 汇总卡：**global_hit**、分模型 hit、冷/热成本；**吞吐 Tab** 看 **M12–M14** 尖峰 badge。
2. 看 cache-cost：**token_mismatch**、**reships**、**cold_streaks**、burst 竖线；**按小时成本** 看 **M15**。
3. 尖峰与 **M4/M5/M11** 是否 **同一 CST 小时或同一分钟**（见「请求 / 成本尖峰」）。
4. 任一项触发 **P0 / P1** → 按「触发后动作」列处理；仅 P2/O → 记入台账或观察。

#### 指标表

| ID | 指标 | 计算方式 | 健康 | 警告 | 严重（P0） | 触发后动作 |
|----|------|----------|------|------|------------|------------|
| **M1** | **全局命中率（跨轮次）** `global_hit` | 剔除首轮后 `Σ CR / (Σ CR + Σ in_wo)`（见上） | **≥ 90%** | 85%–90% | **&lt; 85%** 或 **&lt;90% 且连续 2 个导出日** | 对照 `global_hit_all`；拆 M2/M3/M7 |
| **M2** | **`composer-2.5` 命中率** | 同 M1，仅该 model 行 | **≥ 90%** | 88%–90% | **&lt; 88%** | 能改路由则优先 **fast**；查长会话是否误用标准档 |
| **M3** | **`composer-2.5-fast` 命中率** | 同上 | **≥ 92%** | 90%–92% | **&lt; 90%** | 查网关 conversationId / 换轨频率；与 M5 同查 |
| **M4** | **冷请求占比** `cold_pct` | `CR≤1` 行数 / 计费行数 | **≤ 12%** | 12%–18% | **&gt; 18%** | 看 burst/subagent；冷枪正常但占比高 → 并行新 thread 多 |
| **M5** | **最长冷 streak** | 时间正序连续 `CR≤1` 最大长度 | **≤ 10** | 11–19 | **≥ 20**（尤其 **≥ 30**） | **≥20 按 P0 疑 conversationId**；11–19 多为并行冷启动，结合 M6 |
| **M6** | **滚动 20 枪低命中占比** | 窗口 `ΣCR/(ΣCR+Σin_wo)&lt;90%` 的窗口数 / 总窗口数 | **≤ 35%** | 35%–55% | **&gt; 55%** 且 M1&lt;90% | **勿单独告警**；仅在与 M1/M5 同坏时作辅证 |
| **M7** | **冷启动成本占比** | `cold_cost / total_cost`（脚本 summary） | **≤ 12%** | 12%–18% | **&gt; 18%** | 查大 `in_wo` 冷枪（换轨一次付清）与 Grok 大 output |
| **M8** | **整前缀重送** `reships` | 脚本相邻枪检测（见上） | 仅趋势 | 较前日 **+50%** | 与 M5≥20 **同现** | 区分换轨（预期）vs 每轮 random（事故） |
| **M9** | **Token 一致性** | `Total ≠ in_wo+CR+Out` 行数 | **0** | — | **≥ 1** | 导出/解析 bug，勿用于 cache 结论 |
| **M10** | **非 fast Grok（Agent 路径）** | `cursor-grok-4.6-high` 等 **无 `-fast`** 且带 tools 的计费行 | **0** | 任意 **&gt;0** | 持续日增 | 客户端改 **high-fast**；网关应已 `upgradeGrokRouteForTools` |
| **M11** | **单小时 unhealthy** | CST 小时桶 token 加权 hit | 无 **&lt;85%** 且 **in_wo≥1M** 的小时 | 1 个此类小时 | **≥2** 个或 **最差 &lt;80%** | 对齐 Agent 高峰；看该小时模型 mix 与 burst |
| **M12** | **Roll5 吞吐压力** | 1min 桶 **Roll5 RPM / Roll5 TPM** 全日最大值（by-model badge） | RPM **≤25** 且 TPM **≤2M** | RPM 26–40 或 TPM 2–5M | RPM **≥41** 或 TPM **&gt;5M** | 限流/减并行；对照 M13 是否瞬时更高 |
| **M13** | **1min 瞬时 RPM 尖峰** | 单分钟计费行数最大值 + **发生时刻 (CST)** | **≤25** | 26–40 | **≥41** | 与 **M5 streak / M16 burst** 同分钟 → 并行 subagent；台账必记时刻 |
| **M14** | **1min 瞬时 TPM 尖峰** | 单分钟 Σ(`in_wo+CR+Out`) 最大值 + **时刻 (CST)** | **≤2M** | 2–5M | **&gt;5M** | 长上下文批量推理；与 M15 同小时看成本 |
| **M15** | **单小时成本尖峰** | CST 小时 Σ`Cost` 最大值；辅：是否 **≥ max($12, 3× 当日有量小时中位数)** | 无超阈小时 | 1 个小时超阈 | **≥2** 小时超阈或单小时 **≥$20** | 拆模型（5min 堆叠）；区分热路径贵 vs 冷枪贵 |
| **M16** | **冷 burst × 请求尖峰共现** | `D.anomalies.bursts` 中心时刻 ±1min 内 **M13≥26** 或该分钟 **≥4 冷启动** | 无共现 | 1 段/日 | **≥3 段/日** 或共现且 **M11 同小时** | 预期：批量 Agent；异常：共现且 **M5≥20** 转 P0 查 id |

#### 请求 / 成本尖峰（与 cache 联动）

**尖峰 alone 不升格事故**（多为合法并发），但 **必须记录时刻**，并与 cache 指标 **同屏看**：

| 联动 | 含义 | 典型动作 |
|------|------|----------|
| **M13 高 + M5 11–19** | 并行新 thread 冷启动 | 控 subagent 并发；台账 **坏段** 写「CST 分钟 + streak 长」 |
| **M13 高 + M1 仍 ≥90%** | 热路径仍健康 | **O**；只记尖峰，不必当 S |
| **M15 高 + M11 低 hit** | 高峰又贵又缺缓存 | **S/P1** 强化；查 composer-2.5 占比 |
| **M15 高 + M3 高 hit** | 贵但主要是 **fast 热路径 + 大 CR** | 正常 heavy 使用；看 output/Grok 是否拉高 $ |
| **M16 共现** | burst 竖线与 RPM 柱 **同一时间** | 对齐 Agent 调度；非 9/1 类 id 问题时 **勿回滚网关** |

**读图顺序**（by-model）：吞吐 Tab（M12–M14）→ 5min 成本/Token 堆叠（M15 结构）→ 5min 命中率折线（同段 hit 是否掉）。

**台账字段**：除小时 hit 外，增加 **「请求尖峰 (CST)」**（M13/M14 时刻与数值）、**「成本尖峰 (CST)」**（M15 小时与 $）。

#### 优先级（怎么判事故）

| 级别 | 条件（满足任一） | 含义 |
|------|------------------|------|
| **P0** | M5 **≥ 20**；或 M1 **&lt;85%**；或 M3 **&lt;90%** 且 M5 **≥15** | 优先怀疑 **conversationId / session_fp**（9/1 类） |
| **P1** | M1 **&lt;90%**（不健康）；或 M2 **&lt;90%**；或 M7 **&gt;18%**；或 **M15 超阈且 M11 同小时 unhealthy** | 成本与 cache 偏离，**必须分析**（常见：标准 Composer + 并行 subagent） |
| **P2** | 仅 M4/M6/M12–M16 警告（**无 P0/P1**） | 记录尖峰与趋势；**M13≥41** 单独 → 台账 **O** 或坏段备注 |

#### 报告字段对照

| 指标 | HTML / JSON 位置 |
|------|------------------|
| M1,M4,M7 | `cache-cost` / `by-model` → `D.summary`（`global_hit`, `cold_pct`, `cold_cost`, `cost`） |
| M2,M3 | `by-model` → `D.perModel.model_summary[]`（`model`, `hit`, `cold_pct`, `cost`） |
| M5,M8,M9,M16 | `cache-cost` → `D.anomalies`（`cold_streaks`, `reships`, `token_mismatch`, `bursts`） |
| M11,M15 | `cache-cost` → `hour_hit[]`、`hour_inwo_m[]`、`hour_cost[]`（CST 小时） |
| M12–M14 | `by-model` → `D.throughput`（1min `rpm[]`/`tpm[]`、Roll5、压力 badge；见「吞吐计算标准」） |

#### 改阈值时

- **M1/M2/M3 的 90%** 为产品 SLO，与脚本「热路径 hit≥90%」离群检测一致；动阈值请 **同时改** 本节与 `analyze_team_usage*.py` 中汇总卡片文案（若有硬编码）。
- **M5 的 20/30** 来自 9/1 事故 streak 对照；**不要用 M6 单独驱动告警**（多 thread 交错时 M6 常年偏高）。
- **M12–M14 压力档** 与 `RPM_PRESSURE_BREAKS` / `TPM_PRESSURE_BREAKS` 同步改（`analyze_team_usage_chart_group.py`）；**M13 用瞬时 1min，M12 用 Roll5**，勿混读。

#### 事故台账（大小分级 · 时间记录）

**新条目只增不改**（结论变更用「备注 / 续记」）。编号：`INC-YYYY-MM-DD[-序号]`，同一导出日多条加 `-2`、`-3`。

##### 大小怎么定

| 分级 | 代号 | 判定（满足任一即可归入该档，**就高不就低**） | 典型处置 |
|------|------|---------------------------------------------|----------|
| **大事故** | **L** | **P0**；或 **M1 &lt; 85%**；或 **已确认**网关/会话 id 缺陷（如 random `conversationId`）；或 **M5 ≥ 30** 且 Composer 长会话 CR 持续≈0 | 停发/回滚、修网关、发版验证；写详细根因节（见 9/1） |
| **小事故** | **S** | **P1 且非 L**：如 **90% &gt; M1 ≥ 85%**、**M2 &lt; 90%**、**M7 &gt; 18%**；**M5 11–19** 且无 L 证据 | 运营侧优化（模型/并发）；抽查 `session_fp`；**不必**紧急发版 |
| **观察** | **O** | 仅 **P2** 或单小时噪声（如 **&lt;10 枪** 且 M1 仍 ≥90%） | 记入台账趋势，日报可略 |
| **已关闭** | — | 修复已上线 + 下一导出日指标回到健康 | 在条目「状态」标 closed，保留时间窗 |

**时间怎么写**

- **观测窗**：Team Usage CSV 覆盖的 **UTC 起止**，正文统一转 **CST**（`Date` 列）。
- **坏段**：除全天 summary 外，列出 **CST 小时** 或 **burst/streak 起止**（来自 `D.anomalies.cold_streaks` / 小时 hit），便于和 Agent 日志对齐。
- **尖峰时刻**：**M13/M14** 精确到 **CST 分钟**；**M15** 写到 **小时 + $**（可与 M11 hit 同列）。
- **发版关联**（若相关）：CST **push ≈ 线上 +1min**（Deno），与坏段比先后。

##### 条目模板（复制填写）

```markdown
### INC-YYYY-MM-DD — 【L/S/O】标题

| 字段 | 内容 |
|------|------|
| 分级 | L / S / O |
| 观测窗 (CST) | YYYY-MM-DD HH:MM — YYYY-MM-DD HH:MM |
| 主要坏段 (CST) | 例：09-04 12:00–13:00 hit 79.6%；07:20:26 streak 16 |
| 请求/成本尖峰 (CST) | 例：07:20 RPM=65；10:00 成本 $14.5/h |
| 触发指标 | M1=…% M2=… M5=… M13=… M15=… P0/P1/P2 |
| 用户/团队 | email / team id |
| 证据 | `team-usage-events-….csv`；`reports/usage-….html` |
| 根因结论 | 一句话 + 是否网关 |
| 状态 | open / mitigated / closed |
| 续记 | YYYY-MM-DD：… |
```

##### 已登记

###### INC-2026-09-01 — 【L】random conversationId，长会话 Cache Read 全灭

| 字段 | 内容 |
|------|------|
| 分级 | **L（大事故）** |
| 观测窗 (CST) | **2026-09-01** 全天（norin439 长会话）；坏段见下 |
| 主要坏段 (CST) | **22:41–22:45** 连续 **15** 次 CR≈0（`6dc1abc`）；**23:11–23:23** 连续 **50** 次 CR≈0（`0ccb04b`）；**23:23:54** 起修复后回升（`22376ac`） |
| 触发指标 | M1 极低；M5 **≥50**；滚动 20 **&lt;20%**；**P0** |
| 用户/团队 | norin439；`team-usage-events-29803137-2026-09-01 (2).csv` |
| 证据 | `reports/incident-2026-09-01-windows.html`；详述见下文 **「2026-09-01：每轮 random conversationId」** |
| 根因结论 | fingerprint 路径每轮 `randomId()`，非 KV/无状态设计本身；**已修** `session_fp` → `tenant:session_fp` |
| 状态 | **closed**（`22376ac`） |

###### INC-2026-09-05 — 【S】全局命中率未达 90%（SLO 边缘）

| 字段 | 内容 |
|------|------|
| 分级 | **S（小事故）** |
| 观测窗 (CST) | **2026-09-04 08:58** — **2026-09-05 22:36**（CSV 文件名 09-05） |
| 主要坏段 (CST) | **09-04 12:00** hit **79.6%**（255 枪，85 冷）；**09-04 18:00** hit **76.1%**；**09-05 07:20** streak **16**（~7s）；**09-05 16:00** in_wo **3.66M**、hit **89.2%**；22/31 小时 **&lt;90%** |
| 请求/成本尖峰 (CST) | **07:20** **M13 RPM=65**（与 streak 16 同段）；**09-04 10:00** **M15≈$14.5/h**（当日成本最高小时，fast 为主、hit **96.7%**）；16:00 成本 **≈$11/h** + 大 in_wo |
| 触发指标 | **M1（跨轮次）=91.7%**（T=**25000**、剔除 **590** 行）；含首轮 **89.63%**；**M5=16**；**M13=65** |
| 用户/团队 | cosima15102@corradyn.com；`team-usage-events-29803137-2026-09-05.csv` |
| 证据 | `reports/usage-2026-09-05-by-model.html`；`reports/usage-2026-09-05-cache-cost.html` |
| 根因结论 | 跨轮次看 **cache 正常**；含首轮偏低来自多会话 + **&gt;25k 的冷枪**（换轨整段 in_wo，**不算初始**） |
| 状态 | **closed（M1）**；坏段/尖峰仍作运营参考 |
| 续记 | T 固定 **25k**（前 **33k**→91.84%/604 行）；**33k→25k** 少剔 14 行、M1 **91.7%**；旧自适应 T=4096 只剔 157 行 |

###### INC-2026-09-09 — 【L】InferenceService/Stream 对 Dashboard `crsr_` 失效

| 字段 | 内容 |
|------|------|
| 分级 | **L（大事故）** |
| 观测窗 (CST) | **2026-09-09**（当日发现并改线；精确坏段以各环境打 Stream 的时间为准） |
| 主要坏段 (CST) | Dashboard `crsr_`：`exchange_user_api_key` / `GetUsableModels` 仍可能 200；`POST …/aiserver.v1.InferenceService/Stream` 稳定 `ERROR_NOT_LOGGED_IN`。聊天与 tools 全灭。 |
| 触发指标 | 产品路径不可用（非 M1/M5 cache SLO）；与 **9/1 conversationId** 无关 |
| 用户/团队 | 使用 Dashboard `crsr_` 的网关客户端（Cursor Agent 带 function tools） |
| 证据 | 本机探针 Stream 信封 `ERROR_NOT_LOGGED_IN`；同 key `GET https://api.cursor.com/v1/models` 200；`AgentService/Run` 可聊 |
| 根因结论 | **Cursor 上游**：Inference 这条 RPC 对 Dashboard API key 不再当已登录会话。不是网关把 model id / session_fp 弄丢。 |
| 状态 | **mitigated**：聊天改 `agent.v1.AgentService/Run` + 进程内 customTools（`684da64` / `454122d`）。Inference 仍死，禁止加回。 |
| 续记 | 2026-09-09：实机 Deno `8789` OpenAI probe 7/7、Anthropic `system`、`grok-4.6-fast` PONG。上游另拒 `excludeWorkspaceContext` 与 `customSystemPrompt`（`--system-prompt`）。同日稍后：废弃客户端 `x-session-id`，`conversationId` = `tenant:agentRunFp`（model/tools/system/第一条 user）；KV `agent-run:` 按 fp 绑 ids。当时 `execute()` park 仍必须同 isolate。Team Usage Cache Read 尚未用 CSV 验证。 **2026-09-09 夜：曾改文本 `<gw_tool_call>`（`mcpTools: []`）。2026-09-10 早：回到 custom-user-tools + 自拼 roots / `resumeAction`（`b97f6d7`）；禁止空 `{}`。同日稍后：自制 splice 带空 `turns: []` 盖掉 checkpoint，三句用户话忘上文 → **INC-2026-09-10**（`5c5218e`）。** |

###### INC-2026-09-10 — 【S】跟进 user 覆盖 checkpoint，第三句忘了第一句

| 字段 | 内容 |
|------|------|
| 分级 | **S（小事故）**（产品语义，非 M1/M5 cache SLO） |
| 观测窗 (CST) | **2026-09-10** 凌晨发 `b97f6d7` 后；09:08 起按三句用户话复现 |
| 主要坏段 (CST) | 同一会话：「你的工具有什么」→「调用一下」→「我的第一句话是什么」；第三句看不到第一句（假 host 的三轮 MCP park 仍绿） |
| 触发指标 | 产品验收失败（非 M1/M5）；`conversation_id` 往往仍稳定 |
| 用户/团队 | 走本网关的 Cursor Agent / OpenAI 客户端 |
| 证据 | 实机 `scripts/probe-session-memory.ts`（修后 `composer-2.5-fast` 第三句复述「你的工具有什么」）；单测 `three user sentences stay one session` |
| 根因结论 | **网关**：① 自制 state 带空 `turns: []` 抹上文；② `5c5218e` 跟进枪省略字段 → Cursor Agent 大 system 报 `Conversation state is required`。短 system / 假 host 测不出来。 |
| 状态 | **mitigated**：每枪必带自拼 roots；禁止省略。短 system 绿不算过关。 |
| 续记 | `/tmp` 是默认 cwd。`Prompt cache 4%` 常见于大 system 首轮。2026-09-10：本机 `8793` + `PROBE_PAD_CHARS=24000` 三句 3/3。同日对抗测试：OpenAI 大 system / stream / 三工具 / 并行会话过关；**Anthropic 跟进枪 400**（发出无 signature 的 thinking 又拒收）；**缺 Authorization 明文 500**（cloud handler 未 `await`）。同日稍后：`@cursor/sdk` `systemPrompt` = `customSystemPrompt`，本账号 `crsr_` 仍拒 `--system-prompt`；root blob 盖不住 harness（`scripts/probe-system-override.ts`）。 |

### 成本归因（简表）

- **冷启动 + 超长 in_wo**（10万+）：单枪 $0.05–0.07，换轨一次付清。
- **热路径长上下文**（CR 15万+、in_wo 小）：单枪 ~$0.04，正常。
- **Grok**：注意 `Cache Read=0` 冷枪与 **大 output**（如 out&gt;6k → $0.14），与 Composer 缓存逻辑分开看。

### 报告产物

- `reports/usage-<date>-cache-cost.html`：汇总卡片、按小时成本/命中、命中率分布、滚动命中、**时间轴散点 + burst 竖线**、冷启动 streak 表。
- 与事故对比图：`reports/incident-2026-09-01-windows.html`（若存在）。

### 定稿报告模板（by-model · 以后按此构建）

**主报告**用 `scripts/analyze_team_usage_chart_group.py`（单文件 HTML 模板 + JSON 内嵌）。**辅助**仍可用 `analyze_team_usage.py` 做 cache 事故向的时间轴 / burst / reships，二者互补，不互相替代。

```bash
# 从仓库根目录
python3 scripts/analyze_team_usage_chart_group.py \
  team-usage-events-<team>-<YYYY-MM-DD>.csv \
  -o reports/usage-<YYYY-MM-DD>-by-model.html

open reports/usage-<YYYY-MM-DD>-by-model.html
```

对外分享定稿：生成后用 `artifact` 上传 `reports/usage-*-by-model.html`（默认 7d，需要 30d 显式传 `ttl: 30d`）。

#### 页面结构（布局约定 · 勿随意加回重复图）

自上而下，保持紧凑、**禁止横向滚动**：

1. **Sticky 模型筛选**：chip 开关；**默认仅 Top4 使用量（请求次数）**；「全选 / Top4 使用量 / Top4 成本」；下方所有时序图同步 `enabled`（可点图例）。
2. **吞吐（统一 1 分钟标准 · CST）**  
   - `<details>` 折叠 **计算标准**（见下表）。  
   - **单面板 Tab**：`RPM` | `Token TPM`（320px）；柱色 = 压力档，灰线 = Roll5。  
   - **同一行** RPM + TPM 压力 badge（各自峰值）。
3. **结构占比**：一个 `pies-block`，**2×2** 环形图（**legend 关闭**，tooltip + 标题）；固定 4 张：
   - Composer vs Grok **成本**
   - 模型 **Top5 + 其他** 成本
   - 冷 / 热 **请求次数**（note 含冷热 $）
   - **命中率六档**（与 `build_report_data` bins 一致）
4. **模型汇总表**：全称 model id、可排序；Token 列自动 k/M/B。
5. **5 分钟桶 · 分模型**（**单面板 Tab**：成本 | Token | 请求）：堆叠柱；**与 1min 吞吐分开算**，仅看结构占比。
6. **缓存命中率**：5min 桶、分模型折线（300px hero）。

** intentionally 不再做**：分模型 1min RPM 堆叠、60s 滚动并发堆叠（与总览 RPM/Roll5 重复）。

#### 吞吐计算标准（改阈值只动脚本常量）

| 项 | 定义 |
|----|------|
| 时区 | CSV `Date` → **CST**（UTC+8） |
| 桶 | 秒归零的 **1 分钟**；无事件分钟填 0 |
| **RPM** | 该分钟内计费行数（`Cost≠Free` 且 `in_wo` 非空，同 `parse_rows`） |
| **TPM** | 该分钟 Σ(`in_wo` + `Cache Read` + `Output Tokens`) = `Total Tokens` |
| **Roll5** | 含当前分钟在内 **5 分钟** 的 RPM 或 TPM 之和 |
| **RPM 压力**（柱色） | 绝对档：`0` 空闲 · `1–10` 低 · `11–25` 中 · `26–40` 高 · `≥41` 极高 |
| **TPM 压力**（柱色） | 绝对档：`0` · `≤0.5M` · `≤2M` · `≤5M` · `>5M` tokens/min |

常量位置：`scripts/analyze_team_usage_chart_group.py` 内 `RPM_PRESSURE_BREAKS`、`TPM_PRESSURE_BREAKS`。不要用分位数给 RPM 上色（避免「柱上 19 RPM 却标成高压力」）。

#### 改模板时约束

- 饼图：**2×2**、`minmax(0,1fr)`、`overflow-x: hidden`；模型名 **全称**（`composer-2.5-fast`）。
- 5min 堆叠 Token 轴：按桶内 raw tokens 自动 k/M/B；**不要**与 1min TPM 混在同一 Y 轴口径里解释压力。
- 新 CSV 分析流程：**先跑 chart_group 出 by-model 定稿**；若怀疑 cache 事故再跑 `analyze_team_usage.py` 对照 burst/streak/reships。

---

## 2026-09-03：`gpt-5.6-luna` 是 Other Models，要额度

### 结论

`gpt-5.6-luna` / `terra` / `sol` 是 OpenAI 第三方模型，走 Cursor **Other Models** 池，**不是** Composer / Grok 所在的 **Cursor Models** 池。网关对未知 id **原样透传** `modelId`，不必先写简写映射才能打到上游。打不通通常是 **额度或地区**，不是协议。

### 实测（本仓库 `crsr_`）

| 路径 | 现象 |
|------|------|
| `GET /v1/models`（`GetUsableModels`） | 只回 **19** 条 Composer / Grok / Auto；**没有** `gpt-5.6-*` |
| 本机直连 Inference | `ERROR_CUSTOM_MESSAGE`：`This model provider is not supported in your region` |
| 生产 Deno 网关 | `ERROR_RATE_LIMITED`：`Trial usage limit reached`（Other Models **试用额度**用完） |
| 同 key `composer-2.5-fast` | 正常 `PONG`（Cursor Models 不受 Other Models 试用上限影响） |

复现：`node --experimental-strip-types scripts/probe-luna.ts`。

### Wire id

官方产品 id：`gpt-5.6-luna`。Inference route 常带 effort：

```text
gpt-5.6-luna-{none|low|medium|high|xhigh|max}(-fast)?
```

- `gpt-5.6-luna` / `gpt-5.6-luna-high` 上游认（本账号被额度/地区拦）
- `gpt-5.6-luna-fast`（无 effort）→ `ERROR_BAD_MODEL_NAME`
- Fast 用 `gpt-5.6-luna-high-fast` 这种带档位的 id

### 要用起来

1. 账号 **Pro 及以上**，且 **Other Models** 额度未耗尽（试用 key 常见 `Trial usage limit reached`）
2. 出口不在 Cursor 地区限制内（见 cursor.com/docs/account/regions）；本机受限时，生产 Deno 出口仍可能打到上游，然后才撞额度
3. **不要**用 `GetUsableModels` / `/v1/models` 判断「支不支持 Luna」——那个 RPC 只列 Cursor Models

### 约束

- 空 `content` + HTTP 200 + `error` = 上游拒，不是网关把 id 映射丢了
- 不要为了 Luna 去改 `session_fp` / `conversationId`
- 不要假设「列表里没有 = 网关没接」；Other Models 本来就不在 `GetUsableModels` 里

---

## 2026-09-02：`crsr_` 换票 L1；JWT 直连不存 KV

### 背景

生产客户端**只传** Cursor Dashboard 的 `crsr_…` API key（每次请求 Bearer），不传已换好的 JWT。会话仍 **无状态**（`session_fp` → `conversationId`，不写 KV）。  
此前：每个请求至少 **1 次 KV read** 查换票缓存；`eyJ…` JWT 也会读写 KV（无实际收益）。

### 改动（`b5de214`）

| 凭证 | 行为 |
|------|------|
| `crsr_…` | **L1**（进程/isolate 内 Map）→ **KV L2** → `exchange_user_api_key`；L1 命中则 **0 KV read、0 exchange** |
| `eyJ…` JWT | 直接作上游 Bearer，**不读不写 KV**（自测/脚本；非生产约定） |

L1 TTL 与 KV 一致：条目最长 **5 分钟**，且 JWT `exp` 前 **60s** 失效。

### 生产严肃性（发版评估）

| 维度 | 结论 |
|------|------|
| `session_fp` / prompt cache / Inference 协议 | **无改动** |
| 鉴权结果 | 与改前等价（仍是换票后的 JWT 打上游） |
| 风险等级 | **低～中**（性能/成本优化，非会话事故类） |
| 回滚 | revert 单 commit |
| 多 isolate | 冷 L1 仍走 KV L2，与改前一致；热路径更省 KV |

**不要与 9/1 conversationId 事故混淆**：本项只动 `getAccessToken`，不动 `conversationId`。

### 约束（后续改鉴权时）

- **不要**把 canon、messages 写回 KV（已删除的 canon 路径勿复活）。聊天路径允许 `agent-run:` 小绑定：`{fp, conversationId, agentSessionId, conversationState?}`，不要把 transcript 塞进去。
- **不要**在 `crsr_` 路径去掉 L1 又对每次请求强制 exchange（会打满 Cursor 换票与付费 KV）。
- Cloudflare：KV 仅作 **L2**；不绑 KV 时仍有 L1 + 内存 `createMemoryKv()`。

---

## 2026-09-01：每轮 `random` conversationId → 多轮 Cache Read 全 0

### 时间点（两次发版，两段落零）

Team Usage：`team-usage-events-29803137-2026-09-01 (2).csv`（norin439，Composer 长会话）。Deno 跟 `main`，**push ≈ 线上生效 +1min**。

| CST | UTC | commit | 用量 |
|-----|-----|--------|------|
| **22:40:05** | 14:40 | `6dc1abc` hash-only KV | **22:41:32–22:45:41** 连续 **15** 次 Cache Read≈0（前 2 枪仍 99%） |
| **23:10:27** | 15:10 | `0ccb04b` 删 KV canon | **23:11:29–23:23:39** 连续 **50** 次 ≈0（23:11:03/09 仍 99%） |
| **23:22:42** | 15:22 | `22376ac` fg=conversationId | **23:23:54** Grok-fast 先回 99.5%；23:24 后 Composer 多数 98–99% |

`41e7376`（22:14）已把 `upstreamConversationId = randomId()` 写进 fingerprint；当天两次发版把这条路径推上生产。图：`reports/incident-2026-09-01-windows.html`。

### 现象

同一 Agent 对话多轮：`Input (w/o Cache Write)` 接近整段 history，**Cache Read 恒为 0**。网关 200、正文正常，只是前缀缓存全灭。

### 引入提交

`0ccb04b` — *feat: stateless session_fp (no KV canon)*

正确方向是：**fingerprint 不算 KV、不 409**。错误是把「无状态」理解成「每轮新 conversation id」。

### 根因（大 bug）

**Cursor Inference 的 prompt cache 绑在稳定的 `conversationId` / `x-session-id` 上，不是只看 messages 字节。**

`session_fp` 本应就是 conversation id（同 thread 多轮不变；换 model / effort / tools / system / 第一条 tool 前的内容 → 新 id）。写成 `randomId()` 后，Cursor 每轮当新会话，**即使 history 单调 append 也 0 缓存**。

### 修复

`22376ac` — *fix: use session_fp as Cursor conversationId for prompt cache*

- fingerprint：`conversationId` = `sessionId` = `conversationGroupId` = `tenant:session_fp`
- **禁止** fingerprint 路径每轮 `randomId()`
- `SESSION_MODE=random` 才用随机 id（调试，预期无 cache）

### 约束（后续改 session 时务必遵守）

| 内容 | 策略 |
|------|------|
| `session_fp` | SHA256(modelId ⟂ effort ⟂ flags ⟂ tools ⟂ system ⟂ pipeline[0..第一条 tool]) |
| 上游会话 id | **`tenant:session_fp`**，与 `x-session-id` 一致 |
| KV | Inference **不存** canon；AgentService 只存 `agent-run:` 小绑定（ids ± compact checkpoint），不靠 KV park `execute()` |
| 换轨 | fg 变 = 新 thread = 新 conversationId（cache 从 0 再积） |

不要再假设「Cursor 只按 messages 前缀 cache、id 可以乱跳」。

---

## 2026-08-31：`stream: true` 下 Composer 工具调用崩溃

### 现象

Cursor Agent 走本网关（`stream: true`）时，一旦模型触发 `tool_calls`，即报错：

```text
Agent execution failed: LLM error: model protocol error: provider failure
```

无 tools 的普通对话流式正常；问题仅在工具调用路径出现。

### 引入提交

`d85819d` — *feat: true OpenAI SSE streaming with abort and Deno integration tests*

该提交把 `stream: true` 从「先跑完整推理再一次性拼 SSE」（`openaiSseBody`）改成「Connect 帧边收边转 OpenAI SSE chunk」（`streamOpenAiChatCompletion` + `sseChunksFromConnectFrame`）。

### 根因

**Cursor Agent 不接受增量 `tool_calls` SSE。**

新实现按 OpenAI 常见流式写法，把 `toolCallPart` 拆成多帧下发：

1. 先发 `function.name`
2. 再逐段发 `function.arguments` 片段

而 Cursor Agent 作为 provider 客户端，期望的行为与旧版 `openaiSseBody` 一致：

- 文本 / thinking：可以增量 `delta.content` / `delta.reasoning_content`
- **tool_calls：必须在流结束前以一个完整 delta 一次性给出**（含 `id`、`type`、`function.name`、`function.arguments` 全量 JSON）

协议不匹配时，Agent 侧解析失败，表现为 `model protocol error: provider failure`。

### 修复

提交 `42f8e85` — *fix: emit complete tool_calls in stream=true SSE for Cursor Agent*

1. `sseChunksFromConnectFrame`：只缓冲 `toolCallPart`，**流式过程中不向客户端发 tool delta**
2. `enqueueOpenAiSseFinish`：在 `finish_reason` 之前，仿 `openaiSseBody` **一次性 emit 完整 `tool_calls`**
3. 流式 `streamOpenAiChatCompletion` / `streamAnthropicMessage` 的 `x-session-id` 须与非流式一致：`prepared.sessionId`（`tenant:session_fp`），与 Connect body 的 `conversationId` 相同；勿用裸 `prepared.clientId`

相关测试：`src/lib/connect_stream.test.ts` — *OpenAI SSE stream emits complete tool_calls delta at end*。

### 约束（后续改流式逻辑时务必遵守）

| 内容 | 流式策略 |
|------|----------|
| `textPart` / `thinkingPart` | 可增量下发 |
| `toolCallPart` | **缓冲至流结束，再发一条完整 `delta.tool_calls`** |
| `finish_reason` | 有 tool 时为 `tool_calls`，否则 `stop` |

不要假设「标准 OpenAI 流式 tool_calls 分片」对所有客户端通用；**本网关的首要兼容目标是 Cursor Agent + `stream: true`**。

### 验证

```bash
npm test   # 含 connect_stream tool_calls 用例
```

线上：重启 gateway 后，Composer + tools + `stream: true` 应能正常进入 tool 执行轮次。

---

## 2026-08-31：Grok `max_tokens` 过低导致「无返回」

### 现象

`grok-4.6` / `grok-4.6-fast` + `stream: true` 时，客户端偶发或稳定**看不到任何正文**（只有 `role` 首包，或直接失败）。Composer 同配置正常。

### 根因

Grok 在 Cursor 侧会把 `modelConfig.maxTokens` **先用于内部推理**，再输出可见 `textPart`。客户端若带较小的 `max_tokens`（常见 64、128），预算在出字前就被耗尽，上游返回：

```text
Provider exceeded max output tokens.
```

流式响应里可能没有 `delta.content`，只有 `error` 与 `finish_reason: stop`；部分客户端不展示 `error` 字段，表现为「发了请求但无返回」。

实测（`grok-4.6-fast` + `stream: true` +「Reply PONG」）：

| `max_tokens` | 结果 |
|--------------|------|
| ≤ 96 | 常无 content，带 OUTPUT_TOKEN_LIMIT |
| ≥ 128 | 通常有 content（仍随账号/负载波动） |

### 修复

`cursorBody` 对 Grok route（`cursor-grok-*` / `grok-4.6*`）将 `max_tokens` **下限抬到 512**（`GROK_MIN_MAX_TOKENS`），避免 Agent 默认小 cap 把 Grok 憋死。Composer 等非 Grok 模型原样透传。

实现：`isGrokModel`、`normalizeMaxTokensForModel`（`src/lib/inference.ts`）；单测：`src/lib/inference.model.test.ts`。

### 备注

- 推荐对外使用 **`grok-4.6-fast`**；标准 `grok-4.6` 延迟明显更高（十秒级），易被误认为卡住。
- 若需严格控费，客户端应显式传足够大的 `max_tokens`，而不是依赖极小默认值。

---

## 2026-08-31：Grok `grok-4.6-high-fast` 等别名未映射 → 无返回

### 现象

配置 `model: "grok-4.6-high-fast"`（或 `grok-4.6-medium-fast`、`grok-4.6-xhigh-fast` 等带 effort 的简写）时，流式响应只有 `role` 首包 + `error`，**无任何 `content`**。`grok-4.6-fast` / `cursor-grok-4.6-high-fast` 正常。

### 根因

`parsePublicGrokModel` 只识别 `grok-4.6` / `grok-4.6-fast`，**不识别**文档映射表里的 `grok-4.6-{effort}(-fast)?` 形式。未映射的 id 原样写入 `modelId`，Cursor 返回 `ERROR_BAD_MODEL_NAME`。

### 修复

扩展 `parsePublicGrokModel` 解析 effort + fast 后缀，并映射到 `cursor-grok-4.6-{effort}(-fast)?`；`reasoning_effort` 请求体字段仍可覆盖嵌入 effort。

推荐客户端使用：

- `grok-4.6-fast` / `grok-4.6`（简写）
- 或 `/v1/models` 返回的 `cursor-grok-*` 原生 id

---

## 2026-08-31：`grok-4.6`（无 fast）+ tools → 无返回

### 现象

`model: "grok-4.6"`（映射为 `cursor-grok-4.6-high`）在 **带 tools** 时流式无任何 `content` / `tool_calls`；纯文本对话正常。`grok-4.6-fast` + tools 正常。

### 根因

Cursor Inference 的 **非 fast Grok flat route**（`cursor-grok-4.6-high`、`medium`、`low`、`xhigh`）**不支持 tool calling**，上游返回 `ERROR_PROVIDER_ERROR` / 422。Agent 必带 tools，因此表现为 Grok 标准档「完全无返回」。

### 修复

`cursorBody` 在请求含 `tools` / `providerDefinedTools` 时，对非 fast 的 `cursor-grok-*` route 自动追加 `-fast`（`upgradeGrokRouteForTools`）。无 tools 时仍走标准档 route。

| 请求 | tools | 实际 route |
|------|-------|------------|
| `grok-4.6` | 无 | `cursor-grok-4.6-high` |
| `grok-4.6` | 有 | `cursor-grok-4.6-high-fast` |
| `grok-4.6-medium` | 有 | `cursor-grok-4.6-medium-fast` |

---

## 2026-08-31：OpenAI `image_url` 必须映射为 Cursor `InferenceImagePart`

### 现象

OpenAI Chat Completions 带图（`content: [{type:text},{type:image_url}]`）时，模型当纯文本处理，完全看不到图片。

### 根因

`openaiMessagesToCursor` 对 user 消息调用 `flattenContent`，只抽取 `text` part。`image_url` 被静默丢弃。

Cursor `InferenceService/Stream` 的 `InferenceCoreMessage` 是 **oneof content**：要么 `text`，要么 `parts`（不能把图塞进 `text` 字符串）。图片字段来自 workbench proto：

```text
InferenceContentPart  oneof part { text | image | file }
InferenceImagePart    data: string (裸 base64，非 data URL)
                      mime_type → JSON camelCase mimeType
```

Connect JSON 形状（与现有 prompt-cache `parts.parts[].text` 一致）：

```json
{
  "role": "INFERENCE_MESSAGE_ROLE_USER",
  "parts": {
    "parts": [
      { "text": { "text": "这张图里有什么？" } },
      { "image": { "data": "<raw base64>", "mimeType": "image/png" } }
    ]
  }
}
```

### 修复

提交 `27023de` — *feat: map OpenAI image_url to Cursor InferenceImagePart*

1. 有图时走 `parts`，无图仍用 `text`（避免改变纯文本路径）
2. `data:image/...;base64,...` 本地拆 mime + payload；`http(s)` 由网关拉取再编码（上限 10MB）
3. 非法 scheme / 缺 url / 超限 → `ImageInputError` → **400**

相关测试：`src/lib/inference.model.test.ts`；Deno 集成：`tests/deno_gateway.integration.test.ts` — *forwards OpenAI image_url as Cursor image parts*。

### 约束（后续改消息转换时务必遵守）

| 内容 | 策略 |
|------|------|
| 纯文本 user | `{ role, text }` |
| 含 `image_url` / `input_image` / Anthropic `image` | **`parts.parts[]`，`image.data` 为裸 base64** |
| 文件 `file` / `document` | `parts.parts[].file`（`data` + `mediaType` + `filename`） |
| tool 结果里的图 | `toolContent.parts[].experimentalContent` |
| `image.data` | **不要**带 `data:` 前缀；mime 放在 `mimeType` |

不要把多模态 content 重新 flatten 成字符串；Cursor 没有「图 URL 写在 text 里」这条路径。

---

## 2026-08-31：Inference 协议缺口补全

对照 `InferenceStreamRequest` / `InferenceContentPart` 与 OpenAI/Anthropic 表面，一次补上能转的字段；Cursor 没有的能力给明确错误，不要假装成功。

### 已接到 Cursor proto

| 能力 | 实现 |
|------|------|
| Anthropic 图片 / document | `anthropicToCursor` → 同 `InferenceImagePart` / `InferenceFilePart` |
| Anthropic `stream: true` | `streamAnthropicMessage`（`event:` + `data:`）；tool_use **整块**在结束时发出，与 OpenAI 不增量 tool_calls 同一约束 |
| Composer Max | `requestedModel.maxMode`（`max` / `max_mode` / `metadata.max`） |
| `tool_choice` / `parallel_tool_calls` | 过滤 tools + `<tool-policy>` 注入（proto 无原生字段） |
| Tool result 嵌图 | `experimentalContent` |
| `top_p` / `stop` | `modelConfig.topP` / `stopSequences` |
| `max_completion_tokens` | `max_tokens` 别名 |
| `providerDefinedTools` | 非 function 的 OpenAI tools + `provider_defined_tools` |
| `invocationId` / `automationId` / `inferenceReason` | 请求体透传 |
| 响应 `image_descriptions` | `collectTurn`；JSON 字段 / SSE 末包 |

### 不能接（Cursor Inference 无此 RPC）

| 路径 | 行为 |
|------|------|
| `/v1/embeddings` `/v1/audio/*` `/v1/images/*` `/v1/responses` | **501** |
| `n > 1` | **400** |
| `seed` / `logprobs` / penalty | 忽略 |
| Images 像素 | Inference 只回 `generate_image` tool_call，见实验脚本 |

### 约束

- 流式 **tool 调用**：OpenAI 与 Anthropic 都在结束前一次性给出完整块（Cursor Agent 不接受增量 tool 分片）。
- `maxMode` 不是 `composer-*-max` route，不要改 `modelId`。
- `response_format` 只是 prompt 约束，不是服务端 JSON schema 强制。
