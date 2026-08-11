// 无为账号登录（本地回环中转）：
//   1) 起临时本地 http server(127.0.0.1:随机端口)
//   2) 系统浏览器打开 官网/auth/desktop?port=PORT&state=STATE（复用官网 Google/邮箱登录 UI）
//   3) 官网登录后把 supabase session 经 fragment(#) 302 回 127.0.0.1:PORT/cb
//   4) 本地页用一小段 JS 把 #token 转成对本地的 /cb?token 二次请求，server 收下 token
// 客户端只跟官网通信：不接 Supabase SDK、不持有任何 key。token 续期走官网 /api/refresh。
// —— 从 wuwei-pro 移植（B2）。与 codex/claude 登录(account.ts)互不干扰，是独立的「无为账号态」。
import http from "node:http";
import { shell } from "electron";
import { randomBytes } from "node:crypto";
import { log } from "./logger.js";
import { getDeviceId } from "../../src/device-id.js";

const SITE = process.env.WUWEI_SITE_URL ?? "https://wuweiai.io";

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
}

// AI 提供商目录（/api/catalog，脱敏）：后台可配的平台顺序/显隐/模型。客户端拿它当默认序 + 模型源，拉不到则回退硬编码 PRESETS。
export interface CatalogModelDto {
  id: string;
  label: string;
  free: boolean;
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
const HASH_BRIDGE_HTML = `<!doctype html><meta charset="utf-8"><title>无为登录</title>
<body style="font-family:system-ui;background:#16191E;color:#F4F6F8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:32px">⏳</div><p>正在完成登录…</p></div>
<script>location.replace("/cb?"+location.hash.slice(1))</script></body>`;

const DONE_HTML = `<!doctype html><meta charset="utf-8"><title>无为登录</title>
<body style="font-family:system-ui;background:#16191E;color:#F4F6F8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:32px">✅</div><p id="m">登录成功！本页将自动关闭…</p></div>
<script>
setTimeout(function(){
  window.close();
  // 浏览器通常禁止脚本关闭非脚本打开的标签页；关不掉则退回"可关闭"提示，不空许诺
  setTimeout(function(){ var m=document.getElementById('m'); if(m) m.textContent='登录成功，请回到无为客户端，本页可关闭。'; }, 500);
}, 2500);
</script></body>`;

/** 弹系统浏览器走完整登录，成功返回会话；用户放弃/超时返回 null。 */
export function wuweiLogin(): Promise<WuweiSession | null> {
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
        res.end(HASH_BRIDGE_HTML);
        return;
      }
      // 第二跳：拿到 token
      const gotState = u.searchParams.get("state") ?? "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DONE_HTML);
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
      const authUrl = `${SITE}/auth/desktop?port=${port}&state=${state}`;
      // 直接开中转页：已登录直接回传、未登录中转页会自跳 /login?next=
      log("wuweiAuth", "打开浏览器登录", authUrl);
      void shell.openExternal(authUrl);
    });

    const killer = setTimeout(() => {
      log("wuweiAuth", "5 分钟超时");
      finish(null);
    }, 300000);
  });
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
    if (!res.ok || j.error) return j.error || `登录失败（${res.status}）`;
    return toSession(j) || "登录返回异常";
  } catch (e) {
    log("wuweiAuth", "password 登录异常", String(e));
    return "网络错误，请重试";
  }
}

/** 发送手机/邮箱验证码。POST 官网 /api/auth/send-code。返回 true 或错误文案。 */
export async function wuweiSendCode(target: string, lang?: string, purpose?: string): Promise<true | string> {
  try {
    const res = await fetch(`${SITE}/api/auth/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, lang, purpose }),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || j.error) return j.error || `发送失败（${res.status}）`;
    return true;
  } catch (e) {
    log("wuweiAuth", "send-code 异常", String(e));
    return "网络错误，请重试";
  }
}

/** 验证码登录（手机号或邮箱 + code）。POST 官网 /api/auth/verify-code。 */
export async function wuweiCodeLogin(target: string, code: string): Promise<WuweiSession | string> {
  try {
    const res = await fetch(`${SITE}/api/auth/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, code }),
    });
    const j = (await res.json().catch(() => ({}))) as SigninResp;
    if (!res.ok || j.error) return j.error || `验证失败（${res.status}）`;
    return toSession(j) || "登录返回异常";
  } catch (e) {
    log("wuweiAuth", "code 登录异常", String(e));
    return "网络错误，请重试";
  }
}

/** 邮箱注册：先 send-code 验证邮箱，再带 code + 新密码注册。POST 官网 /api/auth/register。 */
export async function wuweiRegister(email: string, code: string, password: string): Promise<WuweiSession | string> {
  try {
    const res = await fetch(`${SITE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code, password }),
    });
    const j = (await res.json().catch(() => ({}))) as SigninResp;
    if (!res.ok || j.error) return j.error || `注册失败（${res.status}）`;
    return toSession(j) || "注册返回异常";
  } catch (e) {
    log("wuweiAuth", "register 异常", String(e));
    return "网络错误，请重试";
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
