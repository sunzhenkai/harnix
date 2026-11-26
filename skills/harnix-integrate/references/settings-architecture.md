# Harness 设置体系规范（分实现差异化配置）

`harnix` 提供统一的 `HarnixSettings`、`BUILT_IN_HARNESS_DESCRIPTORS`、`normalizeHarnixSettings()`、`validateHarnixSettings()` 与 `redactAcpAgents()`。宿主应围绕这套契约建立前后端设置体系，而非为每个实现手写零散配置键。

## 1. 三实现差异化配置对照

| 实现 | 是否复用宿主 Provider | 核心差异化配置项 | 说明 |
|---|---|---|---|
| `native` | 是 | `providerInstanceId?`、`model?`、`permissionMode`、`maxTurns`、`maxToolCalls`、`maxToolCallsPerTurn`、`timeoutMs`、`includeUsage`、`temperature?`、`maxTokens?` | 原生 `fetch` + SSE 工具循环；空 `apiKey`（如 Ollama）自动省略认证头 |
| `pi` | 是 | `providerInstanceId?`、`model?`、`permissionMode`、`reasoning`、`contextWindow`、`maxTokens`、`maxTurns`、`maxToolCalls`、`maxToolCallsPerTurn`、`timeoutMs` | 基于 `@mariozechner/pi-ai`；独有 `reasoning` 开关与 `contextWindow` 配置 |
| `acp` | 否（独立外部 CLI） | `defaultAgentId`、`maxConcurrentSessions`、`defaults.readonlyOnly`、`agents`（命令、参数、`envPassthrough`、`cwdPolicy`、初始化/执行/空闲超时、细粒度读写搜索抓网执行权限） | 通过 stdio JSON-RPC 2.0 驱动外部 Coding Agent |

## 2. 后端存储、校验与 API 契约

1. **持久化存储**：
   - 将 `HarnixSettings` JSON 序列化后存入宿主配置键（如 `harnix_settings`）。
   - 读取与保存前统一调用 `normalizeHarnixSettings(raw)`，由 `harnix` 完成默认值补全、数值范围检查和 ACP 安全红线校验（拒绝 `env` 明文、拒绝 `args` 凭据、拒绝 shell 元字符、`readonlyOnly=true` 时拒绝写/执行权限）。
   - **三套配置共存**：`native`、`pi`、`acp` 节点始终同时持久化在 `harnix_settings` 中，切换 `defaultKind` 不得清空或覆盖其他实现已保存的参数与各自绑定的 `providerInstanceId` / `model`。
   - **迁移兼容（`migrate` 路径）**：若 `harnix_settings` 尚为空，从宿主旧配置键（如 `default_agent_kind`、`default_acp_agent_id`、`acp_agents_json`、`acp_max_concurrent_agents`、工具轮次上限、`last_instance_id` / `last_model`）自动合成初始 `HarnixSettings`；保存 `harnix_settings` 时反向同步兼容旧键，保证既有客户端或脚本不失效。

2. **模型解析优先级（`requiresProvider: true` 实现）**：
   - 后端执行或探针解析 `native` / `pi` 凭据时，按以下优先级解析：
     `请求/会话显式参数 → harnix_settings[kind].{providerInstanceId, model} → 宿主 last_instance_id / last_model`。
   - 当 `defaultKind` 在 `native` 与 `pi` 之间切换且目标实现已有有效 `(providerInstanceId, model)` 绑定时，同步更新 `last_instance_id` / `last_model`；切换至 `acp` 时**不得清空** `last_instance_id` / `last_model`，确保后台批处理/Embedding 等非对话任务模型继续可用。

3. **推荐 API 端点**：
   - `GET /api/v1/harness/descriptors`：直接返回 `listHarnessDescriptors()`，供前端渲染能力标签与字段说明。
   - `GET /api/v1/settings`：返回包含 `harnix_settings`（以及脱敏后的 `acp_agents` 状态，如使用 `redactAcpAgents()`）的配置对象。
   - `PUT /api/v1/settings`：接收 `harnix_settings`（或部分补丁），经 `normalizeHarnixSettings()` 校验失败时返回 HTTP `400` 与明确错误信息。
   - `POST /api/v1/harness/check`：接收 `{ kind, harnix_settings?, instance_id?, model?, acp_agent_id? }`，调用 `probeHarness()` 执行即时探测并返回结构化结果。

