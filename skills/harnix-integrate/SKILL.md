---
name: harnix-integrate
description: 将 harnix 统一 Agent Harness 框架（native / pi / acp）集成到 TypeScript / Node.js 宿主项目，同步落地分实现差异化设置、运行时/工具/权限桥接与连通性探针。用于新项目接入 harnix、将既有自研 Agent 运行时或 ACP 链路迁移到 harnix、或为宿主补充 Harness 实现切换与配置页时使用。
---

# harnix-integrate：宿主集成与 Harness 设置体系

把任意 TypeScript / Node.js 宿主项目接入 `harnix`（`native` / `pi` / `acp`），并同步建立分实现差异化的 Harness 设置与运行桥接，确保配置可校验、运行可观测、切换可平滑。

## 能力契约与边界

- **完成标准**：宿主完成 `harnix` 依赖接入、新增/对齐分实现差异化的 Harness 设置体系（后端存储/校验/探针 + 前端设置与会话切换）、通过薄桥接层用 `@harnix/*` 驱动 Agent 运行，并通过全部类型检查、单测与集成自检。
- **与相邻 Skill 的边界**：
  - 修改 `harnix` 框架自身源码不在本 Skill 范围内。
  - 通用 UI 视觉风格与组件库设计规范交给 `ui-kit` / `pretty-ui`。
  - 非 Agent 会话的纯结构化 LLM 批处理或 Embedding 基础设施默认保留宿主既有实现，不强行迁入 `harnix`。

## 路径选择

| 路径 | 适用场景 | 差异动作 |
|---|---|---|
| `new` | 宿主此前无 Agent 运行时 | 执行全部 6 步，跳过旧配置兼容与旧代码清理 |
| `migrate` | 宿主已有自研运行时或自研 ACP 链路 | 执行全部 6 步，重点做旧配置键双向兼容、数据库约束放宽与旧链路清理 |

## 集成主流程

### 步骤 1：盘点宿主现状与边界
1. 列出宿主中所有调用 LLM / Agent 的入口，区分 **Agent 会话运行时** 与 **纯批处理/Embedding 任务**。
2. 检查宿主包管理器（`npm` / `pnpm`）、`Dockerfile` 构建上下文、数据库会话表约束（例如 `agent_kind` 的 `CHECK` 约束是否包含 `'pi'`），以及现有 Provider/模型设置接口。
3. **完成标志**：明确本次迁移/接入的业务入口列表、依赖分发方式与兼容性边界。

### 步骤 2：包依赖接入与构建对齐
按宿主环境与分发方式读取 [references/package-setup.md](references/package-setup.md) 完成依赖安装与容器构建配置。
- **完成标志**：宿主可执行 `npm ci` / `pnpm install` 正常解析 `harnix` 与 `@harnix/*` 类型及运行时。

### 步骤 3：新增 Harness 设置体系（核心）
读取 [references/settings-architecture.md](references/settings-architecture.md)，落地「默认实现选择 + 按 `native` / `pi` / `acp` 分实现差异化配置 + 连通性探针」的完整前后端设置体系。
- **完成标志**：后端提供 `HarnixSettings` 归一化/校验/脱敏读写与 `descriptors`/`check` 接口；前端设置页可切换默认实现并独立编辑三类差异化参数、执行连通性探测；会话页支持展示与切换当前会话的 Harness 实现。

### 步骤 4：构建薄桥接层（Runtime / Tools / Events / Permissions）
读取 [references/runtime-bridge.md](references/runtime-bridge.md)，在宿主新建薄桥接目录（如 `src/harness/`），实现：
- `createHarness()` 工厂调用与 `AcpHarness` 常驻进程池管理（并发上限、会话释放、关闭清理）。
- 宿主工具到 `HarnessTool[]` 的包装。
- 策略权限处理器（`createPermissionHandlerForMode` / `createPolicyPermissionHandler`）。
- `HarnessEvent` 与 `onDebug` 到宿主 SSE / 持久化消息与日志的映射。
- **完成标志**：宿主会话执行完全通过 `Harness` 接口驱动，支持流式输出、取消（`AbortSignal`）与工具权限控制。

### 步骤 5：接入业务入口、迁移 DB 与清理旧链路
1. 将会话路由与流式响应切换至步骤 4 的桥接层；若数据库会话表存在 `agent_kind` 约束限制，添加幂等增量迁移放宽至 `('native', 'pi', 'acp')`。
2. （仅 `migrate` 路径）保持旧设置键与 API 兼容后，移除已被替代的自研运行时与协议/进程管理代码，确保无悬挂引用。
- **完成标志**：全部会话接口支持 `native` / `pi` / `acp`，旧自研运行时代码已清理干净。

### 步骤 6：运行验收清单与静态自检
读取 [references/verification-checklist.md](references/verification-checklist.md)，运行静态自检脚本并执行前后端全量验证：
```bash
node <harnix-integrate>/scripts/verify_integration.mjs --host <host-dir>
```
- **完成标志**：`verify_integration.mjs` 返回 0，且宿主类型检查、单测、构建与三实现核心流程实测全部通过。

## 安全红线与副作用边界

- **ACP 凭据隔离**：禁止在 ACP 配置中保存明文 `env` 对象或在 `args` 中传入 API Key / Token；必须使用 `envPassthrough` 变量名白名单。
- **默认只读保护**：`acp.defaults.readonlyOnly` 默认为 `true`，未显式关闭时严禁放行 `allowWrite` 或 `allowExecute`；`native` / `pi` 默认 `permissionMode` 为 `'readonly'`。
- **操作边界**：不自动 `git push`、不发布公共包、不修改线上部署环境；涉及数据库结构或数据迁移需先与用户确认。
