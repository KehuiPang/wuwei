// Electron 主进程：创建窗口，复用核心(agent/tools/config)，
// 通过 IPC 把 Agent 流式 hooks 推给渲染进程，权限确认走 IPC 往返。
import { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, shell, session, clipboard, Menu, safeStorage, Tray, nativeImage, dialog, screen, nativeTheme } from "electron";
import electronUpdater from "electron-updater";
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
import { systemPrompt, renderPrompt, DEFAULT_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT_EN } from "../../src/agent/prompt.js";
import { ALL_TOOLS, TOOL_MAP, MEMORY_FILE } from "../../src/tools/index.js";
import * as brain from "../../src/brain/index.js";
import type { Tool, ToolResult } from "../../src/types.js";
import { connectMcp, mcpTools, mcpToolsBySource, mcpStatus, loadMcpConfig, searchMcpRegistry, MCP_CONFIG_PATH } from "./mcp.js";
import * as secrets from "./secrets.js";
import { writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
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
  listTrash,
  restoreSession,
  purgeTrashItem,
  emptyTrash,
  autoPurgeTrash,
  deriveTitle,
  stripHandoffWrapper,
  listGroups,
  setSessionGroup,
  setSessionPriority,
  setSessionOrder,
  setSessionProject,
  setGroupsOrder,
  setSessionDone,
  setSessionDiscuss,
  setSessionRunning,
  clearInterrupted,
  dismissResume,
  markInterruptedOnStartup,
  flushAllSessionsSync,
} from "./sessions.js";
import { ensureFresh as ensureSearchIndex, searchSessions as searchInSessions } from "./search.js";
import {
  loadSettings,
  saveSettings,
  applyEnvFromSettings,
  detectSysLang,
  loadRateLimits,
  saveRateLimits,
  loadWindowBounds,
  saveWindowBounds,
  loadSessionBalances,
  saveSessionBalances,
  migrateFromMinicc,
  secretsDetectEnabled,
  brainEnabled,
  brainDocsEnabled,
  resumeDetectEnabled,
  type Settings,
  type SessionBal,
} from "./settings.js";

// 数据目录 .minicc→.wuwei 改名后的一次性迁移，须在任何数据读取前执行。
// —— 应用版本(edition)：wuwei(默认) / minicc。两者完全独立：appId、数据目录、单实例锁、窗口标题。
function resolveEdition(): "wuwei" | "minicc" {
  const fromArgv = process.argv.find((a) => a.startsWith("--edition="));
  let raw = (fromArgv ? fromArgv.split("=")[1] : "") || process.env.WUWEI_EDITION || "";
  if (!raw) {
    try {
      const exeName = (process.execPath || "").toLowerCase();
      const appName = (app.getName() || "").toLowerCase();
      if (exeName.includes("minicc") || appName.includes("minicc")) raw = "minicc";
    } catch {
      /* ignore */
    }
  }
  return raw.trim().toLowerCase() === "minicc" ? "minicc" : "wuwei";
}
const EDITION = resolveEdition();
const IS_MINICC = EDITION === "minicc";
const APP_NAME = IS_MINICC ? "minicc" : "无为";
// 窗口标题/托盘提示等「显示用」名字：英文界面显示 Wuwei。
// ⚠️ 只用于显示，绝不能拿去 app.setName()——那会改 userData 目录名，切个语言就把用户数据全丢了。
function appDisplayName(): string {
  return IS_MINICC ? "minicc" : process.env.WUWEI_LANG === "en" ? "Wuwei" : "无为";
}
const APP_ID = IS_MINICC ? "com.minicc.app" : "com.wuwei.app";
const DATA_DIR_NAME = IS_MINICC ? ".minicc" : ".wuwei";
process.env.WUWEI_DATA_DIR_NAME = DATA_DIR_NAME;
process.env.WUWEI_EDITION = EDITION;

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
  wuweiFetchCatalog,
  wuweiPasswordLogin,
  wuweiSendCode,
  wuweiCodeLogin,
  wuweiRegister,
  wuweiPayCreate,
  wuweiPayStatus,
  type WuweiSession,
} from "./wuwei-auth.js";
import { saveWuweiSession, loadWuweiSession, clearWuweiSession } from "./wuwei-session.js";
import { loadRemember, upsertRemember, clearRememberedPassword } from "./wuwei-remember.js";
import { getDeviceId } from "../../src/device-id.js";
import { log, LOG_FILE } from "./logger.js";

