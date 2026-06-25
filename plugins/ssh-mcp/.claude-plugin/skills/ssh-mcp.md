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

### 批量执行

同时对多台服务器执行同一命令，并发执行、汇总结果。

```bash
ssh-mcp batch --servers web1,web2,web3 -c "systemctl status nginx"
ssh-mcp batch --servers prod-web,prod-api "df -h /" --force
```

### 端口转发

打通本地到内网的隧道。本地转发（-L）：本机端口 → SSH 服务器 → 内网目标。远程转发（-R）：SSH 服务器端口 → 回传到本机。

```bash
# 本地转发：本机 8080 → 经 prod-web → 内网 192.168.1.5:80
ssh-mcp forward -s prod-web -L 8080:192.168.1.5:80

# 远程转发：prod-web 的 9000 → 本机 localhost:3000
ssh-mcp forward -s prod-web -R 9000:127.0.0.1:3000

ssh-mcp list-forwards                     # 查看活跃转发
ssh-mcp close-forward -i f1               # 停止转发
```

### 文件浏览

通过 SFTP 列出远程目录、查看文件信息，无需执行 shell 命令。

```bash
ssh-mcp ls -s prod-web -p /var/log              # 简洁列表
ssh-mcp ls -s prod-web -p /var/www --long       # 详细模式（权限/大小/时间）
ssh-mcp stat -s prod-web -p /etc/nginx/nginx.conf   # 文件详细信息
```

### 远程文件操作

通过 SFTP 删除文件和创建目录，比 shell 命令更干净、更安全。

```bash
ssh-mcp rm -s prod-web -p /tmp/old.log                    # 删除文件
ssh-mcp rm -s prod-web -p /tmp/backup --recursive         # 递归删除目录
ssh-mcp mkdir -s prod-web -p /opt/app/logs --parents      # 创建目录（含父目录）
```

### 健康检查

一键收集远程服务器 OS/磁盘/内存/负载/CPU 信息。

```bash
ssh-mcp health -s prod-web
```

### SSL 证书检查

通过远程服务器的 openssl 拉取 SSL/TLS 证书信息，解析有效期、指纹、SAN。

```bash
ssh-mcp cert-info -s prod-web --host example.com
ssh-mcp cert-info -s prod-web --host 10.0.0.5 --port 8443
```

### 服务器间直传

两台远程服务器之间 SFTP 直传，数据不经本地中转。

```bash
ssh-mcp copy-between --src web1 --dst web2 --src-path /opt/app/config.yml --dst-path /opt/app/config.yml
```

### 配置对比

对比两台服务器上同一文件差异，定位配置漂移。

```bash
ssh-mcp diff-servers --server-a web1 --server-b web2 --path /etc/nginx/nginx.conf
```

### 脚本执行

上传本机脚本到远程，执行后自动删除。

```bash
ssh-mcp exec-script -s prod-web --script ./deploy.sh
```

### 快照打包

远程目录 tar.gz 流式下载到本机。

```bash
ssh-mcp snapshot -s prod-web --dir /var/log --output ./logs.tar.gz
ssh-mcp snapshot -s prod-web --dir /opt/app --output ./backup.tar.gz --exclude "*.log,node_modules"
```

### 持续追踪 (tail -f)

SFTP 轮询模式追踪远程文件的新增内容。

```bash
ssh-mcp tail-f -s prod-web -p /var/log/nginx/access.log
ssh-mcp list-tails
ssh-mcp stop-tail --id tail1
```

### 定时监控 (watch)

定时重复执行命令，自动高亮输出变化。

```bash
ssh-mcp watch -s prod-web --interval 5000 -c "ls -la /tmp"
ssh-mcp list-watches
ssh-mcp stop-watch --id w1
```

### 远程 HTTP 请求

从远程服务器发起 HTTP 请求，获取内网视角。

```bash
ssh-mcp curl -s prod-web http://localhost:8080/health
ssh-mcp curl -s prod-web -X POST -H "Content-Type: application/json" -d '{"a":1}' http://api.internal/users
```

### 环境信息收集

收集远程服务器的环境变量、登录用户、网络端口监听、进程信息。

```bash
ssh-mcp env -s prod-web
ssh-mcp env -s prod-web --process nginx
```

## 多服务器操作模式

可直接用 `batch` 命令，或用 shell 循环依次执行：

```bash
for s in prod-web prod-api prod-worker; do
  echo "=== $s ==="
  ssh-mcp run-command -s "$s" -c "systemctl status nginx"
done
```
