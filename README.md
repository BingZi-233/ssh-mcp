# ssh-mcp

> 面向多服务器运维的 SSH / SFTP CLI 与 MCP 服务。
>
> 用一份可审计的服务器配置，完成远程命令、文件传输、端口转发和基础健康检查。

[![npm](https://img.shields.io/npm/v/@bingzi-233/ssh-mcp?color=CB3837&logo=npm)](https://www.npmjs.com/package/@bingzi-233/ssh-mcp)
[![Node.js](https://img.shields.io/node/v/@bingzi-233/ssh-mcp?color=339933&logo=nodedotjs)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/BingZi-233/ssh-mcp?color=EAC54F&logo=github)](https://github.com/BingZi-233/ssh-mcp/stargazers)
[![License](https://img.shields.io/github/license/BingZi-233/ssh-mcp)](LICENSE)
[![LINUX DO](https://img.shields.io/badge/LINUX_DO-%E7%A4%BE%E5%8C%BA%E8%AE%A4%E5%8F%AF-4A90D9?logo=discourse&logoColor=white)](https://linux.do)

ssh-mcp 把日常 SSH 操作收敛成一个可脚本化的命令行工具，也可以作为 MCP stdio 服务接入 Claude Code、Codex 等客户端。它不替代服务器权限系统：连接使用现有 SSH 凭据，命令仍在目标服务器上执行，安全拦截只作为额外保护层。

> 当前版本：**1.5.2** · Node.js **18+** · MIT

**[安装](#安装)** · **[5 分钟上手](#5-分钟上手)** · **[配置](#配置服务器)** · **[命令参考](#命令总览)** · **[MCP 接入](#mcp-模式)**

## 核心能力

| 能力 | 说明 |
|---|---|
| 远程执行 | 单台或批量执行命令，保留 stdout、stderr 和退出码 |
| 文件传输 | SFTP 后台任务、进度轮询、取消和断点续传 |
| 网络通道 | 本地转发和远程转发，访问内网 HTTP 或 TCP 服务 |
| 运行检查 | 健康检查、证书信息、环境信息、远程 HTTP 请求 |
| 配置运维 | 服务器间直传、配置对比、目录快照、脚本执行 |
| AI 接入 | MCP stdio 服务和 Claude/Codex 插件清单 |

## 适合什么场景

- 日常登录多台服务器，快速执行命令并保留清晰的退出码和输出。
- 上传或下载大文件，任务在后台运行并支持断点续传。
- 从跳板机访问内网 HTTP 服务或数据库端口。
- 让 MCP 客户端在明确的服务器配置和安全策略下执行运维动作。

## 安装

```bash
npm install -g @bingzi-233/ssh-mcp
ssh-mcp --help
```

从源码安装：

```bash
git clone https://github.com/BingZi-233/ssh-mcp.git
cd ssh-mcp
npm ci
npm run build
npm link
```

## 5 分钟上手

```bash
cp servers.example.json servers.json
$EDITOR servers.json

ssh-mcp list-servers
ssh-mcp run-command -s prod-web -c "hostname && uptime"
ssh-mcp health -s prod-web
```

如果配置文件不在当前目录：

```bash
SSH_MCP_CONFIG=~/.config/ssh-mcp/servers.json ssh-mcp list-servers
```

## 配置服务器

默认读取当前工作目录的 `servers.json`，也可以用 `SSH_MCP_CONFIG` 指定路径。配置每次调用都会重新读取，修改后不需要重启进程。

```json
{
  "security": {
    "blocked_patterns": ["shutdown\\s+-h", "reboot"]
  },
  "servers": [
    {
      "name": "prod-web",
      "description": "生产 Web",
      "host": "192.168.1.10",
      "port": 22,
      "username": "deploy",
      "privateKeyPath": "~/.ssh/id_ed25519"
    },
    {
      "name": "staging",
      "host": "staging.example.com",
      "username": "deploy",
      "password": "仅供本地测试使用"
    }
  ]
}
```

复制示例配置：

```bash
cp servers.example.json servers.json
export SSH_MCP_CONFIG="$PWD/servers.json"
```

认证优先级为：私钥 → 密码 → `SSH_AUTH_SOCK` 中的 ssh-agent。不要把真实密码或私钥提交到 Git；`servers.json` 默认已被 `.gitignore` 排除。

## CLI 快速开始

```bash
ssh-mcp list-servers
ssh-mcp run-command -s prod-web -c "hostname && uptime"
ssh-mcp batch --servers prod-web,staging -c "df -h /"
ssh-mcp health -s prod-web
```

每个命令都有独立帮助：

```bash
ssh-mcp <命令> --help
```

### 命令总览

| 命令 | 用途 |
|---|---|
| `list-servers` | 列出配置的服务器 |
| `run-command` | 执行远程 shell 命令 |
| `batch` | 并发执行批量命令 |
| `open-session` / `close-session` / `list-sessions` | 管理可复用 SSH 长连接 |
| `upload` / `download` | SFTP 后台传输与断点续传 |
| `transfer-status` / `cancel-transfer` | 查看或取消传输任务 |
| `forward` / `list-forwards` / `close-forward` | 本地或远程 SSH 端口转发 |
| `ls` / `stat` / `rm` / `mkdir` | SFTP 浏览和文件操作 |
| `health` | OS、磁盘、内存、负载和 CPU 检查 |
| `cert-info` | 检查远程 SSL/TLS 证书 |
| `copy-between` | 两台远程服务器之间直传 |
| `diff-servers` | 对比两台服务器的同一路径 |
| `exec-script` | 上传、执行并清理脚本 |
| `snapshot` | 将远程目录打包下载为 tar.gz |
| `tail-f` / `stop-tail` / `list-tails` | 轮询追踪远程文件 |
| `watch` / `stop-watch` / `list-watches` | 定时执行命令并显示变化 |
| `curl` | 从远程网络环境发起 HTTP 请求 |
| `env` | 收集远程环境信息 |

## 常用操作

### 长连接会话

长连接只复用 TCP 和认证；每条命令仍在独立 channel 中执行，不会保留 `cd` 或环境变量。

```bash
ssh-mcp open-session -s prod-web
# 从输出中取得 s1
ssh-mcp run-command -s prod-web --session s1 -c "hostname"
ssh-mcp close-session -i s1
```

### 文件传输与续传

目标文件已有部分内容时，默认从目标大小处继续；使用 `--overwrite` 从头开始。

```bash
ssh-mcp upload -s prod-web -l ./release.tar.gz -r /tmp/
ssh-mcp transfer-status
ssh-mcp download -s prod-web -r /var/log/app.log -l ./logs/ --overwrite
ssh-mcp cancel-transfer -i t1
```

### 端口转发

```bash
# 本机 8080 → SSH 服务器 → 内网 192.168.1.5:80
ssh-mcp forward -s prod-web -L 8080:192.168.1.5:80

# SSH 服务器 9000 → 本机 localhost:3000
ssh-mcp forward -s prod-web -R 9000:127.0.0.1:3000

ssh-mcp list-forwards
ssh-mcp close-forward -i f1
```

### 服务器间直传和配置对比

```bash
ssh-mcp copy-between --src web1 --dst web2 \
  --src-path /opt/app/config.yml --dst-path /opt/app/config.yml

ssh-mcp diff-servers --server-a web1 --server-b web2 \
  --path /etc/nginx/nginx.conf
```

## 安全策略

`run-command` 默认拦截以下高危模式：

- `rm -rf /`、`rm -rf /*` 等根目录递归删除
- `dd` 覆盖块设备
- `mkfs.*` 在块设备上创建文件系统
- 重定向覆盖块设备
- fork bomb

可以在 `security.blocked_patterns` 中追加正则。`--force` 会跳过内置和自定义检查，只应在确认目标和命令后使用。安全策略是最后一道保护，仍应使用最小权限账号、SSH key 和服务器侧审计。

## MCP 模式

以 stdio MCP 服务启动：

```bash
npx -y @bingzi-233/ssh-mcp --mcp
```

Claude Code：

```bash
claude mcp add ssh -- npx -y @bingzi-233/ssh-mcp --mcp
```

本仓库也包含 Claude/Codex 插件清单：

```bash
/plugin marketplace add BingZi-233/ssh-mcp
/plugin install ssh-mcp@bingzi-plugins

codex plugin marketplace add BingZi-233/ssh-mcp
codex plugin add ssh-mcp@bingzi-plugins
```

Codex 插件目录位于 [`plugins/ssh-mcp`](plugins/ssh-mcp)，其中的 `.codex-plugin/plugin.json`、`.mcp.json` 和 `skills/` 与 Claude 插件配置共用同一套 npm MCP 服务。

MCP 客户端启动前，请确保工作目录中存在 `servers.json`，或在客户端配置中设置 `SSH_MCP_CONFIG`。可用工具会从配置文件动态读取服务器列表。

## 开发与验证

```bash
npm ci
npm run build
npm audit --omit=dev
npm run dev
```

发布流程：推送 `v*` 标签后，GitHub Actions 会构建并发布 npm 包。发布前请确认版本号、CHANGELOG、`npm run build` 和安全审计均通过。

## 排障

**找不到服务器配置**

确认当前目录有 `servers.json`，或检查：

```bash
echo "$SSH_MCP_CONFIG"
ssh-mcp --help
```

**认证失败**

确认 `username`、私钥路径和私钥口令；私钥支持 `~` 展开。也可以先运行 `ssh -v` 验证系统 SSH 凭据。

**传输没有结束**

传输是后台任务，使用 `transfer-status` 查看状态。若目标文件大小超过源文件，使用 `--overwrite` 重新开始。

**MCP 客户端看不到工具**

确认启动参数包含 `--mcp`，配置文件路径可读，并从客户端日志检查 stdio 进程是否正常启动。

## 许可证

MIT © BingZi-233

## 社区

本项目由 [LINUX DO](https://linux.do) 社区孵化并认可。
