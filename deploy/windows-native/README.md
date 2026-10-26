# 与 OpenCode 2 共用会话

本分支通过现用 OpenCode 2.0.24 服务的 HTTP/SSE 接口继续原会话。会话 ID 和原工作目录保持不变，不导入、复制或降级原数据库。

## 构建

在仓库根目录执行：

```powershell
npm.cmd ci --ignore-scripts
npm.cmd rebuild better-sqlite3 --foreground-scripts
npm.cmd run build
npm.cmd ci --ignore-scripts --prefix web
npm.cmd run build --prefix web
```

需要全局安装且已配置的 OpenCode 2 CLI。启动时脚本会查询 `opencode service status`，必要时启动同一个标准后台服务，并读取本地服务凭据；不另起旧版 OpenCode。

## 运行

```powershell
.\deploy\windows-native\start.ps1 -RuntimeRoot C:\BridgeRuntime
.\deploy\windows-native\stop.ps1 -RuntimeRoot C:\BridgeRuntime
```

RuntimeRoot 保存 Bridge 自身的平台凭据、绑定和日志，不保存原 OpenCode 会话数据库。
已有 Bridge 可复用其 RuntimeRoot，但应先备份并停止旧 Bridge。停止脚本只停止该部署记录的 Bridge 进程，保留原 OpenCode 服务。

管理面板默认 http://127.0.0.1:4098。API 自动区分旧服务和 OpenCode 2，兼容层只在进程内运行。
Web 会话列表会直接显示原服务中的会话；模型及 Agent 列表按所选会话的原工作目录加载。
继续原会话时默认继承它当前的模型和 Agent，只有用户明确选择才切换。

钉钉中发送 `/sessions all` 查看会话，再发送 `/session 完整会话ID` 绑定；列表会附带完整切换命令。
升级前的独立旧版会话不属于原生服务，须重新选择原生会话后继续。

## 自启动

Windows 当前用户登录自启动仍由系统设置页控制，启动命令指向 RuntimeRoot 下自动生成的 `native-start.ps1`。
对应的 `native-stop.ps1` 也会自动生成。迁移旧部署后，在系统设置页重新启用自启动，使注册表指向新入口。

每次登录重新查询服务地址，支持原 OpenCode 服务端口变化。运行中的服务可重复启动，不产生重复 Bridge。
手动执行启动入口后，当前终端原有的 OpenCode 配置环境会恢复；Bridge 子进程保留自己的独立环境。

## 兼容范围与边界

支持会话分页、历史消息、续聊与附件、文本/思考/工具流、模型/Agent 显式切换、中断、权限回复、基础表单、重命名、会话撤回和删除的 API 映射。
现有旧版 SDK 连接仍走原接口。原生高级条件表单、外部授权表单应在 OpenCode 中回答；不支持的写接口明确返回错误，不尝试降级写数据库。
当前资源管理中的旧版配置编辑接口尚不等价于 OpenCode 2 配置体系，建议继续通过原 OpenCode 管理这些配置。

自动化测试使用合成数据。实机验证应创建专用会话，并禁止工具执行，避免修改现有项目或向真实钉钉会话发送测试消息。
