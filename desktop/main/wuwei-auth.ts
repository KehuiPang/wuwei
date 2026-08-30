// 无为账号登录（本地回环中转）：
//   1) 起临时本地 http server(127.0.0.1:随机端口)
//   2) 系统浏览器打开 官网/auth/desktop?port=PORT&state=STATE（复用官网 Google/邮箱登录 UI）
//   3) 官网登录后把 supabase session 经 fragment(#) 302 回 127.0.0.1:PORT/cb
//   4) 本地页用一小段 JS 把 #token 转成对本地的 /cb?token 二次请求，server 收下 token
// 客户端只跟官网通信：不接 Supabase SDK、不持有任何 key。token 续期走官网 /api/refresh。
// —— 从 wuwei-pro 移植（B2）。与 codex/claude 登录(account.ts)互不干扰，是独立的「无为账号态」。
import http from "node:http";
import { shell, app } from "electron";
import { randomBytes } from "node:crypto";
import { log } from "./logger.js";
import { getDeviceId } from "../../src/device-id.js";

const SITE = process.env.WUWEI_SITE_URL ?? "https://wuweiai.io";

// 界面语言（settings.ts 的 applyEnvFromSettings 写入，未手动设置时按系统语言判定）。
// 主进程返回的这些文案会原样显示在登录表单/浏览器中转页上，必须跟界面语言走。
// 注意：语言可运行时切换，所以只在调用时求值，别固化成模块常量。
const tt = (zh: string, en: string) => (process.env.WUWEI_LANG === "en" ? en : zh);

export interface WuweiSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch 毫秒（0=未知）
}

export interface WuweiMe {
  user: { id: string; email: string | null; name: string | null; avatar: string | null };
  coin: { balance: number; lastSignin?: string | null }; // lastSignin: 最近签到日 UTC YYYY-MM-DD，客户端判「今日已签」
  // 会员身份（后端补：tier=免费/Pro月付/Pro年付 + 到期日 + 档位显示名 + 本周额度）。缺=降级免费版+升级引导。
  membership?: {
    tier: "free" | "pro_month" | "pro_year";
    expireAt?: string | number;
    plan?: string | null; // 档位显示名 Pro/Plus/Max
    weeklyQuota?: { active: boolean; remainingPct: number; resetsAt: string | null };
  };
  providers?: { hidden?: string[] };
  // 灰度开关（C2）：后端按 用户+设备指纹 返回的功能白名单，如 ["subscription"]。
  // 缺省/未含对应项 = 隐藏。客户端只渲染、不判定；判定全在后端。
  flags?: string[];
  trialEligible?: boolean; // 从未付费 → 缺币弹 ¥1 体验；否则弹「升级正式会员」
}

// AI 提供商目录（/api/catalog，脱敏）：后台可配的平台顺序/显隐/模型。客户端拿它当默认序 + 模型源，拉不到则回退硬编码 PRESETS。
export interface CatalogModelDto {
  id: string;
  label: string;
  labelEn?: string | null;
  label_en?: string | null; // 兼容旧/直出 snake_case catalog 字段
  free: boolean;
  anon?: boolean; // 未登录是否可用；false=展示但需登录(免费列表里灰置引导登录)。缺省视为 true
  badge?: string | null; // 角标（如「快」），下拉里显示，提醒用户
}
export interface CatalogProviderDto {
  id: string;
  label: string;
  labelEn: string | null;
  kind: string;
  baseUrl: string;
  keyUrl: string;
  keyHint: string;
  note: string;
  noteEn: string;
  hosted: boolean;
  custom: boolean;
  anon: boolean; // 未登录也可见（匿名试用免费模型）
  sort: number;
  models: CatalogModelDto[];
}

// 本地 /cb 页面：把 URL fragment 里的 token 转成对本地的 query 请求（浏览器不把 # 发给 server）
// 写成函数而非常量：文案要在请求发生的那一刻按当前界面语言渲染
const hashBridgeHtml = () => `<!doctype html><meta charset="utf-8"><title>${tt("无为登录", "Sign in to Wuwei")}</title>
<body style="font-family:system-ui;background:#16191E;color:#F4F6F8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:32px">⏳</div><p>${tt("正在完成登录…", "Finishing sign-in…")}</p></div>
<script>location.replace("/cb?"+location.hash.slice(1))</script></body>`;

