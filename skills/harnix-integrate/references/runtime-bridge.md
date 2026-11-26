# 运行时、工具、事件与权限桥接指南

建议在宿主项目新建薄桥接目录（如 `src/harness/`），将 `harnix` 与宿主数据库、工具系统、SSE 流及会话生命周期解耦。

## 1. 工厂创建与生命周期管理

- **`native` / `pi`**：每次对话请求根据会话绑定的模型实例（`baseUrl`、`apiKey`、`model`、`kind: 'openai-compatible' | 'anthropic'`）与当前 `HarnixSettings` 调用 `createHarness()` 创建实例。
- **`acp`**：**不得每次请求新建后丢弃进程**。应在宿主服务层维护常驻的 `AcpHarness` 实例池（可按 `acpAgentId` + 配置指纹缓存）：
  - 发消息前调用 `acpHarness.hasSessionCapacity(sessionId)`，无容量时返回 HTTP `503` + `Retry-After`。
  - 会话删除或归档时调用 `acpHarness.closeSession(sessionId)` 释放子进程。
  - 配置变更或服务关闭时调用 `acpHarness.close()` 清理全部子进程。

## 2. 工具包装（`HarnessTool`）

将宿主现有工具定义与执行器包装为 `HarnessTool[]`：
```ts
const harnessTools: HarnessTool[] = hostTools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  async execute(args, context) {
    try {
      const output = await hostExecutor.execute(tool.name, JSON.stringify(args), context.signal);
      return { content: output, isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
}));
```
> 注意：工具内部错误应尽量转为 `{ content, isError: true }` 返回给模型自愈，仅在权限拒绝或不可恢复的系统异常时中断。

## 3. 权限桥接（`PermissionHandler`）

- `native` / `pi`：`createPermissionHandlerForMode(settings[kind].permissionMode)`。
- `acp`：`createPolicyPermissionHandler({ ...agentEntry.permission, readonlyOnly: settings.acp.defaults.readonlyOnly })`。
- 当需要记录审计日志或向前端推送权限决策时，可监听 `HarnessEvent` 中的 `permission.resolved`，或外包一层装饰器记录决策明细。

## 4. `HarnessEvent` 与 `onDebug` 映射

| `HarnessEvent.type` / 回调 | 宿主动作建议 |
|---|---|
| `text.delta` | 推送前端 `token` SSE 事件并累加助手消息文本（建议按字符数或时间节流刷库） |
| `thought.delta` | 推送 `thought` SSE 事件（含思维链展示） |
| `tool.started` | 推送 `tool_start` SSE 事件 |
| `tool.completed` | 推送 `tool_done` SSE 事件 |
| `plan.updated` | 推送 `plan` SSE 事件（ACP 计划条目） |
| `permission.resolved` | 推送 `permission` SSE 事件并写审计日志 |
| `run.failed` | 推送 `warning` / `error` SSE 事件，更新消息状态为 `failed` 或 `incomplete`（取消时） |
| `onDebug(event)` | 写入宿主消息调试事件表（`step` / `phase` / `message` / `payload`） |

## 5. 流状态与取消语义

- 将 HTTP 请求的 `AbortSignal` 传入 `harness.run(request, { signal, onEvent, onPermission, onDebug })`。
- 将 `result.stopReason` 映射为宿主消息状态：`completed` / `max_tokens` / `max_turns` → `complete`；`cancelled` → `incomplete`；`error` → `failed`。
- `acp` 路径若发生首包前进程崩溃，`AcpHarness` 已内置一次自动重启恢复；若仍失败则按错误处理并清理损坏会话。
