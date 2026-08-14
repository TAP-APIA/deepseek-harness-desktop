# DeepSeek Harness 桌面版

DeepSeek Harness 的 Windows 桌面应用（Electron）。内嵌 Chromium 打开 DeepSeek Harness Web GUI，自动管理服务生命周期，启动时静默检查官方更新。

## 功能

- 🐋 蓝色鲸鱼品牌图标，任务栏/窗口统一
- 🪟 无边框窗口 + Windows 原生标题栏按钮（`titleBarOverlay`），白色主题与主界面一致
- ⚡ 自动启动 `dsh web` 服务（未运行时最小化拉起）
- 🔄 启动时静默检查 npm 官方 `@deepseek-ai/dsh` 最新版，有新版自动安装（升级日志见 `%LOCALAPPDATA%\DeepSeek Harness\updater.log`）
- 🌐 外部链接自动转系统浏览器打开

## 前置要求

- Windows 10/11
- 已全局安装 DeepSeek Harness CLI：`npm install -g @deepseek-ai/dsh`
- Node.js 22+（含 npm）

## 使用

```bash
npm install
npm start
```

或直接运行打包好的安装程序（见 Releases）。

## 打包

```bash
npm install --save-dev electron-builder
npx electron-builder --win nsis
```

产物在 `dist/` 目录。

## 技术栈

- Electron 43（Chromium 内核）
- `WebContentsView` 承载 DSH Web UI（`sandbox: true`）
- 无运行时 npm 依赖（主进程仅使用 Electron 内置模块）

## 许可

MIT
