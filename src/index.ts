#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configPath, loadSecurity, loadServers, validateCommand } from "./config.js";
import {
  closeSession,
  listSessions,
  openSession,
  runCommand,
} from "./ssh.js";
import {
  cancelTransfer,
  getTransfer,
  listTransfers,
  startTransfer,
  type Transfer,
} from "./transfer.js";
import {
  startForward,
  listForwards,
  closeForward,
} from "./forward.js";
import {
  listDirectory,
  statPath,
  removePath,
  makeDir,
  formatLsLong,
  formatLsShort,
  type FileEntry,
  type FileStat,
} from "./sftp-ops.js";

const DEFAULT_TIMEOUT_MS = 60_000;

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function humanDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTransfer(t: Transfer): string {
  const pct = t.totalBytes > 0 ? (t.transferredBytes / t.totalBytes) * 100 : 100;
  const movedThisSession = t.transferredBytes - t.startOffset;
  const elapsedSec = Math.max((t.updatedAt - t.startedAt) / 1000, 0.001);
  const speed = movedThisSession / elapsedSec;
  const remaining = t.totalBytes - t.transferredBytes;
  const eta = t.state === "running" && speed > 0 ? remaining / speed : NaN;

  const lines = [
    `[${t.id}] ${t.direction === "upload" ? "上传" : "下载"} @ ${t.server} — ${t.state}`,
    `  本地: ${t.localPath}`,
    `  远程: ${t.remotePath}`,
    `  进度: ${humanBytes(t.transferredBytes)} / ${humanBytes(t.totalBytes)} (${pct.toFixed(1)}%)`,
  ];
  if (t.startOffset > 0) lines.push(`  续传起点: ${humanBytes(t.startOffset)}`);
  if (t.state === "running") {
    lines.push(`  速度: ${humanBytes(speed)}/s   预计剩余: ${humanDuration(eta)}`);
  }
  if (t.error) lines.push(`  错误: ${t.error}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP server setup (--mcp mode)
// ---------------------------------------------------------------------------
function createMcpServer(): McpServer {
  const server = new McpServer({ name: "ssh-mcp", version: "1.4.0" });

  server.registerTool(
    "list_servers",
    {
      title: "列出可用的 SSH 服务器",
      description:
        "列出所有已配置的远程服务器及其 name、描述、地址和登录用户。" +
        "在使用 run_command 之前，先用本工具确认有哪些服务器以及对应的 name。" +
        "（不会返回任何密码或私钥等敏感信息。）",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const servers = loadServers();
        const list = [...servers.values()].map((s) => ({
          name: s.name,
          description: s.description ?? "",
          host: s.host,
          port: s.port ?? 22,
          username: s.username,
        }));
        const text =
          list.length > 0
            ? JSON.stringify(list, null, 2)
            : `没有已配置的服务器。请编辑配置文件：${configPath()}`;
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return {
          content: [{ type: "text", text: `读取服务器配置失败：${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "run_command",
    {
      title: "在远程服务器上执行命令",
      description:
        "通过 SSH 在指定的远程服务器上执行一条 shell 命令，返回 stdout、stderr 和退出码。" +
        "用 server 参数指定目标服务器的 name（可先用 list_servers 查看）。" +
        "可选传入 session（长连接会话 id）复用已有 TCP 连接，省去重复握手和认证；" +
        "不传则每次新建连接、执行完即断开（短连接）。" +
        "内置安全策略会拦截 rm -rf /、dd 写块设备、mkfs、fork 炸弹等高危命令，" +
        "可在 servers.json 的 security.blocked_patterns 中追加自定义正则。" +
        "传入 force=true 可绕过安全检查（需明确知道自己在做什么）。" +
        "注意：即便是长连接，每条命令仍在独立 channel 中执行，命令之间不保留工作目录或环境变量；" +
        "需要保持上下文时请自行串接，例如 `cd /var/www && git pull`。",
      inputSchema: {
        server: z.string().describe("目标服务器的 name，必须与 list_servers 返回的某个 name 完全一致"),
        command: z.string().describe("要在远程服务器上执行的 shell 命令"),
        timeout_ms: z.number().int().positive().optional().describe(`命令超时时间（毫秒），默认 ${DEFAULT_TIMEOUT_MS}`),
        session: z.string().optional().describe("长连接会话 id（由 open_session 返回）。不填则使用短连接。"),
        force: z.boolean().optional().describe("传入 true 跳过安全策略检查。请谨慎使用。"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ server: serverName, command, timeout_ms, session, force }) => {
      let servers;
      try { servers = loadServers(); } catch (e) {
        return { content: [{ type: "text", text: `读取服务器配置失败：${(e as Error).message}` }], isError: true };
      }
      const cfg = servers.get(serverName);
      if (!cfg) {
        const names = [...servers.keys()].join(", ") || "（无）";
        return { content: [{ type: "text", text: `未找到名为 "${serverName}" 的服务器。可用：${names}` }], isError: true };
      }
      if (!force) {
        const security = loadSecurity();
        const blocked = validateCommand(command, security.blocked_patterns ?? []);
        if (blocked) return { content: [{ type: "text", text: `${blocked}\n使用 force=true 可跳过安全检查。` }], isError: true };
      }
      try {
        const r = await runCommand(cfg, command, timeout_ms ?? DEFAULT_TIMEOUT_MS, session);
        const parts = [
          `服务器: ${cfg.name} (${cfg.username}@${cfg.host}:${cfg.port ?? 22})`,
          `退出码: ${r.code ?? "null"}${r.signal ? `  信号: ${r.signal}` : ""}`,
        ];
        if (r.stdout) parts.push(`--- stdout ---\n${r.stdout.trimEnd()}`);
        if (r.stderr) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
        if (!r.stdout && !r.stderr) parts.push("（无输出）");
        return { content: [{ type: "text", text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `执行失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "open_session",
    {
      title: "打开到远程服务器的长连接会话",
      description:
        "与指定服务器建立一条持久的 SSH 连接并返回会话 id。该会话可被后续的 run_command " +
        "通过 session 参数复用，省去重复的 TCP 握手和 SSH 认证开销。" +
        "注意：即使使用长连接，每次 exec 仍在独立 channel 中执行，命令之间不保留工作目录或环境变量。",
      inputSchema: { server: z.string().describe("目标服务器的 name（见 list_servers）") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ server: serverName }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) {
          const names = [...servers.keys()].join(", ") || "（无）";
          return { content: [{ type: "text", text: `未找到名为 "${serverName}" 的服务器。可用：${names}` }], isError: true };
        }
        const s = await openSession(cfg, 20_000);
        return { content: [{ type: "text", text: `长连接会话已建立\n  id: ${s.id}\n  服务器: ${s.server}\n  创建时间: ${new Date(s.createdAt).toISOString()}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `打开长连接会话失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "close_session",
    {
      title: "关闭长连接会话",
      description: "关闭由 open_session 建立的长连接会话，释放底层 SSH 连接。",
      inputSchema: { session: z.string().describe("要关闭的会话 id（由 open_session 返回）") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ session }) => {
      const ok = closeSession(session);
      if (!ok) return { content: [{ type: "text", text: `会话 ${session} 不存在或已断开。` }], isError: true };
      return { content: [{ type: "text", text: `会话 ${session} 已关闭。` }] };
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "列出当前所有长连接会话",
      description: "列出当前已打开的所有长连接会话的 id、关联服务器和创建时间。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const all = listSessions();
      const text = all.length > 0
        ? all.map((s) => `  ${s.id} → ${s.server}（${new Date(s.createdAt).toISOString()}）`).join("\n")
        : "当前没有长连接会话。";
      return { content: [{ type: "text", text }] };
    },
  );

  function loadServersOrError() {
    try { return { servers: loadServers(), error: null as null | string }; }
    catch (e) { return { servers: null, error: (e as Error).message }; }
  }

  server.registerTool(
    "upload_file",
    {
      title: "上传文件到远程服务器",
      description:
        "通过 SFTP 把本机文件上传到指定服务器，适用于大文件（40GB+）。" +
        "这是后台任务：本工具立即返回一个传输 id，随后请用 transfer_status 轮询进度，不要阻塞等待。" +
        "支持断点续传——对同一对路径再次调用会自动从远程已有字节处继续；" +
        "若远程 remote_path 是已存在的目录，则自动在其下使用本地文件名。",
      inputSchema: {
        server: z.string().describe("目标服务器的 name（见 list_servers）"),
        local_path: z.string().describe("本机要上传的文件路径（绝对路径）"),
        remote_path: z.string().describe("远程目标路径（文件路径；若为已存在目录则自动追加文件名）"),
        overwrite: z.boolean().optional().describe("true 则忽略远程已有部分、从头覆盖；默认 false（自动断点续传）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ server: serverName, local_path, remote_path, overwrite }) => {
      const { servers, error } = loadServersOrError();
      if (!servers) return { content: [{ type: "text", text: `读取服务器配置失败：${error}` }], isError: true };
      const cfg = servers.get(serverName);
      if (!cfg) {
        const names = [...servers.keys()].join(", ") || "（无）";
        return { content: [{ type: "text", text: `未找到名为 "${serverName}" 的服务器。可用：${names}` }], isError: true };
      }
      try {
        const t = await startTransfer(cfg, "upload", local_path, remote_path, overwrite ?? false);
        const hint = t.state === "completed" ? "\n（目标已是完整文件，无需传输。）" : `\n传输已在后台开始，用 transfer_status({ id: "${t.id}" }) 查看进度。`;
        return { content: [{ type: "text", text: formatTransfer(t) + hint }] };
      } catch (e) {
        return { content: [{ type: "text", text: `发起上传失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "download_file",
    {
      title: "从远程服务器下载文件",
      description:
        "通过 SFTP 把指定服务器上的文件下载到本机，适用于大文件（40GB+）。" +
        "这是后台任务：本工具立即返回一个传输 id，随后请用 transfer_status 轮询进度，不要阻塞等待。" +
        "支持断点续传——对同一对路径再次调用会自动从本地已有字节处继续；" +
        "若本地 local_path 是已存在的目录，则自动在其下使用远程文件名。",
      inputSchema: {
        server: z.string().describe("源服务器的 name（见 list_servers）"),
        remote_path: z.string().describe("远程要下载的文件路径"),
        local_path: z.string().describe("本机目标路径（文件路径；若为已存在目录则自动追加文件名）"),
        overwrite: z.boolean().optional().describe("true 则忽略本地已有部分、从头覆盖；默认 false（自动断点续传）"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ server: serverName, remote_path, local_path, overwrite }) => {
      const { servers, error } = loadServersOrError();
      if (!servers) return { content: [{ type: "text", text: `读取服务器配置失败：${error}` }], isError: true };
      const cfg = servers.get(serverName);
      if (!cfg) {
        const names = [...servers.keys()].join(", ") || "（无）";
        return { content: [{ type: "text", text: `未找到名为 "${serverName}" 的服务器。可用：${names}` }], isError: true };
      }
      try {
        const t = await startTransfer(cfg, "download", local_path, remote_path, overwrite ?? false);
        const hint = t.state === "completed" ? "\n（目标已是完整文件，无需传输。）" : `\n传输已在后台开始，用 transfer_status({ id: "${t.id}" }) 查看进度。`;
        return { content: [{ type: "text", text: formatTransfer(t) + hint }] };
      } catch (e) {
        return { content: [{ type: "text", text: `发起下载失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "transfer_status",
    {
      title: "查看文件传输进度",
      description: "查询后台文件传输任务的进度（已传字节、百分比、速度、预计剩余时间、状态）。传入 id 查看单个任务；不传则列出本次会话的全部任务。",
      inputSchema: { id: z.string().optional().describe("传输任务 id；不填则列出全部任务") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      if (id) {
        const t = getTransfer(id);
        if (!t) return { content: [{ type: "text", text: `未找到传输任务：${id}` }], isError: true };
        return { content: [{ type: "text", text: formatTransfer(t) }] };
      }
      const all = listTransfers();
      const text = all.length > 0 ? all.map(formatTransfer).join("\n\n") : "当前没有传输任务。";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "cancel_transfer",
    {
      title: "取消文件传输",
      description: "取消一个正在进行的后台传输任务。已传输的部分文件会保留，之后可用同样的路径再次发起以断点续传。",
      inputSchema: { id: z.string().describe("要取消的传输任务 id") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      const t = cancelTransfer(id);
      if (!t) return { content: [{ type: "text", text: `未找到传输任务：${id}` }], isError: true };
      return { content: [{ type: "text", text: `已请求取消：\n${formatTransfer(t)}` }] };
    },
  );

  // ---- 端口转发 ----

  server.registerTool(
    "start_forward",
    {
      title: "启动 SSH 端口转发",
      description:
        "启动一个 SSH 端口转发隧道。本地转发（-L）：将本机端口流量经由 SSH 服务器转发到内网目标。" +
        "远程转发（-R）：将 SSH 服务器端口流量回传到本机指定地址。" +
        "返回转发 id，用 list_forwards 查看状态，close_forward 停止。",
      inputSchema: {
        server: z.string().describe("目标 SSH 服务器的 name"),
        type: z.enum(["local", "remote"]).describe("转发类型：local 本地转发，remote 远程转发"),
        local_host: z.string().default("127.0.0.1").describe("本机绑定地址，默认 127.0.0.1"),
        local_port: z.number().int().positive().describe("本机端口号"),
        remote_host: z.string().describe("远端目标地址（local 模式为内网主机，remote 模式为回传目标）"),
        remote_port: z.number().int().positive().describe("远端端口号"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ server: serverName, type, local_host, local_port, remote_host, remote_port }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const f = await startForward(cfg, type, local_host, local_port, remote_host, remote_port);
        const dir = type === "local"
          ? `${f.localHost}:${f.localPort} → ${f.remoteHost}:${f.remotePort}`
          : `${f.remoteHost}:${f.remotePort} → ${f.localHost}:${f.localPort}`;
        return { content: [{ type: "text", text: `转发已启动 [${f.id}] ${dir}\n类型: ${type}\n状态: ${f.state}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `启动转发失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "list_forwards",
    {
      title: "列出所有端口转发",
      description: "列出当前活跃的端口转发隧道。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const all = listForwards();
      if (all.length === 0) return { content: [{ type: "text", text: "当前没有端口转发。" }] };
      const lines = all.map((f) =>
        f.type === "local"
          ? `[${f.id}] ${f.server}  ${f.localHost}:${f.localPort} → ${f.remoteHost}:${f.remotePort}  (${f.state})`
          : `[${f.id}] ${f.server}  ${f.remoteHost}:${f.remotePort} → ${f.localHost}:${f.localPort}  (${f.state})`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "close_forward",
    {
      title: "停止端口转发",
      description: "停止一个端口转发隧道。",
      inputSchema: { id: z.string().describe("转发 id") },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const ok = closeForward(id);
      if (!ok) return { content: [{ type: "text", text: `转发 ${id} 不存在或已停止。` }], isError: true };
      return { content: [{ type: "text", text: `转发 ${id} 已停止。` }] };
    },
  );

  // ---- 批量执行 ----

  server.registerTool(
    "batch_run",
    {
      title: "在多台服务器上批量执行命令",
      description:
        "同时在多台服务器上执行同一条命令，并发执行、汇总结果。" +
        "传入 servers 数组指定目标服务器 name 列表。",
      inputSchema: {
        servers: z.array(z.string()).describe("目标服务器 name 列表"),
        command: z.string().describe("要执行的命令"),
        timeout_ms: z.number().int().positive().optional().describe(`命令超时（毫秒），默认 ${DEFAULT_TIMEOUT_MS}`),
        force: z.boolean().optional().describe("跳过安全策略检查"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ servers: serverNames, command, timeout_ms, force }) => {
      let servers;
      try { servers = loadServers(); } catch (e) {
        return { content: [{ type: "text", text: `读取服务器配置失败：${(e as Error).message}` }], isError: true };
      }
      const missing = serverNames.filter((n) => !servers.has(n));
      if (missing.length) return { content: [{ type: "text", text: `未找到服务器：${missing.join(", ")}` }], isError: true };
      if (!force) {
        const security = loadSecurity();
        const blocked = validateCommand(command, security.blocked_patterns ?? []);
        if (blocked) return { content: [{ type: "text", text: `${blocked}\n使用 force=true 可跳过安全检查。` }], isError: true };
      }
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const results = await Promise.allSettled(
        serverNames.map((name) =>
          runCommand(servers.get(name)!, command, timeout).then((r) => ({ server: name, result: r })),
        ),
      );
      const lines: string[] = [];
      for (const r of results) {
        if (r.status === "rejected") {
          lines.push(`--- ${(r.reason as any)?.server ?? "?"} FAILED ---\n${(r.reason as Error).message}`);
        } else {
          const { server: sName, result } = r.value;
          lines.push(`--- ${sName} (exit ${result.code}) ---`);
          if (result.stdout) lines.push(result.stdout.trimEnd());
          if (result.stderr) lines.push(`[stderr]\n${result.stderr.trimEnd()}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") || "（无输出）" }] };
    },
  );

  // ---- SFTP 文件操作 ----

  server.registerTool(
    "list_directory",
    {
      title: "列出远程目录内容",
      description:
        "通过 SFTP 列出远程服务器上指定目录的文件和子目录。" +
        "返回文件名、类型、大小、权限、修改时间等信息。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        path: z.string().describe("远程目录路径"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: serverName, path }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const entries = await listDirectory(cfg, path);
        const lines = entries.map(formatLsLong);
        return { content: [{ type: "text", text: `${path}:\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `列出目录失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "stat_file",
    {
      title: "查看远程文件信息",
      description: "通过 SFTP stat 查看远程文件的类型、大小、权限、修改时间。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        path: z.string().describe("远程文件路径"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: serverName, path }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const s = await statPath(cfg, path);
        return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `stat 失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "remove_file",
    {
      title: "删除远程文件或目录",
      description:
        "通过 SFTP 删除远程服务器上的文件或目录。" +
        "删除目录时需传入 recursive=true，将递归删除目录下所有内容。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        path: z.string().describe("远程文件或目录路径"),
        recursive: z.boolean().optional().describe("递归删除目录；默认 false"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ server: serverName, path, recursive }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        await removePath(cfg, path, recursive ?? false);
        return { content: [{ type: "text", text: `已删除：${path}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `删除失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "make_directory",
    {
      title: "创建远程目录",
      description:
        "通过 SFTP 在远程服务器上创建目录。" +
        "传入 parents=true 可自动创建父目录（类似 mkdir -p）。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        path: z.string().describe("远程目录路径"),
        parents: z.boolean().optional().describe("自动创建父目录；默认 false"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ server: serverName, path, parents }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        await makeDir(cfg, path, parents ?? false);
        return { content: [{ type: "text", text: `已创建目录：${path}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `创建目录失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------
interface ParsedArgs {
  subcommand: string;
  options: Map<string, string | boolean>;
  positional: string[];
}

function parseArgs(raw: string[]): ParsedArgs {
  const options = new Map<string, string | boolean>();
  let subcommand = "";
  let i = 0;

  while (i < raw.length) {
    const a = raw[i];
    if (a === "--") { i++; break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        options.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        if (i + 1 < raw.length && !raw[i + 1].startsWith("-")) {
          options.set(key, raw[++i]);
        } else {
          options.set(key, true);
        }
      }
    } else if (a.startsWith("-") && a.length === 2 && a[1] !== "-") {
      // short flag: -c → value
      const key = a.slice(1);
      if (i + 1 < raw.length && !raw[i + 1].startsWith("-")) {
        options.set(key, raw[++i]);
      } else {
        options.set(key, true);
      }
    } else if (!subcommand) {
      subcommand = a;
    } else {
      break;
    }
    i++;
  }

  return { subcommand, options, positional: raw.slice(i) };
}

function optStr(opts: Map<string, string | boolean>, key: string): string | undefined {
  const v = opts.get(key);
  return typeof v === "string" ? v : undefined;
}

function optNum(opts: Map<string, string | boolean>, key: string): number | undefined {
  const v = opts.get(key);
  if (typeof v === "string") { const n = Number(v); return isNaN(n) ? undefined : n; }
  return undefined;
}

function optBool(opts: Map<string, string | boolean>, key: string): boolean {
  const v = opts.get(key);
  return v === true || v === "true" || v === "1";
}

function die(msg: string): never {
  process.stderr.write(`ssh-mcp: ${msg}\n`);
  process.exit(1);
}

function showHelp(): void {
  process.stdout.write(`ssh-mcp — SSH/SFTP 远程服务器命令行工具  v1.4.0

用法:  ssh-mcp <子命令> [选项]

子命令:
  list-servers              列出所有已配置的服务器
  run-command               在远程服务器上执行命令
  batch                     在多台服务器上批量执行同一命令
  open-session              打开到远程服务器的长连接会话
  close-session             关闭长连接会话
  list-sessions             列出当前所有长连接会话
  upload                    上传文件到远程服务器（支持断点续传）
  download                  从远程服务器下载文件（支持断点续传）
  transfer-status           查看文件传输进度
  cancel-transfer           取消文件传输
  forward                   启动 SSH 端口转发（本地/远程）
  list-forwards             列出当前所有端口转发
  close-forward             停止端口转发
  ls                        列出远程目录内容
  stat                      查看远程文件信息
  rm                        删除远程文件或目录
  mkdir                     创建远程目录

全局选项:
  --mcp                     以 MCP stdio 服务模式运行（供 AI 客户端调用）
  --help, -h                显示此帮助信息

配置:
  服务器配置文件路径: ${configPath()}
  也可通过环境变量 SSH_MCP_CONFIG 指定其他路径。

  示例 servers.json:
  {
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

各子命令详细用法请运行:  ssh-mcp <子命令> --help
`);
}

// ---------------------------------------------------------------------------
// CLI handlers
// ---------------------------------------------------------------------------

async function cmdListServers(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp list-servers [--json]

选项:
  --json   以 JSON 格式输出

示例:
  ssh-mcp list-servers
  ssh-mcp list-servers --json
`);
    return;
  }
  try {
    const servers = loadServers();
    const list = [...servers.values()].map((s) => ({
      name: s.name,
      description: s.description ?? "",
      host: s.host,
      port: s.port ?? 22,
      username: s.username,
    }));
    if (optBool(opts, "json")) {
      process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    } else if (list.length === 0) {
      process.stdout.write(`没有已配置的服务器。请编辑配置文件：${configPath()}\n`);
    } else {
      for (const s of list) {
        process.stdout.write(`${s.name.padEnd(16)} ${s.username}@${s.host}:${s.port}  ${s.description}\n`);
      }
    }
  } catch (e) {
    die(`读取服务器配置失败：${(e as Error).message}`);
  }
}

async function cmdRunCommand(opts: Map<string, string | boolean>, positional: string[]): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp run-command --server <name> [选项] <命令...>

选项:
  --server, -s <name>   目标服务器 name（必需）
  --timeout <ms>        命令超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）
  --session <id>        长连接会话 id（复用已有连接）
  --force               跳过安全策略检查
  --command, -c <cmd>   要执行的命令（也可直接放在选项之后）

示例:
  ssh-mcp run-command --server prod-web --command "uptime"
  ssh-mcp run-command -s prod-web "df -h /"
  ssh-mcp run-command -s prod-web --session s1 "tail -50 /var/log/nginx/access.log"
`);
    return;
  }

  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  if (!serverName) die("缺少 --server。用法: ssh-mcp run-command --server <name> <命令>");

  let command = optStr(opts, "command") ?? optStr(opts, "c");
  if (!command) {
    command = positional.join(" ");
  }
  if (!command || command.trim() === "") die("缺少命令。用法: ssh-mcp run-command --server <name> <命令>");

  const timeout = optNum(opts, "timeout") ?? DEFAULT_TIMEOUT_MS;
  const session = optStr(opts, "session");
  const force = optBool(opts, "force");

  let servers;
  try { servers = loadServers(); } catch (e) { die(`读取服务器配置失败：${(e as Error).message}`); }

  const cfg = servers.get(serverName);
  if (!cfg) {
    const names = [...servers.keys()].join(", ") || "（无）";
    die(`未找到名为 "${serverName}" 的服务器。可用：${names}`);
  }

  if (!force) {
    const security = loadSecurity();
    const blocked = validateCommand(command, security.blocked_patterns ?? []);
    if (blocked) die(blocked + "\n使用 --force 可跳过安全检查。");
  }

  try {
    const r = await runCommand(cfg, command, timeout, session);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.code ?? 1);
  } catch (e) {
    die(`执行失败：${(e as Error).message}`);
  }
}

async function cmdOpenSession(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp open-session --server <name> [--timeout <ms>]

选项:
  --server, -s <name>   目标服务器 name（必需）
  --timeout <ms>        连接超时毫秒数（默认 20000）

示例:
  ssh-mcp open-session -s prod-web
  SESSION=s1
  ssh-mcp run-command -s prod-web --session $SESSION "hostname"
  ssh-mcp close-session --session $SESSION
`);
    return;
  }

  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  if (!serverName) die("缺少 --server。用法: ssh-mcp open-session --server <name>");

  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) {
      const names = [...servers.keys()].join(", ") || "（无）";
      die(`未找到名为 "${serverName}" 的服务器。可用：${names}`);
    }
    const s = await openSession(cfg, optNum(opts, "timeout") ?? 20_000);
    process.stdout.write(`${s.id}\n`);
  } catch (e) {
    die(`打开长连接会话失败：${(e as Error).message}`);
  }
}

async function cmdCloseSession(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp close-session --session <id>

选项:
  --session, -s <id>   要关闭的会话 id（必需）

示例:
  ssh-mcp close-session -s s1
`);
    return;
  }

  const session = optStr(opts, "session") ?? optStr(opts, "s");
  if (!session) die("缺少 --session。用法: ssh-mcp close-session --session <id>");

  const ok = closeSession(session);
  if (!ok) die(`会话 ${session} 不存在或已断开。`);
  process.stdout.write(`会话 ${session} 已关闭。\n`);
}

async function cmdListSessions(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp list-sessions

列出当前所有活跃的长连接会话（id、对应服务器、创建时间）。

示例:
  ssh-mcp list-sessions
`);
    return;
  }
  const all = listSessions();
  if (all.length === 0) {
    process.stdout.write("当前没有长连接会话。\n");
    return;
  }
  for (const s of all) {
    process.stdout.write(`${s.id.padEnd(8)} → ${s.server.padEnd(20)} ${new Date(s.createdAt).toISOString()}\n`);
  }
}

async function cmdUpload(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp upload --server <name> --local <path> --remote <path> [--overwrite]

选项:
  --server, -s <name>   目标服务器 name（必需）
  --local, -l <path>    本地文件路径（必需）
  --remote, -r <path>   远程目标路径（必需）
  --overwrite           从头覆盖远程文件（默认断点续传）

示例:
  ssh-mcp upload -s prod-web -l ./dist.tar.gz -r /tmp/dist.tar.gz
  ssh-mcp upload -s prod-web -l ./app.log -r /var/log/ --overwrite
`);
    return;
  }

  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const localPath = optStr(opts, "local") ?? optStr(opts, "l");
  const remotePath = optStr(opts, "remote") ?? optStr(opts, "r");
  if (!serverName) die("缺少 --server");
  if (!localPath) die("缺少 --local");
  if (!remotePath) die("缺少 --remote");

  const { servers, error } = loadServersOrDie();
  const cfg = servers.get(serverName);
  if (!cfg) die(`未找到名为 "${serverName}" 的服务器。可用：${[...servers.keys()].join(", ") || "（无）"}`);

  try {
    const t = await startTransfer(cfg, "upload", localPath, remotePath, optBool(opts, "overwrite"));
    process.stdout.write(formatTransfer(t) + "\n");
    if (t.state === "completed") process.stdout.write("目标已是完整文件，无需传输。\n");
    else process.stdout.write(`传输已在后台开始，用 ssh-mcp transfer-status --id ${t.id} 查看进度。\n`);
  } catch (e) {
    die(`发起上传失败：${(e as Error).message}`);
  }
}

async function cmdDownload(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp download --server <name> --remote <path> --local <path> [--overwrite]

选项:
  --server, -s <name>   源服务器 name（必需）
  --remote, -r <path>   远程文件路径（必需）
  --local, -l <path>    本地目标路径（必需）
  --overwrite           从头覆盖本地文件（默认断点续传）

示例:
  ssh-mcp download -s prod-web -r /var/log/app.log -l ./logs/app.log
  ssh-mcp download -s prod-web -r /tmp/data.bin -l ./downloads/ --overwrite
`);
    return;
  }

  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const remotePath = optStr(opts, "remote") ?? optStr(opts, "r");
  const localPath = optStr(opts, "local") ?? optStr(opts, "l");
  if (!serverName) die("缺少 --server");
  if (!remotePath) die("缺少 --remote");
  if (!localPath) die("缺少 --local");

  const { servers, error } = loadServersOrDie();
  const cfg = servers.get(serverName);
  if (!cfg) die(`未找到名为 "${serverName}" 的服务器。可用：${[...servers.keys()].join(", ") || "（无）"}`);

  try {
    const t = await startTransfer(cfg, "download", localPath, remotePath, optBool(opts, "overwrite"));
    process.stdout.write(formatTransfer(t) + "\n");
    if (t.state === "completed") process.stdout.write("目标已是完整文件，无需传输。\n");
    else process.stdout.write(`传输已在后台开始，用 ssh-mcp transfer-status --id ${t.id} 查看进度。\n`);
  } catch (e) {
    die(`发起下载失败：${(e as Error).message}`);
  }
}

async function cmdTransferStatus(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp transfer-status [--id <id>]

选项:
  --id, -i <id>   传输任务 id；不填则列出全部任务

示例:
  ssh-mcp transfer-status
  ssh-mcp transfer-status -i t1
`);
    return;
  }

  const id = optStr(opts, "id") ?? optStr(opts, "i");
  if (id) {
    const t = getTransfer(id);
    if (!t) die(`未找到传输任务：${id}`);
    process.stdout.write(formatTransfer(t) + "\n");
  } else {
    const all = listTransfers();
    if (all.length === 0) process.stdout.write("当前没有传输任务。\n");
    else process.stdout.write(all.map(formatTransfer).join("\n\n") + "\n");
  }
}

async function cmdCancelTransfer(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp cancel-transfer --id <id>

选项:
  --id, -i <id>   要取消的传输任务 id（必需）

示例:
  ssh-mcp cancel-transfer -i t1
`);
    return;
  }

  const id = optStr(opts, "id") ?? optStr(opts, "i");
  if (!id) die("缺少 --id。用法: ssh-mcp cancel-transfer --id <id>");

  const t = cancelTransfer(id);
  if (!t) die(`未找到传输任务：${id}`);
  process.stdout.write(`已请求取消：\n${formatTransfer(t)}\n`);
}

// ---- 端口转发 CLI ----

async function cmdForward(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp forward --server <name> -L <本地端口>:<远端主机>:<远端端口>
       ssh-mcp forward --server <name> -R <远端端口>:<本地主机>:<本地端口>

选项:
  --server, -s <name>   目标 SSH 服务器 name（必需）
  -L <lport>:<rhost>:<rport>   本地端口转发
  -R <rport>:<lhost>:<lport>   远程端口转发

示例:
  # 本地转发：本机 8080 → 经 prod-web → 内网 192.168.1.5:80
  ssh-mcp forward -s prod-web -L 8080:192.168.1.5:80

  # 远程转发：prod-web 的 9000 → 回传到本机 localhost:3000
  ssh-mcp forward -s prod-web -R 9000:127.0.0.1:3000
`);
    return;
  }

  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  if (!serverName) die("缺少 --server");

  const lFwd = optStr(opts, "L");
  const rFwd = optStr(opts, "R");
  if (!lFwd && !rFwd) die("缺少 -L 或 -R。用法: ssh-mcp forward -s <name> -L lport:rhost:rport");
  if (lFwd && rFwd) die("不能同时指定 -L 和 -R");

  const raw = (lFwd ?? rFwd)!;
  const parts = raw.split(":");
  if (parts.length !== 3) die("转发格式错误：应为 -L lport:rhost:rport 或 -R rport:lhost:lport");

  let type: "local" | "remote";
  let localHost: string, localPort: number, remoteHost: string, remotePort: number;
  if (lFwd) {
    type = "local";
    localPort = parseInt(parts[0], 10);
    remoteHost = parts[1];
    remotePort = parseInt(parts[2], 10);
    localHost = "127.0.0.1";
  } else {
    type = "remote";
    remotePort = parseInt(parts[0], 10);
    localHost = parts[1];
    localPort = parseInt(parts[2], 10);
    remoteHost = "0.0.0.0";
  }
  if (isNaN(localPort) || isNaN(remotePort)) die("端口号必须是数字");

  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"。可用：${[...servers.keys()].join(", ") || "（无）"}`);
    const f = await startForward(cfg, type, localHost, localPort, remoteHost, remotePort);
    const dir = type === "local"
      ? `${f.localHost}:${f.localPort} → ${f.remoteHost}:${f.remotePort}`
      : `${f.remoteHost}:${f.remotePort} → ${f.localHost}:${f.localPort}`;
    process.stdout.write(`转发已启动 [${f.id}] ${dir}\n`);
  } catch (e) {
    die(`启动转发失败：${(e as Error).message}`);
  }
}

async function cmdListForwards(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp list-forwards

列出当前所有活跃的端口转发隧道。

示例:
  ssh-mcp list-forwards
`);
    return;
  }
  const all = listForwards();
  if (all.length === 0) { process.stdout.write("当前没有端口转发。\n"); return; }
  for (const f of all) {
    const dir = f.type === "local"
      ? `${f.localHost}:${f.localPort} → ${f.remoteHost}:${f.remotePort}`
      : `${f.remoteHost}:${f.remotePort} → ${f.localHost}:${f.localPort}`;
    process.stdout.write(`[${f.id}] ${f.server.padEnd(16)} ${dir.padEnd(32)} ${f.state}\n`);
  }
}

async function cmdCloseForward(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp close-forward --id <id>

选项:
  --id, -i <id>   要停止的转发 id（必需）

示例:
  ssh-mcp close-forward -i f1
`);
    return;
  }
  const id = optStr(opts, "id") ?? optStr(opts, "i");
  if (!id) die("缺少 --id");
  if (!closeForward(id)) die(`转发 ${id} 不存在或已停止。`);
  process.stdout.write(`转发 ${id} 已停止。\n`);
}

// ---- 批量执行 CLI ----

async function cmdBatch(opts: Map<string, string | boolean>, positional: string[]): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp batch --servers <s1,s2,...> [选项] <命令...>

选项:
  --servers <names>     目标服务器 name 列表，逗号分隔（必需）
  --timeout <ms>        命令超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）
  --force               跳过安全策略检查
  --command, -c <cmd>   要执行的命令（也可直接放在选项之后）

示例:
  ssh-mcp batch --servers prod-web,prod-api -c "df -h /"
  ssh-mcp batch --servers web1,web2,web3 "systemctl status nginx"
`);
    return;
  }

  const serversArg = optStr(opts, "servers");
  if (!serversArg) die("缺少 --servers。用法: ssh-mcp batch --servers s1,s2,... <命令>");

  let command = optStr(opts, "command") ?? optStr(opts, "c");
  if (!command) command = positional.join(" ");
  if (!command || command.trim() === "") die("缺少命令");

  const serverNames = serversArg.split(",").map((s) => s.trim()).filter(Boolean);
  if (serverNames.length === 0) die("--servers 格式错误");

  const timeout = optNum(opts, "timeout") ?? DEFAULT_TIMEOUT_MS;
  const force = optBool(opts, "force");

  let servers;
  try { servers = loadServers(); } catch (e) { die(`读取配置失败：${(e as Error).message}`); }
  const missing = serverNames.filter((n) => !servers.has(n));
  if (missing.length) die(`未找到服务器：${missing.join(", ")}`);

  if (!force) {
    const security = loadSecurity();
    const blocked = validateCommand(command, security.blocked_patterns ?? []);
    if (blocked) die(blocked + "\n使用 --force 可跳过安全检查。");
  }

  const results = await Promise.allSettled(
    serverNames.map((name) =>
      runCommand(servers.get(name)!, command, timeout).then((r) => ({ server: name, result: r })),
    ),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      process.stderr.write(`=== ${(r.reason as any)?.server ?? "?"} FAILED ===\n${(r.reason as Error).message}\n`);
    } else {
      const { server: sName, result } = r.value;
      process.stdout.write(`=== ${sName} (exit ${result.code}) ===\n`);
      if (result.stdout) process.stdout.write(result.stdout.trimEnd() + "\n");
      if (result.stderr) process.stderr.write(`[stderr]\n${result.stderr.trimEnd()}\n`);
    }
  }
}

// ---- SFTP 文件操作 CLI ----

async function cmdLs(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp ls --server <name> --path <path> [--long]

选项:
  --server, -s <name>   目标服务器 name（必需）
  --path, -p <path>     远程目录路径（必需）
  --long, -l            详细列表模式（权限/大小/时间）

示例:
  ssh-mcp ls -s prod-web -p /var/log
  ssh-mcp ls -s prod-web -p /tmp --long
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const path = optStr(opts, "path") ?? optStr(opts, "p");
  if (!serverName) die("缺少 --server");
  if (!path) die("缺少 --path");

  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    const entries = await listDirectory(cfg, path);
    process.stdout.write(`${path}:\n`);
    const long = optBool(opts, "long") || optBool(opts, "l");
    for (const e of entries) {
      process.stdout.write((long ? formatLsLong(e) : formatLsShort(e)) + "\n");
    }
    process.stdout.write(`\n${entries.length} 条\n`);
  } catch (e) {
    die(`列出目录失败：${(e as Error).message}`);
  }
}

async function cmdStat(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp stat --server <name> --path <path>

选项:
  --server, -s <name>   目标服务器 name（必需）
  --path, -p <path>     远程文件路径（必需）

示例:
  ssh-mcp stat -s prod-web -p /etc/nginx/nginx.conf
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const path = optStr(opts, "path") ?? optStr(opts, "p");
  if (!serverName) die("缺少 --server");
  if (!path) die("缺少 --path");

  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    const s = await statPath(cfg, path);
    process.stdout.write(`类型: ${s.type}\n大小: ${s.size}\n权限: ${s.mode.toString(8)}\nuid: ${s.uid}\ngid: ${s.gid}\n修改: ${new Date(s.mtime * 1000).toISOString()}\n`);
  } catch (e) {
    die(`stat 失败：${(e as Error).message}`);
  }
}

async function cmdRm(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp rm --server <name> --path <path> [--recursive]

选项:
  --server, -s <name>   目标服务器 name（必需）
  --path, -p <path>     要删除的远程文件或目录（必需）
  --recursive, -r       递归删除目录

示例:
  ssh-mcp rm -s prod-web -p /tmp/old.log
  ssh-mcp rm -s prod-web -p /tmp/backup --recursive
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const path = optStr(opts, "path") ?? optStr(opts, "p");
  if (!serverName) die("缺少 --server");
  if (!path) die("缺少 --path");

  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    await removePath(cfg, path, optBool(opts, "recursive") || optBool(opts, "r"));
    process.stdout.write(`已删除：${path}\n`);
  } catch (e) {
    die(`删除失败：${(e as Error).message}`);
  }
}

async function cmdMkdir(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp mkdir --server <name> --path <path> [--parents]

选项:
  --server, -s <name>   目标服务器 name（必需）
  --path, -p <path>     要创建的远程目录路径（必需）
  --parents             自动创建父目录（类似 mkdir -p）

示例:
  ssh-mcp mkdir -s prod-web -p /opt/app/logs --parents
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const path = optStr(opts, "path") ?? optStr(opts, "p");
  if (!serverName) die("缺少 --server");
  if (!path) die("缺少 --path");

  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    await makeDir(cfg, path, optBool(opts, "parents"));
    process.stdout.write(`已创建目录：${path}\n`);
  } catch (e) {
    die(`创建目录失败：${(e as Error).message}`);
  }
}

function loadServersOrDie(): { servers: Map<string, import("./config.js").ServerConfig>; error: null } {
  try {
    return { servers: loadServers(), error: null };
  } catch (e) {
    die(`读取服务器配置失败：${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
async function main() {
  const { subcommand, options, positional } = parseArgs(process.argv.slice(2));

  // --mcp flag → run as MCP stdio server
  if (subcommand === "--mcp" || options.has("mcp")) {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`ssh-mcp MCP 服务已启动，配置文件：${configPath()}`);
    return;
  }

  // Route to subcommand first (subcommand may have its own --help)
  switch (subcommand) {
    case "help":
    case undefined:
    case "": {
      showHelp();
      process.exit(0);
    }
    case "list-servers":       return cmdListServers(options);
    case "run-command":        return cmdRunCommand(options, positional);
    case "batch":              return cmdBatch(options, positional);
    case "open-session":       return cmdOpenSession(options);
    case "close-session":      return cmdCloseSession(options);
    case "list-sessions":      return cmdListSessions(options);
    case "upload":             return cmdUpload(options);
    case "download":           return cmdDownload(options);
    case "transfer-status":    return cmdTransferStatus(options);
    case "cancel-transfer":    return cmdCancelTransfer(options);
    case "forward":            return cmdForward(options);
    case "list-forwards":      return cmdListForwards(options);
    case "close-forward":      return cmdCloseForward(options);
    case "ls":                 return cmdLs(options);
    case "stat":               return cmdStat(options);
    case "rm":                 return cmdRm(options);
    case "mkdir":              return cmdMkdir(options);
    default:
      die(`未知子命令: ${subcommand}\n运行 ssh-mcp --help 查看可用命令。`);
  }
}

main().catch((e) => {
  process.stderr.write(`ssh-mcp 启动失败：${e}\n`);
  process.exit(1);
});