log("boot", `${APP_NAME} 主进程启动 (edition=${EDITION})`, "日志文件:", LOG_FILE);
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
let trayMenu: BrowserWindow | null = null; // 自绘托盘右键菜单（无框弹窗，替代原生 setContextMenu）
// 关闭按钮(✕)默认隐藏到托盘常驻；只有托盘「退出」/before-quit 把它置 true 才真正退出。
let quitting = false;

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
// ask_user(AI 弹选择框)往返：id → resolve；turnSid=当前正在跑的会话(供事件带 sid)
const pendingAsk = new Map<number, (answers: any) => void>();
// ask id → 发起该询问的会话 id：答案里带截图时，据此把图片注入回该会话的循环边界
const pendingAskSid = new Map<number, string>();
let askSeq = 0;
let turnSid = "";
// 崩溃恢复：本进程是否已做过一次「残留 running→interrupted」检测(在首个 bootstrap 请求里同步做，避免时序竞争)
let interruptDetected = false;
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
// 无为托管平台(providerId 以 "wuwei-" 开头)的品牌名——底层都走 openai 兼容端点，
// 不能用 cfg.provider(恒为 openai)当平台名，得按 providerId 映射真实品牌。
const HOSTED_BRAND: Record<string, string> = {
  deepseek: "DeepSeek",
  zhipu: "智谱 GLM",
  kimi: "Kimi",
  claude: "Claude",
  gpt: "GPT",
};
// 平台名的英文（只列中文项；纯英文品牌名两边通用，不必重复）。
// 渲染层通常按 providerId 查自己的 PRESET_EN 显示，这里是预设里查不到时的兜底，同样得跟语言。
const PROVIDER_LABELS_EN: Record<string, string> = {
  codex: "Codex subscription",
  "claude-oauth": "Claude subscription",
  qwen: "Qwen",
  doubao: "Doubao",
  zhipu: "Zhipu GLM",
  hunyuan: "Tencent Hunyuan",
  custom: "Custom endpoint",
};
function providerLabel(pid: string): string | undefined {
  const en = process.env.WUWEI_LANG === "en";
  return (en && PROVIDER_LABELS_EN[pid]) || PROVIDER_LABELS[pid];
}
function labelFor(cfg: ReturnType<typeof loadConfig>, providerId?: string): string {
  if (providerId && PROVIDER_LABELS[providerId]) return providerLabel(providerId)!;
  // 无为托管：显示「无为托管 · 品牌」，别露出底层 openai
  if (providerId && providerId.startsWith("wuwei-")) {
    if (providerId === "wuwei-free") return tt("无为 · 免费体验", "Wuwei · Free trial");
    const base = providerId.slice("wuwei-".length);
    // providerLabel 优先：HOSTED_BRAND 里的 zhipu 是中文「智谱 GLM」，英文得走 PROVIDER_LABELS_EN
    return `${tt("无为托管", "Wuwei Hosted")} · ${providerLabel(base) || HOSTED_BRAND[base] || base}`;
  }
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
    title: tt("登录获取账号信息", "Sign in to fetch account info"),
    ...(existsSync(join(__dirname, "../../build/icon.png")) ? { icon: join(__dirname, "../../build/icon.png") } : {}),
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
// 直连 Kimi（Moonshot）余额：用 API Key 调官方余额接口 {baseUrl}/users/me/balance（同一个 key）。
async function moonshotBalance(apiKey: string, baseUrl: string): Promise<{ total: number } | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/users/me/balance`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { available_balance?: number } };
    const bal = j?.data?.available_balance;
    return typeof bal === "number" ? { total: bal } : null;
  } catch (e) {
    log("moonshotBalance", "拉余额异常", String(e));
    return null;
  }
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
      label: tt("Codex 订阅", "Codex subscription"),
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
      label: plan ? `${tt("Claude 订阅", "Claude subscription")} · ${plan}` : tt("Claude 订阅", "Claude subscription"),
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
      label: expired ? tt("Kimi Code 订阅 · 额度登录已过期", "Kimi Code subscription · quota login expired") : tt("Kimi Code 订阅", "Kimi Code subscription"),
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
      label: expired ? tt("智谱 GLM · 登录已过期", "Zhipu GLM · login expired") : tt("智谱 GLM", "Zhipu GLM"),
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
  if (pid === "kimi") {
    // 直连 Kimi（Moonshot）：用 API Key 拉官方余额（¥）显示；无 key 则只显示 token
    const loggedIn = !!st?.apiKey;
    if (!loggedIn) {
      send("evt:account", { providerId: pid, label: "Kimi", loggedIn, email: null, nickname, avatar });
      return;
    }
    const baseUrl = st?.creds?.["kimi"]?.baseUrl || loadConfig().baseUrl || "https://api.moonshot.cn/v1";
    const bal = await moonshotBalance(st.apiKey!, baseUrl);
    send("evt:account", {
      providerId: pid,
      label: "Kimi",
      loggedIn,
      email: null,
      nickname,
      avatar,
      balance: bal ? { total: bal.total.toFixed(2), currency: "CNY" } : undefined,
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

// 脑网络说明的默认提示词(可在「知识网络」设置里查看/覆盖)。追加的『已沉淀概念』动态目录不含在内。
export const DEFAULT_BRAIN_NOTE =
  `\n\n## 本地知识网络（Brain）\n你有一个本地概念知识网络，沉淀着项目/服务器/脚本/部署/注意事项等结构化知识。\n- 涉及具体项目或部署/环境的任务，**开工前先用 brain_recall 检索**，按返回的结构化子图行动，别每次全量翻文档、省 token。\n- 发现值得长期固化的高价值知识（项目背景、git路径、测试/线上环境、部署脚本位置、踩坑注意事项）时，用 brain_learn 记住、brain_link 串联关系；旧信息有误就用同名 brain_learn 覆盖纠正。\n- brain_recall 还会命中知识宫殿等文档库的原文片段（『相关文档』），只给摘要+路径；需要完整内容时用 brain_read_doc 按该路径读全文，不必全量翻。`;
// 英文版脑网络说明（跟随界面语言）
export const DEFAULT_BRAIN_NOTE_EN =
  `\n\n## Local knowledge network (Brain)\nYou have a local concept knowledge network holding structured knowledge about projects/servers/scripts/deployments/caveats.\n- For tasks about a specific project or deployment/environment, **run brain_recall first** and act on the returned structured subgraph — don't re-read whole docs every time (saves tokens).\n- When you find high-value knowledge worth keeping (project background, git paths, test/prod environments, where deploy scripts live, pitfalls), save it with brain_learn and connect relations with brain_link; correct stale info by brain_learn with the same name.\n- brain_recall also surfaces source snippets from doc libraries ("related docs") as summary+path only; when you need the full text, read it by that path with brain_read_doc instead of scanning everything.`;

// 构造系统提示词：优先本平台专属覆盖(creds[pid].systemPrompt)，再全局(settings.systemPrompt)，都没有=默认模板；渲染 {model}/{cwd}
function buildSysPrompt(cwd: string, model: string, providerId?: string): string {
  const st = loadSettings();
  const lang = st?.app?.lang === "en" ? "en" : st?.app?.lang === "zh" ? "zh" : detectSysLang(); // 未手动设过→按系统语言
  const override = providerId ? st?.creds?.[providerId]?.systemPrompt : undefined;
  const custom = typeof override === "string" ? override : st?.systemPrompt;
  let base = typeof custom === "string" ? renderPrompt(custom, cwd, model) : systemPrompt(cwd, model, lang);
  // 记忆：始终告知可用 remember 工具，并附上已记住的内容(跨会话)
  const mem = loadMemory().trim();
  base +=
    lang === "en"
      ? `\n\n## Long-term memory\nWhen the user says "remember…/from now on…/I prefer…", or shares info worth keeping long-term (preferences, how to address them, facts, project background), call the remember tool; it auto-loads into every future conversation.`
      : `\n\n## 长期记忆\n用户说“记住…/以后…/我喜欢…”或出现值得长期保留的信息(偏好、称呼、事实、项目背景)时，调用 remember 工具写入；它会在之后每次对话自动加载。`;
  if (mem) base += lang === "en" ? `\n\nRemembered (follow/refer to actively):\n${mem}` : `\n\n已记住（需主动遵守/参考）：\n${mem}`;
  // 本地知识网络（Brain）：概念化的项目/部署知识，按需 recall；提示词可在设置里覆盖。
  // 关掉「脑网络」或非会员：不注入说明、不追加概念目录(brain_* 工具也在别处一并停掉)。
  if (brainAvailable(st)) {
    base += typeof st?.brainPrompt === "string" ? st.brainPrompt : (lang === "en" ? DEFAULT_BRAIN_NOTE_EN : DEFAULT_BRAIN_NOTE);
    try {
      const idx = brain.conceptIndex(40);
      // 这段拼在系统提示里，中文会把英文用户的回复语言也带偏，跟着 lang 走
      if (idx.length)
        base +=
          lang === "en"
            ? `\nConcepts already stored (expand with brain_recall): ${idx.join(", ")}`
            : `\n已沉淀的概念（可 brain_recall 展开）：${idx.join("、")}`;
    } catch {
      /* brain 不可用不影响主流程 */
    }
  }
  // 密钥说明：告知模型密钥走本地保险箱/环境变量，无需明文；提示词可在设置里覆盖
  base += typeof st?.secretsPrompt === "string" ? st.secretsPrompt : (lang === "en" ? secrets.SECRETS_SYSTEM_NOTE_EN : secrets.SECRETS_SYSTEM_NOTE);
  // 与用户交互：需要用户拍板时必须弹选择框(强引导，否则模型习惯用文字罗列)
  base +=
    lang === "en"
      ? `\n\n## Interacting with the user (must follow)\nWhenever you need the user to choose, confirm, or decide among a few concrete options — e.g. "approach A or B", "which file to delete", "continue or not", "which branch" — you **must call the ask_user tool** to show clickable choices. **Do not** list options in prose like "Option A / Option B" or "1. … 2. …" and make the user type. Single-select, multi-select, and multiple questions at once are supported. Only ask in prose when the answer is free text (not picked from options). This overrides your usual habit of asking in prose.`
      : `\n\n## 与用户交互（务必遵守）\n每当你要让用户在几个明确选项里做选择、确认或拍板——例如“走方案A还是B”“删哪个文件”“要不要继续”“选哪个分支”——你**必须调用 ask_user 工具**弹出可点击选择框，**禁止**在正文里用“方案A/方案B”“1. …2. …”这类文字罗列选项让用户打字。单选/多选/一次多问都支持。只有当答案是自由文本(不是从选项里挑)时，才在正文直接问。这条优先于你平时“用文字提问”的习惯。`;
  return base;
}

// 把「扫描相关文档」开关同步到 brain 模块(recall 据此决定是否连带扫文档冷存储)
function syncBrainDocsFlag(st: Settings | null) {
  try {
    brain.setDocsEnabled(brainDocsEnabled(st));
  } catch {
    /* brain 不可用不影响主流程 */
  }
}

function initProvider() {
  cwd = process.cwd();
  const st = loadSettings();
  applyEnvFromSettings(st); // 有已保存设置则据此，否则自动推断
  syncBrainDocsFlag(st);
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
function applySettings(sIn: Settings) {
  // 合并到磁盘现有配置:调用方只需传自己要改的字段,其余(会话提醒/保留条数/输出方式/主题/app 等
  // 各走独立 IPC 存的设置)一律保留、不被整体替换覆盖。显式传 undefined 仍可清字段(切平台清 key 用)。
  const s: Settings = { ...(loadSettings() || {}), ...sIn };
  log("applySettings", "平台=", s.providerId, "模型=", s.model, "有key=", !!s.apiKey);
  saveSettings(s);
  applyEnvFromSettings(s);
  syncBrainDocsFlag(s);
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
  refreshAgentTools(); // 「知识网络」开关变了→即时给所有会话加/摘 brain_* 工具
  send("evt:ready", { backend: backendLabel, model: modelLabel, cwd, sub: subFlag, ctxWindow });
  void emitAccount(); // 切平台后左下角账号/余额随之更新
  if (s.providerId) void silentRefreshAccount(s.providerId); // 用存的 token 静默刷新，无需重登
}

// Claude 订阅 OAuth：token 快过期时用 refresh_token 静默续期，避免请求报 401「token expired/invalid」。
// 只动 app 自己的 token(settings.oauthToken + sidecar 文件)，绝不碰 ~/.claude.json（避免搞挂 Claude Code 登录）。
// 老用户(有 oauthToken 但无 sidecar/refresh) → 不动，手动重登一次后即自动续期。
let refreshingClaude: Promise<void> | null = null;
// 确认已过期且救不回来 → 把失效 token 从设置里清掉。
// 留着它只会让每次请求都撞 401「授权过期」，用户还得自己去设置里点 × 清空；
// 清掉后界面会提示重新授权，配了 API Key 的则自动回落到 Key。
function clearDeadClaudeOAuth(why: string): void {
  const s = loadSettings();
  if (!s) return;
  const slot = s.creds?.["claude-oauth"];
  if (!s.oauthToken && !slot?.oauthToken) return; // 已经清过，别重复通知
  log("claudeOAuth", "token 已过期且无法续期(", why, ") → 清除失效 token");
  s.oauthToken = undefined;
  if (slot) slot.oauthToken = undefined;
  saveSettings(s);
  applyEnvFromSettings(s);
  provider = makeProvider(loadConfig());
  for (const a of agents.values()) a.setProvider(provider);
  send("evt:error", {
    message: tt(
      "Claude 订阅授权已过期，已自动清除失效 token。请在设置里重新授权，或改用 API Key。",
      "Your Claude subscription authorization expired; the dead token has been cleared. Re-authorize in settings, or switch to an API key.",
    ),
  });
}
// 这个错误是不是「OAuth token 已失效」——只认鉴权类信号，别把限流/余额/网络错误也当成失效把 token 清了
function isOAuthDead(e: any): boolean {
  const status = Number(e?.status || 0);
  const msg = String(e?.message || e || "").toLowerCase();
  if (status === 401 || status === 403) return true;
  return /\b401\b|invalid[_ ]?token|token (has )?expired|oauth token (expired|revoked|invalid)|unauthorized/.test(msg);
}
async function ensureFreshClaudeOAuth(): Promise<void> {
  const st = loadSettings();
  if (!st || st.kind !== "anthropic-oauth") return;
  const auth = loadClaudeAuth();
  if (!auth?.refreshToken || !auth.expiresAt) {
    // 无 refresh/过期信息(老用户或 sidecar 丢失)：能判定已过期就清掉，否则交给手动重登
    if (auth?.expiresAt && auth.expiresAt <= Date.now()) clearDeadClaudeOAuth("no-refresh-token");
    return;
  }
  if (auth.expiresAt - Date.now() > 5 * 60 * 1000) return; // 还有 >5 分钟 → 无需续期
  if (refreshingClaude) return refreshingClaude; // 合并并发，避免同一时刻多次刷新
  refreshingClaude = (async () => {
    try {
      log("claudeOAuth", "token 将过期，静默续期…");
      const r = await claudeOAuthRefresh(auth.refreshToken!); // 内部已把新值写回 sidecar
      if (!r?.token) {
        // 已过期才清：网络抖动导致的临时续期失败(尚未过期)保留旧 token，下次再试
        if (auth.expiresAt! <= Date.now()) clearDeadClaudeOAuth("refresh-failed");
        else log("claudeOAuth", "续期失败但尚未过期，保留旧 token，稍后重试");
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
      if (!/^https?:\/\//i.test(url)) return { content: tt("URL 需以 http/https 开头", "URL must start with http/https"), isError: true };
      const wc = getBrowserView().webContents;
      requestShowBrowser(); // 让前端弹出浏览器面板，用户可实时看
      try {
        await wc.loadURL(url);
      } catch (e: any) {
        // 部分重定向会抛 ERR_ABORTED 但页面其实已加载→已导航就当成功
        if (!wc.getURL() || wc.getURL() === "about:blank") throw e;
      }
      return {
        content: tt(`已打开：${wc.getTitle()}（${wc.getURL()}）。可用 browser_read 读正文、browser_click 点击。`, `Opened: ${wc.getTitle()} (${wc.getURL()}). Use browser_read for text, browser_click to click.`),
      };
    } catch (e: any) {
      return { content: tt(`打开失败: ${e.message}`, `Open failed: ${e.message}`), isError: true };
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
      return { content: (t.length > max ? t.slice(0, max) + tt(`\n…(已截断，共 ${t.length} 字符)`, `\n…(truncated, ${t.length} chars total)`) : t) || tt("(页面无文本)", "(no page text)") };
    } catch (e: any) {
      return { content: tt(`读取失败: ${e.message}（可能还没 browser_open）`, `Read failed: ${e.message} (maybe browser_open wasn't called yet)`), isError: true };
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
      return r === "OK" ? { content: tt(`已点击 ${sel}`, `Clicked ${sel}`) } : { content: tt(`未找到元素 ${sel}`, `Element not found: ${sel}`), isError: true };
    } catch (e: any) {
      return { content: tt(`点击失败: ${e.message}`, `Click failed: ${e.message}`), isError: true };
    }
  },
};
const BROWSER_TOOLS: Tool[] = [browserOpenTool, browserReadTool, browserClickTool];

// ask_user：让 AI 弹出可点击的选择框(单选/多选/可多问)，暂停等用户点选后把选择回传。
// 走「暂停-回传」范式(同权限确认)：run 返回 Promise 挂 pendingAsk，前端选完 ipc 回来 resolve。
const askUserTool: Tool = {
  name: "ask_user",
  description:
    "【首选交互方式】只要你打算让用户在几个明确选项里选择、确认或拍板，就调用本工具弹出可点击选择框，" +
    "不要在正文用文字罗列『方案A/方案B』『1./2.』让用户打字。支持单选/多选/一次多个问题。" +
    "multiSelect=true 允许多选。适合：方案/文件/分支间挑选、确认偏好、二选一、要不要继续等。" +
    "只有需要用户自由文本作答(非选项)时才在正文直接问。" +
    '最简调用示例：{"questions":[{"question":"走哪个方案？","options":[{"label":"方案A"},{"label":"方案B"}]}]}',
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "要问用户的一个或多个问题",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "问题正文" },
            header: { type: "string", description: "很短的标签(可选，如「方案」「文件」)" },
            multiSelect: { type: "boolean", description: "是否允许多选(默认单选)" },
            options: {
              type: "array",
              description: "供点击的选项",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "选项文字" },
                  description: { type: "string", description: "选项说明(可选)" },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  async run(input, ctx): Promise<ToolResult> {
    const questions = Array.isArray((input as any).questions) ? (input as any).questions : [];
    if (!questions.length) return { content: tt("ask_user 需要至少一个带 options 的问题", "ask_user needs at least one question with options"), isError: true };
    const id = ++askSeq;
    // 绑定到「执行本工具的会话」——用 ctx.sessionId(每个 Agent 自带)，不是全局 turnSid。
    // 多会话并发时 turnSid 会被最后派发的会话覆盖，导致弹窗/通知指向错的会话。
    const askSid = ctx.sessionId || turnSid;
    const answers: any = await new Promise((resolve) => {
      pendingAsk.set(id, resolve);
      pendingAskSid.set(id, askSid);
      send("evt:ask-user", { sid: askSid, id, questions });
    });
    if (!answers || answers.cancelled) return { content: tt("用户取消了选择(未作答)。", "User cancelled the selection (no answer).") };
    const list: { selected?: string[]; text?: string }[] = answers.list || [];
    const lines = questions.map((q: any, i: number) => {
      const a = list[i] || {};
      const parts = [...(a.selected || [])];
      if (a.text) parts.push(a.text); // 用户在「其它」里填的自由文本
      return `${i + 1}. ${q.question} → ${parts.length ? parts.join(tt("、", ", ")) : tt("(未选)", "(no selection)")}`;
    });
    return { content: tt("用户的选择：\n", "User's selections:\n") + lines.join("\n") };
  },
};

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

// 桌面版工具集 = 共享工具 + 浏览器工具 + 动态 MCP 工具(连上后加入)，全部过密钥安全包装。
// 设置里关掉「知识网络」→ 一并摘掉 brain_* 工具，别再让模型调用(与系统提示注入的开关同源)。
// 脑网络（brain）为会员专享：非会员即使设置开着也一律停用（不注入说明、不给 brain_* 工具）。
// isProCached 由 fetchMe 的 membership 更新；普通「记忆」(remember/长期记忆) 不受此门控，全员可用。
let isProCached = false;
function brainAvailable(st: ReturnType<typeof loadSettings>): boolean {
  return brainEnabled(st) && isProCached;
}
// 主进程界面文案双语：按 WUWEI_LANG(设置时写入)出中/英，供返回给渲染层的 reason/message/text 等用。
function tt(zh: string, en: string): string {
  return process.env.WUWEI_LANG === "en" ? en : zh;
}
// 工具描述/参数说明的英文版（发给模型那份；界面显示侧另有渲染端 TOOL_DESC_EN）。
// WUWEI_LANG=en 时把内置工具的中文描述替换为英文，让英文用户的模型上下文也全英文。
const TOOL_DESC_EN_MODEL: Record<string, string> = {
  read_file: "Read a text file's content with line numbers. For viewing code/files.",
  write_file: "Write/overwrite a file (creates it and parent dirs if missing).",
  edit_file: "Make an exact string replacement in a file. old_string must appear exactly once, or it errors.",
  bash: "Run a shell command in the working dir (bash on macOS/Linux). Returns stdout+stderr. Default timeout 120s.",
  powershell: "Run native Windows commands (PowerShell first, auto-falls back to cmd). Best for junctions/symlinks, the registry, services/processes, WMI — more reliable than wrapping cmd inside bash. Falls back to a normal shell off Windows.",
  glob: "Find files by glob pattern (e.g. '**/*.ts'), returns matching paths.",
  grep: "Search file contents by regex/string, returns matching lines (file:line:content).",
  remember: "Save a long-term memory (a concise, self-contained sentence); auto-loaded in future chats.",
  web_search: "Search the web — returns titles/links/snippets of relevant pages.",
  web_fetch: "Fetch a web page's main text (HTML stripped). For reading docs, articles, API pages.",
  brain_recall: "Recall relevant concepts and relations from the local Brain (knowledge graph).",
  brain_learn: "Record or update a high-value concept in the local Brain (same name auto-merges). For durable knowledge: what a project is, git paths, test/prod env, deploy scripts, caveats. attrs holds structured key-values.",
  brain_link: "Create a relation between two concepts in the Brain.",
  brain_forget: "Remove a wrong/outdated concept (and all its relations) from the Brain. Use only when sure it's wrong.",
  brain_read_doc: "Read the full source of a document indexed in the Brain.",
  ask_user: "[Preferred interaction] Whenever you want the user to pick/confirm among clear options, call this to pop up clickable choices instead of listing 'Option A/B' in prose. Supports single/multi-select and multiple questions.",
  browser_open: "Open a web page URL in the built-in browser (can run JS; better than web_fetch for dynamic/interactive pages). Then use browser_read for text and browser_click to click.",
  browser_read: "Read the visible text of the built-in browser's current page (open one first with browser_open).",
  browser_click: "Click an element matching a CSS selector on the built-in browser's current page (buttons/links etc). Follow with browser_read to see changes.",
};
// ask_user 的参数说明（嵌套在 questions.items / options.items 里），主进程与设置页共用同一套文案
const ASK_USER_PARAM_EN: Record<string, string> = {
  questions: "One or more questions to ask the user",
  question: "The question text",
  header: "Very short label (optional, e.g. “Approach”, “File”)",
  multiSelect: "Allow multiple selections (default: single-select)",
  options: "Clickable options",
  label: "Option text",
  description: "Option explanation (optional)",
};
const TOOL_PARAM_EN_MODEL: Record<string, Record<string, string>> = {
  read_file: { path: "File path (relative or absolute)", offset: "Start line (1-based), optional", limit: "Lines to read, default 2000" },
  edit_file: { replace_all: "Replace all occurrences, default false" },
  bash: { timeout_ms: "Timeout in ms, default 120000" },
  powershell: { command: "Command to run (PowerShell syntax; the same string is run as cmd syntax when falling back)", timeout_ms: "Timeout in ms, default 120000" },
  glob: { path: "Search root directory, default working dir" },
  grep: { path: "Directory/file to search, default working dir", glob: "Filter by file type, e.g. '*.ts' (optional)" },
  web_search: { query: "Search query" },
  web_fetch: { url: "Web page URL (http/https)" },
  remember: { text: "One line to remember long-term (concise, self-contained)" },
  brain_recall: { query: "Topic/concept to recall, e.g. 'figcheck deploy'", limit: "Max concepts to return, default 6" },
  brain_learn: {
    name: "Primary concept name, e.g. 'figcheck', 'deploy_view_prod.sh'",
    type: "Type: project / server / script / caveat / command / concept…",
    summary: "One-line summary",
    aliases: "Aliases, optional",
    attrs: "Structured key-value attributes, e.g. {git: '~/...', test_env: 'fig01'}",
  },
  brain_link: { from: "Source concept", relation: "Relation: deploy script / test env / prod server / contains / caveat / related…", to: "Target concept" },
  brain_forget: { name: "Concept name to remove" },
  brain_read_doc: { ref: "Document relative path or chunk id (the file value returned by brain_recall)" },
  browser_click: { selector: "CSS selector" },
  ask_user: ASK_USER_PARAM_EN,
};
// 深度替换 inputSchema 里所有层级的 description（ask_user 的选项/问题是嵌套在 items 里的，
// 只译顶层会让英文用户的模型上下文里混着中文字段说明）
function localizeSchemaEn(name: string, schema: any): any {
  const pmap = TOOL_PARAM_EN_MODEL[name];
  if (!pmap || !schema || typeof schema !== "object") return schema;
  const walk = (node: any): any => {
    if (!node || typeof node !== "object") return node;
    const out: any = { ...node };
    if (out.properties && typeof out.properties === "object") {
      const props: any = {};
      for (const [k, v] of Object.entries(out.properties as Record<string, any>)) {
        const child = walk(v);
        props[k] = pmap[k] ? { ...child, description: pmap[k] } : child;
      }
      out.properties = props;
    }
    if (out.items) out.items = walk(out.items);
    return out;
  };
  return walk(schema);
}
function localizeToolEn(t: Tool): Tool {
  const desc = TOOL_DESC_EN_MODEL[t.name];
  if (!desc && !TOOL_PARAM_EN_MODEL[t.name]) return t;
  return { ...t, description: desc ?? t.description, inputSchema: localizeSchemaEn(t.name, t.inputSchema) };
}

function desktopTools(): Tool[] {
  const brainOn = brainAvailable(loadSettings());
  const base = brainOn ? ALL_TOOLS : ALL_TOOLS.filter((t) => !t.name.startsWith("brain_"));
  const en = process.env.WUWEI_LANG === "en";
  let tools = [...base, askUserTool, ...BROWSER_TOOLS, ...mcpTools()];
  if (en) tools = tools.map(localizeToolEn); // 英文用户：模型侧工具描述也走英文
  return tools.map(wrapSecret);
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
    a = new Agent(provider, sysPrompt, desktopTools(), { cwd, sessionId: id }, desktopToolMap(), agentOpts);
    a.setMessages(loadMessages(id));
    const meta = listSessions().find((s) => s.id === id); // 恢复该会话的用量
    if (meta?.usage) a.setUsage(meta.usage);
    agents.set(id, a);
  }
  return a;
}

const EMPTY_USAGE = { totalInput: 0, totalOutput: 0, lastInput: 0, totalCacheHit: 0, totalCacheMiss: 0, totalSteps: 0 };
// 切换/加载会话后推送该会话自己的用量
function sendUsageFor(id: string) {
  const a = agents.get(id);
  send("evt:usage", a ? a.getUsage() : EMPTY_USAGE);
}

// 启动时：选最近会话或新建，推送列表与当前会话历史
function bootstrapSessions() {
  autoPurgeTrash(); // 启动先清掉回收站里超过 7 天的
  const list = listSessions();
  currentId = list[0]?.id ?? randomUUID();
  const a = getAgent(currentId);
  send("evt:sessions", listSessions());
  send("evt:trash", listTrash());
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
  if (now - (draftSaveAt.get(id) || 0) < 600) return; // 更勤落盘：强杀时少丢正在生成的回复
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
// 保留末尾 n 字：助手回复的「下一步问题/建议」几乎都在结尾，从头截断会把它切掉，故取尾。
function msgTextTail(m: any, n: number): string {
  return (m.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ")
    .trim()
    .slice(-n);
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
  const en = process.env.WUWEI_LANG === "en"; // 标题是给用户看的，必须跟随界面语言
  const convo = picked
    .map((m: any) => {
      // 剥掉交接前言只留正文；首条(定主题)多给点字数，确保覆盖到"目标+项目"这几节
      const body = stripHandoffWrapper(msgText(m)).trim().slice(0, m === firstUser ? 500 : 200);
      return `${m.role === "user" ? tt("用户", "User") : tt("助手", "Assistant")}: ${body}`;
    })
    .filter((s: string) => s.length > 3)
    .join("\n");
  try {
    const res = await provider.complete(
      tt(
        "你是会话标注器。根据对话(尤其最新内容)输出两项，用竖线分隔：" +
          "①4-10 个汉字的简短中文标题(概括当前主题)；②2-6 字的项目/产品名或主题域(用于归类，如某系统名/某功能域，若无明显项目就填通用主题)。" +
          "严格只输出「标题|项目」，不要任何引号、解释、多余空格。",
        "You are a conversation labeler. Read the conversation (weighting the latest turns) and output two fields separated by a vertical bar: " +
          "(1) a short English title, 2-5 words, summarizing the current topic; (2) a 1-3 word project/product name or topic domain used for grouping " +
          "(e.g. a system or feature area; if there is no obvious project, give a general topic). " +
          "Output strictly `Title|Project` in English — no quotes, no explanation, nothing else.",
      ),
      [
        {
          role: "user",
          content: [{ type: "text", text: tt(`对话:\n${convo}\n\n标题|项目:`, `Conversation:\n${convo}\n\nTitle|Project:`) }],
        },
      ] as any,
      [],
      {},
    );
    const raw = (res.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      // 推理模型(z1 等)会带 <think>…</think>：先整块剥掉，别让标签漏进标题
      .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
      .replace(/^\s*<think(?:ing)?>[\s\S]*$/i, "") // 极端情况：只有未闭合的 <think>
      .trim();
    const [rawTitle, rawProject] = raw.split(/[|｜]/);
    // 中文标题不留空格；英文必须保留词间空格(否则 "Fix checkout tests" 会被粘成 "Fixcheckouttests")，
    // 长度上限也要放宽——同样信息量英文字符数是中文的两三倍。
    const clean = (t?: string) =>
      (t || "").replace(en ? /["'`。，、：！!？?（）()【】\[\]<>]/g : /[\s"'`。，、：:！!？?（）()【】\[\]<>]/g, "").replace(/\s+/g, " ").trim();
    const title = clean(rawTitle).slice(0, en ? 40 : 12);
    const project = clean(rawProject).slice(0, en ? 24 : 8);
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
    send("evt:suggest", { sid: id, text: "", canContinue: false });
    return;
  }
  suggestInFlight.add(id);
  const en = process.env.WUWEI_LANG === "en"; // 建议会原样填进输入框，必须跟随界面语言
  const recent = msgs.slice(-4);
  const convo = recent
    .map((m: any, i: number) =>
      // 最后一条助手回复取「结尾」(下一步问题/待办常在末尾)，中间几条取开头做背景即可。
      `${m.role === "user" ? tt("用户", "User") : tt("助手", "Assistant")}: ${i === recent.length - 1 ? msgTextTail(m, 600) : msgText(m)}`,
    )
    .filter((s: string) => s.length > 3)
    .join("\n");
  const lastReplyTail = msgTextTail(last, 600); // 助手最后回复的结尾——预测下一步只认它
  const g = sessionGoals[id];
  const goalBlock = g && g.active ? g.text.slice(0, 600) : ""; // 智能继续：会话总目标
  const sr = stopRules.trim(); // 智能继续：自定义红线
  try {
    const res = await provider.complete(
      tt(
        "你是输入建议助手。下面对话里，助手『最后一条回复』的结尾通常会提出一个问题、或建议一个待确认的下一步动作。" +
          "请【只针对助手最后回复结尾的那个问题/下一步】，用中文写出用户最可能的回应(第一人称或祈使句，像用户自己会打的话，不超过20字)——" +
          "比如结尾问『要我继续部署吗?』就回『继续部署』/『先本地验证』这类。" +
          "务必忽略对话中间的其它话题，别自己另起一件事。\n" +
          "输出两行，不要引号、解释或前缀：\n" +
          "第1行：那句话本身；若结尾没有明确的问题或待确认的下一步(助手在等用户自由发挥)，第1行只写：无\n" +
          "第2行：只写 AUTO 或 ASK。\n" +
          "AUTO = 助手只是在确认按它已说明的方案往下推进，且这一步属于寻常低风险的事：本地或测试环境的操作、只读的检查与验证、查资料研究、改代码写文件、跑测试、构建、生成文档、整理数据。" +
          "助手在结尾列了几条『可选的下一步』让用户挑，也算 AUTO——第1行直接替用户挑最贴近目标的那条说出来，别把选择题原样丢回去。\n" +
          "ASK = 只有这些才停下来问人：删除/清空/覆盖数据、部署或上线到生产正式环境、发布对外内容、改线上配置或写生产数据库、花钱付款、替用户发邮件或消息、改权限与安全设置、任何不可逆或会影响他人的动作；或者要用户提供只有他才有的东西(账号、密钥、服务器、线下信息)、上一步出错需要用户定夺、几个方案的差别纯粹取决于用户偏好而无从推断。\n" +
          "『要我继续吗』『下一步做 X 好吗』『可以选 A 或 B』这类一律 AUTO，别当成需要用户拿主意。" +
          (goalBlock
            ? "\n用户给这个对话定了总目标：" + goalBlock +
              "\n他已经授权你朝这个目标自主推进，所以【朝目标推进的常规步骤一律写 AUTO】，第1行就写出推进下一步该说的话(别问要不要，直接说做什么)。只有下面 ASK 的红线才停。"
            : "") +
          (sr ? "\n用户自己定的红线(命中就必须写 ASK，优先级最高)：\n" + sr : ""),
        "You suggest what the user will type next. In the conversation below, the END of the assistant's LAST reply usually asks a question " +
          "or proposes a next step awaiting confirmation. Answer ONLY that question/next step: write, in English, the reply the user is most likely " +
          "to type (first person or imperative, the way a user actually types, under 12 words) — e.g. if it ends with 'Want me to deploy?', " +
          "answer 'Go ahead and deploy' or 'Verify locally first'. Ignore other topics earlier in the conversation and do not start something new.\n" +
          "Output TWO lines, no quotes, no explanation, no prefix:\n" +
          "Line 1: that single line; if the ending has no clear question or pending next step (assistant is waiting for the user to lead), write exactly: none\n" +
          "Line 2: write only AUTO or ASK.\n" +
          "AUTO = the assistant is just confirming it should proceed along a plan it already described, and this step is ordinary low-risk: local/test-env actions, read-only checks and verification, research, editing code/writing files, running tests, builds, generating docs, organizing data. " +
          "If the assistant listed a few optional next steps to pick from, that is also AUTO — on line 1 pick the one closest to the goal and say it, don't echo the menu back.\n" +
          "ASK = stop and ask only for: deleting/clearing/overwriting data, deploying/releasing to production, publishing external content, changing live config or writing to a production DB, spending money, sending mail/messages on the user's behalf, changing permissions/security, anything irreversible or affecting others; or needing something only the user has (account, key, server, offline info), a prior step errored and needs the user to decide, or options differ purely by user preference and can't be inferred.\n" +
          "'Want me to continue', 'shall I do X next', 'pick A or B' are all AUTO, not user-decision." +
          (goalBlock
            ? "\nThe user set an overall goal for this conversation: " + goalBlock +
              "\nThey authorized you to drive toward it autonomously, so [ordinary steps advancing the goal are always AUTO]; line 1 states the next step to take (don't ask whether — say what to do). Only the ASK redlines below stop you."
            : "") +
          (sr ? "\nThe user's own redlines (hitting any one MUST be ASK, highest priority):\n" + sr : ""),
      ),
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: tt(
                `完整对话(供参考):\n${convo}\n\n【助手最后回复的结尾，就针对它作答】:\n${lastReplyTail}\n\n用户接下来最可能输入:`,
                `Full conversation (for context):\n${convo}\n\n[END of the assistant's last reply — answer THIS]:\n${lastReplyTail}\n\nWhat the user most likely types next:`,
              ),
            },
          ],
        },
      ] as any,
      [],
      {},
    );
    const whole = (res.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    const lines = whole.split("\n").map((s: string) => s.trim()).filter(Boolean);
    let raw = (lines[0] || "")
      .replace(/^["'「『]|["'」』]$/g, "")
      .slice(0, en ? 90 : 40); // 英文同样意思字符数是中文的两三倍，别拦腰截断
    // "无"/"none" = 没有明确的下一步 → 不显示建议条
    if (raw === "无" || raw === "无。" || /^none[.!]?$/i.test(raw)) raw = "";
    // 只有模型明确判定「纯推进确认」(第2行 AUTO)才允许智能继续自动接话；缺这行一律当 ASK
    const canContinue = /\bAUTO\b/i.test(lines[1] || "") && !!raw;
    send("evt:suggest", { sid: id, text: raw, canContinue });
  } catch {
    send("evt:suggest", { sid: id, text: "", canContinue: false });
  } finally {
    suggestInFlight.delete(id);
  }
}

// 界面主动要一次建议(切到某个会话、或用户点灯泡)——回合结束时那次是自动发的
ipcMain.handle("chat:suggest", async (_e, sid: string) => {
  await suggestNextAction(String(sid || ""));
});

// 智能识别红线：让模型判断"自主答这道选择题会不会真触发危险动作"(而非选项里提到词就拦)。
// 返回 {risky, reason}。给智能继续的"智能识别"模式用，比关键词匹配更少误伤。
ipcMain.handle("chat:judgeAskRisk", async (_e, questions: any[], rules?: string) => {
  if (!provider) return { risky: false, reason: "" };
  const blob = (questions || [])
    .map((q: any) => [q?.question, q?.header, ...((q?.options || []).map((o: any) => `${o?.label} ${o?.description || ""}`))].join(" "))
    .join("\n")
    .slice(0, 1500);
  const userRules = String(rules || "").trim().slice(0, 1500);
  try {
    const res = await provider.complete(
      tt(
        "你是安全判官。下面是 AI 想让用户拿主意的一道选择题。判断：如果 AI【不等用户、自己挑一个选项并据此行动】，会不会真的触发【不可逆或影响他人的危险动作】——" +
          "删除/清空/覆盖数据、部署上线到生产、对外发布、改线上配置或写生产库、花钱付款下单、替用户对外发送、改权限/密钥/密码、git 强推回滚等。" +
          (userRules ? "\n用户还自定义了必须停下来问他的红线(每行一条，按【意思】判断，不是关键词，别因为选项里只是提到某个字就算命中)：\n" + userRules + "\n" : "") +
          "关键：只有'自主选下去就会真的执行这类动作/踩中上面红线的意思'才算 RISKY；仅仅选项文字里提到某个词（如只是在讨论用哪种方案、其中一个方案名字带'密钥'或'文件'二字）不算危险。" +
          "输出两行：第1行只写 RISKY 或 SAFE；第2行仅当 RISKY 时，用不超过15字说清是哪个危险动作/踩了哪条红线。",
        "You are a safety judge. Below is a multiple-choice question the AI wants the user to decide. Judge: if the AI picks an option ITSELF without waiting and acts on it, " +
          "would that actually trigger an irreversible or others-affecting dangerous action — deleting/overwriting data, deploying to production, publishing, changing live config or writing to prod DB, spending money, sending on the user's behalf, changing permissions/keys/passwords, git force-push/rollback? " +
          (userRules ? "\nThe user also set custom redlines (one per line) — judge by MEANING, not keywords; don't flag just because an option mentions a word:\n" + userRules + "\n" : "") +
          "Key: only RISKY if choosing autonomously would really execute such an action or match a redline's MEANING; merely mentioning a word (e.g. an option named with 'key' or 'file') is NOT dangerous. " +
          "Output two lines: line 1 only RISKY or SAFE; line 2 only when RISKY, ≤10 words naming the dangerous action/redline.",
      ),
      [{ role: "user", content: [{ type: "text", text: blob }] }] as any,
      [],
      {},
    );
    const whole = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const lines = whole.split("\n").map((s: string) => s.trim()).filter(Boolean);
    const risky = /\bRISKY\b/i.test(lines[0] || "");
    return { risky, reason: risky ? (lines[1] || tt("涉及危险动作", "a risky action")) : "" };
  } catch {
    return { risky: false, reason: "" };
  }
});

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
    title: appDisplayName(), // 任务栏悬停显示的就是它，跟随界面语言
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
  win.on("close", (event) => {
    if (win && !win.isDestroyed()) saveWindowBounds(win.getBounds());
    // 点 ✕ 不退出：拦截并隐藏到系统托盘常驻；只有托盘「退出」/before-quit 置 quitting=true 才放行真正退出。
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
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
const gotLock = app.requestSingleInstanceLock({ edition: EDITION });
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  // 自绘托盘右键菜单：原生 setContextMenu 的行高/hover 样式锁死在系统层无法定制(又大又丑、hover 贴边)，
  // 改用无框透明弹窗，走无为 VI(玄墨黑)、紧凑行高、hover 高亮带内边距+圆角。
  const TRAY_MENU_ITEMS = () => [
    {
      id: "show",
      label: tt("显示主窗口", "Show main window"),
      // 线性窗口图标
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>`,
    },
    {
      id: "settings",
      label: tt("设置", "Settings"),
      // 线性齿轮图标
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    },
    {
      id: "check-update",
      label: tt("检查更新", "Check for updates"),
      // 线性向上箭头/升级图标
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V8"/><path d="m6 12 6-6 6 6"/><path d="M6 4h12"/></svg>`,
    },
    {
      id: "restart",
      label: tt("重启", "Restart"),
      // 线性刷新/重启图标
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/></svg>`,
    },
    { id: "sep" },
    {
      id: "quit",
      label: tt("退出", "Quit"),
      danger: true,
      // 线性电源图标
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/></svg>`,
    },
  ];
  const CARD_W = 180; // 卡片宽
  const SHADOW = 16; // 阴影/圆角留白（窗口比卡片大一圈，给 box-shadow 留空间）
  const ITEM_H = 38;
  const SEP_H = 9;
  const PAD_V = 6;
  function trayMenuSize() {
    const items = TRAY_MENU_ITEMS();
    const cardH = PAD_V * 2 + items.reduce((h, it) => h + (it.id === "sep" ? SEP_H : ITEM_H), 0);
    return { cardH, winW: CARD_W + SHADOW * 2, winH: cardH + SHADOW * 2 };
  }
  function trayMenuHtml(cardH: number) {
    const dark = nativeTheme.shouldUseDarkColors;
    // 无为 VI：玄墨黑底；亮色降级用近白卡片
    const c = dark
      ? { bg: "#1B1F26", border: "rgba(255,255,255,.08)", text: "#E6E8EC", sub: "#9AA0AA", hover: "rgba(255,255,255,.07)", sep: "rgba(255,255,255,.08)", danger: "#F0806B", dangerHover: "rgba(240,128,107,.12)" }
      : { bg: "#FFFFFF", border: "rgba(0,0,0,.08)", text: "#1B1F26", sub: "#6B7280", hover: "rgba(0,0,0,.05)", sep: "rgba(0,0,0,.07)", danger: "#D9503B", dangerHover: "rgba(217,80,59,.08)" };
    const rows = TRAY_MENU_ITEMS()
      .map((it) => {
        if (it.id === "sep") return `<div class="sep"></div>`;
        const cls = it.danger ? "row danger" : "row";
        return `<button class="${cls}" data-act="${it.id}"><span class="ico">${it.icon}</span><span class="lbl">${it.label}</span></button>`;
      })
      .join("");
    return `<!doctype html><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box;-webkit-user-select:none;user-select:none}
      html,body{background:transparent;overflow:hidden;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
      .card{position:fixed;left:${SHADOW}px;top:${SHADOW}px;width:${CARD_W}px;height:${cardH}px;
        background:${c.bg};border:1px solid ${c.border};border-radius:12px;
        box-shadow:0 8px 28px rgba(0,0,0,.32),0 2px 6px rgba(0,0,0,.18);
        padding:${PAD_V}px;display:flex;flex-direction:column;gap:2px;
        animation:pop .12s ease-out}
      @keyframes pop{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
      .row{display:flex;align-items:center;gap:10px;height:${ITEM_H}px;width:100%;
        margin:0 2px;padding:0 10px;border:0;border-radius:8px;background:transparent;cursor:pointer;
        color:${c.text};font-size:13px;text-align:left;transition:background .1s}
      .row:hover{background:${c.hover}}
      .row.danger{color:${c.danger}}
      .row.danger:hover{background:${c.dangerHover}}
      .ico{display:flex;width:16px;height:16px;color:${c.sub};flex:none}
      .row.danger .ico{color:${c.danger}}
      .row:hover .ico{color:currentColor}
      .ico svg{width:16px;height:16px}
      .lbl{flex:1}
      .sep{height:${SEP_H}px;margin:2px 8px;position:relative}
      .sep::after{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:${c.sep}}
    </style>
    <div class="card">${rows}</div>
    <script>
      const send=(a)=>{location.href='wuwei-tray:'+a};
      document.querySelectorAll('.row').forEach(b=>b.addEventListener('click',()=>send(b.dataset.act)));
      window.addEventListener('keydown',e=>{if(e.key==='Escape')send('close')});
    </script>`;
  }
  function ensureTrayMenu(): BrowserWindow {
    if (trayMenu && !trayMenu.isDestroyed()) return trayMenu;
    const { winW, winH } = trayMenuSize();
    trayMenu = new BrowserWindow({
      width: winW,
      height: winH,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      fullscreenable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    trayMenu.setMenu(null);
    // 点菜单项：页面把动作塞进 wuwei-tray: 伪协议，这里拦下来执行，避免额外 preload
    trayMenu.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith("wuwei-tray:")) return;
      e.preventDefault();
      const act = url.slice("wuwei-tray:".length).replace(/\/+$/, "");
      trayMenu?.hide();
      if (act === "show") {
        win?.show();
        win?.focus();
      } else if (act === "settings") {
        win?.show();
        win?.focus();
        send("evt:tray-settings"); // 通知渲染层打开设置面板
      } else if (act === "check-update") {
        win?.show();
        win?.focus();
        send("evt:tray-check-update"); // 通知渲染层走检查更新流程(检查中/已最新/发现新版)
      } else if (act === "restart") {
        // 开发模式(electron-vite dev)下退化为「重载窗口」：那里 app.quit() 会把 vite dev server
        // 一并带走，relaunch 拉起的新实例再去 loadURL(ELECTRON_RENDERER_URL) 必然失败，
        // 只剩 backgroundColor 的纯色窗口——看着就是黑屏。重载渲染层效果等价，还不弄丢 dev server。
        if (process.env["ELECTRON_RENDERER_URL"]) {
          win?.show();
          win?.focus();
          win?.reload();
        } else {
          quitting = true; // 放行 close 事件
          app.relaunch(); // 退出后自动重新拉起
          app.quit();
        }
      } else if (act === "quit") {
        quitting = true; // 放行 close 事件，真正退出
        app.quit();
      }
    });
    trayMenu.on("blur", () => trayMenu?.hide()); // 点别处/失焦自动收起
    return trayMenu;
  }
  function popupTrayMenu() {
    const menu = ensureTrayMenu();
    const { winW, winH, cardH } = trayMenuSize();
    const cursor = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cursor).workArea;
    // 卡片水平居中对准鼠标、底边留 8px 间距浮在光标正上方，再整体夹进工作区
    const GAP = 8;
    let x = cursor.x - SHADOW - CARD_W / 2;
    let y = cursor.y - SHADOW - cardH - GAP;
    x = Math.min(Math.max(x, wa.x - SHADOW), wa.x + wa.width - winW + SHADOW);
    y = Math.min(Math.max(y, wa.y - SHADOW), wa.y + wa.height - winH + SHADOW);
    menu.setBounds({ x: Math.round(x), y: Math.round(y), width: winW, height: winH });
    menu.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(trayMenuHtml(cardH)));
    menu.show();
    menu.focus(); // 抢焦点，blur 才能触发自动收起
  }

  // 系统托盘（左键：显示主窗口；右键：自绘菜单）
  function createTray() {
    try {
      // 托盘专用多尺寸 ico：Windows 按 DPI 自动选最清晰的一档，别手动缩到 18(会糊)
      const iconFile = join(__dirname, "../../build/tray.ico");
      const img = nativeImage.createFromPath(iconFile);
      tray = new Tray(img);
      tray.setToolTip(appDisplayName());
      const showAndFocus = () => {
        if (win?.isVisible()) win.focus();
        else {
          win?.show();
          win?.focus();
        }
      };
      tray.on("click", showAndFocus); // 左键单击：显示并聚焦主窗口
      tray.on("double-click", showAndFocus); // 双击同理
      tray.on("right-click", popupTrayMenu); // 右键：自绘弹窗菜单
    } catch (e) {
      log("boot", "托盘创建失败", String(e));
    }
  }

  app.whenReady().then(() => {
    loadGoals(); // 智能继续：会话总目标(userData/session-goals.json)
    loadStopRules(); // 智能继续：自定义红线(userData/stop-rules.txt，首次给默认)
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
    // 任务栏图标/分组标识：必须在创建窗口【之前】设置，Windows 才会把窗口归到无为身份下。
    try {
      app.setName(APP_NAME);
      // ⚠️ 必须与打包 appId(package.json build.appId = com.wuwei.app)一致，
      //    否则安装版快捷方式的 AppUserModelId 与运行时不匹配，任务栏图标关联不上、回退默认图标。
      if (process.platform === "win32") app.setAppUserModelId(APP_ID);
    } catch {
      /* ignore */
    }
    createWindow();
    createTray();
    setupUpdater(); // 自动更新：启动后延迟静默查一次
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
// 退出前把异步合并写里还没落盘的会话同步刷完，别丢最后一段
app.on("before-quit", () => {
  quitting = true; // 自动更新 quitAndInstall / 系统关机等触发退出时放行 close，避免卡在托盘隐藏无法退出
  try {
    flushAllSessionsSync();
  } catch {
    /* ignore */
  }
  stopBabyServer(); // 关掉数字婴儿常驻服务子进程
});

// —— IPC：渲染 → 主 ——
// 多任务：sid 指定跑哪个会话(前端传 currentId)，各会话各自异步、互不阻塞。事件都带 sid，前端只把当前可见会话的更新画出来。
// 无为托管平台(走网关、按 token 扣无为币)：providerId 以 "wuwei-" 开头。
function isHostedProvider(pid?: string): boolean {
  return !!pid && pid.startsWith("wuwei-");
}
// anon(免登录免费体验)平台：未登录也可见/可用，走网关匿名分支。内置 wuwei-free；
// 后台若新增其它 anon 平台，会在拉 catalog 时补进此集合（见 account:wuwei-catalog）。
const anonProviderIds = new Set<string>(["wuwei-free"]);
function isAnonProvider(pid?: string): boolean {
  return !!pid && anonProviderIds.has(pid);
}
// 无为会话统一取新：所有要用 token 的地方都走这里。
// 为什么要收口：Supabase 的 refresh_token 是「一次性轮换」——用一次就换新的、旧的立刻作废。
// 过去 injectWuwei / wuwei-me / pay:create / pay:status 各自独立 refresh，一旦并发（如启动拉 me 时点了充值），
// 第二个用的就是已被轮换作废的旧 refresh_token → 后端 refresh_failed → 误清会话 → 表现为「登录莫名很快就过期」。
// 这里用「在途 Promise 单飞」让并发只跑一次 refresh，并提前 90s 主动续期，access_token 永不踩着过期线用。
let refreshInflight: Promise<WuweiSession | null> | null = null;
// 显式登出标志：用户主动退出后置真，掐断一切后台 me 拉取/推送/续期回写(否则迟到的刷新会把登录态复活，需退两次)。
// 任何一次成功登录都清零(见各登录 handler)。
let wuweiLoggedOut = false;
async function getFreshWuweiSession(): Promise<WuweiSession | null> {
  if (wuweiLoggedOut) return null; // 已显式登出：一律当未登录，防迟到刷新复活
  const sess = loadWuweiSession();
  if (!sess) return null;
  const BUFFER = 90 * 1000; // 距过期 <90s 就提前续
  if (!sess.expiresAt || sess.expiresAt - Date.now() > BUFFER) return sess;
  if (!refreshInflight) {
    refreshInflight = (async () => {
      const fresh = await wuweiRefresh(sess.refreshToken);
      if (!fresh) { clearWuweiSession(); return null; }
      if (wuweiLoggedOut) return null; // 续期期间用户登出了 → 不回写 session
      saveWuweiSession(fresh);
      return fresh;
    })().finally(() => { refreshInflight = null; });
  }
  return refreshInflight;
}
// 托管平台每轮开跑前：把网关的 apiKey 注入并重建 provider。
//  - 已登录：apiKey = 新鲜的无为 access_token(快过期先续期) → 按 token 扣无为币。
//  - 未登录：apiKey = anon-<设备id> → 匿名试用分支(仅 anon 平台的 free 模型可用，网关按设备/IP 每日护栏)。
async function ensureHostedProviderReady(): Promise<void> {
  const st = loadSettings();
  if (!st || !isHostedProvider(st.providerId)) return;
  applyEnvFromSettings(st); // 平台 baseUrl(网关)等按设置
  const sess = await getFreshWuweiSession();
  const key = sess ? sess.accessToken : `anon-${getDeviceId()}`; // 未登录 → 匿名试用 token
  process.env.WUWEI_API_KEY = key; // 网关的"key"(只 env、不落 config)
  process.env.MINICC_API_KEY = key; // 兼容：config.ts 仍读旧名，过渡期内双写
  provider = makeProvider(loadConfig());
  for (const a of agents.values()) a.setProvider(provider);
}
// 托管平台每轮结束后：拉最新余额推给渲染层(账号菜单余额随扣币刷新)。
// 会员态变更 → 脑网络可用性变 → 热更所有会话的工具集 + 系统提示（brain_* 与说明随之加/摘）。
function applyProFromMe(me: WuweiMe | null): void {
  const pro = !!me?.membership && me.membership.tier !== "free";
  if (pro === isProCached) return;
  isProCached = pro;
  refreshAgentTools();
  for (const a of agents.values()) a.setSystem(buildSysPrompt(cwd, modelLabel, loadSettings()?.providerId));
}
async function refreshWuweiMe(): Promise<void> {
  const sess = await getFreshWuweiSession();
  if (!sess) return;
  const me = await wuweiFetchMe(sess.accessToken);
  if (me && me !== "unauthorized") {
    applyProFromMe(me);
    send("evt:wuwei-me", me);
  }
}

async function startTurn(useId: string, text: string, images?: string[], sysOverride?: string) {
  turnSid = useId; // 供 ask_user 工具的事件带上会话 id
  text = secrets.redact(text).text; // 兜底：已入库密钥出现在消息里→占位符替换，永不出网到模型
  const agent = getAgent(useId);
  if (!agent) {
    send("evt:error", { sid: useId, message: tt("未初始化：缺少模型凭证。请确认 ~/.codex/auth.json 或设置 API key 后重启。", "Not initialized: missing model credentials. Check ~/.codex/auth.json or set an API key, then restart.") });
    return;
  }
  if (runs.has(useId)) {
    // 该会话已在跑(上一条可能挂住/未返回，如没权限的型号请求卡住)——不再静默丢弃，
    // 给用户明确提示可「停止」后重发，避免"发了没反应"的困惑。
    send("evt:error", { sid: useId, message: tt("上一条还在处理中（可能卡住了）。请点输入框旁的「停止」结束后再重发。", "The previous message is still running (it may be stuck). Click Stop next to the input, then resend.") });
    return;
  }
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
        onCompactArchive: (dropped) => archiveMessages(useId, dropped), // 压缩前把原始消息追加进完整日志(永不压缩)
        onAssistantDone: () => send("evt:done", { sid: useId }),
      },
      ac.signal,
      images,
    );
    persist(useId); // 用户消息已同步入队,立即落盘让(新)会话进侧栏、带上运行点
    setSessionRunning(useId, true); // 跨重启存活的运行标记(须在 persist 后:新会话此刻才有元信息)；崩溃/强杀残留→下次启动识别为中断
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
        // 记全量原始错误(含 API 400 body/status),便于排查;友好化仅用于前端展示
        try {
          log("turnError", useId.slice(0, 8), "status=", e?.status, "msg=", String(e?.message || e).slice(0, 800),
              e?.error ? "body=" + JSON.stringify(e.error).slice(0, 800) : "");
        } catch { /* ignore */ }
        // Claude 订阅：真撞上 401/token 失效就当场清掉死 token。
        // 光靠 expiresAt 判断会漏——在别处撤销授权时，时间还没到但 token 已经废了。
        if (loadSettings()?.kind === "anthropic-oauth" && isOAuthDead(e)) clearDeadClaudeOAuth("http-401");
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
    if (!runs.has(useId)) setSessionRunning(useId, false); // 无残留活跃轮→清运行标记(须在 persist 后,它会保留旧标记)
    void emitAccount(); // 刷新余额/本会话已消耗(DeepSeek 等)
    // 当前会话，或开着智能继续的后台会话，跑完都算下一步建议(后台会话切走也能自己接着推进)
    if ((useId === currentId || contSessions.has(useId)) && !ac.signal.aborted) void suggestNextAction(useId);
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
  const ac = runs.get(id);
  const agent = agents.get(id);
  // 两段式停止:
  //  第一次点 → 温和收尾:不切断当前输出，让模型把这轮自然吐完、完整落历史后在下个边界停。
  //    历史尾部是完整的助手消息(非截断)，下次发消息无缝接续，不再产生 (已停止) 截断疤。
  //  第二次点(或已在收尾/卡权限)→ 强制中断(abort)，兜底救卡死的工具/流。
  if (ac && agent && !ac.signal.aborted && !agent.isSoftStopping() && pendingPerm.size === 0 && pendingAsk.size === 0) {
    agent.requestSoftStop();
    log("softStop", id.slice(0, 8), "温和收尾中(再点一次强制停止)");
    return;
  }
  // 只 abort，不立即删 runs——留给 agent.send 的 finally 结算后清理。
  // 否则会话仍在跑就被移出 runs，紧接着的新消息不再被拦→并发跑同一 agent→历史错乱(连续user/悬空tool_use)致 400。
  // loop 已在中断后尽快收尾(补齐 tool_result 并 return)，所以很快结算、UI 随即解锁。
  ac?.abort();
  // 若正卡在权限确认，一并取消(否则中断信号也叫不醒它)
  for (const [pid, r] of pendingPerm) {
    r("deny");
    pendingPerm.delete(pid);
  }
  // 若正卡在 ask_user 选择框，一并取消
  for (const [aid, r] of pendingAsk) {
    r({ cancelled: true });
    pendingAsk.delete(aid);
    pendingAskSid.delete(aid);
  }
});

ipcMain.on("perm:respond", (_e, id: number, decision: "allow" | "deny") => {
  const r = pendingPerm.get(id);
  if (r) {
    r(decision);
    pendingPerm.delete(id);
  }
});

ipcMain.on("ask:answer", (_e, id: number, answers: any) => {
  const r = pendingAsk.get(id);
  if (r) {
    // 用户随答案附了截图：注入回该会话的循环边界，与 tool_result 并入同一条 user 消息，模型即刻看到
    const imgs: string[] = Array.isArray(answers?.images) ? answers.images : [];
    if (imgs.length) {
      const sid = pendingAskSid.get(id);
      const agent = sid ? getAgent(sid) : null;
      // 这句会作为用户消息显示在对话里，跟随界面语言
      if (agent)
        agent.injectUser(
          tt("（用户在回答上面的问题时附带了以下截图）", "(The user attached these screenshots along with their answer above.)"),
          imgs,
        );
    }
    r(answers);
    pendingAsk.delete(id);
    pendingAskSid.delete(id);
  }
});

// —— Codex 限额重置(免费重置额度)：官方客户端走 /wham/rate-limit-reset-credits ——
// 用 ~/.codex/auth.json 的订阅 token 认证；GET 查可用次数、POST consume 用掉一次(不可逆)。
function codexAuthHeaders(): Record<string, string> | null {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8"));
    const tok = auth?.tokens?.access_token;
    const acc = auth?.tokens?.account_id;
    if (!tok || !acc) return null;
    return { Authorization: `Bearer ${tok}`, "chatgpt-account-id": acc, "User-Agent": "codex_cli_rs/0.0.0", Accept: "application/json" };
  } catch {
    return null;
  }
}
ipcMain.handle("codex:reset-credits", async () => {
  const h = codexAuthHeaders();
  if (!h) return { ok: false, error: tt("无 Codex 登录(~/.codex/auth.json)", "No Codex login (~/.codex/auth.json)") };
  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", { headers: h });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j: any = await res.json();
    return { ok: true, availableCount: j.available_count ?? 0, credits: Array.isArray(j.credits) ? j.credits : [] };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("codex:consume-reset", async (_e, creditId: string) => {
  const h = codexAuthHeaders();
  if (!h) return { ok: false, error: tt("无 Codex 登录", "No Codex login") };
  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ credit_id: creditId, redeem_request_id: randomUUID() }),
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
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
          return t ? `${m.role === "user" ? tt("我", "Me") : tt("助手", "Assistant")}：${t}` : "";
        })
        .filter(Boolean)
        .join("\n")
        .slice(-2000); // 取末尾(最新进展)，单会话上限约 2000 字
      return `【${meta?.title || tt("对话", "Chat")}】\n${body || tt("(暂无文字内容)", "(no text content yet)")}`;
    })
    .join("\n\n----\n\n");

  // 日报正文整篇都会显示给用户，语言必须跟界面走
  const sys = tt(
    `你是工作日报助手。下面是「${group}」分组下今天多个工作会话的内容。当用户要求生成日报时，` +
      `请按项目/重点条理清晰地梳理成一份精简中文日报，分三部分：` +
      `✅ 今日进展与成果（按项目/重点一条条罗列）、📌 待办（接下来要做的）、⚠️ 遗留问题/风险。` +
      `要求：精简概要、突出重点、条目式，不要逐字复述细节。\n\n=== 会话内容 ===\n${digest}`,
    `You write daily work reports. Below are today's work sessions from the "${group}" group. When the user asks for a report, ` +
      `organize it by project/theme into a concise English report with three sections: ` +
      `✅ Progress & results today (one bullet per project/theme), 📌 Next up (what's still to do), ⚠️ Open issues / risks. ` +
      `Keep it tight and bulleted — summarize, don't replay the details.\n\n=== Sessions ===\n${digest}`,
  );

  // 新开会话并切过去
  const sid = randomUUID();
  currentId = sid;
  getAgent(sid);
  send("evt:session-loaded", { id: sid, messages: [] });
  sendUsageFor(sid);
  // 这句会当成用户气泡显示出来，同样跟随语言
  void startTurn(sid, tt(`请生成「${group}」今天的工作日报。`, `Write today's work report for "${group}".`), undefined, sys);
});

