# 集成验收清单

完成宿主集成或迁移后，逐项核查以下 6 个门禁：

1. **静态自检脚本通过**
   - 运行 `node <harnix-integrate>/scripts/verify_integration.mjs --host <host-dir>`，全部核心检查项返回 `pass`（退出码 `0`）。

2. **包安装与构建验证**
   - 宿主 `npm run typecheck`、`npm run build` 通过。
   - 若使用 `vendor/harnix/*.tgz` 与 `Dockerfile`，确认 `package.json` 的 `overrides` 覆盖全部 `@harnix/*` 子包，且多阶段 `Dockerfile` 在安装根 `package.json` 的 stage 的 `npm ci` 前拷贝 `vendor/harnix`。
   - 若数据库会话表存在 `agent_kind` `CHECK` 约束，确认已通过增量迁移放宽为包含 `'pi'`。

3. **设置体系与安全红线测试**
   - `GET /api/v1/harness/descriptors` 返回 `native`、`pi`、`acp` 描述符。
   - `GET/PUT /api/v1/settings` 支持三实现差异化参数读写；非法值（越界数字、ACP 明文 `env`、命令含 shell 元字符、参数含密钥、`readonlyOnly=true` 时开写权限）返回 HTTP `400`。
   - `POST /api/v1/harness/check` 可分别对 `native`、`pi`、`acp` 返回准确探测状态。

4. **三实现运行时测试**
   - `native` 与 `pi` 通过 mock OpenAI SSE server 验证多轮工具调用、流式输出与权限策略。
   - `acp` 通过 mock ACP stdio 脚本验证会话建立、权限判定、并发上限（`hasSessionCapacity` / `503`）与会话关闭清理。

5. **前端设置页与会话交互验证**
   - 前端 `typecheck`、`lint`、单元测试、`build` 及项目自有设计规范检查全部通过。
   - `/settings/models`（「模型与 Harness」）同页整合 Provider 实例、对话 Harness 与模型、后台任务模型；旧 `/settings/harness` 路由正常重定向至 `/settings/models`。
   - 仅保留单 Harness 实现选择器并按选中实现动态渲染配置；按 `native` → `pi` → `acp` → `native` 往返切换后，各实现的参数与各自绑定的 `providerInstanceId`/`model` 完整保留并还原；`acp` 选中时隐藏对话侧模型选择；会话页同步联动（`acp` 隐藏 `ModelPicker`，切换 `native` ↔ `pi` 自动带入对应模型）。

6. **旧链路清理确认（仅 `migrate` 路径）**
   - 确认已被替代的自研运行时与协议/进程管理代码已移除，代码库无残余引用。
