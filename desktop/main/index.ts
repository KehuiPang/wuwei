// Electron 主进程：创建窗口，复用 minicc 核心(agent/tools/config)，
// 通过 IPC 把 Agent 流式 hooks 推给渲染进程，权限确认走 IPC 往返。
import { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, shell, session, clipboard, Menu, safeStorage, Tray, nativeImage } from "electron";
const safeStorageOk = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadConfig } from "../../src/config.js";
import { makeProvider } from "../../src/agent/provider.js";
import { Agent } from "../../src/agent/loop.js";
import { systemPrompt, renderPrompt, DEFAULT_SYSTEM_PROMPT } from "../../src/agent/prompt.js";
import { ALL_TOOLS, TOOL_MAP, MEMORY_FILE } from "../../src/tools/index.js";
import * as brain from "../../src/brain/index.js";
import type { Tool, ToolResult } from "../../src/types.js";
import { connectMcp, mcpTools, mcpToolsBySource, mcpStatus, loadMcpConfig, searchMcpRegistry, MCP_CONFIG_PATH } from "./mcp.js";
import * as secrets from "./secrets.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 全局记忆：读/写 ~/.wuwei/memory.md
function loadMemory(): string {
  try {
    return readFileSync(MEMORY_FILE, "utf8");
  } catch {
    return "";
  }
}
function saveMemory(text: string) {
  mkdirSync(dirname(MEMORY_FILE), { recursive: true });
  writeFileSync(MEMORY_FILE, text, "utf8");
}
import {
  listSessions,
  loadMessages,
  saveSession,
  deleteSession,
  deriveTitle,
  listGroups,
  setSessionGroup,
  setSessionPriority,
  setSessionOrder,
  setSessionProject,
  setGroupsOrder,
  setSessionDone,
} from "./sessions.js";
import {
  loadSettings,
  saveSettings,
  applyEnvFromSettings,
  loadRateLimits,
  saveRateLimits,
  loadWindowBounds,
  saveWindowBounds,
  loadSessionBalances,
  saveSessionBalances,
  migrateFromMinicc,
  type Settings,
  type SessionBal,
} from "./settings.js";

// 数据目录 .minicc→.wuwei 改名后的一次性迁移，须在任何数据读取前执行。
migrateFromMinicc();
import { getAccount, logout } from "./account.js";
import {
  claudeOAuthLogin,
  claudeOAuthOpenBrowser,
  claudeOAuthExchange,
  claudeOAuthRefresh,
  loadClaudeAuth,
} from "./claude-oauth.js";
import { codexOAuthLogin } from "./codex-oauth.js";
import {
  wuweiLogin,
  wuweiRefresh,
  wuweiFetchMe,
  wuweiPasswordLogin,
  wuweiSendCode,
  wuweiCodeLogin,
  wuweiRegister,
  type WuweiSession,
} from "./wuwei-auth.js";
import { saveWuweiSession, loadWuweiSession, clearWuweiSession } from "./wuwei-session.js";
import { getDeviceId } from "../../src/device-id.js";
import { log, LOG_FILE } from "./logger.js";

log("boot", "minicc 主进程启动", "日志文件:", LOG_FILE);
process.on("uncaughtException", (e) => log("uncaught", e?.stack || String(e)));
process.on("unhandledRejection", (e) => log("unhandledRejection", String(e)));

// __dirname 由 electron-vite 为 ESM 输出自动注入，无需手动声明

// 注册自定义 app:// 协议为特权协议（须在 app ready 前）。
// 用它伺服打包后的 renderer，避免 file:// 下 module 脚本被 CORS/CSP 拦导致黑屏。
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

// provider/系统提示全局共享；每个会话一个 Agent（各自 messages）
let provider: ReturnType<typeof makeProvider> | null = null;
let sysPrompt = "";
let agentOpts = { compactThreshold: 60000, keepRecent: 6 };
let backendLabel = "";
let modelLabel = "";
let ctxWindow = 1_000_000; // 当前模型上下文窗口(占用条用真实值)
let subFlag = false; // 当前后端是否订阅类(决定前端是否显示 5小时/周额度)
let cwd = process.cwd();
const agents = new Map<string, Agent>();
let currentId = "";

// 权限往返：id → resolve
const pendingPerm = new Map<number, (d: "allow" | "deny") => void>();
let permSeq = 0;
// 多任务：每个会话各自的中断控制器；keys = 正在运行的会话集(用于任务计数)
const runs = new Map<string, AbortController>();
// 广播当前所有运行中的会话(前端据此显示"N 个任务运行中"+侧栏运行点)
function emitTasks() {
  send("evt:tasks", { running: [...runs.keys()] });
}

function send(channel: string, payload?: unknown) {
  win?.webContents.send(channel, payload);
}

function mimeFor(path: string): string | null {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".woff2")) return "font/woff2";
  return null;
}

// 平台友好名（各兼容端点的 cfg.provider 都是 openai，改用 UI 预设 providerId 显示真实平台）
const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex 订阅",
  "claude-oauth": "Claude 订阅",
  anthropic: "Claude API",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  qwen: "通义千问",
  doubao: "豆包",
  minimax: "MiniMax",
  zhipu: "智谱 GLM",
  kimi: "Kimi",
  hunyuan: "腾讯混元",
  grok: "Grok",
  custom: "自定义端点",
};
function labelFor(cfg: ReturnType<typeof loadConfig>, providerId?: string): string {
  if (providerId && PROVIDER_LABELS[providerId]) return PROVIDER_LABELS[providerId];
  return cfg.provider === "anthropic" ? `anthropic/${cfg.authMode}` : cfg.provider;
}

// 订阅类后端(有 5小时/周额度概念)：Codex / Claude 订阅 / Kimi Code 订阅
function isSub(pid?: string): boolean {
  return pid === "codex" || pid === "claude-oauth" || pid === "kimi-sub";
}

// DeepSeek 提供余额查询 API；用当前 key 拉账户余额(CNY)
async function fetchDeepSeekBalance(
  apiKey: string,
): Promise<{ total: string; currency: string } | null> {
  try {
    const r = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: "Bearer " + apiKey },
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const info = j?.balance_infos?.[0];
    return info ? { total: info.total_balance, currency: info.currency } : null;
  } catch {
    return null;
  }
}

// DeepSeek 官方单价(人民币/百万 token)：缓存命中输入 / 缓存未命中输入 / 输出
// 余额 API 有分钟级延迟且跨会话共享，按 token×单价当场算才准、无延迟(本会话精确)
function dsPrice(model: string): { hit: number; miss: number; out: number } {
  const m = (model || "").toLowerCase();
  if (m.includes("flash")) return { hit: 0.02, miss: 1, out: 2 };
  // deepseek-v4-pro / reasoner / chat 及默认
  return { hit: 0.025, miss: 3, out: 6 };
}
// 用累计用量算本会话消耗(元)；缓存命中/未命中缺失时全算未命中兜底
function dsCost(model: string, u: { totalOutput: number; totalCacheHit: number; totalCacheMiss: number }): number {
  const p = dsPrice(model);
  return (u.totalCacheHit * p.hit + u.totalCacheMiss * p.miss + u.totalOutput * p.out) / 1e6;
}

// 智谱 GLM 官方单价(元/百万 token)：缓存命中 / 未命中输入 / 输出(2026-07 官网)
function glmPrice(model: string): { hit: number; miss: number; out: number } {
  const m = (model || "").toLowerCase();
  if (/flash/.test(m)) return { hit: 0.1, miss: 0.1, out: 0.1 }; // Flash 近免费
  if (/glm-4/.test(m)) return { hit: 0.11, miss: 0.6, out: 2 }; // GLM-4.x 近似
  return { hit: 1.4, miss: 5.6, out: 19.6 }; // glm-5.x(5.2 旗舰) 默认
}
function tokenCost(
  price: { hit: number; miss: number; out: number },
  u: { totalOutput: number; totalCacheHit: number; totalCacheMiss: number },
): number {
  return (u.totalCacheHit * price.hit + u.totalCacheMiss * price.miss + u.totalOutput * price.out) / 1e6;
}

// 每个会话的余额跟踪(持久化)：账户余额展示用；消耗改由 token 计价
const sessionBal: Record<string, SessionBal> = loadSessionBalances();

// 各平台控制台：登录页 + 登录后拿账号信息的内部接口(在已登录页面里同源 fetch，自动带 cookie)
// 接口是自己开浏览器 F12 网络面板扒出来的(别公开 API 就这么找)；其它平台照此法加。
const CONSOLE: Record<string, { login: string; api: string; sniff?: RegExp }> = {
  deepseek: {
    login: "https://platform.deepseek.com/sign_in",
    api: "https://platform.deepseek.com/auth-api/v0/users/current",
  },
  zhipu: {
    // 账号+余额都在这个控制台内部接口(cookie 认证)：data.basicCustomerInfo.{customerName,avatar,balance}
    login: "https://open.bigmodel.cn/login",
    api: "https://bigmodel.cn/api/biz/customer/accountSet",
    sniff: /bigmodel\.cn\/.*(customer|user|account|balance|finance|wallet|overview|profile|current|info)/i,
  },
  // Kimi Code 订阅：额度接口(Connect-RPC POST)与登录页同域(www.kimi.com)→页面内同源 fetch 直接带 cookie
  // 返回 usages[0].detail=周额度、usages[0].limits[](window.duration=300min)=5小时窗口
  "kimi-sub": {
    login: "https://www.kimi.com/code",
    api: "https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages",
    sniff: /kimi\.com\/apiv2\/.*(Usage|Subscription|Billing|Quota)/i,
  },
};

// 把 GetUsages 返回体解析成统一的 rateLimits(5小时=primary / 周=secondary)
// 结构：{usages:[{detail:{limit,used,remaining,resetTime}, limits:[{detail,window:{duration,timeUnit}}]}]}
function parseKimiUsage(j: any): {
  rateLimits?: ReturnType<typeof loadRateLimits>;
  ok: boolean;
} {
  try {
    const u0 = j?.usages?.[0];
    if (!u0) return { ok: false };
    const pct = (d: any) => {
      const lim = Number(d?.limit),
        used = Number(d?.used);
      if (!Number.isFinite(lim) || lim <= 0 || !Number.isFinite(used)) return undefined;
      return Math.min(100, Math.round((used / lim) * 100));
    };
    const resetSecs = (iso?: string) => {
      if (!iso) return undefined;
      const t = Date.parse(iso);
      return Number.isNaN(t) ? undefined : Math.max(0, Math.round((t - Date.now()) / 1000));
    };
    // 周额度：外层 detail
    const week = u0.detail;
    // 5小时窗口：limits[] 里找 window.duration≈300min（TIME_UNIT_MINUTE）
    const mins = (w: any) =>
      w?.timeUnit === "TIME_UNIT_MINUTE" ? Number(w?.duration) : Number(w?.duration) / 60;
    const fiveH =
      (u0.limits || [])
        .map((l: any) => ({ l, m: mins(l.window) }))
        .sort((a: any, b: any) => Math.abs(a.m - 300) - Math.abs(b.m - 300))[0]?.l || null;
    const rl: any = {
      primaryUsedPercent: fiveH ? pct(fiveH.detail) : undefined,
      primaryWindowMinutes: 300,
      primaryResetAfterSeconds: fiveH ? resetSecs(fiveH.detail?.resetTime) : undefined,
      secondaryUsedPercent: week ? pct(week) : undefined,
      secondaryWindowMinutes: 7 * 24 * 60,
      secondaryResetAfterSeconds: week ? resetSecs(week.resetTime) : undefined,
    };
    if (rl.primaryUsedPercent == null && rl.secondaryUsedPercent == null) return { ok: false };
    return { rateLimits: rl, ok: true };
  } catch {
    return { ok: false };
  }
}

// 主进程静默拉 Kimi Code 额度：分区 cookie + 已存 webToken(Bearer) POST GetUsages
// token 存在 creds["kimi-sub"].webToken；同域 cookie 一般已够，Bearer 作兜底
async function kimiUsage(): Promise<
  { rateLimits?: ReturnType<typeof loadRateLimits>; expired?: boolean } | null
