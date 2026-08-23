// 无为账号会话持久化（B3：Electron safeStorage/DPAPI 加密落盘）。
// 存 ~/.wuwei/auth.json，自描述格式：
//   - 加密态： {"v":1,"enc":"<base64(safeStorage.encryptString(json))>"}
//   - 明文态： {access_token,refresh_token,expires_at}  ← 旧版(B2)或 safeStorage 不可用时的回退
// 读到明文态且本机可加密 → 自动转存为加密态（B3 兼容迁移，无需重登）。
//
// 跨端取舍（CEO 已定·方案A）：不再追求三端共享 session，各端各自登录。
// 桌面端此文件为 safeStorage 加密态；CLI 端(纯 node 无 safeStorage)若需要登录，自管其明文 token，
// 二者互不读取。登录一次成本低，换来桌面端 token 加密落盘。
import { safeStorage } from "electron";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import type { WuweiSession } from "./wuwei-auth.js";

const DIR = join(homedir(), process.env.WUWEI_DATA_DIR_NAME || ".wuwei");
const FILE = join(DIR, "auth.json");

interface StoredPlain {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}
interface EnvelopeEnc {
  v: 1;
  enc: string; // base64(safeStorage.encryptString(JSON.stringify(StoredPlain)))
}

function toStored(s: WuweiSession): StoredPlain {
  return { access_token: s.accessToken, refresh_token: s.refreshToken, expires_at: Math.floor(s.expiresAt / 1000) };
}
function fromStored(d: StoredPlain): WuweiSession | null {
  if (!d.access_token) return null;
  return { accessToken: d.access_token, refreshToken: d.refresh_token ?? "", expiresAt: (d.expires_at || 0) * 1000 };
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false; // app 未就绪或平台不支持
  }
}

export function saveWuweiSession(s: WuweiSession): void {
  mkdirSync(DIR, { recursive: true });
  const plain = JSON.stringify(toStored(s));
  let out: string;
  if (canEncrypt()) {
    const enc = safeStorage.encryptString(plain).toString("base64");
    const env: EnvelopeEnc = { v: 1, enc };
    out = JSON.stringify(env);
  } else {
    log("wuweiAuth", "safeStorage 不可用，回退明文落盘");
    out = plain;
  }
  writeFileSync(FILE, out, "utf8");
  try {
    chmodSync(FILE, 0o600); // Windows 无效（靠 DPAPI 加密兜底）
  } catch {
    /* ignore */
  }
}

export function loadWuweiSession(): WuweiSession | null {
  try {
    if (!existsSync(FILE)) return null;
    const raw = readFileSync(FILE, "utf8").trim();
    if (!raw || raw === "{}") return null;
    const parsed = JSON.parse(raw) as Partial<EnvelopeEnc & StoredPlain>;

    // 加密态
    if (typeof parsed.enc === "string") {
      if (!canEncrypt()) {
        log("wuweiAuth", "会话为加密态但本机 safeStorage 不可用，无法解密（需重登）");
        return null;
      }
      const json = safeStorage.decryptString(Buffer.from(parsed.enc, "base64"));
      return fromStored(JSON.parse(json) as StoredPlain);
    }

    // 明文态（旧版 B2 或回退）→ 若本机可加密则自动迁移，无需重登
    const sess = fromStored(parsed as StoredPlain);
    if (sess && canEncrypt()) {
      log("wuweiAuth", "检测到旧明文会话，自动转存为加密态");
      saveWuweiSession(sess);
    }
    return sess;
  } catch (e) {
    log("wuweiAuth", "loadWuweiSession 异常", String(e));
    return null;
  }
}

export function clearWuweiSession(): void {
  try {
    if (existsSync(FILE)) writeFileSync(FILE, "{}", "utf8");
  } catch {
    /* ignore */
  }
}