const doneHtml = () => `<!doctype html><meta charset="utf-8"><title>${tt("无为登录", "Sign in to Wuwei")}</title>
<body style="font-family:system-ui;background:#16191E;color:#F4F6F8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:32px">✅</div><p id="m">${tt("登录成功！本页将自动关闭…", "You're signed in! This page will close automatically…")}</p></div>
<script>
setTimeout(function(){
  window.close();
  // 浏览器通常禁止脚本关闭非脚本打开的标签页；关不掉则退回"可关闭"提示，不空许诺
  setTimeout(function(){ var m=document.getElementById('m'); if(m) m.textContent=${JSON.stringify(tt("登录成功，请回到无为客户端，本页可关闭。", "You're signed in. Head back to the Wuwei app — you can close this page."))}; }, 500);
}, 2500);
</script></body>`;

/** 弹系统浏览器走完整登录，成功返回会话；用户放弃/超时返回 null。 */
// forceSwitch=true(用户显式退出后再登)：给中转页带 switch=1，让它先在浏览器里 signOut 旧会话
// 再跳 /login 重新选账号——否则浏览器残留的旧会话会被直接复用，导致"换不了账号、跳回原账号"。
export function wuweiLogin(forceSwitch = false): Promise<WuweiSession | null> {
  const state = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: WuweiSession | null) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };

    const server = http.createServer((req, res) => {
      let u: URL;
      try {
        u = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (u.pathname !== "/cb") {
        res.writeHead(404).end();
        return;
      }
      const access = u.searchParams.get("access_token");
      if (!access) {
        // 第一跳：还没带 token（token 在 fragment 里）→ 回 JS 把 # 转成 query 再打回来
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(hashBridgeHtml());
        return;
      }
      // 第二跳：拿到 token
      const gotState = u.searchParams.get("state") ?? "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(doneHtml());
      if (gotState !== state) {
        log("wuweiAuth", "state 不匹配，拒绝");
        finish(null);
        return;
      }
      const sess: WuweiSession = {
        accessToken: access,
        refreshToken: u.searchParams.get("refresh_token") ?? "",
        expiresAt: (Number(u.searchParams.get("expires_at")) || 0) * 1000,
      };
      log("wuweiAuth", "✓ 收到会话 token", access.slice(0, 10) + "…");
      finish(sess);
    });

    server.on("error", (e) => {
      log("wuweiAuth", "本地 server 出错", String(e));
      finish(null);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (!port) {
        finish(null);
        return;
      }
      const authUrl = `${SITE}/auth/desktop?port=${port}&state=${state}${forceSwitch ? "&switch=1" : ""}`;
      // 直接开中转页：已登录直接回传、未登录中转页会自跳 /login?next=；switch=1 则先退干净旧会话再重登
      log("wuweiAuth", "打开浏览器登录", authUrl);
      void shell.openExternal(authUrl);
    });

    const killer = setTimeout(() => {
      log("wuweiAuth", "5 分钟超时");
      finish(null);
    }, 300000);
  });
}

/** 上报客户端登录事件（隐私红线：只发匿名 anon_id=设备指纹 + 版本 + 平台，绝不带 email/name/IP 明文）。
 *  写官网 /api/client-event(event=login)，供后台「客户端登录明细/版本分布/平台分布」看板统计。
 *  纯 fire-and-forget：失败静默，绝不影响登录主流程。version 由主进程传入(app.getVersion())。 */
export async function reportClientLogin(version?: string, accessToken?: string | null): Promise<void> {
  try {
    const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : String(process.platform);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    await fetch(`${SITE}/api/client-event`, {
      method: "POST",
      headers,
      body: JSON.stringify({ event: "login", anon_id: getDeviceId(), version: version || "", platform, sys_lang: app.getLocale(), app_lang: process.env.WUWEI_LANG || null }),
    });
  } catch {
    /* 上报失败静默：埋点不能拖累登录 */
  }
}

