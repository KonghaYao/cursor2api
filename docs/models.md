# 模型 id 与 Cursor 路由

网关把客户端的 **OpenAI 风格 `model` 名** 映射为 Cursor `GetUsableModels` / `InferenceService/Stream` 使用的 **flat route id**（写入 `modelId` 与 `requestedModel.modelId`）。

实现：`src/lib/inference.ts` 中的 `resolveCursorModelRoute`、`extractFastMode`、`extractReasoningEffort`、`mapGrokEffort`。单测：`src/lib/inference.model.test.ts`。

## `GET /v1/models`

返回 Cursor 账号下 **原生 route id**（如 `cursor-grok-4.6-high-fast`、`composer-2.5-fast`）。客户端也可以只用下文 **对外简写 id**，由网关映射。

## Composer（Standard / Fast）

| 客户端 `model` | 额外字段 | 发给 Cursor 的 route |
|----------------|----------|----------------------|
| `composer-2.5` | — | `composer-2.5` |
| `composer-2.5-fast` | — | `composer-2.5-fast` |
| `composer-2.5` | `fast: true`（见下） | `composer-2.5-fast` |
| `composer-2` / `composer-2-fast` | 同上规则 | 对应 `composer-2*` |

**Fast 开关**（任选其一，为 true 时且 `model` 尚未带 `-fast` 后缀）：

- 请求体：`fast` / `fast_mode` / `fastMode`
- `metadata.fast` / `metadata.fast_mode` / `metadata.fastMode`
- `extra_body.fast`

Composer **不使用** `reasoning_effort` 选档。**Max** 通过 `requestedModel.maxMode`（不是 `-fast` 后缀）：请求体 `max` / `max_mode` / `maxMode`（以及 `metadata` / `extra_body` 同名字段）为 true 时打开。模型 id 仍按列表原样传递（`composer-2.5` + Max，而不是 `composer-2.5-max` route）。

## Grok 4.6 / 4.5

对外推荐：

- `grok-4.6` / `grok-4.6-fast`
- `grok-4.5` / `grok-4.5-fast`
- 带 effort 的简写：`grok-4.6-high`、`grok-4.6-high-fast`、`grok-4.6-medium-fast` 等（映射到对应 `cursor-grok-*` route）

也可直接传 Cursor id：`cursor-grok-4.6-high-fast`（原样透传）。

**Tool calling：** Cursor 的非 fast Grok route（如 `cursor-grok-4.6-high`）不支持 `tools`。网关在有 `tools[]` 时会自动升级到 `-fast` route（`grok-4.6` + tools → `cursor-grok-4.6-high-fast`）。纯文本对话仍走标准档。

### `reasoning_effort`

读取顺序：`reasoning_effort` → `reasoningEffort` → `effort` → `reasoning.effort`。

| `reasoning_effort` | 说明 |
|--------------------|------|
| 省略 | 默认 **`high`** |
| `low` / `medium` / `high` | 同名档位 |
| `max` / `xhigh` / `extrahigh` | **4.6** → `xhigh`；**4.5** 无 xhigh route，落到 **`high`** |
| 无法识别 | **4.6** → `xhigh`；**4.5** → `high` |

### 映射表（`grok-4.6`）

| effort | 标准 | Fast（`grok-4.6-fast` 或 `fast: true`） |
|--------|------|----------------------------------------|
| 默认 | `cursor-grok-4.6-high` | `cursor-grok-4.6-high-fast` |
| `low` | `cursor-grok-4.6-low` | `cursor-grok-4.6-low-fast` |
| `medium` | `cursor-grok-4.6-medium` | `cursor-grok-4.6-medium-fast` |
| `high` | `cursor-grok-4.6-high` | `cursor-grok-4.6-high-fast` |
| `max` / `xhigh` | `cursor-grok-4.6-xhigh` | `cursor-grok-4.6-xhigh-fast` |

### 映射表（`grok-4.5`）

与 4.6 相同，但 **没有** `xhigh` 列；`max` / `xhigh` / 非法值均映射到 `high` 或 `high-fast`。

映射完成后 **不再** 设置 `requestedModel.parameters`（effort 已编码在 route id 里）。

## 响应与调试

- JSON 里的 `model` 字段一般为客户端传入的 id（如 `grok-4.6-fast`）。
- 服务端日志会打印 `cursorRoute=<实际 route id>`，便于核对映射。

## 示例

```bash
BASE=https://cursor2api.freetavily.deno.net/v1
KEY=crsr_your_key_here

# Composer Fast
curl -sS "$BASE/chat/completions" -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" \
  -d '{"model":"composer-2.5-fast","messages":[{"role":"user","content":"hi"}]}'

# Grok Fast + 默认 high
curl -sS "$BASE/chat/completions" -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" \
  -d '{"model":"grok-4.6-fast","messages":[{"role":"user","content":"hi"}],"max_tokens":256}'

# Grok Fast + Max → xhigh-fast
curl -sS "$BASE/chat/completions" -H 'content-type: application/json' \
  -H "authorization: Bearer $KEY" \
  -d '{"model":"grok-4.6-fast","reasoning_effort":"max","messages":[{"role":"user","content":"hi"}],"max_tokens":256}'
```