// 一键工作交接:把某会话有价值的内容总结成交接文档 → 开一个干净的新会话(继承当前平台/模型)
// → 把文档喂进去让 AI 接着把没做完的事做完。解决老对话上下文被污染后，还在原地续跑越跑越乱的问题。
ipcMain.handle("session:handoff", async (_e, sid: string) => {
  const srcId = sid || currentId;
  const srcAgent = getAgent(srcId);
  if (!srcAgent) {
    send("evt:error", { sid: srcId, message: tt("交接失败：源会话未初始化。", "Handoff failed: the source chat isn't initialized.") });
    return { ok: false };
  }
  send("evt:handoff", { sid: srcId, phase: "summarizing" }); // UI 提示"正在生成交接文档…"
  let doc = "";
  try {
    doc = await srcAgent.makeHandoff();
  } catch (e: any) {
    log("handoffError", srcId.slice(0, 8), String(e?.message || e).slice(0, 300));
    send("evt:handoff", { sid: srcId, phase: "error" });
    send("evt:error", { sid: srcId, message: tt("生成交接文档失败：", "Failed to build the handoff doc: ") + String(e?.message || e).slice(0, 200) });
    return { ok: false };
  }
  if (!doc.trim()) {
    send("evt:handoff", { sid: srcId, phase: "error" });
    send("evt:error", { sid: srcId, message: tt("交接文档为空(该会话暂无可提炼的内容)。", "The handoff doc came back empty — nothing to distill from this chat.") });
    return { ok: false };
  }
  // 新会话：沿用当前全局平台/模型(handoff 后 currentId 切到新会话)，让续跑用同一套模型
  const newId = randomUUID();
  currentId = newId;
  getAgent(newId);
  // 源会话带总目标 → 带给新会话，交接后接着朝同一目标自主推进(渲染端会据此自动开智能继续)
  const srcGoal = sessionGoals[srcId];
  const goalCarried = !!(srcGoal && String(srcGoal.text || "").trim() && srcGoal.active !== false && !srcGoal.done);
  if (goalCarried) {
    sessionGoals[newId] = { text: srcGoal.text, active: true, done: false };
    saveGoals();
  }
  send("evt:session-loaded", { id: newId, messages: [] });
  sendUsageFor(newId);
  send("evt:handoff", { sid: newId, phase: "done" });
  // 交接开场白会作为新会话的第一条用户消息显示出来，跟随界面语言
  const goalLine = goalCarried
    ? tt(`【总目标（延续自上一个对话，继续朝它推进）】\n${srcGoal.text}\n\n`, `[Overall goal (carried from the previous chat — keep advancing it)]\n${srcGoal.text}\n\n`)
    : "";
  const firstMsg =
    goalLine +
    tt(
      "【工作交接（来自上一个对话）】\n" +
        "上一个对话的上下文比较杂乱/过长，以下是从中整理出的有价值内容与当前进展。" +
        "请先理解交接内容，然后**接着把未完成的部分继续做完**；有不确定处再问我。\n\n",
      "[Handoff from the previous chat]\n" +
        "The previous chat got long and cluttered; below is what was worth keeping, plus where things stand. " +
        "Read the handoff first, then **pick up and finish what's still open** — ask me if anything is unclear.\n\n",
    ) +
    "----\n" +
    doc;
  void startTurn(newId, firstMsg);
  return { ok: true, newId, goalCarried };
});

