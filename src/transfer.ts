import { createReadStream, createWriteStream, statSync } from "node:fs";
import { basename } from "node:path";
import { posix as posixPath } from "node:path";
import { Readable, Writable } from "node:stream";
import { Client, type SFTPWrapper, type Stats } from "ssh2";
import { createConnection } from "./ssh.js";
import type { ServerConfig } from "./config.js";

export type Direction = "upload" | "download";
export type TransferState = "running" | "completed" | "failed" | "cancelled";

export interface Transfer {
  id: string;
  server: string;
  direction: Direction;
  localPath: string;
  remotePath: string;
  /** 源文件总大小（字节）。 */
  totalBytes: number;
  /** 续传起点：本次开始时目标已有的字节数。 */
  startOffset: number;
  /** 目标当前已有字节数 = startOffset + 本次已搬运。 */
  transferredBytes: number;
  state: TransferState;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

// 任务注册表只活在内存里。续传不依赖它——真正的事实来源是磁盘上文件的实际大小，
// 所以即便进程重启、注册表清空，再次发起同一对路径的传输也能自动续上。
const transfers = new Map<string, Transfer>();
const handles = new Map<string, () => void>();
let counter = 0;

function statRemote(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  return new Promise((resolve) => {
    sftp.stat(path, (err, stats) => resolve(err ? null : stats));
  });
}

function statLocal(path: string): { size: number; isDir: boolean } | null {
  try {
    const s = statSync(path);
    return { size: s.size, isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

function openSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

/**
 * 发起一次后台文件传输并立即返回任务记录。调用方应随后用 getTransfer/listTransfers 轮询进度。
 *
 * 续传逻辑：根据目标当前大小决定起始偏移量。overwrite=true 时从头覆盖。
 * 若目标是已存在的目录，则自动在其下追加源文件名。
 */
export async function startTransfer(
  cfg: ServerConfig,
  direction: Direction,
  localPath: string,
  remotePath: string,
  overwrite: boolean,
): Promise<Transfer> {
  const conn = await createConnection(cfg, 20_000);

  let sftp: SFTPWrapper;
  try {
    sftp = await openSftp(conn);
  } catch (e) {
    conn.end();
    throw e;
  }

  let totalBytes: number;
  let startOffset: number;
  let localFile = localPath;
  let remoteFile = remotePath;

  try {
    if (direction === "upload") {
      const lst = statLocal(localPath);
      if (!lst) throw new Error(`本地文件不存在：${localPath}`);
      if (lst.isDir) throw new Error(`本地路径是目录，请指定文件：${localPath}`);
      totalBytes = lst.size;

      const rst = await statRemote(sftp, remotePath);
      if (rst?.isDirectory()) {
        // 远程是目录 → 在其下追加本地文件名。
        remoteFile = posixPath.join(remotePath, basename(localPath));
        const r2 = await statRemote(sftp, remoteFile);
        startOffset = overwrite ? 0 : r2?.size ?? 0;
      } else {
        startOffset = overwrite ? 0 : rst?.size ?? 0;
      }
    } else {
      const rst = await statRemote(sftp, remotePath);
      if (!rst) throw new Error(`远程文件不存在：${remotePath}`);
      if (rst.isDirectory()) throw new Error(`远程路径是目录，请指定文件：${remotePath}`);
      totalBytes = rst.size;

      const lst = statLocal(localPath);
      if (lst?.isDir) {
        // 本地是目录 → 在其下追加远程文件名。
        localFile = posixPath.join(localPath, basename(remotePath));
        const l2 = statLocal(localFile);
        startOffset = overwrite ? 0 : l2?.size ?? 0;
      } else {
        startOffset = overwrite ? 0 : lst?.size ?? 0;
      }
    }
  } catch (e) {
    conn.end();
    throw e;
  }

  if (startOffset > totalBytes) {
    conn.end();
    throw new Error(
      `目标已有 ${startOffset} 字节，超过源文件的 ${totalBytes} 字节，文件可能不一致。` +
        `请用 overwrite=true 重新传输。`,
    );
  }

  const id = `t${++counter}`;
  const now = Date.now();
  const t: Transfer = {
    id,
    server: cfg.name,
    direction,
    localPath: localFile,
    remotePath: remoteFile,
    totalBytes,
    startOffset,
    transferredBytes: startOffset,
    state: "running",
    startedAt: now,
    updatedAt: now,
  };
  transfers.set(id, t);

  // 目标已经完整，无需传输。
  if (startOffset === totalBytes) {
    t.state = "completed";
    t.updatedAt = Date.now();
    conn.end();
    return t;
  }

  const flags = overwrite ? "w" : "a";
  const read: Readable =
    direction === "download"
      ? sftp.createReadStream(remoteFile, { start: startOffset })
      : createReadStream(localFile, { start: startOffset });
  const write: Writable =
    direction === "download"
      ? createWriteStream(localFile, { flags })
      : sftp.createWriteStream(remoteFile, { flags });

  const cleanup = () => {
    read.destroy();
    write.destroy();
    conn.end();
    handles.delete(id);
  };
  handles.set(id, () => {
    read.destroy();
    write.destroy();
    conn.end();
  });

  read.on("data", (chunk: Buffer) => {
    t.transferredBytes += chunk.length;
    t.updatedAt = Date.now();
  });
  const onError = (err: Error) => {
    if (t.state === "running") {
      t.state = "failed";
      t.error = err.message;
      t.updatedAt = Date.now();
    }
    cleanup();
  };
  read.on("error", onError);
  write.on("error", onError);
  write.on("finish", () => {
    if (t.state === "running") {
      t.state = "completed";
      t.transferredBytes = totalBytes;
      t.updatedAt = Date.now();
    }
    cleanup();
  });

  read.pipe(write);
  return t;
}

export function getTransfer(id: string): Transfer | undefined {
  return transfers.get(id);
}

export function listTransfers(): Transfer[] {
  return [...transfers.values()];
}

export function cancelTransfer(id: string): Transfer | undefined {
  const t = transfers.get(id);
  if (!t) return undefined;
  if (t.state === "running") {
    t.state = "cancelled";
    t.updatedAt = Date.now();
    handles.get(id)?.();
    handles.delete(id);
  }
  return t;
}
