# ssh-mcp

纯命令行 SSH/SFTP 工具：在多台远程服务器上执行命令、传输大文件（断点续传）。支持 CLI 模式和 MCP stdio 模式（`--mcp`）。

[![NPM](https://img.shields.io/npm/v/@bingzi-233/ssh-mcp?color=CB3837&logo=npm)](https://www.npmjs.com/package/@bingzi-233/ssh-mcp)
[![Node](https://img.shields.io/node/v/@bingzi-233/ssh-mcp?color=339933&logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Stars](https://img.shields.io/github/stars/BingZi-233/ssh-mcp?color=EAC54F&logo=github)](https://github.com/BingZi-233/ssh-mcp/stargazers)
[![License](https://img.shields.io/github/license/BingZi-233/ssh-mcp?color=4A90D9)](https://github.com/BingZi-233/ssh-mcp/blob/master/LICENSE)
[![LINUX DO](https://img.shields.io/badge/LINUX_DO-社区认可-4A90D9?logo=discourse&logoColor=white)](https://linux.do)

## CLI 快速上手

```bash
# 安装
npm i -g @bingzi-233/ssh-mcp

# 查看帮助
ssh-mcp --help

# 列出服务器
ssh-mcp list-servers

# 执行远程命令
ssh-mcp run-command -s prod-web -c "df -h /"

# 上传文件（支持断点续传）
ssh-mcp upload -s prod-web -l ./dist.tar.gz -r /tmp/dist.tar.gz

# 下载文件
ssh-mcp download -s prod-web -r /var/log/app.log -l ./logs/app.log

# 传输进度
ssh-mcp transfer-status
```

## 命令一览

| 子命令 | 用途 |
|---|---|
| `list-servers` | 列出所有已配置的服务器 |
| `run-command` | 在远程服务器上执行命令 |
| `open-session` | 打开长连接会话（复用 TCP 连接） |
| `close-session` | 关闭长连接会话 |
| `list-sessions` | 列出当前所有长连接会话 |
| `upload` | 上传文件到远程（后台任务，断点续传） |
| `download` | 从远程下载文件（后台任务，断点续传） |
| `transfer-status` | 查看传输进度 |
| `cancel-transfer` | 取消传输 |

每个子命令运行 `ssh-mcp <子命令> --help` 查看详细用法。

## 配置 servers.json

默认从运行目录下 `./servers.json` 读取，或设置环境变量 `SSH_MCP_CONFIG`。

```json
{
  "security": {
    "blocked_patterns": []
  },
  "servers": [
    {
      "name": "prod-web",
      "description": "生产环境 Web 服务器",
      "host": "192.168.1.10",
      "port": 22,
      "username": "deploy",
      "privateKeyPath": "~/.ssh/id_rsa"
    },
    {
      "name": "db",
      "description": "数据库服务器",
      "host": "db.example.com",
      "username": "admin",
      "password": "your-password"
    }
  ]
}
```

鉴权优先级：私钥 → 密码 → ssh-agent。修改配置无需重启。

## 长连接会话

```bash
SID=$(ssh-mcp open-session -s prod-web)
ssh-mcp run-command -s prod-web --session $SID -c "hostname"
ssh-mcp run-command -s prod-web --session $SID -c "uptime"
ssh-mcp close-session -s $SID
```

复用 TCP 连接，省去重复握手和认证。注意每条命令仍在独立 channel 中执行，不保留工作目录。

## 安全策略

内置拦截高危命令：`rm -rf /`、`dd` 写块设备、`mkfs`、fork 炸弹。在 `servers.json` 的 `security.blocked_patterns` 中追加自定义正则。传 `--force` 跳过检查。

## MCP 模式

以 MCP stdio 服务运行（供 Claude Code 等 AI 客户端调用）：

```bash
# 手动注册
claude mcp add ssh -- npx -y @bingzi-233/ssh-mcp --mcp

# 或通过插件安装
/plugin marketplace add BingZi-233/ssh-mcp
/plugin install ssh-mcp@bingzi-plugins
```

## 社区

本项目由 [LINUX DO](https://linux.do) 社区孵化并认可。

## License

MIT © BingZi-233
