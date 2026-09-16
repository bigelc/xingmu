<div align="center">
  <img src="build/to-do-panel-icon.png" width="100" alt="醒目图标" />
  <h1>醒目</h1>
  <p>常驻 Mac 屏幕顶部的本地工作台。</p>
  <p>待办、笔记、链接、录音和任务坐标图，随手打开、集中处理。</p>
</div>

[下载 macOS Apple Silicon 版](https://github.com/bigelc/xingmu/releases/latest) · [版本说明](CHANGELOG.md) · [许可证](LICENSE)

## 当前版本

**1.0.5 · 构建 105.9.11 · 2026-09-16**

本仓库发布的是 TO-DO Panel 二开版更名为「醒目」后的实际安装版本。发布包中的应用与本次已经启动验收的应用一致；运行源码与该应用逐文件匹配，详见 [release-manifest.json](release-manifest.json)。本地开发目录中尚未安装的后续改动未包含在本次发布中。

## 能做什么

- **首页工作台**：番茄钟、快速录音、当前窗口、随笔记、常用指令、音乐、镜子和任务坐标图，可选择显示的组件。
- **待办**：四个可改名的分类、截止时间、任务完成状态和快速记录。
- **任务坐标图**：按紧急与重要两条轴放置任务，支持关注、筛选和展开查看。
- **当前任务**：选择当前任务、关联已有笔记与链接、使用番茄钟专注。
- **笔记与链接**：保存本地笔记、整理链接与分组。
- **录音**：本地录音；可选配置百炼实时转写与 DeepSeek 智能命名。
- **本机提醒**：接收 Codex、Claude Code 与 GPT 的本机任务完成事件。
- **本地设置**：配置功能显示、唤出快捷键、数据文件夹与开机启动。

转写、智能命名及链接元数据获取可能连接相应外部服务；API Key 由使用者自行配置。仓库与下载包不包含任何个人待办、笔记、录音、凭据或运行配置。

## 下载安装

要求 **Apple Silicon Mac（arm64）、macOS 13 或更新版本**。

1. 在 [Releases](https://github.com/bigelc/xingmu/releases/latest) 下载 `XingMu-1.0.5-macos-arm64.zip`。
2. 解压后，把 `醒目.app` 拖入「应用程序」。
3. 打开「醒目」，通过屏幕顶部入口、Dock 或设置中的唤出快捷键进入工作台。

当前包为 **ad-hoc 本地签名，未经 Apple 公证**，macOS 可能提示无法验证开发者。若系统拦截，请先核对下载来源和 SHA-256，再按 macOS「系统设置 → 隐私与安全性」中的提示处理。下载页附有 `SHA256SUMS.txt`。

摄像头、麦克风、辅助功能和屏幕录制权限按功能需要由使用者自行授权。本次验证覆盖启动、界面名称和原数据保留，未宣称所有设备或权限功能已在其他 Mac 上通过测试。

## 从源码运行

使用 **Node.js 22.12.0 或更新版本**：

```bash
npm ci
npm start
```

```bash
npm test          # 本版本适用的领域逻辑和结构检查，以及运行源码语法检查
npm run build    # 构建 macOS DMG
npm run build:zip
```

应用使用 Electron 44 与原生 HTML/CSS/JavaScript，构建配置位于 `package.json`。`package-lock.json` 固定依赖树。源代码构建生成相同功能版本，但文件时间戳与签名等可能使二进制校验和不同于本次打包的已安装快照。

## 更名与数据兼容

对外名称统一为「醒目」。为保留原二开版的用户数据和 macOS 钥匙串身份，内部应用名与数据目录名仍为 `TO-DO Panel 二开版`，Bundle ID 仍为 `com.dynamicpanel.app.custom`。因此，曾使用该二开版的用户安装后会继续使用原来的本机资料。

默认数据目录为 `~/Library/Application Support/TO-DO Panel 二开版`，本机通知端口为 `127.0.0.1:43822`。请勿与原二开版同时运行；原 TO-DO Panel 官方版使用不同身份和端口。

## 来源与许可

醒目基于 [xiaopu-ai/TO-DO-Panel](https://github.com/xiaopu-ai/TO-DO-Panel) 进行本地二次开发和更名，继续遵循 MIT License，并保留原项目署名。应用图标与默认素材沿用上游，本仓库不宣称它们为新原创作品。

本次使用经过筛选的独立源码快照建立仓库历史。第三方组件与上游版权说明见 [NOTICE.md](NOTICE.md)。
