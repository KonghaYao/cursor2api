# Session fingerprint（无 KV）

**状态**：Normative  
**版本**：3.0

每请求：pipeline 客户端 `messages` → 算 **一条** `session_fp` → 日志；上游 messages = pipeline 结果。`conversationId` 每轮随机。**`session_fp` 变 = 新 thread。**

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

JWT KV 与 session 无关。`SESSION_MODE=random` 不算 fp。
