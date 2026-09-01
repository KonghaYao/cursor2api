# Canonical Session Fingerprint（内容锚点会话）

**状态**：Normative（网关实现须符合本文）  
**版本**：1.0  
**替代关系**：网关**仅**使用 canonical fingerprint（已移除 `active-session:{tenant}` sticky）；`conversationId` 每轮随机，**高 prompt cache 靠服务端 canonical transcript**。

**默认模式**：未设置 `SESSION_MODE` 时为 **fingerprint**。仅 `SESSION_MODE=random` 关闭 canon（调试）。

---

## 1. 目标与非目标

### 1.1 目标

1. **去除对 Cursor `conversationId` / 客户端 `x-session-id` 的语义依赖**：多轮续聊与 cache 前缀连续性由网关 **KV + 内容指纹** 保证。
2. **对齐 Cursor Inference 的 prefix cache**：每轮发往上游的 `messages` 为 **单调 append** 的规范化序列，使 `Cache Read` 随轮次增长、`Input (w/o Cache Write)` 仅尾部增量。
3. **会话绑定**：用 **环境指纹 `env_fp` + 锚点指纹 `anchor_fp`** 在 KV 中定位同一条 logical thread。

### 1.2 非目标

- 不实现 Cursor IDE 内部的 compact/summary 策略（可后续扩展）。
- 不保证「仅第一句 user」级别的会话唯一性。
- 不改变 Inference 协议；仍每轮 POST 完整 `messages`。

---

## 2. 概念

| 术语 | 含义 |
|------|------|
| **tenant** | API key 指纹（现有 `auth` 逻辑），隔离 KV 命名空间 |
| **env_fp** | 推理环境稳定哈希：模型 route、tools catalog、system、影响序列化的 body 标志 |
| **anchor_fp** | 对话锚点哈希：首个 **完整 tool 回合** 结束后的 Cursor 对话消息前缀（见 §4） |
| **thread_key** | KV 主键：`{tenant}:{env_fp}:{anchor_fp}`；锚点未闭合前用 `pending` 状态（§6） |
| **canon** | 服务端存储的 `CursorMessage[]`，为发往上游的唯一真相源 |
| **conversationId** | 每请求可 `randomUUID()`；**不参与** KV 查找 |

---

## 3. 规范化管道（指纹与上游必须一致）

指纹计算与 `cursorBodyFromClient` **必须使用同一管道**，顺序固定：

```
raw OpenAI messages[]
  → openaiMessagesToCursor(opts)
  → applyToolPolicy(messages, tools, body)     // tool_choice 变化会插入 <tool-policy>，纳入 env 或禁止变参
  → applyResponseFormat(messages, body)
  → injectToolsPrompt(messages, tools)         // <tools-rules>, <tools-catalog>
  → applyPromptCache(messages)                 // 与线上一致，含 cacheControl
```

**序列化** `canonicalSerialize(messages)`：

- UTF-8
- `JSON.stringify` 前对对象做 **递归 key 排序**（与 `stableStringify` 一致）
- 数组保持消息顺序；单条 message 内不 reorder parts（除 tool 合并规则另有规定）

**Tool arguments**（写入 canon 或参与 anchor 时）：

- 使用 `normalizeToolArguments(raw, schemaForTool(...))`

**多 tool_calls**：按 `tool_call_id` 字典序排序后再规范化。

---

## 4. env_fp（环境指纹）

```
env_fp = SHA256_hex( join("\x1e", [
  canonical_model_id,           // resolveCursorModelRoute 之后、含 Grok fast 升级前或后须固定一种：用 cursorBody 内实际 modelId
  toolsCatalogText(sorted_tools),
  fold_system(system/developer messages),
  stableStringify({ inject_tools_prompt, maxMode, reasoning_effort, fast }),  // 仅影响 body 的 flags
  tool_policy_salt,             // applyToolPolicy 若产生额外 user 前缀，将其稳定文本 hash 入 env
]) )
```

**规则**：

- `env_fp` 变化 ⇒ **新 thread**，不得复用旧 canon。
- system 每轮变化是预期行为时，应接受新 session（不强行 merge）。

---

## 5. anchor_fp（锚点指纹）

### 5.1 对话消息定义

在 `injectToolsPrompt` 之后，**对话消息** = 去掉下列前缀后的剩余消息：

- `<tools-rules>`
- `<tools-catalog>`
- `<system>`
- `<tool-policy>`（若存在）
- `<output-format>`（若存在）

### 5.2 首个完整 tool 回合（First Complete Tool Round, FCTR）

在对话消息序列上扫描：

1. **第一个对话 user**（记为 U₁）
2. **其后第一个含 tool 的 assistant**（A₁：assistant 消息在 Cursor 形态下带 tool_calls / toolCallParts）
3. **A₁ 引用的全部 tool 结果消息**（按 tool_call_id 关联，顺序按 id 排序）

**FCTR 闭包** = 从 U₁ 到上述 tool 结果 inclusive 的最短连续子序列。

若首轮仅有 user + assistant 纯文本、**尚无 tool**：

- **锚点未闭合**：不计算最终 `anchor_fp` 用于 KV commit；进入 §6 pending。

### 5.3 anchor_fp 计算

锚点未闭合时：

```
anchor_fp = "pending:" + SHA256_hex( canonicalSerialize(对话消息至今) )
```

