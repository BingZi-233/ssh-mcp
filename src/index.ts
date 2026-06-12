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

const server = new McpServer({
  name: "ssh-mcp",
  version: "1.0.0",
});

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
      server: z
        .string()
        .describe("目标服务器的 name，必须与 list_servers 返回的某个 name 完全一致"),
      command: z.string().describe("要在远程服务器上执行的 shell 命令"),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`命令超时时间（毫秒），默认 ${DEFAULT_TIMEOUT_MS}`),
      session: z
        .string()
        .optional()
        .describe("长连接会话 id（由 open_session 返回）。不填则使用短连接。"),
      force: z
        .boolean()
        .optional()
        .describe("传入 true 跳过安全策略检查。请谨慎使用。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ server: serverName, command, timeout_ms, session, force }) => {
    let servers;
    try {
      servers = loadServers();
    } catch (e) {
      return {
        content: [{ type: "text", text: `读取服务器配置失败：${(e as Error).message}` }],
        isError: true,
      };
    }

    const cfg = servers.get(serverName);
    if (!cfg) {
      const names = [...servers.keys()].join(", ") || "（无）";
      return {
        content: [
          { type: "text", text: `未找到名为 "${serverName}" 的服务器。可用：${names}` },
        ],
        isError: true,
      };
    }

    if (!force) {
      const security = loadSecurity();
      const blocked = validateCommand(command, security.blocked_patterns ?? []);
      if (blocked) {
        return {
          content: [{ type: "text", text: `${blocked}\n使用 force=true 可跳过安全检查。` }],
          isError: true,
        };
      }
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
      return {
        content: [{ type: "text", text: `执行失败：${(e as Error).message}` }],
        isError: true,
      };
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
    inputSchema: {
      server: z.string().describe("目标服务器的 name（见 list_servers）"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ server: serverName }) => {
    try {
      const servers = loadServers();
      const cfg = servers.get(serverName);
      if (!cfg) {
        const names = [...servers.keys()].join(", ") || "（无）";
        return {
          content: [{ type: "text", text: `未找到名为 "${serverName}" 的服务器。可用：${names}` }],
          isError: true,
        };
      }
      const s = await openSession(cfg, 20_000);
      return { content: [{ type: "text", text: `长连接会话已建立\n  id: ${s.id}\n  服务器: ${s.server}\n  创建时间: ${new Date(s.createdAt).toISOString()}` }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `打开长连接会话失败：${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "close_session",
  {
    title: "关闭长连接会话",
    description:
      "关闭由 open_session 建立的长连接会话，释放底层 SSH 连接。",
    inputSchema: {
      session: z.string().describe("要关闭的会话 id（由 open_session 返回）"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ session }) => {
    const ok = closeSession(session);
    if (!ok) {
      return {
        content: [{ type: "text", text: `会话 ${session} 不存在或已断开。` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: `会话 ${session} 已关闭。` }] };
  },
);

server.registerTool(
  "list_sessions",
  {
    title: "列出当前所有长连接会话",
    description:
      "列出当前已打开的所有长连接会话的 id、关联服务器和创建时间。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const all = listSessions();
    const text =
      all.length > 0
        ? all
            .map(
              (s) =>
                `  ${s.id} → ${s.server}（${new Date(s.createdAt).toISOString()}）`,
            )
            .join("\n")
        : "当前没有长连接会话。";
    return { content: [{ type: "text", text }] };
  },
);

function loadServersOrError() {
  try {
    return { servers: loadServers(), error: null as null | string };
  } catch (e) {
    return { servers: null, error: (e as Error).message };
  }
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
      overwrite: z
        .boolean()
        .optional()
        .describe("true 则忽略远程已有部分、从头覆盖；默认 false（自动断点续传）"),
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
      const hint =
        t.state === "completed"
          ? "\n（目标已是完整文件，无需传输。）"
          : `\n传输已在后台开始，用 transfer_status({ id: "${t.id}" }) 查看进度。`;
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
      overwrite: z
        .boolean()
        .optional()
        .describe("true 则忽略本地已有部分、从头覆盖；默认 false（自动断点续传）"),
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
      const hint =
        t.state === "completed"
          ? "\n（目标已是完整文件，无需传输。）"
          : `\n传输已在后台开始，用 transfer_status({ id: "${t.id}" }) 查看进度。`;
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
    description:
      "查询后台文件传输任务的进度（已传字节、百分比、速度、预计剩余时间、状态）。" +
      "传入 id 查看单个任务；不传则列出本次会话的全部任务。",
    inputSchema: {
      id: z.string().optional().describe("传输任务 id；不填则列出全部任务"),
    },
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
    description:
      "取消一个正在进行的后台传输任务。已传输的部分文件会保留，之后可用同样的路径再次发起以断点续传。",
    inputSchema: {
      id: z.string().describe("要取消的传输任务 id"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    const t = cancelTransfer(id);
    if (!t) return { content: [{ type: "text", text: `未找到传输任务：${id}` }], isError: true };
    return { content: [{ type: "text", text: `已请求取消：\n${formatTransfer(t)}` }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 日志走 stderr，避免污染 stdio 上的 MCP 协议数据。
  console.error(`ssh-mcp 已启动，配置文件：${configPath()}`);
}

main().catch((e) => {
  console.error("ssh-mcp 启动失败：", e);
  process.exit(1);
});
