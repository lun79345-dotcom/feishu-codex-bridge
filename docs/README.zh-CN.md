# 中文部署指南

这是一个自托管飞书机器人：把员工私聊转交给 Codex CLI，支持连续聊天、生图、图片与文件输入，以及文件回传。每位员工分别保存会话、附件、任务和回传目标。默认回复中文。

## 环境与安装

目前仅 macOS 原部署经过验证。建议 Node.js 22 或更新版本。安装并登录 Codex CLI，安装官方 `@larksuite/cli`，完成你自己的飞书应用配置和授权。按各工具官方说明操作，不要把密码、App Secret 或登录令牌放进项目、Issue 或聊天里。

原部署使用 Lark CLI 1.0.97、Codex CLI 0.162.0-alpha.2。程序依赖自定义文件权限、特定功能开关、JSON Schema 输出和原生生图；不同版本可能不兼容，不要通过关闭沙箱解决兼容问题。图片能力及模型可用性以你的账号和安装版本为准。

1. 在飞书后台启用机器人，配置并发布消息接收事件 `im.message.receive_v1`，授予私聊收发与附件所需权限，并配置应用可见范围。
2. 通过 `lark-cli config init --help`、`lark-cli auth login --help` 查看当前版本的配置流程。核对 CLI 当前选中的应用正是目标机器人。
3. 复制 `bridge.config.example.json` 为 `bridge.config.json`。填入实际 CLI 路径、所有者的 `oc_` 私聊 ID 和 `ou_` 用户 open ID。示例不会包含任何现有机器人的绑定。
4. 执行 `npm test`，然后 `npm start`。确认日志出现 `event receiver ready`，用所有者账号私聊机器人进行验收。
5. 验证员工之间的上下文、命令和文件访问隔离，再将 `teamMode` 改为 `true`。应用可见范围内的用户才能接入。所有员工共用当前登录账号额度，全局串行处理。

## 用法

直接发送自然语言：“写一个 30 秒广告脚本”“改短一点”“生成适合这个脚本的图片”。也可以先上传图片或文件再提问。

- `帮助`：查看功能。
- `状态`：查询自己的任务。
- `新对话`：建立自己的新上下文，旧文件保留。
- `停止`：取消自己的当前及排队任务。
- `重试`：重做自己最近失败或中断的任务，可能再次消耗额度。

## 后台运行（macOS）

先在前台完成验收。复制 `examples/io.github.feishu-codex-bridge.plist` 到 `~/Library/LaunchAgents/`，替换其中全部 `REPLACE_…` 占位符。Node 路径必须为绝对路径，项目路径使用真实路径；配置中 CLI 也建议使用绝对路径。先创建项目的 `.bridge` 文件夹供日志使用。若 XML 路径包含 `&` 等字符，需进行 XML 转义。

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.github.feishu-codex-bridge.plist"
launchctl print "gui/$(id -u)/io.github.feishu-codex-bridge"
```

这是登录后启动的用户服务，不是未登录即运行的系统服务。保持电脑接电、联网、不休眠。合盖或系统休眠仍可能暂停服务。

## 停止与迁移

同一机器人不要同时运行多个部署。先禁用旧机器的后台服务，再关闭该应用的长连接：

```sh
launchctl disable "gui/$(id -u)/io.github.feishu-codex-bridge"
launchctl bootout "gui/$(id -u)/io.github.feishu-codex-bridge"
lark-cli event stop --app-id YOUR_APP_ID --json
lark-cli event status
```

确认无残留的本项目 `bridge.mjs` 和事件消费者进程。若事件总线仍有消费者，先核对它们是否都属于本部署，再停止对应进程；仅在确认后使用 `event stop --app-id YOUR_APP_ID --force --json`，不要使用 `--all` 影响其他机器人。恢复服务需要显式 `launchctl enable` 后再 `bootstrap`。

在新机器重新登录，不迁移凭据。默认从新会话开始。如需旧历史，先停止旧服务并备份，再单独处理状态中的绝对路径、Codex 会话及文件迁移；仅复制 `.bridge/state.json` 不足以恢复完整上下文。

## 数据与验收

`.bridge/` 保存运行状态、去重、队列、回传结果、事件和日志；`output/` 保存员工附件及输出。不要在运行时删除或手改状态。管理员可以读取这些数据，需自行制定备份与保留期限。

验收包括两轮连续记忆、重置、真实生图、文件回传、两位员工互不串上下文、取消只影响本人、跨目录读取被系统拒绝、重启恢复，以及正式私聊收发。单元测试通过不代表飞书后台权限或模型能力已经验证。详见 [安全边界](../SECURITY.md)。