ipcMain.on("session:switch", (_e, id: string) => {
  currentId = id;
  const a = getAgent(id);
  // getDisplayMessages：带上还没并入历史的注入消息，否则切回正在跑的会话时「刚发的那条」会不见
  send("evt:session-loaded", { id, messages: a ? a.getDisplayMessages() : [] });
  sendUsageFor(id);
  void emitAccount();
});

// 崩溃恢复——用户点「继续」：切到该会话、清中断标记，注入一句续跑指令让 AI 接着未完成的工作。
// 历史在 getAgent→loadMessages 里已自愈(补齐悬空 tool_result/交替角色)，可直接续跑。
ipcMain.on("session:resume", (_e, id: string) => {
  const sid = id || currentId;
  clearInterrupted(sid);
  currentId = sid;
  const a = getAgent(sid);
  send("evt:session-loaded", { id: sid, messages: a ? a.getDisplayMessages() : [] });
  sendUsageFor(sid);
  send("evt:sessions", listSessions());
  void startTurn(
    sid,
    tt(
      "（这个任务上次运行时被强制中断了。请先回顾上面已完成到哪一步，然后接着把没做完的部分继续完成；若已经做完了，简要说明结果即可。）",
      "(This task was force-interrupted on its last run. Look back at how far it got, then finish what's still open — if it's already done, just summarize the result.)",
    ),
  );
});

