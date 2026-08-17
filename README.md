# DeepSeek Harness 桌面版

DeepSeek Harness 的 Windows 桌面应用（Electron）。内嵌 Chromium 打开 DeepSeek Harness Web GUI。安装包已内置 Node.js 与 dsh 运行时，**无需预装任何环境，安装即用**。

## 功能

- 蓝色鲸鱼品牌图标，窗口与任务栏统一
- 无边框窗口，白色主题标题栏，Windows 原生最小化/最大化/关闭按钮
- 内嵌 Chromium 内核直接打开 DeepSeek Harness Web 界面
- 外部链接自动转系统浏览器打开
- 系统托盘：点击关闭最小化到托盘，托盘菜单"退出"会同时停止 dsh 服务
- 内置 Node.js 与 dsh CLI 运行时，安装后无需单独安装 Node.js / npm / dsh

## 前置要求

- Windows 10 / Windows 11（x64）

## 使用

直接运行安装程序（见 Releases），安装后从桌面快捷方式或开始菜单启动即可。

## 从源码开发

```bash
npm install
npm start
```

## 打包

```bash
npm install --save-dev electron-builder
npx electron-builder --win nsis
```

产物在 `dist/` 目录。`runtime/` 目录（内置 Node.js 与 dsh）由打包脚本准备，不入库。

## 技术栈

- Electron 43（Chromium 内核）
- `WebContentsView` 承载 DSH Web UI（`sandbox: true`）
- 无运行时 npm 依赖（主进程仅使用 Electron 内置模块）

## 许可

MIT
