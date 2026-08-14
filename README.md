# DeepSeek Harness 桌面版

DeepSeek Harness 的 Windows 桌面应用（Electron）。内嵌 Chromium 打开 DeepSeek Harness Web GUI。

## 功能

- 蓝色鲸鱼品牌图标，窗口与任务栏统一
- 无边框窗口，白色主题标题栏，Windows 原生最小化/最大化/关闭按钮
- 内嵌 Chromium 内核直接打开 DeepSeek Harness Web 界面
- 外部链接自动转系统浏览器打开
- 系统托盘：点击关闭最小化到托盘，托盘菜单"退出"会同时停止 dsh 服务
- 自更新：启动时及每 2 小时从 GitHub 检查新版本，发现更新时标题栏右侧显示"升级"按钮，点击自动下载安装

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