// 崩溃恢复——用户点「忽略」：只清中断标记，不续跑。
ipcMain.on("session:dismiss-interrupted", (_e, id: string) => {
  const sid = id || currentId;
  dismissResume(sid); // 清中断标记 + 记忽略，内容启发式不再重复提示
  send("evt:sessions", listSessions());
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
    send("evt:session-loaded", { id: currentId, messages: a ? a.getDisplayMessages() : [] });
    sendUsageFor(currentId);
  }
  send("evt:sessions", listSessions());
  send("evt:groups", listGroups());
  send("evt:trash", listTrash()); // 删除→进回收站,同步刷新回收站
});

// 回收站:列出(顺带清过期)
ipcMain.handle("session:list-trash", () => listTrash());

// 全局搜索:跨所有会话搜正文,返回「会话标题 + 关键词上下文摘要 + 跳转锚点」
ipcMain.handle("session:search", async (_e, q: string) => {
  const metas = listSessions();
  await ensureSearchIndex(metas.map((s) => s.id)); // 首次会解析一遍历史(分文件让出主线程)
  return searchInSessions(q, metas);
});

// 回收站:恢复某条→回到会话列表
ipcMain.on("session:restore", (_e, id: string) => {
  restoreSession(id);
  send("evt:sessions", listSessions());
  send("evt:groups", listGroups());
  send("evt:trash", listTrash());
});

