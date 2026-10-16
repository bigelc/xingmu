# 醒目-个人效率工作台 官网

醒目 v2.0.0 的中文官网，与桌面应用源码一起维护。

- 官网：https://bigelc.github.io/xingmu/
- 源码：https://github.com/bigelc/xingmu
- 下载：https://github.com/bigelc/xingmu/releases/latest
- 环境：Node.js 22.13.0+

```bash
npm ci
npm run dev
npm test
npm run lint
npm run build
npm run build:pages
```

`build:pages` 默认使用 `/xingmu` 资源前缀，静态发布目录为 `dist/client`。如需部署至其他路径，可设置 `NEXT_PUBLIC_BASE_PATH`。

下载按钮在点击时读取 GitHub 最新正式 Release，分别查找同版本的 `Xingmu-<version>-arm64.dmg` 和 `Xingmu-<version>-windows-x64-setup.exe`。未发布对应安装包或查询失败时跳转发布页面；不会返回其他项目、架构或旧版本的文件。

首页使用代码绘制的浅色交互示意，支持切换待办、笔记、AI 用量与收起面板。示例内容全部虚构，未使用个人截图、录屏、账户余额或凭据。页面不加载外部字体，不接入分析服务。旧产品截图、录屏和历史托管项目绑定已移除。
