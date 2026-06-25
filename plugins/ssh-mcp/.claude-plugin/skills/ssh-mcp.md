---
name: ssh-mcp
description: 通过 ssh-mcp CLI 在多台远程服务器上执行命令、传输文件。SSH 连接管理、SFTP 大文件断点续传。
---

# ssh-mcp CLI

通过 `ssh-mcp` 命令行工具在远程服务器上执行 shell 命令、传输文件。

## 前置条件

已配置 `servers.json`（默认在当前目录，或通过 `SSH_MCP_CONFIG` 环境变量指定）：

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
    }
  ]
}
```

## 命令参考

### 列出服务器

```bash
ssh-mcp list-servers           # 人类可读格式
ssh-mcp list-servers --json    # JSON 格式
```

### 执行远程命令

```bash
ssh-mcp run-command --server <name> --command "<cmd>"
ssh-mcp run-command -s <name> -c "<cmd>"              # 短选项
ssh-mcp run-command -s <name> "<cmd>"                  # 命令放在选项后
ssh-mcp run-command -s <name> --timeout 120000 -c "<cmd>"  # 自定义超时(ms)
ssh-mcp run-command -s <name> --session <sid> -c "<cmd>"   # 复用长连接
ssh-mcp run-command -s <name> --force -c "<高危命令>"      # 跳过安全检查
```

stdout 输出到标准输出，stderr 到标准错误，退出码透传。

### 长连接会话

复用 TCP 连接，省去重复握手和认证。每条命令仍在独立 channel 中执行，不保留工作目录。

```bash
SESSION=$(ssh-mcp open-session -s prod-web)            # 打开会话，输出 session id
ssh-mcp run-command -s prod-web --session $SESSION -c "hostname"
ssh-mcp run-command -s prod-web --session $SESSION -c "uptime"
ssh-mcp list-sessions                                   # 列出所有会话
ssh-mcp close-session -s $SESSION                      # 关闭会话
```

### 文件上传

支持断点续传。对同一对路径再次调用自动从目标已有字节处继续。

```bash
ssh-mcp upload -s <name> -l <本地文件> -r <远程路径>
ssh-mcp upload -s prod-web -l ./dist.tar.gz -r /tmp/dist.tar.gz
ssh-mcp upload -s prod-web -l ./app.log -r /var/log/              # 若远程是目录则自动追加文件名
ssh-mcp upload -s prod-web -l ./data.bin -r /tmp/data.bin --overwrite  # 从头覆盖
```

### 文件下载

```bash
ssh-mcp download -s <name> -r <远程文件> -l <本地路径>
ssh-mcp download -s prod-web -r /var/log/app.log -l ./logs/app.log
ssh-mcp download -s prod-web -r /tmp/data.bin -l ./downloads/    # 若本地是目录则自动追加文件名
ssh-mcp download -s prod-web -r /tmp/data.bin -l ./data.bin --overwrite
```

### 传输进度

传输在后台进行。用 `transfer-status` 轮询进度。

```bash
ssh-mcp transfer-status            # 列出所有传输任务
ssh-mcp transfer-status -i t1      # 查看指定任务
```

### 取消传输

```bash
ssh-mcp cancel-transfer -i t1
```

## 安全策略

内置拦截以下高危命令：
- `rm -rf /` / `rm -rf /*` 递归删除根目录
- `dd` 写入块设备 (`of=/dev/sd*`)
- `mkfs.*` 在块设备上创建文件系统
- `>` 重定向覆盖块设备
- fork 炸弹 `:(){ :|:& };:`

在 `servers.json` 中追加自定义正则：
```json
{
  "servers": [...],
  "security": {
    "blocked_patterns": ["shutdown\\s+-h", "reboot"]
  }
}
```

使用 `--force` 跳过所有安全检查（需明确知道自己在做什么）。

## 多服务器操作模式

当需要同时在多台服务器上执行命令时，依次调用即可：

```bash
for s in prod-web prod-api prod-worker; do
  echo "=== $s ==="
  ssh-mcp run-command -s "$s" -c "systemctl status nginx"
done
```
