import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

export interface SecurityConfig {
  /** 用户追加的拦截正则（JSON 字符串形式，需双重转义，如 "rm\\\\s.*-rf?\\\\s+/\\\\*"）。 */
  blocked_patterns?: string[];
}

/** 把开头的 ~ 展开成用户主目录。 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** 配置文件路径：优先环境变量 SSH_MCP_CONFIG，否则取运行目录下的 ./servers.json。 */
export function configPath(): string {
  const fromEnv = process.env.SSH_MCP_CONFIG;
  return fromEnv ? expandHome(fromEnv) : resolve(process.cwd(), "servers.json");
}

function readConfig(): unknown {
  const path = configPath();
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${(e as Error).message}`);
  }
}

/**
 * 每次调用都从磁盘重新读取配置——配置文件就是唯一事实来源。
 * 这样新增服务器后无需重启 MCP 服务器。读取或校验失败时抛错，由调用方处理。
 */
export function loadServers(): Map<string, ServerConfig> {
  const parsed = readConfig();
  const path = configPath();

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

/** 读取安全策略配置（如有）。 */
export function loadSecurity(): SecurityConfig {
  const parsed = readConfig() as { security?: SecurityConfig };
  return parsed.security ?? {};
}

// ---- 命令安全校验 ----

interface BlockRule {
  regex: RegExp;
  desc: string;
}

const BUILTIN_RULES: BlockRule[] = [
  {
    // rm -rf /   rm -rf /*   rm -r -f /   rm -fr /   sudo rm -rf /
    regex: /\brm\b\s+(?:-[a-z]*[rR][^\s]*f[^\s]*|-[a-z]*f[^\s]*[rR][^\s]*|-r\s+-f|-R\s+-f)(?:\s+\S+)*\s+(?:\/\s*\*?\s*$|['"]\/['"]\s*$)/,
    desc: "rm 递归强制删除根目录",
  },
  {
    // dd if=... of=/dev/sda
    regex: /\bdd\b\s+.*\bof=\/dev\/(?:sd|hd|nvme|md|vd|xvd|mmcblk|loop|ram)/,
    desc: "dd 覆盖块设备",
  },
  {
    // mkfs.ext4 /dev/sda1
    regex: /\bmkfs\.\S+\s+\/dev\/(?:sd|hd|nvme|md|vd|xvd|mmcblk|loop)/,
    desc: "在块设备上创建文件系统",
  },
  {
    // > /dev/sda  (redirect overwrite)
    regex: /(?<![|&])\s*>\s*\/dev\/(?:sd|hd|nvme|md|vd|xvd|mmcblk|loop)\b/,
    desc: "重定向覆盖块设备",
  },
  {
    // fork bomb: :(){ :|:& };:
    regex: /:\s*\(\s*\)\s*\{/,
    desc: "疑似 fork 炸弹",
  },
];

/**
 * 校验命令是否命中安全拦截规则。
 * 返回 null 表示通过；返回字符串则为拦截原因。
 */
export function validateCommand(command: string, extraPatterns: string[] = []): string | null {
  for (const { regex, desc } of BUILTIN_RULES) {
    if (regex.test(command)) return `内置策略拦截：${desc}`;
  }
  for (const p of extraPatterns) {
    try {
      if (new RegExp(p).test(command)) return `自定义策略拦截（匹配模式: ${p}）`;
    } catch {
      // 用户提供的正则无效，跳过不报错。
    }
  }
  return null;
}
