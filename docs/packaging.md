# 客户端打包参考说明（gs-worker · Windows）

本文说明如何在一台全新的 Windows 机器上，从零检出仓库到打出 gs-worker 桌面客户端的安装包。所有命令均在仓库根目录执行（Git Bash 或 PowerShell 均可，`corepack yarn` 命令与 shell 无关）。

## 1. 产物

打包脚本（`dsh-plugin-desktop/scripts/package-win.ts`）产出**未签名**的 Windows x64 产物，输出目录 `dsh-plugin-desktop/dist/`：

| 产物 | 命令 | 说明 |
| --- | --- | --- |
| `gs-worker-<version>-x64-Setup.exe` | `corepack yarn dist:win` | NSIS assisted 安装器：安装时必须由用户确认路径（`oneClick: false`、`perMachine: false`、`allowToChangeInstallationDirectory: true`） |
| `gs-worker-<version>-x64-Portable.zip` | `corepack yarn dist:win-portable` | 便携包（zip），解压即用 |

版本号来自 `dsh-plugin-desktop/package.json` 的 `version` 字段；发版前先 bump 该字段，产物文件名随之变化。

签名说明：打包脚本会**主动剥离** `CSC_*` / `WIN_CSC_*` 等证书环境变量并以 `--config.win.signExecutable=false` 构建——Authenticode 签名是独立的发布步骤，不要在打包机上配置证书变量指望脚本顺带签名。

## 2. 打包机要求（新电脑一次性准备）

1. **Windows x64 原生机器**。脚本强制校验：必须是 `win32` 平台、x64 架构——不能交叉打包，也不能在 ARM 设备上做 x64 包。
2. **Node.js `^22.19.0` 或 `24.x`**（脚本运行时校验，版本不符直接拒绝）。建议用官方安装包，确认自带 Corepack。
3. 启用 Corepack 并激活仓库钉住的 Yarn：

   ```bash
   corepack enable
   ```

   仓库 `package.json` 声明 `packageManager: yarn@4.18.0`，首次 `corepack yarn` 会自动下载该版本，无需全局安装 Yarn。

4. 克隆仓库并初始化上游 submodule：

   ```bash
   git clone <仓库地址> dsh-desktop
   cd dsh-desktop
   git submodule update --init --recursive
   ```

   说明：`deepseek-harness/` 是 pinned 上游 submodule，日常打包**不依赖**它的构建——上游运行时以 tgz 形式 vendored 在 `vendor/dsh-runtime/`（随仓库提交，约 243 个文件），根 `package.json` 的 resolutions 直接指向这些 tgz。submodule 只有跑 `upstream:*` 脚本（升级上游、重新制备运行时）时才真正用到，但按仓库约定应始终保持初始化状态。

5. 安装依赖：

   ```bash
   corepack yarn install --immutable
   ```

   需要网络访问 npm registry。`.yarnrc.yml` 关了 `enableScripts`，依赖的 postinstall 不会执行（原生模块全部走 prebuilds，打包时也以 `npmRebuild=false` 跳过重建），这是预期行为，不是安装失败。

## 3. 打包

### 3.1 正式打包（推荐）

```bash
corepack yarn dist:win            # 安装器
corepack yarn dist:win-portable   # 便携包（可选）
```

每条命令内部按顺序做三件事：

1. **预检门禁** `check:win-package`：构建 community-market 与桌面包 → 5 个 tsconfig 全量 typecheck → 打包相关测试（`package.spec`、`package-win.spec`、`verify-win-installer.spec`、`windows-pwsh-sandbox.spec` 等）→ 运行时闭包校验。任何一步失败即中止，不会产出安装包。
2. **electron-builder 构建**：无签名、`--publish never`、`npmRebuild=false`，NSIS toolset 钉在 1.2.1。
3. **产物验证**：`verify-win-installer.ts` / `verify-win-portable.ts` 对打出来的文件做结构校验（含 `verify-packaged-runtime` 的 afterPack 钩子已在构建期内跑过）。

