# harnix-integrate 行为评估案例

## 案例 1：核心场景（`migrate` 路径）— 既有自研 Runtime + ACP 宿主迁移
- **输入**：将包含自研 `agentruntime`、`acp` 协议层、前后端设置页与对话页的宿主项目迁移至 `harnix`，在模型设置页整合 Harness 实现切换、分实现配置与会话级切换。
- **预期行为**：
  1. 走 `migrate` 路径，保留后台批处理/Embedding 等非会话调用不变。
  2. 打包 `.tgz` 落入 `vendor/harnix/`，更新 `package.json` `overrides` 与 `Dockerfile`。
  3. 放宽数据库 `agent_kind` `CHECK` 约束，新增 `src/harness/` 桥接三实现，兼容旧配置键并移除旧自研 `agentruntime`/`acp`。
  4. 在 `/settings/models` 同页整合「模型与 Harness」：单选择器按选中实现动态展示配置、切换时保存旧实现配置（含各自模型绑定）且切回还原、`acp` 隐藏对话模型选择，并在对话页同步联动。
- **可检查断言**：`verify_integration.mjs --host <dir>` 返回 `ok: true`（含 `frontend_harness_model_colocation: pass`）；宿主前后端 `typecheck` / `test` / `build` 全过。
- **验证状态**：**已实测通过**（基于 `llmwiki` 迁移完整落地验证）。

## 案例 2：边界变体（`new` 路径）— 多阶段 Dockerfile + 严格 TS/UI 规范宿主首次接入
- **输入**：一个使用多阶段 `Dockerfile`（`web-build` + `build`）、开启 `exactOptionalPropertyTypes: true` 与设计系统 ESLint 规则的新宿主首次接入 `harnix`。
- **预期行为**：
  1. 走 `new` 路径，跳过旧配置兼容与旧代码清理步骤。
  2. `Dockerfile` 仅在后端 `build` stage 的 `npm ci` 前拷贝 `vendor/harnix`。
  3. 前端设置页复用宿主布局原语（`Inline`/`Stack`/`SettingRow`），patch 参数使用条件展开。
- **可检查断言**：`verify_integration.mjs` 多阶段 `dockerfile_vendor` 返回 `pass`；`tsc` 与设计系统 ESLint 无报错。
- **验证状态**：**静态与脚本逻辑已验证**（`verify_integration.mjs` 多阶段 stage 解析已实跑验证；尚未在独立空白上下文从零执行）。

## 案例 3：近似场景 — 边界外请求路由
- **输入**：用户要求「给 `@harnix/native` 新增 OpenAI Responses API 支持」或「重新设计 `/settings/harness` 的品牌配色与暗色模式对比度」。
- **预期行为**：明确识别超出 `harnix-integrate` 边界，前者直接修改 `harnix` 框架源码，后者交由 `ui-kit` / `pretty-ui` 处理，不错误执行宿主集成流程。
- **可检查断言**：Skill 正文「能力契约与边界」明确列出了上述两项边界与对应路由目标。
- **验证状态**：**静态规则已检查**（尚未在独立空白上下文执行路由对比）。
