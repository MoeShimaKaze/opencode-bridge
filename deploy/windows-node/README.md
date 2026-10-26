# Windows Node 部署修复

这里保存已经验证的独立部署脚本，供后续源码维护参考。
它们使用 npm 发布的 Bridge 3.1.5 和配套 OpenCode 1.19.4，尚未实现 OpenCode 2.0 接口适配。

## 安装与运行

需要 Windows、Node.js 22，以及已有的 `~/.config/opencode/opencode.json`。
在本目录中执行：

```powershell
npm.cmd ci --ignore-scripts --omit=dev
npm.cmd rebuild better-sqlite3 --foreground-scripts
.\start.ps1
```

管理面板位于 http://127.0.0.1:4098；在平台接入页配置钉钉 Stream 应用凭据。
停止时运行 `.\stop.ps1`。启动脚本可重复运行，不会替换已运行的实例。
系统设置页的自启动开关可注册或移除当前用户的 Windows 登录启动项。

## 修复范围

- 绕过 npm 发布包缺失的 preinstall 镜像设置脚本，单独安装 SQLite 原生依赖。
- 为 Bridge 提供与其现有 SDK 兼容的独立 OpenCode 运行环境。
- 从原配置同步模型和 Markdown Agent，保留 Agent 的模型、模式、提示词及权限。
- 保留在 Bridge 中选择的默认模型，不在重启时重置。
- 管理面板仅监听 127.0.0.1。
- 兼容飞书禁用时仍被无条件初始化的新版 SDK。
- 为 Node 部署接入可在面板控制的 Windows 登录自启动。
- 兼容系统自带 Windows PowerShell 5.1 的参数传递和 JSON 数组行为。

`prepare.mjs` 会对已安装的 Bridge 构建文件应用有限的兼容修改；
这是部署修复快照，后续应将适用修复移入本仓库 TypeScript 源码和对应测试。

## 会话隔离

原有全局 OpenCode 安装和数据库不被覆盖。
配套版本的数据、缓存及配置位于本目录的 `profile/`，与原 OpenCode 2.0 历史会话分开。
因此这套部署不能直接共享原 OpenCode 2.0 的会话。
若要实时共享，需通过 OpenCode 2.0 API 实现兼容客户端；不能将旧程序直接指向新版数据库。

## 验证

服务启动后运行：

```powershell
node --test autostart.test.mjs verify-agents.test.mjs
```

测试会检查本机 Agent 的可见性及关键配置保留，并验证 Windows 登录启动脚本重复执行时仍使用同一 Bridge 进程。
它们依赖本地配置和运行中的服务，不属于上游纯单元测试套件。

## 本地数据

钉钉与服务凭据保存在 `data/config.db`；模型配置副本位于 `profile/opencode.json`；日志位于 `logs/`。
这些目录、进程记录、会话绑定及环境文件均应保持在版本库外。
