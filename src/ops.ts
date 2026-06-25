import { createWriteStream, createReadStream, statSync, unlinkSync } from "node:fs";
import { posix } from "node:path";
import { createConnection, runCommand } from "./ssh.js";
import type { ServerConfig } from "./config.js";
import type { SFTPWrapper, Client } from "ssh2";

// reopen: helper because openSftp is not exported from transfer.ts, but we need it here
function sftpOpen(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
export interface HealthReport {
  server: string;
  hostname: string;
  os: string;
  uptime: string;
  load: string;
  memory: string;
  disk: string;
  cpuCores: string;
}

const HEALTH_CMD = [
  'echo "HOSTNAME:$(hostname)"',
  'echo "OS_START"',
  'cat /etc/os-release 2>/dev/null | head -2 || echo "N/A"',
  'echo "OS_END"',
  'echo "UPTIME:$(uptime -p 2>/dev/null || cat /proc/uptime)"',
  'echo "LOAD:$(cat /proc/loadavg)"',
  'echo "MEM:$(free -h 2>/dev/null || head -5 /proc/meminfo)"',
  'echo "DISK_START"',
  'df -h / /tmp /var 2>/dev/null || df -h /',
  'echo "DISK_END"',
  'echo "CPU:$(nproc) cores"',
].join("; ");

export async function getHealth(cfg: ServerConfig, timeoutMs = 30_000): Promise<HealthReport> {
  const r = await runCommand(cfg, HEALTH_CMD, timeoutMs);
  const out = (r.stdout || "") + (r.stderr || "");

  const extract = (label: string): string => {
    const m = out.match(new RegExp(`${label}:(.+?)(?:\\n|$)`));
    return m ? m[1].trim() : "—";
  };
  const section = (start: string, end: string): string => {
    const i = out.indexOf(start);
    const j = out.indexOf(end, i);
    if (i === -1) return "—";
    return out.slice(i + start.length, j === -1 ? undefined : j).trim();
  };

  return {
    server: cfg.name,
    hostname: extract("HOSTNAME"),
    os: section("OS_START", "OS_END"),
    uptime: extract("UPTIME"),
    load: extract("LOAD"),
    memory: extract("MEM"),
    disk: section("DISK_START", "DISK_END"),
    cpuCores: extract("CPU"),
  };
}

// ---------------------------------------------------------------------------
// SSL Certificate info (via remote openssl)
// ---------------------------------------------------------------------------
export interface CertInfo {
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  sans: string[];
  fingerprint: string;
  remainingDays: number;
}

export async function getCertInfo(
  cfg: ServerConfig,
  host: string,
  port = 443,
  timeoutMs = 15_000,
): Promise<CertInfo> {
  const cmd = `echo | openssl s_client -connect '${host}:${port}' -servername '${host}' 2>/dev/null | openssl x509 -noout -subject -issuer -dates -fingerprint -ext subjectAltName`;
  const r = await runCommand(cfg, cmd, timeoutMs);
  const out = (r.stdout || "") + (r.stderr || "");

  const extract = (label: string): string => {
    const m = out.match(new RegExp(`^${label}\\s*=\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "—";
  };

  const sans: string[] = [];
  const sanRe = /DNS:([^\s,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = sanRe.exec(out))) sans.push(m[1]);

  const notAfter = extract("notAfter");
  let remainingDays = -1;
  try {
    remainingDays = Math.ceil((Date.parse(notAfter) - Date.now()) / 86_400_000);
  } catch { /* */ }

  return {
    subject: extract("subject"),
    issuer: extract("issuer"),
    notBefore: extract("notBefore"),
    notAfter,
    sans,
    fingerprint: extract("fingerprint") || extract("SHA256 Fingerprint") || extract("SHA1 Fingerprint"),
    remainingDays,
  };
}

// ---------------------------------------------------------------------------
// Copy file between two servers (no local intermediate)
// ---------------------------------------------------------------------------
export interface CopyResult {
  sourceServer: string;
  destServer: string;
  sourcePath: string;
  destPath: string;
  size: number;
  elapsedMs: number;
}

export async function copyBetween(
  srcCfg: ServerConfig,
  destCfg: ServerConfig,
  sourcePath: string,
  destPath: string,
): Promise<CopyResult> {
  const srcConn = await createConnection(srcCfg, 20_000);
  const srcSftp = await sftpOpen(srcConn);

  // stat the source file
  const srcStat: { size: number } = await new Promise((resolve, reject) => {
    srcSftp.stat(sourcePath, (err, s) => (err ? reject(err) : resolve(s)));
  });

  const destConn = await createConnection(destCfg, 20_000);
  const destSftp = await sftpOpen(destConn);

  const startedAt = Date.now();

  await new Promise<void>((resolve, reject) => {
    const readStream = srcSftp.createReadStream(sourcePath);
    const writeStream = destSftp.createWriteStream(destPath);

    readStream.on("error", (err: Error) => {
      destConn.end();
      srcConn.end();
      reject(err);
    });
    writeStream.on("error", (err: Error) => {
      destConn.end();
      srcConn.end();
      reject(err);
    });
    writeStream.on("close", () => {
      destConn.end();
      srcConn.end();
      resolve();
    });

    readStream.pipe(writeStream);
  });

  return {
    sourceServer: srcCfg.name,
    destServer: destCfg.name,
    sourcePath,
    destPath,
    size: srcStat.size,
    elapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Diff same file across two servers
// ---------------------------------------------------------------------------
export interface DiffResult {
  path: string;
  serverA: string;
  serverB: string;
  identical: boolean;
  added: number;
  removed: number;
  diff: string;
}

export async function diffServers(
  cfgA: ServerConfig,
  cfgB: ServerConfig,
  path: string,
): Promise<DiffResult> {
  const read = async (cfg: ServerConfig): Promise<string> => {
    const conn = await createConnection(cfg, 20_000);
    const sftp = await sftpOpen(conn);
    return new Promise((resolve, reject) => {
      let buf = "";
      const stream = sftp.createReadStream(path, { autoClose: true });
      stream.on("data", (d: Buffer) => (buf += d.toString("utf8")));
      stream.on("error", reject);
      stream.on("end", () => {
        conn.end();
        resolve(buf);
      });
    });
  };

  const [a, b] = await Promise.all([read(cfgA), read(cfgB)]);
  const linesA = a.split("\n");
  const linesB = b.split("\n");

  // simple unified diff
  const diffLines: string[] = [];
  const maxLen = Math.max(linesA.length, linesB.length);
  let added = 0;
  let removed = 0;

  // Very simple line-by-line comparison with context
  let i = 0, j = 0;
  while (i < linesA.length || j < linesB.length) {
    if (i < linesA.length && j < linesB.length && linesA[i] === linesB[j]) {
      diffLines.push(`  ${linesA[i]}`);
      i++; j++;
    } else {
      // look ahead for sync point
      let syncI = -1, syncJ = -1;
      const lookahead = 10;
      for (let di = 0; di <= lookahead && i + di < linesA.length; di++) {
        for (let dj = 0; dj <= lookahead && j + dj < linesB.length; dj++) {
          if (di === 0 && dj === 0) continue;
          if (linesA[i + di] === linesB[j + dj]) {
            if (syncI === -1 || di + dj < syncI + syncJ) {
              syncI = di; syncJ = dj;
            }
          }
        }
      }

      if (syncI >= 0) {
        // show removed lines from A
        for (let di = 0; di < syncI; di++) {
          diffLines.push(`- ${linesA[i + di]}`);
          removed++;
        }
        // show added lines from B
        for (let dj = 0; dj < syncJ; dj++) {
          diffLines.push(`+ ${linesB[j + dj]}`);
          added++;
        }
        i += syncI; j += syncJ;
      } else {
        // no sync found, dump remaining
        while (i < linesA.length) {
          diffLines.push(`- ${linesA[i++]}`);
          removed++;
        }
        while (j < linesB.length) {
          diffLines.push(`+ ${linesB[j++]}`);
          added++;
        }
      }
    }
  }

  return {
    path,
    serverA: cfgA.name,
    serverB: cfgB.name,
    identical: added === 0 && removed === 0,
    added,
    removed,
    diff: diffLines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Exec script: upload → chmod → run → cleanup
// ---------------------------------------------------------------------------
export interface ExecScriptResult {
  server: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function execScript(
  cfg: ServerConfig,
  localScriptPath: string,
  remotePath: string,
  timeoutMs = 120_000,
): Promise<ExecScriptResult> {
  const conn = await createConnection(cfg, 20_000);
  const sftp = await sftpOpen(conn);

  // upload the script
  await new Promise<void>((resolve, reject) => {
    const read = createReadStream(localScriptPath);
    const write = sftp.createWriteStream(remotePath, { mode: 0o755 });
    read.on("error", reject);
    write.on("error", reject);
    write.on("close", resolve);
    read.pipe(write);
  });

  // run it
  const result = await runCommand(cfg, `chmod +x '${remotePath}' && '${remotePath}'; EC=$?; rm -f '${remotePath}'; exit $EC`, timeoutMs, undefined);

  conn.end();
  return {
    server: cfg.name,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// ---------------------------------------------------------------------------
// Snapshot: remote directory → tar.gz stream → local file
// ---------------------------------------------------------------------------
export interface SnapshotResult {
  server: string;
  remotePath: string;
  localFile: string;
  fileSize: number;
  elapsedMs: number;
}

export async function snapshot(
  cfg: ServerConfig,
  remoteDir: string,
  localFile: string,
  excludes: string[] = [],
): Promise<SnapshotResult> {
  const startedAt = Date.now();
  const excludeArgs = excludes.map((e) => `--exclude='${e}'`).join(" ");
  const cmd = `cd '${remoteDir}' && tar czf - ${excludeArgs} .`;

  const conn = await createConnection(cfg, 20_000);

  await new Promise<void>((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) { conn.end(); return reject(err); }

      const write = createWriteStream(localFile);
      stream.on("error", (e: Error) => { conn.end(); reject(e); });
      write.on("error", (e: Error) => { conn.end(); reject(e); });

      stream.on("close", (code: number | null) => {
        conn.end();
        if (code !== null && code !== 0) {
          return reject(new Error(`tar 退出码: ${code}`));
        }
        resolve();
      });

      stream.pipe(write);
    });
  });

  const fileSize = statSync(localFile).size;
  return {
    server: cfg.name,
    remotePath: remoteDir,
    localFile,
    fileSize,
    elapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Tail-f (SFTP polling mode)
// ---------------------------------------------------------------------------
export interface TailFollow {
  id: string;
  server: string;
  path: string;
  state: "following" | "stopped";
  seenBytes: number;
  createdAt: number;
}

const tails = new Map<string, TailFollow & { timer: ReturnType<typeof setInterval> }>();
let tailCounter = 0;

export async function startTailFollow(
  cfg: ServerConfig,
  path: string,
  intervalMs = 2000,
  onData: (id: string, chunk: string) => void,
): Promise<TailFollow> {
  const conn = await createConnection(cfg, 20_000);
  const sftp = await sftpOpen(conn);

  const currentSize = await new Promise<{ size: number }>((resolve, reject) => {
    sftp.stat(path, (err, s) => (err ? reject(err) : resolve(s)));
  });

  const id = `tail${++tailCounter}`;
  let offset = currentSize.size;
  const tf: TailFollow = {
    id,
    server: cfg.name,
    path,
    state: "following",
    seenBytes: 0,
    createdAt: Date.now(),
  };

  const timer = setInterval(() => {
    if (tf.state === "stopped") {
      clearInterval(timer);
      conn.end();
      tails.delete(id);
      return;
    }
    sftp.stat(path, (err, s) => {
      if (err) return;
      if (s.size > offset) {
        const read = sftp.createReadStream(path, { start: offset, end: s.size - 1 });
        let chunk = "";
        read.on("data", (d: Buffer) => (chunk += d.toString("utf8")));
        read.on("end", () => {
          tf.seenBytes += chunk.length;
          offset = s.size;
          onData(id, chunk);
        });
      } else if (s.size < offset) {
        // file truncated
        offset = 0;
      }
    });
  }, intervalMs);

  tails.set(id, { ...tf, timer });
  conn.on("close", () => { tf.state = "stopped"; clearInterval(timer); tails.delete(id); });
  conn.on("error", () => { tf.state = "stopped"; clearInterval(timer); tails.delete(id); });

  return tf;
}

export function stopTailFollow(id: string): boolean {
  const t = tails.get(id);
  if (!t) return false;
  t.state = "stopped";
  clearInterval(t.timer);
  tails.delete(id);
  return true;
}

export function getTailFollow(id: string): TailFollow | undefined {
  const t = tails.get(id);
  if (!t) return undefined;
  return { id: t.id, server: t.server, path: t.path, state: t.state, seenBytes: t.seenBytes, createdAt: t.createdAt };
}

export function listTailFollows(): TailFollow[] {
  return [...tails.values()].map((t) => ({
    id: t.id, server: t.server, path: t.path, state: t.state, seenBytes: t.seenBytes, createdAt: t.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// HTTP request from remote server (curl)
// ---------------------------------------------------------------------------
export interface HttpResponse {
  server: string;
  exitCode: number | null;
  httpCode: string;
  body: string;
  headers: string;
  duration: string;
}

export async function httpRequest(
  cfg: ServerConfig,
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
  timeoutMs = 30_000,
): Promise<HttpResponse> {
  const headerArgs = Object.entries(headers)
    .map(([k, v]) => `-H '${k}: ${v.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const dataArg = body ? `--data '${body.replace(/'/g, "'\\''")}'` : "";
  const urlEscaped = url.replace(/'/g, "'\\''");

  const cmd = `curl -sS -w '\\n<<HTTP_CODE>>%{http_code}<<TIME>>%{time_total}' -X ${method} ${headerArgs} ${dataArg} '${urlEscaped}'`;

  const r = await runCommand(cfg, cmd, timeoutMs);
  const out = (r.stdout || "") + (r.stderr || "");

  let httpCode = "—";
  let duration = "—";
  const codeM = out.match(/<<HTTP_CODE>>(\d+)/);
  const timeM = out.match(/<<TIME>>([\d.]+)/);
  if (codeM) httpCode = codeM[1];
  if (timeM) duration = `${timeM[1]}s`;
  const bodyContent = out.replace(/<<HTTP_CODE>>\d+.*$/, "").trim();

  return {
    server: cfg.name,
    exitCode: r.code,
    httpCode,
    body: bodyContent,
    headers: "",
    duration,
  };
}

// ---------------------------------------------------------------------------
// Remote environment info
// ---------------------------------------------------------------------------
export interface RemoteEnv {
  server: string;
  envVars: Record<string, string>;
  procInfo: { pid: number; ppid: number; cmdline: string } | null;
  users: string;
  openFiles: string;
  network: string;
}

export async function getRemoteEnv(
  cfg: ServerConfig,
  processName?: string,
  timeoutMs = 20_000,
): Promise<RemoteEnv> {
  const cmds = [
    "echo '<<ENV>>'" + "&& env | head -60",
    "echo '<<USERS>>'" + "&& who 2>/dev/null || echo 'N/A'",
    "echo '<<OPENFILES>>'" + "&& lsof -u $(whoami) 2>/dev/null | tail -20 || echo 'N/A'",
    "echo '<<NETWORK>>'" + "&& ss -tlnp 2>/dev/null | head -20 || netstat -tlnp 2>/dev/null | head -20 || echo 'N/A'",
  ];

  if (processName) {
    cmds.push(`echo '<<PROC>>' && ps aux | grep '${processName}' | grep -v grep | head -5`);
  }

  const cmd = cmds.join("; ");
  const r = await runCommand(cfg, cmd, timeoutMs);
  const out = (r.stdout || "") + (r.stderr || "");

  const section = (label: string): string => {
    const i = out.indexOf(`<<${label}>>`);
    if (i === -1) return "";
    const start = i + label.length + 7; // <<LABEL>>\n
    const rest = out.slice(start);
    const next = rest.search(/<<[A-Z]+>>/);
    return next === -1 ? rest.trim() : rest.slice(0, next).trim();
  };

  const envStr = section("ENV");
  const envVars: Record<string, string> = {};
  for (const line of envStr.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) envVars[line.slice(0, eq)] = line.slice(eq + 1);
  }

  let procInfo: { pid: number; ppid: number; cmdline: string } | null = null;
  const procSection = section("PROC");
  if (procSection) {
    const fields = procSection.split(/\s+/);
    if (fields.length >= 11) {
      procInfo = {
        pid: parseInt(fields[1], 10),
        ppid: parseInt(fields[2], 10),
        cmdline: fields.slice(10).join(" "),
      };
    }
  }

  return {
    server: cfg.name,
    envVars,
    procInfo,
    users: section("USERS"),
    openFiles: section("OPENFILES"),
    network: section("NETWORK"),
  };
}

// ---------------------------------------------------------------------------
// Watch: periodic command with diff highlighting
// ---------------------------------------------------------------------------
export interface WatchHandle {
  id: string;
  command: string;
  server: string;
  intervalMs: number;
  state: "running" | "stopped";
}

const watches = new Map<string, WatchHandle & { timer: ReturnType<typeof setInterval> }>();
let watchCounter = 0;

export interface WatchIteration {
  timestamp: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  changed: boolean;
  diff: string;
}

export function startWatch(
  cfg: ServerConfig,
  command: string,
  intervalMs: number,
  onIteration: (id: string, iter: WatchIteration) => void,
  timeoutMs = 10_000,
): WatchHandle {
  const id = `w${++watchCounter}`;
  const wh: WatchHandle = { id, command, server: cfg.name, intervalMs, state: "running" };

  let prevOut = "";

  const tick = async () => {
    if (wh.state === "stopped") {
      clearInterval(timer);
      watches.delete(id);
      return;
    }
    try {
      const r = await runCommand(cfg, command, timeoutMs);
      const out = r.stdout + r.stderr;
      const changed = out !== prevOut;
      const diff = changed ? computeDiff(prevOut, out) : "";
      prevOut = out;
      onIteration(id, {
        timestamp: Date.now(),
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.code,
        changed,
        diff,
      });
    } catch {
      // skip failed iterations
    }
  };

  const timer = setInterval(tick, intervalMs);
  watches.set(id, { ...wh, timer });

  // run first iteration immediately
  tick();

  return wh;
}

export function stopWatch(id: string): boolean {
  const w = watches.get(id);
  if (!w) return false;
  w.state = "stopped";
  clearInterval(w.timer);
  watches.delete(id);
  return true;
}

export function getWatch(id: string): WatchHandle | undefined {
  return watches.get(id);
}

export function listWatches(): WatchHandle[] {
  return [...watches.values()].map((w) => ({
    id: w.id, command: w.command, server: w.server, intervalMs: w.intervalMs, state: w.state,
  }));
}

function computeDiff(prev: string, curr: string): string {
  const pa = prev.split("\n");
  const ca = curr.split("\n");
  const lines: string[] = [];
  const max = Math.max(pa.length, ca.length);
  for (let i = 0; i < max; i++) {
    const p = pa[i] ?? "";
    const c = ca[i] ?? "";
    if (p !== c) {
      if (p) lines.push(`- ${p}`);
      if (c) lines.push(`+ ${c}`);
    }
  }
  return lines.slice(0, 40).join("\n");
}