// 回收站:彻底删除某条(不可恢复)
ipcMain.on("session:purge", (_e, id: string) => {
  purgeTrashItem(id);
  send("evt:trash", listTrash());
});

// 回收站:清空(全部彻底删除)
ipcMain.on("session:empty-trash", () => {
  emptyTrash();
  send("evt:trash", listTrash());
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

// 标记待讨论(需过会议讨论)：仅列表徽标区分，不影响排序
ipcMain.on("session:set-discuss", (_e, id: string, discuss: boolean) => {
  setSessionDiscuss(id, discuss);
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
    a.setUsage({ totalInput: 0, totalOutput: 0, lastInput: 0, totalCacheHit: 0, totalCacheMiss: 0, totalSteps: 0 });
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
  // 崩溃恢复(设置开关开时)：首个 bootstrap 同步检测(无时序竞争)。running 残留=强杀(强信号);
  // 再对最近半截会话做内容启发式。返回所有 interrupted(含历史遗留未处理的)，多个不漏。
  const resumeOn = resumeDetectEnabled(loadSettings());
  if (!interruptDetected) {
    interruptDetected = true;
    if (resumeOn) markInterruptedOnStartup(true);
  }
  const a = getAgent(currentId);
  return {
    sessions: listSessions(),
    groups: listGroups(),
    currentId,
    messages: a ? a.getDisplayMessages() : [],
    usage: a ? a.getUsage() : EMPTY_USAGE,
    rateLimits: loadRateLimits(curProviderId()) || null,
    interrupted: resumeOn
      ? listSessions()
          .filter((s) => s.interrupted)
          .map((s) => ({ id: s.id, title: s.title }))
      : [], // 待恢复的会话(全部)；开关关=不提示
  };
});

ipcMain.handle("settings:get", () => ({
  settings: loadSettings(),
  backend: backendLabel,
  model: modelLabel,
  defaultPrompt: DEFAULT_SYSTEM_PROMPT, // 中文默认(设置页按界面语言在渲染层实时选)
  defaultPromptEn: DEFAULT_SYSTEM_PROMPT_EN, // 英文默认
  defaultBrainPrompt: DEFAULT_BRAIN_NOTE, // 脑网络说明默认(知识网络设置页显示/恢复默认)
  defaultBrainPromptEn: DEFAULT_BRAIN_NOTE_EN,
  defaultSecretsPrompt: secrets.SECRETS_SYSTEM_NOTE, // 密钥说明默认(密钥设置页显示/恢复默认)
  defaultSecretsPromptEn: secrets.SECRETS_SYSTEM_NOTE_EN,
}));

// 脑网络/密钥 提示词覆盖：只落盘该字段并热更所有会话系统提示(不重启 provider)。传 null=恢复默认
function hotRefreshSys() {
  sysPrompt = buildSysPrompt(cwd, modelLabel, loadSettings()?.providerId);
  for (const a of agents.values()) a.setSystem(sysPrompt);
}
ipcMain.on("settings:set-brain-prompt", (_e, text: string | null) => {
  const s = loadSettings() || ({} as Settings);
  if (typeof text === "string" && text.trim()) s.brainPrompt = text;
  else delete s.brainPrompt; // 空/删除=恢复默认
  saveSettings(s);
  hotRefreshSys();
});
ipcMain.on("settings:set-secrets-prompt", (_e, text: string | null) => {
  const s = loadSettings() || ({} as Settings);
  if (typeof text === "string" && text.trim()) s.secretsPrompt = text;
  else delete s.secretsPrompt;
  saveSettings(s);
  hotRefreshSys();
});

ipcMain.on("settings:set", (_e, s: Settings) => {
  try {
    applySettings(s);
  } catch (e: any) {
    send("evt:error", tt("切换后端失败：", "Failed to switch backend: ") + e.message);
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

// 应用级开关(app.*：密钥检测/知识网络/扫描相关文档)：只并进 app 字段落盘，不重启 provider。
// 热更：知识网络开关变了→重建系统提示 + 加/摘 brain_* 工具；文档开关→同步 brain 模块。
ipcMain.on("settings:set-app", (_e, patch: Record<string, boolean | string>) => {
  const s = loadSettings() || ({} as Settings);
  s.app = { ...(s.app || {}), ...patch } as any;
  saveSettings(s);
  applyEnvFromSettings(s); // 关键：app.lang 变了要刷 WUWEI_LANG，主进程 tt()/工具描述/系统提示默认才跟随界面语言
  // 语言变了，任务栏标题/托盘提示要当场跟上，不用重启
  try {
    win?.setTitle(appDisplayName());
    tray?.setToolTip(appDisplayName());
  } catch {
    /* ignore */
  }
  syncBrainDocsFlag(s);
  sysPrompt = buildSysPrompt(cwd, modelLabel, s.providerId);
  for (const a of agents.values()) a.setSystem(sysPrompt);
  refreshAgentTools();
});

// 右上角「别的会话在等你选择」提醒：是否自动消失 + 倒计时秒数(纯 UI，只落盘)
ipcMain.on("settings:set-ask-toast", (_e, autoDismiss: boolean, sec: number) => {
  const s = loadSettings() || ({} as Settings);
  const n = Number(sec);
  saveSettings({
    ...s,
    askToastAutoDismiss: !!autoDismiss,
    askToastDismissSec: Number.isFinite(n) && n > 0 ? n : 30,
  });
});

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
// 通用：弹系统目录选择框，返回所选绝对路径（取消返回 null）。给知识网络文档库等路径输入用。
ipcMain.handle("dialog:select-folder", async () => {
  const parent = win && !win.isDestroyed() ? win : undefined;
  const r = await dialog.showOpenDialog(parent as BrowserWindow, {
    title: tt("选择文件夹", "Choose a folder"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
});
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
  if (conceptState.running)
    throw new Error(
      tt(
        "正在抽取概念，请先停止或等它完成再重建索引（两者共用向量模型）",
        "Concept extraction is running — stop it or let it finish before rebuilding the index (they share the embedding model).",
      ),
    );
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
  if (conceptState.running) return { started: false, reason: tt("已在运行", "Already running") };
  if (!provider) return { started: false, reason: tt("未配置模型", "No model configured") };
  // 防并发:抽概念时每存一个概念要给它算向量,走的是索引重建正霸占的同一个 worker,
  // 同时跑会互相饿死→龟速。索引没建完先拦住,提示用户等索引跑完再抽。
  if (docBuildState.building)
    return { started: false, reason: tt("索引正在构建，请等它跑完再抽概念（两者共用向量模型，同时跑会互相拖慢）", "Index is building — wait for it to finish before extracting concepts (they share the embedding model and slow each other down).") };
  void runConceptExtraction(!!opts?.all); // 后台跑,不阻塞;进度走 evt:brain-concepts
  return { started: true };
});

async function extractOneFile(file: string, body: string): Promise<number> {
  // 抽出来的概念名/类型/摘要会显示在知识网络列表里，还会拼进系统提示 → 跟随界面语言。
  // 另注：原文写死「中文文档片段」，英文文档也会被当中文处理，这里一并改成不限定语种。
  const sys = tt(
    "你是知识图谱抽取器。从给定的文档片段中，抽取值得长期记住的【概念节点】与它们之间的【关系】。" +
      "概念 = 项目/服务器/服务/脚本/工具/命令/注意事项/偏好/抽象概念 等有信息量的实体。" +
      "只输出一个 JSON 对象，禁止任何解释、禁止代码围栏，格式严格为：" +
      '{"concepts":[{"name":"规范短名","type":"类型","summary":"一句话摘要","aliases":["别名"]}],"relations":[{"from":"概念A","relation":"关系","to":"概念B"}]}。' +
      "name 用最规范简短的名字；没有可抽的就返回 {\"concepts\":[],\"relations\":[]}。最多 12 个概念。",
    "You extract knowledge graphs. From the given document excerpt, pull out the [concept nodes] worth remembering long-term and the [relations] between them. " +
      "A concept = an informative entity: project / server / service / script / tool / command / caveat / preference / abstract concept, etc. " +
      "Output a single JSON object — no explanation, no code fences — strictly in this shape: " +
      '{"concepts":[{"name":"canonical short name","type":"type","summary":"one-line summary","aliases":["alias"]}],"relations":[{"from":"concept A","relation":"relation","to":"concept B"}]}. ' +
      'Use the most canonical short name; if there is nothing to extract, return {"concepts":[],"relations":[]}. At most 12 concepts. Write names and summaries in English.',
  );
  const res = await provider!.complete(
    sys,
    [
      {
        role: "user",
        content: [{ type: "text", text: tt(`文档《${file}》片段：\n${body}\n\nJSON:`, `Excerpt from "${file}":\n${body}\n\nJSON:`) }],
      },
    ] as any,
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
      type: c.type ? String(c.type).slice(0, 20) : tt("概念", "concept"),
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
    send("evt:error", tt("写入 MCP 配置失败：", "Failed to write MCP config: ") + e.message);
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
    if (!ok) return { ok: false, error: tt("密码不正确", "Incorrect password") };
    return { ok: true, items: secrets.revealAll() };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});
// 发送前扫描：脱敏已入库密钥 + 返回尚未入库的疑似新密钥(给确认弹窗)。永不抛错,否则会挡住发送。
ipcMain.handle("secrets:scan", (_e, text: string) => {
  try {
    // redact 始终跑：已入库密钥→占位符，永不出网(与"检测新密钥"是两回事，不受开关影响)。
    // detect 受「密钥检测」开关控制：关掉后不再扫描/弹窗拦截疑似新密钥(如临时长 token)。
    const detect = secretsDetectEnabled(loadSettings());
    return { redacted: secrets.redact(text).text, candidates: detect ? secrets.detect(text) : [] };
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
    browserPopWin = new BrowserWindow({
      width: 1040,
      height: 780,
      title: tt("无为 浏览器", "Wuwei Browser"),
      ...(existsSync(join(__dirname, "../../build/icon.png")) ? { icon: join(__dirname, "../../build/icon.png") } : {}),
    });
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
  // 之前显式退出过(wuweiLoggedOut) → 强制重新选账号(浏览器先 signOut)，避免复用残留旧会话跳回原账号
  const sess = await wuweiLogin(wuweiLoggedOut);
  if (!sess) return null;
  wuweiLoggedOut = false; // 重新登录 → 解除登出封锁
  saveWuweiSession(sess);
  const me = await wuweiFetchMe(sess.accessToken);
  if (me === "unauthorized" || !me) return null;
  applyProFromMe(me);
  return me;
});
// —— 应用内登录（邮箱密码/邮箱注册/手机验证码）：成功存会话+返回 {me}，失败返回 {error:文案} ——
async function finishWuweiSignin(
  r: WuweiSession | string,
  action: "login" | "register" = "login",
): Promise<{ me?: unknown; error?: string }> {
  if (typeof r === "string") return { error: r };
  wuweiLoggedOut = false; // 重新登录 → 解除登出封锁
  saveWuweiSession(r);
  const me = await wuweiFetchMe(r.accessToken);
  if (me === "unauthorized" || !me) {
    return {
      error:
        action === "register"
          ? tt("注册成功，但拉取账号失败，请重开登录", "Signed up, but we couldn't load your account — please sign in again.")
          : tt("登录成功，但拉取账号失败，请重试", "Signed in, but we couldn't load your account — please try again."),
    };
  }
  applyProFromMe(me);
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
  const sess = await getFreshWuweiSession(); // 提前续期 + 单飞，避免并发把 refresh_token 用作废
  if (!sess) return null;
  let me = await wuweiFetchMe(sess.accessToken);
  if (me === "unauthorized") {
    // 提前续过还被拒(时钟偏差/刚好失效)：再强制续一次
    const fresh = await wuweiRefresh(sess.refreshToken);
    if (!fresh) {
      clearWuweiSession();
      return null;
    }
    saveWuweiSession(fresh);
    me = await wuweiFetchMe(fresh.accessToken);
  }
  const meVal = me === "unauthorized" || !me ? null : me;
  applyProFromMe(meVal); // 同步会员态 → 脑网络可用性
  return meVal;
});
ipcMain.handle("account:wuwei-logout", () => {
  wuweiLoggedOut = true;      // 掐断后台刷新/推送，防"退一次又自动登回"
  refreshInflight = null;     // 丢弃进行中的续期(其回写已被 wuweiLoggedOut 拦)
  clearWuweiSession();
  applyProFromMe(null); // 退出 → 会员态清空 → 脑网络停用
  return true;
});
// AI 提供商目录（脱敏）：带上当前会话 token(可选) 拉后台可配的平台顺序/显隐/模型。失败返回 null → 渲染层回退硬编码 PRESETS。
ipcMain.handle("account:wuwei-catalog", async () => {
  const sess = await getFreshWuweiSession().catch(() => null);
  const cat = await wuweiFetchCatalog(sess?.accessToken ?? null);
  // 记下后台标为 anon(免登录)的平台，供 hasCredential/发送前注入识别；内置 wuwei-free 恒在集合里。
  if (cat) {
    anonProviderIds.clear();
    anonProviderIds.add("wuwei-free");
    for (const p of cat) if (p.anon) anonProviderIds.add(p.id);
  }
  return cat;
});
// 记住登录：多账号加密存储，供登录框自动填充 + 账号下拉历史。
ipcMain.handle("login:remember-get", () => loadRemember());
ipcMain.handle("login:remember-set", (_e, email: string, password: string) => {
  upsertRemember(email, password);
  return true;
});
ipcMain.handle("login:remember-clear-password", (_e, email: string) => {
  clearRememberedPassword(email);
  return true;
});
// 客户端公告：从 wuwei-site 拉当前发布中的公告(公开、无需登录)。走主进程避免 CORS。
// 返回 { active, version, titleZh/En, bodyZh/En }；异常/未发布 → { active:false }。
ipcMain.handle("announcement:get", async () => {
  try {
    const site = process.env.WUWEI_SITE_URL || "https://wuweiai.io";
    const res = await fetch(`${site}/api/announcement`);
    if (!res.ok) return { active: false };
    return await res.json();
  } catch {
    return { active: false };
  }
});
// 当前应用版本号（帮助菜单显示 + 更新比对）
ipcMain.handle("app:version", () => app.getVersion());

// ── 自动更新（electron-updater + OSS generic 源，发布配置见 electron-builder.wuwei.yml）──
// autoDownload：发现新版即后台静默下载；下载完推 evt:update-downloaded，用户点「升级」再 quitAndInstall。
// 未打包(dev)或无更新源时 checkForUpdates 会抛错，一律吞掉，不影响使用。
const { autoUpdater } = electronUpdater;
let updaterWired = false;
function setupUpdater(): void {
  if (updaterWired) return;
  updaterWired = true;
  autoUpdater.autoDownload = true; // 发现新版即后台下载
  autoUpdater.autoInstallOnAppQuit = false; // 不擅自在退出时装，由用户点「升级」触发
  autoUpdater.on("update-available", (info) => {
    send("evt:update-available", { version: info.version, notes: typeof info.releaseNotes === "string" ? info.releaseNotes : "" });
  });
  // 下载进度：转发给界面显示进度条（percent 0-100 + 速度/已下/总量）
  autoUpdater.on("download-progress", (p) => {
    send("evt:update-progress", {
      percent: Math.max(0, Math.min(100, p?.percent ?? 0)),
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    log("updater", "update-downloaded 事件", info.version);
    send("evt:update-downloaded", { version: info.version, notes: typeof info.releaseNotes === "string" ? info.releaseNotes : "" });
  });
  autoUpdater.on("error", (e) => log("updater", "更新出错", String(e?.message || e)));
  // 启动后延迟自动查一次（静默；有新版即等待下载完成后主动推「就绪」，不依赖原生 update-downloaded 事件）
  setTimeout(() => { void checkAndPrepareUpdate(); }, 8000);
}

// 检查更新 + 等待下载完成（已缓存则立即完成）后主动推「就绪」。返回 {available, downloaded, version, notes}。
// 关键：不再单纯依赖 update-downloaded 事件——缓存已存在时它可能不重新触发，导致界面永远等不到「升级重启」。
async function checkAndPrepareUpdate(): Promise<{ available: boolean; downloaded?: boolean; version?: string; notes?: string; error?: string }> {
  try {
    const r = await autoUpdater.checkForUpdates();
    const info = r?.updateInfo;
    if (!info) return { available: false };
    const available = info.version !== app.getVersion();
    const notes = typeof info.releaseNotes === "string" ? info.releaseNotes : "";
    if (!available) return { available: false, version: info.version };
    log("updater", "发现新版", info.version);
    // r.downloadPromise：autoDownload 触发的下载；已缓存则立即 resolve
    if (r.downloadPromise) {
      try {
        await r.downloadPromise;
        log("updater", "下载完成(就绪)", info.version);
        send("evt:update-downloaded", { version: info.version, notes });
        return { available: true, downloaded: true, version: info.version, notes };
      } catch (e: any) {
        log("updater", "下载失败", String(e?.message || e));
        return { available: true, downloaded: false, version: info.version, notes };
      }
    }
    return { available: true, downloaded: false, version: info.version, notes };
  } catch (e: any) {
    return { available: false, error: String(e?.message || e) };
  }
}

// 手动检查更新：会等待下载完成再返回（downloaded=true 时界面直接弹「升级重启」）。dev/无源 → available:false + error。
ipcMain.handle("updater:check", async () => checkAndPrepareUpdate());
// 立即安装已下载的更新并重启
ipcMain.on("updater:install", () => {
  try { autoUpdater.quitAndInstall(); } catch (e: any) { log("updater", "安装失败", String(e?.message || e)); }
});
// 每日签到：带 token 调后端 /api/signin（幂等，当天重复调不重复发）。返回 {success, amount, balanceAfter, streak, message}。
ipcMain.handle("account:checkin", async () => {
  const sess = await getFreshWuweiSession();
  if (!sess) return null;
  try {
    const site = process.env.WUWEI_SITE_URL || "https://wuweiai.io";
    const res = await fetch(`${site}/api/signin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sess.accessToken}`, "X-Device-Id": getDeviceId() },
    });
    const j = (await res.json().catch(() => null)) as
      | { success?: boolean; amount?: number; balanceAfter?: number; streak?: number; message?: string; error?: string }
      | null;
    if (!res.ok || !j) return null;
    return j;
  } catch (e) {
    log("checkin", "签到异常", String(e));
    return null;
  }
});
// 客服留言：POST 到 wuwei-site，后端存库供「留言管理」查看（用户/时间/内容/图片）。带 token 则后端能关联用户。
ipcMain.handle(
  "support:message",
  async (_e, payload: { message: string; contact: string; images: string[] }) => {
    try {
      const site = process.env.WUWEI_SITE_URL || "https://wuweiai.io";
      const sess = loadWuweiSession();
      const headers: Record<string, string> = { "Content-Type": "application/json", "X-Device-Id": getDeviceId() };
      if (sess) headers.Authorization = `Bearer ${sess.accessToken}`;
      const res = await fetch(`${site}/api/support/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: payload?.message || "",
          contact: payload?.contact || "",
          images: Array.isArray(payload?.images) ? payload.images.slice(0, 4) : [],
        }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !j) return { ok: false, error: j?.error || `http_${res.status}` };
      return { ok: j.ok !== false, error: j.error };
    } catch (e) {
      log("support", "留言提交异常", String(e));
      return { ok: false, error: "network" };
    }
  },
);
// 消息中心：拉取当前用户消息 + 未读数。未登录 → 空列表。带 token 后端按 user_id 过滤。
ipcMain.handle("messages:list", async () => {
  const empty = { messages: [], unread: 0 };
  const sess = await getFreshWuweiSession();
  if (!sess) return empty;
  try {
    const site = process.env.WUWEI_SITE_URL || "https://wuweiai.io";
    const res = await fetch(`${site}/api/me/messages`, {
      headers: { Authorization: `Bearer ${sess.accessToken}`, "X-Device-Id": getDeviceId() },
    });
    const j = (await res.json().catch(() => null)) as { messages?: unknown[]; unread?: number } | null;
    if (!res.ok || !j) return empty;
    return { messages: Array.isArray(j.messages) ? j.messages : [], unread: Number(j.unread) || 0 };
  } catch (e) {
    log("messages", "拉取消息异常", String(e));
    return empty;
  }
});
// 消息中心：标记已读（ids 或 all）→ 返回剩余未读数
ipcMain.handle("messages:read", async (_e, arg: { ids?: number[]; all?: boolean }) => {
  const sess = await getFreshWuweiSession();
  if (!sess) return { ok: false, unread: 0 };
  try {
    const site = process.env.WUWEI_SITE_URL || "https://wuweiai.io";
    const res = await fetch(`${site}/api/me/messages/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sess.accessToken}`, "Content-Type": "application/json", "X-Device-Id": getDeviceId() },
      body: JSON.stringify({ ids: Array.isArray(arg?.ids) ? arg.ids : undefined, all: !!arg?.all }),
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; unread?: number } | null;
    if (!res.ok || !j) return { ok: false, unread: 0 };
    return { ok: j.ok !== false, unread: Number(j.unread) || 0 };
  } catch (e) {
    log("messages", "标记已读异常", String(e));
    return { ok: false, unread: 0 };
  }
});
// 稳定设备指纹（灰度开关 & 免费试用额度共用）
ipcMain.handle("account:wuwei-device-id", () => getDeviceId());

// ── 扫码支付：下单 / 轮询。带用户 token 调后端，401 自动 refresh 重试（同 wuwei-me）──
ipcMain.handle("pay:create", async (_e, sku: string, channel: string) => {
  const sess = await getFreshWuweiSession(); // 下单前先确保 token 新鲜，减少 401 与误登出
  if (!sess) return { error: "not_logged_in" };
  let r = await wuweiPayCreate(sess.accessToken, sku, channel);
  if (r === "unauthorized") {
    const fresh = await wuweiRefresh(sess.refreshToken);
    if (!fresh) {
      clearWuweiSession();
      return { error: "not_logged_in" };
    }
    saveWuweiSession(fresh);
    r = await wuweiPayCreate(fresh.accessToken, sku, channel);
  }
  return r === "unauthorized" ? { error: "not_logged_in" } : r;
});
ipcMain.handle("pay:status", async (_e, orderId: string) => {
  const sess = await getFreshWuweiSession();
  if (!sess) return null;
  let r = await wuweiPayStatus(sess.accessToken, orderId);
  if (r === "unauthorized") {
    const fresh = await wuweiRefresh(sess.refreshToken);
    if (!fresh) {
      clearWuweiSession();
      return null;
    }
    saveWuweiSession(fresh);
    r = await wuweiPayStatus(fresh.accessToken, orderId);
  }
  return r === "unauthorized" ? null : r;
});

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
  if (!k) return { ok: false, reason: tt("空 key", "Empty key") };
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
    return { ok: true, reason: tt("验证通过", "Verified") };
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
  // 例外：anon(免登录)平台始终有凭证——未登录用 anon-<设备id> 走匿名试用。
  if (isHostedProvider(curProviderId())) return isAnonProvider(curProviderId()) || !!loadWuweiSession();
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
    return { status: "red", reason: tt("当前平台未配置凭证 / 未授权，无法使用。", "This provider has no credentials / isn't authorized — can't be used.") };
  }
  // 匿名试用平台(未登录)：真实 ping 会走网关匿名分支、白白消耗当日免费次数。
  // 故未登录时不 ping，直接判绿——凭证恒在(anon-<设备id>)，真连通性发消息时自会体现。
  if (isAnonProvider(curProviderId()) && !loadWuweiSession()) {
    return { status: "green", reason: tt("免费体验就绪（无需登录）。", "Free trial ready (no login needed).") };
  }
  // 托管平台：ping 前必须先注入新鲜的无为 token 并重建 provider，
  // 否则用的是空/旧 token（token 只在发消息前注入），网关会回 401 invalid_token 而误判「未连通」。
  if (isHostedProvider(curProviderId())) await ensureHostedProviderReady();
  if (!provider) return { status: "red", reason: tt("未初始化，请检查设置。", "Not initialized — please check settings.") };
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
    return { status: "green", reason: tt(`已连通 · ${backendLabel} / ${modelLabel}，可随时使用。`, `Connected · ${backendLabel} / ${modelLabel}, ready to use.`) };
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    return { status: "yellow", reason: tt("已配置但请求报错：", "Configured but the request errored: ") + msg.slice(0, 600) };
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

// ==================== 完整对话日志归档（压缩前的原始消息，永不压缩） ====================
// 上下文压缩会把旧消息换成摘要、原文就丢了。这里把压缩前的原始消息按会话追加进 jsonl，
// 供"查看完整历史"弹窗还原被压缩前的交流(尤其半夜自主推进跑很久时)。
const transcriptsDir = () => join(app.getPath("userData"), "transcripts");
const transcriptFile = (sid: string) => join(transcriptsDir(), String(sid).replace(/[^\w.-]/g, "_") + ".jsonl");
function archiveMessages(sid: string, msgs: any[]) {
  if (!sid || !Array.isArray(msgs) || !msgs.length) return;
  try {
    mkdirSync(transcriptsDir(), { recursive: true });
    const lines = msgs
      .map((m) => { try { return JSON.stringify({ role: m.role, content: m.content, ts: m.ts || 0 }); } catch { return ""; } })
      .filter(Boolean)
      .join("\n") + "\n";
    appendFileSync(transcriptFile(sid), lines, "utf-8");
  } catch { /* 归档失败不影响主流程 */ }
}
// 查看完整历史：已归档(被压缩掉的原始消息) + 当前持久化消息(含最新摘要与近期原文)，拼成完整对话。
// 没发生过压缩时归档为空，直接就是全量历史；发生过压缩则 = 压缩前原文 + 摘要 + 近期。
ipcMain.handle("session:transcript", (_e, sid: string) => {
  const id = String(sid || "");
  let archived: any[] = [];
  try {
    const raw = readFileSync(transcriptFile(id), "utf-8");
    archived = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* 无归档文件=从没压缩过 */ }
  let live: any[] = [];
  try { live = loadMessages(id) || []; } catch { /* ignore */ }
  return { archived, live, full: [...archived, ...live], compacted: archived.length > 0 };
});
// 按保留天数清理归档(渲染端启动时用它的设置调一次)
ipcMain.handle("session:pruneTranscripts", (_e, days: number) => { pruneTranscripts(Number(days) || 0); });
// 保留天数清理：删掉超过 N 天没更新的归档(N<=0 表示永久保留)
function pruneTranscripts(days: number) {
  if (!days || days <= 0) return;
  try {
    const dir = transcriptsDir();
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - days * 86400_000;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ==================== 智能继续：会话总目标 + 自定义红线 + 后台推进集合 ====================
// —— 会话总目标：给这个对话定一个大目标，它自己拆解、自己一步步推进 ——
type SessionGoal = { text: string; active: boolean; done?: boolean };
let sessionGoals: Record<string, SessionGoal> = {};
const goalsFile = () => join(app.getPath("userData"), "session-goals.json");
function loadGoals() {
  try { sessionGoals = JSON.parse(readFileSync(goalsFile(), "utf-8")) || {}; } catch { sessionGoals = {}; }
}
function saveGoals() {
  try { writeFileSync(goalsFile(), JSON.stringify(sessionGoals), "utf-8"); } catch { /* 存不下不影响主流程 */ }
}
// 用户自己写的「必须停下来问我」的规则(设置→运行模式)，优先级高于内置判断
let stopRules = "";
const stopRulesFile = () => join(app.getPath("userData"), "stop-rules.txt");
// 首次使用给一份常见红线，省得用户从零写；之后以文件为准(不覆盖他改过的)
const DEFAULT_STOP_RULES = [
  "删除或清空任何数据、文件、数据库表、代码分支",
  "部署上线、发布到生产/正式环境",
  "修改线上配置，或往生产数据库写数据",
  "重启、停止、扩缩容任何线上服务或容器",
  "花钱：付款、下单、买资源、开通付费服务",
  "替我给别人发邮件、消息、短信、提交工单",
  "改权限、密钥、账号、安全设置",
  "git 强制推送、回滚、reset 已推送的提交",
  "执行 rm -rf、drop table、truncate 这类不可逆命令",
  "把我的数据或代码上传、公开、分享到外部",
].join("\n");
function loadStopRules() {
  try {
    stopRules = readFileSync(stopRulesFile(), "utf-8");
  } catch {
    stopRules = DEFAULT_STOP_RULES;
    try { writeFileSync(stopRulesFile(), stopRules, "utf-8"); } catch { /* ignore */ }
  }
}
ipcMain.handle("chat:stopRulesGet", () => stopRules);
ipcMain.handle("chat:stopRulesSet", (_e, t: string) => {
  stopRules = String(t || "").slice(0, 4000);
  try { writeFileSync(stopRulesFile(), stopRules, "utf-8"); } catch { /* ignore */ }
});
ipcMain.handle("chat:goalGet", (_e, sid: string) => sessionGoals[String(sid || "")] || null);
ipcMain.handle("chat:goalSet", (_e, sid: string, goal: SessionGoal | null) => {
  const k = String(sid || "");
  if (!k) return;
  // 只有显式传 null 才删；「完成」只是把 active 关掉、done 打上，目标本身一直留着
  if (!goal || !String(goal.text || "").trim()) delete sessionGoals[k];
  else sessionGoals[k] = { text: String(goal.text).slice(0, 2000), active: !!goal.active, done: !!goal.done };
  saveGoals();
});
// 开着「智能继续/自主推进」的会话集合(渲染端在模式变化时同步过来)。
// 这些会话即使不在屏幕上，跑完一轮也要照样算下一步建议——否则切走就断在那儿。
const contSessions = new Set<string>();
ipcMain.on("chat:cont-sessions", (_e, ids: string[]) => {
  contSessions.clear();
  for (const id of Array.isArray(ids) ? ids : []) if (id) contSessions.add(String(id));
});

// ==================== AGI 板块：数字婴儿对接 ====================
// 用 child_process 调 Python 跑 d1_digital_baby/baby_server.py,把结果返回渲染进程。
// 路径可配置：python 路径 / baby 目录 / LLM 地址都从 ~/.wuwei/config.json 的 agi 字段读。
// ⚠ 迁自 minicc(mac 环境),默认值已中性化：babyDir 必须自己在 config.json 填,
//   python 默认走 PATH 里的 "python"。这套依赖本地 agi-lab/d1_digital_baby + python3.10,
//   普通发版用户没有这套后端,数字婴儿对他们是隐藏/点了报错的开发者功能。
function agiCfg() {
  const s: any = loadSettings() || {};
  const agi = s.agi || {};
  return {
    enabled: agi.enabled !== false, // 默认开
    python: agi.python || "python", // Win/跨平台默认走 PATH；需要可在 config.json 填绝对路径(mac 常是 /usr/local/bin/python3)
    babyDir: agi.babyDir || "", // 必填：agi-lab/d1_digital_baby 的绝对路径。留空则启动时给出友好报错
    llmBase: agi.llmBase || "http://192.168.2.195:8002/v1",
    llmModel: agi.llmModel || "qwen3.6-35b-a3b",
  };
}

// ——— 数字婴儿常驻服务 ———
// 旧版每次 execFile 冷启动 python，光 import sentence_transformers+加载句向量模型就 ~11s。
// 改成常驻 HTTP 服务(baby_server.py)：模型只加载一次，之后每次请求秒回。
let babyProc: any = null;
let babyPort = 0;
let babyReady = false;
let babyStarting: Promise<void> | null = null;
// 婴儿的"大脑"：本地 nano_baby_gpt(纯手写小 GPT)。当 llmBase 指向本机时由 wuwei 自动拉起，
// 这样开婴儿=大脑+身体一起起，用户不用手动跑。指向外部 LLM 时不管(那是用户自己的服务)。
let babyBrainProc: any = null;
let babyBrainStarting: Promise<void> | null = null;

const _sleepBaby = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 找一个空闲端口
function pickPort(): Promise<number> {
  return new Promise(async (resolve, reject) => {
    const netmod = await import("node:net");
    const srv = netmod.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
  });
}

// 探活 /health
function pingHealth(port: number): Promise<boolean> {
  return new Promise(async (resolve) => {
    const http = await import("node:http");
    const req = http.request({ host: "127.0.0.1", port, path: "/health", method: "GET", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// 确保婴儿"大脑"(本地 nano_baby_gpt)在跑。llmBase 指向本机(127.0.0.1/localhost)且 babyDir 有
// nano_baby_gpt.py 才管；已经健康在跑就跳过(不重复起，兼容用户手动起的)。首启无 checkpoint 会先训练。
function ensureNanoBrain(cfg: ReturnType<typeof agiCfg>): Promise<void> {
  const p = (async () => {
    let host = "", port = 0;
    try { const u = new URL(cfg.llmBase); host = u.hostname; port = Number(u.port) || 0; } catch { return; }
    if (!(host === "127.0.0.1" || host === "localhost")) return; // 外部 LLM：用户自己的服务，不代管
    if (!port) return;
    if (!existsSync(join(cfg.babyDir, "nano_baby_gpt.py"))) return; // 没有本地脑脚本：跳过
    if (await pingHealth(port)) return; // 已经有人(可能用户手动)起着且健康：直接用
    const { spawn } = await import("node:child_process");
    const env = { HF_ENDPOINT: "https://hf-mirror.com", ...process.env, PYTHONIOENCODING: "utf-8", KMP_DUPLICATE_LIB_OK: "TRUE" };
    babyBrainProc = spawn(cfg.python, ["nano_baby_gpt.py", "--port", String(port)], { cwd: cfg.babyDir, env });
    babyBrainProc.stderr?.on("data", (d: any) => log("nano_brain", String(d).trim()));
    babyBrainProc.on("exit", () => { babyBrainProc = null; });
    const deadline = Date.now() + 120000; // 首启可能要训练(几分钟)，给足时间
    while (Date.now() < deadline) {
      if (babyBrainProc && await pingHealth(port)) return;
      if (!babyBrainProc) throw new Error("nano_baby_gpt 进程已退出(看日志 nano_brain)");
      await _sleepBaby(700);
    }
    throw new Error("nano_baby_gpt(婴儿大脑)启动超时");
  })();
  babyBrainStarting = p.finally(() => { babyBrainStarting = null; });
  return babyBrainStarting;
}

// 确保常驻服务在跑(懒启动+并发合流)。首次要等模型加载 ~11s。
function ensureBabyServer(): Promise<void> {
  if (babyReady && babyProc && !babyProc.killed) return Promise.resolve();
  if (babyStarting) return babyStarting;
  const p = (async () => {
    const cfg = agiCfg();
    if (!cfg.babyDir) throw new Error("未配置数字婴儿目录：请在 ~/.wuwei/config.json 的 agi.babyDir 填 d1_digital_baby 的绝对路径");
    if (!existsSync(join(cfg.babyDir, "baby_server.py"))) throw new Error("找不到 baby_server.py（检查 agi.babyDir 路径是否正确）");
    await ensureNanoBrain(cfg); // 先把大脑(本地 nano)拉起来，否则 baby /chat 连不到 LLM
    babyPort = await pickPort();
    const { spawn } = await import("node:child_process");
    const env = { HF_HUB_OFFLINE: "1", HF_ENDPOINT: "https://hf-mirror.com", ...process.env, PYTHONIOENCODING: "utf-8", LLM_BASE: cfg.llmBase, LLM_MODEL: cfg.llmModel };
    babyProc = spawn(cfg.python, ["baby_server.py", "--port", String(babyPort)], { cwd: cfg.babyDir, env });
    babyProc.stderr?.on("data", (d: any) => log("baby_server", String(d).trim()));
    babyProc.on("exit", () => { babyReady = false; babyProc = null; });
    const deadline = Date.now() + 45000; // 给模型加载留足时间
    while (Date.now() < deadline) {
      if (babyProc && await pingHealth(babyPort)) { babyReady = true; return; }
      if (!babyProc) throw new Error("baby_server 进程已退出");
      await _sleepBaby(500);
    }
    throw new Error("baby_server 启动超时");
  })();
  babyStarting = p.finally(() => { babyStarting = null; });
  return babyStarting;
}

// 向常驻服务发一个请求。body===undefined 走 GET，否则 POST(JSON)。
function babyHttp(path: string, body: any, timeoutMs: number): Promise<{ ok: boolean; text: string }> {
  return new Promise(async (resolve) => {
    const http = await import("node:http");
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf-8");
    const req = http.request({
      host: "127.0.0.1", port: babyPort, path, method: body === undefined ? "GET" : "POST",
      timeout: timeoutMs,
      headers: payload ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(payload.length) } : {},
    }, (res) => {
      let buf = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { const j = JSON.parse(buf); resolve({ ok: !!j.ok, text: String(j.text ?? "") }); }
        catch { resolve({ ok: false, text: buf || "空响应" }); }
      });
    });
    req.on("error", (e) => resolve({ ok: false, text: "出错:" + String(e) }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, text: "出错:请求超时" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// 停止常驻服务(app 退出时调用)：身体 + 大脑一起停
function stopBabyServer() {
  try { babyProc?.kill(); } catch { /* ignore */ }
  try { babyBrainProc?.kill(); } catch { /* ignore */ }
  babyProc = null; babyReady = false; babyBrainProc = null;
}

// 兼容旧签名：把 (args, stdin) 映射到常驻服务的 HTTP 接口，IPC handler 无需改动。
function runBaby(args: string[], stdin?: string, timeoutMs = 600000): Promise<{ ok: boolean; out: string }> {
  return (async () => {
    const cmd = args[0];
    let path: string; let body: any;
    if (cmd === "status" || cmd === "diary" || cmd === "curious") { path = "/" + cmd; body = undefined; }
    else if (cmd === "praise" || cmd === "scold") { path = "/" + cmd; body = {}; }
    else if (cmd === "live") { path = "/live"; body = { n: parseInt(args[1] || "3", 10) || 3 }; }
    else if (cmd === "seed") { path = "/seed"; body = { concept: args.slice(1).join(" ") }; }
    else if (cmd === "chat") { path = "/chat"; body = { msg: (stdin || "").replace(/\n?退出\n?$/, "").trim() }; }
    else if (cmd === "alivestart") { path = "/alive/start"; body = {}; }
    else if (cmd === "alivestop") { path = "/alive/stop"; body = {}; }
    else if (cmd === "alivestatus") { path = "/alive/status"; body = undefined; }
    else if (cmd === "graph") { path = "/graph"; body = undefined; }
    else if (cmd === "pyramid") { path = "/pyramid"; body = undefined; }
    else if (cmd === "reorganize") { path = "/reorganize"; body = {}; }
    else return { ok: false, out: "未知命令:" + cmd };
    try {
      await ensureBabyServer();
    } catch (e) {
      return { ok: false, out: "数字婴儿服务启动失败:" + String(e) };
    }
    const r = await babyHttp(path, body, timeoutMs);
    return { ok: r.ok, out: r.text };
  })();
}

ipcMain.handle("agi:cfg", () => agiCfg());
ipcMain.handle("agi:baby:status", async () => (await runBaby(["status"], undefined, 60000)).out);
ipcMain.handle("agi:baby:diary", async () => (await runBaby(["diary"], undefined, 60000)).out);
ipcMain.handle("agi:baby:curious", async () => (await runBaby(["curious"], undefined, 60000)).out);
ipcMain.handle("agi:baby:live", async (_e, n: number) => (await runBaby(["live", String(n || 3)], undefined, 900000)).out);
ipcMain.handle("agi:baby:praise", async () => (await runBaby(["praise"], undefined, 60000)).out);
ipcMain.handle("agi:baby:scold", async () => (await runBaby(["scold"], undefined, 60000)).out);
ipcMain.handle("agi:baby:seed", async (_e, concept: string) => (await runBaby(["seed", String(concept || "")], undefined, 60000)).out);
// 聊天:baby_server /chat 接口
ipcMain.handle("agi:baby:chat", async (_e, msg: string) => {
  const r = await runBaby(["chat"], String(msg || "") + "\n退出\n", 300000);
  const m = r.out.split("👶 >").slice(1).join("👶 >").trim();
  return m || r.out;
});
// 无限生命循环开关 + 状态
ipcMain.handle("agi:baby:alivestart", async () => (await runBaby(["alivestart"], undefined, 30000)).out);
ipcMain.handle("agi:baby:alivestop", async () => (await runBaby(["alivestop"], undefined, 30000)).out);
ipcMain.handle("agi:baby:alivestatus", async () => (await runBaby(["alivestatus"], undefined, 30000)).out);
ipcMain.handle("agi:baby:graph", async () => (await runBaby(["graph"], undefined, 30000)).out);
// 知识金字塔：分层结构(读) + 主动整理一次(重建，要跑聚类+每层起名，给足超时)
ipcMain.handle("agi:baby:pyramid", async () => (await runBaby(["pyramid"], undefined, 60000)).out);
ipcMain.handle("agi:baby:reorganize", async () => (await runBaby(["reorganize"], undefined, 900000)).out);