/** 通用客户端埋点上报（heartbeat 日活 / install 安装）。
 *  隐私红线同 reportClientLogin：只发匿名 anon_id(设备指纹)+版本+平台，绝不带 email/name/IP 明文。
 *  纯 fire-and-forget：失败静默，绝不影响主流程。用于后台算 DAU/留存/安装量。 */
export async function reportClientEvent(event: "heartbeat" | "install", version?: string, active?: boolean, accessToken?: string | null): Promise<void> {
  try {
    const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : String(process.platform);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    await fetch(`${SITE}/api/client-event`, {
      method: "POST",
      headers,
      body: JSON.stringify({ event, anon_id: getDeviceId(), version: version || "", platform, active: active === true, sys_lang: app.getLocale(), app_lang: process.env.WUWEI_LANG || null }),
    });
  } catch {
    /* 上报失败静默：埋点不能拖累主流程 */
  }
}

/** 产品行为埋点上报 → 官网 /api/product-event（通用事件，desktop 端；后台「行为分析」板块读 product_events）。
 *  隐私：只发匿名 anon_id(设备指纹)+版本+平台+事件名+props/detail；登录态带 Bearer 让服务端落 user_id(不落邮箱/姓名)。
 *  纯 fire-and-forget：失败静默，绝不拖累主流程。event/props/detail 由业务侧传入。 */
export async function trackProductEvent(
  event: string,
  opts: { props?: Record<string, unknown>; detail?: string; sessionId?: string | null; version?: string; accessToken?: string | null } = {},
): Promise<void> {
  try {
    if (!event) return;
    const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : String(process.platform);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
    await fetch(`${SITE}/api/product-event`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event,
        surface: "desktop",
        anon_id: getDeviceId(),
        session_id: opts.sessionId || null,
        props: opts.props || {},
        detail: opts.detail || null,
        platform,
        app_version: opts.version || "",
      }),
    });
  } catch {
    /* 埋点失败静默：不拖累主流程 */
  }
}

// ——「发送诊断信息」用户开关（默认开，用户可在设置里关）。关掉后 trackClientLog 一律不发。
let diagConsent = true;
export function setDiagConsent(v: boolean): void {
  diagConsent = v;
}
/** 客户端诊断日志上报：早期用于分析「用户为啥没怎么用/是否报错」。三层开关拦截：
 *  ① 用户设置「发送诊断信息」(diagConsent，默认开) ② 后台 diag.enabled 总开关 ③ 后台留存/消息捕获。
 *  隐私红线：默认只发 报错信息 + 调用画像(模型/成功失败/耗时)，绝不发对话正文(除非后台单独开 capture_messages)。
 *  纯 fire-and-forget：失败静默，绝不拖累客户端。 */
export async function trackClientLog(
  level: "info" | "warn" | "error",
  event: string,
  opts: { message?: string; meta?: Record<string, unknown>; accessToken?: string | null; version?: string } = {},
): Promise<void> {
  try {
    if (!diagConsent || !event) return; // 用户关了诊断上报 → 一条不发
    const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : String(process.platform);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
    await fetch(`${SITE}/api/client-log`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        level,
        event,
        device_id: getDeviceId(),
        message: opts.message ?? null,
        meta: { platform, version: opts.version || "", ...(opts.meta || {}) },
      }),
    });
  } catch {
    /* 诊断上报失败静默 */
  }
}

/** 上报「非托管」（订阅 / 自配 key）用量，供后台统计——网关物理上看不到这类请求（它们直连厂商），
 *  故由客户端每轮结束后自报一次。隐私红线：只发 token 计数 + 模型/平台标识 + 匿名 anon_id + 版本/系统，
 *  绝不发对话内容、也不发用户自己的 API key。登录用户带上 access_token(Authorization)，服务端据此归到 user_id；
 *  未登录(纯自配 key 无账号)则只有设备维度。纯 fire-and-forget：失败静默，绝不拖累对话。 */
