import { readFileSync } from "node:fs";
import { Client, type ConnectConfig } from "ssh2";
import { expandHome, type ServerConfig } from "./config.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** 远程命令退出码。被信号杀死时可能为 null。 */
  code: number | null;
  /** 若进程被信号终止，则为信号名（如 "KILL"）。 */
  signal?: string;
}

/** 长连接会话——复用 TCP 连接，省去重复握手和认证开销。 */
export interface Session {
  id: string;
  server: string;
  conn: Client;
  createdAt: number;
}

const sessions = new Map<string, Session>();
let sessionCounter = 0;

export async function openSession(server: ServerConfig, timeoutMs: number): Promise<Session> {
  const conn = await createConnection(server, timeoutMs);
  const id = `s${++sessionCounter}`;
  const session: Session = { id, server: server.name, conn, createdAt: Date.now() };
  sessions.set(id, session);
  conn.on("close", () => sessions.delete(id));
  conn.on("error", () => sessions.delete(id));
  return { id: session.id, server: session.server, createdAt: session.createdAt } as Session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function closeSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.conn.end();
  sessions.delete(id);
  return true;
}

export function listSessions(): Session[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    server: s.server,
    createdAt: s.createdAt,
  })) as Session[];
}

/** 根据服务器配置组装 ssh2 的连接参数，挑选鉴权方式。 */
export function buildConnectConfig(server: ServerConfig, readyTimeoutMs: number): ConnectConfig {
  const conf: ConnectConfig = {
    host: server.host,
    port: server.port ?? 22,
    username: server.username,
    readyTimeout: readyTimeoutMs,
  };

  if (server.privateKeyPath) {
    // 私钥登录优先级最高。
    conf.privateKey = readFileSync(expandHome(server.privateKeyPath));
    if (server.passphrase) conf.passphrase = server.passphrase;
  } else if (server.password) {
    // 其次是密码登录。
    conf.password = server.password;
  } else if (process.env.SSH_AUTH_SOCK) {
    // 最后退回到本机 ssh-agent。
    conf.agent = process.env.SSH_AUTH_SOCK;
  }

  return conf;
}

/** 建立一条已就绪的 SSH 连接。命令执行和文件传输共用这一条连接路径。 */
export function createConnection(server: ServerConfig, readyTimeoutMs: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.on("ready", () => {
      if (!settled) {
        settled = true;
        resolve(conn);
      }
    });
    conn.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    try {
      conn.connect(buildConnectConfig(server, readyTimeoutMs));
    } catch (e) {
      // 读取私钥失败等同步错误。
      if (!settled) {
        settled = true;
        reject(e as Error);
      }
    }
  });
}

/**
 * 在指定服务器上执行一条命令，收集 stdout/stderr/退出码后返回。
 *
 * 短连接模式（默认）：每次调用建立一条独立连接，执行完即断开。
 * 长连接模式（传入 sessionId）：复用已有 TCP 连接，省去重复握手和认证，
 *   但注意每次 exec 仍在独立 channel 中执行，命令之间不保留工作目录或环境变量——
 *   需要时请用 `cd x && cmd` 自行串接。
 */
export async function runCommand(
  server: ServerConfig,
  command: string,
  timeoutMs: number,
  sessionId?: string,
): Promise<CommandResult> {
  let conn: Client;
  let shouldEnd: boolean;

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`长连接会话 ${sessionId} 不存在或已断开`);
    conn = session.conn;
    shouldEnd = false;
  } else {
    conn = await createConnection(server, timeoutMs);
    shouldEnd = true;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      if (shouldEnd) conn.end();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`命令执行超时（${timeoutMs}ms）`)));
    }, timeoutMs);

    conn.on("error", (err) => finish(() => reject(err)));

    conn.exec(command, (err, stream) => {
      if (err) {
        finish(() => reject(err));
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      stream.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      stream.on("close", (code: number | null, signal?: string) => {
        finish(() => resolve({ stdout, stderr, code, signal }));
      });
    });
  });
}
