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
