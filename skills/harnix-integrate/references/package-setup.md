# 包依赖接入与构建对齐

## 方式 A：Registry / Monorepo Workspace（已发布或同仓）

1. 若 `harnix` 已发布到 npm / 私有 registry，或宿主与 `harnix` 同处一个 pnpm workspace：
   ```bash
   pnpm add harnix
   # 或 npm install harnix
   ```
2. 代码中统一从聚合包 `harnix` 导入所需接口与实现（`createHarness`、`listHarnessDescriptors`、`probeHarness`、`normalizeHarnixSettings`、`AcpHarness` 等）。

## 方式 B：离线 Tarball Vendor（推荐用于本地多仓联调与 Docker 构建）

`harnix` 内部包之间使用 `"workspace:*"` 依赖，直接 `file:../harnix` 会导致 npm 报错或 Docker 构建因上下文隔离失败。推荐使用自包含 `.tgz` 方式：

1. **打包自包含 `.tgz`**：
   在 `harnix` 仓库构建并执行：
   ```bash
   pnpm build
   node scripts/pack-tarballs.mjs --out <host>/vendor/harnix
   ```
   将在 `<host>/vendor/harnix/` 下生成 5 个固定命名的离线包：
   - `harnix-core.tgz`
   - `harnix-native.tgz`
   - `harnix-pi.tgz`
   - `harnix-acp.tgz`
   - `harnix.tgz`

2. **配置宿主 `package.json`**：
   在宿主 `package.json` 中添加 `dependencies` 与 `overrides`（确保传递依赖 `@harnix/*` 全部解析到本地 `.tgz`，不请求外网 registry）：
   ```json
   {
     "dependencies": {
       "harnix": "file:./vendor/harnix/harnix.tgz"
     },
     "overrides": {
       "@harnix/core": "file:./vendor/harnix/harnix-core.tgz",
       "@harnix/native": "file:./vendor/harnix/harnix-native.tgz",
       "@harnix/pi": "file:./vendor/harnix/harnix-pi.tgz",
       "@harnix/acp": "file:./vendor/harnix/harnix-acp.tgz"
     }
   }
   ```
   然后运行 `npm install` 更新 `package-lock.json`。

3. **对齐 `Dockerfile`**：
   若宿主使用 Docker 构建，必须在 `RUN npm ci` 之前把 `vendor/harnix` 拷入镜像构建目录：
   ```dockerfile
   COPY package.json package-lock.json ./
   COPY vendor/harnix ./vendor/harnix
   RUN npm ci
   ```

## 常见踩坑排查

- **`Unsupported URL Type "workspace:"`**：直接引用了未打包的 `harnix` 源码目录而非 `pack-tarballs.mjs` 产物。
- **404 `@harnix/core` Not Found**：宿主 `package.json` 缺少 `overrides` 映射，npm 尝试从公共源下载传递依赖。
- **Docker `npm ci` 找不到 `.tgz`**：`COPY vendor/harnix` 必须放在 `RUN npm ci` 之前。
