# cursor2api

把 Cursor 的模型接到 OpenAI / Anthropic 常用接口上。用 Cursor Dashboard 里的 `crsr_` API key 即可。

线上地址：`https://cursor2api.freetavily.deno.net`

---

## 怎么用

**OpenAI SDK**

```text
baseURL = https://cursor2api.freetavily.deno.net/v1
apiKey  = crsr_你的key
model   = composer-2.5
```

**Anthropic SDK**（`baseURL` 不要再加 `/v1`，SDK 会自己拼 `/v1/messages`）

```text
baseURL = https://cursor2api.freetavily.deno.net
apiKey  = crsr_你的key
model   = composer-2.5
```

请求里带 `Authorization: Bearer …` 或 `x-api-key` 都行。不要把换好的 JWT 写进配置。

网关自己根据模型 / 思考档 / Fast / 工具 / 系统提示 / **第一条 user** 计算会话；客户端的 `x-session-id` / `conversation_id` **会被忽略**。网关不会替你跑工具：模型给出 `tool_calls` 后，你在本地执行，再把结果用 `role: tool` 发回来。每一枪都请带上**完整** `messages`（从第一条 user 起只往后追加，不要改前面的内容）。网关把已有上文拼进 Cursor 会话状态，本轮只把**新的** user 文本（或刚回的 tool 结果）发给模型；不要只发最后一条。

```bash
curl -sS https://cursor2api.freetavily.deno.net/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"hi"}]}'
```

---

## 兼容性

| 能力 | 状态 | 用户侧含义 |
|------|------|------------|
| 文本聊天 | 可用 | OpenAI `/v1/chat/completions`、Anthropic `/v1/messages` |
| 流式 `stream: true` | 可用 | 立刻回 SSE（含 keepalive）；正文/思考在 AgentService 推出 `textDelta`/`thinkingDelta` 时转发。Composer 常在想完后短时间打出全文。工具调用仍是一整块 |
| 工具调用 | 可用 | 和 OpenAI / Anthropic 一样：先拿到 `tool_calls` / `tool_use`，本地执行后再回传结果 |
| `system` 提示 | 部分可用 | 会随会话进 Cursor 的对话 roots，**叠在** Cursor 自带助手设定上面，换不掉「Composer / 工作区 / 文件工具」那套身份。官方 SDK 的 `systemPrompt` 能整段替换，但要账号开门，而且只给 SDK 本机 agent；Dashboard `crsr_` 一发仍是 `unknown option '--system-prompt'`。同一会话里改 system 会开成新对话 |
| 上下文缓存 | 部分可用 | 同一条对话（**第一条 user** + 模型 / 思考档 / Fast / 工具 / 系统提示不变）会复用 Cursor 会话。传 `x-session-id` / `conversation_id` 没用。Deno Deploy 的 KV 只记会话 id（24h）和上次处理到第几条 message（5 分钟），**不存聊天正文**；换实例也能续上。每一枪都会开关到 Cursor 的后向连接；你跑完工具再 POST `role: tool` 时是**新的一轮**，不是把结果塞回上一枪还开着的那条流 |
| `usage` 用量 | 可用 | 响应里有 token 数。OpenAI 看 `prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens`；Anthropic 看 `input_tokens`、`output_tokens`、`cache_read_input_tokens`。模型正在等你跑工具时，这一枪的 usage 经常是 0，最终回复那一枪才带上整轮。**缓存命中率**请用 `CR/(CR+未命中 input)`（与 Team Usage 一致）；不要用 `cache_read_input_tokens / input_tokens`（Anthropic 的 `input_tokens` 只是未缓存部分，会算成 300%+）。多枪 usage 汇总用 `aggregatePromptCacheHitPercent`（`agent_json.ts`） |
| Fast 档 | 可用 | 模型名带 `-fast`，或请求体写 `"fast": true`。`composer-2.5`、`grok-4.6` 默认是标准档，不是 Fast |
| 思考强度 effort | 可用（仅 Grok） | 用 `reasoning_effort`（`low` / `medium` / `high` / `max`）。不写则按 `high`。Composer 没有这个档位 |
| Composer Max | 不可用 | 请求里的 `max` / `max_mode` 目前不会生效 |
| 思考过程 thinking | 可用 | OpenAI 看 `reasoning_content`；Anthropic 看 `thinking` 块。只转发明文思考，不转发加密内容 |
| 图片 | 可用 | 用户消息里的 `image_url` / Anthropic `image`（data URL 或 http 图）会转给模型 |
| `max_tokens` | 不可用 | 目前限制不住上游输出长度 |
| 模型列表 | 可用 | `GET /v1/models`。列表里没有的第三方模型（例如 Luna）仍可能能打，差的是账号额度或地区，不是网关没接 |
| 部署环境 | Deno / Node 可用 | Cloudflare Workers 上聊天会失败 |

---

## 模型

日常用 `composer-2.5`，比 Fast 便宜。

| 你写的 `model` | 实际效果 |
|----------------|----------|
| `composer-2.5` | 标准档 |
| `composer-2.5-fast` 或 `"fast": true` | Fast 档 |
| `grok-4.6` | 标准档，思考强度默认 high |
| `grok-4.6-fast` | Fast 档，思考强度默认 high |
| `grok-4.6-low` / `grok-4.6-medium` | 标准档，思考强度按名字 |
| `grok-4.6-fast` + `"reasoning_effort": "max"` | Fast + 最强思考 |
| `gpt-5.6-luna` 等 | 原样转给 Cursor；列表里可能看不到 |

带工具时，Grok **不会**被自动改成 Fast。想用 Fast 就写 `grok-4.6-fast`。

更细的对照表见 `docs/models.md`。

```bash
curl -sS https://cursor2api.freetavily.deno.net/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" \
  -d '{"model":"grok-4.6-fast","reasoning_effort":"max","messages":[{"role":"user","content":"hi"}],"max_tokens":256}'
```

---

## 目前做不到的

- 一次请求出多条回复（`n > 1`）
- embeddings、语音、画图、Responses API
- Anthropic 的服务端工具、citations、`top_k`
- `response_format` 不会在服务端强制 JSON Schema

网关也不会去改你的代码、跑 shell。Cursor 自带的那些编辑/搜索工具是关掉的。

---

## 事故记录

详情和修复过程看 git / `CLAUDE.md`，这里只记结论。

| 日期 | 说明 | 状态 |
|------|------|------|
| 2026-09-12 | 同一对话上一轮 Write/Read 还能跑，下一轮模型说没有 Edit/Write/Bash、只剩 MCP。是网关跟进枪工具目录和政策不一致，不是客户端自己换了 tool 列表 | 已修 |
| 2026-09-09 | Cursor 把旧版 `InferenceService/Stream` 整条删了；网关聊天只走 AgentService，该路径已从入口移除 | 已移除 |
| 2026-09-01 | 会话 id 每轮随机，长对话缓存全灭 | 已修 |
| 2026-09-05 | 当天全局缓存命中略低于目标，本身不是缓存坏了 | 已关闭 |
