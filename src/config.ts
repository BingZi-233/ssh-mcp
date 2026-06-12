import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 一台远程服务器的配置。name 是模型用来区分服务器的唯一标识。 */
export interface ServerConfig {
  name: string;
  description?: string;
  host: string;
  port?: number;
  username: string;
  /** 私钥文件路径，支持 ~ 展开。优先级最高。 */
  privateKeyPath?: string;
  /** 私钥的口令（如果私钥被加密）。 */
  passphrase?: string;
  /** 密码登录。仅在未配置私钥时使用。 */
  password?: string;
}

/** 把开头的 ~ 展开成用户主目录。 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** 配置文件路径：优先环境变量 SSH_MCP_CONFIG，否则取 ~/.ssh-mcp/servers.json。 */
export function configPath(): string {
  const fromEnv = process.env.SSH_MCP_CONFIG;
  return fromEnv ? expandHome(fromEnv) : join(homedir(), ".ssh-mcp", "servers.json");
}

/**
 * 每次调用都从磁盘重新读取配置——配置文件就是唯一事实来源。
 * 这样新增服务器后无需重启 MCP 服务器。读取或校验失败时抛错，由调用方处理。
 */
export function loadServers(): Map<string, ServerConfig> {
  const path = configPath();
  const raw = readFileSync(path, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${(e as Error).message}`);
  }

  const list = (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(list)) {
    throw new Error(`配置文件 ${path} 缺少顶层 "servers" 数组`);
  }

  const map = new Map<string, ServerConfig>();
  for (const item of list as ServerConfig[]) {
    if (!item.name || !item.host || !item.username) {
      throw new Error(`配置文件中存在缺少 name/host/username 的服务器条目`);
    }
    if (map.has(item.name)) {
      throw new Error(`配置文件中存在重复的服务器 name："${item.name}"`);
    }
    map.set(item.name, item);
  }
  return map;
}
