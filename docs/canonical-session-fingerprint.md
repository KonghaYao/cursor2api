# Session fingerprint（无 KV）

**状态**：Normative  
**版本**：3.0

每请求：pipeline 客户端 `messages` → 算 **一条** `session_fp` → 上游 **`conversationId` / `x-session-id` = `tenant:session_fp`**（Cursor prompt cache 绑这个 id）。messages = pipeline 结果。**`session_fp` 变 = 新 thread / 新 conversationId。**

---

## 公式

**RS** = ASCII `U+001E`

```
modelId = upgradeGrokRouteForTools(
  resolveCursorModelRoute(model, { fast, reasoning_effort }).routeId,
  tools.length > 0,
)

effort     = extractReasoningEffort(body)     // 未设则为 ""
flags      = stableStringify({ fast, maxMode })
catalog    = toolsCatalogText(tools)
system     = body.system 与 messages 内 system/developer 拼接
prefix     = pipelined[0 .. 第一条 role=tool]   // 尚无 tool → 整段（pending）
transcript = canonicalSerialize(normalize(prefix, tools))

session_fp = SHA256_hex( join(RS, [
  modelId, String(effort), flags, catalog, system, transcript
]) )
```

`normalize`：assistant `tool_calls` 按 id 排序 + `normalizeToolArguments`。

---

## 为什么包含 model / effort

Cursor `requestedModel` 含 **route（modelId）** 与 **parameters（fast / maxMode / reasoning_effort）**。同 messages、不同 model 或不同 effort 是不同推理环境，必须换 thread，否则 cache / 日志会把两条轨混在一起。

| 字段 | 进 hash | 说明 |
|------|---------|------|
| `model` → `modelId` | 是 | 含 Grok `-fast` 升级 |
| `reasoning_effort` | 是 | 可嵌在 model id 或 body |
| `fast` / `maxMode` | 是 | `requestedModel` flags |
| `tools` catalog | 是 | 你说的 tools |
| `system` | 是 | 你说的 sys |
| `messages[0..第一条 tool]` | 是 | 你说的锚点；后续轮次加长 **不改** 切片 |
| `temperature` / `max_tokens` | **否** | 未进 fingerprint（可再议） |
| `tool_choice` | **间接** | 会改 pipeline 前缀（`<tool-policy>`）从而改 `transcript` |

---

## 稳定性

| 情况 | `session_fp` |
|------|----------------|
| 正常续聊（第一条 tool 已出现） | **不变** |
| 尚无 tool，只加 user/assistant | **变**（pending：整段都在切片里） |
| 换 model / effort / fast / max | **变** → 新 thread |
| 换 tools / system | **变** |
| compact 改了第一条 tool 之前的内容 | **变** |

---

## 日志

```
session_mode=fingerprint session_fp=… canon_len=N
```

`crsr_…` 换票可走进程 L1 + KV L2；**客户端 JWT 不存储**。`SESSION_MODE=random` 不算 fp。

---

## AgentService 聊天路径

产品聊天不走 Inference。会话 id **完全内部计算**，忽略客户端 `x-session-id` / `conversation_id`。

**客户端合约（常态）：** 每轮 POST 都带 **全量** `messages`；客户端维持前缀稳定（只 append，不改第一条 user / 已有 assistant-tool 前缀 / system / tools）。网关从全量里抽出本轮 delta，**不要**把整段再送给 AgentService。

```
agentRunFp = SHA256_hex( join(RS, [
  modelId, effort, flags, catalog, system, serialize([{ role: user, text: firstUser }])
]) )

conversationId = tenant + ":" + agentRunFp
```

`firstUser` = messages 里第一条 `role=user`（跳过 `tool_result`）。这条锚能跨轮不变，是因为客户端保证前缀稳定，不是因为网关存了 transcript。park `execute()` 和跟进不必带客户端 session header，但跟进必须仍带上**同一条第一条 user**（完整 history）。

换 model / tools / system / 第一条 user → 新 thread。