首次打包 electron-builder 需要联网下载 Electron 43.3.0 与 NSIS 工具链（缓存在 `%LOCALAPPDATA%\electron-builder` 与 electron 下载缓存，之后离线可用）。下载慢可设 `ELECTRON_MIRROR` 环境变量指向内网镜像。

### 3.2 快速迭代打包（仅调试用）

```bash
corepack yarn workspace dsh-plugin-desktop dist:win-fast
```

跳过预检门禁（`DSH_PACKAGE_CHECK_ALREADY_RAN=1`）并降低压缩等级，速度快很多。**只用于本地验证打包流程本身，不要拿它出的包发版**——发版必须走 3.1 的完整门禁。

### 3.3 打包前的自检（可选但建议）

```bash
corepack yarn check
```

根级完整 headless 门禁（布局、双语档、架构方向、vendored 运行时一致性、桌面变体漂移、两个桌面包的 build/typecheck/test/闭包）。打包机的 `dist:win` 预检是它的子集；换电脑第一次打包前跑一遍能提前暴露环境问题。全部检查都是 headless 的，不会启动 GUI。

已知环境性问题：Windows 未开启开发者模式（无符号链接权限）时，少数与本仓库打包无关的测试（setup-wizard、diagnostic-export 等）会报 EPERM。`dist:win` 预检不包含这些用例，不受影响；如果跑全量 `corepack yarn test` 遇到，开启"开发者模式"或以管理员身份运行即可。

## 4. 服务端端点与运行时配置

打包**不烧录任何服务端地址或凭据**，打包机上不需要 `.env`、不需要 gsclaw-server 可达：

- 默认端点内置在 `dsh-plugin-desktop/src/server/gs-endpoint.ts`（当前为 `http://192.168.230.108:8151/gsworker`）。要改默认值就改这里再打包。
- 运行时覆盖优先级：`userData/gs-endpoint.json` > 环境变量 `GSCLAW_ENDPOINT` > 内置默认。纯 http 只接受 loopback 与内网网段，其他地址必须 https。
- 安装后首次启动会先弹登录窗（登录门控在 Host boot 之前），此时才需要 gsclaw-server 可达。

## 5. 换电脑打包检查清单

1. Windows x64 原生机器 + Node 22.19+/24.x + `corepack enable`。
2. `git clone` + `git submodule update --init --recursive`。
3. `corepack yarn install --immutable`（网络可达 npm registry）。
4. 确认 `dsh-plugin-desktop/package.json` 的 `version` 是本次要发的版本号。
5. 确认工作树包含本次要发布的全部改动（建议先 commit；脚本不校验工作树干净）。
6. `corepack yarn dist:win`（需要便携包再跑 `corepack yarn dist:win-portable`）。
7. 在 `dsh-plugin-desktop/dist/` 取 `gs-worker-<version>-x64-Setup.exe`；签名按独立发布流程处理。
8. 冒烟：在测试机安装，启动后出现登录窗、能连上 gsclaw-server 登录进主界面，即打包合格。

## 6. 备注

- macOS 另有 `dist:mac` / `dist:mac-smoke` 脚本与 `release-mac.ts` 发布流程（universal 包、签名与公证），路径与 Windows 不同，本文不覆盖；在 Mac 上操作时参考 `dsh-plugin-desktop/scripts/release-mac.ts` 头部注释。
- beta 变体（`dsh-plugin-desktop-beta`）有对应的 `dist:win:beta` 等根级脚本，仅在做 beta 渠道时使用。
- 安装器行为约定（assisted、必须确认路径、stable 不开 `oneClick`）由 `tests/package.spec.ts` 钉死，改动 `package.json` 的 `build.nsis` 段前先看该测试。
- 打包相关的更深背景见 [gs-worker-integration.md](gs-worker-integration.md) 的"Windows 安装器约定"一节。
