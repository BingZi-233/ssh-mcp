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
 * 设计取舍：每次调用建立一条独立连接，执行完即断开。SSH 的 exec channel 本就
 * 无状态，命令之间不会保留工作目录或环境变量——需要时请用 `cd x && cmd` 自行串接。
 */
export async function runCommand(
  server: ServerConfig,
  command: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const conn = await createConnection(server, timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      conn.end();
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
