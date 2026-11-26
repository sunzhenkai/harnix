# Harness 设置体系规范（分实现差异化配置）

`harnix` 提供统一的 `HarnixSettings`、`BUILT_IN_HARNESS_DESCRIPTORS`、`normalizeHarnixSettings()`、`validateHarnixSettings()` 与 `redactAcpAgents()`。宿主应围绕这套契约建立前后端设置体系，而非为每个实现手写零散配置键。

## 1. 三实现差异化配置对照

| 实现 | 是否复用宿主 Provider | 核心差异化配置项 | 说明 |
|---|---|---|---|
| `native` | 是 | `permissionMode`、`maxTurns`、`maxToolCalls`、`maxToolCallsPerTurn`、`timeoutMs`、`includeUsage`、`temperature?`、`maxTokens?` | 原生 `fetch` + SSE 工具循环；空 `apiKey`（如 Ollama）自动省略认证头 |
| `pi` | 是 | `permissionMode`、`reasoning`、`contextWindow`、`maxTokens`、`maxTurns`、`maxToolCalls`、`maxToolCallsPerTurn`、`timeoutMs` | 基于 `@mariozechner/pi-ai`；独有 `reasoning` 开关与 `contextWindow` 配置 |
| `acp` | 否（独立外部 CLI） | `defaultAgentId`、`maxConcurrentSessions`、`defaults.readonlyOnly`、`agents`（命令、参数、`envPassthrough`、`cwdPolicy`、初始化/执行/空闲超时、细粒度读写搜索抓网执行权限） | 通过 stdio JSON-RPC 2.0 驱动外部 Coding Agent |

## 2. 后端存储、校验与 API 契约

1. **持久化存储**：
   - 将 `HarnixSettings` JSON 序列化后存入宿主配置键（如 `harnix_settings`）。
   - 读取与保存前统一调用 `normalizeHarnixSettings(raw)`，由 `harnix` 完成默认值补全、数值范围检查和 ACP 安全红线校验（拒绝 `env` 明文、拒绝 `args` 凭据、拒绝 shell 元字符、`readonlyOnly=true` 时拒绝写/执行权限）。
   - **迁移兼容（`migrate` 路径）**：若 `harnix_settings` 尚为空，从宿主旧配置键（如 `default_agent_kind`、`default_acp_agent_id`、`acp_agents_json`、`acp_max_concurrent_agents`、工具轮次上限等）自动合成初始 `HarnixSettings`；保存 `harnix_settings` 时反向同步兼容旧键，保证既有客户端或脚本不失效。

2. **推荐 API 端点**：
   - `GET /api/v1/harness/descriptors`：直接返回 `listHarnessDescriptors()`，供前端渲染能力标签与字段说明。
   - `GET /api/v1/settings`：返回包含 `harnix_settings`（以及脱敏后的 `acp_agents` 状态，如使用 `redactAcpAgents()`）的配置对象。
   - `PUT /api/v1/settings`：接收 `harnix_settings`（或部分补丁），经 `normalizeHarnixSettings()` 校验失败时返回 HTTP `400` 与明确错误信息。
   - `POST /api/v1/harness/check`：接收 `{ kind, harnix_settings?, provider_instance_id?, model?, acp_agent_id? }`，调用 `probeHarness()` 执行即时探测并返回结构化结果。

## 3. 前端设置页与会话切换规范

1. **设置页分区（推荐独立分区，如 `/settings/harness`）**：
   - **顶部总览区**：选择默认 Harness 实现（`native` / `pi` / `acp`），并展示当前选中实现的能力标签（`streaming`、`thinking`、`tools`、`plan` 等）及是否依赖模型 Provider 的提示。
   - **分实现差异化配置区**：使用 Tab 或分段面板分别展示 `Native`、`Pi`、`ACP` 配置表单。切换 Tab 查看/编辑各实现参数时，**不得丢失其他实现的未保存配置或改动当前默认实现**（默认实现与表单草稿分离或显式保存）。
   - **ACP Agent 列表与安全展示**：展示每个 Agent 的命令、启用状态、权限策略与 `envPassthrough` 变量名状态（仅显示变量名与是否已在宿主进程环境存在，不展示值）；提供「检查连通性」按钮调用 `/api/v1/harness/check` 并内联展示探测结果。
2. **会话级切换器**：
   - 在对话页面（如顶部或输入区工具栏）展示当前会话使用的 Harness 实现；支持在 `native` / `pi` / `acp` 之间切换（选 `acp` 时联动选择具体启用的 ACP Agent）。
   - 若数据库会话表存在 `agent_kind` 的 `CHECK` 约束，务必新增迁移将其扩展为包含 `'pi'`（`CHECK (agent_kind IN ('native','pi','acp'))`）。