锚点闭合后（FCTR 完整）：

```
anchor_fp = SHA256_hex( canonicalSerialize(FCTR 闭包内的对话消息) )
```

**注意**：A₁ 在 tool 之前的 **正文 text** 必须包含在闭包内（避免「同 U₁ + 同第一次 tool、不同中间 assistant」撞车）。

---

## 6. KV 状态机

### 6.1 Key

```
thread_key = `${tenant}:${env_fp}:${anchor_fp}`
```

`anchor_fp` 以 `pending:` 开头时，**哈希每轮随对话增长而变**；KV 用 `canon:{tenant}:{env_fp}:active_pending` **单槽**续传 canon（append-only），闭合后迁入 `canon:{tenant}:{env_fp}:{final_anchor_fp}`。同一 `tenant+env` 下第二条进行中的 pending 对话若前缀冲突且已有 `turnCount>1` → **409**。

推荐结构：

| Key | Value |
|-----|--------|
| `canon:${tenant}:${env_fp}:${anchor_fp}` | `{ canon: CursorMessage[], updatedAt, turnCount }` |
| `thread_token:${tenant}:${randomId}` | `{ env_fp, anchor_fp }`（可选：首轮闭合后下发给客户端，减轻重算） |

TTL：与现有 `KV_TTL_SECONDS`（5 分钟）一致，滑动续期。

### 6.2 每轮处理

**输入**：tenant、body（含 OpenAI messages、tools、model）、可选 `thread_token` / explicit `conversation_id`（explicit 仍优先，兼容旧客户端）。

1. 计算 `env_fp`。
2. 跑规范化管道得到 `cursorMessages`（客户端全量或增量经 merge，见下）。
3. 计算 `anchor_fp`（pending 或 final）。
4. **Lookup**：
   - 有 `thread_token` → 直接取 `env_fp`+`anchor_fp`
   - 否则 `GET canon:${tenant}:${env_fp}:${anchor_fp}`（pending 阶段用 pending hash）
5. **Merge**：
   - **MISS**：`canon = cursorMessages`（来自客户端全量，须与管道一致）
   - **HIT**：`canon' = appendOnly(canon, suffix(cursorMessages))`  
     - `suffix` = 客户端消息相对 canon 的新增尾部；若客户端改写 canon 前缀 ⇒ **409 / 新 thread**（不 silent corrupt）
6. `SET` KV，`turnCount++`。
7. **上游**：`cursorBodyFromClient(body, { messages: canon', ... conversationId: randomUUID() })`。

### 6.3 appendOnly 规则

- 仅允许在 canon 末尾追加新 message（或追加 tool 结果）。
- 长度校验：`canon.length <= cursorMessages.length` 且 `canon` 与 `cursorMessages[0..canon.length-1]` 逐条 `canonicalSerialize` 相等。

---

## 7. 会话模式

| 模式 | 行为 |
|------|------|
| `fingerprint`（**默认**） | 本文 canonical fingerprint + KV canon |
| `SESSION_MODE=random` | 每请求 random id，无 KV canon（仅调试） |
| `conversation_id` / `x-session-id` / `x-thread-token` | 可作 **thread_token 查找**；**不**跳过 canon |

环境变量：`SESSION_MODE` = `fingerprint`（默认）\| `random`。遗留 `sticky` 视为 `fingerprint`；`SESSION_STICKY` 已移除。

---

## 8. Prompt cache 推论（运维）

- **不依赖** `conversationId` 稳定；依赖 **canon 前缀字节稳定**。
- 客户端 compact 改写 FCTR 之前内容 ⇒ 新 `anchor_fp` ⇒ 新 thread + cache 换轨。
- 日志建议输出：`session_mode=fingerprint env_fp=… anchor_fp=… canon_len=… merge=hit|miss|conflict`。

---

## 9. 测试要求

### 9.1 单元测试（`session_fingerprint.test.ts`）

1. 相同 OpenAI 输入两次，`env_fp` / `anchor_fp` 一致。
2. 改 tool schema、`env_fp` 变。
3. FCTR 闭合前后 `anchor_fp` 从 `pending:` 变为 final。
4. `appendOnly`：合法追加合并；篡改中间 message 拒绝。
5. `canonicalSerialize` 键序无关稳定。

### 9.2 集成脚本（`scripts/verify-fingerprint-session.sh`）

- 两轮 Agent 式对话（含 tool 或模拟多轮 messages），**不传** `conversation_id`。
- 断言：KV/canon 合并后第二轮 `canon` 长度 ≥ 第一轮；响应头可带 `x-thread-token`（若实现）。
- 可选：对比 `x-session-id` 可不同（若实现 random conversationId）但业务续聊一致。

---

## 10. 开放问题（v1.1）

- 纯文本长会话无 tool：pending → 用「第 N 条 user」或超时升格 anchor 的策略。
- canon 体积上限与裁剪。
- 与 Peri `x-session-id` 的 `conversationGroupId` 是否保留映射。

---

## 11. 参考文献

- 网关 `applyPromptCache`、`injectToolsPrompt`、`toolsCatalogText`：`src/lib/inference.ts`
- 实现：`src/lib/session_fingerprint.ts`、`src/lib/session.ts`
- 开发备忘：prompt cache 须完整 tool_calls SSE、前缀稳定性：`CLAUDE.md`