> {
  const cfg = CONSOLE["kimi-sub"];
  try {
    const ses = session.fromPartition("persist:login-kimi-sub");
    const cookies = await ses.cookies.get({ url: "https://www.kimi.com" });
    if (!cookies.length) return null; // 从没登录过
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const st = loadSettings();
    const slot = st?.creds?.["kimi-sub"];
    const extra = slot?.webHeaders || {}; // 登录时抓到的整套头(Authorization + x-msh-*)
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cookieHeader,
      ...extra,
    };
    if (!headers.Authorization && !headers.authorization && slot?.webToken)
      headers.Authorization = "Bearer " + slot.webToken;
    if (!headers.Authorization && !headers.authorization) {
      log("kimiUsage", "无鉴权头(未浏览器登录过)");
      return null;
    }
    // 请求体必须带 scope(repeated,≥1项)，否则 400 invalid_argument
    const r = await fetch(cfg.api, { method: "POST", headers, body: JSON.stringify({ scope: ["FEATURE_CODING"] }) });
    const j: any = await r.json().catch(() => null);
    const parsed = parseKimiUsage(j);
    if (!parsed.ok) {
      log("kimiUsage", "未取到额度 status=", r.status, "body=", JSON.stringify(j).slice(0, 160), "hasCookie=", !!cookieHeader, "hasAuth=", !!(headers.Authorization || headers.authorization));
      if (r.status === 401 || r.status === 403) return { expired: true };
      return null;
    }
    log(
      "kimiUsage",
      "5h=", parsed.rateLimits?.primaryUsedPercent, "% 周=", parsed.rateLimits?.secondaryUsedPercent, "%",
    );
    return { rateLimits: parsed.rateLimits };
  } catch (e) {
    log("kimiUsage", "出错", String(e));
    return null;
  }
}
// 从接口返回的 JSON 里深度搜索账号资料(不管包了几层 data/biz_data)：找同时有 名字+头像 的对象
function pickProfile(j: any): { name?: string; avatar?: string } | null {
  const nameKeys = ["name", "nickname", "username", "display_name", "customerName"];
  const avKeys = ["picture", "avatar", "avatar_url", "headimgurl", "head_img", "photo"];
  let best: { name?: string; avatar?: string } | null = null;
  const visit = (o: any, depth: number): boolean => {
    if (!o || typeof o !== "object" || depth > 7) return false;
    const name = nameKeys.map((k) => o[k]).find((v) => typeof v === "string" && v.trim());
    const avatar = avKeys.map((k) => o[k]).find((v) => typeof v === "string" && /^https?:/.test(v));
    if (name && avatar) {
      best = { name, avatar };
      return true; // 最理想：名字+头像齐全(即 id_profile)，直接命中
    }
    if ((name || avatar) && !best) best = { name: name || undefined, avatar: avatar || undefined };
    for (const v of Object.values(o)) if (visit(v, depth + 1)) return true;
    return false;
  };
  visit(j, 0);
  return best;
}

// 读 ~/.claude.json 的 oauthAccount(明文)：用户名/邮箱/套餐，零风险、总是最新(Claude Code 自动维护)
function readClaudeAccount(): { displayName?: string; email?: string; plan?: string } | null {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const oa = d.oauthAccount;
    if (!oa) return null;
    const ot = String(oa.organizationType || "");
    const tier = String(oa.organizationRateLimitTier || "");
    let plan: string | undefined;
    if (/max/i.test(ot)) {
      const m = tier.match(/(\d+)x/i);
      plan = m ? `Max ${m[1]}x` : "Max";
    } else if (/pro/i.test(ot)) plan = "Pro";
    else if (/team/i.test(ot)) plan = "Team";
    else if (/free/i.test(ot)) plan = "Free";
    return { displayName: oa.displayName, email: oa.emailAddress, plan };
  } catch {
    return null;
  }
}

// 智谱：用登录分区的 cookie 拉 accountSet 接口，取昵称/头像/余额(元)
// JWT 来源优先级：cookie 里的 token 项 > 已存的 webToken(creds.zhipu.webToken)
// 取到 JWT 后同步存回 webToken，保证 cookie 过期后仍可用 webToken 静默拉余额
async function zhipuAccount(): Promise<{ name?: string; avatar?: string; balance?: number; expired?: boolean } | null> {
  const cfg = CONSOLE.zhipu;
  try {
    const ses = session.fromPartition("persist:login-zhipu");
    const cookies = await ses.cookies.get({ url: "https://bigmodel.cn" });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    // JWT 来源1：cookie 的 *token* 项(eyJ 开头)
    const tokCookie = cookies.find((c) => /token/i.test(c.name) && c.value.startsWith("eyJ"));
    // JWT 来源2：已存的 webToken(cookie 过期时的兜底)
    const st = loadSettings();
    const savedToken = st?.creds?.zhipu?.webToken;
    const jwt = tokCookie?.value || savedToken;
    if (!jwt) {
      log("zhipuAccount", "无 JWT 可用(cookie 无 token, webToken 也无)");
      return null;
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cookieHeader) headers.Cookie = cookieHeader;
    headers.Authorization = "Bearer " + jwt;
    const r = await fetch(cfg.api, { headers });
    const j: any = await r.json().catch(() => null);
    const bi = j?.data?.basicCustomerInfo;
    if (!bi) {
      log("zhipuAccount", "未取到 basicCustomerInfo status=", r.status, "code=", j?.code, j?.msg || "", "src=", tokCookie ? "cookie" : "webToken");
      // 如果是 webToken 也失效了，标记 expired 让调用方知道要重新登录
      if (!tokCookie && savedToken) return { expired: true };
      return null;
    }
    // cookie 里有新 JWT 就存回 webToken，保证下次 cookie 过期仍可用
    if (tokCookie && tokCookie.value !== savedToken) {
      const s2 = loadSettings();
      if (s2) {
        const c = { ...(s2.creds || {}) };
        c.zhipu = { ...(c.zhipu || {}), webToken: tokCookie.value };
        saveSettings({ ...s2, creds: c });
        log("zhipuAccount", "已更新 webToken(cookie→creds)");
      }
    }
    return {
      name: typeof bi.customerName === "string" ? bi.customerName : undefined,
      avatar: bi.avatar || undefined,
      balance: typeof bi.balance === "number" ? bi.balance : undefined,
    };
  } catch (e) {
    log("zhipuAccount", "出错", String(e));
    return null;
  }
}

async function webLogin(pid: string): Promise<{ name?: string; avatar?: string; token?: string } | null> {
  const cfg = CONSOLE[pid];
  log("webLogin", "开始", pid, cfg ? "登录页=" + cfg.login : "无该平台配置");
  if (!cfg) return null;
  const w = new BrowserWindow({
    width: 480,
    height: 700,
    title: "登录获取账号信息",
    webPreferences: { partition: "persist:login-" + pid },
  });
  w.webContents.on("did-navigate", (_e, url) => log("webLogin", "导航到", url));
  // 网络嗅探：把控制台发出的账号/余额相关内部接口 URL 记到日志(用于发现真实接口)
  if (cfg.sniff) {
    try {
      const ses = session.fromPartition("persist:login-" + pid);
      ses.webRequest.onCompleted((details) => {
        if (cfg.sniff!.test(details.url))
          log("sniff", pid, details.method, details.statusCode, details.url.split("?")[0]);
      });
      // 抓页面真实请求头：命中额度接口且带 Authorization 时，捕获整套鉴权头存进 creds，
      // 供主进程静默刷新时原样重放(Kimi 需 Bearer JWT + x-msh-* 一整套，缺一即 401)
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        if (cfg.sniff!.test(details.url)) {
          const h = details.requestHeaders || {};
          const auth = h["authorization"] || h["Authorization"];
          if (pid === "kimi-sub" && auth && /GetUsages/i.test(details.url)) {
            const want = ["x-msh-platform", "x-msh-device-id", "x-msh-version", "x-language", "x-msh-session-id", "x-traffic-id"];
            const captured: Record<string, string> = { Authorization: auth };
            for (const k of Object.keys(h)) if (want.includes(k.toLowerCase())) captured[k] = h[k];
            const s = loadSettings();
            if (s) {
              const c = { ...(s.creds || {}) };
              c["kimi-sub"] = { ...(c["kimi-sub"] || {}), webToken: auth.replace(/^Bearer\s+/i, ""), webHeaders: captured };
              saveSettings({ ...s, creds: c });
              log("sniff-hdr", pid, "✓ 捕获额度鉴权头", "keys=", Object.keys(captured).join(","));
            }
          }
        }
        cb({ requestHeaders: details.requestHeaders });
      });
    } catch (e) {
      log("webLogin", "sniff 挂载失败", String(e));
    }
  }
  w.loadURL(cfg.login).catch((e) => log("webLogin", "loadURL 失败", String(e)));

  // 从 localStorage 收集候选 token(userToken 等键里的长字符串)，逐个当 Bearer 试；带 X-Client 头
  const probeJs = `(async () => {
    const API = ${JSON.stringify(cfg.api)};
    const out = { tries: [] };
    const cands = [];
    const push = (v) => { if (typeof v === 'string' && v.length >= 20 && !cands.includes(v)) cands.push(v); };
    const walk = (v) => { if (typeof v === 'string') push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    try {
      for (let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i); const raw = localStorage.getItem(k) || '';
        if (!/token/i.test(k)) continue;
        try { walk(JSON.parse(raw)); } catch(e){ push(raw.replace(/^"|"$/g,'')); }
      }
    } catch(e){ out.lsErr = String(e); }
    out.candN = cands.length;
    const base = { 'Accept':'application/json', 'X-Client-Platform':'web', 'X-Client-Bundle-Id':'com.deepseek.chat', 'X-Client-Locale':'zh_CN' };
    const call = async (label, extra) => {
      try { const r = await fetch(API, { credentials:'include', headers: Object.assign({}, base, extra) }); let j=null; try{ j=await r.json(); }catch(e){}
        const d = j && j.data && typeof j.data === 'object' ? j.data : null;
        return { label, status:r.status, code:j&&j.code, msg:j&&j.msg, dataNull: !d, dataKeys: d?Object.keys(d):null, json:j };
      } catch(e){ return { label, error:String(e) }; }
    };
    for (let i=0;i<cands.length;i++){
      const t = await call('bearer#'+i+'('+cands[i].slice(0,8)+'…)', { 'Authorization':'Bearer '+cands[i] });
      if (!t.dataNull) t.tok = cands[i]; // 命中的 token 带回主进程存起来(供以后静默刷新)
      out.tries.push(t);
      if (!t.dataNull) break; // 找到能出 data 的就停
    }
    if (!cands.length) out.tries.push(await call('cookie', {}));
    return out;
  })()`;

  return await new Promise((resolve) => {
    let done = false;
    let tries = 0;
    const finish = (v: { name?: string; avatar?: string; token?: string } | null) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(killer);
      log("webLogin", "结束 结果=", v ? { name: v.name, hasAvatar: !!v.avatar } : "null");
      if (!w.isDestroyed()) w.close();
      resolve(v);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) return finish(null);
      if (w.webContents.isLoading()) return; // 页面加载中，等一轮
      tries++;
      // 智谱：accountSet 在 bigmodel.cn 域，页面上下文跨域会被 CORS 挡；改主进程用分区 cookie 拉
      if (pid === "zhipu") {
        const a = await zhipuAccount();
        if (a && (a.name || a.balance != null)) {
          log("webLogin", "✓ 抓到账号(zhipu cookie)", { name: a.name, balance: a.balance });
          // zhipuAccount 已把 JWT 存回 webToken，这里把 token 带回让 IPC handler 也存
          const s = loadSettings();
          const tok = s?.creds?.zhipu?.webToken;
          return finish({ name: a.name, avatar: a.avatar, token: tok });
        }
        if (tries % 8 === 0) log("webLogin", "zhipu 仍未取到(等登录 cookie)");
        return;
      }
      // Kimi Code 订阅：额度接口鉴权=Bearer JWT + 一整套 x-msh-* 头(在 SPA 内存里，localStorage 探测拿不全)。
      // 靠 onBeforeSendHeaders 捕获页面真实请求头存进 creds；这里等捕获到后用主进程 kimiUsage() 验证，成功即收工。
      if (pid === "kimi-sub") {
        const captured = !!loadSettings()?.creds?.["kimi-sub"]?.webHeaders?.Authorization;
        if (captured) {
          const u = await kimiUsage();
          if (u?.rateLimits) {
            log("webLogin", "✓ Kimi 额度打通(重放捕获头)", "5h=", u.rateLimits.primaryUsedPercent, "周=", u.rateLimits.secondaryUsedPercent);
            const tok = loadSettings()?.creds?.["kimi-sub"]?.webToken;
            return finish({ name: undefined, avatar: undefined, token: tok });
          }
          if (tries % 8 === 0) log("webLogin", "kimi 已捕获头但验证未通过，等页面刷新额度…");
        } else if (tries % 8 === 0) {
          log("webLogin", "kimi 等待登录/额度接口触发(捕获鉴权头中)…");
        }
        return;
      }
      try {
        const out: any = await w.webContents.executeJavaScript(probeJs, true);
        // 首轮记一次概况；之后只在成功/异常时记，避免刷屏
        if (tries === 1) log("webLogin", "探测中 候选token数=", out?.candN, out?.lsErr ? "lsErr=" + out.lsErr : "");
        for (const t of out?.tries || []) {
          if (t.error) {
            if (tries % 6 === 0) log("webLogin", "尝试出错", t.label, t.error);
            continue;
          }
          if (!t.dataNull && t.json) {
            const info = pickProfile(t.json);
            if (info) {
              log("webLogin", "✓ 抓到账号", { name: info.name, hasAvatar: !!info.avatar }, "via", t.label);
              return finish({ ...info, token: t.tok });
            }
          } else if (tries % 8 === 0) {
            log("webLogin", "仍未取到(等登录/token)", t.label, "code=", t.code, t.msg || "");
          }
        }
      } catch (e) {
        if (tries % 8 === 0) log("webLogin", "executeJavaScript 出错=", String(e));
      }
    }, 1500);
    w.on("closed", () => {
      log("webLogin", "窗口被关闭");
      finish(null);
    });
    const killer = setTimeout(() => {
      log("webLogin", "3 分钟超时兜底");
      finish(null);
    }, 180000);
  });
}

