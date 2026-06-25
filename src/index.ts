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
import {
  getHealth,
  getCertInfo,
  copyBetween,
  diffServers,
  execScript,
  snapshot,
  startTailFollow,
  stopTailFollow,
  getTailFollow,
  listTailFollows,
  httpRequest,
  getRemoteEnv,
  startWatch,
  stopWatch,
  getWatch,
  listWatches,
  type HealthReport,
  type CertInfo,
  type CopyResult,
  type DiffResult,
  type ExecScriptResult,
  type SnapshotResult,
  type TailFollow,
  type HttpResponse,
  type RemoteEnv,
  type WatchHandle,
  type WatchIteration,
} from "./ops.js";

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
  const server = new McpServer({ name: "ssh-mcp", version: "1.5.0" });

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

  // ---- 健康检查 ----

  server.registerTool(
    "health_check",
    {
      title: "远程服务器健康检查",
      description:
        "一键收集远程服务器健康报告：主机名、操作系统、运行时长、负载、内存、磁盘、CPU 核心数。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: serverName }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const h = await getHealth(cfg);
        const lines = [
          `=== ${h.server} (${h.hostname}) ===`,
          `操作系统: ${h.os}`,
          `运行时长: ${h.uptime}`,
          `平均负载: ${h.load}`,
          `CPU 核心: ${h.cpuCores}`,
          `内存:\n${h.memory}`,
          `磁盘:\n${h.disk}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `健康检查失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ---- SSL 证书 ----

  server.registerTool(
    "cert_info",
    {
      title: "查看 SSL/TLS 证书信息",
      description:
        "通过远程服务器上的 openssl 拉取目标主机的 SSL 证书，解析主题、签发者、SAN、有效期、指纹和剩余天数。",
      inputSchema: {
        server: z.string().describe("执行 openssl 的 SSH 服务器 name"),
        host: z.string().describe("要检查证书的目标主机名或 IP"),
        port: z.number().int().positive().optional().describe("目标端口，默认 443"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: serverName, host, port }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const c = await getCertInfo(cfg, host, port ?? 443);
        const lines = [
          `主题:   ${c.subject}`,
          `签发者: ${c.issuer}`,
          `有效期: ${c.notBefore} → ${c.notAfter}`,
          `剩余天数: ${c.remainingDays}`,
          `指纹: ${c.fingerprint}`,
          `SAN: ${c.sans.length ? c.sans.join(", ") : "（无）"}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `证书检查失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ---- 服务器间直传 ----

  server.registerTool(
    "copy_between",
    {
      title: "服务器间直接传输文件",
      description:
        "在两台远程服务器之间直接 SFTP 传输文件，数据不经过本机中转。" +
        "从 source_server 的 source_path 读取，写入 dest_server 的 dest_path。",
      inputSchema: {
        source_server: z.string().describe("源服务器 name"),
        dest_server: z.string().describe("目标服务器 name"),
        source_path: z.string().describe("源文件路径"),
        dest_path: z.string().describe("目标文件路径"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ source_server, dest_server, source_path, dest_path }) => {
      try {
        const servers = loadServers();
        const src = servers.get(source_server);
        const dest = servers.get(dest_server);
        if (!src) return { content: [{ type: "text", text: `未找到源服务器 "${source_server}"` }], isError: true };
        if (!dest) return { content: [{ type: "text", text: `未找到目标服务器 "${dest_server}"` }], isError: true };
        const r = await copyBetween(src, dest, source_path, dest_path);
        return { content: [{ type: "text", text: `已复制 ${humanBytes(r.size)}：${r.sourceServer}:${r.sourcePath} → ${r.destServer}:${r.destPath}（耗时 ${(r.elapsedMs / 1000).toFixed(1)}s）` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `服务器间复制失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ---- 服务器文件对比 ----

  server.registerTool(
    "diff_servers",
    {
      title: "对比两台服务器上同一文件的差异",
      description:
        "对比两台服务器上同一路径的文件内容，返回 unified diff 格式的差异。" +
        "用于排查配置漂移、确认多台服务器配置一致性。",
      inputSchema: {
        server_a: z.string().describe("第一台服务器 name"),
        server_b: z.string().describe("第二台服务器 name"),
        path: z.string().describe("要对比的文件路径"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server_a, server_b, path }) => {
      try {
        const servers = loadServers();
        const a = servers.get(server_a);
        const b = servers.get(server_b);
        if (!a) return { content: [{ type: "text", text: `未找到服务器 "${server_a}"` }], isError: true };
        if (!b) return { content: [{ type: "text", text: `未找到服务器 "${server_b}"` }], isError: true };
        const d = await diffServers(a, b, path);
        if (d.identical) return { content: [{ type: "text", text: `${server_a} 和 ${server_b} 上 ${path} 内容一致。` }] };
        return { content: [{ type: "text", text: `--- ${server_a}:${path}\n+++ ${server_b}:${path}\n${d.diff}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `对比失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ---- 脚本执行 ----

  server.registerTool(
    "exec_script",
    {
      title: "上传脚本到远程执行并清理",
      description:
        "将本机脚本文件上传到远程服务器，设置执行权限，运行后自动删除临时文件。" +
        "一站式操作，无需手动清理。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        local_script: z.string().describe("本机脚本文件的绝对路径"),
        remote_path: z.string().optional().describe("远程暂存路径，默认 /tmp/ssh-mcp-script.sh"),
        timeout_ms: z.number().int().positive().optional().describe("执行超时毫秒数，默认 120000"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ server: serverName, local_script, remote_path, timeout_ms }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const r = await execScript(cfg, local_script, remote_path ?? "/tmp/ssh-mcp-script.sh", timeout_ms ?? 120_000);
        return { content: [{ type: "text", text: `退出码: ${r.exitCode}\n${r.stdout}\n${r.stderr ? "--- stderr ---\n" + r.stderr : ""}`.trim() }] };
      } catch (e) {
        return { content: [{ type: "text", text: `脚本执行失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ---- 快照 ----

  server.registerTool(
    "snapshot",
    {
      title: "远程目录快照打包下载",
      description:
        "将远程服务器上的目录通过 tar.gz 打包后流式下载到本机。" +
        "支持 --exclude 排除模式。适用于备份、迁移场景。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        remote_dir: z.string().describe("远程目录路径"),
        local_file: z.string().describe("本机输出文件路径（.tar.gz）"),
        excludes: z.array(z.string()).optional().describe("排除模式列表，如 ['*.log', 'node_modules']"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ server: serverName, remote_dir, local_file, excludes }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const r = await snapshot(cfg, remote_dir, local_file, excludes ?? []);
        return { content: [{ type: "text", text: `快照完成\n  服务器: ${r.server}:${r.remotePath}\n  本地: ${r.localFile}\n  大小: ${humanBytes(r.fileSize)}\n  耗时: ${(r.elapsedMs / 1000).toFixed(1)}s` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `快照失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ---- tail-f ----

  server.registerTool(
    "start_tail",
    {
      title: "持续追踪远程文件（tail -f）",
      description:
        "以 SFTP 轮询方式持续追踪远程文件的增长内容。返回 tail id，" +
        "用 get_tail 抓取已收集的内容，stop_tail 停止追踪。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        path: z.string().describe("要追踪的远程文件路径"),
        interval_ms: z.number().int().positive().optional().describe("轮询间隔毫秒数，默认 2000"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: serverName, path, interval_ms }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const chunks: string[] = [];
        const t = await startTailFollow(cfg, path, interval_ms ?? 2000, (_id, chunk) => chunks.push(chunk));
        return { content: [{ type: "text", text: `tail 已启动 [${t.id}]\n  服务器: ${t.server}\n  文件: ${t.path}\n  用 get_tail({ id: "${t.id}" }) 获取内容，stop_tail({ id: "${t.id}" }) 停止。` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `启动 tail 失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_tail",
    {
      title: "查看 tail 追踪状态",
      description: "查看指定 tail 追踪任务的状态、已收集字节数等信息。",
      inputSchema: { id: z.string().optional().describe("tail id；不填则列出所有") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      if (id) {
        const t = getTailFollow(id);
        if (!t) return { content: [{ type: "text", text: `未找到 tail: ${id}` }], isError: true };
        return { content: [{ type: "text", text: `[${t.id}] ${t.server}:${t.path} — ${t.state}（${humanBytes(t.seenBytes)} 已跟踪）` }] };
      }
      const all = listTailFollows();
      const text = all.length ? all.map((t) => `[${t.id}] ${t.server}:${t.path} — ${t.state}（${humanBytes(t.seenBytes)}）`).join("\n") : "当前没有 tail 任务。";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "stop_tail",
    {
      title: "停止 tail 追踪",
      description: "停止一个 tail 追踪任务。",
      inputSchema: { id: z.string().describe("tail id") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      if (!stopTailFollow(id)) return { content: [{ type: "text", text: `未找到 tail: ${id}` }], isError: true };
      return { content: [{ type: "text", text: `tail ${id} 已停止。` }] };
    },
  );

  // ---- watch ----

  server.registerTool(
    "start_watch",
    {
      title: "定时重复执行命令并高亮差异",
      description:
        "在远程服务器上按指定间隔重复执行命令。每次执行结果与上次对比，" +
        "自动高亮变化行。返回 watch id，用 stop_watch 停止。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        command: z.string().describe("要重复执行的命令"),
        interval_ms: z.number().int().positive().describe("执行间隔毫秒数"),
        timeout_ms: z.number().int().positive().optional().describe("每次命令执行超时毫秒数，默认 10000"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: serverName, command, interval_ms, timeout_ms }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const iterations: WatchIteration[] = [];
        const wh = startWatch(cfg, command, interval_ms, (_id, iter) => iterations.push(iter), timeout_ms ?? 10_000);
        return { content: [{ type: "text", text: `watch 已启动 [${wh.id}]\n  服务器: ${wh.server}\n  命令: ${wh.command}\n  间隔: ${wh.intervalMs}ms\n  用 get_watch({ id: "${wh.id}" }) 查看或 stop_watch({ id: "${wh.id}" }) 停止。` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `启动 watch 失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_watch",
    {
      title: "查看 watch 状态",
      description: "查看指定 watch 任务的状态。",
      inputSchema: { id: z.string().optional().describe("watch id；不填则列出所有") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      if (id) {
        const w = getWatch(id);
        if (!w) return { content: [{ type: "text", text: `未找到 watch: ${id}` }], isError: true };
        return { content: [{ type: "text", text: `[${w.id}] ${w.server}: ${w.command}（每 ${w.intervalMs}ms）— ${w.state}` }] };
      }
      const all = listWatches();
      const text = all.length ? all.map((w) => `[${w.id}] ${w.server}: ${w.command}（每 ${w.intervalMs}ms）— ${w.state}`).join("\n") : "当前没有 watch 任务。";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "stop_watch",
    {
      title: "停止 watch",
      description: "停止一个定时 watch 任务。",
      inputSchema: { id: z.string().describe("watch id") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      if (!stopWatch(id)) return { content: [{ type: "text", text: `未找到 watch: ${id}` }], isError: true };
      return { content: [{ type: "text", text: `watch ${id} 已停止。` }] };
    },
  );

  // ---- HTTP 请求 ----

  server.registerTool(
    "http_request",
    {
      title: "从远程服务器发起 HTTP 请求",
      description:
        "在远程服务器上通过 curl 执行 HTTP 请求，以远程服务器的网络视角探测目标。" +
        "适用于内网接口调试、从服务器视角访问受限端点。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        url: z.string().describe("请求 URL"),
        method: z.string().optional().describe("HTTP 方法，默认 GET"),
        headers: z.record(z.string(), z.string()).optional().describe("请求头键值对"),
        body: z.string().optional().describe("请求体"),
        timeout_ms: z.number().int().positive().optional().describe("超时毫秒数，默认 30000"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: serverName, url, method, headers, body, timeout_ms }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const r = await httpRequest(cfg, url, method ?? "GET", headers ?? {}, body, timeout_ms ?? 30_000);
        return { content: [{ type: "text", text: `HTTP ${r.httpCode}（耗时 ${r.duration}）\n${r.body}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `HTTP 请求失败：${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ---- 环境信息 ----

  server.registerTool(
    "remote_env",
    {
      title: "收集远程服务器环境信息",
      description:
        "收集远程服务器的环境变量、登录用户、网络端口监听、进程信息。" +
        "可选传入 process_name 搜索特定进程。",
      inputSchema: {
        server: z.string().describe("目标服务器 name"),
        process_name: z.string().optional().describe("搜索的进程名（可选）"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ server: serverName, process_name }) => {
      try {
        const servers = loadServers();
        const cfg = servers.get(serverName);
        if (!cfg) return { content: [{ type: "text", text: `未找到服务器 "${serverName}"` }], isError: true };
        const e = await getRemoteEnv(cfg, process_name);
        const lines = [`=== ${e.server} 环境信息 ===`];
        if (e.procInfo) lines.push(`进程: PID=${e.procInfo.pid} PPID=${e.procInfo.ppid} CMD=${e.procInfo.cmdline}`);
        lines.push(`登录用户:\n${e.users}`);
        lines.push(`网络监听:\n${e.network}`);
        if (e.openFiles) lines.push(`文件句柄（尾部）:\n${e.openFiles}`);
        const envKeys = Object.keys(e.envVars);
        if (envKeys.length) {
          lines.push(`环境变量 (${envKeys.length} 个):`);
          for (const [k, v] of Object.entries(e.envVars)) lines.push(`  ${k}=${v}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `收集环境信息失败：${(e as Error).message}` }], isError: true };
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
  process.stdout.write(`ssh-mcp — SSH/SFTP 远程服务器命令行工具  v1.5.0

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
  health                    一键健康检查（OS/磁盘/内存/负载）
  cert-info                 查看 SSL/TLS 证书信息
  copy-between              服务器间直传文件（不经本地）
  diff-servers              对比两台服务器上同一文件差异
  exec-script               上传脚本并执行（自动清理）
  snapshot                  远程目录 tar.gz 打包下载
  tail-f                    持续追踪远程文件（SFTP 轮询）
  stop-tail                 停止 tail 追踪
  list-tails                列出所有 tail 追踪
  watch                     定时重复执行命令并高亮差异
  stop-watch                停止 watch
  list-watches              列出所有 watch 任务
  curl                      从远程服务器发起 HTTP 请求
  env                       收集远程服务器环境信息

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

// ---- 健康检查 CLI ----

async function cmdHealth(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp health --server <name>

一键收集远程服务器健康信息（OS/磁盘/内存/负载/CPU）。

示例:
  ssh-mcp health -s prod-web
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  if (!serverName) die("缺少 --server");
  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    const h = await getHealth(cfg);
    process.stdout.write(`=== ${h.server} (${h.hostname}) ===
操作系统: ${h.os}
运行时长: ${h.uptime}
平均负载: ${h.load}
CPU 核心: ${h.cpuCores}
内存:
${h.memory}
磁盘:
${h.disk}
`);
  } catch (e) { die(`健康检查失败：${(e as Error).message}`); }
}

// ---- SSL 证书 CLI ----

async function cmdCertInfo(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp cert-info --server <name> --host <host> [--port <port>]

通过远程服务器的 openssl 拉取目标 SSL 证书信息。

选项:
  --server, -s <name>   执行 openssl 的 SSH 服务器
  --host <host>         目标主机（必需）
  --port <port>         目标端口（默认 443）

示例:
  ssh-mcp cert-info -s prod-web --host example.com
  ssh-mcp cert-info -s prod-web --host 10.0.0.5 --port 8443
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const host = optStr(opts, "host");
  if (!serverName) die("缺少 --server");
  if (!host) die("缺少 --host");
  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    const c = await getCertInfo(cfg, host, parseInt(optStr(opts, "port") ?? "443", 10));
    process.stdout.write(`主题:   ${c.subject}
签发者: ${c.issuer}
有效期: ${c.notBefore} → ${c.notAfter}
剩余天数: ${c.remainingDays}
指纹: ${c.fingerprint}
SAN: ${c.sans.length ? c.sans.join(", ") : "（无）"}
`);
  } catch (e) { die(`证书检查失败：${(e as Error).message}`); }
}

// ---- 服务器间直传 CLI ----

async function cmdCopyBetween(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp copy-between --src <name> --dst <name> --src-path <path> --dst-path <path>

在两台远程服务器之间直接传输文件，数据不经本机。

选项:
  --src <name>      源服务器 name（必需）
  --dst <name>      目标服务器 name（必需）
  --src-path <path> 源文件路径（必需）
  --dst-path <path> 目标文件路径（必需）

示例:
  ssh-mcp copy-between --src web1 --dst web2 --src-path /opt/app/config.yml --dst-path /opt/app/config.yml
`);
    return;
  }
  const src = optStr(opts, "src");
  const dst = optStr(opts, "dst");
  const srcPath = optStr(opts, "src-path");
  const dstPath = optStr(opts, "dst-path");
  if (!src) die("缺少 --src");
  if (!dst) die("缺少 --dst");
  if (!srcPath) die("缺少 --src-path");
  if (!dstPath) die("缺少 --dst-path");
  try {
    const servers = loadServers();
    const srvA = servers.get(src);
    const srvB = servers.get(dst);
    if (!srvA) die(`未找到源服务器 "${src}"`);
    if (!srvB) die(`未找到目标服务器 "${dst}"`);
    const r = await copyBetween(srvA, srvB, srcPath, dstPath);
    process.stdout.write(`已复制 ${humanBytes(r.size)}：${r.sourceServer}:${r.sourcePath} → ${r.destServer}:${r.destPath}（${(r.elapsedMs / 1000).toFixed(1)}s）\n`);
  } catch (e) { die(`复制失败：${(e as Error).message}`); }
}

// ---- 服务器文件对比 CLI ----

async function cmdDiffServers(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp diff-servers --server-a <name> --server-b <name> --path <path>

对比两台服务器上同一文件的内容差异。

示例:
  ssh-mcp diff-servers --server-a web1 --server-b web2 --path /etc/nginx/nginx.conf
`);
    return;
  }
  const a = optStr(opts, "server-a");
  const b = optStr(opts, "server-b");
  const path = optStr(opts, "path") ?? optStr(opts, "p");
  if (!a) die("缺少 --server-a");
  if (!b) die("缺少 --server-b");
  if (!path) die("缺少 --path");
  try {
    const servers = loadServers();
    const cfgA = servers.get(a);
    const cfgB = servers.get(b);
    if (!cfgA) die(`未找到服务器 "${a}"`);
    if (!cfgB) die(`未找到服务器 "${b}"`);
    const d = await diffServers(cfgA, cfgB, path);
    if (d.identical) { process.stdout.write(`${a} 和 ${b} 上 ${path} 内容一致。\n`); return; }
    process.stdout.write(`--- ${a}:${path}\n+++ ${b}:${path}\n${d.diff}\n`);
  } catch (e) { die(`对比失败：${(e as Error).message}`); }
}

// ---- 脚本执行 CLI ----

async function cmdExecScript(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp exec-script --server <name> --script <path> [--remote <path>] [--timeout <ms>]

上传本机脚本到远程服务器执行，完成后自动删除。

示例:
  ssh-mcp exec-script -s prod-web --script ./deploy.sh
  ssh-mcp exec-script -s prod-web --script ./migrate.sh --remote /tmp/migrate.sh
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const script = optStr(opts, "script");
  if (!serverName) die("缺少 --server");
  if (!script) die("缺少 --script");
  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    const r = await execScript(cfg, script, optStr(opts, "remote") ?? "/tmp/ssh-mcp-script.sh", optNum(opts, "timeout") ?? 120_000);
    process.stdout.write(`退出码: ${r.exitCode}\n${r.stdout}\n`);
    if (r.stderr) process.stderr.write(r.stderr + "\n");
  } catch (e) { die(`脚本执行失败：${(e as Error).message}`); }
}

// ---- 快照 CLI ----

async function cmdSnapshot(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp snapshot --server <name> --dir <path> --output <file> [--exclude <pattern,...>]

将远程目录通过 tar.gz 打包后流式下载到本机。

示例:
  ssh-mcp snapshot -s prod-web --dir /var/log --output ./logs.tar.gz
  ssh-mcp snapshot -s prod-web --dir /opt/app --output ./app-backup.tar.gz --exclude "*.log,node_modules"
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const dir = optStr(opts, "dir");
  const output = optStr(opts, "output");
  if (!serverName) die("缺少 --server");
  if (!dir) die("缺少 --dir");
  if (!output) die("缺少 --output");
  const excludes = (optStr(opts, "exclude") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    const r = await snapshot(cfg, dir, output, excludes);
    process.stdout.write(`快照完成\n  服务器: ${r.server}:${r.remotePath}\n  本地: ${r.localFile}\n  大小: ${humanBytes(r.fileSize)}\n  耗时: ${(r.elapsedMs / 1000).toFixed(1)}s\n`);
  } catch (e) { die(`快照失败：${(e as Error).message}`); }
}

// ---- tail-f CLI ----

async function cmdTailFollow(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp tail-f --server <name> --path <path> [--interval <ms>]

持续追踪远程文件的增长内容（SFTP 轮询模式）。在终端实时输出新增内容。

选项:
  --server, -s <name>   目标服务器 name（必需）
  --path, -p <path>     要追踪的远程文件（必需）
  --interval <ms>       轮询间隔（默认 2000ms）

示例:
  ssh-mcp tail-f -s prod-web -p /var/log/nginx/access.log
  ssh-mcp tail-f -s prod-web -p /var/log/app.log --interval 1000
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
    process.stdout.write(`追踪 ${cfg.name}:${path}（Ctrl+C 停止）\n`);
    await startTailFollow(cfg, path, optNum(opts, "interval") ?? 2000, (_id, chunk) => {
      process.stdout.write(chunk);
    });
    // keep alive; SIGINT will kill process
    await new Promise(() => {});
  } catch (e) { die(`tail 失败：${(e as Error).message}`); }
}

async function cmdStopTail(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp stop-tail --id <id>

停止 tail 追踪任务。

示例:
  ssh-mcp stop-tail --id tail1
`);
    return;
  }
  const id = optStr(opts, "id") ?? optStr(opts, "i");
  if (!id) die("缺少 --id");
  if (!stopTailFollow(id)) die(`未找到 tail: ${id}`);
  process.stdout.write(`tail ${id} 已停止。\n`);
}

async function cmdListTails(_opts: Map<string, string | boolean>): Promise<void> {
  const all = listTailFollows();
  if (all.length === 0) { process.stdout.write("当前没有 tail 追踪任务。\n"); return; }
  for (const t of all) {
    process.stdout.write(`[${t.id}] ${t.server}:${t.path} — ${t.state}（${humanBytes(t.seenBytes)} 已跟踪）\n`);
  }
}

// ---- watch CLI ----

async function cmdWatch(opts: Map<string, string | boolean>, positional: string[]): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp watch --server <name> --interval <ms> [选项] <命令...>

定时重复执行命令，自动高亮输出变化。

选项:
  --server, -s <name>   目标服务器 name（必需）
  --interval <ms>       执行间隔毫秒数（必需）
  --timeout <ms>        每次命令超时（默认 10000）
  --command, -c <cmd>   要执行的命令（也可放在选项之后）

示例:
  ssh-mcp watch -s prod-web --interval 5000 -c "ls -la /tmp"
  ssh-mcp watch -s prod-web --interval 2000 "date +%s ; wc -l /var/log/app.log"
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  const interval = optNum(opts, "interval");
  if (!serverName) die("缺少 --server");
  if (!interval) die("缺少 --interval");

  let command = optStr(opts, "command") ?? optStr(opts, "c");
  if (!command) command = positional.join(" ");
  if (!command) die("缺少命令");

  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    process.stdout.write(`watch ${cfg.name} 每 ${interval}ms: ${command}（Ctrl+C 停止）\n`);
    let prev = "";
    startWatch(cfg, command, interval, (_id, iter) => {
      process.stdout.write(`\n=== ${new Date(iter.timestamp).toLocaleTimeString()} ===\n`);
      if (iter.changed) {
        process.stdout.write(`[变化]\n${iter.diff}\n`);
        prev = iter.stdout + iter.stderr;
      } else {
        process.stdout.write("（无变化）\n");
        process.stdout.write(iter.stdout);
        if (iter.stderr) process.stderr.write(iter.stderr);
      }
    }, optNum(opts, "timeout") ?? 10_000);
    await new Promise(() => {});
  } catch (e) { die(`watch 失败：${(e as Error).message}`); }
}

async function cmdStopWatch(opts: Map<string, string | boolean>): Promise<void> {
  const id = optStr(opts, "id") ?? optStr(opts, "i");
  if (!id) die("缺少 --id");
  if (!stopWatch(id)) die(`未找到 watch: ${id}`);
  process.stdout.write(`watch ${id} 已停止。\n`);
}

async function cmdListWatches(_opts: Map<string, string | boolean>): Promise<void> {
  const all = listWatches();
  if (all.length === 0) { process.stdout.write("当前没有 watch 任务。\n"); return; }
  for (const w of all) {
    process.stdout.write(`[${w.id}] ${w.server}: ${w.command}（每 ${w.intervalMs}ms）— ${w.state}\n`);
  }
}

// ---- curl CLI ----

async function cmdCurl(opts: Map<string, string | boolean>, positional: string[]): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp curl --server <name> [选项] <url>

从远程服务器发起 HTTP 请求，以远程视角探测目标。

选项:
  --server, -s <name>   目标服务器 name（必需）
  --method, -X <method> HTTP 方法（默认 GET）
  --header, -H <hdr>    请求头（可重复使用）
  --data, -d <body>     请求体
  --timeout <ms>        超时毫秒数（默认 30000）

示例:
  ssh-mcp curl -s prod-web http://localhost:8080/health
  ssh-mcp curl -s prod-web -X POST -H 'Content-Type: application/json' -d '{"a":1}' http://api.internal/users
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  let url = positional[0] ?? optStr(opts, "url");
  if (!serverName) die("缺少 --server");
  if (!url) die("缺少 URL");
  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    const r = await httpRequest(cfg, url,
      optStr(opts, "method") ?? optStr(opts, "X") ?? "GET",
      parseHeaderArgs(opts),
      optStr(opts, "data") ?? optStr(opts, "d"),
      optNum(opts, "timeout") ?? 30_000);
    process.stdout.write(`HTTP ${r.httpCode}（耗时 ${r.duration}）\n${r.body}\n`);
  } catch (e) { die(`HTTP 请求失败：${(e as Error).message}`); }
}

function parseHeaderArgs(opts: Map<string, string | boolean>): Record<string, string> {
  const headers: Record<string, string> = {};
  const hv = opts.get("header") ?? opts.get("H");
  if (typeof hv === "string") {
    const colon = hv.indexOf(":");
    if (colon > 0) headers[hv.slice(0, colon).trim()] = hv.slice(colon + 1).trim();
  }
  // For multi-header support, the current arg parser doesn't support repeated flags.
  // Accept comma-separated: -H "a:1,b:2"
  const multi = (typeof hv === "string" ? hv : "");
  return headers;
}

// ---- env CLI ----

async function cmdEnv(opts: Map<string, string | boolean>): Promise<void> {
  if (optBool(opts, "help")) {
    process.stdout.write(`用法: ssh-mcp env --server <name> [--process <name>]

收集远程服务器环境信息：环境变量、登录用户、网络端口、进程。

示例:
  ssh-mcp env -s prod-web
  ssh-mcp env -s prod-web --process nginx
`);
    return;
  }
  const serverName = optStr(opts, "server") ?? optStr(opts, "s");
  if (!serverName) die("缺少 --server");
  try {
    const servers = loadServers();
    const cfg = servers.get(serverName);
    if (!cfg) die(`未找到服务器 "${serverName}"`);
    const e = await getRemoteEnv(cfg, optStr(opts, "process"));
    process.stdout.write(`=== ${e.server} 环境信息 ===\n`);
    if (e.procInfo) process.stdout.write(`进程: PID=${e.procInfo.pid} PPID=${e.procInfo.ppid} CMD=${e.procInfo.cmdline}\n`);
    process.stdout.write(`登录用户:\n${e.users}\n`);
    process.stdout.write(`网络监听:\n${e.network}\n`);
    const envKeys = Object.keys(e.envVars);
    if (envKeys.length) {
      process.stdout.write(`环境变量 (${envKeys.length} 个):\n`);
      for (const [k, v] of Object.entries(e.envVars)) process.stdout.write(`  ${k}=${v}\n`);
    }
  } catch (e) { die(`收集失败：${(e as Error).message}`); }
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
    case "health":             return cmdHealth(options);
    case "cert-info":          return cmdCertInfo(options);
    case "copy-between":       return cmdCopyBetween(options);
    case "diff-servers":       return cmdDiffServers(options);
    case "exec-script":        return cmdExecScript(options);
    case "snapshot":           return cmdSnapshot(options);
    case "tail-f":             return cmdTailFollow(options);
    case "stop-tail":          return cmdStopTail(options);
    case "list-tails":         return cmdListTails(options);
    case "watch":              return cmdWatch(options, positional);
    case "stop-watch":         return cmdStopWatch(options);
    case "list-watches":       return cmdListWatches(options);
    case "curl":               return cmdCurl(options, positional);
    case "env":                return cmdEnv(options);
    default:
      die(`未知子命令: ${subcommand}\n运行 ssh-mcp --help 查看可用命令。`);
  }
}

main().catch((e) => {
  process.stderr.write(`ssh-mcp 启动失败：${e}\n`);
  process.exit(1);
});
