// 稳定设备指纹（machine-id）—— 灰度开关 & 免费试用额度的设备级 key
//
// 设计（小笨 CEO 定的口径）：
//   OS 机器 GUID 只当「首次种子」→ sha256 → 固化到 ~/.wuwei/device-id → 之后只读文件。
// 为什么固化到文件：node/OS 读的机器 GUID 在重装系统 / 克隆镜像 / 虚拟机下会变，
// 只有落盘后「一次生成、永远只读」才真稳定。钱包(无为币)与灰度共用这一个 id，别搞两套。
//
// 存储路径 ~/.wuwei/device-id，与鉴权 auth.json 同处（三端共享目录）。

import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const WUWEI_DIR = join(homedir(), process.env.WUWEI_DATA_DIR_NAME || ".wuwei");
const DEVICE_FILE = join(WUWEI_DIR, "device-id");
const PREFIX = "wd_"; // wuwei device
const ID_HEX_LEN = 32;

let cached: string | null = null;

/** 读取 OS 机器 GUID 作为种子；读不到返回 null（调用方退回随机）。 */
function readMachineSeed(): string | null {
  try {
    const os = platform();
    if (os === "win32") {
      // 注册表 MachineGuid（每台 Windows 安装唯一）
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
      return m ? m[1] : null;
    }
    if (os === "darwin") {
      const out = execSync(
        "ioreg -rd1 -c IOPlatformExpertDevice",
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const m = out.match(/IOPlatformUUID"?\s*=\s*"([\w-]+)"/i);
      return m ? m[1] : null;
    }
    // linux / 其它：/etc/machine-id 或 dbus machine-id
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      if (existsSync(p)) {
        const v = readFileSync(p, "utf8").trim();
        if (v) return v;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 生成设备 id：优先 OS 机器 GUID 派生，失败退回随机（都会被固化到文件后只读）。 */
function mint(): string {
  const seed = readMachineSeed();
  const hex = seed
    ? createHash("sha256").update(`wuwei:${seed}`).digest("hex").slice(0, ID_HEX_LEN)
    : randomBytes(ID_HEX_LEN / 2).toString("hex");
  return PREFIX + hex;
}

function isValid(id: string): boolean {
  return typeof id === "string" && id.startsWith(PREFIX) && id.length === PREFIX.length + ID_HEX_LEN;
}

/**
 * 取稳定设备 id：文件已有且合法 → 读文件；否则 mint 一次并固化。
 * 进程内缓存，避免重复读盘。
 */
export function getDeviceId(): string {
  if (cached) return cached;
  try {
    if (existsSync(DEVICE_FILE)) {
      const existing = readFileSync(DEVICE_FILE, "utf8").trim();
      if (isValid(existing)) {
        cached = existing;
        return existing;
      }
    }
  } catch {
    // 读失败则重新生成
  }
  const id = mint();
  try {
    mkdirSync(WUWEI_DIR, { recursive: true });
    writeFileSync(DEVICE_FILE, id, "utf8");
    try {
      chmodSync(DEVICE_FILE, 0o600); // Windows 不支持会静默跳过
    } catch {
      /* ignore */
    }
  } catch {
    // 落盘失败也返回本次生成值，保证可用（下次进程会重试落盘）
  }
  cached = id;
  return id;
}
