# ssh-mcp

一个 MCP 服务器，让 Claude 通过 **SSH** 在多台远程服务器上执行命令、并通过 **SFTP** 传输大文件（支持 40GB+ 与断点续传）。每台服务器配一个 `name`，模型靠 `name` 区分目标机器。

## 工具

| 工具 | 作用 |
|---|---|
| `list_servers` | 列出所有已配置的服务器（name / 描述 / 地址 / 用户，**不含密码私钥**） |
| `run_command` | 在指定 `name` 的服务器上执行一条命令，返回 stdout / stderr / 退出码 |
| `open_session` | 建立到服务器的长连接会话，返回会话 id 供 `run_command` 复用 |
| `close_session` | 关闭长连接会话 |
| `list_sessions` | 列出当前所有活跃的长连接会话 |
| `upload_file` | 上传本机文件到远程（后台任务，支持断点续传） |
| `download_file` | 从远程下载文件到本机（后台任务，支持断点续传） |
| `transfer_status` | 查询传输进度（已传字节、百分比、速度、ETA、状态） |
| `cancel_transfer` | 取消一个进行中的传输（已传部分保留，可续传） |

> - **长连接**：用 `open_session` 建立持久连接，`run_command` 传入 `session` 参数复用，省去重复握手和认证开销。即便复用了连接，每条命令仍在独立 channel 中执行，工作目录和环境变量不保留。
> - **安全策略**：内置拦截 `rm -rf /`、`dd` 写块设备、`mkfs`、fork 炸弹等高危命令。可在 `servers.json` 的 `security.blocked_patterns` 中追加自定义正则。传入 `force=true` 可绕过。
> - 命令在独立会话中执行，**命令之间不保留工作目录和环境变量**。需要保持上下文时自行串接，例如 `cd /var/www && git pull`。
> - 大文件传输是**后台任务**：`upload_file`/`download_file` 立即返回一个传输 id，用 `transfer_status` 轮询进度，不阻塞。
> - **断点续传**基于目标文件的实际大小：对同一对路径再次发起传输会自动从已传字节处继续，进程重启后依然有效。

---

## 安装

### 方式一：作为 Claude Code 插件（推荐）

```shell
/plugin marketplace add BingZi-233/ssh-mcp
/plugin install ssh-mcp@bingzi-plugins
```

插件会通过 `npx` 拉起已发布的 npm 包，因此**需要先把包发布到 npm**（见下文「发布到 npm」）。

### 方式二：作为 MCP 服务器手动注册

```bash
claude mcp add ssh -- npx -y @bingzi-233/ssh-mcp
```

需要自定义配置文件路径时：

```bash
claude mcp add ssh -e SSH_MCP_CONFIG=/path/to/servers.json -- npx -y @bingzi-233/ssh-mcp
```

### 方式三：本地源码构建（开发用）

```bash
npm install
npm run build
claude mcp add ssh -- node /绝对路径/ssh-mcp/dist/index.js
```

---

## 配置服务器

默认从**运行目录下的 `./servers.json`** 读取（即 Claude 启动 MCP 服务器时所在的工作目录，通常是你当前的项目根目录）。也可用环境变量 `SSH_MCP_CONFIG` 指定任意路径。参考 `servers.example.json`：

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

**鉴权优先级**（每台服务器独立选择）：

1. `privateKeyPath`（+ 可选 `passphrase`）—— 私钥文件，支持 `~` 展开
2. `password` —— 密码登录
3. 都没配 → 回退到本机 `ssh-agent`（读 `SSH_AUTH_SOCK`）

新增/修改服务器后**无需重启**——配置文件每次调用都会重新读取。

---

## ⚠️ 安全提示

这个工具允许模型在你的服务器上执行**任意命令**、读写文件。请仅指向你拥有/授权的机器：

- `servers.json` 含明文凭据，已在 `.gitignore` 中排除，**切勿提交到仓库**。
- 优先用私钥或 `ssh-agent`，尽量不在配置里写明文密码。
- 给 SSH 账号最小权限；高危机器考虑用受限账号。
- 内置命令安全策略会拦截 `rm -rf /`、`dd` 写块设备、`mkfs`、fork 炸弹等高危模式。可在 `security.blocked_patterns` 中追加自定义正则（JSON 字符串，需双重转义，如 `"rm\\\\s.*-rf?\\\\s+/\\\\*"`）。传 `force=true` 可绕过。

## License

MIT © BingZi-233