## 3. 前端设置页与会话切换规范

1. **与模型/Provider 同页整合且双向联动（严禁割裂）**：
   - Harness 设置必须与 Provider 实例、模型选择置于**同一设置页**（如 `/settings/models`，「模型与 Harness」），不得拆分为互相无联动的独立菜单项；若存在历史 `/settings/harness` 路由，保留 `<Navigate to="/settings/models" replace />` 重定向。
   - Provider 实例池在同一页面维护，增删改即时联动下方模型列表；当某实现绑定的 Provider 实例被删除时，优雅降级并给出明确提示。

2. **单选择器驱动 + 按选中实现动态展示 + 切走保旧/切回还原**：
   - **禁止「顶部默认实现 Select + 底部独立 Tabs」双状态割裂**：只保留**一个** Harness 实现选择器（绑定 `defaultKind`），下方仅渲染当前选中实现的配置面板。
   - **受控隔离防残留**：为分实现面板设置 `key={selectedKind}`，全部输入采用受控状态或随切换同步的草稿；禁止使用无 `key` 隔离的非受控 `defaultValue` 导致跨实现残留。
   - **切换前保存旧配置**：从实现 A 切往实现 B 时，必须先把实现 A 尚未失焦提交的草稿（数字、文本、模型绑定）flush 合入 `harnix_settings[A]` 并连同 `defaultKind: B` 原子保存；`harnix_settings[A]` 完整保留，切换回 A 时原样还原（含各自绑定的模型与参数）。
   - **按 `requiresProvider` 联动渲染**：
     - 选中 `native` / `pi`（`requiresProvider: true`）：在当前实现面板内直接选择并保存该实现专属的 `providerInstanceId` 与 `model`（同步宿主 `last_instance_id` / `last_model`），展示协议适配提示（OpenAI-compatible vs Anthropic）与未配置实例警告；点击「检查」时直接携带当前绑定的实例与模型调用 `POST /api/v1/harness/check`。
     - 选中 `acp`（`requiresProvider: false`）：**隐藏**对话侧 Provider/模型选择器，改为展示 `defaultAgentId`、`maxConcurrentSessions`、`defaults.readonlyOnly`、ACP Agents JSON 编辑器及 `envPassthrough` 存在性检查，并明示对话由外部 ACP Agent 驱动、不依赖 Provider 实例；同时保留独立区块（如「后台摄入任务模型」）继续可用。

3. **会话级切换器联动**：
   - 在对话页面（如输入区工具栏）展示并切换当前会话的 Harness 实现（`native` / `pi` / `acp`）。
   - 当会话为 `acp` 时隐藏或禁用 `ModelPicker`，仅展示 ACP Agent 选择；从 `acp` 或在 `native` ↔ `pi` 之间切换时，优先带入目标 Harness 已绑定的 `(providerInstanceId, model)`。
   - 若数据库会话表存在 `agent_kind` 的 `CHECK` 约束，务必新增迁移将其扩展为包含 `'pi'`（`CHECK (agent_kind IN ('native','pi','acp'))`）。

4. **宿主 UI 规范与严格 TypeScript 兼容**：
   - **严守宿主设计体系**：优先复用宿主既有表面/布局原语（如 `Section`、`Panel`、`Rows`、`Inline`、`Stack`、`SettingRow`），避免在页面代码手写 `gap-*` / `p-*` 等布局类触发设计系统 ESLint 规则。
   - **兼容 `exactOptionalPropertyTypes: true`**：调用更新会话或设置的 patch API 时，对可选字段使用条件展开（`...(v !== undefined ? { k: v } : {})`），避免显式传入 `undefined`。
