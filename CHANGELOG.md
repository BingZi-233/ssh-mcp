# Changelog

## [1.5.0] - 2026-06-25

### 新增

- **健康检查** (`health`)：一键收集远程服务器 OS/磁盘/内存/负载/CPU 信息
- **SSL 证书** (`cert-info`)：通过远程 openssl 拉取 SSL 证书，解析有效期/指纹/SAN
- **服务器间直传** (`copy-between`)：两台远程服务器之间 SFTP 直传，不经本地中转
- **配置对比** (`diff-servers`)：对比两台服务器上同一文件差异，定位配置漂移
- **脚本执行** (`exec-script`)：上传本机脚本 → 执行 → 自动清理，一站式
- **快照打包** (`snapshot`)：远程目录 tar.gz 流式下载到本机
- **持续追踪** (`tail-f` / `stop-tail` / `list-tails`)：SFTP 轮询模式实现 tail -f
- **定时监控** (`watch` / `stop-watch` / `list-watches`)：定时重复执行命令并高亮差异
- **远程 HTTP** (`curl`)：从远程服务器发起 HTTP 请求，获取内网视角
- **环境信息** (`env`)：收集远程环境变量、用户、端口监听、进程信息

## [1.4.0] - 2026-06-25

### 新增

- **端口转发**：`forward` / `list-forwards` / `close-forward`，支持本地转发（-L）和远程转发（-R）
- **批量执行**：`batch` 命令，一条命令并发在多台服务器上执行、汇总结果
- **SFTP 文件浏览**：`ls` 列出远程目录，`stat` 查看文件详细信息
- **SFTP 文件操作**：`rm` 删除远程文件/递归删除目录，`mkdir` 创建目录（支持 `--parents`）

## [1.3.0] - 2026-06-25

### 变更

- **纯命令行模式**：默认行为改为 CLI 子命令（`ssh-mcp run-command`、`ssh-mcp upload` 等）
- MCP stdio 模式通过 `--mcp` 标志显式启用，向后兼容
- 每个子命令支持 `--help` 查看详细用法
- 新增 Claude Code skill 使用指南（`.claude-plugin/skills/ssh-mcp.md`）

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
