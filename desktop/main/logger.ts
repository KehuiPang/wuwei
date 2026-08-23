// 文件日志：写到 ~/.wuwei/logs/minicc.log，方便事后排查(不用瞎猜)。
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), process.env.WUWEI_DATA_DIR_NAME || ".wuwei", "logs");
export const LOG_FILE = join(DIR, "minicc.log");
const MAX_BYTES = 3 * 1024 * 1024; // 超过 3MB 滚动一次

function safe(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function log(tag: string, ...args: unknown[]): void {
  try {
    mkdirSync(DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {
      /* 文件不存在，忽略 */
    }
    const line = `[${new Date().toISOString()}] [${tag}] ${args.map(safe).join(" ")}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}
