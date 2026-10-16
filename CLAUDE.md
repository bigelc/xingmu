# 醒目-个人效率工作台开发说明

先阅读 [AGENTS.md](AGENTS.md)，产品说明见 [README.md](README.md)。本文件不另设与它们冲突的行为规则。

- 桌面：Electron 44、原生 HTML/CSS/JavaScript；`npm start` 是完整开发入口。
- 官网：`website/` 的 React 19 / Vinext 工程，测试与构建独立进行。
- UI：暖白画布与灰色卡片，黑色顶部折叠条；布局约束见 [工作台设计](docs/DASHBOARD-DESIGN.md)。
- 数据与 IPC：保留旧工作区兼容、系统密钥隔离、远端内容限制及异步状态保护，见 [开发约定](docs/conventions.md)。
- 完整桌面检查：`npm test`；发布与验证边界见 [发布流程](docs/releasing.md)。

不要将个人路径、真实凭据、账单或用户截图写入源码、示例或公开说明。测试使用隔离数据和合成内容；用户已授权的正常修改、验证与构建直接推进。
