# ssh-mcp

一个本地 MCP 服务器，让 Claude 通过 SSH 在**多台**远程服务器上执行命令。
每台服务器配一个 `name`，模型靠 `name` 区分目标机器。

## 工具

| 工具 | 作用 |
|---|---|
| `list_servers` | 列出所有已配置的服务器（name / 描述 / 地址 / 用户，**不含密码私钥**） |
| `run_command` | 在指定 `name` 的服务器上执行一条命令，返回 stdout / stderr / 退出码 |

> 命令在独立会话中执行，**命令之间不保留工作目录和环境变量**。
> 需要保持上下文时自行串接，例如 `cd /var/www && git pull`。

## 安装与构建

```bash
npm install
npm run build
```

## 配置服务器

默认从 `~/.ssh-mcp/servers.json` 读取（可用环境变量 `SSH_MCP_CONFIG` 指定别的路径）。
参考 `servers.example.json`：

```json
{
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

**鉴权优先级**（每台服务器独立选择）：

1. `privateKeyPath`（+ 可选 `passphrase`）—— 私钥文件，支持 `~` 展开
2. `password` —— 密码登录
3. 都没配 → 回退到本机 `ssh-agent`（读 `SSH_AUTH_SOCK`）

新增/修改服务器后**无需重启**——配置文件每次调用都会重新读取。

## 注册到 Claude Code

```bash
claude mcp add ssh -- node C:/Users/ziyou/IdeaProjects/ssh-mcp/dist/index.js
```

需要自定义配置文件路径时：

```bash
claude mcp add ssh -e SSH_MCP_CONFIG=C:/path/to/servers.json -- node C:/Users/ziyou/IdeaProjects/ssh-mcp/dist/index.js
```

或在 `.mcp.json` / Claude Desktop 配置里手写：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["C:/Users/ziyou/IdeaProjects/ssh-mcp/dist/index.js"],
      "env": { "SSH_MCP_CONFIG": "C:/Users/ziyou/.ssh-mcp/servers.json" }
    }
  }
}
```

## ⚠️ 安全提示

这个工具允许模型在你的服务器上执行**任意命令**。请仅指向你拥有/授权的机器：

- `servers.json` 含明文凭据，已在 `.gitignore` 中排除，**切勿提交到仓库**。
- 优先用私钥或 `ssh-agent`，尽量不在配置里写明文密码。
- 给 SSH 账号最小权限；高危机器考虑用只读/受限账号。
- 默认每条命令 60s 超时，可用 `run_command` 的 `timeout_ms` 调整。