export async function reportExternalUsage(
  p: {
    kind: string; // anthropic-oauth / anthropic-apikey / openai / codex
    providerId?: string; // UI 平台标识：claude-oauth / anthropic / openai / openrouter / codex / deepseek ...
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens?: number;
    steps?: number;
    version?: string;
  },
  accessToken?: string | null,
): Promise<void> {
  try {
    if (!p.model || (p.inputTokens <= 0 && p.outputTokens <= 0)) return; // 无实际用量不上报
    const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform === "linux" ? "linux" : String(process.platform);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    await fetch(`${SITE}/api/usage/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        anon_id: getDeviceId(),
        kind: p.kind,
        provider_id: p.providerId || "",
        model: p.model,
        input_tokens: Math.round(p.inputTokens),
        output_tokens: Math.round(p.outputTokens),
        cache_hit_tokens: Math.round(p.cacheHitTokens || 0),
        steps: p.steps || 0,
        platform,
        version: p.version || "",
      }),
    });
  } catch {
    /* 上报失败静默：统计不能拖累对话 */
  }
}

/** token 静默续期：走官网 /api/refresh。成功返回新会话，失败返回 null（需重新登录）。 */
export async function wuweiRefresh(refreshToken: string): Promise<WuweiSession | null> {
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${SITE}/api/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_at: number | null;
    };
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: (j.expires_at || 0) * 1000,
    };
  } catch (e) {
    log("wuweiAuth", "refresh 异常", String(e));
    return null;
  }
}

// —— 应用内登录（邮箱密码 / 手机验证码），不跳浏览器。后端契约见下，需 wuwei-site 实现 ——
// 统一返回：成功=WuweiSession；失败=错误文案字符串。
type SigninResp = { access_token?: string; refresh_token?: string; expires_at?: number; error?: string };
function toSession(j: SigninResp): WuweiSession | null {
  if (!j.access_token) return null;
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? "", expiresAt: (j.expires_at || 0) * 1000 };
}

/** 邮箱/手机号 + 密码 登录（identifier 自动判断邮箱或手机号）。POST 官网 /api/auth/password。 */
export async function wuweiPasswordLogin(identifier: string, password: string): Promise<WuweiSession | string> {
  try {
    const res = await fetch(`${SITE}/api/auth/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
    const j = (await res.json().catch(() => ({}))) as SigninResp;
    if (!res.ok || j.error) return j.error || tt(`登录失败（${res.status}）`, `Sign-in failed (${res.status})`);
    return toSession(j) || tt("登录返回异常", "Unexpected sign-in response");
  } catch (e) {
    log("wuweiAuth", "password 登录异常", String(e));
    return tt("网络错误，请重试", "Network error, please try again");
  }
}

/** 发送手机/邮箱验证码。POST 官网 /api/auth/send-code。返回 true 或错误文案。 */
export async function wuweiSendCode(target: string, lang?: string, purpose?: string): Promise<true | string> {
  try {
    const res = await fetch(`${SITE}/api/auth/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": getDeviceId() }, // 设备指纹→后端注册防刷计数
      body: JSON.stringify({ target, lang, purpose }),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || j.error) return j.error || tt(`发送失败（${res.status}）`, `Couldn't send the code (${res.status})`);
    return true;
  } catch (e) {
    log("wuweiAuth", "send-code 异常", String(e));
    return tt("网络错误，请重试", "Network error, please try again");
  }
}

/** 验证码登录（手机号或邮箱 + code）。POST 官网 /api/auth/verify-code。 */
export async function wuweiCodeLogin(target: string, code: string): Promise<WuweiSession | string> {
  try {
    const res = await fetch(`${SITE}/api/auth/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": getDeviceId() }, // 设备指纹→后端注册防刷计数
      body: JSON.stringify({ target, code }),
    });
    const j = (await res.json().catch(() => ({}))) as SigninResp;
    if (!res.ok || j.error) return j.error || tt(`验证失败（${res.status}）`, `Verification failed (${res.status})`);
    return toSession(j) || tt("登录返回异常", "Unexpected sign-in response");
  } catch (e) {
    log("wuweiAuth", "code 登录异常", String(e));
    return tt("网络错误，请重试", "Network error, please try again");
  }
}

/** 邮箱注册：先 send-code 验证邮箱，再带 code + 新密码注册。POST 官网 /api/auth/register。 */
export async function wuweiRegister(email: string, code: string, password: string): Promise<WuweiSession | string> {
  try {
    const res = await fetch(`${SITE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": getDeviceId() }, // 设备指纹→后端注册防刷计数
      body: JSON.stringify({ email, code, password }),
    });
    const j = (await res.json().catch(() => ({}))) as SigninResp;
    if (!res.ok || j.error) return j.error || tt(`注册失败（${res.status}）`, `Sign-up failed (${res.status})`);
    return toSession(j) || tt("注册返回异常", "Unexpected sign-up response");
  } catch (e) {
    log("wuweiAuth", "register 异常", String(e));
    return tt("网络错误，请重试", "Network error, please try again");
  }
}

/** 查账号 + 无为币余额。401 视为 token 失效由调用方决定是否 refresh。 */
export async function wuweiFetchMe(accessToken: string): Promise<WuweiMe | "unauthorized" | null> {
  try {
    // 上报身份：Bearer=用户身份，X-Device-Id=稳定机器指纹，供后端按 用户/设备 决策灰度 flags。
    const res = await fetch(`${SITE}/api/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Device-Id": getDeviceId() },
    });
    if (res.status === 401) return "unauthorized";
    if (!res.ok) return null;
    return (await res.json()) as WuweiMe;
  } catch (e) {
    log("wuweiAuth", "fetchMe 异常", String(e));
    return null;
  }
}

/** 拉 AI 提供商目录（脱敏）。带上 token(可选，用于登录态+每用户显隐) + 设备指纹。失败返回 null → 客户端回退硬编码。 */
export async function wuweiFetchCatalog(accessToken?: string | null): Promise<CatalogProviderDto[] | null> {
  try {
    const headers: Record<string, string> = { "X-Device-Id": getDeviceId() };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const res = await fetch(`${SITE}/api/catalog`, { headers });
    if (!res.ok) return null;
    const j = (await res.json()) as { providers?: CatalogProviderDto[] };
    return Array.isArray(j.providers) ? j.providers : null;
  } catch (e) {
    log("wuweiAuth", "fetchCatalog 异常", String(e));
    return null;
  }
}

// ── 国内扫码支付（支付宝当面付 / 微信 Native）：下单拿二维码 + 轮询订单状态 ──
export interface PayCreateResult {
  orderId: string;
  qr: string; // 二维码串（支付宝 qr_code / 微信 code_url），客户端渲染成 QR
  channel: string;
  amountFen: number;
  coins: number;
  bonus: number;
}
export interface PayStatusResult {
  status: string; // pending | paid | failed | expired
  balance?: number; // 到账后的最新余额
}

/** 下单：只传 sku + channel，金额/币量以后端为准。返回二维码串。 */
export async function wuweiPayCreate(
  accessToken: string,
  sku: string,
  channel: string,
): Promise<PayCreateResult | "unauthorized" | { error: string; message?: string }> {
  try {
    const res = await fetch(`${SITE}/api/pay/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Device-Id": getDeviceId(),
      },
      body: JSON.stringify({ sku, channel }),
    });
    if (res.status === 401) return "unauthorized";
    const j = (await res.json().catch(() => null)) as (PayCreateResult & { error?: string; message?: string }) | null;
    if (!res.ok || !j) return { error: j?.error || `http_${res.status}`, message: j?.message };
    if (j.error) return { error: j.error, message: j.message };
    return j;
  } catch (e) {
    log("wuweiAuth", "payCreate 异常", String(e));
    return { error: "network" };
  }
}

/** 轮询订单状态（后端会主动查单兜底）。 */
export async function wuweiPayStatus(
  accessToken: string,
  orderId: string,
): Promise<PayStatusResult | "unauthorized" | null> {
  try {
    const res = await fetch(`${SITE}/api/pay/status?order=${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Device-Id": getDeviceId() },
    });
    if (res.status === 401) return "unauthorized";
    if (!res.ok) return null;
    return (await res.json()) as PayStatusResult;
  } catch (e) {
    log("wuweiAuth", "payStatus 异常", String(e));
    return null;
  }
}
