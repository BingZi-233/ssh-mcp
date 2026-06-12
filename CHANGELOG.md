# Changelog

## [1.2.0] - 2026-06-12

### 新增

- 内置命令安全策略，自动拦截 `rm -rf /`、`dd` 写块设备、`mkfs`、fork 炸弹等高危命令
- `run_command` 新增 `force` 参数，传入 `true` 可绕过安全检查
- 支持在 `servers.json` 的 `security.blocked_patterns` 中追加自定义拦截正则

## [1.1.0] - 2026-06-12

### 新增

- 长连接会话：`open_session` 建立持久 SSH 连接，`close_session` 释放，`list_sessions` 查看
- `run_command` 新增 `session` 参数，传入会话 id 则复用已有 TCP 连接，省去重复握手和认证

## [1.0.1]

### 变更

- 默认配置路径改为运行目录下的 `./servers.json`
- 移除 README 中的内部维护者发布说明
- 支持 npm 自动发布与 Claude 插件分发

## [1.0.0] - 2026-06

### 新增

- SSH 多服务器管理：通过 `name` 区分目标服务器，支持私钥/密码/ssh-agent 三种鉴权
- `list_servers` / `run_command` — 列出服务器，执行远程命令
- `upload_file` / `download_file` — SFTP 大文件传输，支持 40GB+ 与断点续传
- `transfer_status` / `cancel_transfer` — 传输进度轮询与取消
