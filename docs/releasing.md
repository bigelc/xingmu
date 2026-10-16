# 发布流程

仓库：`bigelc/xingmu`。版本号使用语义版本，当前为 `2.0.0`。同一 GitHub Release 提供 macOS arm64 DMG、Windows x64 NSIS EXE 与各自的 SHA-256 文件。

## 发布前

1. 对齐根目录与官网的 package / lock 版本、README 稳定版本、CHANGELOG 和 `docs/release-notes.md`。
2. 在根目录运行 `npm ci`、`npm test`；官网运行 `npm ci`、`npm test`、`npm run lint`、`npm run build`。
3. 确认运行包带有 `LICENSE`、`NOTICE.md`，不含用户数据、账单、录音、凭据、历史截图或本地工具配置。
4. 核对安装包名称：`Xingmu-<版本>-arm64.dmg` 与 `Xingmu-<版本>-windows-x64-setup.exe`。
5. 安装与升级验收使用隔离数据目录；区分单元测试、集成测试、真实安装和真实联网调用的结论。

## 自动化流程

`.github/workflows/release-dmg.yml` 并行运行两个平台的检查。macOS 构建后校验应用签名与 DMG；Windows 构建后通过 `scripts/verify-windows.ps1` 验证安装程序、启动、核心 IPC、数据保存、系统加密、快捷键、模拟录音设备、重新安装和卸载。

手动 `workflow_dispatch` 只验证并上传 Actions artifacts。正式发布时推送与 package 版本一致的 `v*.*.*` 标签；两个平台均成功后，发布任务校验哈希并创建同一个 Release。任一平台失败，不应把未验证的安装包称为正式完成。

官网从 `releases/latest` 分别解析 macOS 与 Windows 资产；资产缺失时退回发布页，不跨平台下载。发布后必须回读 Release 的两个安装包、两个校验文件，以及线上网站下载按钮的实际目标。

## 本地构建与边界

`npm run pack` 生成应用目录；`npm run build` 生成 macOS DMG；`npm run build:win` 生成 Windows EXE。输出位于 `dist.noindex/`。终端用户无需安装 Node.js；可选通知转发脚本需要相应工具的 Node 环境。

macOS 当前采用 ad-hoc 签名、没有 Apple 公证；Windows 没有商业代码签名。CI 的托管 Windows 环境与模拟设备不代表 Windows 10/11 所有物理设备、多显示器、DPI 和组织策略已经实测。公开发布说明应如实标注验证范围，不写尚未取得的验证结果。

## 升级兼容

应用身份为 `com.bigelc.xingmu`，默认目录名为「醒目-个人效率工作台」。首次启动只在新目录不存在时复制旧版默认目录，保留原目录；已有新目录不覆盖。自选工作区独立保留。应用身份变化可能导致安全存储密钥需要重填、系统权限及开机自启需要重新确认。
