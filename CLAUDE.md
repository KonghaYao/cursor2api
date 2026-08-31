# 开发备忘 / 踩坑记录

供后续改网关或接 Cursor Agent 时对照，避免重复踩坑。

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
3. 顺带修正 `streamOpenAiChatCompletion` 的 `x-session-id`：误用 `tenant:clientId`，改回与非流式一致的 `clientId`

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
