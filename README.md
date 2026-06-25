# ssh-mcp

纯命令行 SSH/SFTP 工具：远程执行命令、批量操作、大文件传输（断点续传）、端口转发、健康检查、配置对比、快照打包、tail -f、watch 等 27 个子命令。CLI + MCP 双模式。

[![NPM](https://img.shields.io/npm/v/@bingzi-233/ssh-mcp?color=CB3837&logo=npm)](https://www.npmjs.com/package/@bingzi-233/ssh-mcp)
[![Node](https://img.shields.io/node/v/@bingzi-233/ssh-mcp?color=339933&logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Stars](https://img.shields.io/github/stars/BingZi-233/ssh-mcp?color=EAC54F&logo=github)](https://github.com/BingZi-233/ssh-mcp/stargazers)
[![License](https://img.shields.io/github/license/BingZi-233/ssh-mcp?color=4A90D9)](https://github.com/BingZi-233/ssh-mcp/blob/master/LICENSE)
[![LINUX DO](https://img.shields.io/badge/LINUX_DO-社区认可-4A90D9?logo=discourse&logoColor=white)](https://linux.do)

## CLI 快速上手

```bash
npm i -g @bingzi-233/ssh-mcp

ssh-mcp list-servers                                     # 列出服务器
ssh-mcp run-command -s prod-web -c "df -h /"             # 执行命令
ssh-mcp batch --servers web1,web2,web3 -c "uptime"       # 批量执行
ssh-mcp upload -s prod-web -l ./dist.tar.gz -r /tmp/     # 上传文件
ssh-mcp health -s prod-web                               # 健康检查
ssh-mcp ls -s prod-web -p /var/log                       # 列出目录
ssh-mcp tail-f -s prod-web -p /var/log/app.log           # 追尾日志
ssh-mcp forward -s prod-web -L 8080:192.168.1.5:80       # 端口转发
```

## 命令一览

| 子命令 | 用途 |
|---|---|
| `list-servers` | 列出所有已配置的服务器 |
| `run-command` | 在远程服务器上执行命令 |
| `batch` | 在多台服务器上批量执行同一命令 |
| `open-session` / `close-session` / `list-sessions` | 长连接会话管理 |
| `upload` / `download` | 大文件传输（后台任务，断点续传） |
| `transfer-status` / `cancel-transfer` | 传输进度与取消 |
| `forward` / `list-forwards` / `close-forward` | SSH 端口转发（本地/远程） |
| `ls` / `stat` | 列出远程目录、查看文件信息 |
| `rm` / `mkdir` | 删除远程文件/目录、创建远程目录 |
| `health` | 一键健康检查（OS/磁盘/内存/负载/CPU） |
| `cert-info` | 查看 SSL/TLS 证书信息 |
| `copy-between` | 服务器间直传文件（不经本地中转） |
| `diff-servers` | 对比两台服务器同一文件差异 |
| `exec-script` | 上传脚本执行并自动清理 |
| `snapshot` | 远程目录 tar.gz 打包下载 |
| `tail-f` / `stop-tail` / `list-tails` | 持续追踪远程文件（SFTP） |
| `watch` / `stop-watch` / `list-watches` | 定时重复执行命令并高亮差异 |
| `curl` | 从远程服务器发起 HTTP 请求 |
| `env` | 收集远程服务器环境信息 |

每个子命令运行 `ssh-mcp <子命令> --help` 查看详细用法。

## 配置 servers.json

默认从运行目录下 `./servers.json` 读取，或设置环境变量 `SSH_MCP_CONFIG`。

```json
{
  "security": { "blocked_patterns": [] },
  "servers": [
    {
      "name": "prod-web",
      "description": "生产环境",
      "host": "192.168.1.10",
      "port": 22,
      "username": "deploy",
      "privateKeyPath": "~/.ssh/id_rsa"
    }
  ]
}
```

鉴权优先级：私钥 → 密码 → ssh-agent。修改配置无需重启。

## 端口转发

```bash
# 本地转发：本机 8080 → 经 SSH 服务器 → 内网 192.168.1.5:80
ssh-mcp forward -s prod-web -L 8080:192.168.1.5:80

# 远程转发：SSH 服务器 9000 → 回传到本机 localhost:3000
ssh-mcp forward -s prod-web -R 9000:127.0.0.1:3000

ssh-mcp list-forwards
ssh-mcp close-forward -i f1
```

## 批量执行

```bash
ssh-mcp batch --servers prod-web,prod-api,prod-worker -c "systemctl status nginx"
```

## 安全策略

内置拦截高危命令：`rm -rf /`、`dd` 写块设备、`mkfs`、fork 炸弹。在 `servers.json` 的 `security.blocked_patterns` 中追加自定义正则。传 `--force` 跳过检查。

## MCP 模式

以 MCP stdio 服务运行（供 Claude Code 等 AI 客户端调用）：

```bash
claude mcp add ssh -- npx -y @bingzi-233/ssh-mcp --mcp
/plugin marketplace add BingZi-233/ssh-mcp
/plugin install ssh-mcp@bingzi-plugins
```

## 社区

本项目由 [LINUX DO](https://linux.do) 社区孵化并认可。

## License

MIT © BingZi-233
