import type { Client, SFTPWrapper } from "ssh2";
import { posix } from "node:path";
import { createConnection } from "./ssh.js";
import type { ServerConfig } from "./config.js";

function openSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  atime: number;
  longname: string;
}

export interface FileStat {
  type: "file" | "directory" | "link" | "other";
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  atime: number;
}

function classify(mode: number): FileEntry["type"] {
  const ifmt = mode & 0o170000;
  if (ifmt === 0o040000) return "directory";
  if (ifmt === 0o100000) return "file";
  if (ifmt === 0o120000) return "link";
  return "other";
}

function formatMode(mode: number): string {
  const r = (mode & 0o4) ? "r" : "-";
  const w = (mode & 0o2) ? "w" : "-";
  const x = (mode & 0o1) ? "x" : "-";
  return r + w + x;
}

function formatPerms(mode: number): string {
  const f = classify(mode);
  const c = f === "directory" ? "d" : f === "link" ? "l" : f === "other" ? "?" : "-";
  return c + formatMode(mode >> 6) + formatMode(mode >> 3) + formatMode(mode);
}

export function formatLsLong(e: FileEntry): string {
  return `${formatPerms(e.mode)}  ${String(e.uid).padStart(5)} ${String(e.gid).padStart(5)}  ${String(e.size).padStart(10)}  ${new Date(e.mtime * 1000).toISOString().replace("T", " ").replace(/\..*/, "")}  ${e.name}`;
}

export function formatLsShort(e: FileEntry): string {
  return e.name;
}

export async function listDirectory(cfg: ServerConfig, path: string): Promise<FileEntry[]> {
  const conn = await createConnection(cfg, 20_000);
  try {
    const sftp = await openSftp(conn);
    return new Promise((resolve, reject) => {
      sftp.readdir(path, (err, entries) => {
        conn.end();
        if (err) return reject(err);
        resolve(
          entries.map((e) => ({
            name: e.filename,
            type: classify(e.attrs.mode),
            size: e.attrs.size,
            mode: e.attrs.mode,
            uid: e.attrs.uid,
            gid: e.attrs.gid,
            mtime: e.attrs.mtime,
            atime: e.attrs.atime,
            longname: e.longname,
          })),
        );
      });
    });
  } catch (e) {
    conn.end();
    throw e;
  }
}

export async function statPath(cfg: ServerConfig, path: string): Promise<FileStat> {
  const conn = await createConnection(cfg, 20_000);
  try {
    const sftp = await openSftp(conn);
    return new Promise((resolve, reject) => {
      sftp.stat(path, (err, s) => {
        conn.end();
        if (err) return reject(err);
        resolve({
          type: classify(s.mode),
          size: s.size,
          mode: s.mode,
          uid: s.uid,
          gid: s.gid,
          mtime: s.mtime,
          atime: s.atime,
        });
      });
    });
  } catch (e) {
    conn.end();
    throw e;
  }
}

export async function removePath(cfg: ServerConfig, path: string, recursive: boolean): Promise<void> {
  const conn = await createConnection(cfg, 20_000);
  try {
    const sftp = await openSftp(conn);

    // 先 stat 确定类型
    const s: { type: string } = await new Promise((resolve, reject) => {
      sftp.stat(path, (err, st) => {
        if (err) return reject(err);
        resolve({ type: classify(st.mode) });
      });
    });

    if (s.type === "directory") {
      if (!recursive) throw new Error(`"${path}" 是目录，需要 --recursive 选项`);

      // 递归删除目录内容
      const entries: { filename: string; attrs: { mode: number } }[] = await new Promise((res, rej) => {
        sftp.readdir(path, (err, e) => (err ? rej(err) : res(e)));
      });
      for (const e of entries) {
        if (e.filename === "." || e.filename === "..") continue;
        await removePath(cfg, posix.join(path, e.filename), true);
      }
      await new Promise<void>((res, rej) => {
        sftp.rmdir(path, (err) => (err ? rej(err) : res()));
      });
    } else {
      await new Promise<void>((res, rej) => {
        sftp.unlink(path, (err) => (err ? rej(err) : res()));
      });
    }
    conn.end();
  } catch (e) {
    conn.end();
    throw e;
  }
}

export async function makeDir(cfg: ServerConfig, path: string, parents: boolean): Promise<void> {
  const conn = await createConnection(cfg, 20_000);
  try {
    const sftp = await openSftp(conn);

    if (parents) {
      // 逐层创建
      const parts = path.split("/").filter(Boolean);
      let current = path.startsWith("/") ? "/" : "";
      for (const p of parts) {
        current = current ? posix.join(current, p) : p;
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, { mode: 0o755 }, (err) => {
            // 已存在不算错
            if (err && (err as any).code !== 4) return reject(err);
            resolve();
          });
        });
      }
    } else {
      await new Promise<void>((res, rej) => {
        sftp.mkdir(path, { mode: 0o755 }, (err) => (err ? rej(err) : res()));
      });
    }
    conn.end();
  } catch (e) {
    conn.end();
    throw e;
  }
}
