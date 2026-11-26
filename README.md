# harnix

统一、可集成的 TypeScript / Node.js Agent Harness 框架，面向 **LLM-Wiki**、**Sage** 等宿主项目提供一致的执行、流式事件、工具循环、权限控制与会话抽象。

## 包结构

| 包名 | 说明 |
|---|---|
| `@harnix/core` | 零重依赖核心接口：`Harness`、`HarnessCapabilities`、`HarnessEvent`、`HarnessTool`、`PermissionHandler`、`HarnixError`、`HarnixSettings`、`createPolicyPermissionHandler` |
| `@harnix/native` | 手搓 Harness：原生 `fetch` + SSE 流式解析，支持 OpenAI-compatible 与 Anthropic 多轮 tool-use 循环 |
| `@harnix/pi` | Pi Harness：封装 `@mariozechner/pi-ai`，对接统一 `Harness` 接口与事件流 |
| `@harnix/acp` | ACP 适配器：通过 stdio JSON-RPC 2.0 连接任意支持 ACP 的外部 Agent（支持并发上限、白名单环境变量、进程组清理与 `probeAcpAgent`） |
| `harnix` | 聚合入口包：导出 `createHarness`、`listHarnessDescriptors`、`probeHarness` 并 re-export 上述全部子包 |
| `@harnix/cli` | 示例 CLI：支持 `--harness native \| pi \| acp` 单次问答与交互式 REPL |

## 宿主集成 Skill

仓库内置 [`skills/harnix-integrate/`](skills/harnix-integrate/SKILL.md) 集成 Skill，涵盖离线 `.tgz` 打包（`node scripts/pack-tarballs.mjs --out <host>/vendor/harnix`）、分实现差异化 Harness 设置体系、运行时/权限桥接以及静态自检：

```bash
node skills/harnix-integrate/scripts/verify_integration.mjs --host <host-dir>
```

## 快速开发与验证

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

## 集成示例

```ts
import { NativeHarness } from '@harnix/native';
import { PiHarness } from '@harnix/pi';
import { AcpHarness } from '@harnix/acp';
import type { Harness } from '@harnix/core';

const harness: Harness = new NativeHarness({
  provider: {
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  },
});

for await (const event of harness.stream({ input: 'Hello harnix!' })) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
```

## CLI 示例

```bash
# 使用 Native Harness
node packages/cli/dist/bin.js --harness native --api-key "$OPENAI_API_KEY" -p "现在几点？"

# 使用 Pi Harness
node packages/cli/dist/bin.js --harness pi --provider anthropic --api-key "$ANTHROPIC_API_KEY" --model claude-sonnet-4 -p "你好"

# 连接外部 ACP Agent
node packages/cli/dist/bin.js --harness acp --acp-command my-acp-agent
```
