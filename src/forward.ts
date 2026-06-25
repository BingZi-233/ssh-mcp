import { createServer, type Server, Socket } from "node:net";
import type { Client } from "ssh2";
import { createConnection } from "./ssh.js";
import type { ServerConfig } from "./config.js";

export interface Forward {
  id: string;
  server: string;
  type: "local" | "remote";
  /** 本地绑定地址 */
  localHost: string;
  localPort: number;
  /** 隧道远端目标地址 */
  remoteHost: string;
  remotePort: number;
  state: "running" | "stopped";
  createdAt: number;
}

const forwards = new Map<string, Forward>();
/** 存活的本地 net.Server / SSH 连接，用于关闭 */
const resources = new Map<string, { conn: Client; server?: Server }>();
let counter = 0;

function track(id: string, conn: Client, server?: Server) {
  resources.set(id, { conn, server });
  conn.on("close", () => {
    const f = forwards.get(id);
    if (f) f.state = "stopped";
    server?.close();
  });
  conn.on("error", () => {
    const f = forwards.get(id);
    if (f) f.state = "stopped";
    server?.close();
  });
}

/**
 * 启动端口转发。
 *
 * type=local: 监听本机 localPort，流量经 SSH 服务器转发到 remoteHost:remotePort。
 * type=remote: SSH 服务器监听 remotePort，流量经本机转发到 localHost:localPort。
 */
export async function startForward(
  cfg: ServerConfig,
  type: "local" | "remote",
  localHost: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<Forward> {
  const conn = await createConnection(cfg, 20_000);
  const id = `f${++counter}`;

  if (type === "local") {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket: Socket) => {
        conn.forwardOut(localHost, localPort, remoteHost, remotePort, (err, stream) => {
          if (err) { socket.destroy(); return; }
          socket.pipe(stream).pipe(socket);
          stream.on("error", () => socket.destroy());
          socket.on("error", () => stream.destroy());
        });
      });
      server.on("error", reject);
      server.listen(localPort, localHost, () => {
        server.removeListener("error", reject);
        track(id, conn, server);
        resolve();
      });
    });
  } else {
    // remote: SSH 服务器暴露端口，转发回本机
    await new Promise<void>((resolve, reject) => {
      conn.forwardIn(remoteHost, remotePort, (err) => {
        if (err) reject(err);
        else {
          track(id, conn);
          resolve();
        }
      });
    });
    // 处理来自远程的入站连接
    conn.on("tcp connection", (info, accept) => {
      const stream = accept();
      const sock = new Socket();
      sock.connect(remotePort, localHost, () => {
        sock.pipe(stream).pipe(sock);
        stream.on("error", () => sock.destroy());
        sock.on("error", () => stream.destroy());
      });
      sock.on("error", () => stream.end());
    });
  }

  const fwd: Forward = {
    id,
    server: cfg.name,
    type,
    localHost,
    localPort,
    remoteHost,
    remotePort,
    state: "running",
    createdAt: Date.now(),
  };
  forwards.set(id, fwd);
  return fwd;
}

export function getForward(id: string): Forward | undefined {
  return forwards.get(id);
}

export function listForwards(): Forward[] {
  return [...forwards.values()];
}

export function closeForward(id: string): boolean {
  const fwd = forwards.get(id);
  if (!fwd || fwd.state === "stopped") return false;
  fwd.state = "stopped";
  const res = resources.get(id);
  if (res) {
    res.server?.close();
    res.conn.end();
    resources.delete(id);
  }
  return true;
}
