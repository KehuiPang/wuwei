// 记住登录账号密码（多账号）：safeStorage/DPAPI 加密落盘 ~/.wuwei/login-remember.json。
// 与登录 token(auth.json) 同级加密保护，不明文存密码。
// 数据形态：
//   加密态 {"v":1,"enc":"<base64(encryptString(json))>"}
//   明文态 {"last":"a@x.com","accounts":[{email,password}]}  (safeStorage 不可用时回退)
// 规则：登录成功 upsert 并置为 last；用户手动清空密码 → 该账号密码清空(账号保留供下拉)。
import { safeStorage } from "electron";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";

const DIR = join(homedir(), process.env.WUWEI_DATA_DIR_NAME || ".wuwei");
const FILE = join(DIR, "login-remember.json");

export interface RememberedAccount {
  email: string;
  password: string; // 可为空串(用户清空过密码)
}
export interface RememberData {
  last?: string; // 最近使用的 email，用于打开时自动填充
  accounts: RememberedAccount[];
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function write(data: RememberData): void {
  try {
    mkdirSync(DIR, { recursive: true });
    const plain = JSON.stringify(data);
    const out = canEncrypt()
      ? JSON.stringify({ v: 1, enc: safeStorage.encryptString(plain).toString("base64") })
      : plain;
    writeFileSync(FILE, out, "utf8");
  } catch (e) {
    log("wuweiRemember", "写入失败", String(e));
  }
}

export function loadRemember(): RememberData {
  try {
    if (!existsSync(FILE)) return { accounts: [] };
    const raw = readFileSync(FILE, "utf8").trim();
    if (!raw || raw === "{}") return { accounts: [] };
    const parsed = JSON.parse(raw) as { v?: number; enc?: string } & Partial<RememberData>;
    if (typeof parsed.enc === "string") {
      if (!canEncrypt()) return { accounts: [] }; // 加密态但本机无法解密
      const json = safeStorage.decryptString(Buffer.from(parsed.enc, "base64"));
      const d = JSON.parse(json) as RememberData;
      return { last: d.last, accounts: Array.isArray(d.accounts) ? d.accounts : [] };
    }
    return { last: parsed.last, accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
  } catch (e) {
    log("wuweiRemember", "读取失败", String(e));
    return { accounts: [] };
  }
}

/** 登录成功：新增/更新该账号密码，并置为最近使用。 */
export function upsertRemember(email: string, password: string): void {
  const e = email.trim();
  if (!e) return;
  const data = loadRemember();
  const idx = data.accounts.findIndex((a) => a.email.toLowerCase() === e.toLowerCase());
  if (idx >= 0) data.accounts[idx].password = password;
  else data.accounts.push({ email: e, password });
  data.last = e;
  write(data);
}

/** 用户手动清空密码：把该账号的记住密码清空（账号仍保留，供下拉选择）。 */
export function clearRememberedPassword(email: string): void {
  const e = email.trim();
  if (!e) return;
  const data = loadRemember();
  const idx = data.accounts.findIndex((a) => a.email.toLowerCase() === e.toLowerCase());
  if (idx >= 0) {
    data.accounts[idx].password = "";
    write(data);
  }
}
