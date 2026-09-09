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

如果要用工具调用（function tools），每次请求带上同一个 `x-session-id`（或 `conversation_id`）。网关不会替你跑工具：模型给出 `tool_calls` 后，你在本地执行，再把结果用 `role: tool` 发回来。

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
| 流式 `stream: true` | 可用，但不逐字推 | 能收到 SSE；正文往往等这一轮结束后一次性出来。工具调用仍是一整块，不会拆碎 |
| 工具调用 | 可用 | 和 OpenAI / Anthropic 一样：先拿到 `tool_calls` / `tool_use`，本地执行后再回传结果 |
| `system` 提示 | 可用 | 同一会话里，系统提示只在第一轮生效 |
| 上下文缓存 | 部分可用 | 网关不重启时，同一会话多轮能复用上下文、费用会低一些。一重启或重新发版，会话会断，缓存要从头开始。账单侧的缓存命中还没完整核对 |
| `usage` 用量 | 可用 | 响应里有 token 数。OpenAI 看 `prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens`；Anthropic 看 `input_tokens`、`output_tokens`、`cache_read_input_tokens`。模型正在等你跑工具时，这一枪的 usage 经常是 0，最终回复那一枪才带上整轮 |
| Fast 档 | 可用 | 模型名带 `-fast`，或请求体写 `"fast": true`。`composer-2.5`、`grok-4.6` 默认是标准档，不是 Fast |
| 思考强度 effort | 可用（仅 Grok） | 用 `reasoning_effort`（`low` / `medium` / `high` / `max`）。不写则按 `high`。Composer 没有这个档位 |
| Composer Max | 不可用 | 请求里的 `max` / `max_mode` 目前不会生效 |
| 思考过程 thinking | 可用 | OpenAI 看 `reasoning_content`；Anthropic 看 `thinking` 块。只转发明文思考，不转发加密内容 |
| 图片 | 可用 | 用户消息里的 `image_url` / Anthropic `image`（data URL 或 http 图）会转给模型。文件附件还不行 |
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
| 2026-09-09 | Cursor 把旧版聊天接口整条删了，本网关已改到现行接口 | 已绕开 |
| 2026-09-01 | 会话 id 每轮随机，长对话缓存全灭 | 已修 |
| 2026-09-05 | 当天全局缓存命中略低于目标，本身不是缓存坏了 | 已关闭 |