// 头像 URL → data: URI(CSP 只放行 self/data:，外链 img 加载不了)
async function toDataUri(url?: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const r = await fetch(url);
    if (!r.ok) return undefined;
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = r.headers.get("content-type") || "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

// 用已存的 webToken + 分区 cookie 静默拉账号信息(不弹窗)；token 过期返回 "expired"
async function webAccountRefresh(
  pid: string,
): Promise<{ name?: string; avatar?: string } | "expired" | null> {
  const cfg = CONSOLE[pid];
  const s = loadSettings();
  const token = s?.creds?.[pid]?.webToken;
  if (!cfg || !token) return null;
  try {
    const ses = session.fromPartition("persist:login-" + pid);
    const cookies = await ses.cookies.get({ url: new URL(cfg.api).origin });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const r = await fetch(cfg.api, {
      headers: {
        Authorization: "Bearer " + token,
        Cookie: cookieHeader,
        Accept: "application/json",
        "X-Client-Platform": "web",
        "X-Client-Bundle-Id": "com.deepseek.chat",
        "X-Client-Locale": "zh_CN",
      },
    });
    const j: any = await r.json().catch(() => null);
    const codes = [j?.code, j?.data?.code, j?.data?.biz_code];
    if (codes.includes(40003) || codes.includes(40002)) {
      log("webRefresh", pid, "token 已过期/失效");
      return "expired";
    }
    const info = pickProfile(j);
    log("webRefresh", pid, info ? "静默刷新成功 " + info.name : "未取到 profile");
    return info;
  } catch (e) {
    log("webRefresh", pid, "出错", String(e));
    return null;
  }
}

// 用存好的 token 后台静默刷新账号(不弹窗)；有变化就落盘+重发
async function silentRefreshAccount(pid: string) {
  if (pid === "kimi-sub") return; // kimi 额度是 POST 接口，由 emitAccount 的 kimiUsage() 处理，不走 GET profile
  const res = await webAccountRefresh(pid);
  if (!res || res === "expired") return; // 无 token/过期：保留已缓存的头像昵称
  const s = loadSettings();
  if (!s) return;
  const c = { ...(s.creds || {}) };
  const avatar = (await toDataUri(res.avatar)) || c[pid]?.avatar;
  c[pid] = { ...(c[pid] || {}), nickname: res.name || c[pid]?.nickname, avatar };
  saveSettings({ ...s, creds: c });
  void emitAccount();
}

// 账号信息随当前平台变化：Codex→ChatGPT邮箱；DeepSeek→余额；其它→是否填了key
// 当前平台 id（用于按平台读写订阅额度快照，避免串台）
function curProviderId(): string {
  const st = loadSettings();
  return st?.providerId || (loadConfig().provider === "codex" ? "codex" : "");
}
async function emitAccount() {
  const st = loadSettings();
  const pid = st?.providerId || (loadConfig().provider === "codex" ? "codex" : "");
  const nickname = st?.creds?.[pid]?.nickname || undefined;
  const avatar = st?.creds?.[pid]?.avatar || undefined;
  log("emitAccount", "平台=", pid, "昵称=", nickname || "无", "头像=", avatar ? "有" : "无");
  if (pid === "codex" || (!pid && !st)) {
    const a = getAccount();
    send("evt:account", {
      providerId: "codex",
      label: "Codex 订阅",
      loggedIn: a.loggedIn,
      email: a.email,
      nickname,
      avatar,
    });
    const rl = loadRateLimits("codex"); // 上次的 Codex 订阅额度快照，切过来即显示（检测/发消息再刷新）
    if (rl) send("evt:ratelimits", rl);
    return;
  }
  if (pid === "claude-oauth") {
    const loggedIn = !!st?.oauthToken;
    // 账号来自 ~/.claude.json 的 oauthAccount(明文,Claude Code 自维护)：用户名/邮箱/套餐，零风险、总最新
    // (Claude 账号没有头像图，桌面版也是显示首字母，故 avatar 用默认首字母即可)
    const acct = readClaudeAccount();
    const nick = acct?.displayName || acct?.email || nickname;
    const plan = acct?.plan;
    log("claudeAcct", "用户=", nick || "无", "套餐=", plan || "无", "(来源 ~/.claude.json)");
    send("evt:account", {
      providerId: pid,
      label: plan ? `Claude 订阅 · ${plan}` : "Claude 订阅",
      loggedIn,
      email: acct?.email || null,
      nickname: nick,
      avatar,
    });
    if (plan) {
      const rl = loadRateLimits(pid) || {};
      send("evt:ratelimits", { ...rl, planType: plan }); // 套餐显示在订阅额度面板
    }
    return;
  }
  if (pid === "kimi-sub") {
    const loggedIn = !!st?.apiKey; // 订阅 key 决定能否对话
    // 额度走 www.kimi.com 网页会话(浏览器登录后 cookie/webToken)，与订阅 key 相互独立
    const u = await kimiUsage();
    const expired = u?.expired;
    send("evt:account", {
      providerId: pid,
      label: expired ? "Kimi Code 订阅 · 额度登录已过期" : "Kimi Code 订阅",
      loggedIn,
      email: null,
      nickname,
      avatar,
      expired,
    });
    if (u?.rateLimits) {
      saveRateLimits(pid, u.rateLimits); // 记住，下次打开直接显示
      send("evt:ratelimits", u.rateLimits);
    }
    return;
  }
  if (pid === "zhipu") {
    const loggedIn = !!st?.apiKey;
    // 本会话消耗按 token×GLM 单价当场算(智谱无公开余额 API，余额待扒控制台接口)
    const u = agents.get(currentId)?.getUsage();
    const model = loadConfig().model;
    const consumed = u
      ? tokenCost(glmPrice(model), {
          totalOutput: u.totalOutput,
          totalCacheHit: u.totalCacheHit ?? 0,
          totalCacheMiss: u.totalCacheMiss ?? Math.max(0, u.totalInput - (u.totalCacheHit ?? 0)),
        })
      : 0;
    // cookie + webToken 拉账号+余额；zhipuAccount 会自动把新 JWT 存回 webToken
    const acct = await zhipuAccount();
    let nick = nickname;
    let av = avatar;
    if (acct?.name || acct?.avatar) {
      nick = acct.name || nickname;
      av = (await toDataUri(acct.avatar)) || avatar;
      const s2 = loadSettings();
      if (s2) {
        const c = { ...(s2.creds || {}) };
        c[pid] = { ...(c[pid] || {}), nickname: acct.name || c[pid]?.nickname };
        saveSettings({ ...s2, creds: c });
      }
    }
    const total = acct?.balance;
    const expired = acct?.expired;
    log(
      "balance",
      "sid=", currentId.slice(0, 8),
      "zhipu model=", model,
      "余额=", total != null ? total.toFixed(4) : "无",
      "expired=", expired || false,
      "本会话已消耗=", consumed.toFixed(4),
    );
    send("evt:account", {
      providerId: pid,
      label: expired ? "智谱 GLM · 登录已过期" : "智谱 GLM",
      loggedIn,
      email: null,
      nickname: nick,
      avatar: av,
      balance: {
        currency: "CNY",
        consumed: consumed.toFixed(2),
        total: total != null ? total.toFixed(2) : undefined,
      },
      expired,
    });
    // token 过期时清掉失效的 webToken，避免反复用过期的 token 重试
    if (expired) {
      const s2 = loadSettings();
      if (s2?.creds?.zhipu?.webToken) {
        const c = { ...(s2.creds || {}) };
        c.zhipu = { ...(c.zhipu || {}), webToken: undefined };
        saveSettings({ ...s2, creds: c });
        log("zhipuAccount", "已清除失效的 webToken");
      }
    }
    return;
  }
  if (pid === "deepseek") {
    const loggedIn = !!st?.apiKey;
    send("evt:account", { providerId: pid, label: "DeepSeek", loggedIn, email: null, nickname, avatar });
    if (!loggedIn) return;
    const bal = await fetchDeepSeekBalance(st!.apiKey!);
    if (!bal) return;
    // 本会话消耗 = 累计 token × 官方单价(当场算，无余额延迟、跨会话不错配)
    const u = agents.get(currentId)?.getUsage();
    const model = loadConfig().model;
    const consumed = u
      ? dsCost(model, {
          totalOutput: u.totalOutput,
          totalCacheHit: u.totalCacheHit ?? 0,
          totalCacheMiss: u.totalCacheMiss ?? Math.max(0, u.totalInput - (u.totalCacheHit ?? 0)),
        })
      : 0;
    log(
      "balance",
      "sid=", currentId.slice(0, 8),
      "model=", model,
      "余额=", bal.total,
      "hit/miss/out=", `${u?.totalCacheHit ?? 0}/${u?.totalCacheMiss ?? 0}/${u?.totalOutput ?? 0}`,
      "本会话已消耗=", consumed.toFixed(4),
    );
    send("evt:account", {
      providerId: pid,
      label: "DeepSeek",
      loggedIn,
      email: null,
      nickname,
      avatar,
      balance: { total: bal.total, currency: bal.currency, consumed: consumed.toFixed(2) },
    });
    return;
  }
  send("evt:account", {
    providerId: pid,
    label: labelFor(loadConfig(), pid),
    loggedIn: !!st?.apiKey,
    email: null,
    nickname,
    avatar,
  });
}

// 构造系统提示词：优先本平台专属覆盖(creds[pid].systemPrompt)，再全局(settings.systemPrompt)，都没有=默认模板；渲染 {model}/{cwd}
function buildSysPrompt(cwd: string, model: string, providerId?: string): string {
  const st = loadSettings();
  const override = providerId ? st?.creds?.[providerId]?.systemPrompt : undefined;
  const custom = typeof override === "string" ? override : st?.systemPrompt;
  let base = typeof custom === "string" ? renderPrompt(custom, cwd, model) : systemPrompt(cwd, model);
  // 记忆：始终告知可用 remember 工具，并附上已记住的内容(跨会话)
  const mem = loadMemory().trim();
  base +=
    `\n\n## 长期记忆\n用户说“记住…/以后…/我喜欢…”或出现值得长期保留的信息(偏好、称呼、事实、项目背景)时，调用 remember 工具写入；它会在之后每次对话自动加载。`;
  if (mem) base += `\n\n已记住（需主动遵守/参考）：\n${mem}`;
  // 本地知识网络（Brain）：概念化的项目/部署知识，按需 recall，不再全量注入
  base +=
    `\n\n## 本地知识网络（Brain）\n你有一个本地概念知识网络，沉淀着项目/服务器/脚本/部署/注意事项等结构化知识。\n- 涉及具体项目或部署/环境的任务，**开工前先用 brain_recall 检索**，按返回的结构化子图行动，别每次全量翻文档、省 token。\n- 发现值得长期固化的高价值知识（项目背景、git路径、测试/线上环境、部署脚本位置、踩坑注意事项）时，用 brain_learn 记住、brain_link 串联关系；旧信息有误就用同名 brain_learn 覆盖纠正。\n- brain_recall 还会命中知识宫殿等文档库的原文片段（『相关文档』），只给摘要+路径；需要完整内容时用 brain_read_doc 按该路径读全文，不必全量翻。`;
  try {
    const idx = brain.conceptIndex(40);
    if (idx.length) base += `\n已沉淀的概念（可 brain_recall 展开）：${idx.join("、")}`;
  } catch {
    /* brain 不可用不影响主流程 */
  }
  base += secrets.SECRETS_SYSTEM_NOTE; // 告知模型：密钥走本地保险箱/环境变量，无需明文
  return base;
}

function initProvider() {
  cwd = process.cwd();
  const st = loadSettings();
  applyEnvFromSettings(st); // 有已保存设置则据此，否则自动推断
  const cfg = loadConfig();
  provider = makeProvider(cfg);
  modelLabel = cfg.model;
  ctxWindow = cfg.contextWindow;
  sysPrompt = buildSysPrompt(cwd, modelLabel, st?.providerId);
  agentOpts = {
    compactThreshold: cfg.compactThreshold,
    keepRecent: st?.keepRecent && st.keepRecent > 0 ? st.keepRecent : cfg.keepRecentTurns,
  };
  backendLabel = labelFor(cfg, st?.providerId);
  subFlag = isSub(st?.providerId) || (!st && cfg.provider === "codex");
}

// 运行时切换模型后端：保存设置、重建 provider、更新所有会话 Agent
function applySettings(s: Settings) {
  log("applySettings", "平台=", s.providerId, "模型=", s.model, "有key=", !!s.apiKey);
  saveSettings(s);
  applyEnvFromSettings(s);
  const cfg = loadConfig();
  provider = makeProvider(cfg);
  backendLabel = labelFor(cfg, s.providerId);
  modelLabel = cfg.model;
  ctxWindow = cfg.contextWindow;
  subFlag = isSub(s.providerId);
  sysPrompt = buildSysPrompt(cwd, modelLabel, s.providerId); // 底层模型/自定义提示词变了都同步
  for (const a of agents.values()) {
    a.setProvider(provider);
    a.setSystem(sysPrompt); // 热更每个会话的系统提示，问"你是什么模型"能答对
  }
  send("evt:ready", { backend: backendLabel, model: modelLabel, cwd, sub: subFlag, ctxWindow });
  void emitAccount(); // 切平台后左下角账号/余额随之更新
  if (s.providerId) void silentRefreshAccount(s.providerId); // 用存的 token 静默刷新，无需重登
}

// Claude 订阅 OAuth：token 快过期时用 refresh_token 静默续期，避免请求报 401「token expired/invalid」。
// 只动 app 自己的 token(settings.oauthToken + sidecar 文件)，绝不碰 ~/.claude.json（避免搞挂 Claude Code 登录）。
// 老用户(有 oauthToken 但无 sidecar/refresh) → 不动，手动重登一次后即自动续期。
let refreshingClaude: Promise<void> | null = null;
async function ensureFreshClaudeOAuth(): Promise<void> {
  const st = loadSettings();
  if (!st || st.kind !== "anthropic-oauth") return;
  const auth = loadClaudeAuth();
  if (!auth?.refreshToken || !auth.expiresAt) return; // 无 refresh/过期信息 → 交给手动重登
  if (auth.expiresAt - Date.now() > 5 * 60 * 1000) return; // 还有 >5 分钟 → 无需续期
  if (refreshingClaude) return refreshingClaude; // 合并并发，避免同一时刻多次刷新
  refreshingClaude = (async () => {
    try {
      log("claudeOAuth", "token 将过期，静默续期…");
      const r = await claudeOAuthRefresh(auth.refreshToken!); // 内部已把新值写回 sidecar
      if (!r?.token) {
        log("claudeOAuth", "续期失败，保留旧 token（可能需手动重登）");
        return;
      }
      const s = loadSettings();
      if (!s) return;
      s.oauthToken = r.token;
      if (s.creds?.["claude-oauth"]) s.creds["claude-oauth"].oauthToken = r.token;
      saveSettings(s);
      applyEnvFromSettings(s);
      provider = makeProvider(loadConfig());
      for (const a of agents.values()) a.setProvider(provider); // 热更所有会话，用新 token
      log("claudeOAuth", "✓ 已续期并热更 provider");
    } finally {
      refreshingClaude = null;
    }
  })();
  return refreshingClaude;
}

// —— 浏览器控制：Electron 内置 Chromium 的 WebContentsView，可嵌入主窗口面板"可视化" AI 操作 ——
let browserView: WebContentsView | null = null;
let browserAttached = false;
function emitBrowser() {
  if (!browserView || browserView.webContents.isDestroyed()) return;
  const wc = browserView.webContents;
  send("evt:browser", {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  });
}
function getBrowserView(): WebContentsView {
  if (browserView && !browserView.webContents.isDestroyed()) return browserView;
  browserView = new WebContentsView({ webPreferences: { partition: "persist:agent-browser" } }); // cookie 持久
  const wc = browserView.webContents;
  for (const ev of [
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
    "did-start-loading",
    "did-stop-loading",
  ] as const) {
    wc.on(ev as any, () => emitBrowser());
  }
  return browserView;
}
function browserExec(js: string): Promise<unknown> {
  return getBrowserView().webContents.executeJavaScript(js, true);
}
// 让前端把浏览器面板打开(AI 一开网页你就能看到它在干嘛)
function requestShowBrowser() {
  send("evt:browser-activity");
}
const browserOpenTool: Tool = {
  name: "browser_open",
  description:
    "用内置浏览器打开一个网页 URL（能执行 JS，比 web_fetch 更适合动态/需交互页面）。打开后可用 browser_read 读正文、browser_click 点击元素。",
  readOnly: true,
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  async run(input): Promise<ToolResult> {
    try {
      const url = String(input.url || "");
      if (!/^https?:\/\//i.test(url)) return { content: "URL 需以 http/https 开头", isError: true };
      const wc = getBrowserView().webContents;
      requestShowBrowser(); // 让前端弹出浏览器面板，用户可实时看
      try {
        await wc.loadURL(url);
      } catch (e: any) {
        // 部分重定向会抛 ERR_ABORTED 但页面其实已加载→已导航就当成功
        if (!wc.getURL() || wc.getURL() === "about:blank") throw e;
      }
      return {
        content: `已打开：${wc.getTitle()}（${wc.getURL()}）。可用 browser_read 读正文、browser_click 点击。`,
      };
    } catch (e: any) {
      return { content: `打开失败: ${e.message}`, isError: true };
    }
  },
};
const browserReadTool: Tool = {
  name: "browser_read",
  description: "读取内置浏览器当前页面的可见正文文本（需先 browser_open）。",
  readOnly: true,
  inputSchema: { type: "object", properties: {} },
  async run(): Promise<ToolResult> {
    try {
      const text = String((await browserExec("document.body ? document.body.innerText : ''")) || "");
      const max = 12000;
      const t = text.trim();
      return { content: (t.length > max ? t.slice(0, max) + `\n…(已截断，共 ${t.length} 字符)` : t) || "(页面无文本)" };
    } catch (e: any) {
      return { content: `读取失败: ${e.message}（可能还没 browser_open）`, isError: true };
    }
  },
};
const browserClickTool: Tool = {
  name: "browser_click",
  description: "在内置浏览器当前页面点击匹配 CSS 选择器的元素（按钮/链接等）。点完可再 browser_read 看变化。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: { selector: { type: "string", description: "CSS 选择器" } },
    required: ["selector"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const sel = String(input.selector || "");
      const r = await browserExec(
        `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'NOT_FOUND';el.scrollIntoView();el.click();return 'OK';})()`,
      );
      return r === "OK" ? { content: `已点击 ${sel}` } : { content: `未找到元素 ${sel}`, isError: true };
    } catch (e: any) {
      return { content: `点击失败: ${e.message}`, isError: true };
    }
  },
};
const BROWSER_TOOLS: Tool[] = [browserOpenTool, browserReadTool, browserClickTool];

// 密钥安全包装：入参占位符→真实值回填、bash 注入密钥环境变量、工具结果→脱敏后再回给模型。
// 闭环:模型能用密钥(env/占位符)但读不回明文(输出被脱敏)，想 echo 偷取也会被拦。
function deepRehydrate(input: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return secrets.rehydrate(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return walk(input) as Record<string, unknown>;
}
function wrapSecret(t: Tool): Tool {
  return {
    ...t,
    async run(input, ctx) {
      const realInput = deepRehydrate(input); // 占位符→明文，供本机执行
      const r = await t.run(realInput, { ...ctx, env: secrets.envForTools() });
      return { ...r, content: secrets.redact(r.content).text }; // 结果里的明文→占位符再回模型
    },
  };
}

// 桌面版工具集 = 共享工具 + 浏览器工具 + 动态 MCP 工具(连上后加入)，全部过密钥安全包装
function desktopTools(): Tool[] {
  return [...ALL_TOOLS, ...BROWSER_TOOLS, ...mcpTools()].map(wrapSecret);
}
function desktopToolMap(): Map<string, Tool> {
  return new Map(desktopTools().map((t) => [t.name, t]));
}
// MCP 连接/变更后，热更所有会话 agent 的工具集
function refreshAgentTools() {
  const tools = desktopTools();
  const map = desktopToolMap();
  for (const a of agents.values()) a.setTools(tools, map);
}

// 取/建某会话的 Agent（懒加载并恢复其历史）
function getAgent(id: string): Agent | null {
  if (!provider) return null;
  let a = agents.get(id);
  if (!a) {
    a = new Agent(provider, sysPrompt, desktopTools(), { cwd }, desktopToolMap(), agentOpts);
    a.setMessages(loadMessages(id));
    const meta = listSessions().find((s) => s.id === id); // 恢复该会话的用量
    if (meta?.usage) a.setUsage(meta.usage);
    agents.set(id, a);
  }
  return a;
}

const EMPTY_USAGE = { totalInput: 0, totalOutput: 0, lastInput: 0, totalCacheHit: 0, totalCacheMiss: 0 };
// 切换/加载会话后推送该会话自己的用量
function sendUsageFor(id: string) {
  const a = agents.get(id);
  send("evt:usage", a ? a.getUsage() : EMPTY_USAGE);
}

// 启动时：选最近会话或新建，推送列表与当前会话历史
function bootstrapSessions() {
  const list = listSessions();
  currentId = list[0]?.id ?? randomUUID();
  const a = getAgent(currentId);
  send("evt:sessions", listSessions());
  send("evt:session-loaded", { id: currentId, messages: a ? a.getMessages() : [] });
  const rl = loadRateLimits(curProviderId()); // 上次的订阅额度快照（按平台），打开即显示
  if (rl) send("evt:ratelimits", rl);
  sendUsageFor(currentId); // 当前会话自己的用量
}

// 会话有内容才落盘；空会话不持久化
function persist(id: string) {
  const a = agents.get(id);
  if (!a) return;
  const msgs = a.getMessages();
  if (msgs.length === 0) return;
  saveSession(id, msgs, deriveTitle(msgs), Date.now(), a.getUsage());
  send("evt:sessions", listSessions());
  void maybeSmartTitle(id);
}
function persistCurrent() {
  persist(currentId);
}

// 即时落盘(不触发智能标题/防刷)：每完成一段就存，重启不丢进度。可附带正在生成的半截草稿。
const streamDrafts = new Map<string, string>(); // 正在流的助手段落累积文本(还没进 agent.messages)
const draftSaveAt = new Map<string, number>(); // 草稿落盘节流时间戳
function persistQuiet(id: string, draft?: string) {
  const a = agents.get(id);
  if (!a) return;
  let msgs = a.getMessages();
  if (draft && draft.trim()) {
    // 把正在生成的半截作为临时助手消息附在末尾一起存(重启后可见/可续)；正常完成时会被真消息覆盖
    msgs = [...msgs, { role: "assistant", content: [{ type: "text", text: draft }] } as any];
  }
  if (msgs.length === 0) return;
  saveSession(id, msgs, deriveTitle(msgs), Date.now(), a.getUsage());
}
// 流式草稿节流落盘(~1.2s 一次)：既保存半截又不狂写盘
function saveDraftThrottled(id: string) {
  const now = Date.now();
  if (now - (draftSaveAt.get(id) || 0) < 1200) return;
  draftSaveAt.set(id, now);
  persistQuiet(id, streamDrafts.get(id));
}

// AI 智能标题：每一轮对话后都重新总结，让标题实时跟上会话内容
const titleInFlight = new Set<string>(); // 正在生成的会话(防重入)，非"只生成一次"
function hasText(msgs: any[], role: string): boolean {
  return msgs.some(
    (m) => m.role === role && m.content?.some((b: any) => b.type === "text" && b.text?.trim()),
  );
}
function msgText(m: any): string {
  return (m.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ")
    .slice(0, 200);
}
async function maybeSmartTitle(id: string) {
  if (titleInFlight.has(id) || !provider) return;
  const a0 = agents.get(id);
  if (!a0) return;
  const msgs = a0.getMessages();
  if (!hasText(msgs, "user") || !hasText(msgs, "assistant")) return;
  titleInFlight.add(id);
  // 取首条用户消息(定主题) + 最近几条(跟进展)，让标题随对话演进
  const firstUser = msgs.find((m: any) => m.role === "user");
  const recent = msgs.slice(-6);
  const picked = firstUser && !recent.includes(firstUser) ? [firstUser, ...recent] : recent;
  const convo = picked
    .map((m: any) => `${m.role === "user" ? "用户" : "助手"}: ${msgText(m)}`)
    .filter((s: string) => s.length > 3)
    .join("\n");
  try {
    const res = await provider.complete(
      "你是会话标注器。根据对话(尤其最新内容)输出两项，用竖线分隔：" +
        "①4-10 个汉字的简短中文标题(概括当前主题)；②2-6 字的项目/产品名或主题域(用于归类，如某系统名/某功能域，若无明显项目就填通用主题)。" +
        "严格只输出「标题|项目」，不要任何引号、解释、多余空格。",
      [{ role: "user", content: [{ type: "text", text: `对话:\n${convo}\n\n标题|项目:` }] }] as any,
      [],
      {},
    );
    const raw = (res.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    const [rawTitle, rawProject] = raw.split(/[|｜]/);
    const clean = (t?: string) => (t || "").replace(/[\s"'`。，、：:！!？?（）()【】\[\]]/g, "");
    const title = clean(rawTitle).slice(0, 12);
    const project = clean(rawProject).slice(0, 8);
    if (title) {
      const a = agents.get(id);
      if (a) {
        saveSession(id, a.getMessages(), title, Date.now(), a.getUsage());
        if (project) setSessionProject(id, project);
        send("evt:sessions", listSessions());
      }
    }
  } catch {
    /* 失败保留上一个标题 */
  } finally {
    titleInFlight.delete(id);
  }
}

// 输入框「下一步动作」建议：回复完后，用模型根据对话(尤其助手最后回复常以问题/建议结尾)
// 预测用户接下来最可能输入的一句话，发给前端做幽灵提示(Tab 补全)。无明确下一步则清空。
const suggestInFlight = new Set<string>();
async function suggestNextAction(id: string) {
  if (suggestInFlight.has(id) || !provider) return;
  const a0 = agents.get(id);
  if (!a0) return;
  const msgs = a0.getMessages();
  // 需要至少有一轮助手回复；最后一条应是助手(回复已完成)
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant" || !hasText(msgs, "user")) {
    send("evt:suggest", { sid: id, text: "" });
    return;
  }
  suggestInFlight.add(id);
  const recent = msgs.slice(-4);
  const convo = recent
    .map((m: any) => `${m.role === "user" ? "用户" : "助手"}: ${msgText(m)}`)
    .filter((s: string) => s.length > 3)
    .join("\n");
  try {
    const res = await provider.complete(
      "你是输入建议助手。下面是用户与编码助手的对话，助手最后的回复常以一个问题或建议的下一步动作结尾。" +
        "请用中文写出用户接下来最可能输入的一句话(第一人称或祈使句，像用户自己会打的话，不超过20字)，" +
        "直接输出这句话，不要引号、解释或前缀。若助手在等用户自由发挥、没有明确下一步，只输出：无",
      [{ role: "user", content: [{ type: "text", text: `对话:\n${convo}\n\n用户接下来最可能输入:` }] }] as any,
      [],
      {},
    );
    let raw = (res.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim()
      .replace(/^["'「『]|["'」』]$/g, "")
      .slice(0, 40);
    if (raw === "无" || raw === "无。") raw = "";
    send("evt:suggest", { sid: id, text: raw });
  } catch {
    send("evt:suggest", { sid: id, text: "" });
  } finally {
    suggestInFlight.delete(id);
  }
}

function createWindow() {
  const b = loadWindowBounds(); // 上次窗口尺寸/位置
  // 窗口/任务栏图标：dev 下 electron.exe 用默认图标，显式指向 build/icon.png；
  // 打包版 build/ 不入包，文件不存在则跳过，自动回退到 exe 自带图标。
  const iconPath = join(__dirname, "../../build/icon.png");
  win = new BrowserWindow({
    width: b?.width ?? 960,
    height: b?.height ?? 720,
    ...(b?.x != null && b?.y != null ? { x: b.x, y: b.y } : {}),
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    minWidth: 640,
    minHeight: 480,
    title: "无为",
    backgroundColor: "#16191e", // 无为·玄墨黑，避免加载时白闪
    // 无边框自绘：mac 保留悬浮红绿灯(hiddenInset)，Windows/Linux 全去原生边框+菜单，标题栏自绘
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 记住窗口尺寸/位置（拖动节流保存 + 关闭时保存）
  let saveT: ReturnType<typeof setTimeout> | undefined;
  const persistBounds = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      if (win && !win.isDestroyed()) saveWindowBounds(win.getBounds());
    }, 400);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
  win.on("close", () => {
    if (win && !win.isDestroyed()) saveWindowBounds(win.getBounds());
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) win.loadURL(devUrl);
  else win.loadURL("app://bundle/index.html");

  win.webContents.on("did-finish-load", () => {
    send("evt:ready", { backend: backendLabel, model: modelLabel, cwd, sub: subFlag, ctxWindow });
    bootstrapSessions();
    void emitAccount();
    const pid = loadSettings()?.providerId;
    if (pid) void silentRefreshAccount(pid); // 启动时用存的 token 静默刷新账号(不弹窗)
    // 连接已配置的 MCP 服务器，连上后把其工具热更进各会话
    if (loadMcpConfig().length) {
      void connectMcp(() => {
        refreshAgentTools();
        send("evt:mcp", mcpStatus());
      });
    }
  });
  // 诊断：把渲染进程报错/加载失败打到主进程 stdout，便于终端排查黑屏
  win.webContents.on("console-message", (_e, _lvl, message, line, src) => {
    console.log(`[renderer] ${message} (${src}:${line})`);
    log("renderer", `${message} (${src}:${line})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`);
  });
}

// 单例锁：防御纵深——即使被意外多次启动也只存活一个实例，杜绝 fork bomb 类问题
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  // 系统托盘 + 右键菜单（任务栏图标右键：打开无为 / 退出）
  function createTray() {
    try {
      // 托盘专用多尺寸 ico：Windows 按 DPI 自动选最清晰的一档，别手动缩到 18(会糊)
      const iconFile = join(__dirname, "../../build/tray.ico");
      const img = nativeImage.createFromPath(iconFile);
      tray = new Tray(img);
      tray.setToolTip("无为");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: "打开无为",
            click: () => {
              win?.show();
              win?.focus();
            },
          },
          { type: "separator" },
          {
            label: "退出",
            click: () => {
              app.quit();
            },
          },
        ]),
      );
      tray.on("click", () => {
        if (win?.isVisible()) win.focus();
        else {
          win?.show();
          win?.focus();
        }
      });
    } catch (e) {
      log("boot", "托盘创建失败", String(e));
    }
  }

  app.whenReady().then(() => {
    // app://bundle/xxx → out/renderer/xxx（打包后 renderer 与 main 同级 out 下）
    protocol.handle("app", async (request) => {
      const { pathname } = new URL(request.url);
      const rel = pathname === "/" || pathname === "" ? "/index.html" : pathname;
      const filePath = join(__dirname, "../renderer", rel);
      const res = await net.fetch(pathToFileURL(filePath).toString());
      const type = mimeFor(rel);
      if (type) {
        const headers = new Headers(res.headers);
        headers.set("content-type", type);
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    });
    Menu.setApplicationMenu(null); // 去掉原生菜单栏(File/Edit/View/Window)
    try {
      initProvider();
    } catch {
      // 凭证等问题：窗口起来后提示
    }
    createWindow();
    // 任务栏图标/分组用无为标识
    try {
      app.setName("无为");
      if (process.platform === "win32") app.setAppUserModelId("io.wuweiai.app");
    } catch {
      /* ignore */
    }
    createTray();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// —— IPC：渲染 → 主 ——
// 多任务：sid 指定跑哪个会话(前端传 currentId)，各会话各自异步、互不阻塞。事件都带 sid，前端只把当前可见会话的更新画出来。
// 无为托管平台(走网关、按 token 扣无为币)：providerId 以 "wuwei-" 开头。
function isHostedProvider(pid?: string): boolean {
  return !!pid && pid.startsWith("wuwei-");
}
// 托管平台每轮开跑前：把新鲜的无为 access_token 注入为网关的 apiKey(快过期先续期)，重建 provider。
async function ensureHostedProviderReady(): Promise<void> {
  const st = loadSettings();
  if (!st || !isHostedProvider(st.providerId)) return;
  let sess = loadWuweiSession();
  if (!sess) return; // 未登录：发送门槛已拦，这里兜底不注入
  if (sess.expiresAt && sess.expiresAt - Date.now() < 2 * 60 * 1000) {
    const fresh = await wuweiRefresh(sess.refreshToken);
    if (fresh) {
      saveWuweiSession(fresh);
      sess = fresh;
    }
  }
  applyEnvFromSettings(st); // 平台 baseUrl(网关)等按设置
  process.env.MINICC_API_KEY = sess.accessToken; // 网关的"key"=用户无为 token(只 env、不落 config)
  provider = makeProvider(loadConfig());
  for (const a of agents.values()) a.setProvider(provider);
}
// 托管平台每轮结束后：拉最新余额推给渲染层(账号菜单余额随扣币刷新)。
async function refreshWuweiMe(): Promise<void> {
  const sess = loadWuweiSession();
  if (!sess) return;
  const me = await wuweiFetchMe(sess.accessToken);
  if (me && me !== "unauthorized") send("evt:wuwei-me", me);
}

async function startTurn(useId: string, text: string, images?: string[], sysOverride?: string) {
  text = secrets.redact(text).text; // 兜底：已入库密钥出现在消息里→占位符替换，永不出网到模型
  const agent = getAgent(useId);
  if (!agent) {
    send("evt:error", { sid: useId, message: "未初始化：缺少模型凭证。请确认 ~/.codex/auth.json 或设置 API key 后重启。" });
    return;
  }
  if (runs.has(useId)) return; // 该会话已在跑，忽略重复提交
  await ensureFreshClaudeOAuth(); // Claude 订阅 OAuth 快过期则先静默续期，避免本轮请求 401
  await ensureHostedProviderReady(); // 无为托管平台：注入新鲜无为 token 为网关 key
  // 每轮开跑前刷新系统提示词，让上一轮 remember 写入的记忆立即生效(日报等场景用 sysOverride 注入聚合内容)
  agent.setSystem(sysOverride ?? buildSysPrompt(cwd, modelLabel, loadSettings()?.providerId));
  const ac = new AbortController();
  runs.set(useId, ac);
  emitTasks();
  try {
    const runP = agent.send(
      text,
      {
        onText: (delta) => {
          send("evt:assistant-delta", { sid: useId, delta });
          streamDrafts.set(useId, (streamDrafts.get(useId) || "") + delta); // 累积半截
          saveDraftThrottled(useId); // 节流落盘：重启不丢正在生成的内容
        },
        onStep: () => {
          streamDrafts.delete(useId); // 该段已进历史，清草稿
          persistQuiet(useId); // 即时落盘真实消息(每段/每工具轮)
        },
        onRecover: (cleaned) => {
          streamDrafts.delete(useId);
          send("evt:assistant-replace", { sid: useId, text: cleaned }); // 前端把泄漏的 XML 换成干净正文
        },
        onToolStart: (id, name, input) => send("evt:tool-start", { sid: useId, id, name, input }),
        onToolEnd: (id, result, isError) => send("evt:tool-end", { sid: useId, id, result, isError }),
        requestPermission: (tool, input) =>
          new Promise((resolve) => {
            const id = ++permSeq;
            pendingPerm.set(id, resolve);
            send("evt:permission-request", { sid: useId, id, name: tool.name, input });
          }),
        onUsage: (u) => send("evt:usage", { sid: useId, usage: u }),
        onRateLimits: (rl) => {
          log("ratelimits", "5h=", rl.primaryUsedPercent, "% 周=", rl.secondaryUsedPercent, "%");
          saveRateLimits(curProviderId(), rl); // 记住（按平台），下次打开直接显示
          send("evt:ratelimits", rl);
        },
        onCompact: (b, a) => send("evt:compact", { sid: useId, before: b, after: a }),
        onAssistantDone: () => send("evt:done", { sid: useId }),
      },
      ac.signal,
      images,
    );
    persist(useId); // 用户消息已同步入队,立即落盘让(新)会话进侧栏、带上运行点
    await runP;
    if (isHostedProvider(loadSettings()?.providerId)) void refreshWuweiMe(); // 托管平台：扣币后刷新顶栏/菜单余额
    if (runs.get(useId) === ac)
      send(ac.signal.aborted ? "evt:stopped" : "evt:done", { sid: useId }); // 中断后 loop 干净返回也算停止
  } catch (e: any) {
    // 若已被 chat:stop 手动停止(runs 里已换掉/删掉本 ac),就不再重复报,避免"已停止"提示重复
    if (runs.get(useId) === ac) {
      if (e?.name === "AbortError" || ac.signal.aborted) send("evt:stopped", { sid: useId });
      else {
        if (isHostedProvider(loadSettings()?.providerId)) void refreshWuweiMe(); // 失败也刷新，避免余额提示仍显示旧缓存
        send("evt:error", { sid: useId, message: e.message });
      }
    }
  } finally {
    if (runs.get(useId) === ac) {
      runs.delete(useId);
      emitTasks();
    }
    streamDrafts.delete(useId); // 清掉流式草稿(真实消息已在历史)
    draftSaveAt.delete(useId);
    persist(useId); // 该会话跑完落盘
    void emitAccount(); // 刷新余额/本会话已消耗(DeepSeek 等)
    if (useId === currentId && !ac.signal.aborted) void suggestNextAction(useId); // 仅当前会话、正常跑完才提建议
  }
}

ipcMain.on("chat:send", (_e, sid: string, text: string, images?: string[]) => {
  void startTurn(sid || currentId, text, images);
});

// 运行中注入新需求：正在跑→注入到当前循环边界(AI 综合权衡/优先处理，不必等整轮跑完)；没在跑→当普通发送
ipcMain.on("chat:inject", (_e, sid: string, text: string, images?: string[]) => {
  const useId = sid || currentId;
  text = secrets.redact(text).text; // 同发送路径：注入的文本也脱敏
  const agent = getAgent(useId);
  if (agent && runs.has(useId)) {
    agent.injectUser(text, images);
    log("inject", useId.slice(0, 8), (text || "").slice(0, 40));
  } else {
    void startTurn(useId, text, images);
  }
});

// 撤回一条尚未被处理的注入消息(还在缓冲里)；命中=干净撤回，AI 没看到
ipcMain.handle("chat:recall-inject", (_e, sid: string, text: string) => {
  return agents.get(sid || currentId)?.recallPendingInject(text) ?? false;
});

ipcMain.on("chat:stop", (_e, sid?: string) => {
  const id = sid || currentId;
  // 只 abort，不立即删 runs——留给 agent.send 的 finally 结算后清理。
  // 否则会话仍在跑就被移出 runs，紧接着的新消息不再被拦→并发跑同一 agent→历史错乱(连续user/悬空tool_use)致 400。
  // loop 已在中断后尽快收尾(补齐 tool_result 并 return)，所以很快结算、UI 随即解锁。
  runs.get(id)?.abort();
  // 若正卡在权限确认，一并取消(否则中断信号也叫不醒它)
  for (const [pid, r] of pendingPerm) {
    r("deny");
    pendingPerm.delete(pid);
  }
});

ipcMain.on("perm:respond", (_e, id: number, decision: "allow" | "deny") => {
  const r = pendingPerm.get(id);
  if (r) {
    r(decision);
    pendingPerm.delete(id);
  }
});

// —— 会话管理 IPC ——
ipcMain.on("session:new", () => {
  currentId = randomUUID();
  const a = getAgent(currentId);
  send("evt:session-loaded", { id: currentId, messages: a ? a.getMessages() : [] });
  sendUsageFor(currentId);
  void emitAccount();
});

// 一键生成日报：把某分组下(前端算好的会话 id 列表)所有会话内容聚合，新开一个会话让 AI 梳理成日报
ipcMain.on("report:generate", (_e, group: string, sessionIds: string[]) => {
  const ids = Array.isArray(sessionIds) ? sessionIds : [];
  if (!ids.length) return;
  const metas = listSessions();
  // 每个会话取标题 + 正文文本(取末尾最新进展，单会话截断防超长)
  const digest = ids
    .map((id) => {
      const meta = metas.find((s) => s.id === id);
      const body = loadMessages(id)
        .map((m: any) => {
          const t = (m.content || [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join(" ")
            .trim();
          return t ? `${m.role === "user" ? "我" : "助手"}：${t}` : "";
        })
        .filter(Boolean)
        .join("\n")
        .slice(-2000); // 取末尾(最新进展)，单会话上限约 2000 字
      return `【${meta?.title || "对话"}】\n${body || "(暂无文字内容)"}`;
    })
    .join("\n\n----\n\n");

  const sys =
    `你是工作日报助手。下面是「${group}」分组下今天多个工作会话的内容。当用户要求生成日报时，` +
    `请按项目/重点条理清晰地梳理成一份精简中文日报，分三部分：` +
    `✅ 今日进展与成果（按项目/重点一条条罗列）、📌 待办（接下来要做的）、⚠️ 遗留问题/风险。` +
    `要求：精简概要、突出重点、条目式，不要逐字复述细节。\n\n=== 会话内容 ===\n${digest}`;

  // 新开会话并切过去
  const sid = randomUUID();
  currentId = sid;
  getAgent(sid);
  send("evt:session-loaded", { id: sid, messages: [] });
  sendUsageFor(sid);
  void startTurn(sid, `请生成「${group}」今天的工作日报。`, undefined, sys);
});

ipcMain.on("session:switch", (_e, id: string) => {
  currentId = id;
  const a = getAgent(id);
  send("evt:session-loaded", { id, messages: a ? a.getMessages() : [] });
  sendUsageFor(id);
  void emitAccount();
});

ipcMain.on("session:delete", (_e, id: string) => {
  runs.get(id)?.abort(); // 删除正在跑的会话先中断它
  runs.delete(id);
  deleteSession(id);
  agents.delete(id);
  if (currentId === id) {
    const list = listSessions();
    currentId = list[0]?.id ?? randomUUID();
    const a = getAgent(currentId);
    send("evt:session-loaded", { id: currentId, messages: a ? a.getMessages() : [] });
    sendUsageFor(currentId);
  }
  send("evt:sessions", listSessions());
  send("evt:groups", listGroups());
});

// 会话分组：移动到分组(group 空=移出)；新组自动创建并置顶
ipcMain.on("session:set-group", (_e, id: string, group?: string | null) => {
  setSessionGroup(id, group);
  send("evt:sessions", listSessions());
  send("evt:groups", listGroups());
});

// 会话优先级：权重(数字大靠前) + 显示标签
ipcMain.on("session:set-priority", (_e, id: string, priority: number, tag?: string) => {
  setSessionPriority(id, priority, tag);
  send("evt:sessions", listSessions());
});

// 会话手动拖拽排序：写入 order 键
ipcMain.on("session:set-order", (_e, id: string, order: number) => {
  setSessionOrder(id, order);
  send("evt:sessions", listSessions());
});

// 组顺序拖拽重排
ipcMain.on("session:reorder-groups", (_e, names: string[]) => {
  setGroupsOrder(names);
  send("evt:groups", listGroups());
});

// 标记已完成(排到最后、置灰)
ipcMain.on("session:set-done", (_e, id: string, done: boolean) => {
  setSessionDone(id, done);
  send("evt:sessions", listSessions());
});

// 删除某一轮问答(第 ordinal 条用户输入及其后到下一条用户输入之间的全部消息=该轮回复)
// 整轮删除→历史天然保持交替与 tool_use/tool_result 配对，不产生占位垃圾
ipcMain.on("session:delete-exchange", (_e, id: string, ordinal: number) => {
  if (runs.has(id)) return; // 正在跑的会话不允许删,防改到正在变的历史
  const a = getAgent(id);
  if (!a) return;
  const msgs = a.getMessages();
  const isUserInput = (m: any) =>
    m.role === "user" && (m.content || []).some((b: any) => b.type === "text" || b.type === "image");
  // 定位第 ordinal 条用户输入的起点
  let seen = -1;
  let start = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (isUserInput(msgs[i])) {
      seen++;
      if (seen === ordinal) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return;
  // 终点=下一条用户输入(不含)，即该轮 AI 多步回复的末尾
  let end = msgs.length;
  for (let i = start + 1; i < msgs.length; i++) {
    if (isUserInput(msgs[i])) {
      end = i;
      break;
    }
  }
  a.setMessages([...msgs.slice(0, start), ...msgs.slice(end)]);
  send("evt:session-loaded", { id, messages: a.getMessages() });
  persist(id); // 落盘(空了也会更新列表)
  send("evt:sessions", listSessions());
});

// /reset：清空当前会话
// 外部链接用系统浏览器打开（Markdown 里的链接，防在 app 内导航离开）
ipcMain.on("open-external", (_e, url: string) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.on("chat:reset", () => {
  const a = getAgent(currentId);
  if (a) {
    a.setMessages([]);
    a.setUsage({ totalInput: 0, totalOutput: 0, lastInput: 0, totalCacheHit: 0, totalCacheMiss: 0 });
  }
  send("evt:session-loaded", { id: currentId, messages: [] });
  sendUsageFor(currentId);
});

// 撤销上一条：删掉最后一条用户消息及其之后所有(修出错卡死的消息)
ipcMain.on("chat:undo-last", () => {
  const a = agents.get(currentId);
  if (!a) return;
  const msgs = a.getMessages();
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      idx = i;
      break;
    }
  }
  if (idx < 0) return;
  a.setMessages(msgs.slice(0, idx));
  send("evt:session-loaded", { id: currentId, messages: a.getMessages() });
  saveSession(currentId, a.getMessages(), deriveTitle(a.getMessages()), Date.now(), a.getUsage());
  send("evt:sessions", listSessions());
  sendUsageFor(currentId);
});

// —— 设置（provider/model）——
// 渲染端挂载时主动拉取(避免启动推送早于监听注册导致会话列表丢失=空白页)
ipcMain.handle("session:bootstrap", () => {
  if (!currentId) {
    const list = listSessions();
    currentId = list[0]?.id ?? randomUUID();
  }
  const a = getAgent(currentId);
  return {
    sessions: listSessions(),
    groups: listGroups(),
    currentId,
    messages: a ? a.getMessages() : [],
    usage: a ? a.getUsage() : EMPTY_USAGE,
    rateLimits: loadRateLimits(curProviderId()) || null,
  };
});

ipcMain.handle("settings:get", () => ({
  settings: loadSettings(),
  backend: backendLabel,
  model: modelLabel,
  defaultPrompt: DEFAULT_SYSTEM_PROMPT, // 供设置页显示"未自定义时的默认提示词"
}));

ipcMain.on("settings:set", (_e, s: Settings) => {
  try {
    applySettings(s);
  } catch (e: any) {
    send("evt:error", "切换后端失败：" + e.message);
  }
});

// 纯 UI 设置(分组模式)：只落盘，不重启 provider
ipcMain.on("settings:set-group-mode", (_e, mode: "manual" | "date" | "project") => {
  const s = loadSettings() || ({} as Settings);
  saveSettings({ ...s, groupMode: mode });
});

// 纯 UI 设置(输出方式/速度)：只落盘，不重启 provider
ipcMain.on(
  "settings:set-stream",
  (_e, mode: "typewriter" | "stream" | "instant", speed: number) => {
    const s = loadSettings() || ({} as Settings);
    saveSettings({ ...s, streamMode: mode, streamSpeed: speed });
  },
);

// 上下文压缩：保留最近 N 条(热更所有会话，不重启 provider)
ipcMain.on("settings:set-keep-recent", (_e, n: number) => {
  const keep = Number(n);
  if (!Number.isFinite(keep) || keep <= 0) return;
  const s = loadSettings() || ({} as Settings);
  saveSettings({ ...s, keepRecent: keep });
  agentOpts = { ...agentOpts, keepRecent: keep };
  for (const a of agents.values()) a.setCompactOpts({ keepRecent: keep });
});

// —— 全局记忆(设置里手动编辑) ——
ipcMain.handle("memory:get", () => loadMemory());
ipcMain.on("memory:set", (_e, text: string) => {
  saveMemory(text);
  // 立即刷新当前会话系统提示词,手动改的记忆下一条消息就生效
  for (const a of agents.values()) a.setSystem(buildSysPrompt(cwd, modelLabel, loadSettings()?.providerId));
});

// —— 输入框草稿：实时落盘 ~/.wuwei/draft.json，重开/更新后自动恢复(含粘贴的截图 base64) ——
const DRAFT_FILE = join(homedir(), ".wuwei", "draft.json");
ipcMain.handle("draft:get", () => {
  try {
    return JSON.parse(readFileSync(DRAFT_FILE, "utf8"));
  } catch {
    return { text: "", images: [] };
  }
});
ipcMain.on("draft:set", (_e, draft: { text?: string; images?: string[] }) => {
  try {
    mkdirSync(dirname(DRAFT_FILE), { recursive: true });
    writeFileSync(
      DRAFT_FILE,
      JSON.stringify({ text: draft?.text || "", images: draft?.images || [] }),
      "utf8",
    );
  } catch {
    /* 落盘失败不影响发送 */
  }
});

// —— 本地知识网络 Brain（设置里的"知识网络"面板 + 模型预热）——
function refreshSysAfterBrain() {
  for (const a of agents.values()) a.setSystem(buildSysPrompt(cwd, modelLabel, loadSettings()?.providerId));
}
ipcMain.handle("brain:graph", () => brain.getGraphLite());
ipcMain.handle("brain:stats", () => brain.stats());
ipcMain.handle("brain:recall", async (_e, query: string) => (await brain.recall(String(query || ""))).text);
ipcMain.handle("brain:warmup", async () => brain.warmupEmbedder());
ipcMain.handle("brain:save-node", async (_e, node) => {
  await brain.saveNodeFromUI(node);
  refreshSysAfterBrain();
});
ipcMain.handle("brain:delete-node", (_e, id: string) => {
  brain.deleteNodeFromUI(String(id));
  refreshSysAfterBrain();
});
ipcMain.handle("brain:add-edge", async (_e, from: string, relation: string, to: string) => {
  await brain.addEdgeFromUI(String(from), String(relation), String(to));
  refreshSysAfterBrain();
});
ipcMain.handle("brain:delete-edge", (_e, id: string) => brain.deleteEdgeFromUI(String(id)));
// 文档冷存储（知识宫殿等）：建索引(带进度事件)/统计/读原文
ipcMain.handle("brain:doc-stats", () => brain.docStats());

// —— 索引构建进度：主进程为唯一真相源，关闭设置弹窗也不丢；渲染随时可查/订阅 ——
type DocBuildState = {
  building: boolean;
  phase: string; // idle|scan|embed|done|error
  files: number;
  total: number;
  done: number;
  error?: string;
};
let docBuildState: DocBuildState = { building: false, phase: "idle", files: 0, total: 0, done: 0 };
ipcMain.handle("brain:doc-progress", () => docBuildState);
ipcMain.handle("brain:embed-ready", () => brain.embeddingReady());
ipcMain.handle("brain:build-docs", async (_e, dir: string) => {
  if (conceptState.running) throw new Error("正在抽取概念，请先停止或等它完成再重建索引（两者共用向量模型）");
  const abs = String(dir).replace(/^~(?=\/|$)/, homedir());
  docBuildState = { building: true, phase: "scan", files: 0, total: 0, done: 0 };
  send("evt:brain-docs", docBuildState);
  try {
    await brain.buildDocs(abs, (p) => {
      docBuildState = {
        building: true,
        phase: p.phase,
        files: p.files ?? docBuildState.files,
        total: p.total ?? docBuildState.total,
        done: p.done ?? docBuildState.done,
      };
      send("evt:brain-docs", docBuildState);
    });
    docBuildState = { ...docBuildState, building: false, phase: "done" };
  } catch (e: any) {
    docBuildState = { ...docBuildState, building: false, phase: "error", error: e?.message || String(e) };
  }
  send("evt:brain-docs", docBuildState);
  return brain.docStats();
});
ipcMain.handle("brain:read-doc", (_e, ref: string) => brain.readDoc(String(ref)));

// —— 概念抽取：用当前对话模型(k3)从已索引文档「按文档级」批量抽概念+关系填进 graph ——
// 按文档级(而非块级)大幅省 token：204 文档 = 204 次调用，非 3571 块。可停、进度持久、默认只抽未抽过的文档。
const CONCEPTS_DONE_FILE = join(homedir(), ".wuwei", "brain", "concepts-done.json");
function loadConceptsDone(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(CONCEPTS_DONE_FILE, "utf8")).files || []);
  } catch {
    return new Set();
  }
}
function saveConceptsDone(s: Set<string>) {
  try {
    mkdirSync(dirname(CONCEPTS_DONE_FILE), { recursive: true });
    writeFileSync(CONCEPTS_DONE_FILE, JSON.stringify({ files: [...s], updatedAt: Date.now() }), "utf8");
  } catch {
    /* ignore */
  }
}
type ConceptState = {
  running: boolean;
  phase: string; // idle|run|done|stopped|error
  total: number;
  done: number;
  created: number;
  skipped: number;
  cur?: string;
  error?: string;
};
let conceptState: ConceptState = { running: false, phase: "idle", total: 0, done: 0, created: 0, skipped: 0 };
let conceptCancel = false;
ipcMain.handle("brain:concept-progress", () => conceptState);
ipcMain.on("brain:stop-concepts", () => {
  conceptCancel = true;
});
ipcMain.handle("brain:extract-concepts", (_e, opts: { all?: boolean }) => {
  if (conceptState.running) return { started: false, reason: "已在运行" };
  if (!provider) return { started: false, reason: "未配置模型" };
  // 防并发:抽概念时每存一个概念要给它算向量,走的是索引重建正霸占的同一个 worker,
  // 同时跑会互相饿死→龟速。索引没建完先拦住,提示用户等索引跑完再抽。
  if (docBuildState.building)
    return { started: false, reason: "索引正在构建，请等它跑完再抽概念（两者共用向量模型，同时跑会互相拖慢）" };
  void runConceptExtraction(!!opts?.all); // 后台跑,不阻塞;进度走 evt:brain-concepts
  return { started: true };
});

async function extractOneFile(file: string, body: string): Promise<number> {
  const sys =
    "你是知识图谱抽取器。从给定的中文文档片段中，抽取值得长期记住的【概念节点】与它们之间的【关系】。" +
    "概念 = 项目/服务器/服务/脚本/工具/命令/注意事项/偏好/抽象概念 等有信息量的实体。" +
    "只输出一个 JSON 对象，禁止任何解释、禁止代码围栏，格式严格为：" +
    '{"concepts":[{"name":"规范短名","type":"类型","summary":"一句话摘要","aliases":["别名"]}],"relations":[{"from":"概念A","relation":"关系","to":"概念B"}]}。' +
    "name 用最规范简短的名字；没有可抽的就返回 {\"concepts\":[],\"relations\":[]}。最多 12 个概念。";
  const res = await provider!.complete(
    sys,
    [{ role: "user", content: [{ type: "text", text: `文档《${file}》片段：\n${body}\n\nJSON:` }] }] as any,
    [],
    {},
  );
  const raw = (res.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw.replace(/^```(json)?/i, "").replace(/```\s*$/, "").trim());
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch { /* 放弃本篇 */ }
  }
  if (!parsed) return 0;
  let n = 0;
  for (const c of parsed.concepts || []) {
    if (!c?.name) continue;
    await brain.learn({
      name: String(c.name).slice(0, 60),
      type: c.type ? String(c.type).slice(0, 20) : "概念",
      summary: c.summary ? String(c.summary).slice(0, 200) : "",
      aliases: Array.isArray(c.aliases) ? c.aliases.slice(0, 8).map((a: any) => String(a).slice(0, 40)) : [],
    });
    n++;
  }
  for (const r of parsed.relations || []) {
    if (!r?.from || !r?.to || !r?.relation) continue;
    await brain.link(String(r.from).slice(0, 60), String(r.relation).slice(0, 20), String(r.to).slice(0, 60));
  }
  return n;
}

async function runConceptExtraction(all: boolean) {
  conceptCancel = false;
  const idx = brain.loadDocIndex();
  const byFile = new Map<string, { headingPath: string; text: string }[]>();
  for (const c of idx.chunks) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push({ headingPath: c.headingPath, text: c.text });
  }
  const done = all ? new Set<string>() : loadConceptsDone();
  const files = [...byFile.keys()].filter((f) => all || !done.has(f));
  conceptState = { running: true, phase: "run", total: files.length, done: 0, created: 0, skipped: 0 };
  send("evt:brain-concepts", conceptState);
  log("concept", `开始抽取:待处理 ${files.length} 篇(all=${all}),模型=${modelLabel}`);
  for (const f of files) {
    if (conceptCancel) {
      conceptState = { ...conceptState, running: false, phase: "stopped" };
      log("concept", `已停止:${conceptState.done}/${files.length} 篇, 累计 ${conceptState.created} 概念`);
      break;
    }
    conceptState = { ...conceptState, cur: f };
    send("evt:brain-concepts", conceptState);
    let body = byFile
      .get(f)!
      .map((c) => (c.headingPath ? `〖${c.headingPath}〗\n${c.text}` : c.text))
      .join("\n\n");
    if (body.length > 6000) body = body.slice(0, 6000); // 单篇上限,控 token
    const t0 = Date.now();
    log("concept", `[${conceptState.done + 1}/${files.length}] 抽取中: ${f}`);
    try {
      const created = await extractOneFile(f, body);
      conceptState = { ...conceptState, created: conceptState.created + created };
      done.add(f);
      saveConceptsDone(done);
      log("concept", `[${conceptState.done + 1}/${files.length}] 完成: ${f} → +${created} 概念 (${Date.now() - t0}ms)`);
    } catch (e: any) {
      conceptState = { ...conceptState, skipped: conceptState.skipped + 1 };
      log("concept", `[${conceptState.done + 1}/${files.length}] 失败(跳过): ${f} → ${e?.message || e}`);
    }
    conceptState = { ...conceptState, done: conceptState.done + 1 };
    send("evt:brain-concepts", conceptState);
  }
  if (!conceptCancel) {
    conceptState = { ...conceptState, running: false, phase: "done", cur: undefined };
    log("concept", `全部完成:${conceptState.done} 篇, 共 ${conceptState.created} 概念, 跳过 ${conceptState.skipped}`);
  }
  send("evt:brain-concepts", conceptState);
}

// —— MCP 服务器(设置里配置) ——
ipcMain.handle("mcp:get", () => {
  let config = "";
  try {
    config = readFileSync(MCP_CONFIG_PATH, "utf8");
  } catch {
    /* 无配置 */
  }
  return { config, status: mcpStatus() };
});
ipcMain.on("mcp:set", (_e, text: string) => {
  try {
    mkdirSync(dirname(MCP_CONFIG_PATH), { recursive: true });
    writeFileSync(MCP_CONFIG_PATH, text, "utf8");
  } catch (e: any) {
    send("evt:error", "写入 MCP 配置失败：" + e.message);
    return;
  }
  void connectMcp(() => {
    refreshAgentTools();
    send("evt:mcp", mcpStatus());
  });
});
ipcMain.handle("mcp:search", (_e, query: string, cursor?: string) => searchMcpRegistry(query, cursor));

// —— 本地密钥管理器 ——
ipcMain.handle("secrets:list", () => {
  try {
    return { entries: secrets.listSecrets(), available: safeStorageOk() };
  } catch {
    return { entries: [], available: safeStorageOk() };
  }
});
ipcMain.handle("secrets:add", (_e, input: { name?: string; envVar?: string; value: string; note?: string }) => {
  try {
    return { ok: true, entry: secrets.addSecret(input) };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("secrets:update", (_e, id: string, patch: any) => {
  try {
    secrets.updateSecret(id, patch);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("secrets:delete", (_e, id: string) => {
  secrets.deleteSecret(id);
  return { ok: true };
});
ipcMain.handle("secrets:import-env", (_e, text: string) => {
  try {
    return { ok: true, count: secrets.importEnv(text) };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});
// 查看明文:先用本机账号密码校验(macOS dscl -authonly，不需 sudo)，通过才返回真实值
ipcMain.handle("secrets:reveal", async (_e, pw: string) => {
  try {
    const { execFile } = await import("node:child_process");
    const os = await import("node:os");
    const user = os.userInfo().username;
    const ok = await new Promise<boolean>((resolve) => {
      const p = execFile("/usr/bin/dscl", [".", "-authonly", user, String(pw ?? "")], (err) => resolve(!err));
      p.on("error", () => resolve(false));
    });
    if (!ok) return { ok: false, error: "密码不正确" };
    return { ok: true, items: secrets.revealAll() };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});
// 发送前扫描：脱敏已入库密钥 + 返回尚未入库的疑似新密钥(给确认弹窗)。永不抛错,否则会挡住发送。
ipcMain.handle("secrets:scan", (_e, text: string) => {
  try {
    // detect 用原文(才能发现"值已存在但描述不同"的重复)；redact 单独产出发给模型的脱敏版
    return { redacted: secrets.redact(text).text, candidates: secrets.detect(text) };
  } catch {
    return { redacted: text, candidates: [] };
  }
});

// 「工具」面板：把当前生效的全部工具（内置 + 浏览器 + 各 MCP 服务器）按来源分组返回
ipcMain.handle("tools:get", () => {
  const mk = (t: Tool) => ({
    name: t.name,
    description: t.description || "",
    readOnly: !!t.readOnly,
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  });
  const groups: { source: string; kind: "builtin" | "browser" | "mcp"; tools: ReturnType<typeof mk>[] }[] = [
    { source: "内置工具", kind: "builtin", tools: ALL_TOOLS.map(mk) },
    { source: "浏览器", kind: "browser", tools: BROWSER_TOOLS.map(mk) },
    ...mcpToolsBySource().map((g) => ({
      source: g.server,
      kind: "mcp" as const,
      tools: g.tools.map(mk),
    })),
  ];
  const total = groups.reduce((n, g) => n + g.tools.length, 0);
  return { groups, total };
});

// —— 浏览器面板：把 WebContentsView 贴到主窗口指定区域(前端量好 bounds 发来) ——
ipcMain.on("browser:show", (_e, b: { x: number; y: number; width: number; height: number }) => {
  const v = getBrowserView();
  if (win && !browserAttached) {
    win.contentView.addChildView(v);
    browserAttached = true;
  }
  v.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  emitBrowser();
});
ipcMain.on("browser:hide", () => {
  if (win && browserView && browserAttached) {
    win.contentView.removeChildView(browserView);
    browserAttached = false;
  }
});
ipcMain.on("browser:nav", (_e, action: string, arg?: string) => {
  try {
    const wc = getBrowserView().webContents;
    if (action === "back") wc.navigationHistory.goBack();
    else if (action === "forward") wc.navigationHistory.goForward();
    else if (action === "reload") wc.reload();
    else if (action === "open" && arg) wc.loadURL(/^https?:\/\//i.test(arg) ? arg : "https://" + arg);
  } catch {
    /* ignore */
  }
});
// 把浏览器视图弹成独立可拖动窗口
let browserPopWin: BrowserWindow | null = null;
ipcMain.on("browser:detach", () => {
  const v = getBrowserView();
  if (win && browserAttached) {
    win.contentView.removeChildView(v);
    browserAttached = false;
  }
  if (!browserPopWin || browserPopWin.isDestroyed()) {
    browserPopWin = new BrowserWindow({ width: 1040, height: 780, title: "minicc 浏览器" });
    const fit = () => {
      if (!browserPopWin || browserPopWin.isDestroyed()) return;
      const [w, h] = browserPopWin.getContentSize();
      v.setBounds({ x: 0, y: 0, width: w, height: h });
    };
    browserPopWin.contentView.addChildView(v);
    fit();
    browserPopWin.on("resize", fit);
    browserPopWin.on("close", () => {
      // 关窗前先把视图摘出来，别随窗口销毁(否则丢失页面)
      if (browserView && !browserView.webContents.isDestroyed() && browserPopWin) {
        try {
          browserPopWin.contentView.removeChildView(browserView);
        } catch {
          /* ignore */
        }
      }
    });
    browserPopWin.on("closed", () => {
      browserPopWin = null;
      send("evt:browser-detached", false); // 关掉独立窗=收回到主窗口
    });
  } else {
    browserPopWin.contentView.addChildView(v);
    browserPopWin.focus();
  }
  send("evt:browser-detached", true);
});
ipcMain.on("browser:reattach", () => {
  if (browserPopWin && !browserPopWin.isDestroyed()) {
    if (browserView && !browserView.webContents.isDestroyed()) {
      try {
        browserPopWin.contentView.removeChildView(browserView); // 先摘视图再销毁窗口，保住页面
      } catch {
        /* ignore */
      }
    }
    browserPopWin.destroy();
    browserPopWin = null;
  }
  send("evt:browser-detached", false); // 前端随后 browser:show 重新嵌回主窗口
});

// —— 账号 ——
ipcMain.handle("account:get", () => getAccount());
ipcMain.on("account:logout", () => {
  logout();
  send("evt:account", getAccount());
});

// Claude 订阅一键授权：跑 app 内 OAuth(PKCE)，成功返回 access_token(sk-ant-oat…)
// 渲染层拿到后自动填入并保存切换，无需手动 claude setup-token / 复制粘贴。
// 应用内弹窗授权(自行输账号密码，自动捕获回调)
ipcMain.handle("account:claude-login", async () => {
  log("claude-login-ipc", "应用内弹窗授权");
  const r = await claudeOAuthLogin();
  return r ? r.token : null;
});

// 系统浏览器授权 第1步：打开默认浏览器(可复用已登录 Google)
ipcMain.handle("account:claude-oauth-open", () => {
  log("claude-login-ipc", "打开系统浏览器授权");
  claudeOAuthOpenBrowser();
  return true;
});

// 系统浏览器授权 第2步：用回调页显示的授权码换 token
ipcMain.handle("account:claude-oauth-exchange", async (_e, code: string) => {
  log("claude-login-ipc", "用授权码换 token");
  const r = await claudeOAuthExchange(code);
  return r ? r.token : null;
});

// Codex 订阅一键授权：app 内跑 ChatGPT OAuth(本地 1455 回环)，写 ~/.codex/auth.json。
// 成功返回 true；由前端切到 codex 预设(复用其成熟切换逻辑) + 刷新账号。
ipcMain.handle("account:codex-login", async () => {
  log("codex-login-ipc", "应用内 ChatGPT 授权");
  const r = await codexOAuthLogin();
  if (!r) return false;
  // 持久化选中 codex + 重载 provider(读新写的 ~/.codex/auth.json)，前端账号随 evt:ready/account 刷新
  const s = loadSettings();
  if (s) saveSettings({ ...s, providerId: "codex", kind: "codex", model: s.model || "gpt-5.5" });
  try {
    initProvider();
    send("evt:ready", { backend: backendLabel, model: modelLabel, cwd, sub: subFlag, ctxWindow });
    void emitAccount();
  } catch (e) {
    log("codex-login-ipc", "重载 provider 失败", String(e));
  }
  return true;
});

// —— 无为账号登录（B2：登录闭环，独立于 codex/claude 账号态，不动 account.ts）——
// 登录 → 拿 /api/me(user+coin) → 明文持久化 ~/.wuwei/auth.json（B3 改 safeStorage 加密）。
ipcMain.handle("account:wuwei-login", async () => {
  const sess = await wuweiLogin();
  if (!sess) return null;
  saveWuweiSession(sess);
  const me = await wuweiFetchMe(sess.accessToken);
  if (me === "unauthorized" || !me) return null;
  return me;
});
// —— 应用内登录（邮箱密码/邮箱注册/手机验证码）：成功存会话+返回 {me}，失败返回 {error:文案} ——
async function finishWuweiSignin(
  r: WuweiSession | string,
  action: "login" | "register" = "login",
): Promise<{ me?: unknown; error?: string }> {
  if (typeof r === "string") return { error: r };
  saveWuweiSession(r);
  const me = await wuweiFetchMe(r.accessToken);
  if (me === "unauthorized" || !me) {
    return {
      error: action === "register" ? "注册成功，但拉取账号失败，请重开登录" : "登录成功，但拉取账号失败，请重试",
    };
  }
  return { me };
}
ipcMain.handle("account:wuwei-password-login", (_e, identifier: string, password: string) =>
  wuweiPasswordLogin(identifier, password).then((r) => finishWuweiSignin(r, "login")),
);
ipcMain.handle("account:wuwei-register", (_e, email: string, code: string, password: string) =>
  wuweiRegister(email, code, password).then((r) => finishWuweiSignin(r, "register")),
);
ipcMain.handle("account:wuwei-code-login", (_e, target: string, code: string) =>
  wuweiCodeLogin(target, code).then((r) => finishWuweiSignin(r, "login")),
);
ipcMain.handle("account:wuwei-send-code", (_e, target: string, lang?: string, purpose?: string) =>
  wuweiSendCode(target, lang, purpose),
);
// 冷启动/刷新：读本地会话 → /api/me；401 走 /api/refresh 续期后重试。
ipcMain.handle("account:wuwei-me", async () => {
  const sess = loadWuweiSession();
  if (!sess) return null;
  let me = await wuweiFetchMe(sess.accessToken);
  if (me === "unauthorized") {
    const fresh = await wuweiRefresh(sess.refreshToken);
    if (!fresh) {
      clearWuweiSession();
      return null;
    }
    saveWuweiSession(fresh);
    me = await wuweiFetchMe(fresh.accessToken);
  }
  return me === "unauthorized" || !me ? null : me;
});
ipcMain.handle("account:wuwei-logout", () => {
  clearWuweiSession();
  return true;
});
// 稳定设备指纹（灰度开关 & 免费试用额度共用）
ipcMain.handle("account:wuwei-device-id", () => getDeviceId());

// 动态拉当前平台的实时模型列表(/models)：OpenAI 兼容用 Bearer，Anthropic 用 x-api-key。
// 前端并入下拉(与预设去重)，新模型上线自动出现。订阅/无 key 的返回空、走预设。
ipcMain.handle("models:fetch", async () => {
  try {
    const cfg = loadConfig();
    if (cfg.provider === "codex") return []; // Codex 订阅无 models 接口
    let url: string;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cfg.provider === "anthropic") {
      if (cfg.authMode === "oauth" || !cfg.apiKey) return []; // 订阅 OAuth 无 x-api-key
      url = "https://api.anthropic.com/v1/models?limit=100";
      headers["x-api-key"] = cfg.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      if (!cfg.apiKey || cfg.apiKey === "not-needed") return [];
      const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
      url = base + "/models";
      headers.Authorization = "Bearer " + cfg.apiKey;
    }
    const r = await fetch(url, { headers });
    if (!r.ok) return [];
    const j: any = await r.json().catch(() => null);
    const ids = (j?.data || j?.models || [])
      .map((m: any) => (typeof m === "string" ? m : m?.id))
      .filter((x: any) => typeof x === "string");
    log("models:fetch", cfg.provider, "拿到", ids.length, "个模型");
    return ids as string[];
  } catch (e) {
    log("models:fetch", "出错", String(e).slice(0, 80));
    return [];
  }
});

// 读系统剪贴板(供「完成授权」自动取授权码)
ipcMain.handle("util:read-clipboard", () => clipboard.readText() || "");

// —— 无边框窗口控制（自绘标题栏用）——
ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("win:close", () => win?.close());
ipcMain.handle("win:is-maximized", () => !!win?.isMaximized());

// 用候选 API Key 试连通(不落库)：给平台临时套上这个 key 发个 ping，通过才让渲染层保存。
// override 可指定要测的平台/端点/模型(设置页里选的平台可能还不是当前生效的)。
ipcMain.handle(
  "conn:test-key",
  async (_e, key: string, override?: { provider?: string; baseUrl?: string; model?: string }) => {
  const k = (key || "").trim();
  if (!k) return { ok: false, reason: "空 key" };
  try {
    const cfg = loadConfig();
    const tcfg: any = { ...cfg, apiKey: k, authMode: "api-key", oauthToken: "" };
    if (override?.provider) {
      tcfg.provider = override.provider;
      tcfg.baseUrl = override.baseUrl || undefined; // anthropic 用默认端点，openai 用预设 baseUrl
    }
    if (override?.model) tcfg.model = override.model;
    const p = makeProvider(tcfg);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    await p.complete("", [{ role: "user", content: [{ type: "text", text: "ping" }] }], [], {
      signal: ac.signal,
    });
    clearTimeout(timer);
    return { ok: true, reason: "验证通过" };
  } catch (e: any) {
    return { ok: false, reason: (e?.message ? String(e.message) : String(e)).slice(0, 600) };
  }
});

// 当前平台是否已配置凭证(红灯判据：无凭证=不可用)
function hasCredential(cfg: ReturnType<typeof loadConfig>): boolean {
  if (cfg.provider === "codex") return !!cfg.codexToken;
  if (cfg.provider === "anthropic")
    return cfg.authMode === "oauth" ? !!cfg.oauthToken : !!cfg.apiKey;
  // 无为托管平台：key 不落 config、只在发送前注入 env，故这里以"已登录无为"为准。
  // 登录了即有凭证(判绿由后续真实 ping 决定；网关不通会转黄，而非红)。
  if (isHostedProvider(curProviderId())) return !!loadWuweiSession();
  // openai 兼容：有真实 key 即可；本地端点(localhost)无需 key。
  // 托管平台(通义千问/DeepSeek 等)虽有固定 baseUrl，但没 key 一样不可用→判红。
  const hasKey = !!cfg.apiKey && cfg.apiKey !== "not-needed";
  const isLocal = !!cfg.baseUrl && /(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(cfg.baseUrl);
  return hasKey || isLocal;
}

// 连通状态检测：红=未配置/未授权；绿=实测 ping 通；黄=已配置但请求报错
// 由渲染层在启动/切换平台/点灯时调用
ipcMain.handle("conn:check", async () => {
  const cfg = loadConfig();
  if (!hasCredential(cfg)) {
    return { status: "red", reason: "当前平台未配置凭证 / 未授权，无法使用。" };
  }
  if (!provider) return { status: "red", reason: "未初始化，请检查设置。" };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    // 极小 ping：不带工具、只发一句，验证鉴权+连通。顺带捕获响应里的订阅额度/余额头，切平台检测即刷新
    await provider.complete(
      "",
      [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      [],
      {
        signal: ac.signal,
        onRateLimits: (rl: unknown) => {
          const pid = curProviderId();
          saveRateLimits(pid, rl);
          send("evt:ratelimits", rl);
        },
      },
    );
    clearTimeout(timer);
    void emitAccount(); // 检测通过后刷新账户/余额(DeepSeek 等计费平台余额也随检测更新)
    return { status: "green", reason: `已连通 · ${backendLabel} / ${modelLabel}，可随时使用。` };
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    return { status: "yellow", reason: "已配置但请求报错：" + msg.slice(0, 600) };
  }
});

// 浏览器登录抓账号信息(头像/昵称)，存进当前平台的凭证槽
ipcMain.handle("account:web-login", async (_e, pid: string) => {
  log("web-login-ipc", "调用", pid);
  const info = await webLogin(pid);
  if (!info) {
    log("web-login-ipc", "webLogin 返回 null，不更新");
    return false;
  }
  const s = loadSettings();
  if (!s) return false;
  const c = { ...(s.creds || {}) };
  const avatar = (await toDataUri(info.avatar)) || c[pid]?.avatar; // 头像存成 data: URI
  c[pid] = {
    ...(c[pid] || {}),
    nickname: info.name || c[pid]?.nickname,
    avatar,
    webToken: info.token || c[pid]?.webToken, // 存 token，供以后静默刷新，过期才需重登
  };
  saveSettings({ ...s, creds: c });
  log(
    "web-login-ipc",
    "已存",
    pid,
    "昵称=", c[pid].nickname,
    "头像=", avatar ? "有" : "无",
    "token=", c[pid].webToken ? "有" : "无",
  );
  void emitAccount();
  return true;
});
