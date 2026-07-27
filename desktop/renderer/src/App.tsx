import React, { useEffect, useRef, useState } from "react";
import type { WuweiMe } from "../../main/wuwei-auth.js";
import { getLang, setLang as persistLang, makeT, type Lang, type T } from "./i18n.js";
import { BRAND_LOGOS } from "./brandLogos.js";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

type Item =
  | { type: "user"; text: string; images?: string[]; ts?: number }
  | { type: "assistant"; text: string; ts?: number }
  | {
      type: "tool";
      id?: string; // 工具调用 id：并行时用来精确匹配 start/end(不再靠"最后一个running")
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      status: "running" | "done";
    }
  | { type: "notice"; text: string };

interface Usage {
  totalInput: number;
  totalOutput: number;
  lastInput: number;
}
interface Pending {
  id: number;
  name: string;
  input: Record<string, unknown>;
}
interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  group?: string;
  priority?: number;
  priorityTag?: string;
  order?: number;
  project?: string;
  done?: boolean;
}

// 优先级方案：高/中/低 + 艾森豪威尔四象限。weight 用于排序(大在前)，tag=徽标短标签，label=全称
const PRIO_HL = [
  { tag: "高", weight: 3, label: "高" },
  { tag: "中", weight: 2, label: "中" },
  { tag: "低", weight: 1, label: "低" },
];
const PRIO_QUAD = [
  { tag: "重急", weight: 4, label: "紧急重要" },
  { tag: "重", weight: 3, label: "不紧急重要" },
  { tag: "急", weight: 2, label: "紧急不重要" },
  { tag: "缓", weight: 1, label: "不紧急不重要" },
];
const PRIO_TITLE: Record<string, string> = Object.fromEntries(
  [...PRIO_HL, ...PRIO_QUAD].map((p) => [p.tag, p.label]),
);

// 图片放大预览：模块级 opener，供 ItemView(消息里的图) 调用，避免逐层传 props
let openImageLightbox: ((src: string) => void) | null = null;

const CTX_MAX = 1_000_000; // gpt-5.5 上下文窗口估算，用于占用条

// 把持久化的 messages 还原成展示用 items
function messagesToItems(messages: any[]): Item[] {
  const items: Item[] = [];
  const toolById: Record<string, Extract<Item, { type: "tool" }>> = {};
  for (const m of messages) {
    if (m.role === "user") {
      let text = "";
      const imgs: string[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text) text += b.text;
        else if (b.type === "image") imgs.push(b.dataUrl);
        else if (b.type === "tool_result" && toolById[b.tool_use_id]) {
          const t = toolById[b.tool_use_id];
          t.result = b.content;
          t.isError = b.is_error;
          t.status = "done";
        }
      }
      if (text || imgs.length)
        items.push({ type: "user", text, images: imgs.length ? imgs : undefined, ts: m.ts });
    } else {
      for (const b of m.content) {
        if (b.type === "text" && b.text) items.push({ type: "assistant", text: b.text, ts: m.ts });
        else if (b.type === "tool_use") {
          const it: Extract<Item, { type: "tool" }> = {
            type: "tool",
            name: b.name,
            input: b.input,
            status: "done",
          };
          items.push(it);
          toolById[b.id] = it;
        }
      }
    }
  }
  return items;
}

// 把后端/SDK 的原始报错（多为英文）归纳成一句中文提示，避免把整段英文甩给用户。
// 返回值以「出错：」开头，鉴权类务必含 isAuthError 能识别的关键词（未授权/凭证），以便触发一键授权条。
function friendlyError(raw: string): string {
  const r = raw || "";
  // 无为托管网关的业务错误 → 友好中文（优先，避免被下方通用 401/429 规则吃掉）
  if (/insufficient_balance/i.test(r)) return "无为币余额不足：请点账号头像「充值」后，再使用无为托管模型。";
  if (/daily_cap_reached/i.test(r)) return "今日无为托管消耗已达上限：明日自动恢复，或联系客服提额。";
  if (/gateway_not_configured/i.test(r)) return "无为托管暂不可用（服务维护中）：请稍后再试，或切换到其它模型。";
  if (/unknown_hosted_model/i.test(r)) return "该无为托管模型暂不可用，请换一个模型。";
  if (/upstream_error/i.test(r)) return "模型服务商暂时不可用：请稍后重试。";
  if (/gateway_error[\s\S]*(invalid_token|no_token)/i.test(r))
    return "无为账号登录已过期：请重新登录后再用托管模型。";
  if (/authentication method|apiKey or authToken|x-api-key|unauthorized|\b401\b|invalid.*key|api key/i.test(r))
    return "出错：当前模型未授权或缺少凭证（API Key / 订阅授权），请先完成授权。";
  if (/rate.?limit|\b429\b|quota|exceed|too many/i.test(r))
    return "出错：请求过于频繁或额度已用尽（触发限流），请稍后再试。";
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang/i.test(r))
    return "出错：网络连接失败，请检查网络 / 代理后重试。";
  if (/\b400\b|invalid_request|bad request|context length|too long|max.*token/i.test(r))
    return "出错：请求有误（可能是模型名不对或上下文超长）。";
  if (/\b5\d\d\b|server error|internal error|overloaded/i.test(r))
    return "出错：服务端错误或繁忙，请稍后重试。";
  // 未知错误：只取首行 + 截断，加中文前缀，不整段英文轰炸
  return "出错：" + (r.split("\n")[0] || r).slice(0, 120);
}

function isCoinShortage(raw: string): boolean {
  return /insufficient_balance|无为币余额不足|积分余额不足|余额不足/i.test(raw || "");
}

// 粗判是否像 API Key：无空白、可见 ASCII、够长(真正闸门是连通测试)
function isLikelyKey(s: string): boolean {
  const t = (s || "").trim();
  return t.length >= 20 && t.length <= 400 && !/\s/.test(t) && /^[\x21-\x7e]+$/.test(t);
}

// 验证失败时：报错是否说明「Key 本身无效」(鉴权失败)。
// 只有这种才拒绝保存；余额不足/额度/账单/限流等 = Key 有效、账户问题 → 照样保存并提醒。
function keyRejected(reason: string): boolean {
  return /\b401\b|authentication_error|invalid[_ ]?api[_ ]?key|invalid x-api-key|unauthorized|permission_error|api key not valid|no auth/i.test(
    reason || "",
  );
}

// 报错文案是否属于「缺鉴权」（据此显示一键授权条；兼容英文原文与翻译后的中文）
function isAuthErrorText(text: string): boolean {
  return /authentication method|apiKey or authToken|x-api-key|unauthorized|401|缺少模型凭证|未初始化|未授权|缺少凭证|授权/i.test(
    text,
  );
}

// minicc 主标·橙色 sparkle 星星（沿用初版 app 图标的四角星几何，缩放到 24 视口；
// 主星 currentColor 随主题走，右上小星用一点朱 --spark 呼应品牌）
// 无为官方主标（几何同 WuweiLogo / 官网 WuMark：同 path、不旋转、stroke 12/dot 10）。
// 顶栏用 currentColor 描边以适配文字色，缺口处一点朱赭火种。
function WuweiMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      aria-hidden="true"
      style={{ flex: "0 0 auto" }}
    >
      <path
        d="M152.04 193.48 A82 82 0 1 1 195.48 150.04"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="195.48" cy="150.04" r="10" fill="#C05F3C" />
    </svg>
  );
}

// —— 简约 SVG 图标（禁用 emoji，统一线性风、跟随 currentColor）——
// 深色主题已下线：存量 "dark"/空值一律回退为白色，仅保留 light / gold。
function resolveTheme(t?: string): string {
  return t === "light" || t === "gold" ? t : "light";
}
function CoinIcon({ size = 14 }: { size?: number }) {
  // 币：填充淡底 + 描边 + ¥ 记号，比双环更像“货币”
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.16" />
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.4 8l3.6 4 3.6-4M12 12v4.2M9.2 12.4h5.6M9.2 14.6h5.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
// 无为官方主标「一念之门圆相」（精确复刻 wuwei-site LandNav 的 WuMark：同 path、不旋转、stroke 12/dot 10）。
// 用于浅色登录面：描边玄墨黑，朱赭火种点。
function WuweiLogo({ size = 46 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 240 240" aria-hidden="true" style={{ flex: "0 0 auto", display: "block" }}>
      <path
        d="M152.04 193.48 A82 82 0 1 1 195.48 150.04"
        fill="none"
        stroke="#16191E"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <circle cx="195.48" cy="150.04" r="10" fill="#C05F3C" />
    </svg>
  );
}
function GlobeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto", display: "block" }}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.6-5.3-3.6-8.5S9.6 5.8 12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
    </svg>
  );
}
function GearIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
function LogoutIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path
        d="M14.5 5H6.8A1.8 1.8 0 0 0 5 6.8v10.4A1.8 1.8 0 0 0 6.8 19h7.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M18.5 12H10m8.5 0-3-3m3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function RefreshIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M20 4v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GiftIcon({ size = 22, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <rect x="3.5" y="9" width="17" height="11.5" rx="1.6" stroke={color} strokeWidth="1.6" />
      <path d="M2.5 9h19v3.2h-19z" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 9v11.5" stroke={color} strokeWidth="1.6" />
      <path d="M12 9S10.8 5 8 5a1.8 1.8 0 000 3.6c2 0 4 .4 4 .4Zm0 0s1.2-4 4-4a1.8 1.8 0 010 3.6c-2 0-4 .4-4 .4Z" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// 应用内登录框（邮箱密码登录 / 邮箱验证码注册 / 手机验证码直登注册 / Google浏览器兜底）
// 后端契约（需 wuwei-site 实现）：
//   POST /api/auth/password    {identifier,password}     → {access_token,refresh_token,expires_at}|{error}
//   POST /api/auth/send-code   {target}                  → {ok}|{error}   (target=邮箱或手机号)
//   POST /api/auth/register    {email,code,password}     → {...tokens}|{error}
//   POST /api/auth/verify-code {target,code}             → {...tokens}|{error}  (无账号自动注册)
// 登录方式开关：手机号 / 微信后端尚未接通，先隐藏；接通后翻成 true 即恢复。
const PHONE_LOGIN_ENABLED = false;
const WECHAT_LOGIN_ENABLED = false;

function WuweiLoginModal({
  incentive,
  lang,
  t,
  onClose,
  onSuccess,
}: {
  incentive?: boolean;
  lang: Lang;
  t: T;
  onClose: () => void;
  onSuccess: (me: WuweiMe, action?: "login" | "register" | "reset") => void;
}) {
  type Mode = "email-login" | "email-register" | "email-reset" | "phone";
  const zh = lang === "zh";
  const [mode, setMode] = useState<Mode>("email-login");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false); // 验证码发送单独态，不牵连主按钮
  const [err, setErr] = useState("");
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // 后端可能回错误码(如 missing_credentials)或人类可读消息；码→友好文案，消息→原样。
  function friendlyErr(raw?: string): string {
    const s = (raw || "").trim();
    if (!s) return t("login.err.generic");
    // 1. 精确错误码(如 missing_credentials / email_exists)
    const mapped = t("login.err." + s.toLowerCase(), "");
    if (mapped) return mapped;
    // 2. 已含中文(多为我们后端的可读提示) → 原样显示
    if (/[一-鿿]/.test(s)) return s;
    // 3. 匹配已知英文消息(Supabase 等第三方回的) → 映射成中文
    const low = s.toLowerCase();
    const M: [string, string][] = [
      ["invalid login credentials", "login.err.invalid_credentials"],
      ["invalid credentials", "login.err.invalid_credentials"],
      ["email not confirmed", "login.err.email_not_confirmed"],
      ["already registered", "login.err.email_exists"],
      ["already been registered", "login.err.email_exists"],
      ["user not found", "login.err.user_not_found"],
      ["signups not allowed", "login.err.user_not_found"],
      ["has expired", "login.err.code_expired"],
      ["expired", "login.err.code_expired"],
      ["invalid otp", "login.err.invalid_code"],
      ["invalid token", "login.err.invalid_code"],
      ["token is invalid", "login.err.invalid_code"],
      ["should be at least", "login.err.weak_password"],
      ["for security purposes", "login.err.rate_limited"],
      ["rate limit", "login.err.rate_limited"],
      ["too many", "login.err.rate_limited"],
      ["network", "login.err.network"],
      ["failed to fetch", "login.err.network"],
    ];
    for (const [pat, key] of M) if (low.includes(pat)) return t(key);
    // 4. 其它未知英文技术消息 → 通用兜底(绝不把英文技术串丢给用户)
    return t("login.err.generic");
  }
  async function sendCode() {
    const target = mode === "phone" ? phone.trim() : email.trim();
    if (!target) {
      setErr(mode === "phone" ? t("login.needPhone") : t("login.needEmail"));
      return;
    }
    setSending(true);
    setErr("");
    // 注册要求邮箱未注册、找回密码要求已注册 → 后端按 purpose 查重
    const purpose = mode === "email-reset" ? "reset" : mode === "email-register" ? "register" : undefined;
    const r = await window.minicc.wuweiSendCode(target, lang, purpose);
    setSending(false);
    if (r === true) {
      setCooldown(60);
      return;
    }
    // 注册时邮箱已存在 → 提示并引导去登录
    if (r === "email_exists") {
      setErr(t("login.err.email_exists"));
      setMode("email-login");
      return;
    }
    setErr(typeof r === "string" ? friendlyErr(r) : t("login.sendFail"));
  }
  async function submit() {
    // 客户端先做空值校验，避免把 missing_credentials 这类码丢给用户
    if (mode === "phone") {
      if (!phone.trim()) return setErr(t("login.needPhone"));
      if (!code.trim()) return setErr(t("login.needCode"));
    } else {
      if (!email.trim()) return setErr(t("login.needEmail"));
      if ((mode === "email-register" || mode === "email-reset") && !code.trim()) return setErr(t("login.needCode"));
      if (!password) return setErr(t("login.needPassword"));
    }
    setBusy(true);
    setErr("");
    let res: { me?: WuweiMe; error?: string };
    if (mode === "email-login") res = await window.minicc.wuweiPasswordLogin(email.trim(), password);
    // 找回密码复用 register 接口：验证码校验通过后重设密码并直接登录
    else if (mode === "email-register" || mode === "email-reset")
      res = await window.minicc.wuweiRegister(email.trim(), code.trim(), password);
    else res = await window.minicc.wuweiCodeLogin(phone.trim(), code.trim());
    setBusy(false);
    if (res.me)
      onSuccess(res.me, mode === "email-register" ? "register" : mode === "email-reset" ? "reset" : "login");
    else setErr(friendlyErr(res.error));
  }
  async function googleLogin() {
    setBusy(true);
    setErr("");
    const me = await window.minicc.wuweiLogin();
    setBusy(false);
    if (me) onSuccess(me);
    else setErr(t("login.googleIncomplete"));
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "9px 11px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-input)",
    color: "var(--text)",
    fontSize: 13,
    marginBottom: 9,
    outline: "none",
    boxSizing: "border-box",
  };
  const tabStyle = (on: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "7px 0",
    fontSize: 13,
    cursor: "pointer",
    background: "none",
    border: "none",
    color: on ? "var(--text)" : "var(--text-muted)",
    fontWeight: on ? 600 : 400,
    borderBottom: on ? "2px solid var(--spark)" : "2px solid transparent",
  });
  // 验证码按钮：与输入框同高、主题中性、品牌色文字；冷却/发送时置灰
  const codeBtnStyle: React.CSSProperties = {
    flex: "0 0 auto",
    padding: "0 12px",
    height: 36,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg-soft)",
    color: cooldown > 0 || sending ? "var(--text-muted)" : "var(--spark)",
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: "nowrap",
    cursor: cooldown > 0 || sending ? "default" : "pointer",
    marginBottom: 9,
  };
  const codeBtnLabel = cooldown > 0 ? `${cooldown}s` : sending ? t("login.sending") : t("login.getCode");

  return (
    <>
      <div className="mq-overlay" onClick={onClose} />
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div
          style={{
            width: 340,
            maxWidth: "90vw",
            background: "var(--bg-raised)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: "22px 22px 18px",
            boxShadow: "0 16px 44px rgba(0,0,0,.28)",
            position: "relative",
          }}
        >
          <button
            onClick={onClose}
            title="关闭"
            style={{ position: "absolute", top: 8, right: 10, width: 26, height: 26, background: "none", border: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: "pointer" }}
          >
            ×
          </button>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginBottom: incentive ? 8 : 16 }}>
            <WuweiLogo size={46} />
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0.5 }}>
              {mode === "email-register"
                ? t("login.register")
                : mode === "email-reset"
                  ? t("login.resetTitle")
                  : t("login.signin")}
            </div>
          </div>
          {incentive && (
            <div style={{ textAlign: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>
                {t("login.freeModels")}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{t("login.incentive")}</div>
            </div>
          )}
          {/* 邮箱/手机 切换：仅中文版有手机号（后端未接通时整块隐藏） */}
          {zh && PHONE_LOGIN_ENABLED && (
            <div style={{ display: "flex", marginBottom: 14 }}>
              <button style={tabStyle(mode !== "phone")} onClick={() => { setMode("email-login"); setErr(""); }}>
                {t("login.tab.email")}
              </button>
              <button style={tabStyle(mode === "phone")} onClick={() => { setMode("phone"); setErr(""); }}>
                {t("login.tab.phone")}
              </button>
            </div>
          )}

          {mode === "phone" ? (
            <>
              <input style={inputStyle} placeholder={t("login.phone")} value={phone} onChange={(e) => setPhone(e.target.value)} />
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...inputStyle, flex: 1 }} placeholder={t("login.code")} value={code} onChange={(e) => setCode(e.target.value)} />
                <button onClick={sendCode} disabled={sending || cooldown > 0} style={codeBtnStyle}>
                  {codeBtnLabel}
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>{t("login.autoRegister")}</div>
            </>
          ) : (
            <>
              <input style={inputStyle} placeholder={t("login.email")} value={email} onChange={(e) => setEmail(e.target.value)} />
              {(mode === "email-register" || mode === "email-reset") && (
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={{ ...inputStyle, flex: 1 }} placeholder={t("login.emailCode")} value={code} onChange={(e) => setCode(e.target.value)} />
                  <button onClick={sendCode} disabled={sending || cooldown > 0} style={codeBtnStyle}>
                    {codeBtnLabel}
                  </button>
                </div>
              )}
              <input
                style={inputStyle}
                type="password"
                placeholder={
                  mode === "email-register"
                    ? t("login.setPassword")
                    : mode === "email-reset"
                      ? t("login.newPassword")
                      : t("login.password")
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode === "email-login" && (
                <div style={{ textAlign: "right", marginTop: -3, marginBottom: 4 }}>
                  <span
                    style={{ fontSize: 11.5, color: "var(--text-muted)", cursor: "pointer" }}
                    onClick={() => { setMode("email-reset"); setErr(""); }}
                  >
                    {t("login.forgotPassword")}
                  </span>
                </div>
              )}
            </>
          )}

          {err && <div style={{ color: "var(--spark)", fontSize: 12, marginBottom: 10, textAlign: "center" }}>{err}</div>}

          <button
            onClick={submit}
            disabled={busy}
            style={{ width: "100%", padding: "10px", borderRadius: 9, border: "none", background: "var(--spark)", color: "#F4F6F8", fontSize: 14, fontWeight: 600, cursor: busy ? "default" : "pointer", marginBottom: 10 }}
          >
            {busy
              ? t("login.busy")
              : mode === "email-register"
                ? t("login.register")
                : mode === "email-reset"
                  ? t("login.resetSubmit")
                  : t("login.signin")}
          </button>

          {/* 底部切换：前缀灰字 + 动作词品牌色强调（忘记密码已移到密码框下方） */}
          {mode !== "phone" && (
            <div style={{ textAlign: "center", fontSize: 12, marginBottom: 12, color: "var(--text-muted)" }}>
              {mode === "email-reset" ? (
                <span
                  style={{ color: "var(--spark)", fontWeight: 500, cursor: "pointer" }}
                  onClick={() => { setMode("email-login"); setErr(""); }}
                >
                  {t("login.backToLogin")}
                </span>
              ) : mode === "email-register" ? (
                <>
                  {t("login.haveAccountPrefix")}
                  <span
                    style={{ color: "var(--spark)", fontWeight: 500, cursor: "pointer" }}
                    onClick={() => { setMode("email-login"); setErr(""); }}
                  >
                    {t("login.gotoLogin")}
                  </span>
                </>
              ) : (
                <>
                  {t("login.noAccountPrefix")}
                  <span
                    style={{ color: "var(--spark)", fontWeight: 500, cursor: "pointer" }}
                    onClick={() => { setMode("email-register"); setErr(""); }}
                  >
                    {t("login.registerNow")}
                  </span>
                </>
              )}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-faint)", fontSize: 11, margin: "2px 0 12px" }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            {t("login.or")}
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>
          <button
            onClick={googleLogin}
            disabled={busy}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: 9,
              border: "1px solid #dadce0",
              background: "#fff",
              color: "#3c4043",
              fontSize: 13,
              fontWeight: 500,
              cursor: busy ? "default" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 9,
              marginBottom: zh && WECHAT_LOGIN_ENABLED ? 8 : 0,
            }}
          >
            <img src={BRAND_LOGOS.google} alt="" width={17} height={17} style={{ display: "block", flex: "0 0 auto" }} />
            {t("login.google")}
          </button>
          {zh && WECHAT_LOGIN_ENABLED && (
            <button
              disabled
              title={t("login.wechat")}
              style={{ width: "100%", padding: "9px", borderRadius: 9, border: "1px solid var(--border)", background: "none", color: "var(--text-faint)", fontSize: 13, cursor: "not-allowed" }}
            >
              {t("login.wechat")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

export function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [now, setNow] = useState(() => Date.now()); // 相对时间戳每 30s 刷新一次
  const [runningSet, setRunningSet] = useState<Set<string>>(() => new Set()); // 多任务:正在跑的会话id集
  const [pending, setPending] = useState<Pending | null>(null);
  const [meta, setMeta] = useState({
    backend: "…",
    model: "…",
    cwd: "",
    sub: false,
    ctxWindow: CTX_MAX,
  });
  const [usage, setUsage] = useState<Usage>({ totalInput: 0, totalOutput: 0, lastInput: 0 });
  const [rate, setRate] = useState<any>(null);
  const [input, setInput] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null); // 图片放大预览的 src
  openImageLightbox = setLightbox; // 供 ItemView 里的图调用
  const [suggestion, setSuggestion] = useState(""); // 输入框幽灵提示：下一步动作建议(Tab 补全)
  const [autoMode, setAutoMode] = useState(true);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [groups, setGroups] = useState<string[]>([]); // 分组顺序(新组置顶)
  const [groupMode, setGroupMode] = useState<"manual" | "date" | "project">("manual"); // 分组模式
  const [streamMode, setStreamMode] = useState<"typewriter" | "stream" | "instant">("stream"); // 输出方式
  const [streamSpeed, setStreamSpeed] = useState(400); // 打字机速度(字符/秒)
  const [keepRecent, setKeepRecent] = useState(12); // 上下文压缩保留最近N条
  const streamModeRef = useRef(streamMode);
  streamModeRef.current = streamMode;
  const streamSpeedRef = useRef(streamSpeed);
  streamSpeedRef.current = streamSpeed;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [ctxMenu, setCtxMenu] = useState<{ sid: string; x: number; y: number } | null>(null); // 会话右键菜单
  const [groupCtx, setGroupCtx] = useState<{ name: string; x: number; y: number } | null>(null); // 分组右键菜单
  const [dragId, setDragId] = useState<string | null>(null); // 正在拖拽的会话 id
  const [dragOverId, setDragOverId] = useState<string | null>(null); // 拖到哪个会话上(高亮)
  const [dragGroup, setDragGroup] = useState<string | null>(null); // 正在拖拽的组名
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null); // 拖到哪个组头上
  const [groupInputSid, setGroupInputSid] = useState<string | null>(null); // 正在为哪个会话输入新组名
  const [newGroupName, setNewGroupName] = useState("");
  const [currentId, setCurrentId] = useState("");
  const busy = runningSet.has(currentId); // 当前可见会话是否在跑(多任务:各会话独立)
  const currentIdRef = useRef(currentId); // 事件回调里读最新 currentId(判是否本会话的更新)
  currentIdRef.current = currentId;
  const [showUsage, setShowUsage] = useState(false);
  const [showTasks, setShowTasks] = useState(false); // 运行中任务列表弹窗
  const [showBrowser, setShowBrowser] = useState(false); // 内置浏览器面板(可视化AI操作)
  const [browserMode, setBrowserMode] = useState<"split" | "full">("split"); // 半屏/全屏
  const [browserDetached, setBrowserDetached] = useState(false); // 是否弹成独立窗口
  const [browserWidth, setBrowserWidth] = useState(640); // 浏览器面板宽度(可拖动分隔条调)
  const [showBrowserMenu, setShowBrowserMenu] = useState(false); // 独立时顶栏浏览器图标的下拉
  const [footCompact, setFootCompact] = useState(false); // 底栏空间不够→收起次要信息
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFootCompact(el.clientWidth < 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [browserInfo, setBrowserInfo] = useState<{
    url?: string;
    title?: string;
    loading?: boolean;
    canGoBack?: boolean;
    canGoForward?: boolean;
  }>({});
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState("model"); // 统一设置页的初始/当前左侧菜单项
  const [curProviderId, setCurProviderId] = useState("");
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({}); // 各平台实时拉到的模型
  const [showAllModels, setShowAllModels] = useState(false); // 切换模型下拉：false=常用(预设旗舰) true=全部(含实时拉取)
  const [stations, setStations] = useState<Station[]>([]); // 自定义中转站
  const [providerOrder, setProviderOrder] = useState<string[]>([]); // 平台自定义顺序
  const [hiddenProviders, setHiddenProviders] = useState<string[]>([]); // 隐藏的平台
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [sidebarW, setSidebarW] = useState(
    () => Number(localStorage.getItem("minicc-sidebar-w")) || 232,
  );
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("minicc-sidebar-collapsed") === "1",
  );
  const sidebarWRef = useRef(sidebarW);
  sidebarWRef.current = sidebarW;
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // 输入框草稿持久化：文字+粘贴的截图实时落盘(~/.wuwei/draft.json)，重开/更新后自动恢复。
  // draftLoadedRef 保证「先加载完再回写」，避免初始空草稿把已存内容冲掉。
  const draftLoadedRef = useRef(false);
  useEffect(() => {
    window.minicc
      .draftGet()
      .then((d) => {
        if (d?.text) setInput(d.text);
        if (d?.images?.length) setPendingImages(d.images);
      })
      .catch(() => {})
      .finally(() => {
        draftLoadedRef.current = true;
      });
  }, []);
  useEffect(() => {
    if (!draftLoadedRef.current) return;
    const t = setTimeout(() => {
      window.minicc.draftSet({ text: input, images: pendingImages });
    }, 250);
    return () => clearTimeout(t);
  }, [input, pendingImages]);
  // 知识网络后台进度：主进程为真相源，无论设置弹窗开没开都持续订阅，供底部状态栏实时显示。
  const [idxProg, setIdxProg] = useState<{
    building: boolean;
    phase: string;
    files: number;
    total: number;
    done: number;
  } | null>(null);
  const [conProg, setConProg] = useState<{
    running: boolean;
    phase: string;
    total: number;
    done: number;
    created: number;
    cur?: string;
  } | null>(null);
  useEffect(() => {
    window.minicc.brainDocProgress?.().then((s: any) => setIdxProg(s)).catch(() => {});
    window.minicc.brainConceptProgress?.().then((s: any) => setConProg(s)).catch(() => {});
    const off = window.minicc.onEvent((ch, p: any) => {
      if (ch === "evt:brain-docs") setIdxProg(p);
      else if (ch === "evt:brain-concepts") setConProg(p);
    });
    return off;
  }, []);
  // 发送前检测到的疑似新密钥→确认弹窗
  type SecCand = {
    value: string;
    masked: string;
    kind: string;
    suggestedName: string;
    note?: string;
    existing?: { id: string; name: string; note?: string }; // 该值已在保险箱(备注不同)→三选一
  };
  const [secretPrompt, setSecretPrompt] = useState<{
    text: string; // 原始文本(供存入后重新扫描)
    redacted: string; // 已把已入库密钥换成占位符的版本(用于显示/发送)
    imgs: string[];
    inject: boolean;
    candidates: SecCand[];
    checked: boolean[]; // 新密钥:是否存入
    dupChoice: ("new" | "overwrite" | "ignore")[]; // 重复项:新增/覆盖备注/忽略
  } | null>(null);
  const [account, setAccount] = useState<{
    loggedIn: boolean;
    email: string | null;
    label?: string;
    providerId?: string;
    nickname?: string;
    avatar?: string;
    balance?: { total?: string; currency: string; consumed: string };
    expired?: boolean;
  }>({
    loggedIn: false,
    email: null,
  });
  const [showAcctMenu, setShowAcctMenu] = useState(false);
  const [showLoginForm, setShowLoginForm] = useState(false); // 应用内登录框
  const [loginResume, setLoginResume] = useState(false); // 登录成功后是否续发刚才拦下的消息
  const [lang, setLangState] = useState<Lang>(getLang()); // 界面语言
  const t = makeT(lang);
  function changeLang(l: Lang) {
    persistLang(l);
    setLangState(l);
  }
  const [webLoginBusy, setWebLoginBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false); // 失败处一键授权 Claude 进行中
  const [codexBusy, setCodexBusy] = useState(false); // Codex 一键授权进行中
  // 无为账号（B2：全新正交账号态，≠模型商账号，独立身份区。最终顶栏样式待小美定稿换皮）
  const [wuwei, setWuwei] = useState<{
    user: { id: string; email: string | null; name: string | null; avatar: string | null };
    coin: { balance: number };
    flags?: string[];
    providers?: { hidden?: string[] };
  } | null>(null);
  // 灰度开关（C2）：订阅版是否显示，完全由后端 flags 决定，默认隐藏。客户端只渲染不判定。
  const showSubscription = !!wuwei?.flags?.includes("subscription");
  const [wuweiBusy, setWuweiBusy] = useState(false);
  const [coinShortage, setCoinShortage] = useState<{ message: string; balance?: number } | null>(null);
  async function refreshWuweiForShortage(message: string) {
    setCoinShortage({ message });
    try {
      const me = await window.minicc.wuweiMe();
      if (me) {
        setWuwei(me);
        setCoinShortage({ message, balance: me.coin.balance });
      }
    } catch {
      /* 弹窗仍然保留充值入口 */
    }
  }
  async function doWuweiLogout() {
    await window.minicc.wuweiLogout();
    setWuwei(null);
  }
  // 应用内登录框成功回调：更新账号 + 关框 + (若从发送门槛来)续发刚才拦下的消息
  function onWuweiLoggedIn(me: WuweiMe, action?: "login" | "register" | "reset") {
    setWuwei(me);
    setShowLoginForm(false);
    const who = me.user.name || me.user.email || "用户";
    const msg =
      action === "register"
        ? `✓ 注册成功，欢迎加入无为！已登录：${who}`
        : action === "reset"
          ? `✓ 密码已重置，已自动登录：${who}`
          : `✓ 已登录：${who}`;
    push({ type: "notice", text: msg });
    if (loginResume) {
      const t = input.trim();
      if (t || pendingImages.length) {
        doSend(t, pendingImages);
        clearComposer();
      }
      setLoginResume(false);
    }
  }
  async function doCodexLogin() {
    setCodexBusy(true);
    try {
      const ok = await window.minicc.codexLogin();
      push({
        type: "notice",
        text: ok
          ? "✓ Codex 授权成功，已切到 Codex 订阅，可以直接对话了。"
          : "Codex 授权未完成（取消/超时/端口 1455 被占）。若本机在跑 codex CLI 请先关掉再试。",
      });
    } finally {
      setCodexBusy(false);
    }
  }
  const [needAuth, setNeedAuth] = useState(false); // 检测到缺授权：授权条常驻显示
  const [authDismissed, setAuthDismissed] = useState(false); // 用户手动 × 关掉了授权条
  const [oauthStep, setOauthStep] = useState<"idle" | "awaiting-code">("idle"); // 浏览器授权：等回填授权码
  const [codeInput, setCodeInput] = useState(""); // 授权码输入
  const [apiKeyStep, setApiKeyStep] = useState<"idle" | "awaiting">("idle"); // API Key 平台：等复制/粘贴 key
  const [apiKeyInput, setApiKeyInput] = useState(""); // API Key 输入
  const [apiKeyBusy, setApiKeyBusy] = useState(false); // 正在验证 key
  const lastClipRef = useRef(""); // 上次检测过的剪贴板内容(去重)
  const keyTestingRef = useRef(false); // 防并发验证
  const [conn, setConn] = useState<{ status: "green" | "yellow" | "red" | "checking"; reason: string }>({
    status: "checking",
    reason: "检测连通状态…",
  });
  const [showConn, setShowConn] = useState(false); // 状态灯说明气泡
  const thinkStartRef = useRef<number | null>(null); // 本轮开始时间（思考计时）
  const charsRef = useRef(0); // 本轮已流式字符数（估算 token）
  // 已"总是允许"的工具（记住授权，跨重启，手动模式下不再提示）
  const alwaysAllowRef = useRef<Set<string>>(
    new Set((() => {
      try {
        return JSON.parse(localStorage.getItem("minicc-allow") || "[]");
      } catch {
        return [];
      }
    })()),
  );
  const autoRef = useRef(autoMode);
  autoRef.current = autoMode;
  const streamRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // 用户是否贴着底部：滚上去看历史时暂停自动吸底，滚回底部再恢复
  const forceBottomRef = useRef(false); // 切换会话:内容异步改高，需多帧兜底吸底(否则要点两下)
  const taRef = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>([]);
  const histIdx = useRef<number>(-1);

  const push = (it: Item) => setItems((p) => [...p, it]);

  // 流式出字：把到手文本先缓冲，再按「输出方式」揭示。
  //  stream=每 30ms 把缓冲一次性吐出(唰的一下)；typewriter=每 ~16ms 匀速吐 speed 字/秒；
  //  instant=流式期间不吐，攒到段落边界(工具/结束)一次性整段出。
  //  正在流的那条渲染纯文本(不重解析 markdown)，流完再切完整 Markdown。
  const pendingDeltaRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const TW_TICK = 16;
  function scheduleFlush() {
    if (flushTimerRef.current != null) return;
    const delay = streamModeRef.current === "typewriter" ? TW_TICK : 30;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushDelta(false);
    }, delay);
  }
  // force=true：段落边界(工具开始/回合结束)整段吐出，无视模式，别把内容卡在缓冲里
  function flushDelta(force = false) {
    if (flushTimerRef.current != null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const buf = pendingDeltaRef.current;
    if (!buf) return;
    const mode = streamModeRef.current;
    let chunk: string;
    if (force || mode === "stream") {
      chunk = buf;
      pendingDeltaRef.current = "";
    } else if (mode === "instant") {
      return; // 流式期间不揭示，等边界 force 整段出
    } else {
      // typewriter：按速度取前 N 字，其余留缓冲，继续排下一次
      const n = Math.max(1, Math.round((streamSpeedRef.current * TW_TICK) / 1000));
      chunk = buf.slice(0, n);
      pendingDeltaRef.current = buf.slice(n);
    }
    setItems((p) => {
      const last = p[p.length - 1];
      if (last && last.type === "assistant") {
        const c = [...p];
        c[c.length - 1] = { ...last, text: last.text + chunk };
        return c;
      }
      return [...p, { type: "assistant", text: chunk, ts: Date.now() }];
    });
    if (pendingDeltaRef.current) scheduleFlush(); // 还有剩(typewriter)继续吐
  }

  // 每 15s 刷新一次「多久之前」相对时间(实时递增)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // 当前平台预设(用于右下角模型快切列出该平台模型)；设置面板关闭后刷新
  useEffect(() => {
    window.minicc.getSettings().then((r) => {
      setCurProviderId(r?.settings?.providerId || "");
      setStations(r?.settings?.customStations || []);
      setProviderOrder(r?.settings?.providerOrder || []);
      setHiddenProviders(r?.settings?.hiddenProviders || []);
      setGroupMode((r?.settings as any)?.groupMode || "manual");
      setStreamMode((r?.settings as any)?.streamMode || "stream");
      setStreamSpeed((r?.settings as any)?.streamSpeed || 400);
      setKeepRecent((r?.settings as any)?.keepRecent || 12);
      // 应用主题(深色已下线，默认白色；存量 dark 回退白色)
      const theme = resolveTheme((r?.settings as any)?.theme);
      document.documentElement.setAttribute("data-theme", theme);
    });
    document.documentElement.setAttribute("data-platform", window.minicc.platform);
  }, [showSettings]);
  // 内置平台 + 用户自定义中转站，按用户自定义顺序、隐藏项不进切换菜单
  const backendHidden = wuwei?.providers?.hidden ?? []; // 后台下发的隐藏供应商(全局+按用户)
  const providerList = arrangePresets(
    // 托管平台需登录可见；后台隐藏的一律不显示(供应商上下架由后台控制)
    [...PRESETS, ...stations.map(stationToPreset)].filter(
      (p) => (!p.hosted || !!wuwei) && !backendHidden.includes(p.id),
    ),
    providerOrder,
    hiddenProviders,
    false,
  );
  const curPreset = providerList.find((p) => p.id === curProviderId);
  // 动态实时模型(从平台 /models 拉)并入预设，去重；预设在前(保证旗舰置顶)，实时补充新模型
  const quickModels = [
    ...new Set([...(curPreset?.models ?? []), ...(liveModels[curProviderId] || [])]),
  ];
  // 切换模型下拉展示：常用=预设旗舰(+当前选中项)，全部=预设+实时拉取全量
  const commonModels = curPreset?.models ?? [];
  const shownModels = showAllModels
    ? quickModels
    : [...new Set([...commonModels, ...(meta.model && !commonModels.includes(meta.model) ? [meta.model] : [])])];
  const hasMoreModels = quickModels.length > commonModels.length;
  async function quickModel(m: string) {
    const r = await window.minicc.getSettings();
    const cur = r?.settings;
    if (cur) window.minicc.setSettings({ ...cur, model: m });
    setShowModelMenu(false);
  }

  // 连通状态检测：更新状态灯（红/黄/绿）
  async function runConnCheck() {
    setConn({ status: "checking", reason: "检测连通状态…" });
    try {
      const r = await window.minicc.checkConn();
      setConn(r);
    } catch {
      setConn({ status: "yellow", reason: "检测失败，请重试。" });
    }
  }

  // ——— API Key 平台：一键获取 → 复制自动检测 → 通了自动设置 ———
  // 把验证过的 key 存进当前平台槽并切换生效
  async function saveApiKeyToSettings(key: string) {
    const r = await window.minicc.getSettings();
    const s = r?.settings || {};
    const pid = s.providerId || curProviderId;
    const creds = { ...(s.creds || {}) };
    creds[pid] = { ...(creds[pid] || {}), apiKey: key };
    window.minicc.setSettings({ ...s, apiKey: key, oauthToken: undefined, creds });
  }

  // 试一个候选 key：先测连通，通了才落库+提示成功。silent=剪贴板自动检测时不打扰
  async function tryApiKey(candidate: string, silent = false): Promise<boolean> {
    const key = (candidate || "").trim();
    if (!key || keyTestingRef.current) return false;
    keyTestingRef.current = true;
    setApiKeyBusy(true);
    try {
      const res = await window.minicc.testKey(key);
      if (res.ok) {
        await saveApiKeyToSettings(key);
        push({ type: "notice", text: "✓ API Key 已验证通过并设置完成，可以直接使用了。" });
        setNeedAuth(false);
        setAuthDismissed(false);
        setApiKeyStep("idle");
        setApiKeyInput("");
        setConn({ status: "green", reason: "已连通，可随时使用。" });
        return true;
      }
      if (keyRejected(res.reason)) {
        // 真·鉴权失败：Key 无效，不保存
        if (!silent) push({ type: "notice", text: "✗ 这个 Key 无效（鉴权失败）：" + res.reason });
        return false;
      }
      // Key 有效但请求未通过(余额/额度/账单等)：照样保存，给提醒；灯转黄
      await saveApiKeyToSettings(key);
      push({
        type: "notice",
        text: "⚠ Key 已保存（本身有效），但请求未通过，多为账户余额/额度问题，非 Key 错误：" + res.reason,
      });
      setNeedAuth(false);
      setAuthDismissed(false);
      setApiKeyStep("idle");
      setApiKeyInput("");
      setConn({ status: "yellow", reason: res.reason });
      return true;
    } finally {
      keyTestingRef.current = false;
      setApiKeyBusy(false);
    }
  }

  // 点「去获取 API Key」：打开官网 + 进入等待态(启动剪贴板自动检测)
  function startApiKeyFlow() {
    if (curPreset?.keyUrl) window.minicc.openExternal(curPreset.keyUrl);
    lastClipRef.current = "";
    setApiKeyInput("");
    setApiKeyStep("awaiting");
  }

  // 把拿到的 token 存进设置并切到 Claude 订阅后端
  async function saveClaudeToken(tok: string) {
    const r = await window.minicc.getSettings();
    const s = r?.settings || {};
    const creds = { ...(s.creds || {}) };
    creds["claude-oauth"] = { ...(creds["claude-oauth"] || {}), oauthToken: tok };
    window.minicc.setSettings({
      ...s,
      kind: "anthropic-oauth",
      providerId: "claude-oauth",
      model: s.model || "claude-opus-4-8",
      oauthToken: tok,
      apiKey: undefined,
      baseUrl: undefined,
      creds,
    });
    push({ type: "notice", text: "✓ Claude 订阅已授权，请重新发送刚才的消息。" });
    setNeedAuth(false); // 授权完成，收起授权条
    setAuthDismissed(false);
    setOauthStep("idle");
  }

  // 应用内弹窗授权(自行输账号密码，自动捕获)
  async function authorizeWindow() {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      const tok = await window.minicc.claudeLogin();
      if (tok) await saveClaudeToken(tok);
      else push({ type: "notice", text: "授权未完成（已取消/超时），可重试。" });
    } finally {
      setAuthBusy(false);
    }
  }

  // 系统浏览器授权 第1步：开浏览器(复用已登录 Google)，进入「等回填授权码」态
  async function authorizeBrowser() {
    await window.minicc.claudeOauthOpen();
    setCodeInput("");
    setOauthStep("awaiting-code");
    push({
      type: "notice",
      text: "已在浏览器打开授权页：登录并点“同意”后，复制页面显示的授权码，回来点「完成授权」（会自动读剪贴板）。",
    });
  }

  // 系统浏览器授权 第2步：用授权码换 token（输入框留空则自动读剪贴板）
  async function completeBrowserAuth() {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      let code = codeInput.trim();
      if (!code) code = (await window.minicc.readClipboard()).trim();
      if (!code) {
        push({ type: "notice", text: "没读到授权码：请先在浏览器复制授权码，或粘贴进输入框再点完成。" });
        return;
      }
      const tok = await window.minicc.claudeOauthExchange(code);
      if (tok) await saveClaudeToken(tok);
      else push({ type: "notice", text: "授权码无效或已过期，请重新点「用浏览器登录」再试一次。" });
    } finally {
      setAuthBusy(false);
    }
  }

  // 快捷切换供应商：带出该平台已存的 key/baseUrl，默认用该平台第一个模型
  async function quickProvider(p: (typeof PRESETS)[number]) {
    const r = await window.minicc.getSettings();
    const cur = r?.settings || {};
    const slot = (cur.creds || {})[p.id] || {};
    window.minicc.setSettings({
      ...cur,
      kind: p.kind,
      providerId: p.id,
      apiKey: slot.apiKey,
      oauthToken: slot.oauthToken,
      baseUrl: p.fixedBaseUrl ? p.baseUrl : slot.baseUrl || p.baseUrl,
      model: p.models[0] || cur.model,
    });
    setRate(null); // 清掉上一个平台的订阅额度残留(余额类无 evt:ratelimits 不会覆盖)，新平台 emitAccount 会重推
    setCurProviderId(p.id);
    setShowProviderMenu(false);
  }

  useEffect(() => {
    const off = window.minicc.onEvent((ch, payload: any) => {
      // 结构性事件(工具/完成/切换…)前先把累积的流式文本落定，保证顺序不乱
      if (ch !== "evt:assistant-delta" && pendingDeltaRef.current) flushDelta(true); // 段落边界整段吐
      switch (ch) {
        case "evt:ready":
          setMeta(payload);
          setApiKeyStep("idle"); // 切平台/模型：重置 key 等待态，避免残留
          setOauthStep("idle");
          void runConnCheck(); // 启动 / 切平台切模型后自动检测连通状态
          break;
        case "evt:sessions":
          setSessions(payload);
          break;
        case "evt:groups":
          setGroups(Array.isArray(payload) ? payload : []);
          break;
        case "evt:account":
          setAccount(payload);
          break;
        case "evt:wuwei-me":
          setWuwei(payload); // 托管平台扣币后主进程推来的最新账号+余额
          break;
        case "evt:tasks":
          setRunningSet(new Set<string>(payload.running || []));
          break;
        case "evt:browser":
          setBrowserInfo(payload || {});
          break;
        case "evt:browser-activity":
          setShowBrowser(true); // AI 用浏览器时自动弹面板，实时可见
          break;
        case "evt:browser-detached":
          setBrowserDetached(!!payload);
          break;
        case "evt:session-loaded":
          setCurrentId(payload.id);
          atBottomRef.current = true; // 打开/切换会话：定位到最新(底部)，不用手滚
          forceBottomRef.current = true; // 切换会话：多帧兜底吸底，一次点击就到最新
          setItems(messagesToItems(payload.messages));
          break;
        case "evt:assistant-delta":
          if (payload.sid !== currentIdRef.current) break; // 只画当前可见会话
          charsRef.current += (payload.delta as string).length;
          pendingDeltaRef.current += payload.delta; // 累积，节流 flush
          scheduleFlush();
          break;
        case "evt:tool-start":
          if (payload.sid !== currentIdRef.current) break;
          push({ type: "tool", id: payload.id, name: payload.name, input: payload.input, status: "running" });
          break;
        case "evt:tool-end":
          if (payload.sid !== currentIdRef.current) break;
          setItems((p) => {
            // 优先按 id 精确匹配(并行时多个 running)；无 id 时回退到最后一个 running
            let real = payload.id
              ? p.findIndex((i) => i.type === "tool" && (i as any).id === payload.id)
              : -1;
            if (real === -1) {
              const idx = [...p].reverse().findIndex((i) => i.type === "tool" && i.status === "running");
              if (idx === -1) return p;
              real = p.length - 1 - idx;
            }
            const c = [...p];
            c[real] = { ...(c[real] as any), result: payload.result, isError: payload.isError, status: "done" };
            return c;
          });
          break;
        case "evt:permission-request":
          if (autoRef.current || alwaysAllowRef.current.has(payload.name))
            window.minicc.respondPermission(payload.id, "allow");
          else setPending(payload);
          break;
        case "evt:usage":
          if (payload.sid !== currentIdRef.current) break; // 只显示当前会话用量
          setUsage(payload.usage);
          break;
        case "evt:ratelimits":
          setRate(payload);
          break;
        case "evt:suggest":
          if (payload.sid === currentIdRef.current) setSuggestion(payload.text || "");
          break;
        case "evt:assistant-replace":
          // 清理泄漏工具调用/噪音后：把屏上那条 assistant 换成干净正文(为空则移除该气泡)
          if (payload.sid !== currentIdRef.current) break;
          flushDelta(true);
          setItems((p) => {
            const c = [...p];
            for (let k = c.length - 1; k >= 0; k--) {
              if (c[k].type === "assistant") {
                if ((payload.text || "").trim()) c[k] = { ...(c[k] as any), text: payload.text };
                else c.splice(k, 1); // 清理后无正文→去掉空气泡
                break;
              }
            }
            return c;
          });
          break;
        case "evt:compact":
          if (payload.sid !== currentIdRef.current) break;
          push({ type: "notice", text: `上下文已压缩：${payload.before} → ${payload.after} 条消息` });
          break;
        case "evt:done":
          if (payload.sid === currentIdRef.current) thinkStartRef.current = null;
          setNeedAuth(false); // 成功完成一轮=鉴权已通，收起授权条
          setConn({ status: "green", reason: "已连通，可随时使用。" }); // 成功=绿灯
          break;
        case "evt:stopped":
          if (payload.sid !== currentIdRef.current) break;
          thinkStartRef.current = null;
          push({ type: "notice", text: "已停止" });
          break;
        case "evt:error": {
          if (payload.sid && payload.sid !== currentIdRef.current) break;
          thinkStartRef.current = null;
          const rawMsg = String(payload.message ?? payload);
          const friendly = friendlyError(rawMsg);
          if (isCoinShortage(rawMsg) || isCoinShortage(friendly)) {
            setShowAcctMenu(false);
            void refreshWuweiForShortage(friendly);
          }
          // 去重：与上一条完全相同的出错提示不重复堆叠
          setItems((p) => {
            const last = p[p.length - 1];
            if (last && last.type === "notice" && last.text === friendly) return p;
            return [...p, { type: "notice", text: friendly }];
          });
          // 鉴权类错误：授权条常驻(重置手动关闭态，让它重新出现)；灯转红/黄
          if (isAuthErrorText(friendly)) {
            setNeedAuth(true);
            setAuthDismissed(false);
            setConn({ status: "red", reason: friendly });
          } else {
            setConn({ status: "yellow", reason: friendly }); // 已配置但报错
          }
          break;
        }
      }
    });
    return () => {
      off?.(); // 卸载事件监听，防 HMR/重挂载叠加导致事件被重复处理
      if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current);
    };
  }, []);

  useEffect(() => {
    // 只有用户本来就贴着底部时才自动吸底；往上滚看历史时不打扰
    if (!atBottomRef.current) return;
    const el = streamRef.current;
    if (!el) return;
    const toBottom = () => el.scrollTo({ top: el.scrollHeight });
    toBottom();
    // 二次校正：长会话/代码高亮/图片会在下一帧改变高度，再吸一次确保真到底
    requestAnimationFrame(() => {
      if (atBottomRef.current) toBottom();
    });
    // 切换会话：内容(markdown/代码高亮/图片)会在随后几帧持续改变高度，多次兜底吸底，
    // 保证一次点击就停在最新消息，而不用点两下。
    if (forceBottomRef.current) {
      forceBottomRef.current = false;
      [50, 130, 260, 450].forEach((ms) =>
        setTimeout(() => {
          if (atBottomRef.current) toBottom();
        }, ms),
      );
    }
  }, [items, busy, pending]);

  useEffect(() => {
    setSuggestion(""); // 切换会话清掉上个会话的建议
  }, [currentId]);

  // 平台切换后拉该平台实时模型列表(/models)，并入下拉；延迟一点等主进程 applySettings 落定
  useEffect(() => {
    if (!curProviderId) return;
    const t = setTimeout(() => {
      window.minicc.fetchModels().then((ids) => {
        if (ids && ids.length) setLiveModels((m) => ({ ...m, [curProviderId]: ids }));
      });
    }, 400);
    return () => clearTimeout(t);
  }, [curProviderId]);

  useEffect(() => {
    window.minicc.getAccount().then(setAccount);
    window.minicc.wuweiMe().then(setWuwei).catch(() => {});
    // 主动拉取当前后端/模型，避免 evt:ready 推送早于订阅被丢导致显示「…」
    window.minicc.getSettings().then((r: any) => {
      if (r?.backend) setMeta((m) => ({ ...m, backend: r.backend, model: r.model || m.model }));
    });
    // 主动拉取会话列表+当前会话，避免启动推送早于监听导致空白页(需发消息才加载的bug)
    window.minicc.bootstrap().then((r) => {
      if (!r) return;
      setSessions(r.sessions || []);
      setGroups(r.groups || []);
      if (r.currentId) setCurrentId(r.currentId);
      atBottomRef.current = true; // 初次打开：定位到最新(底部)
      setItems(messagesToItems(r.messages || []));
      if (r.usage) setUsage(r.usage);
      if (r.rateLimits) setRate(r.rateLimits);
    });
  }, []);

  // API Key 等待态：轮询剪贴板，检测到像 key 的新内容就自动验证+设置(零手填)
  useEffect(() => {
    if (apiKeyStep !== "awaiting") return;
    const timer = setInterval(async () => {
      if (keyTestingRef.current) return;
      const clip = (await window.minicc.readClipboard()).trim();
      if (!clip || clip === lastClipRef.current || !isLikelyKey(clip)) return;
      lastClipRef.current = clip;
      setApiKeyInput(clip);
      await tryApiKey(clip, true); // 静默：不通就继续等，通了自动完成
    }, 1200);
    return () => clearInterval(timer);
  }, [apiKeyStep]);

  // 点用量面板外部时自动关闭
  useEffect(() => {
    if (!showUsage) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".usage-panel") && !t.closest(".usage-btn")) setShowUsage(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showUsage]);

  // 拖动侧边栏右边缘调宽度
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWRef.current;
    const move = (ev: MouseEvent) => {
      const w = Math.min(420, Math.max(170, startW + ev.clientX - startX));
      setSidebarW(w);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      localStorage.setItem("minicc-sidebar-w", String(sidebarWRef.current));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function toggleCollapse(v: boolean) {
    setCollapsed(v);
    localStorage.setItem("minicc-sidebar-collapsed", v ? "1" : "0");
  }

  // 读取图片文件为 dataURL
  function addFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => setPendingImages((p) => [...p, reader.result as string]);
      reader.readAsDataURL(f);
    }
  }

  // 真正发送一条(立即入队跑)
  function doSend(text: string, imgs: string[]) {
    if (text) {
      history.current.push(text);
      histIdx.current = history.current.length;
    }
    push({ type: "user", text, images: imgs.length ? imgs : undefined, ts: Date.now() });
    setRunningSet((s) => new Set(s).add(currentId)); // 乐观置为运行中(主进程随后 evt:tasks 校准)
    thinkStartRef.current = Date.now();
    charsRef.current = 0;
    window.minicc.send(currentId, text, imgs.length ? imgs : undefined);
  }

  function clearComposer() {
    setInput("");
    setPendingImages([]);
    if (taRef.current) taRef.current.style.height = "auto";
    window.minicc.draftSet({ text: "", images: [] }); // 发送后立即清空落盘草稿
  }

  // 真正把消息投递出去(注入 or 新发)——已入库密钥由主进程兜底脱敏
  function dispatchMessage(text: string, imgs: string[], inject: boolean) {
    if (inject) {
      push({ type: "user", text, images: imgs.length ? imgs : undefined, ts: Date.now() });
      if (text) {
        history.current.push(text);
        histIdx.current = history.current.length;
      }
      window.minicc.inject(currentId, text, imgs.length ? imgs : undefined);
    } else {
      doSend(text, imgs);
    }
  }

  function submit() {
    const text = input.trim();
    if (!text && pendingImages.length === 0) return;
    if (text === "/reset") {
      window.minicc.reset();
      setInput("");
      return;
    }
    // 硬门槛：未登录无为账号不能发送 → 弹登录注册（保留输入内容，登录后自动续发）
    if (!wuwei) {
      setLoginResume(true);
      setShowLoginForm(true);
      return;
    }
    if (curPreset?.hosted && wuwei.coin.balance <= 0) {
      void refreshWuweiForShortage("无为币余额不足：请充值后再使用无为托管模型。");
      return;
    }
    setSuggestion(""); // 发送后清掉旧的下一步建议(回复完会重新生成)
    const imgs = pendingImages;
    const inject = busy; // 跑动中→注入到当前回合
    // 铁律:发送绝不能依赖密钥扫描。扫描失败/无该接口都要照常发,主进程还会兜底脱敏。
    const go = () => {
      dispatchMessage(text, imgs, inject);
      clearComposer();
    };
    const scan = text ? window.minicc.secretsScan?.(text) : undefined;
    if (!scan) {
      go();
      return;
    }
    scan
      .then((r) => {
        if (r?.candidates?.length > 0) {
          setSecretPrompt({
            text,
            redacted: r.redacted ?? text,
            imgs,
            inject,
            candidates: r.candidates,
            checked: r.candidates.map(() => true),
            dupChoice: r.candidates.map(() => "ignore" as const),
          });
        } else {
          // 用脱敏后的文本显示+发送:已入库密钥在气泡里也是占位符,不明文示人
          dispatchMessage(r?.redacted ?? text, imgs, inject);
          clearComposer();
        }
      })
      .catch(() => go()); // 扫描出错→照常发
  }

  // 密钥确认弹窗：新密钥按勾选存入;重复项按三选一(新增/覆盖备注/忽略);再发送
  async function confirmSecretPrompt(store: boolean) {
    const sp = secretPrompt;
    if (!sp) return;
    let outText = sp.redacted; // 默认:已入库的已脱敏,新密钥保持原样(用户选了不存)
    if (store) {
      for (let i = 0; i < sp.candidates.length; i++) {
        const c = sp.candidates[i];
        if (c.existing) {
          // 重复项:值已在保险箱,只处理备注/新增
          const choice = sp.dupChoice[i];
          if (choice === "new") {
            await window.minicc.secretsAdd({ name: c.suggestedName, value: c.value, note: c.note, force: true });
          } else if (choice === "overwrite") {
            await window.minicc.secretsUpdate(c.existing.id, { note: c.note });
          } // ignore: 不动
        } else {
          if (!sp.checked[i]) continue;
          await window.minicc.secretsAdd({ name: c.suggestedName, value: c.value, note: c.note });
        }
      }
      // 存好后重新扫描:刚入库的这批也会被替换成占位符
      try {
        outText = (await window.minicc.secretsScan(sp.text))?.redacted ?? sp.redacted;
      } catch {
        outText = sp.redacted;
      }
    }
    setSecretPrompt(null);
    dispatchMessage(outText, sp.imgs, sp.inject);
    clearComposer();
  }

  const stop = () => window.minicc.stop(currentId);

  // ——— 侧栏分组/排序辅助 ———
  const orderKey = (s: SessionMeta) => (s.order != null ? s.order : -s.updatedAt);
  // 相对时间(最新消息多久前)：随 now(每15s)更新
  const relTime = (ts: number): string => {
    const sec = Math.max(0, Math.floor((now - ts) / 1000));
    if (sec < 60) return sec + "秒前";
    const min = Math.floor(sec / 60);
    if (min < 60) return min + "分钟前";
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + "小时前";
    const day = Math.floor(hr / 24);
    if (day < 30) return day + "天前";
    const mo = Math.floor(day / 30);
    return mo < 12 ? mo + "个月前" : Math.floor(mo / 12) + "年前";
  };
  // 组内排序：已完成沉底 → 优先级(数字大在前) → 手动拖拽键(未拖过=按最近更新)
  const sortRows = (arr: SessionMeta[]) =>
    [...arr].sort(
      (a, b) =>
        (a.done ? 1 : 0) - (b.done ? 1 : 0) ||
        (b.priority || 0) - (a.priority || 0) ||
        orderKey(a) - orderKey(b),
    );
  // 日期分组的桶名 + 排序权重
  const dateBucket = (ts: number): string => {
    const d = new Date(ts);
    const now = new Date();
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff <= 0) return "今天";
    if (diff === 1) return "昨天";
    if (diff <= 7) return "近 7 天";
    if (diff <= 30) return "近 30 天";
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月`;
    return `${d.getFullYear()} 年`;
  };
  const dateRank = (b: string) =>
    ["今天", "昨天", "近 7 天", "近 30 天"].indexOf(b) >= 0
      ? ["今天", "昨天", "近 7 天", "近 30 天"].indexOf(b)
      : 100; // 具体月/年桶排后面，用桶内最新时间兜底排序
  // 会话所属分组(按当前模式)
  const groupOf = (s: SessionMeta): string =>
    groupMode === "date" ? dateBucket(s.updatedAt) : groupMode === "project" ? s.project || "未归类" : s.group || "";

  // 拖拽会话到某会话上→插入并写 order；手动模式下跨组=移动分组
  function dropOnSession(e: React.DragEvent, target: SessionMeta, list: SessionMeta[]) {
    e.preventDefault();
    setDragOverId(null);
    const id = dragId;
    setDragId(null);
    if (!id || id === target.id) return;
    const dragged = sessions.find((s) => s.id === id);
    if (!dragged) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const below = e.clientY > rect.top + rect.height / 2;
    const others = list.filter((r) => r.id !== id);
    const ti = others.findIndex((r) => r.id === target.id);
    const above = below ? others[ti] : others[ti - 1];
    const belowItem = below ? others[ti + 1] : others[ti];
    let newOrder: number;
    if (above && belowItem) newOrder = (orderKey(above) + orderKey(belowItem)) / 2;
    else if (above) newOrder = orderKey(above) + 1e6;
    else if (belowItem) newOrder = orderKey(belowItem) - 1e6;
    else newOrder = orderKey(target);
    if (groupMode === "manual" && (dragged.group || "") !== (target.group || ""))
      window.minicc.setSessionGroup(id, target.group || null);
    window.minicc.setSessionOrder(id, newOrder);
  }

  // 拖拽组头重排(仅手动模式)
  function dropOnGroup(e: React.DragEvent, targetGroup: string, ordered: string[]) {
    e.preventDefault();
    const g = dragGroup;
    setDragGroup(null);
    setDragOverGroup(null);
    if (!g || g === targetGroup) return;
    const without = ordered.filter((x) => x !== g);
    const ti = without.indexOf(targetGroup);
    const next = [...without.slice(0, ti), g, ...without.slice(ti)];
    const rest = groups.filter((x) => !next.includes(x)); // 无会话的组保持在后
    window.minicc.reorderGroups([...next, ...rest]);
  }

  function changeGroupMode(m: "manual" | "date" | "project") {
    setGroupMode(m);
    window.minicc.setGroupMode(m);
  }
  function changeStream(mode: "typewriter" | "stream" | "instant", speed: number) {
    setStreamMode(mode);
    setStreamSpeed(speed);
    window.minicc.setStreamOutput(mode, speed);
  }
  function changeKeepRecent(n: number) {
    setKeepRecent(n);
    window.minicc.setKeepRecent(n);
  }

  function answerPerm(decision: "allow" | "deny") {
    if (!pending) return;
    window.minicc.respondPermission(pending.id, decision);
    setPending(null);
  }

  function allowAlways() {
    if (!pending) return;
    alwaysAllowRef.current.add(pending.name);
    localStorage.setItem("minicc-allow", JSON.stringify([...alwaysAllowRef.current]));
    window.minicc.respondPermission(pending.id, "allow");
    setPending(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab" && input === "" && suggestion) {
      // 幽灵提示补全：输入框为空且有建议时，Tab 把建议填进输入框
      e.preventDefault();
      setInput(suggestion);
      setSuggestion("");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && input === "") {
      if (histIdx.current > 0) {
        histIdx.current -= 1;
        setInput(history.current[histIdx.current] ?? "");
      }
    } else if (e.key === "Escape") {
      setInput("");
    }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (pending) {
        if (e.key === "Escape" || e.key === "n" || e.key === "N") answerPerm("deny");
        if (e.key === "y" || e.key === "Y") answerPerm("allow");
        if (e.key === "a" || e.key === "A") allowAlways();
      } else if (busy && e.key === "Escape") {
        stop();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [pending, busy]);

  const ctxWin = meta.ctxWindow || CTX_MAX;
  const ctxPct = Math.min(100, Math.round((usage.lastInput / ctxWin) * 100));
  const ctxWinLabel = ctxWin >= 1_000_000 ? (ctxWin / 1_000_000).toFixed(1) + "M" : Math.round(ctxWin / 1000) + "k";

  return (
    <div className={"shell" + (showBrowser && !browserDetached && browserMode === "full" ? " browser-full" : "")}>
      {/* 侧边栏：会话历史（可拖宽/可折叠） */}
      {!collapsed && (
      <div className="sidebar" style={{ width: sidebarW }}>
        <div className="sidebar-top">
          <button className="icon-btn" title="收起侧栏" onClick={() => toggleCollapse(true)}>
            «
          </button>
        </div>
        <button className="new-session" onClick={() => window.minicc.newSession()}>
          {t("session.new")}
        </button>
        <div className="session-list">
          {sessions.length === 0 && <div className="empty">暂无历史对话</div>}
          {(() => {
            const byGroup = new Map<string, SessionMeta[]>();
            for (const s of sessions) {
              const g = groupOf(s);
              if (!byGroup.has(g)) byGroup.set(g, []);
              byGroup.get(g)!.push(s);
            }
            // 组顺序：手动=groups 顺序(新组置顶)；日期=按时间桶权重；项目=按最新会话时间
            let orderedGroups: string[];
            if (groupMode === "date") {
              orderedGroups = [...byGroup.keys()]
                .filter((g) => g !== "")
                .sort(
                  (a, b) =>
                    dateRank(a) - dateRank(b) ||
                    Math.max(...byGroup.get(b)!.map((s) => s.updatedAt)) -
                      Math.max(...byGroup.get(a)!.map((s) => s.updatedAt)),
                );
            } else if (groupMode === "project") {
              orderedGroups = [...byGroup.keys()]
                .filter((g) => g !== "")
                .sort(
                  (a, b) =>
                    Math.max(...byGroup.get(b)!.map((s) => s.updatedAt)) -
                    Math.max(...byGroup.get(a)!.map((s) => s.updatedAt)),
                );
            } else {
              orderedGroups = groups.filter((g) => byGroup.has(g));
            }
            const manual = groupMode === "manual";
            const renderRow = (s: SessionMeta, list: SessionMeta[]) => (
              <div
                key={s.id}
                className={
                  "session-item" +
                  (s.id === currentId ? " active" : "") +
                  (s.done ? " done" : "") +
                  (s.id === dragId ? " dragging" : "") +
                  (s.id === dragOverId ? " drag-over" : "")
                }
                draggable
                onDragStart={(e) => {
                  setDragId(s.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragId && dragId !== s.id) setDragOverId(s.id);
                }}
                onDragLeave={() => setDragOverId((v) => (v === s.id ? null : v))}
                onDrop={(e) => dropOnSession(e, s, list)}
                onDragEnd={() => {
                  setDragId(null);
                  setDragOverId(null);
                }}
                onClick={() => window.minicc.switchSession(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setGroupInputSid(null);
                  setCtxMenu({ sid: s.id, x: e.clientX, y: e.clientY });
                }}
              >
                {runningSet.has(s.id) && <span className="s-run" title="运行中" />}
                {s.priorityTag && (
                  <span
                    className={"s-prio p" + (s.priority || 0)}
                    title={PRIO_TITLE[s.priorityTag] || s.priorityTag}
                  >
                    {s.priorityTag}
                  </span>
                )}
                {s.done && <span className="s-done" title="已完成">✓</span>}
                <span className="s-title">{s.title}</span>
                <span className="s-time" title={new Date(s.updatedAt).toLocaleString()}>
                  {relTime(s.updatedAt)}
                </span>
                <button
                  className="s-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.minicc.deleteSession(s.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
            return (
              <>
                {orderedGroups.map((g) => {
                  const collapsed = collapsedGroups.has(g);
                  const rows = sortRows(byGroup.get(g)!);
                  return (
                    <div key={"g:" + g} className="session-group">
                      <div
                        className={
                          "group-head" +
                          (g === dragOverGroup ? " g-drag-over" : "") +
                          (g === dragGroup ? " g-dragging" : "")
                        }
                        draggable={manual}
                        onDragStart={
                          manual
                            ? (e) => {
                                setDragGroup(g);
                                e.stopPropagation();
                                e.dataTransfer.effectAllowed = "move";
                              }
                            : undefined
                        }
                        onDragOver={
                          manual
                            ? (e) => {
                                if (dragGroup && dragGroup !== g) {
                                  e.preventDefault();
                                  setDragOverGroup(g);
                                }
                              }
                            : undefined
                        }
                        onDragLeave={
                          manual ? () => setDragOverGroup((v) => (v === g ? null : v)) : undefined
                        }
                        onDrop={manual ? (e) => dropOnGroup(e, g, orderedGroups) : undefined}
                        onDragEnd={
                          manual
                            ? () => {
                                setDragGroup(null);
                                setDragOverGroup(null);
                              }
                            : undefined
                        }
                        onClick={() =>
                          setCollapsedGroups((prev) => {
                            const n = new Set(prev);
                            if (n.has(g)) n.delete(g);
                            else n.add(g);
                            return n;
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setGroupCtx({ name: g, x: e.clientX, y: e.clientY });
                        }}
                      >
                        <span className="group-caret">{collapsed ? "▸" : "▾"}</span>
                        <span className="group-name" title={g}>
                          {g}
                        </span>
                        <span className="group-count">{rows.length}</span>
                      </div>
                      {!collapsed && rows.map((s) => renderRow(s, rows))}
                    </div>
                  );
                })}
                {(() => {
                  const un = sortRows(byGroup.get("") || []);
                  return un.map((s) => renderRow(s, un));
                })()}
              </>
            );
          })()}
        </div>
        {ctxMenu &&
          (() => {
            const s = sessions.find((x) => x.id === ctxMenu.sid);
            if (!s) return null;
            const close = () => {
              setCtxMenu(null);
              setGroupInputSid(null);
              setNewGroupName("");
            };
            const move = (g: string | null) => {
              window.minicc.setSessionGroup(ctxMenu.sid, g);
              close();
            };
            return (
              <>
                <div
                  className="ctx-overlay"
                  onClick={close}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    close();
                  }}
                />
                <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
                  <button
                    className="ctx-item ctx-done"
                    onClick={() => {
                      window.minicc.setSessionDone(ctxMenu.sid, !s.done);
                      close();
                    }}
                  >
                    {s.done ? "↩ 取消完成" : "✓ 标记完成"}
                  </button>
                  <div className="ctx-sep" />
                  <div className="ctx-head">移动到分组</div>
                  {groups
                    .filter((g) => g !== s.group)
                    .map((g) => (
                      <button key={g} className="ctx-item" onClick={() => move(g)}>
                        {g}
                      </button>
                    ))}
                  {s.group && (
                    <button className="ctx-item" onClick={() => move(null)}>
                      移出「{s.group}」
                    </button>
                  )}
                  {groupInputSid === ctxMenu.sid ? (
                    <input
                      className="ctx-input"
                      autoFocus
                      placeholder="新组名，回车创建"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newGroupName.trim()) move(newGroupName.trim());
                        if (e.key === "Escape") {
                          setGroupInputSid(null);
                          setNewGroupName("");
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="ctx-item ctx-new"
                      onClick={() => {
                        setGroupInputSid(ctxMenu.sid);
                        setNewGroupName("");
                      }}
                    >
                      ＋ 新建分组…
                    </button>
                  )}
                  <div className="ctx-sep" />
                  <div className="ctx-head">优先级</div>
                  <div className="ctx-prio">
                    <button
                      className={"ctx-prio-b" + (!s.priorityTag ? " on" : "")}
                      onClick={() => {
                        window.minicc.setSessionPriority(ctxMenu.sid, 0, "");
                        close();
                      }}
                    >
                      无
                    </button>
                    {PRIO_HL.map((p) => (
                      <button
                        key={p.tag}
                        className={"ctx-prio-b" + (s.priorityTag === p.tag ? " on" : "")}
                        onClick={() => {
                          window.minicc.setSessionPriority(ctxMenu.sid, p.weight, p.tag);
                          close();
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="ctx-head">四象限（重要/紧急）</div>
                  <div className="ctx-quad">
                    {PRIO_QUAD.map((p) => (
                      <button
                        key={p.tag}
                        className={"ctx-quad-b p" + p.weight + (s.priorityTag === p.tag ? " on" : "")}
                        onClick={() => {
                          window.minicc.setSessionPriority(ctxMenu.sid, p.weight, p.tag);
                          close();
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            );
          })()}
        {groupCtx &&
          (() => {
            const close = () => setGroupCtx(null);
            return (
              <>
                <div
                  className="ctx-overlay"
                  onClick={close}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    close();
                  }}
                />
                <div className="ctx-menu" style={{ left: groupCtx.x, top: groupCtx.y }}>
                  <div className="ctx-head">分组「{groupCtx.name}」</div>
                  <button
                    className="ctx-item ctx-new"
                    onClick={() => {
                      const ids = sessions.filter((s) => groupOf(s) === groupCtx.name).map((s) => s.id);
                      window.minicc.generateReport(groupCtx.name, ids);
                      close();
                    }}
                  >
                    📋 一键生成日报
                  </button>
                </div>
              </>
            );
          })()}
        {(() => {
          const name =
            account.nickname || account.email || account.label || (account.loggedIn ? "已登录" : "未登录");
          return (
            <div className="sidebar-foot">
              {/* 订阅版入口（C2 占位）：默认隐藏，仅当后端 flags 含 "subscription" 才出现。
                  后台可按用户名/机器指纹对指定客户端单独放开——判定全在后端，客户端只渲染。 */}
              {showSubscription && (
                <button
                  onClick={() => push({ type: "notice", text: "订阅版入口（灰度已放开）。具体订阅页/权益后续接入。" })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    padding: "6px 8px",
                    marginBottom: 6,
                    borderRadius: 8,
                    background: "none",
                    border: "1px solid #C05F3C",
                    color: "#F4F6F8",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: "#C05F3C" }}>✨</span> 订阅版
                </button>
              )}
              <button className="acct-btn" onClick={() => setShowAcctMenu((v) => !v)}>
                <div className={"acct-av" + (wuwei ? "" : " off")}>
                  {wuwei?.user.avatar ? (
                    <img src={wuwei.user.avatar} alt="" />
                  ) : (
                    (wuwei?.user.name || wuwei?.user.email || "游").slice(0, 1).toUpperCase()
                  )}
                </div>
                <div
                  className="acct-name"
                  title={wuwei ? wuwei.user.name || wuwei.user.email || "无为用户" : t("acct.notLoggedIn")}
                >
                  {wuweiBusy ? "登录中…" : wuwei ? wuwei.user.name || wuwei.user.email || "无为用户" : t("acct.guest")}
                </div>
                <span className="acct-caret">⋯</span>
              </button>
              {showAcctMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowAcctMenu(false)} />
                  <div className="acct-menu">
                    {/* 无为账号（与模型商账号合并进同一入口）。未登录只给登录入口，设置等登录后才显示 */}
                    {wuwei ? (
                      <>
                        {/* premium 账号头部：头像 + 昵称 + 无为币（主题中性配色） */}
                        <div style={{ padding: "11px 13px 10px", display: "flex", alignItems: "center", gap: 10 }}>
                          <div
                            style={{
                              width: 34,
                              height: 34,
                              borderRadius: "50%",
                              overflow: "hidden",
                              flex: "0 0 auto",
                              background: "#274A63",
                              color: "#F4F6F8",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 14,
                            }}
                          >
                            {wuwei.user.avatar ? (
                              <img src={wuwei.user.avatar} alt="" style={{ width: "100%", height: "100%" }} />
                            ) : (
                              (wuwei.user.name || wuwei.user.email || "无").slice(0, 1).toUpperCase()
                            )}
                          </div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {wuwei.user.name || wuwei.user.email || "无为用户"}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                              <div
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 5,
                                  padding: "1px 9px 1px 6px",
                                  borderRadius: 999,
                                  background: "var(--bg-soft)",
                                  border: "1px solid var(--border)",
                                  color: "var(--spark)",
                                  fontSize: 12,
                                  width: "fit-content",
                                }}
                              >
                                <CoinIcon size={13} />
                                <span style={{ fontWeight: 700 }}>{wuwei.coin.balance}</span>
                                <span style={{ fontWeight: 500, opacity: 0.7 }}>{t("acct.guestIncentive")}</span>
                              </div>
                              <span
                                title="前往官网充值无为币"
                                onClick={() => window.minicc.openExternal("https://wuweiai.io/pricing")}
                                style={{ fontSize: 11.5, color: "var(--spark)", cursor: "pointer", fontWeight: 500 }}
                              >
                                充值
                              </span>
                            </div>
                          </div>
                        </div>
                        <div style={{ height: 1, background: "rgba(128,128,128,.18)", margin: "2px 0" }} />
                        <button
                          className="acct-menu-item"
                          style={{ display: "flex", alignItems: "center", gap: 8 }}
                          onClick={() => {
                            setShowAcctMenu(false);
                            setSettingsTab("general");
                            setShowSettings(true);
                          }}
                        >
                          <GearIcon size={15} />
                          {t("acct.settings")}
                        </button>
                        {/* 退出放最后一项 */}
                        <button
                          className="acct-menu-item"
                          style={{ display: "flex", alignItems: "center", gap: 8 }}
                          onClick={() => {
                            setShowAcctMenu(false);
                            void doWuweiLogout();
                          }}
                        >
                          <LogoutIcon size={15} />
                          {t("acct.logout")}
                        </button>
                      </>
                    ) : (
                      <div style={{ padding: "20px 18px 12px", textAlign: "center" }}>
                        <div
                          style={{
                            width: 46,
                            height: 46,
                            borderRadius: "50%",
                            margin: "0 auto 12px",
                            background: "linear-gradient(135deg,#C87551,#A34E30)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            boxShadow: "0 5px 16px rgba(192,95,60,.35)",
                          }}
                        >
                          <GiftIcon size={22} color="#F4F6F8" />
                        </div>
                        {/* 重点：免费顶级模型（核心卖点「免费」用朱赭点出，做出层次） */}
                        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 7, lineHeight: 1.3, letterSpacing: 0.2, color: "var(--text)" }}>
                          {lang === "zh" ? (
                            <>
                              <span style={{ color: "#C05F3C" }}>免费</span>使用最新顶级模型
                            </>
                          ) : (
                            <>
                              Top-tier models, <span style={{ color: "#C05F3C" }}>free</span>
                            </>
                          )}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.4 }}>
                          {lang === "zh" ? "无需自备 API Key，登录即用" : "No API key needed — just sign in"}
                        </div>
                        {/* 具体模型名，让「顶级」落地 */}
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(2, auto)",
                            justifyContent: "center",
                            columnGap: 16,
                            rowGap: 7,
                            marginBottom: 13,
                            fontSize: 12,
                            fontWeight: 500,
                            color: "var(--text-dim)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {[
                            { k: "kimi", n: "Kimi" },
                            { k: "claude", n: "Claude" },
                            { k: "gpt", n: "GPT" },
                            { k: "deepseek", n: "DeepSeek" },
                          ].map((m) => (
                            <span key={m.k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                              <span
                                style={{
                                  width: 18,
                                  height: 18,
                                  borderRadius: 5,
                                  background: "#fff",
                                  boxShadow: "0 0 0 1px rgba(0,0,0,.06)",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  flex: "0 0 auto",
                                }}
                              >
                                <img
                                  src={BRAND_LOGOS[m.k]}
                                  alt=""
                                  width={13}
                                  height={13}
                                  style={{ display: "block", objectFit: "contain" }}
                                />
                              </span>
                              {m.n}
                            </span>
                          ))}
                        </div>
                        {/* 次要：无为币激励，小徽章 */}
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: 11.5,
                            fontWeight: 500,
                            color: "#C05F3C",
                            background: "rgba(192,95,60,.09)",
                            padding: "3px 11px",
                            borderRadius: 20,
                            marginBottom: 16,
                          }}
                        >
                          <CoinIcon size={12} />
                          {lang === "zh" ? "注册即得 100 无为币" : "Get 100 credits"}
                        </div>
                        <button
                          onClick={() => {
                            setShowAcctMenu(false);
                            setLoginResume(false);
                            setShowLoginForm(true);
                          }}
                          style={{
                            width: "100%",
                            padding: "10px",
                            borderRadius: 10,
                            border: "none",
                            background: "#C05F3C",
                            color: "#F4F6F8",
                            fontSize: 14,
                            fontWeight: 600,
                            letterSpacing: 2,
                            cursor: "pointer",
                            boxShadow: "0 3px 12px rgba(192,95,60,.3)",
                          }}
                        >
                          {t("login.signin")}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })()}
        <div className="resizer" onMouseDown={startResize} />
      </div>
      )}

      {/* 主区 */}
      <div className="main">
        <div
          className={
            "titlebar" +
            (collapsed && window.minicc.platform === "darwin" ? " tb-collapsed" : "")
          }
        >
          <span className="tb-title">
            <WuweiMark />
            {(() => {
              const t = sessions.find((s) => s.id === currentId)?.title;
              return t && t !== "新对话" ? t : "无为";
            })()}
          </span>
          <span className="tb-spacer" />
          {showBrowser && browserDetached && (
            <span className="tb-browser-wrap">
              <button
                className="tb-browser"
                title="浏览器（独立窗口）"
                onClick={() => setShowBrowserMenu((v) => !v)}
              >
                <GlobeIcon size={15} />
                <span className="tb-caret">▾</span>
              </button>
              {showBrowserMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowBrowserMenu(false)} />
                  <div className="tb-browser-menu">
                    <button
                      onClick={() => {
                        setBrowserMode("split");
                        window.minicc.browserReattach();
                        setShowBrowserMenu(false);
                      }}
                    >
                      收回为半屏
                    </button>
                    <button
                      onClick={() => {
                        setBrowserMode("full");
                        window.minicc.browserReattach();
                        setShowBrowserMenu(false);
                      }}
                    >
                      收回为全屏
                    </button>
                    <button
                      className="tb-bm-close"
                      onClick={() => {
                        window.minicc.browserReattach();
                        setShowBrowser(false);
                        setShowBrowserMenu(false);
                      }}
                    >
                      关闭浏览器
                    </button>
                  </div>
                </>
              )}
            </span>
          )}
          {window.minicc.platform !== "darwin" && (
            <span className="win-ctrl">
              <button className="wc-btn" title="最小化" onClick={() => window.minicc.winMinimize()}>
                ─
              </button>
              <button className="wc-btn" title="最大化" onClick={() => window.minicc.winMaximize()}>
                ☐
              </button>
              <button
                className="wc-btn wc-close"
                title="关闭"
                onClick={() => window.minicc.winClose()}
              >
                ✕
              </button>
            </span>
          )}
        </div>

        {collapsed && (
          <div className="toolbar-min">
            <button className="icon-btn" title="展开侧栏" onClick={() => toggleCollapse(false)}>
              »
            </button>
          </div>
        )}

        <div
          className="stream"
          ref={streamRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 距底 ≤40px 视为"贴底"→继续自动吸底；否则用户在往上看→暂停
            atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
          }}
        >
          {items.length === 0 && (
            <div className="welcome">
              <h1>
                minicc <span className="dot">●</span>
              </h1>
              <p>自研 Claude Code · 桌面版。直接描述你的编码需求，它会读写文件、执行命令帮你完成。</p>
              <p>Enter 发送，Shift+Enter 换行，↑ 翻历史，忙碌时 Esc 停止。</p>
              <p>左侧可新建/切换历史对话；「自动」模式工具直接放行。</p>
              <div className="meta">
                后端 {meta.backend} · 模型 {meta.model}
              </div>
            </div>
          )}
          {(() => {
            const turns = groupTurns(items);
            let userOrd = -1; // 已见的用户输入序号(与主进程 messages 里的用户输入一一对应)
            const canDel = !busy; // 运行中不允许删(历史正在变)
            const delExchange = (ord: number) => {
              if (ord < 0) return;
              window.minicc.deleteExchange(currentId, ord);
            };
            // 撤回一条用户消息(像微信撤回)：收回 + 文字放回输入框可改可重发
            const recallUser = async (it: Extract<Item, { type: "user" }>, ord: number) => {
              if (busy) {
                // 运行中：只有还没被 AI 处理(仍在注入缓冲)的才能干净撤回
                const ok = await window.minicc.recallInject(currentId, it.text);
                if (ok) {
                  setItems((p) => p.filter((x) => x !== it));
                  setInput((cur) => cur || it.text);
                } else {
                  push({
                    type: "notice",
                    text: "这条已开始处理，无法撤回；可按 Esc 停止后再撤回编辑。",
                  });
                }
              } else {
                setInput((cur) => cur || it.text);
                delExchange(ord); // 闲时：删掉这轮(含回复)，文字回到输入框
              }
            };
            return turns.map((t, i) => {
              if (t.kind === "solo") {
                if (t.item.type === "user") {
                  userOrd++;
                  const ord = userOrd;
                  const uItem = t.item;
                  return (
                    <ItemView
                      key={i}
                      item={uItem}
                      now={now}
                      onDelete={canDel ? () => delExchange(ord) : undefined}
                      onEdit={() => recallUser(uItem, ord)}
                    />
                  );
                }
                return <ItemView key={i} item={t.item} now={now} />;
              }
              const ord = userOrd; // AI 回合归属最近一条用户输入这一轮
              const aiTs = aiTurnTs(t.blocks);
              const lastTurn = i === turns.length - 1; // 只有最后一个回合可能正在流
              return (
                <div className="aiturn" key={i}>
                  <div className="aiturn-body">
                    {t.blocks.map((b, j) =>
                      b.kind === "item" ? (
                        <AssistantMsg
                          key={j}
                          text={(b.item as Extract<Item, { type: "assistant" }>).text}
                          streaming={busy && lastTurn && j === t.blocks.length - 1}
                        />
                      ) : (
                        <ToolGroup key={j} tools={b.tools} />
                      ),
                    )}
                  </div>
                  <div className="turn-foot ai">
                    <div className="tf-actions">
                      <CopyBtn
                        text={t.blocks
                          .filter((b) => b.kind === "item")
                          .map((b) => (b as { kind: "item"; item: Item }).item)
                          .filter((it): it is Extract<Item, { type: "assistant" }> => it.type === "assistant")
                          .map((it) => it.text)
                          .join("\n\n")}
                      />
                      {canDel && ord >= 0 && (
                        <button className="tf-icon del" title="删除这轮问答(含提问与回复)" onClick={() => delExchange(ord)}>
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                    {aiTs && (
                      <span className="tf-time" title={new Date(aiTs).toLocaleString()}>
                        {relTime(aiTs, now)}
                      </span>
                    )}
                  </div>
                </div>
              );
            });
          })()}
          {busy && !pending && (
            <ThinkingBar startRef={thinkStartRef} charsRef={charsRef} items={items} />
          )}
        </div>

        <div className="composer" ref={composerRef}>
          {/* 鉴权提示条：检测到缺授权后常驻，直到授权成功或用户手动 × 关闭 */}
          {needAuth && !authDismissed && (
            <div className="err-fix err-auth">
              <button className="err-close" title="关闭" onClick={() => setAuthDismissed(true)}>
                ×
              </button>
              {curPreset?.kind === "anthropic-oauth" ? (
                // Claude 订阅：一键 OAuth
                oauthStep === "awaiting-code" ? (
                  <>
                    <span>🔑 浏览器同意后，复制页面上的授权码 →（留空则自动读剪贴板）：</span>
                    <div className="err-auth-actions">
                      <input
                        className="code-input"
                        value={codeInput}
                        onChange={(e) => setCodeInput(e.target.value)}
                        placeholder="粘贴授权码（可留空自动读剪贴板）"
                      />
                      <button className="allow" onClick={completeBrowserAuth} disabled={authBusy}>
                        {authBusy ? "校验中…" : "完成授权"}
                      </button>
                      <button onClick={() => setOauthStep("idle")} disabled={authBusy}>
                        返回
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span>🔑 Claude 订阅需要授权才能使用，可一键登录授权：</span>
                    <div className="err-auth-actions">
                      <button className="allow" onClick={authorizeBrowser} disabled={authBusy}>
                        用浏览器登录（推荐·复用已登录账号）
                      </button>
                      <button onClick={authorizeWindow} disabled={authBusy}>
                        {authBusy ? "授权中…" : "应用内登录"}
                      </button>
                      <button onClick={() => setShowSettings(true)}>去设置填 Key</button>
                    </div>
                  </>
                )
              ) : curPreset?.kind === "codex" ? (
                // Codex 订阅：应用内一键 ChatGPT 授权(无需本机 codex CLI)
                <>
                  <span>
                    🔑 Codex 订阅需要 ChatGPT 登录。点下方<b>一键授权</b>，会开系统浏览器登录 ChatGPT（本机无需装 codex）。
                  </span>
                  <div className="err-auth-actions">
                    <button className="allow" onClick={doCodexLogin} disabled={codexBusy}>
                      {codexBusy ? "授权中…（浏览器完成登录）" : "一键授权（ChatGPT 登录）"}
                    </button>
                  </div>
                </>
              ) : apiKeyStep === "awaiting" ? (
                // 已打开官网，等复制 key：自动检测剪贴板 + 可手动粘贴
                <>
                  <span>
                    🔑 已打开获取页面。<b>复制 API Key 后会自动检测并设置</b>
                    ，也可粘贴到下方点完成：
                  </span>
                  <div className="err-auth-actions">
                    <input
                      className="code-input"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="复制 Key 后自动检测；或粘贴到此"
                      disabled={apiKeyBusy}
                    />
                    <button className="allow" onClick={() => tryApiKey(apiKeyInput)} disabled={apiKeyBusy}>
                      {apiKeyBusy ? "检测中…" : "完成设置"}
                    </button>
                    <button onClick={() => setApiKeyStep("idle")} disabled={apiKeyBusy}>
                      返回
                    </button>
                  </div>
                </>
              ) : (
                // API Key 平台（通义千问 / DeepSeek / OpenAI / 智谱 …）：引导去各自官网拿 key
                <>
                  <span>
                    🔑 当前平台「{curPreset?.label ?? meta.backend}」需要配置 API Key 才能使用。
                  </span>
                  <div className="err-auth-actions">
                    {curPreset?.keyUrl ? (
                      <button className="allow" onClick={startApiKeyFlow}>
                        去获取 {curPreset.label} 的 API Key ↗
                      </button>
                    ) : (
                      <button className="allow" onClick={() => setApiKeyStep("awaiting")}>
                        粘贴 API Key
                      </button>
                    )}
                    <button onClick={() => setShowSettings(true)}>去设置填 Key</button>
                  </div>
                </>
              )}
            </div>
          )}
          {/* 非鉴权类错误：提示删除上一条 */}
          {!busy &&
            !needAuth &&
            items.length > 0 &&
            items[items.length - 1].type === "notice" &&
            (items[items.length - 1] as { type: "notice"; text: string }).text.startsWith("出错") && (
              <div className="err-fix">
                <span>上一条消息出错了（可能卡住后续发送）</span>
                <button onClick={() => window.minicc.undoLast()}>删除这条并继续</button>
              </div>
            )}
          {pendingImages.length > 0 && (
            <div className="img-strip">
              {pendingImages.map((src, i) => (
                <div className="thumb" key={i}>
                  <img
                    src={src}
                    alt=""
                    style={{ cursor: "zoom-in" }}
                    onClick={() => setLightbox(src)}
                  />
                  <button onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {suggestion && input === "" && (
            <div
              className="suggest-bar"
              title="点击或按 Tab 采纳"
              onClick={() => {
                setInput(suggestion);
                setSuggestion("");
                taRef.current?.focus();
              }}
            >
              <span className="suggest-ico">💡</span>
              <span className="suggest-text">{suggestion}</span>
              <span className="suggest-key">Tab 采纳</span>
            </div>
          )}
          <div className="input-wrap">
            <textarea
              ref={taRef}
              rows={1}
              placeholder={t("composer.placeholder")}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const its = e.clipboardData?.items;
                if (!its) return;
                const files: File[] = [];
                for (const it of its)
                  if (it.type.startsWith("image/")) {
                    const f = it.getAsFile();
                    if (f) files.push(f);
                  }
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
            />
            {busy ? (
              <button className="send-btn stop" onClick={stop} title="停止">
                <span className="stop-sq" />
              </button>
            ) : (
              <button
                className={"send-btn" + (input.trim() || pendingImages.length ? " active" : "")}
                onClick={submit}
                title="发送 (Enter)"
                disabled={!input.trim() && pendingImages.length === 0}
              >
                ↵
              </button>
            )}
          </div>

          <div className={"composer-foot" + (footCompact ? " compact" : "")}>
            <div className="conn-light-wrap">
              <button
                className={`conn-light conn-${conn.status}`}
                title="连通状态（点击查看）"
                onClick={() => setShowConn((v) => !v)}
              />
              {showConn && (
                <>
                  <div className="mq-overlay" onClick={() => setShowConn(false)} />
                  <div className="conn-pop">
                    <div className="conn-pop-title">
                      <span className={`conn-dot conn-${conn.status}`} />
                      {conn.status === "green"
                        ? "已连通"
                        : conn.status === "yellow"
                          ? "有报错，未完全连通"
                          : conn.status === "red"
                            ? "未连通 / 未配置"
                            : "检测中…"}
                    </div>
                    <p className="conn-pop-reason">{conn.reason}</p>
                    <div className="conn-pop-actions">
                      <button
                        onClick={() => {
                          setShowConn(false);
                          void runConnCheck();
                        }}
                      >
                        重新检测
                      </button>
                      {(conn.status === "red" || conn.status === "yellow") && (
                        <button
                          className="allow"
                          onClick={() => {
                            setShowConn(false);
                            setSettingsTab("model");
                            setShowSettings(true);
                          }}
                        >
                          {conn.status === "red" ? "去配置 / 授权" : "去解决"}
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="mode-mini" title={autoMode ? t("mode.autoTip") : t("mode.manualTip")}>
              <button className={autoMode ? "on" : ""} onClick={() => setAutoMode(true)}>
                {t("mode.auto")}
              </button>
              <button className={!autoMode ? "on" : ""} onClick={() => setAutoMode(false)}>
                {t("mode.manual")}
              </button>
            </div>

            {/* 知识网络后台进度：索引构建 / 概念抽取，实时可见，点击进设置查看 */}
            {(idxProg?.building || conProg?.running) && (
              <button
                className="brain-prog"
                title="点击打开知识网络"
                onClick={() => {
                  setSettingsTab("brain");
                  setShowSettings(true);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "2px 8px",
                  border: "1px solid var(--border, #e2e2e2)",
                  borderRadius: 999,
                  background: "var(--chip-bg, #f4f4f5)",
                  fontSize: 11,
                  color: "var(--text-2, #666)",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "#3b82f6",
                    animation: "pulse 1.2s ease-in-out infinite",
                  }}
                />
                {idxProg?.building
                  ? idxProg.phase === "scan"
                    ? `索引·扫描 ${idxProg.files} 文档`
                    : `索引 ${idxProg.done}/${idxProg.total || "…"} 块`
                  : `抽概念 ${conProg?.done}/${conProg?.total}`}
              </button>
            )}

            <div className="model-quick">
              <button
                className="mq-btn mq-prov"
                title={curPreset?.label ?? meta.backend}
                onClick={() => setShowProviderMenu((v) => !v)}
              >
                <span className="mq-txt">{(curPreset?.label ?? meta.backend).replace(/（.*$/, "")}</span>
                <span className="mq-caret">▾</span>
              </button>
              <span className="mq-mid">·</span>
              <button
                className="mq-btn mq-mod"
                title={meta.model}
                onClick={() => setShowModelMenu((v) => !v)}
              >
                <span className="mq-txt">{meta.model}</span>
                <span className="mq-caret">▾</span>
              </button>
              {showProviderMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowProviderMenu(false)} />
                  <div className="mq-menu mq-menu-prov">
                    <div className="mq-head">切换平台</div>
                    {providerList.map((p) => (
                      <button
                        key={p.id}
                        className={"mq-item" + (p.id === curProviderId ? " on" : "")}
                        onClick={() => quickProvider(p)}
                      >
                        <span>{p.label}</span>
                        {p.id === curProviderId && <span className="mq-check">✓</span>}
                      </button>
                    ))}
                    <div className="mq-sep" />
                    <button
                      className="mq-item mq-more"
                      onClick={() => {
                        setShowProviderMenu(false);
                        setSettingsTab("platforms");
                        setShowSettings(true);
                      }}
                    >
                      全部供应商设置…
                    </button>
                  </div>
                </>
              )}
              {showModelMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowModelMenu(false)} />
                  <div className="mq-menu">
                    <div
                      className="mq-head"
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        切换模型 · {curPreset?.label ?? meta.backend}
                      </span>
                      {hasMoreModels && (
                        <span style={{ display: "inline-flex", gap: 2, flex: "0 0 auto" }}>
                          {[
                            { k: false, t: "常用" },
                            { k: true, t: "全部" },
                          ].map((o) => (
                            <button
                              key={o.t}
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowAllModels(o.k);
                              }}
                              style={{
                                padding: "1px 8px",
                                borderRadius: 5,
                                border: "none",
                                cursor: "pointer",
                                fontSize: 11,
                                background: showAllModels === o.k ? "#274A63" : "transparent",
                                color: showAllModels === o.k ? "#F4F6F8" : "inherit",
                                opacity: showAllModels === o.k ? 1 : 0.55,
                              }}
                            >
                              {o.t}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                    {shownModels.length === 0 && <div className="mq-empty">无预设模型，去设置里填</div>}
                    {shownModels.map((m) => (
                      <button
                        key={m}
                        className={"mq-item" + (m === meta.model ? " on" : "")}
                        onClick={() => quickModel(m)}
                      >
                        <span>{m}</span>
                        {m === meta.model && <span className="mq-check">✓</span>}
                      </button>
                    ))}
                    <div className="mq-sep" />
                    <button
                      className="mq-item mq-more"
                      onClick={() => {
                        setShowModelMenu(false);
                        setSettingsTab("model");
                        setShowSettings(true);
                      }}
                    >
                      全部设置 / 换平台…
                    </button>
                  </div>
                </>
              )}
            </div>

            <button
              className={"foot-browser" + (showBrowser ? " on" : "")}
              title="内置浏览器（看/控 AI 打开的网页）"
              onClick={() => setShowBrowser((v) => !v)}
              style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <GlobeIcon size={14} />
              <span className="fb-txt">{t("foot.browser")}</span>
            </button>

            <span className="foot-spacer" />

            <span
              className="foot-status"
              title="运行状态 · 本轮上下文 token · 订阅额度(5小时/周)或余额。点击看详情"
              onClick={() => setShowUsage((v) => !v)}
            >
              <span
                className={(busy || runningSet.size > 0 ? "fs-busy" : "") + (runningSet.size > 0 ? " fs-clickable" : "")}
                title={runningSet.size > 0 ? "点击查看/停止运行中的任务" : undefined}
                onClick={(e) => {
                  if (runningSet.size === 0) return;
                  e.stopPropagation(); // 别触发用量面板
                  setShowTasks((v) => !v);
                  setShowUsage(false);
                }}
              >
                {runningSet.size > 1
                  ? `● ${runningSet.size} ${t("foot.tasksSuffix")}`
                  : busy
                    ? `● ${t("foot.running")}`
                    : runningSet.size === 1
                      ? `● ${t("foot.bgRunning")}`
                      : `○ ${t("foot.ready")}`}
              </span>
              <span className="fs-extra">
                <span>
                  {t("foot.context")} {(usage.lastInput / 1000).toFixed(1)}k
                </span>
                {meta.sub && rate && typeof rate.primaryUsedPercent === "number" && (
                  <>
                    <span className="fs-dot">·</span>
                    <span>5小时 {rate.primaryUsedPercent}%</span>
                    <span className="fs-dot">·</span>
                    <span>周 {rate.secondaryUsedPercent ?? 0}%</span>
                  </>
                )}
                {!meta.sub && account.balance && (
                  <>
                    <span className="fs-dot">·</span>
                    <span>
                      {account.balance.total
                        ? `余额 ${account.balance.total} 元`
                        : `已消耗 ${account.balance.consumed} 元`}
                    </span>
                  </>
                )}
              </span>
              <span className="fs-caret">▾</span>
            </span>
          </div>
        </div>

        {showTasks && runningSet.size > 0 && (
          <>
            <div className="mq-overlay" onClick={() => setShowTasks(false)} />
            <div className="tasks-panel">
              <div className="tp-head">运行中的任务（{runningSet.size}）</div>
              {[...runningSet].map((sid) => {
                const meta = sessions.find((s) => s.id === sid);
                const title = meta?.title || (sid === currentId ? "当前会话" : "未命名会话");
                return (
                  <div key={sid} className={"tp-item" + (sid === currentId ? " cur" : "")}>
                    <span className="tp-dot" />
                    <span
                      className="tp-title"
                      title="切换到该会话"
                      onClick={() => {
                        if (sid !== currentId) window.minicc.switchSession(sid);
                        setShowTasks(false);
                      }}
                    >
                      {title}
                    </span>
                    <button
                      className="tp-stop"
                      title="停止该任务"
                      onClick={() => window.minicc.stop(sid)}
                    >
                      停止
                    </button>
                  </div>
                );
              })}
              <div className="tp-foot">
                <button className="tp-stopall" onClick={() => [...runningSet].forEach((s) => window.minicc.stop(s))}>
                  全部停止
                </button>
              </div>
            </div>
          </>
        )}

        {showUsage && (
          <div className="usage-panel">
            <div className="u-row">
              <span>上下文窗口</span>
              <span>
                {(usage.lastInput / 1000).toFixed(1)}k / {ctxWinLabel} ({ctxPct}%)
              </span>
            </div>
            <div className="u-bar">
              <div className="u-fill" style={{ width: ctxPct + "%" }} />
            </div>

            {/* 余额/额度未登录或过期：给个可点登录入口（kimi看额度rate，deepseek/zhipu看余额；有数据就不显示） */}
            {((account.providerId === "kimi-sub" && (account.expired || !rate)) ||
              ((account.providerId === "deepseek" || account.providerId === "zhipu") &&
                (account.expired || !account.balance?.total))) && (
                <div
                  className="u-row"
                  style={{ color: "#C05F3C", cursor: webLoginBusy ? "default" : "pointer", alignItems: "center" }}
                  title="登录对应网站授权后自动刷新余额/额度"
                  onClick={async () => {
                    if (webLoginBusy) return;
                    setWebLoginBusy(true);
                    await window.minicc.webLogin(account.providerId!);
                    setWebLoginBusy(false);
                  }}
                >
                  <span>
                    {account.providerId === "kimi-sub"
                      ? account.expired
                        ? "额度登录已过期"
                        : "额度未登录"
                      : account.expired
                        ? "余额登录已过期"
                        : "余额未登录"}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {webLoginBusy ? "登录中…" : "点此登录"}
                    <RefreshIcon size={13} />
                  </span>
                </div>
              )}

            {meta.sub && rate ? (
              // 订阅类后端(Codex/Claude)：显示 5小时/周额度
              <>
                {rate.planType && (
                  <div className="u-row">
                    <span>订阅套餐</span>
                    <span style={{ textTransform: "capitalize" }}>
                      {rate.planType}
                      {rate.creditsUnlimited ? " · 无限" : ""}
                    </span>
                  </div>
                )}
                {typeof rate.primaryUsedPercent === "number" && (
                  <LimitRow
                    label={`${Math.round((rate.primaryWindowMinutes ?? 300) / 60)}小时限额`}
                    used={rate.primaryUsedPercent}
                    resetSec={rate.primaryResetAfterSeconds}
                  />
                )}
                {typeof rate.secondaryUsedPercent === "number" && (
                  <LimitRow
                    label={`周限额`}
                    used={rate.secondaryUsedPercent}
                    resetSec={rate.secondaryResetAfterSeconds}
                  />
                )}
                <div className="u-note">数据来自订阅额度（发一条消息后刷新）。</div>
              </>
            ) : account.balance ? (
              // 计费类后端(DeepSeek 等)：显示账户余额 + 本会话已消耗
              <>
                {account.balance.total && (
                  <div className="u-row">
                    <span>账户余额</span>
                    <span>{account.balance.total} 元</span>
                  </div>
                )}
                <div className="u-row">
                  <span>本会话已消耗</span>
                  <span>≈ {account.balance.consumed} 元</span>
                </div>
                <div className="u-row">
                  <span>本会话 tokens</span>
                  <span>
                    ↑{usage.totalInput.toLocaleString()} ↓{usage.totalOutput.toLocaleString()}
                  </span>
                </div>
                <div className="u-note">
                  {account.balance.total
                    ? `余额实时来自 ${account.label} 账户（每轮对话后刷新）。`
                    : `消耗按 token×单价估算（每轮对话后刷新）。`}
                </div>
              </>
            ) : (
              // 无额度/无余额信息：显示 token 统计
              <>
                <div className="u-row">
                  <span>本会话累计输入</span>
                  <span>{usage.totalInput.toLocaleString()} tokens</span>
                </div>
                <div className="u-row">
                  <span>本会话累计输出</span>
                  <span>{usage.totalOutput.toLocaleString()} tokens</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {showBrowser && (
        <BrowserPanel
          info={browserInfo}
          mode={browserMode}
          detached={browserDetached}
          width={browserWidth}
          onResize={setBrowserWidth}
          onMode={setBrowserMode}
          onDetach={() => window.minicc.browserDetach()}
          onReattach={() => window.minicc.browserReattach()}
          onClose={() => {
            if (browserDetached) window.minicc.browserReattach();
            setShowBrowser(false);
          }}
        />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          liveModels={liveModels}
          initialTab={settingsTab}
          groupMode={groupMode}
          onGroupMode={changeGroupMode}
          streamMode={streamMode}
          streamSpeed={streamSpeed}
          onStream={changeStream}
          keepRecent={keepRecent}
          onKeepRecent={changeKeepRecent}
          lang={lang}
          onLang={changeLang}
          t={t}
        />
      )}
      {/* 应用内登录框：邮箱/手机号/Google。未登录点发送(loginResume)或点账号登录时弹出 */}
      {showLoginForm && (
        <WuweiLoginModal
          incentive={loginResume}
          lang={lang}
          t={t}
          onClose={() => {
            setShowLoginForm(false);
            setLoginResume(false);
          }}
          onSuccess={onWuweiLoggedIn}
        />
      )}
      {coinShortage && (
        <div className="perm-overlay add-st-overlay" onClick={() => setCoinShortage(null)}>
          <div className="add-st-dialog coin-shortage-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>无为币余额不足</h3>
            <p className="s-note">{coinShortage.message}</p>
            <div className="coin-shortage-card">
              <CoinIcon size={18} />
              <div>
                <div className="coin-shortage-label">当前可用余额</div>
                <div className="coin-shortage-balance">
                  {coinShortage.balance != null ? coinShortage.balance : wuwei?.coin.balance ?? "刷新中"} 无为币
                </div>
              </div>
            </div>
            <div className="btns">
              <button
                onClick={() => {
                  void refreshWuweiForShortage(coinShortage.message);
                }}
              >
                刷新余额
              </button>
              <button
                className="allow"
                onClick={() => {
                  window.minicc.openExternal("https://wuweiai.io/pricing");
                }}
              >
                去充值
              </button>
            </div>
          </div>
        </div>
      )}
      {secretPrompt && (
        <div className="perm-overlay" onClick={() => setSecretPrompt(null)}>
          <div className="add-st-dialog sec-prompt" onClick={(e) => e.stopPropagation()}>
            <h3>🔒 检测到疑似密钥</h3>
            <p className="s-note">
              发现下面的敏感信息。勾选要存入本地密钥管理器的项——存入后会加密保存,并在发给 AI 前用占位符替换,之后每次自动识别。
            </p>
            <div className="sec-cand-list">
              {secretPrompt.candidates.map((c, i) =>
                c.existing ? (
                  // 值已在保险箱、但这次描述不同→让用户三选一
                  <div key={i} className="sec-cand sec-cand-dup">
                    <div className="sec-cand-dup-top">
                      <span className="sec-cand-kind dup">已存在</span>
                      <span className="sec-cand-val">{c.masked}</span>
                      <span className="sec-cand-meta">
                        旧备注：{c.existing.note || "（无）"} → 新：<b>{c.note}</b>
                      </span>
                    </div>
                    <div className="sec-seg">
                      {(["new", "overwrite", "ignore"] as const).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          className={"sec-seg-btn" + (secretPrompt.dupChoice[i] === opt ? " on" : "")}
                          onClick={() => {
                            const dupChoice = [...secretPrompt.dupChoice];
                            dupChoice[i] = opt;
                            setSecretPrompt({ ...secretPrompt, dupChoice });
                          }}
                        >
                          {opt === "new" ? "存为新的一条" : opt === "overwrite" ? "覆盖备注" : "不存"}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <label key={i} className="sec-cand">
                    <input
                      type="checkbox"
                      checked={secretPrompt.checked[i]}
                      onChange={(e) => {
                        const checked = [...secretPrompt.checked];
                        checked[i] = e.target.checked;
                        setSecretPrompt({ ...secretPrompt, checked });
                      }}
                    />
                    <span className="sec-cand-kind">{c.kind}</span>
                    <span className="sec-cand-val">{c.masked}</span>
                    <span className="sec-cand-meta">
                      → <b>{c.suggestedName}</b>
                      {c.note ? ` · ${c.note}` : ""}
                    </span>
                  </label>
                ),
              )}
            </div>
            <div className="btns">
              <button onClick={() => setSecretPrompt(null)}>取消发送</button>
              <button onClick={() => confirmSecretPrompt(false)}>不存,直接发</button>
              <button className="allow" onClick={() => confirmSecretPrompt(true)}>
                存入并替换后发送
              </button>
            </div>
          </div>
        </div>
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" title="关闭" onClick={() => setLightbox(null)}>
            ×
          </button>
        </div>
      )}

      {pending && (
        <div className="perm-overlay">
          <div className="perm">
            <h3>
              允许执行 <span className="tname">{pending.name}</span>？
            </h3>
            <div className="args">{JSON.stringify(pending.input, null, 2)}</div>
            <div className="btns">
              <button onClick={() => answerPerm("deny")}>拒绝 (N)</button>
              <button onClick={allowAlways}>总是允许 (A)</button>
              <button className="allow" onClick={() => answerPerm("allow")}>
                允许 (Y)
              </button>
            </div>
            <div className="hint">Y 允许一次 · A 总是允许该工具 · N/Esc 拒绝</div>
          </div>
        </div>
      )}
    </div>
  );
}

// 本轮(到上一条用户消息为止)正在执行的工具
function runningTools(items: Item[]): Extract<Item, { type: "tool" }>[] {
  const out: Extract<Item, { type: "tool" }>[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === "user" || it.type === "notice") break;
    if (it.type === "tool" && it.status === "running") out.push(it);
  }
  return out;
}

// 实时状态短语：随执行内容动态变——并行多工具/单工具/思考/生成
function liveStatus(items: Item[], chars: number, elapsed: number): string {
  const running = runningTools(items);
  if (running.length > 1) return `正在并行执行 ${running.length} 个操作`;
  if (running.length === 1) return "正在" + toolMeta(running[0]).label;
  if (chars === 0) return elapsed > 20 ? "深度思考中" : "思考中";
  return "生成回复";
}

function ThinkingBar({
  startRef,
  charsRef,
  items,
}: {
  startRef: React.MutableRefObject<number | null>;
  charsRef: React.MutableRefObject<number>;
  items: Item[];
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 400);
    return () => clearInterval(t);
  }, []);
  const start = startRef.current;
  const elapsed = start ? Math.floor((Date.now() - start) / 1000) : 0;
  const chars = charsRef.current;
  const toks = Math.max(0, Math.round(chars / 3));
  const tokLabel = toks >= 1000 ? (toks / 1000).toFixed(1) + "k" : String(toks);
  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;
  const time = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
  const status = liveStatus(items, chars, elapsed);
  const running = runningTools(items).length;
  return (
    <div className="thinking">
      <span className="tspark">✳</span>
      <span className="tstatus">{status}…</span>
      <span className="tmeta">
        {time} · {tokLabel} tokens · {running > 0 ? `${running} 个任务执行中` : "执行中"}
      </span>
    </div>
  );
}

function fmtReset(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}小时后重置`;
  if (h > 0) return `${h}小时${m}分后重置`;
  return `${m}分后重置`;
}

function LimitRow({ label, used, resetSec }: { label: string; used: number; resetSec?: number }) {
  return (
    <div className="limit">
      <div className="u-row">
        <span>{label}</span>
        <span>
          已用 {used}%
          {resetSec ? <span className="reset"> · {fmtReset(resetSec)}</span> : null}
        </span>
      </div>
      <div className="u-bar">
        <div className="u-fill" style={{ width: Math.min(100, used) + "%" }} />
      </div>
    </div>
  );
}

// 相对时间：刚刚 / X秒前 / X分钟前 / X小时前 / X天前 / 超过一周显示月日
function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 10) return "刚刚";
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}天前`;
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}


// 内置浏览器面板：与聊天同层的一列(半屏)/独占(全屏)/或弹成独立窗口。页面区是原生 WebContentsView，按此区域 bounds 贴合。
function BrowserPanel({
  info,
  mode,
  detached,
  width,
  onResize,
  onMode,
  onDetach,
  onReattach,
  onClose,
}: {
  info: { url?: string; title?: string; loading?: boolean; canGoBack?: boolean; canGoForward?: boolean };
  mode: "split" | "full";
  detached: boolean;
  width: number;
  onResize: (w: number) => void;
  onMode: (m: "split" | "full") => void;
  onDetach: () => void;
  onReattach: () => void;
  onClose: () => void;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  // 拖动左边缘调整浏览器面板宽度(面板在右→宽度=窗口宽-鼠标x)
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const w = Math.min(window.innerWidth - 300, Math.max(360, window.innerWidth - ev.clientX));
      onResize(w);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  const [urlEdit, setUrlEdit] = useState(info.url || "");
  useEffect(() => setUrlEdit(info.url || ""), [info.url]);
  useEffect(() => {
    if (detached) return; // 独立窗口时不占主窗口区域(视图已移到弹出窗)
    const push = () => {
      const el = regionRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      window.minicc.browserShow({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    push();
    const t = setTimeout(push, 60);
    const ro = new ResizeObserver(push);
    if (regionRef.current) ro.observe(regionRef.current);
    window.addEventListener("resize", push);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      window.removeEventListener("resize", push);
      window.minicc.browserHide();
    };
  }, [detached]);

  // 独立窗口时不占任何主窗口空间(控件移到顶栏 🖥 图标的下拉)
  if (detached) return null;
  return (
    <div className={"browser-panel " + mode} style={mode === "split" ? { flexBasis: width } : undefined}>
      {mode === "split" && <div className="bp-resizer" onMouseDown={startResize} title="拖动调整宽度" />}
      <div className="bp-bar">
        <button className="bp-nav" disabled={!info.canGoBack} onClick={() => window.minicc.browserNav("back")} title="后退">
          ‹
        </button>
        <button
          className="bp-nav"
          disabled={!info.canGoForward}
          onClick={() => window.minicc.browserNav("forward")}
          title="前进"
        >
          ›
        </button>
        <button className="bp-nav" onClick={() => window.minicc.browserNav("reload")} title="刷新">
          ⟳
        </button>
        <input
          className="bp-url"
          value={urlEdit}
          onChange={(e) => setUrlEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") window.minicc.browserNav("open", urlEdit);
          }}
          placeholder="输入网址回车打开"
        />
        {info.loading && <span className="bp-loading">…</span>}
        <button className={"bp-mode" + (mode === "split" ? " on" : "")} onClick={() => onMode("split")} title="半屏(与聊天并排)">
          ◫
        </button>
        <button className={"bp-mode" + (mode === "full" ? " on" : "")} onClick={() => onMode("full")} title="全屏浏览器">
          ▢
        </button>
        <button className="bp-mode" onClick={onDetach} title="弹成独立窗口(可拖动)">
          ⇱
        </button>
        <button className="bp-close" onClick={onClose} title="关闭浏览器面板">
          ✕
        </button>
      </div>
      <div className="bp-region" ref={regionRef} />
    </div>
  );
}

function ItemView({
  item,
  now,
  onDelete,
  onEdit,
}: {
  item: Item;
  now: number;
  onDelete?: () => void;
  onEdit?: () => void;
}) {
  if (item.type === "user")
    return (
      <div className="user-block">
        <div className="msg user">
          <div className="body">
            {item.images && item.images.length > 0 && (
              <div className="msg-imgs">
                {item.images.map((src, i) => (
                  <img
                    key={i}
                    src={src}
                    alt=""
                    style={{ cursor: "zoom-in" }}
                    onClick={() => openImageLightbox?.(src)}
                  />
                ))}
              </div>
            )}
            {maskSecrets(item.text)}
          </div>
        </div>
        <div className="turn-foot user">
          <div className="tf-actions">
            <CopyBtn text={item.text} />
            {onEdit && (
              <button
                className="tf-icon"
                title="撤回并编辑（收回这条，文字回到输入框可改可重发）"
                onClick={onEdit}
              >
                ↩
              </button>
            )}
            {onDelete && (
              <button className="tf-icon del" title="删除这轮问答(含提问与回复)" onClick={onDelete}>
                <TrashIcon />
              </button>
            )}
          </div>
          {item.ts && (
            <span className="tf-time" title={new Date(item.ts).toLocaleString()}>
              {relTime(item.ts, now)}
            </span>
          )}
        </div>
      </div>
    );
  if (item.type === "assistant") return <AssistantMsg text={item.text} />;
  if (item.type === "notice") return <div className="notice">ⓘ {item.text}</div>;
  return <ToolView item={item} />;
}

// 把"松散列表"(列表项间有空行)转成紧凑列表，从源头消除列表大间距；段落空行保留
// 显示层给密码/密钥打码：防止截图/上下文泄露(历史里保留原文供 AI 使用，仅屏上遮盖)。
// 只遮盖「凭据类关键词 + 分隔符 + 值」，如 密码是 xxx / server_pass="xxx" / token=xxx。
function maskSecrets(t: string): string {
  if (!t) return t;
  return t.replace(
    /((?:密码|口令|密钥|私钥|凭据|凭证|password|passwd|pwd|pass|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|auth)\s*[为是:：=]{1,3}\s*["'`「」]?)([^\s"'`，,。；;）)「」]{3,})/gi,
    (_m, pre: string) => pre + "••••••",
  );
}

function tightenMarkdown(t: string): string {
  let s = t.replace(/\n{3,}/g, "\n\n");
  // AI 有时用 • ‣ ◦ · ▪ 等字符当项目符号(非标准 markdown → 被当普通段落，间距大)，归一成 -
  s = s.replace(/^([ \t]*)[•‣◦·▪∙]\s+/gm, "$1- ");
  const listItem = /^[ \t]*([-*+]|\d+[.)])\s/;
  const lines = s.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (cur.trim() === "") {
      const prev = out[out.length - 1] ?? "";
      const next = lines[i + 1] ?? "";
      if (listItem.test(prev) && listItem.test(next)) continue; // 删列表项之间的空行
    }
    out.push(cur);
  }
  return out.join("\n").trimEnd();
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
      <path
        d="M12 1.6 Q13.6 10.4 13.6 10.4 Q13.6 10.4 22.4 12 Q13.6 13.6 13.6 13.6 Q13.6 13.6 12 22.4 Q10.4 13.6 10.4 13.6 Q10.4 13.6 1.6 12 Q10.4 10.4 10.4 10.4 Q10.4 10.4 12 1.6 Z"
        fill="#d97757"
      />
    </svg>
  );
}

// 复制/删除小图标(线条风，14px，currentColor)
function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
// 复制按钮：点后短暂显示绿色勾 + "已复制"提示
function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={"tf-icon" + (done ? " ok" : "")}
      title={done ? "已复制" : "复制"}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1300);
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

// 助手文字块：无头像、整块左对齐、纯 markdown 渲染
// memo：只有 text/streaming 变的那条才重渲染，其余消息跳过——流式不卡的关键。
// 流式中「按段提交」：以最后一个空行(\n\n)为界，前面已完成的段落即时渲染 Markdown
// (MarkdownView 有 memo，committed 不变就不重解析→只在跨段时解析一次)，最后没写完的一段用纯文本。
// 流完(streaming=false)整体走完整 Markdown + 代码高亮。
const AssistantMsg = React.memo(function AssistantMsg({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  if (!streaming) {
    return (
      <div className="aimsg">
        <MarkdownView text={text} highlight={true} />
      </div>
    );
  }
  const cut = text.lastIndexOf("\n\n"); // 最后一个段落边界
  const committed = cut >= 0 ? text.slice(0, cut) : "";
  const tail = cut >= 0 ? text.slice(cut + 2) : text;
  return (
    <div className="aimsg">
      {committed && <MarkdownView text={committed} highlight={false} />}
      {tail && <div className="md md-streaming">{maskSecrets(tail)}</div>}
    </div>
  );
});

// 代码块：右上角一键复制(取 <pre> 的纯文本)
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [done, setDone] = useState(false);
  const copy = () => {
    const t = ref.current?.textContent ?? "";
    navigator.clipboard.writeText(t).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    });
  };
  return (
    <div className="code-wrap">
      <button className={"code-copy" + (done ? " ok" : "")} onClick={copy} title="复制代码">
        {done ? "✓ 已复制" : "复制"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

// memo：text/highlight 不变就不重新解析——流式「按段提交」时已完成段落不会每帧重解析的关键
const MarkdownView = React.memo(function MarkdownView({
  text,
  highlight = true,
}: {
  text: string;
  highlight?: boolean;
}) {
  const clean = maskSecrets(tightenMarkdown(text));
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={highlight ? [rehypeHighlight] : []}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) window.minicc.openExternal(href);
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {clean}
      </Markdown>
    </div>
  );
});

function baseName(p: string): string {
  return p.split("/").pop() || p;
}

// 单段命令→动作名
function segAction(seg: string): string {
  const c = seg.toLowerCase().trim();
  if (/\b(test|pytest|jest|vitest|go test|npm (run )?test)\b/.test(c)) return "测试";
  if (/(electron-vite build|vite build|tsc\b|\b(npm|yarn|pnpm) (run )?build\b|cargo build|go build|\bmake\b)/.test(c))
    return "构建";
  if (/(electron-builder|--dir|\bpkg\b|package)/.test(c)) return "打包";
  if (/\b(deploy|scp|rsync|publish)\b|docker (push|cp)|rm -rf .*app|cp -R .*\.app|xattr/.test(c))
    return "部署";
  if (/\b(install|pip install|npm i\b|yarn add|apt|brew install)\b/.test(c)) return "安装依赖";
  if (/\bgit\b/.test(c)) return "Git 操作";
  if (/\b(grep|rg|ag|ack)\b/.test(c)) return "搜索内容";
  if (/\b(ls|find|tree|du|stat|fd)\b/.test(c)) return "浏览目录";
  if (/\b(cat|head|tail|less|more|sed|awk)\b/.test(c)) return "查看文件";
  if (/\b(mkdir|touch|cp|mv|rm|chmod|ln)\b/.test(c)) return "文件操作";
  if (/\b(node|python3?|electron|osascript|open|kill|pkill)\b|(^|\s)\.\//.test(c)) return "运行";
  return "执行命令";
}
// 把整条命令按 && / ; / | / 换行 拆开，逐段识别动作，拼成"构建 · 部署 · 运行"这种摘要
function bashIntent(cmd: string): { label: string; category: string } {
  const segs = cmd
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(cd|export|set|echo)\b/.test(s.toLowerCase())); // 跳过无信息量的
  const acts: string[] = [];
  for (const s of segs) {
    const a = segAction(s);
    if (!acts.includes(a)) acts.push(a);
  }
  const uniq = acts.length ? acts : ["执行命令"];
  return { label: uniq.slice(0, 4).join(" · "), category: uniq[0] };
}

// 工具的图标 + 意图描述 + 类别（分组用）+ 行数增删
function toolMeta(item: Extract<Item, { type: "tool" }>): {
  icon: string;
  label: string;
  category: string;
  add?: number;
  del?: number;
} {
  const inp = item.input as any;
  switch (item.name) {
    case "bash": {
      const bi = bashIntent(String(inp.command || ""));
      return { icon: "⌘", label: bi.label, category: bi.category };
    }
    case "read_file":
      return {
        icon: "◎",
        label: "读取 " + baseName(String(inp.path || "")),
        category: "读取文件",
      };
    case "write_file":
      return {
        icon: "✎",
        label: "新建 " + baseName(String(inp.path || "")),
        category: "新建文件",
        add: String(inp.content ?? "").length, // 字符数
      };
    case "edit_file":
      return {
        icon: "✎",
        label: "编辑 " + baseName(String(inp.path || "")),
        category: "编辑文件",
        add: String(inp.new_string ?? "").length, // 新增字符数
        del: String(inp.old_string ?? "").length, // 删除字符数
      };
    case "glob":
      return { icon: "⌕", label: "查找文件", category: "搜索内容" };
    case "grep":
      return { icon: "⌕", label: "搜索内容", category: "搜索内容" };
    case "web_search":
      return { icon: "🌐", label: "搜索网络：" + String(inp.query || ""), category: "联网搜索" };
    case "web_fetch":
      return { icon: "🌐", label: "抓取网页 " + String(inp.url || ""), category: "读取网页" };
    case "browser_open":
      return { icon: "🖥", label: "浏览器打开 " + String(inp.url || ""), category: "浏览器" };
    case "browser_read":
      return { icon: "🖥", label: "读取当前页面", category: "浏览器" };
    case "browser_click":
      return { icon: "🖥", label: "点击 " + String(inp.selector || ""), category: "浏览器" };
    case "remember":
      return { icon: "✦", label: "记住：" + String(inp.text || ""), category: "写入记忆" };
    default:
      return { icon: "•", label: item.name, category: item.name };
  }
}

// 工具输入预览：展开后显示"具体在执行啥"(运行中也能看)
function toolInputPreview(item: Extract<Item, { type: "tool" }>): string {
  const inp = (item.input || {}) as any;
  switch (item.name) {
    case "bash":
      return "$ " + String(inp.command || "");
    case "read_file":
      return "读取 " + String(inp.path || "");
    case "write_file":
      return "写入 " + String(inp.path || "");
    case "edit_file":
      return "编辑 " + String(inp.path || "");
    case "grep":
      return `搜索 “${inp.pattern ?? ""}”` + (inp.path ? `  ·  路径 ${inp.path}` : "");
    case "glob":
      return `匹配 ${inp.pattern ?? inp.glob ?? ""}` + (inp.path ? `  ·  路径 ${inp.path}` : "");
    case "web_search":
      return `搜索网络：${inp.query ?? ""}`;
    case "web_fetch":
      return `抓取 ${inp.url ?? ""}`;
    case "browser_open":
      return `浏览器打开 ${inp.url ?? ""}`;
    case "browser_click":
      return `点击 ${inp.selector ?? ""}`;
    case "remember":
      return `记住：${inp.text ?? ""}`;
    default: {
      const s = JSON.stringify(inp);
      return s === "{}" ? "" : s;
    }
  }
}

const ToolView = React.memo(function ToolView({ item }: { item: Extract<Item, { type: "tool" }> }) {
  const [open, setOpen] = useState(false); // 默认折叠
  const m = toolMeta(item);
  const running = item.status === "running";
  const diff = renderDiff(item);
  const cmd = item.name === "bash" ? String((item.input as any).command || "") : "";
  const inputStr = toolInputPreview(item);
  // 有输入/结果/diff 都可展开——运行中也能点开看正在执行的输入
  const hasDetail = !!diff || !!item.result || !!inputStr;
  return (
    <div className="tool">
      <div className="trow" onClick={() => hasDetail && setOpen((v) => !v)}>
        <span className="tlabel">{m.label}</span>
        {(m.add != null || m.del != null) && (
          <span
            className="tdelta"
            title={`新增 ${m.add ?? 0} 字符${m.del != null ? ` · 删除 ${m.del} 字符` : ""}`}
          >
            {m.add != null && <span className="add">+{m.add}</span>}
            {m.del != null && <span className="del">-{m.del}</span>}
            <span className="tunit"> 字符</span>
          </span>
        )}
        <span className="tspacer" />
        <span className={"tstat " + (running ? "run" : item.isError ? "err" : "ok")}>
          {running ? "运行中" : item.isError ? "失败" : "完成"}
        </span>
        {hasDetail && <span className="tcaret">{open ? "▾" : "▸"}</span>}
      </div>
      {open && cmd && <div className="tcmd">$ {cmd}</div>}
      {open && !cmd && inputStr && <div className="tcmd">{inputStr}</div>}
      {open && diff}
      {open && !diff && item.result && (
        <div className={"result" + (item.isError ? " err" : "")}>{clip(item.result, 60)}</div>
      )}
    </div>
  );
});

type ToolItem = Extract<Item, { type: "tool" }>;

// 连续的工具调用合并成一组，收起显示概括；点开列步骤，再点开看命令
function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 1) return <ToolView item={tools[0]} />;
  const running = tools.some((t) => t.status === "running");
  const done = tools.filter((t) => t.status === "done").length;
  const counts: Record<string, number> = {};
  for (const t of tools) {
    const c = toolMeta(t).category;
    counts[c] = (counts[c] || 0) + 1;
  }
  const mainCat = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "操作";
  return (
    <div className="tool">
      <div className="trow" onClick={() => setOpen((v) => !v)}>
        <span className="tlabel">
          {mainCat} · {tools.length} 步{running ? `（${done}/${tools.length}）` : ""}
        </span>
        <span className="tspacer" />
        <span className="tcaret">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="tgroup-items">
          {tools.map((t, i) => (
            <ToolView key={i} item={t} />
          ))}
        </div>
      )}
    </div>
  );
}

type RenderBlock = { kind: "item"; item: Item } | { kind: "tools"; tools: ToolItem[] };
function groupBlocks(items: Item[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  for (const it of items) {
    if (it.type === "tool") {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "tools") last.tools.push(it);
      else blocks.push({ kind: "tools", tools: [it] });
    } else {
      blocks.push({ kind: "item", item: it });
    }
  }
  return blocks;
}

// 一个 AI 回合 = 连续的助手文字 + 工具块，整组左对齐、底部左侧只放一个星星
type Turn = { kind: "solo"; item: Item } | { kind: "ai"; blocks: RenderBlock[] };
function groupTurns(items: Item[]): Turn[] {
  const turns: Turn[] = [];
  for (const rb of groupBlocks(items)) {
    const solo = rb.kind === "item" && (rb.item.type === "user" || rb.item.type === "notice");
    if (solo) {
      turns.push({ kind: "solo", item: (rb as { kind: "item"; item: Item }).item });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last && last.kind === "ai") last.blocks.push(rb);
    else turns.push({ kind: "ai", blocks: [rb] });
  }
  return turns;
}

// 取一个 AI 回合的时间戳=回合内最后一条助手文字的 ts(没有则不显示)
function aiTurnTs(blocks: RenderBlock[]): number | undefined {
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    if (b.kind === "item" && b.item.type === "assistant" && b.item.ts) return b.item.ts;
  }
  return undefined;
}

function renderDiff(item: Extract<Item, { type: "tool" }>) {
  if (item.status !== "done") return null;
  if (item.name === "edit_file" && item.input.old_string && item.input.new_string) {
    const del = String(item.input.old_string).split("\n");
    const add = String(item.input.new_string).split("\n");
    return (
      <div className="diff">
        {del.map((l, i) => (
          <div key={"d" + i} className="line del">
            - {l}
          </div>
        ))}
        {add.map((l, i) => (
          <div key={"a" + i} className="line add">
            + {l}
          </div>
        ))}
      </div>
    );
  }
  if (item.name === "write_file" && typeof item.input.content === "string") {
    const add = String(item.input.content).split("\n").slice(0, 40);
    return (
      <div className="diff">
        {add.map((l, i) => (
          <div key={"a" + i} className="line add">
            + {l}
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function clip(text: string, lines = 12): string {
  const arr = text.split("\n");
  return arr.length > lines ? arr.slice(0, lines).join("\n") + "\n…（已截断）" : text;
}

type Kind = "codex" | "anthropic-oauth" | "anthropic-apikey" | "openai";
interface Preset {
  id: string;
  label: string;
  kind: Kind;
  baseUrl: string;
  keyUrl: string;
  keyHint: string;
  models: string[];
  modelLabels?: Record<string, string>; // 模型 id → 灰字说明(如"基于 Qwen3-VL-8B 微调")
  note?: string;
  fixedBaseUrl: boolean;
  custom?: boolean; // 用户自定义中转站(可删除)
  hosted?: boolean; // 无为托管平台(走网关、按 token 扣无为币)；仅灰度放开的用户可见
}

// 用户自定义中转站
type Station = { id: string; label: string; baseUrl: string };
// 中转站 → 伪预设(OpenAI 兼容)，并入平台下拉
function stationToPreset(s: Station): Preset {
  return {
    id: s.id,
    label: s.label + "（中转）",
    kind: "openai",
    baseUrl: s.baseUrl,
    keyUrl: "",
    keyHint: "sk-...",
    models: [],
    note: "自定义中转站（OpenAI 兼容）。模型名按该站文档填，可自定义输入。",
    fixedBaseUrl: true,
    custom: true,
  };
}

// 私有版：保留 Codex/Claude 两种订阅后端，其余为各平台 API Key 预设（模型 id 均取自官网 2026-07）
const PRESETS: Preset[] = [
  {
    // 无为托管：走网关、用无为币按 token 扣费，无需自己的 Key。仅灰度放开的用户可见。
    id: "wuwei-deepseek",
    label: "无为托管 · DeepSeek",
    kind: "openai",
    baseUrl: "https://wuweiai.io/api/gateway/v1",
    keyUrl: "",
    keyHint: "",
    models: ["deepseek-chat"],
    note: "无为托管额度：无需自己的 Key，按实际 token 消耗扣无为币（余额在账号菜单查看）。",
    fixedBaseUrl: true,
    hosted: true,
  },
  {
    id: "codex",
    label: "Codex 订阅（ChatGPT 登录）",
    kind: "codex",
    baseUrl: "",
    keyUrl: "",
    keyHint: "",
    models: [
      "gpt-5.5",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5-pro",
      "gpt-5.4",
    ],
    note: "使用本机 ~/.codex 登录态，无需填写凭证。仅 gpt-5.5 经真机验证；其它型号能否走订阅通道，切换后看状态灯/实际请求为准（不通会亮黄灯）。",
    fixedBaseUrl: true,
  },
  {
    id: "claude-oauth",
    label: "Claude 订阅（Claude Code）",
    kind: "anthropic-oauth",
    baseUrl: "",
    keyUrl: "",
    keyHint: "sk-ant-oat…（点上方一键授权自动获取）",
    models: [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-fable-5",
    ],
    note: "",
    fixedBaseUrl: true,
  },
  {
    id: "anthropic",
    label: "Claude API Key（Anthropic）",
    kind: "anthropic-apikey",
    baseUrl: "",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-...",
    models: [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-fable-5",
    ],
    fixedBaseUrl: true,
  },
  {
    id: "openai",
    label: "OpenAI（GPT）",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-...",
    models: [
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o4-mini",
    ],
    note: "gpt-5.6-terra 均衡 / sol 最强 / luna 省钱",
    fixedBaseUrl: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter（中转 · 全平台）",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-...",
    models: [
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5.5",
      "openai/gpt-5.6-terra",
      "google/gemini-3-pro",
      "deepseek/deepseek-chat",
      "x-ai/grok-4.5",
      "qwen/qwen3-max",
      "moonshotai/kimi-k2",
    ],
    note: "一个 key 直连 Claude / GPT / Gemini 等全平台。模型用「厂商/型号」slug（完整清单见 openrouter.ai/models），可选「自定义」直接输入任意 slug。",
    fixedBaseUrl: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek（深度求索）",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-...",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    note: "V4 Pro/Flash；deepseek-chat/deepseek-reasoner 2026-07-24 后停用",
    fixedBaseUrl: true,
  },
  {
    id: "qwen",
    label: "通义千问 Qwen（阿里百炼）",
    kind: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://bailian.console.aliyun.com/",
    keyHint: "sk-...",
    models: [
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-flash",
      "qwen3-max",
      "qwen-max",
      "qwen-plus",
      "qwen-flash",
      "qwen-turbo",
      "qwen-long",
      "qwen3-coder-plus",
      "qwen3-coder-flash",
    ],
    fixedBaseUrl: true,
  },
  {
    id: "doubao",
    label: "豆包 Doubao（火山方舟）",
    kind: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyUrl: "https://console.volcengine.com/ark",
    keyHint: "火山方舟 API Key",
    models: [
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-1-8-251228",
      "doubao-seed-1-6-251015",
      "doubao-seed-1-6-flash-250828",
      "doubao-seed-1-6-lite-251015",
      "doubao-1-5-pro-32k-250115",
      "doubao-1-5-lite-32k-250115",
    ],
    note: "豆包多在方舟「在线推理」创建接入点后用接入点 ID(ep-...)；模型名带日期串会更新，可用「自定义」直接填最新的",
    fixedBaseUrl: true,
  },
  {
    id: "minimax",
    label: "MiniMax",
    kind: "openai",
    baseUrl: "https://api.minimaxi.com/v1",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    keyHint: "MiniMax API Key",
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ],
    fixedBaseUrl: true,
  },
  {
    id: "zhipu",
    label: "智谱 GLM（BigModel）",
    kind: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyUrl: "https://open.bigmodel.cn/apikey/platform",
    keyHint: "智谱 API Key",
    models: [
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-5-turbo",
      "glm-4.7",
      "glm-4.6",
      "glm-4.5",
      "glm-4.7-flash",
      "glm-5v-turbo",
      "glm-4.6v",
      "glm-4.6v-flash",
      "glm-4.1v-thinking",
    ],
    note: "glm-5.2 旗舰(1M上下文)；glm-5v-turbo / glm-4.6v 为视觉多模态(支持图文)",
    fixedBaseUrl: true,
  },
  {
    id: "kimi",
    label: "Kimi（月之暗面 Moonshot）",
    kind: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    keyUrl: "https://platform.kimi.com/console/api-keys",
    keyHint: "sk-...",
    models: [
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-latest",
      "moonshot-v1-128k",
      "moonshot-v1-32k",
      "moonshot-v1-8k",
      "moonshot-v1-128k-vision-preview",
      "moonshot-v1-32k-vision-preview",
      "moonshot-v1-8k-vision-preview",
    ],
    note: "kimi-k3 旗舰(2.8T/1M上下文)；国际站请改 https://api.moonshot.ai/v1；kimi-latest 与 *-vision-preview 支持图文",
    fixedBaseUrl: false,
  },
  {
    id: "kimi-sub",
    label: "Kimi Code 订阅（会员）",
    kind: "openai",
    baseUrl: "https://api.kimi.com/coding/v1",
    keyUrl: "https://www.kimi.com/code",
    keyHint: "sk-...（Kimi Code 控制台会员创建）",
    models: ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"],
    note: "走会员订阅额度（非按量计费 API）。base=/coding/v1，旗舰 model 用 k3（≠开放平台的 kimi-k3）。key 在 Kimi Code 控制台创建，最多 5 个、仅创建时可见。⚠官方红线：勿改 User-Agent 冒充其它工具，否则视为违规可能封会员。",
    fixedBaseUrl: false,
  },
  {
    id: "hunyuan",
    label: "腾讯混元（元宝）",
    kind: "openai",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
    keyHint: "混元 API Key",
    models: [
      "hunyuan-turbos-latest",
      "hunyuan-t1-latest",
      "hunyuan-turbo-latest",
      "hunyuan-large",
      "hunyuan-standard",
      "hunyuan-lite",
      "hunyuan-vision",
    ],
    note: "元宝对应腾讯混元 API；hunyuan-vision 支持图文",
    fixedBaseUrl: true,
  },
  {
    id: "grok",
    label: "Grok（xAI）",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    keyHint: "xai-...",
    models: [
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent-0309",
    ],
    note: "grok-4.x 系原生多模态(支持图文)；grok-4.3 为 1M 上下文旗舰",
    fixedBaseUrl: true,
  },
  {
    id: "custom",
    label: "本地 / 自建端点（vLLM、Ollama 等）",
    kind: "openai",
    baseUrl: "http://localhost:8000/v1",
    keyUrl: "",
    keyHint: "本地可留空",
    models: [],
    note: "任意 OpenAI 兼容端点，填你的 Base URL + 模型名即可",
    fixedBaseUrl: false,
  },
];

// 菜单/下拉里的展示顺序(不改 PRESETS 定义本身，PRESETS[0]=codex 仍作默认)
const PROVIDER_ORDER = [
  "codex",
  "claude-oauth",
  "anthropic",
  "openrouter",
  "openai",
  "zhipu",
  "deepseek",
  "minimax",
  "doubao",
  "qwen",
  "kimi",
  "kimi-sub",
  "hunyuan",
  "grok",
  "custom",
];

// 依据用户自定义顺序(order)+隐藏集(hidden)对预设列表排序/过滤。
// order 里没有的(新平台/新中转站)按内置 PROVIDER_ORDER 默认序、再按原始相对序补到末尾——保证永不漏显示。
// includeHidden=true 时保留隐藏项(设置里的平台管理列表用)，false 时过滤掉(切换菜单/正常展示用)。
function arrangePresets(
  all: Preset[],
  order: string[] | undefined,
  hidden: string[] | undefined,
  includeHidden: boolean,
): Preset[] {
  const userRank = new Map((order || []).map((id, i) => [id, i]));
  const defRank = new Map(PROVIDER_ORDER.map((id, i) => [id, i]));
  const rankOf = (id: string) => {
    if (userRank.has(id)) return userRank.get(id)!; // 用户排过的：最优先
    if (defRank.has(id)) return 1000 + defRank.get(id)!; // 内置但用户没排过：接在后面按默认序
    return 2000; // 都不认识(自定义中转站)：垫底，靠原始序稳定排列
  };
  const sorted = [...all].sort((a, b) => {
    const d = rankOf(a.id) - rankOf(b.id);
    return d !== 0 ? d : all.indexOf(a) - all.indexOf(b);
  });
  const hide = new Set(hidden || []);
  return includeHidden ? sorted : sorted.filter((p) => !hide.has(p.id));
}

type CredSlot = { apiKey?: string; baseUrl?: string; oauthToken?: string; nickname?: string };

// 简约线条眼睛图标：off=true 显示"划掉的眼睛"(当前明文，点击隐藏)
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

// MCP 服务器配置项
type McpServer = { command: string; args?: string[]; env?: Record<string, string>; disabled?: boolean };
// 把配置 JSON(数组 或 {mcpServers}) 解析成 {name: server}
function parseMcpServers(text: string): Record<string, McpServer> {
  try {
    const r = JSON.parse(text);
    if (r?.mcpServers && typeof r.mcpServers === "object") return r.mcpServers;
    if (Array.isArray(r))
      return Object.fromEntries(
        r.map((s: any) => [s.name, { command: s.command, args: s.args, env: s.env, disabled: s.disabled }]),
      );
  } catch {
    /* 非法 JSON */
  }
  return {};
}
// 配置字段：指向某个 arg 下标或某个 env 键，带说明；有默认值的装上直接可用
type McpConfigField =
  | { arg: number; label: string; hint: string }
  | { env: string; label: string; hint: string };
type CatalogItem = {
  name: string;
  label: string;
  desc: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  config?: McpConfigField[]; // 需/可配置的字段(编辑器只显示这些，其余固定参数隐藏)
};
// 常用 MCP 服务器目录(搜索+一键安装)。有默认值的开箱即用；<...> 是必须填的密钥/连接串
const MCP_CATALOG: CatalogItem[] = [
  {
    name: "filesystem",
    label: "文件系统",
    desc: "读写指定目录的文件/搜索",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "~/Desktop"],
    config: [{ arg: 2, label: "可访问目录", hint: "AI 能读写的目录，默认桌面；可留桌面或改成项目目录" }],
  },
  { name: "puppeteer", label: "Puppeteer 浏览器", desc: "无头浏览器控制/截图，开箱可用", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] },
  { name: "memory", label: "知识图谱记忆", desc: "持久知识图谱记忆，开箱可用", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  { name: "sequential-thinking", label: "逐步思考", desc: "结构化多步推理，开箱可用", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
  {
    name: "github",
    label: "GitHub",
    desc: "仓库/Issue/PR 操作",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "<token>" },
    config: [{ env: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Token", hint: "github.com/settings/tokens 生成，勾选仓库权限" }],
  },
  {
    name: "brave-search",
    label: "Brave 搜索",
    desc: "网页搜索",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "<key>" },
    config: [{ env: "BRAVE_API_KEY", label: "Brave API Key", hint: "brave.com/search/api 免费申请" }],
  },
  {
    name: "postgres",
    label: "Postgres",
    desc: "查询 Postgres（只读）",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "<连接串>"],
    config: [{ arg: 2, label: "连接串", hint: "postgresql://用户:密码@主机:5432/库名" }],
  },
  {
    name: "slack",
    label: "Slack",
    desc: "读写 Slack 消息",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "<token>", SLACK_TEAM_ID: "<team>" },
    config: [
      { env: "SLACK_BOT_TOKEN", label: "Bot Token", hint: "xoxb- 开头" },
      { env: "SLACK_TEAM_ID", label: "Team ID", hint: "T 开头" },
    ],
  },
];

// 迁移：把已装服务器里的旧 <占位> 自动补成目录里的默认值(如 sqlite 的 <db路径>→~/minicc.db)，让老配置也开箱可用
function migrateMcpDefaults(text: string): { text: string; changed: boolean } {
  const servers = parseMcpServers(text);
  let changed = false;
  for (const [name, sv] of Object.entries(servers)) {
    const cat = MCP_CATALOG.find((c) => c.name === name);
    if (!cat?.config) continue;
    for (const f of cat.config) {
      if ("arg" in f) {
        const cur = sv.args?.[f.arg];
        const def = cat.args[f.arg];
        if ((cur == null || String(cur).includes("<")) && def && !def.includes("<")) {
          sv.args = [...(sv.args || [])];
          sv.args[f.arg] = def;
          changed = true;
        }
      } else {
        const cur = sv.env?.[f.env];
        const def = cat.env?.[f.env];
        if ((cur == null || String(cur).includes("<")) && def && !def.includes("<")) {
          sv.env = { ...(sv.env || {}), [f.env]: def };
          changed = true;
        }
      }
    }
  }
  return { text: changed ? JSON.stringify({ mcpServers: servers }, null, 2) : text, changed };
}

// Brain 属性 <-> 文本（每行「键: 值」）互转，供知识网络面板编辑属性
function attrsToText(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
function textToAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function SettingsModal({
  onClose,
  liveModels,
  initialTab,
  groupMode,
  onGroupMode,
  streamMode,
  streamSpeed,
  onStream,
  keepRecent,
  onKeepRecent,
  lang,
  onLang,
  t,
}: {
  onClose: () => void;
  liveModels: Record<string, string[]>;
  initialTab?: string;
  groupMode: "manual" | "date" | "project";
  onGroupMode: (m: "manual" | "date" | "project") => void;
  streamMode: "typewriter" | "stream" | "instant";
  streamSpeed: number;
  onStream: (mode: "typewriter" | "stream" | "instant", speed: number) => void;
  keepRecent: number;
  onKeepRecent: (n: number) => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  t: T;
}) {
  // 界面主题（并入设置页「外观」）
  const [uiTheme, setUiTheme] = useState("light");
  useEffect(() => {
    window.minicc.getSettings().then((r: any) => setUiTheme(resolveTheme(r?.settings?.theme)));
  }, []);
  async function pickTheme(t: string) {
    setUiTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    const r: any = await window.minicc.getSettings();
    window.minicc.setSettings({ ...(r?.settings || {}), theme: t });
  }
  const [pid, setPid] = useState("codex");
  const [model, setModel] = useState(PRESETS[0].models[0]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [oauthToken, setOauthToken] = useState("");
  const [nickname, setNickname] = useState("");
  const [customModel, setCustomModel] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [claudeBusy, setClaudeBusy] = useState(false); // Claude 一键授权进行中
  const [sCodexBusy, setSCodexBusy] = useState(false); // 设置里 Codex 一键授权进行中
  const [sysPrompt, setSysPrompt] = useState(""); // 系统提示词(可编辑)
  const [sysPromptDefault, setSysPromptDefault] = useState(""); // 默认模板(恢复默认用)
  const [sysPromptTouched, setSysPromptTouched] = useState(false); // 是否自定义过(否则存 undefined=用默认)
  const [platPromptOn, setPlatPromptOn] = useState(false); // 当前平台是否用专属提示词覆盖全局
  const [platPrompt, setPlatPrompt] = useState(""); // 当前平台专属提示词内容
  const [sKeyWaiting, setSKeyWaiting] = useState(false); // 设置里：已开官网，等复制 key 自动检测
  const [sKeyMsg, setSKeyMsg] = useState(""); // key 验证内联反馈
  const sLastClipRef = useRef(""); // 设置里剪贴板去重
  const sKeyTestingRef = useRef(false); // 设置里防并发验证
  const [sAwaitCode, setSAwaitCode] = useState(false); // 设置里浏览器授权：等回填授权码
  const [sCode, setSCode] = useState(""); // 设置里授权码输入
  const [creds, setCreds] = useState<Record<string, CredSlot>>({}); // 各平台凭证分槽
  const credsRef = useRef(creds); // 镜像最新 creds，避免切换时读到过时闭包(会误显示空 key→保存覆盖)
  // ── 文档冷存储（知识宫殿等）──
  const [docStat, setDocStat] = useState<{ chunks: number; files: number; dir: string; builtAt: number }>({ chunks: 0, files: 0, dir: "", builtAt: 0 });
  const [docDir, setDocDir] = useState("~/Documents/tanxun/知识宫殿");
  const [docBuilding, setDocBuilding] = useState(false);
  const [docProg, setDocProg] = useState("");
  credsRef.current = creds;
  const loadedRef = useRef<any>({}); // 保存加载时的完整 settings，保存时 spread 保留 theme/app 等本页不管的字段
  const [stations, setStations] = useState<Station[]>([]); // 自定义中转站
  const [newStName, setNewStName] = useState(""); // 新增中转站：名称
  const [newStUrl, setNewStUrl] = useState(""); // 新增中转站：baseURL
  const [showAddStation, setShowAddStation] = useState(false); // 添加中转站独立弹窗
  const stationsRef = useRef(stations);
  stationsRef.current = stations;
  const [order, setOrder] = useState<string[]>([]); // 平台自定义顺序(全量 id 列表)
  const [hidden, setHidden] = useState<string[]>([]); // 隐藏的平台
  const orderRef = useRef(order);
  orderRef.current = order;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [dragOverIdx, setDragOverIdx] = useState(-1); // 拖拽悬停到第几行(高亮)
  const dragIdxRef = useRef(-1); // 拖起始行
  const [tab, setTab] = useState<
    "general" | "display" | "model" | "platforms" | "prompt" | "memory" | "brain" | "mcp" | "tools" | "secrets"
  >((initialTab as any) || "model"); // 设置分块标签页(左侧菜单)
  const [maxed, setMaxed] = useState(false); // 设置弹窗最大化(知识网络等大结构需放大看)
  const [memory, setMemory] = useState(""); // 全局长期记忆
  const memoryTouchedRef = useRef(false); // 是否改过记忆(保存时才写)
  // ── 本地知识网络 Brain ──
  const [brainNodes, setBrainNodes] = useState<import("./env").BrainNodeLite[]>([]);
  const [brainEdges, setBrainEdges] = useState<import("./env").BrainEdgeLite[]>([]);
  const [brainStat, setBrainStat] = useState<{ nodes: number; edges: number; embedded: number }>({ nodes: 0, edges: 0, embedded: 0 });
  const [brainFilter, setBrainFilter] = useState(""); // 概念列表过滤
  const [brainSel, setBrainSel] = useState<string | null>(null); // 选中编辑的节点 id
  const [brainDraft, setBrainDraft] = useState<import("./env").BrainNodeLite | null>(null); // 编辑草稿
  const [brainRecallQ, setBrainRecallQ] = useState(""); // 检索测试输入
  const [brainRecallOut, setBrainRecallOut] = useState(""); // 检索测试结果
  const [brainWarming, setBrainWarming] = useState(false); // 模型预热中
  const [brainWarmMsg, setBrainWarmMsg] = useState(""); // 预热结果提示
  const [conExtract, setConExtract] = useState<{ running: boolean; phase: string; total: number; done: number; created: number; cur?: string } | null>(null); // 概念抽取进度
  const [brainNewEdge, setBrainNewEdge] = useState({ relation: "", to: "" }); // 给选中节点加关系
  const reloadBrain = () =>
    Promise.all([window.minicc.brainGraph(), window.minicc.brainStats()]).then(([g, st]) => {
      setBrainNodes(g.nodes);
      setBrainEdges(g.edges);
      setBrainStat(st);
    });
  const [mcpConfig, setMcpConfig] = useState(""); // MCP 服务器配置(JSON，源真相)
  const [mcpStatus, setMcpStatus] = useState<
    { name: string; status: string; error: string; disabled?: boolean; toolInfos?: { name: string; description: string }[] }[]
  >([]);
  const mcpTouchedRef = useRef(false);
  const [mcpSearch, setMcpSearch] = useState(""); // 搜索(过滤已装+目录+在线库)
  const [mcpExpanded, setMcpExpanded] = useState<string | null>(null); // 展开看工具的服务器
  const [mcpRawEdit, setMcpRawEdit] = useState(false); // 高级：直接编辑 JSON
  const [mcpEdit, setMcpEdit] = useState<string | null>(null); // 就地编辑配置的服务器
  const [mcpEditArgs, setMcpEditArgs] = useState<string[]>([]); // 完整 args(写回用)
  const [mcpEditEnvMap, setMcpEditEnvMap] = useState<Record<string, string>>({}); // 完整 env(写回用)
  // 只展示这些可配置字段(带说明)，其余固定参数隐藏
  const [mcpEditFields, setMcpEditFields] = useState<
    { label: string; hint: string; kind: "arg" | "env"; idx?: number; key?: string }[]
  >([]);
  type RegItem = {
    name: string;
    fullName: string;
    description: string;
    command: string;
    args: string[];
    repo: string;
    version: string;
  };
  const [mcpOnline, setMcpOnline] = useState<RegItem[]>([]);
  const [mcpCursor, setMcpCursor] = useState(""); // 下一页游标
  const [mcpSearching, setMcpSearching] = useState(false);
  const [mcpLoadingMore, setMcpLoadingMore] = useState(false);
  const [mcpOnlineOpen, setMcpOnlineOpen] = useState<string | null>(null); // 展开详情的在线结果
  const mcpSearchRef = useRef(""); // 当前搜索词(翻页时校验没变)
  // ── 工具面板：当前生效的全部工具（按来源分组）──
  type ToolInfo = { name: string; description: string; readOnly: boolean; inputSchema: any };
  type ToolGroup = { source: string; kind: "builtin" | "browser" | "mcp"; tools: ToolInfo[] };
  const [toolGroups, setToolGroups] = useState<ToolGroup[]>([]);
  const [toolTotal, setToolTotal] = useState(0);
  const [toolView, setToolView] = useState<"list" | "json">("list"); // 列表 / JSON 视图
  const [toolSel, setToolSel] = useState<ToolInfo | null>(null); // 点开看详情的工具
  const [toolFilter, setToolFilter] = useState(""); // 工具名/描述过滤
  // 切到「工具」页时拉一次当前工具集
  useEffect(() => {
    if (tab !== "tools") return;
    window.minicc.getTools().then((r) => {
      setToolGroups(r.groups);
      setToolTotal(r.total);
    });
  }, [tab]);
  // 切到「知识网络」页时拉一次图谱 + 文档库统计，并监听建索引/概念抽取进度。
  // 关键：主进程是进度真相源——重开设置时先查一次当前状态回填，避免"关了再开状态就没了"。
  useEffect(() => {
    if (tab !== "brain") return;
    reloadBrain();
    window.minicc.brainDocStats().then((s) => {
      setDocStat(s);
      if (s.dir) setDocDir(s.dir);
    });
    // 回填：索引是否正在构建 + 向量模型是否已就绪 + 概念抽取是否在跑
    window.minicc.brainDocProgress().then((d) => {
      if (d?.building) {
        setDocBuilding(true);
        setDocProg(
          d.phase === "scan" ? `扫描到 ${d.files} 个文档，开始向量化…` : `向量化 ${d.done}/${d.total} 块…`,
        );
      }
    });
    window.minicc.brainEmbedReady().then((r) => {
      if (r) setBrainWarmMsg("✓ 向量模型就绪，语义检索已启用。");
    });
    window.minicc.brainConceptProgress().then((c) => setConExtract(c));
    const off = window.minicc.onEvent((ch, p) => {
      if (ch === "evt:brain-docs") {
        const d = p as { building?: boolean; phase: string; files?: number; total?: number; done?: number };
        if (d.phase === "scan") setDocProg(`扫描到 ${d.files} 个文档，开始向量化…`);
        else if (d.phase === "embed") setDocProg(`向量化 ${d.done}/${d.total} 块…`);
        else if (d.phase === "done") {
          setDocProg(`✓ 完成，共 ${d.total} 块`);
          setDocBuilding(false);
          window.minicc.brainDocStats().then(setDocStat);
        } else if (d.phase === "error") {
          setDocProg("✗ 构建失败");
          setDocBuilding(false);
        }
      } else if (ch === "evt:brain-concepts") {
        const c = p as { running: boolean; phase: string; total: number; done: number; created: number; cur?: string };
        setConExtract(c);
        if (!c.running) reloadBrain(); // 抽完刷新概念/关系数
      }
    });
    return off;
  }, [tab]);
  // ── 密钥管理器 ──
  type SecretRow = { id: string; name: string; envVar: string; masked: string; note?: string; createdAt: number };
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [secretsAvail, setSecretsAvail] = useState(true);
  const [secNew, setSecNew] = useState({ name: "", envVar: "", value: "", note: "" });
  const [secMore, setSecMore] = useState(false); // 展开环境变量名/备注(默认收起)
  const [secImportOpen, setSecImportOpen] = useState(false);
  const [secImportText, setSecImportText] = useState("");
  const [secErr, setSecErr] = useState("");
  // 查看明文:需输入本机账号密码解锁(退出设置即失效——本状态随弹窗卸载清空)
  const [revealed, setRevealed] = useState<Record<string, string> | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPw, setUnlockPw] = useState("");
  const [unlockErr, setUnlockErr] = useState("");
  async function doUnlock() {
    setUnlockErr("");
    const r = await window.minicc.secretsReveal(unlockPw);
    if (!r.ok) {
      setUnlockErr(r.error || "验证失败");
      return;
    }
    const map: Record<string, string> = {};
    for (const it of r.items || []) map[it.id] = it.value;
    setRevealed(map);
    setUnlockOpen(false);
    setUnlockPw("");
  }
  const reloadSecrets = () =>
    window.minicc.secretsList().then((r) => {
      setSecrets(r.entries);
      setSecretsAvail(r.available);
    });
  useEffect(() => {
    if (tab === "secrets") reloadSecrets();
  }, [tab]);
  async function addSecret() {
    setSecErr("");
    if (!secNew.value.trim()) {
      setSecErr("请填入密钥值");
      return;
    }
    const r = await window.minicc.secretsAdd({
      name: secNew.name.trim() || undefined,
      envVar: secNew.envVar.trim() || undefined,
      value: secNew.value,
      note: secNew.note.trim() || undefined,
    });
    if (!r.ok) {
      setSecErr(r.error || "添加失败");
      return;
    }
    setSecNew({ name: "", envVar: "", value: "", note: "" });
    reloadSecrets();
  }
  async function doImportEnv() {
    const r = await window.minicc.secretsImportEnv(secImportText);
    if (r.ok) {
      setSecImportText("");
      setSecImportOpen(false);
      reloadSecrets();
    } else setSecErr(r.error || "导入失败");
  }
  // 内置平台 + 中转站(合并成一份预设列表；下拉与查找都用它)
  const allPresets = [...PRESETS, ...stations.map(stationToPreset)];
  const orderedPresets = arrangePresets(allPresets, order, hidden, true);
  const preset = allPresets.find((p) => p.id === pid) ?? PRESETS[0];
  // 模型下拉：预设在前(旗舰置顶)+ 平台实时拉到的新模型(liveModels，与底栏同源)，去重
  const modelOptions = [...new Set([...(preset.models ?? []), ...(liveModels[pid] || [])])];

  // 把某平台槽里的凭证取出来填进字段(没存过就空/回退默认 baseUrl)
  function slotFields(c: Record<string, CredSlot>, id: string, p: Preset) {
    const slot = c[id] || {};
    return {
      apiKey: slot.apiKey || "",
      // 固定端点的平台始终用预设 baseUrl，忽略旧存值(避免端点迁移后残留旧地址连不上)
      baseUrl: p.fixedBaseUrl ? p.baseUrl : slot.baseUrl || p.baseUrl,
      oauthToken: slot.oauthToken || "",
      nickname: slot.nickname || "",
      systemPrompt: slot.systemPrompt, // string=有专属覆盖 / undefined=跟随全局
    };
  }

  useEffect(() => {
    window.minicc.getMemory().then((m) => setMemory(m || ""));
    window.minicc.getMcp().then((r) => {
      const mig = migrateMcpDefaults(r?.config || "");
      setMcpConfig(mig.text);
      setMcpStatus(r?.status || []);
      if (mig.changed) {
        window.minicc.setMcp(mig.text); // 自动把旧占位补默认值→重连(sqlite等直接可用)
        setTimeout(() => window.minicc.getMcp().then((x) => setMcpStatus(x?.status || [])), 2800);
      }
    });
  }, []);
  const reloadMcpStatus = () => window.minicc.getMcp().then((r) => setMcpStatus(r?.status || []));
  // 写回 MCP 配置(标准 {mcpServers}) + 重连 + 稍后刷新状态
  function writeMcp(servers: Record<string, McpServer>) {
    const text = JSON.stringify({ mcpServers: servers }, null, 2);
    setMcpConfig(text);
    mcpTouchedRef.current = false;
    window.minicc.setMcp(text);
    setMcpStatus((s) => s.map((x) => ({ ...x, status: "connecting" }))); // 乐观置连接中
    setTimeout(reloadMcpStatus, 2800);
  }
  function mcpToggle(name: string) {
    const servers = parseMcpServers(mcpConfig);
    if (!servers[name]) return;
    servers[name] = { ...servers[name], disabled: !servers[name].disabled };
    writeMcp(servers);
  }
  function mcpRemove(name: string) {
    const servers = parseMcpServers(mcpConfig);
    delete servers[name];
    writeMcp(servers);
  }
  function mcpInstall(c: { name: string; command: string; args: string[]; env?: Record<string, string> }) {
    const servers = parseMcpServers(mcpConfig);
    servers[c.name] = { command: c.command, args: c.args, ...(c.env ? { env: c.env } : {}) };
    writeMcp(servers);
    // 有占位需填→自动展开就地编辑表单
    if (JSON.stringify(servers[c.name]).includes("<")) startEditMcp(c.name, servers[c.name]);
    else setMcpExpanded(c.name);
  }
  function startEditMcp(name: string, sv?: McpServer) {
    const s = sv || parseMcpServers(mcpConfig)[name];
    if (!s) return;
    const args = [...(s.args || [])];
    const envMap = { ...(s.env || {}) };
    // 优先用目录里定义的可配置字段(带说明)；目录里没有的服务器→回退到检测 <占位>
    const cat = MCP_CATALOG.find((c) => c.name === name);
    const fields: { label: string; hint: string; kind: "arg" | "env"; idx?: number; key?: string }[] = [];
    if (cat?.config) {
      for (const f of cat.config) {
        if ("arg" in f) fields.push({ label: f.label, hint: f.hint, kind: "arg", idx: f.arg });
        else fields.push({ label: f.label, hint: f.hint, kind: "env", key: f.env });
      }
    } else {
      args.forEach((a, i) => {
        if (a.includes("<")) fields.push({ label: "参数 " + (i + 1), hint: "", kind: "arg", idx: i });
      });
      Object.entries(envMap).forEach(([k, v]) => {
        if (String(v).includes("<")) fields.push({ label: k, hint: "", kind: "env", key: k });
      });
    }
    setMcpEdit(name);
    setMcpEditArgs(args);
    setMcpEditEnvMap(envMap);
    setMcpEditFields(fields);
    setMcpExpanded(null);
  }
  function saveEditMcp(name: string) {
    const servers = parseMcpServers(mcpConfig);
    if (!servers[name]) return;
    servers[name] = {
      ...servers[name],
      args: mcpEditArgs,
      ...(Object.keys(mcpEditEnvMap).length ? { env: mcpEditEnvMap } : {}),
    };
    writeMcp(servers);
    setMcpEdit(null);
  }
  // 在线搜索官方 MCP Registry（防抖 400ms，首页）
  useEffect(() => {
    if (tab !== "mcp") return;
    const q = mcpSearch.trim();
    mcpSearchRef.current = q;
    if (q.length < 2) {
      setMcpOnline([]);
      setMcpCursor("");
      setMcpSearching(false);
      return;
    }
    setMcpSearching(true);
    const t = setTimeout(() => {
      window.minicc.searchMcp(q).then((r) => {
        if (mcpSearchRef.current !== q) return; // 词已变，丢弃过期结果
        setMcpOnline(r?.results || []);
        setMcpCursor(r?.nextCursor || "");
        setMcpSearching(false);
      });
    }, 400);
    return () => clearTimeout(t);
  }, [mcpSearch, tab]);
  // 下滑翻页：加载下一页并追加
  function loadMoreMcp() {
    const q = mcpSearchRef.current;
    if (!mcpCursor || mcpLoadingMore || q.length < 2) return;
    setMcpLoadingMore(true);
    window.minicc.searchMcp(q, mcpCursor).then((r) => {
      if (mcpSearchRef.current !== q) {
        setMcpLoadingMore(false);
        return;
      }
      setMcpOnline((prev) => [...prev, ...(r?.results || [])]);
      setMcpCursor(r?.nextCursor || "");
      setMcpLoadingMore(false);
    });
  }

  useEffect(() => {
    window.minicc.getSettings().then((r) => {
      const s = r?.settings;
      if (!s) return;
      loadedRef.current = s; // 存完整 settings，保存时 spread 保留本页不管的字段
      const sts: Station[] = s.customStations || [];
      setStations(sts);
      stationsRef.current = sts;
      const ord = s.providerOrder || [];
      setOrder(ord);
      orderRef.current = ord;
      const hid = s.hiddenProviders || [];
      setHidden(hid);
      hiddenRef.current = hid;
      const pool = [...PRESETS, ...sts.map(stationToPreset)];
      const p =
        pool.find((x) => x.id === s.providerId) ??
        PRESETS.find((x) => x.kind === s.kind) ??
        PRESETS[0];
      const c: Record<string, CredSlot> = { ...(s.creds || {}) };
      // 兼容旧配置(只有顶层单套凭证)：迁移到当前平台槽
      if (!c[p.id] && (s.apiKey || s.baseUrl || s.oauthToken)) {
        c[p.id] = { apiKey: s.apiKey, baseUrl: s.baseUrl, oauthToken: s.oauthToken };
      }
      setCreds(c);
      credsRef.current = c;
      const f = slotFields(c, p.id, p);
      setPid(p.id);
      setModel(s.model || p.models[0] || "");
      setApiKey(f.apiKey);
      setBaseUrl(f.baseUrl);
      setOauthToken(f.oauthToken);
      setNickname(f.nickname);
      setPlatPromptOn(typeof f.systemPrompt === "string");
      setPlatPrompt(typeof f.systemPrompt === "string" ? f.systemPrompt : "");
      setCustomModel(p.models.length === 0 || (!!s.model && !p.models.includes(s.model)));
      // 系统提示词：有自定义(含空串)就用它+标记已改；否则显示默认模板(未改，保存时不写入=跟随默认)
      const def = r?.defaultPrompt || "";
      setSysPromptDefault(def);
      if (typeof s.systemPrompt === "string") {
        setSysPrompt(s.systemPrompt);
        setSysPromptTouched(true);
      } else {
        setSysPrompt(def);
        setSysPromptTouched(false);
      }
    });
  }, []);

  function changePreset(id: string) {
    const p = [...PRESETS, ...stationsRef.current.map(stationToPreset)].find((x) => x.id === id) ??
      PRESETS[0];
    // 先把当前平台的凭证存回它自己的槽，再从「最新」creds(ref)带出目标平台的槽
    // 用 credsRef 而非闭包 creds：否则连续切换会读到过时值→目标 key 显示空→保存把空覆盖回去
    // 展开原槽保留 avatar/webToken 等本页不管的字段(别切平台就抹掉头像/登录态)
    const merged = {
      ...credsRef.current,
      [pid]: {
        ...(credsRef.current[pid] || {}),
        apiKey,
        baseUrl,
        oauthToken,
        nickname,
        systemPrompt: platPromptOn ? platPrompt : undefined,
      },
    };
    credsRef.current = merged;
    setCreds(merged);
    const f = slotFields(merged, id, p);
    setPid(id);
    setModel(p.models[0] || "");
    setApiKey(f.apiKey);
    setBaseUrl(f.baseUrl);
    setOauthToken(f.oauthToken);
    setNickname(f.nickname);
    setPlatPromptOn(typeof f.systemPrompt === "string");
    setPlatPrompt(typeof f.systemPrompt === "string" ? f.systemPrompt : "");
    setCustomModel(p.models.length === 0);
    setShowKey(false);
    setSKeyWaiting(false); // 切平台：清掉上一个平台的 key 自动检测态
    setSKeyMsg("");
  }

  // key/token 只含可见 ASCII：清掉粘贴带进来的空白/非 ASCII 乱码字符(否则网关直接 401)
  const cleanKey = (v: string) => v.replace(/[^\x20-\x7E]/g, "").trim();

  // 测当前所选平台(可能还没生效)时给 testKey 的平台/端点/模型覆盖
  function keyOverride() {
    return {
      provider: preset.kind === "anthropic-apikey" ? "anthropic" : "openai",
      baseUrl: preset.kind === "openai" ? baseUrl.trim() || preset.baseUrl : undefined,
      model: model || undefined,
    };
  }

  // 试一个候选 key：按所选平台测连通，通了就填入+落库(不关弹窗)+内联提示成功
  async function trySettingsKey(candidate: string, silent = false): Promise<boolean> {
    const key = (candidate || "").trim();
    if (!key || sKeyTestingRef.current) return false;
    sKeyTestingRef.current = true;
    if (!silent) setSKeyMsg("检测中…");
    try {
      const res = await window.minicc.testKey(key, keyOverride());
      if (res.ok) {
        setApiKey(key);
        persist({ apiKeyOverride: key, close: false }); // 保存但不关，留在弹窗看结果
        setSKeyWaiting(false);
        setSKeyMsg("✓ API Key 已验证通过并设置完成，可直接使用（可关闭本窗）。");
        return true;
      }
      if (keyRejected(res.reason)) {
        if (!silent) setSKeyMsg("✗ Key 无效（鉴权失败）：" + res.reason);
        return false;
      }
      // Key 有效但请求未通过(余额/额度/账单等)：照样保存并提醒
      setApiKey(key);
      persist({ apiKeyOverride: key, close: false });
      setSKeyWaiting(false);
      setSKeyMsg("⚠ Key 已保存（本身有效），但请求未通过，多为账户余额/额度问题：" + res.reason);
      return true;
    } finally {
      sKeyTestingRef.current = false;
    }
  }

  // 点「去获取」：开官网 + 进入等待态(启动剪贴板自动检测)
  function startGetKey() {
    if (preset.keyUrl) window.minicc.openExternal(preset.keyUrl);
    sLastClipRef.current = "";
    setSKeyMsg("已打开获取页面：复制 API Key 后会自动填入并验证…");
    setSKeyWaiting(true);
  }

  // 等待态：轮询剪贴板，检测到像 key 的新内容就自动验证+设置
  useEffect(() => {
    if (!sKeyWaiting) return;
    const timer = setInterval(async () => {
      if (sKeyTestingRef.current) return;
      const clip = (await window.minicc.readClipboard()).trim();
      if (!clip || clip === sLastClipRef.current || !isLikelyKey(clip)) return;
      sLastClipRef.current = clip;
      setApiKey(clip);
      await trySettingsKey(clip, true);
    }, 1200);
    return () => clearInterval(timer);
  }, [sKeyWaiting]);

  // 应用内弹窗授权(自行输账号密码)
  async function claudeLoginWindow() {
    if (claudeBusy) return;
    setClaudeBusy(true);
    try {
      const tok = await window.minicc.claudeLogin();
      if (tok) {
        setOauthToken(tok);
        save(tok);
      } else alert("授权未完成（已取消/超时/失败），请重试。");
    } finally {
      setClaudeBusy(false);
    }
  }

  // 系统浏览器授权 第1步：开浏览器(复用已登录 Google)，进入等回填授权码
  async function claudeOpenBrowser() {
    await window.minicc.claudeOauthOpen();
    setSCode("");
    setSAwaitCode(true);
  }

  // 系统浏览器授权 第2步：用授权码换 token（留空则自动读剪贴板）
  async function claudeCompleteBrowser() {
    if (claudeBusy) return;
    setClaudeBusy(true);
    try {
      let code = sCode.trim();
      if (!code) code = (await window.minicc.readClipboard()).trim();
      if (!code) {
        alert("没读到授权码：请先在浏览器复制授权码，或粘贴进输入框。");
        return;
      }
      const tok = await window.minicc.claudeOauthExchange(code);
      if (tok) {
        setSAwaitCode(false);
        setOauthToken(tok);
        save(tok);
      } else alert("授权码无效或已过期，请重新点「用浏览器登录」。");
    } finally {
      setClaudeBusy(false);
    }
  }

  // 落库(可指定 key/token 覆盖，绕开 setState 异步)；close=false 时保存但不关闭弹窗
  function persist(opts?: { apiKeyOverride?: string; oauthOverride?: string; close?: boolean }) {
    const apiKind = preset.kind === "anthropic-apikey" || preset.kind === "openai";
    const prevSlot = credsRef.current[pid] || {};
    const slot: CredSlot = {
      ...prevSlot, // 保留 avatar/webToken 等本页不动的字段，别保存时抹掉头像/登录态
      // 空则回退到已存的 key/token，绝不用空把原凭证覆盖掉(防误抹)
      apiKey: apiKind
        ? cleanKey(opts?.apiKeyOverride ?? apiKey) || prevSlot.apiKey || undefined
        : undefined,
      baseUrl: preset.kind === "openai" ? baseUrl.trim() || preset.baseUrl : undefined,
      oauthToken:
        preset.kind === "anthropic-oauth"
          ? cleanKey(opts?.oauthOverride ?? oauthToken) || prevSlot.oauthToken || undefined
          : undefined,
      nickname: nickname.trim() || prevSlot.nickname || undefined,
      systemPrompt: platPromptOn ? platPrompt : undefined, // 本平台专属提示词(关掉=undefined 跟随全局)
    };
    const newCreds = { ...credsRef.current, [pid]: slot }; // 存进当前平台的槽(用最新creds,别丢其它槽)
    window.minicc.setSettings({
      ...loadedRef.current, // 保留 theme / app 等本页不管的字段
      kind: preset.kind,
      providerId: pid,
      model: model || undefined,
      apiKey: slot.apiKey, // 顶层=当前生效平台的凭证(loadConfig 用)
      baseUrl: slot.baseUrl,
      oauthToken: slot.oauthToken,
      creds: newCreds,
      // 自定义过才写入(含空串=强制空提示词)；没改则留 undefined=跟随默认模板
      systemPrompt: sysPromptTouched ? sysPrompt : undefined,
      customStations: stationsRef.current, // 一并保存中转站列表，别丢
    });
    if (memoryTouchedRef.current) window.minicc.setMemory(memory); // 手动改过记忆才写盘
    if (mcpTouchedRef.current) window.minicc.setMcp(mcpConfig); // 改过 MCP 配置才写盘+重连
    if (opts?.close !== false) onClose();
  }

  // 新增中转站：校验 baseURL，落库，选中它
  function addStation() {
    const label = newStName.trim();
    let url = newStUrl.trim();
    if (!label || !url) {
      alert("请填写中转站名称和 Base URL。");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const id = "st_" + crypto.randomUUID().slice(0, 8);
    const st: Station = { id, label, baseUrl: url };
    const next = [...stationsRef.current, st];
    stationsRef.current = next;
    setStations(next);
    setNewStName("");
    setNewStUrl("");
    // 直接切到新站(带出空槽)，并持久化列表
    const merged = { ...credsRef.current, [pid]: { apiKey, baseUrl, oauthToken, nickname } };
    credsRef.current = merged;
    setCreds(merged);
    setPid(id);
    setModel("");
    setApiKey("");
    setBaseUrl(url);
    setOauthToken("");
    setNickname("");
    setCustomModel(true);
    setShowKey(false);
    setShowAddStation(false); // 关闭添加弹窗
    void persistStationsOnly(next); // 持久化中转站列表
  }

  // 只更新 customStations(不动当前平台选择/凭证)——增删站用
  async function persistStationsOnly(next: Station[]) {
    const r = await window.minicc.getSettings();
    const s = r?.settings || {};
    window.minicc.setSettings({ ...s, customStations: next });
  }

  // 只更新平台顺序/隐藏(拉最新 settings 再合并，避免覆盖本页不管的字段)
  async function persistArrangement(ord: string[], hid: string[]) {
    const r = await window.minicc.getSettings();
    const s = r?.settings || {};
    window.minicc.setSettings({ ...s, providerOrder: ord, hiddenProviders: hid });
  }
  function applyOrder(ids: string[]) {
    orderRef.current = ids;
    setOrder(ids);
    loadedRef.current = { ...loadedRef.current, providerOrder: ids }; // 让随后的 save() 不回退
    void persistArrangement(ids, hiddenRef.current);
  }
  // 拖拽：把第 from 行插到第 to 行位置，得到新的全量顺序并落库
  function moveProvider(from: number, to: number) {
    const ids = arrangePresets(allPresets, orderRef.current, hiddenRef.current, true).map((p) => p.id);
    if (from < 0 || from >= ids.length || from === to) return;
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    applyOrder(ids);
  }
  // 显/隐某平台(当前选中平台不许隐藏，保证切换菜单至少留一项且不锁死自己)
  function toggleHidden(id: string) {
    if (id === pid && !hiddenRef.current.includes(id)) return;
    const set = new Set(hiddenRef.current);
    set.has(id) ? set.delete(id) : set.add(id);
    const next = [...set];
    hiddenRef.current = next;
    setHidden(next);
    loadedRef.current = { ...loadedRef.current, hiddenProviders: next };
    void persistArrangement(orderRef.current, next);
  }

  // 删除中转站
  function deleteStation(id: string) {
    const next = stationsRef.current.filter((s) => s.id !== id);
    stationsRef.current = next;
    setStations(next);
    void persistStationsOnly(next);
    if (pid === id) changePreset(PRESETS[0].id); // 删的是当前选中的→退回默认
  }
  // oauthOverride：一键授权拿到 token 后直接传入保存并关闭
  // 防呆：若被当 onClick 直接调用会收到事件对象，只认字符串，别把事件塞给 cleanKey
  function save(oauthOverride?: string) {
    persist({ oauthOverride: typeof oauthOverride === "string" ? oauthOverride : undefined, close: true });
  }

  return (
    <>
    <div className="perm-overlay">
      <div className={"settings tabbed sidenav" + (maxed ? " maxed" : "")} onClick={(e) => e.stopPropagation()}>
        {/* 左侧竖排菜单 */}
        <aside className="set-side">
          <div className="set-side-title">{t("set.title")}</div>
          <nav className="set-tabs">
          <button type="button" className={"set-tab" + (tab === "general" ? " on" : "")} onClick={() => setTab("general")}>
            {t("set.tab.general")}
          </button>
          <button type="button" className={"set-tab" + (tab === "display" ? " on" : "")} onClick={() => setTab("display")}>
            {t("set.tab.display")}
          </button>
          <button type="button" className={"set-tab" + (tab === "model" ? " on" : "")} onClick={() => setTab("model")}>
            {t("set.tab.model")}
          </button>
          <button type="button" className={"set-tab" + (tab === "platforms" ? " on" : "")} onClick={() => setTab("platforms")}>
            {t("set.tab.platforms")}
          </button>
          <button type="button" className={"set-tab" + (tab === "prompt" ? " on" : "")} onClick={() => setTab("prompt")}>
            {t("set.tab.prompt")}
          </button>
          <button type="button" className={"set-tab" + (tab === "memory" ? " on" : "")} onClick={() => setTab("memory")}>
            {t("set.tab.memory")}
          </button>
          <button type="button" className={"set-tab" + (tab === "brain" ? " on" : "")} onClick={() => setTab("brain")}>
            {t("set.tab.brain")}
          </button>
          <button type="button" className={"set-tab" + (tab === "mcp" ? " on" : "")} onClick={() => setTab("mcp")}>
            {t("set.tab.mcp")}
          </button>
          <button type="button" className={"set-tab" + (tab === "tools" ? " on" : "")} onClick={() => setTab("tools")}>
            {t("set.tab.tools")}
          </button>
          <button type="button" className={"set-tab" + (tab === "secrets" ? " on" : "")} onClick={() => setTab("secrets")}>
            {t("set.tab.secrets")}
          </button>
          </nav>
        </aside>

        {/* 右侧主区：头(窗口按钮) + 内容 + 底部保存 */}
        <div className="set-main">
          <div className="set-main-head">
            <div className="settings-winbtns">
              <button
                type="button"
                className="set-win-btn"
                title={maxed ? "还原窗口大小" : "最大化（同时把整个 minicc 窗口最大化铺满屏幕）"}
                onClick={async () => {
                  const next = !maxed;
                  setMaxed(next);
                  // 进入最大化时,把整个应用窗口也最大化——否则 96vw 弹窗只铺满小窗口、铺不满屏幕
                  if (next && !(await window.minicc.winIsMaximized?.())) window.minicc.winMaximize();
                }}
              >
                {maxed ? (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="3" y="5" width="8" height="8" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M5.5 5V3.5A1.2 1.2 0 016.7 2.3H12.5A1.2 1.2 0 0113.7 3.5V9.3A1.2 1.2 0 0112.5 10.5H11" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="2.8" y="2.8" width="10.4" height="10.4" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                )}
              </button>
              <button type="button" className="set-win-btn" title="关闭" onClick={onClose}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

        <div className="set-body">
          {/* ── 通用：会话分组 + 上下文压缩 + 账号读取 ── */}
          {tab === "general" && (
            <>
              <div className="app-set-group">语言 / Language</div>
              <div className="theme-pick" style={{ marginBottom: "16px" }}>
                {(["zh", "en"] as Lang[]).map((l) => (
                  <button
                    key={l}
                    type="button"
                    className={"theme-opt" + (lang === l ? " on" : "")}
                    onClick={() => onLang(l)}
                  >
                    {l === "zh" ? "中文" : "English"}
                  </button>
                ))}
              </div>
              <div className="app-set-group">会话分组</div>
              <div className="theme-pick" style={{ marginBottom: "6px" }}>
                {[
                  { id: "manual", label: t("set.g.manual") },
                  { id: "date", label: t("set.g.byDate") },
                  { id: "project", label: t("set.g.byProject") },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={"theme-opt" + (groupMode === m.id ? " on" : "")}
                    onClick={() => onGroupMode(m.id as any)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="app-set-hint" style={{ marginBottom: "16px" }}>
                {t("set.g.groupingHint")}
              </div>
              <div className="app-set-group">{t("set.g.compaction")}</div>
              <div className="app-set-row" style={{ cursor: "default", gap: "10px" }}>
                <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>
                  {t("set.g.keepRecent")}
                </div>
                <input
                  type="range"
                  min={4}
                  max={40}
                  step={2}
                  value={keepRecent}
                  onChange={(e) => onKeepRecent(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <div className="app-set-hint" style={{ minWidth: 40, textAlign: "right" }}>
                  {keepRecent} {t("set.g.items")}
                </div>
              </div>
              <div className="app-set-hint" style={{ marginBottom: "16px" }}>
                {t("set.g.compactionHint")}
              </div>
              <div className="app-set-group">{t("set.g.claudeSub")}</div>
              <div className="app-set-row" style={{ cursor: "default" }}>
                <div className="app-set-text">
                  <div className="app-set-label">{t("set.g.autoRead")}</div>
                  <div className="app-set-hint">{t("set.g.autoReadHint")}</div>
                </div>
              </div>
            </>
          )}

          {/* ── 外观：输出方式 + 界面主题 ── */}
          {tab === "display" && (
            <>
              <div className="app-set-group">{t("set.d.output")}</div>
              <div className="theme-pick" style={{ marginBottom: "6px" }}>
                {[
                  { id: "stream", label: t("set.d.stream") },
                  { id: "typewriter", label: t("set.d.typewriter") },
                  { id: "instant", label: t("set.d.instant") },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={"theme-opt" + (streamMode === m.id ? " on" : "")}
                    onClick={() => onStream(m.id as any, streamSpeed)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {streamMode === "typewriter" && (
                <div className="app-set-row" style={{ cursor: "default", gap: "10px" }}>
                  <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>
                    {t("set.d.typeSpeed")}
                  </div>
                  <input
                    type="range"
                    min={80}
                    max={2000}
                    step={20}
                    value={streamSpeed}
                    onChange={(e) => onStream("typewriter", Number(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <div className="app-set-hint" style={{ minWidth: 66, textAlign: "right" }}>
                    {streamSpeed} {t("set.d.cps")}
                  </div>
                </div>
              )}
              <div className="app-set-hint" style={{ marginBottom: "16px" }}>
                {t("set.d.outputHint")}
              </div>
              <div className="app-set-group">{t("set.d.theme")}</div>
              <div className="theme-pick" style={{ marginBottom: "14px" }}>
                {[
                  { id: "light", label: t("set.d.light") },
                  { id: "gold", label: t("set.d.gold") },
                ].map((th) => (
                  <button
                    key={th.id}
                    type="button"
                    className={"theme-opt theme-" + th.id + (uiTheme === th.id ? " on" : "")}
                    onClick={() => pickTheme(th.id)}
                  >
                    <span className="theme-sw" />
                    {th.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {/* ── 板块一：模型（选平台 / 打通模型 / 填凭证）── */}
          {tab === "model" && (
            <>
              <label className="field">
                <span>{t("set.m.platform")}</span>
                <select value={pid} onChange={(e) => changePreset(e.target.value)}>
                  {orderedPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* 中转站：一个小按钮弹独立对话框添加；选中自定义站时可删除 */}
              <div className="station-bar">
                <button
                  type="button"
                  className="station-add-btn"
                  onClick={() => {
                    setNewStName("");
                    setNewStUrl("");
                    setShowAddStation(true);
                  }}
                >
                  {t("set.m.addStation")}
                </button>
                {preset.custom && (
                  <button type="button" className="station-del" onClick={() => deleteStation(pid)}>
                    {t("set.m.delete")}「{preset.label.replace(/（中转）$/, "")}」
                  </button>
                )}
              </div>

              <label className="field">
                <span>{t("set.m.model")}</span>
                {modelOptions.length > 0 && !customModel ? (
                  <select
                    value={model}
                    onChange={(e) => {
                      if (e.target.value === "__custom__") {
                        setCustomModel(true);
                        setModel("");
                      } else {
                        setModel(e.target.value);
                      }
                    }}
                  >
                    {modelOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    <option value="__custom__">{t("set.m.custom")}</option>
                  </select>
                ) : (
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={t("set.m.modelPlaceholder")}
                  />
                )}
              </label>
              {preset.modelLabels?.[model] && <p className="model-sub">{preset.modelLabels[model]}</p>}

              {(preset.kind === "anthropic-apikey" || preset.kind === "openai") && preset.keyUrl && (
                <div className="key-guide">
                  {t("set.m.noKey")}
                  <a onClick={startGetKey}>
                    {lang === "zh" ? `去 ${preset.label} 官网获取（复制后自动填入验证）↗` : `Get one from ${preset.label} ↗`}
                  </a>
                  <span className="key-steps">{t("set.m.getKeySteps")}</span>
                  {(sKeyWaiting || sKeyMsg) && (
                    <p className={"skey-msg" + (sKeyMsg.startsWith("✓") ? " ok" : sKeyMsg.startsWith("✗") ? " err" : "")}>
                      {sKeyMsg}
                      {sKeyWaiting && (
                        <button
                          type="button"
                          className="link-inline"
                          onClick={() => trySettingsKey(apiKey)}
                        >
                          {t("set.m.verifyNow")}
                        </button>
                      )}
                    </p>
                  )}
                </div>
              )}

              {preset.note && <p className="s-note">{preset.note}</p>}

              {preset.kind === "anthropic-oauth" && (
                <>
                  {sAwaitCode ? (
                    <>
                      <p className="s-note">{t("set.m.oauthCodeHint")}</p>
                      <div className="key-wrap">
                        <input
                          value={sCode}
                          onChange={(e) => setSCode(e.target.value)}
                          placeholder={t("set.m.pasteCode")}
                        />
                      </div>
                      <button
                        type="button"
                        className="allow oauth-login-btn"
                        onClick={claudeCompleteBrowser}
                        disabled={claudeBusy}
                      >
                        {claudeBusy ? t("set.m.verifying") : t("set.m.completeAuth")}
                      </button>
                      <p className="s-note">
                        <a className="link-inline" onClick={() => !claudeBusy && setSAwaitCode(false)}>
                          {t("set.m.back")}
                        </a>
                      </p>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="allow oauth-login-btn"
                        onClick={claudeOpenBrowser}
                        disabled={claudeBusy}
                      >
                        {t("set.m.authBrowser")}
                      </button>
                      <p className="s-note">
                        {lang === "zh"
                          ? "用系统默认浏览器打开授权页，可直接选已登录的 Google 账号，登录并点“同意”后，复制授权码回来完成（走订阅额度，不额外计费）。"
                          : "Opens the authorization page in your default browser; pick your signed-in Google account, click “Allow”, then copy the code back (uses your subscription quota, no extra charge)."}
                        <a className="link-inline" onClick={() => !claudeBusy && claudeLoginWindow()}>
                          {t("set.m.useInApp")}
                        </a>
                      </p>
                    </>
                  )}
                  {/* OAuth Token 由授权流程自动填入；授权前不显示、授权后只读展示——避免用户误把授权码填进来 */}
                  {oauthToken ? (
                    <label className="field">
                      <span>{t("set.m.oauthToken")}</span>
                      <div className="key-wrap">
                        <input type={showKey ? "text" : "password"} value={oauthToken} readOnly />
                        <button
                          type="button"
                          className="eye-btn"
                          onClick={() => setShowKey((v) => !v)}
                          title={showKey ? t("set.m.hide") : t("set.m.show")}
                        >
                          <EyeIcon off={showKey} />
                        </button>
                      </div>
                    </label>
                  ) : null}
                </>
              )}

              {preset.kind === "codex" && (
                <>
                  <button
                    type="button"
                    className="allow oauth-login-btn"
                    disabled={sCodexBusy}
                    onClick={async () => {
                      setSCodexBusy(true);
                      try {
                        const ok = await window.minicc.codexLogin();
                        if (ok) onClose();
                        else alert(lang === "zh" ? "Codex 授权未完成（取消/超时/端口 1455 被占）。" : "Codex authorization failed (canceled/timeout/port 1455 busy).");
                      } finally {
                        setSCodexBusy(false);
                      }
                    }}
                  >
                    {sCodexBusy ? t("set.m.codexAuthing") : t("set.m.codexAuth")}
                  </button>
                  <p className="s-note">
                    {lang === "zh"
                      ? "用系统默认浏览器打开 ChatGPT 登录（走本地回环，无需安装 codex CLI）。登录并同意后自动回来完成，授权写入本机 ~/.codex，可直接对话（走订阅额度）。"
                      : "Opens ChatGPT login in your default browser (local loopback, no codex CLI needed). After you sign in and allow, it completes automatically and writes to ~/.codex — ready to chat (uses your subscription quota)."}
                  </p>
                </>
              )}

              {(preset.kind === "anthropic-apikey" || preset.kind === "openai") && !preset.hosted && (
                <label className="field">
                  <span>{t("set.m.apiKey")}</span>
                  <div className="key-wrap">
                    <input
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={preset.keyHint}
                    />
                    <button
                      type="button"
                      className="eye-btn"
                      onClick={() => setShowKey((v) => !v)}
                      title={showKey ? "隐藏" : "显示"}
                    >
                      <EyeIcon off={showKey} />
                    </button>
                  </div>
                </label>
              )}

              {!preset.fixedBaseUrl && (
                <label className="field">
                  <span>Base URL</span>
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://localhost:8000/v1"
                  />
                </label>
              )}

            </>
          )}

          {/* ── 板块二：平台管理（拖拽排序 + 显隐，即时保存）── */}
          {tab === "platforms" && (
            <>
              <p className="prov-manage-hint">{t("set.p.hint")}</p>
              <div className="prov-list">
                {orderedPresets.map((p, i) => {
                  const isHidden = hidden.includes(p.id);
                  const lockOn = p.id === pid && !isHidden; // 当前平台不可隐藏
                  return (
                    <div
                      key={p.id}
                      className={
                        "prov-row" +
                        (isHidden ? " off" : "") +
                        (dragOverIdx === i ? " dragover" : "")
                      }
                      draggable
                      onDragStart={() => {
                        dragIdxRef.current = i;
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragOverIdx !== i) setDragOverIdx(i);
                      }}
                      onDragEnd={() => {
                        setDragOverIdx(-1);
                        dragIdxRef.current = -1;
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = dragIdxRef.current;
                        if (from >= 0 && from !== i) moveProvider(from, i);
                        setDragOverIdx(-1);
                        dragIdxRef.current = -1;
                      }}
                    >
                      <span className="prov-grip" title={t("set.p.dragSort")}>
                        ⋮⋮
                      </span>
                      <span className="prov-name">{p.label}</span>
                      <button
                        type="button"
                        className="prov-eye"
                        disabled={lockOn}
                        title={lockOn ? t("set.p.lockOn") : isHidden ? t("set.p.hiddenClickShow") : t("set.p.clickHide")}
                        onClick={() => toggleHidden(p.id)}
                      >
                        <EyeIcon off={isHidden} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── 板块三：系统提示词（全局默认 + 每平台可覆盖）── */}
          {tab === "prompt" && (
            <div className="prompt-pane">
              <label className="field pp-grow">
                <span>
                  {t("set.pr.globalPrompt")}
                  {sysPromptTouched ? t("set.pr.customized") : t("set.pr.default")}
                </span>
                <textarea
                  className="sysprompt-area pp-fill"
                  value={sysPrompt}
                  onChange={(e) => {
                    setSysPrompt(e.target.value);
                    setSysPromptTouched(true);
                  }}
                  placeholder={t("set.pr.emptyHint")}
                />
              </label>
              <p className="s-note pp-fixed">
                {lang === "zh" ? "发给模型的第一段指令。" : "The first instruction sent to the model. "}
                <code>{"{model}"}</code>
                {lang === "zh" ? " = 当前型号，" : " = current model, "}
                <code>{"{cwd}"}</code>
                {lang === "zh" ? " = 工作目录，会自动替换。" : " = working dir; replaced automatically. "}
                {sysPromptTouched && (
                  <button
                    type="button"
                    className="link-inline"
                    onClick={() => {
                      setSysPrompt(sysPromptDefault);
                      setSysPromptTouched(false);
                    }}
                  >
                    {t("set.pr.restore")}
                  </button>
                )}
              </p>

              {/* 每平台覆盖：勾选后本平台用单独的提示词，不影响其它平台 */}
              <label className="prov-override-toggle pp-fixed">
                <input
                  type="checkbox"
                  checked={platPromptOn}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setPlatPromptOn(on);
                    // 首次开启且为空：用当前全局做起点，方便改
                    if (on && !platPrompt) setPlatPrompt(sysPromptTouched ? sysPrompt : sysPromptDefault);
                  }}
                />
                <span>
                  {lang === "zh"
                    ? `为当前平台「${preset.label}」单独设置（覆盖全局）`
                    : `Override for “${preset.label}” (this provider only)`}
                </span>
              </label>
              {platPromptOn && (
                <label className="field pp-grow">
                  <span>「{preset.label}」{t("set.pr.overrideLabelSuffix")}</span>
                  <textarea
                    className="sysprompt-area pp-fill"
                    value={platPrompt}
                    onChange={(e) => setPlatPrompt(e.target.value)}
                    placeholder={t("set.pr.overridePlaceholder")}
                  />
                </label>
              )}
            </div>
          )}

          {/* ── 板块四：记忆（全局长期记忆，注入每次对话）── */}
          {tab === "memory" && (
            <div className="prompt-pane">
              <label className="field pp-grow">
                <span>{t("set.mem.global")}</span>
                <textarea
                  className="sysprompt-area pp-fill"
                  value={memory}
                  onChange={(e) => {
                    setMemory(e.target.value);
                    memoryTouchedRef.current = true;
                  }}
                  placeholder={t("set.mem.placeholder")}
                />
              </label>
              <p className="s-note pp-fixed">
                {lang === "zh"
                  ? "你对模型说「记住…」时它会自动往这里追加；也可在此手动增删。保存后下一条消息即生效。存于 "
                  : "When you tell the model “remember…”, it appends here; you can also edit manually. Takes effect on the next message. Stored at "}
                <code>~/.wuwei/memory.md</code>。
              </p>
            </div>
          )}

          {/* ── 板块 · 知识网络 Brain（概念图谱：查看/检索/编辑）── */}
          {tab === "brain" &&
            (() => {
              const q = brainFilter.trim().toLowerCase();
              const filteredNodes = q
                ? brainNodes.filter(
                    (n) =>
                      n.name.toLowerCase().includes(q) ||
                      n.type.toLowerCase().includes(q) ||
                      n.summary.toLowerCase().includes(q) ||
                      n.aliases.some((a) => a.toLowerCase().includes(q)),
                  )
                : brainNodes;
              const sorted = [...filteredNodes].sort((a, b) => b.weight - a.weight);
              const nodeName = (id: string) => brainNodes.find((n) => n.id === id)?.name || id;
              return (
                <div className="prompt-pane" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <span className="s-note" style={{ margin: 0 }}>
                      {t("set.brain.statNodes")} <b>{brainStat.nodes}</b> · {t("set.brain.statEdges")}{" "}
                      <b>{brainStat.edges}</b> · {t("set.brain.statEmbedded")}{" "}
                      <b>{brainStat.embedded}</b>/{brainStat.nodes}
                    </span>
                    <button type="button" onClick={() => reloadBrain()}>
                      {t("set.brain.refresh")}
                    </button>
                    <button
                      type="button"
                      disabled={brainWarming}
                      onClick={async () => {
                        setBrainWarming(true);
                        setBrainWarmMsg(t("set.brain.warmLoading"));
                        const ok = await window.minicc.brainWarmup();
                        setBrainWarming(false);
                        setBrainWarmMsg(ok ? t("set.brain.warmOk") : t("set.brain.warmFail"));
                        reloadBrain();
                      }}
                    >
                      {brainWarming ? t("set.brain.warming") : t("set.brain.warmBtn")}
                    </button>
                    {brainWarmMsg && (
                      <span className="s-note" style={{ margin: 0 }}>
                        {brainWarmMsg}
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      style={{ flex: 1 }}
                      placeholder={t("set.brain.recallPlaceholder")}
                      value={brainRecallQ}
                      onChange={(e) => setBrainRecallQ(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter")
                          setBrainRecallOut((await window.minicc.brainRecall(brainRecallQ)) || t("set.brain.noHit"));
                      }}
                    />
                    <button
                      type="button"
                      onClick={async () =>
                        setBrainRecallOut((await window.minicc.brainRecall(brainRecallQ)) || t("set.brain.noHit"))
                      }
                    >
                      {t("set.brain.recall")}
                    </button>
                  </div>
                  {brainRecallOut && (
                    <pre
                      style={{
                        margin: 0,
                        maxHeight: 140,
                        overflow: "auto",
                        fontSize: 12,
                        whiteSpace: "pre-wrap",
                        opacity: 0.85,
                        background: "rgba(127,127,127,0.08)",
                        padding: 8,
                        borderRadius: 6,
                      }}
                    >
                      {brainRecallOut}
                    </pre>
                  )}

                  <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
                    {/* 左：概念列表 */}
                    <div style={{ width: 220, display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
                      <input
                        placeholder={t("set.brain.filterPlaceholder")}
                        value={brainFilter}
                        onChange={(e) => setBrainFilter(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setBrainSel(null);
                          setBrainDraft({
                            id: "",
                            name: "",
                            aliases: [],
                            type: "概念",
                            summary: "",
                            attrs: {},
                            weight: 1,
                            hits: 0,
                            createdAt: 0,
                            updatedAt: 0,
                          });
                        }}
                      >
                        {t("set.brain.newNode")}
                      </button>
                      <div style={{ overflow: "auto", flex: 1 }}>
                        {sorted.map((n) => (
                          <div
                            key={n.id}
                            onClick={() => {
                              setBrainSel(n.id);
                              setBrainDraft({ ...n, attrs: { ...n.attrs }, aliases: [...n.aliases] });
                            }}
                            style={{
                              padding: "6px 8px",
                              cursor: "pointer",
                              borderRadius: 6,
                              background: brainSel === n.id ? "rgba(127,127,127,0.18)" : "transparent",
                            }}
                          >
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{n.name}</div>
                            <div className="s-note" style={{ margin: 0 }}>
                              {n.type} · {t("set.brain.hits")}{n.hits}
                            </div>
                          </div>
                        ))}
                        {sorted.length === 0 && (
                          <div className="s-note">{t("set.brain.emptyNodes")}</div>
                        )}
                      </div>
                    </div>

                    {/* 右：详情编辑 */}
                    <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                      {!brainDraft ? (
                        <div className="s-note">{t("set.brain.selectHint")}</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <label className="field">
                            <span>{t("set.brain.fName")}</span>
                            <input
                              value={brainDraft.name}
                              onChange={(e) => setBrainDraft({ ...brainDraft, name: e.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>{t("set.brain.fType")}</span>
                            <input
                              value={brainDraft.type}
                              placeholder={t("set.brain.fTypePlaceholder")}
                              onChange={(e) => setBrainDraft({ ...brainDraft, type: e.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>{t("set.brain.fSummary")}</span>
                            <input
                              value={brainDraft.summary}
                              onChange={(e) => setBrainDraft({ ...brainDraft, summary: e.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>{t("set.brain.fAliases")}</span>
                            <input
                              value={brainDraft.aliases.join(", ")}
                              onChange={(e) =>
                                setBrainDraft({
                                  ...brainDraft,
                                  aliases: e.target.value
                                    .split(/[,，]/)
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          </label>
                          <label className="field">
                            <span>{t("set.brain.fAttrs")}</span>
                            <textarea
                              className="sysprompt-area"
                              style={{ minHeight: 90 }}
                              value={attrsToText(brainDraft.attrs)}
                              placeholder={t("set.brain.fAttrsPlaceholder")}
                              onChange={(e) => setBrainDraft({ ...brainDraft, attrs: textToAttrs(e.target.value) })}
                            />
                          </label>
                          {brainDraft.id && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <span className="s-note" style={{ margin: 0 }}>
                                {t("set.brain.relations")}
                              </span>
                              {brainEdges
                                .filter((ed) => ed.from === brainDraft.id)
                                .map((ed) => (
                                  <div key={ed.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: 13 }}>
                                      ──{ed.relation}→ {nodeName(ed.to)}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        await window.minicc.brainDeleteEdge(ed.id);
                                        reloadBrain();
                                      }}
                                    >
                                      {t("set.brain.delEdge")}
                                    </button>
                                  </div>
                                ))}
                              <div style={{ display: "flex", gap: 6 }}>
                                <input
                                  style={{ width: 110 }}
                                  placeholder={t("set.brain.relationName")}
                                  value={brainNewEdge.relation}
                                  onChange={(e) => setBrainNewEdge({ ...brainNewEdge, relation: e.target.value })}
                                />
                                <input
                                  style={{ flex: 1 }}
                                  placeholder={t("set.brain.targetNode")}
                                  value={brainNewEdge.to}
                                  onChange={(e) => setBrainNewEdge({ ...brainNewEdge, to: e.target.value })}
                                />
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (brainNewEdge.relation.trim() && brainNewEdge.to.trim()) {
                                      await window.minicc.brainAddEdge(
                                        brainDraft.name,
                                        brainNewEdge.relation.trim(),
                                        brainNewEdge.to.trim(),
                                      );
                                      setBrainNewEdge({ relation: "", to: "" });
                                      reloadBrain();
                                    }
                                  }}
                                >
                                  {t("set.brain.addEdge")}
                                </button>
                              </div>
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              type="button"
                              onClick={async () => {
                                if (!brainDraft.name.trim()) return;
                                await window.minicc.brainSaveNode({
                                  id: brainDraft.id || undefined,
                                  name: brainDraft.name.trim(),
                                  type: brainDraft.type,
                                  summary: brainDraft.summary,
                                  aliases: brainDraft.aliases,
                                  attrs: brainDraft.attrs,
                                });
                                await reloadBrain();
                                setBrainWarmMsg(t("set.brain.saved"));
                              }}
                            >
                              {t("set.brain.save")}
                            </button>
                            {brainDraft.id && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await window.minicc.brainDeleteNode(brainDraft.id);
                                  setBrainDraft(null);
                                  setBrainSel(null);
                                  reloadBrain();
                                }}
                              >
                                {t("set.brain.delNode")}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div
                    style={{
                      borderTop: "1px solid var(--border)",
                      paddingTop: 10,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <span className="s-note" style={{ margin: 0 }}>
                      {t("set.brain.docLib")}{" "}
                      <b>{docStat.chunks}</b> {t("set.brain.docChunks")} / <b>{docStat.files}</b> {t("set.brain.docFiles")}
                    </span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        style={{ flex: 1 }}
                        placeholder={t("set.brain.docDirPlaceholder")}
                        value={docDir}
                        onChange={(e) => setDocDir(e.target.value)}
                      />
                      <button
                        type="button"
                        disabled={docBuilding || conExtract?.running || !docDir.trim()}
                        onClick={async () => {
                          setDocBuilding(true);
                          setDocProg(t("set.brain.docPreparing"));
                          try {
                            const s = await window.minicc.brainBuildDocs(docDir.trim());
                            setDocStat(s);
                          } catch (e: any) {
                            setDocProg("✗ " + (e?.message || t("set.brain.docBuildFail")));
                          } finally {
                            setDocBuilding(false);
                          }
                        }}
                      >
                        {docBuilding ? t("set.brain.docBuilding") : docStat.chunks > 0 ? t("set.brain.docRebuild") : t("set.brain.docBuild")}
                      </button>
                    </div>
                    {docProg && (
                      <span className="s-note" style={{ margin: 0 }}>
                        {docProg}
                      </span>
                    )}
                    {/* 概念抽取：用当前对话模型(k3)从已索引文档批量抽概念+关系填进 graph。按文档级调用，省 token；可停。 */}
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        disabled={docStat.files === 0 || conExtract?.running}
                        title={t("set.brain.extractNewTitle")}
                        onClick={async () => {
                          const r = await window.minicc.brainExtractConcepts({ all: false });
                          if (!r.started) setBrainWarmMsg("✗ " + (r.reason || t("set.brain.extractFail")));
                        }}
                      >
                        {conExtract?.running ? t("set.brain.extracting") : t("set.brain.extractNew")}
                      </button>
                      <button
                        type="button"
                        disabled={docStat.files === 0 || conExtract?.running}
                        title={t("set.brain.extractAllTitle")}
                        onClick={async () => {
                          const r = await window.minicc.brainExtractConcepts({ all: true });
                          if (!r.started) setBrainWarmMsg("✗ " + (r.reason || t("set.brain.extractFail")));
                        }}
                      >
                        {t("set.brain.extractAll")}
                      </button>
                      {conExtract?.running && (
                        <button type="button" className="allow" onClick={() => window.minicc.brainStopConcepts()}>
                          {t("set.brain.stop")}
                        </button>
                      )}
                      {conExtract && (conExtract.running || conExtract.phase === "done" || conExtract.phase === "stopped") && (
                        <span className="s-note" style={{ margin: 0 }}>
                          {conExtract.running
                            ? `${t("set.brain.exRunning")} ${conExtract.done}/${conExtract.total} ${t("set.brain.exDocs")} · ${t("set.brain.exGen")} ${conExtract.created} ${t("set.brain.exConcepts")}${conExtract.cur ? " · " + conExtract.cur : ""}`
                            : conExtract.phase === "stopped"
                              ? `${t("set.brain.exStopped")} (${conExtract.done}/${conExtract.total} ${t("set.brain.exDocs")}, ${conExtract.created} ${t("set.brain.exConcepts")})`
                              : `${t("set.brain.exDone")} · ${t("set.brain.exTotalGen")} ${conExtract.created} ${t("set.brain.exConcepts")}`}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="s-note pp-fixed">
                    {t("set.brain.footStored")} <code>~/.wuwei/brain/graph.json</code>, {t("set.brain.footModels")}{" "}
                    <code>~/.wuwei/brain/models</code>. {t("set.brain.footDesc")}
                  </p>
                </div>
              );
            })()}

          {/* ── 板块五：MCP 服务器管理（列表/搜索/安装/启停/删除）── */}
          {tab === "mcp" &&
            (() => {
              const servers = parseMcpServers(mcpConfig);
              const names = Object.keys(servers);
              const q = mcpSearch.trim().toLowerCase();
              const statusOf = (n: string) => mcpStatus.find((s) => s.name === n);
              const matchServer = (n: string) => {
                if (!q) return true;
                const st = statusOf(n);
                return (
                  n.toLowerCase().includes(q) ||
                  (st?.toolInfos || []).some(
                    (t) => t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q),
                  )
                );
              };
              return (
                <div className="mcp-pane">
                  <input
                    className="mcp-search"
                    placeholder={t("set.mcp.search")}
                    value={mcpSearch}
                    onChange={(e) => setMcpSearch(e.target.value)}
                  />
                  <div
                    className="mcp-scroll"
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 90) loadMoreMcp();
                    }}
                  >
                    <div className="mcp-sec">{t("set.mcp.configured")}（{names.length}）</div>
                    {names.length === 0 && <div className="mcp-empty">{t("set.mcp.empty")}</div>}
                    {names.filter(matchServer).map((n) => {
                      const sv = servers[n];
                      const st = statusOf(n);
                      const badge = sv.disabled ? "disabled" : st?.status || "connecting";
                      const tools = st?.toolInfos || [];
                      return (
                        <div key={n} className={"mcp-card " + badge}>
                          <div className="mcp-card-head">
                            <span className={"mcp-dot " + badge} />
                            <span
                              className={"mcp-name" + (badge === "ready" ? " clk" : "")}
                              onClick={() => badge === "ready" && setMcpExpanded(mcpExpanded === n ? null : n)}
                            >
                              {n}
                            </span>
                            <span
                              className={"mcp-count" + (badge === "ready" ? " clk" : "")}
                              onClick={() => badge === "ready" && setMcpExpanded(mcpExpanded === n ? null : n)}
                            >
                              {badge === "disabled"
                                ? t("set.mcp.disabled")
                                : badge === "needs-config"
                                  ? t("set.mcp.needsConfig")
                                  : badge === "ready"
                                    ? `${tools.length} ${t("set.mcp.tools")} ${mcpExpanded === n ? "▴" : "▾"}`
                                    : badge === "error"
                                      ? t("set.mcp.error")
                                      : t("set.mcp.connecting")}
                            </span>
                            <span className="mcp-actions">
                              <button
                                type="button"
                                className="mcp-btn"
                                onClick={() => (mcpEdit === n ? setMcpEdit(null) : startEditMcp(n, sv))}
                              >
                                {mcpEdit === n ? t("set.mcp.collapse") : t("set.mcp.edit")}
                              </button>
                              <button type="button" className="mcp-btn" onClick={() => mcpToggle(n)}>
                                {sv.disabled ? t("set.mcp.enable") : t("set.mcp.disable")}
                              </button>
                              <button type="button" className="mcp-btn del" onClick={() => mcpRemove(n)}>
                                {t("set.mcp.delete")}
                              </button>
                            </span>
                          </div>
                          {st?.error && (st.status === "error" || st.status === "needs-config") && (
                            <div className={"mcp-err" + (st.status === "needs-config" ? " hint" : "")}>{st.error}</div>
                          )}
                          {mcpEdit === n && (
                            <div className="mcp-editor">
                              {mcpEditFields.length === 0 && (
                                <div className="mcp-ed-none">{t("set.mcp.edNone")}</div>
                              )}
                              {mcpEditFields.map((f, fi) => {
                                const raw = f.kind === "arg" ? mcpEditArgs[f.idx!] ?? "" : mcpEditEnvMap[f.key!] ?? "";
                                const isPh = String(raw).includes("<"); // 占位=还没填
                                const val = isPh ? "" : raw; // 占位→空框(用 placeholder 灰字提示)
                                return (
                                  <div className="mcp-ed-field" key={fi}>
                                    <div className="mcp-ed-flabel">
                                      {f.label}
                                      {isPh && <span className="mcp-ed-req">{t("set.mcp.edReq")}</span>}
                                    </div>
                                    {f.hint && <div className="mcp-ed-fhint">{f.hint}</div>}
                                    <input
                                      className={"mcp-ed-input" + (isPh ? " ph" : "")}
                                      value={val}
                                      placeholder={isPh ? String(raw).replace(/[<>]/g, "") : ""}
                                      onChange={(e) => {
                                        const nv = e.target.value;
                                        if (f.kind === "arg")
                                          setMcpEditArgs((prev) => prev.map((x, i) => (i === f.idx ? nv : x)));
                                        else setMcpEditEnvMap((prev) => ({ ...prev, [f.key!]: nv }));
                                      }}
                                    />
                                  </div>
                                );
                              })}
                              <div className="mcp-ed-actions">
                                <button type="button" className="mcp-btn" onClick={() => setMcpEdit(null)}>
                                  {t("set.cancel")}
                                </button>
                                <button type="button" className="mcp-btn save" onClick={() => saveEditMcp(n)}>
                                  {t("set.mcp.saveReconnect")}
                                </button>
                              </div>
                            </div>
                          )}
                          {mcpExpanded === n && tools.length > 0 && (
                            <div className="mcp-tools">
                              {tools
                                .filter((t) => !q || t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q))
                                .map((t) => (
                                  <div key={t.name} className="mcp-tool">
                                    <code>{t.name}</code>
                                    <span>{t.description}</span>
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <div className="mcp-sec">{t("set.mcp.installable")}</div>
                    {MCP_CATALOG.filter(
                      (c) => !q || c.name.toLowerCase().includes(q) || c.label.includes(mcpSearch) || c.desc.includes(mcpSearch),
                    ).map((c) => {
                      const installed = names.includes(c.name);
                      return (
                        <div key={c.name} className="mcp-cat">
                          <div className="mcp-cat-info">
                            <span className="mcp-cat-label">
                              {c.label} <code>{c.name}</code>
                            </span>
                            <span className="mcp-cat-desc">{c.desc}</span>
                          </div>
                          <button type="button" className="mcp-btn" disabled={installed} onClick={() => mcpInstall(c)}>
                            {installed ? t("set.mcp.installed") : t("set.mcp.install")}
                          </button>
                        </div>
                      );
                    })}

                    {/* 在线库：搜索整个官方 MCP Registry */}
                    {q.length >= 2 && (
                      <>
                        <div className="mcp-sec">{t("set.mcp.online")}{mcpSearching ? t("set.mcp.searching") : ""}</div>
                        {!mcpSearching && mcpOnline.length === 0 && (
                          <div className="mcp-empty">{t("set.mcp.onlineEmpty")}</div>
                        )}
                        {mcpOnline.map((r, i) => {
                          const key = r.fullName + ":" + r.version + ":" + i;
                          const open = mcpOnlineOpen === key;
                          const installed = names.includes(r.name);
                          return (
                            <div key={key} className={"mcp-cat col" + (open ? " open" : "")}>
                              <div className="mcp-cat-row">
                                <div
                                  className="mcp-cat-info clk"
                                  onClick={() => setMcpOnlineOpen(open ? null : key)}
                                  title="点击看详情"
                                >
                                  <span className="mcp-cat-label">
                                    <code>{r.name}</code>
                                    {r.version && <span className="mcp-ver">v{r.version}</span>}
                                    <span className="mcp-more">{open ? "▴" : "▾"}</span>
                                  </span>
                                  <span className="mcp-cat-desc">{r.description}</span>
                                </div>
                                <button
                                  type="button"
                                  className="mcp-btn"
                                  disabled={installed}
                                  onClick={() => mcpInstall(r)}
                                >
                                  {installed ? t("set.mcp.installed") : t("set.mcp.install")}
                                </button>
                              </div>
                              {open && (
                                <div className="mcp-detail">
                                  <div className="mcp-d-row">
                                    <b>{t("set.mcp.dFullName")}</b>
                                    <span>{r.fullName}</span>
                                  </div>
                                  <div className="mcp-d-row">
                                    <b>{t("set.mcp.dDesc")}</b>
                                    <span>{r.description || t("set.mcp.dNone")}</span>
                                  </div>
                                  <div className="mcp-d-row">
                                    <b>{t("set.mcp.dInstall")}</b>
                                    <code>
                                      {r.command} {r.args.join(" ")}
                                    </code>
                                  </div>
                                  {r.repo && (
                                    <div className="mcp-d-row">
                                      <b>{t("set.mcp.dRepo")}</b>
                                      <a
                                        className="link-inline"
                                        onClick={() => window.minicc.openExternal(r.repo)}
                                        style={{ marginLeft: 0 }}
                                      >
                                        {r.repo}
                                      </a>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {mcpLoadingMore && <div className="mcp-empty">{t("set.mcp.loadingMore")}</div>}
                        {!mcpLoadingMore && mcpCursor && mcpOnline.length > 0 && (
                          <div className="mcp-empty mcp-loadmore" onClick={loadMoreMcp}>
                            {t("set.mcp.loadMore")}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="mcp-foot">
                    <button type="button" className="link-inline" onClick={() => setMcpRawEdit((v) => !v)}>
                      {mcpRawEdit ? "收起 JSON" : "高级：编辑 JSON"}
                    </button>
                    <span className="mcp-path">~/.wuwei/mcp.json</span>
                  </div>
                  {mcpRawEdit && (
                    <>
                      <textarea
                        className="sysprompt-area mcp-raw"
                        value={mcpConfig}
                        onChange={(e) => {
                          setMcpConfig(e.target.value);
                          mcpTouchedRef.current = true;
                        }}
                        placeholder='{ "mcpServers": { "名称": { "command": "npx", "args": ["-y", "..."] } } }'
                      />
                      <button
                        type="button"
                        className="link-inline"
                        onClick={() => {
                          window.minicc.setMcp(mcpConfig);
                          mcpTouchedRef.current = false;
                          setTimeout(reloadMcpStatus, 2800);
                        }}
                      >
                        保存并重连
                      </button>
                    </>
                  )}
                </div>
              );
            })()}

          {/* ── 板块六：工具（当前生效的全部工具，列表/JSON 视图 + 详情）── */}
          {tab === "tools" &&
            (() => {
              const q = toolFilter.trim().toLowerCase();
              const filtered = toolGroups
                .map((g) => ({
                  ...g,
                  tools: q
                    ? g.tools.filter(
                        (t) =>
                          t.name.toLowerCase().includes(q) ||
                          t.description.toLowerCase().includes(q),
                      )
                    : g.tools,
                }))
                .filter((g) => g.tools.length > 0);
              const shownTotal = filtered.reduce((n, g) => n + g.tools.length, 0);
              const badge = (kind: ToolGroup["kind"]) =>
                kind === "builtin" ? t("set.tools.badgeBuiltin") : kind === "browser" ? t("set.tools.badgeBrowser") : t("set.tools.badgeMcp");
              return (
                <div className="tools-pane">
                  <div className="tools-bar">
                    <input
                      className="mcp-search"
                      value={toolFilter}
                      onChange={(e) => setToolFilter(e.target.value)}
                      placeholder={`${t("set.tools.search")}（${toolTotal}）`}
                    />
                    <div className="tools-viewsw">
                      <button
                        type="button"
                        className={"tv-btn" + (toolView === "list" ? " on" : "")}
                        onClick={() => setToolView("list")}
                      >
                        {t("set.tools.list")}
                      </button>
                      <button
                        type="button"
                        className={"tv-btn" + (toolView === "json" ? " on" : "")}
                        onClick={() => setToolView("json")}
                      >
                        JSON
                      </button>
                    </div>
                  </div>

                  {toolView === "json" ? (
                    <pre className="tools-json">
                      {JSON.stringify(
                        filtered.map((g) => ({
                          source: g.source,
                          kind: g.kind,
                          tools: g.tools.map((t) => ({
                            name: t.name,
                            description: t.description,
                            readOnly: t.readOnly,
                            inputSchema: t.inputSchema,
                          })),
                        })),
                        null,
                        2,
                      )}
                    </pre>
                  ) : filtered.length === 0 ? (
                    <div className="mcp-empty">{t("set.tools.noMatch")}</div>
                  ) : (
                    filtered.map((g) => (
                      <div key={g.source} className="tools-group">
                        <div className="tools-group-h">
                          <span className={"tools-badge k-" + g.kind}>{badge(g.kind)}</span>
                          <span className="tools-group-name">{g.source}</span>
                          <span className="tools-group-n">{g.tools.length}</span>
                        </div>
                        {g.tools.map((t) => (
                          <button
                            key={t.name}
                            type="button"
                            className="tool-row"
                            onClick={() => setToolSel(t)}
                          >
                            <span className="tool-name">
                              {t.name}
                              {t.readOnly && <span className="tool-ro">{t("set.tools.readOnly")}</span>}
                            </span>
                            <span className="tool-desc">{t.description}</span>
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                  {toolView === "list" && (
                    <div className="tools-count">
                      {t("set.tools.showing")} {shownTotal} / {toolTotal} {t("set.tools.toolsUnit")}
                    </div>
                  )}
                </div>
              );
            })()}

          {/* ── 板块七：密钥（本地加密保险箱，统一管理敏感密钥）── */}
          {tab === "secrets" && (
            <div className="secrets-pane">
              <p className="s-note">
                {t("set.sec.note")}
                {!secretsAvail && <b style={{ color: "var(--danger, #c0392b)" }}>{t("set.sec.unavailable")}</b>}
              </p>

              <div className="sec-add">
                <div className="sec-add-row">
                  <input
                    className="sec-in"
                    placeholder={t("set.sec.namePlaceholder")}
                    value={secNew.name}
                    onChange={(e) => setSecNew({ ...secNew, name: e.target.value })}
                  />
                  <input
                    className="sec-in"
                    type="password"
                    placeholder={t("set.sec.valuePlaceholder")}
                    value={secNew.value}
                    onChange={(e) => setSecNew({ ...secNew, value: e.target.value })}
                  />
                </div>
                <button type="button" className="sec-more-toggle" onClick={() => setSecMore((v) => !v)}>
                  {secMore ? t("set.sec.collapse") : t("set.sec.expand")}
                </button>
                {secMore && (
                  <div className="sec-add-row">
                    <input
                      className="sec-in"
                      placeholder={t("set.sec.envPlaceholder")}
                      value={secNew.envVar}
                      onChange={(e) => setSecNew({ ...secNew, envVar: e.target.value })}
                    />
                    <input
                      className="sec-in"
                      placeholder={t("set.sec.notePlaceholder")}
                      value={secNew.note}
                      onChange={(e) => setSecNew({ ...secNew, note: e.target.value })}
                    />
                  </div>
                )}
                <div className="sec-add-actions">
                  <button type="button" className="allow" onClick={addSecret} disabled={!secretsAvail}>
                    {t("set.sec.add")}
                  </button>
                  <button type="button" onClick={() => setSecImportOpen((v) => !v)} disabled={!secretsAvail}>
                    {t("set.sec.importEnv")}
                  </button>
                  {secErr && <span className="sec-err">{secErr}</span>}
                </div>
                {secImportOpen && (
                  <div className="sec-import">
                    <textarea
                      className="sec-import-ta"
                      placeholder={t("set.sec.importPlaceholder")}
                      value={secImportText}
                      onChange={(e) => setSecImportText(e.target.value)}
                    />
                    <button type="button" className="allow" onClick={doImportEnv}>
                      {t("set.sec.import")}
                    </button>
                  </div>
                )}
              </div>

              {secrets.length > 0 && (
                <div className="sec-reveal-bar">
                  {revealed ? (
                    <button type="button" className="sec-reveal-btn on" onClick={() => setRevealed(null)}>
                      <svg className="sec-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                      {t("set.sec.hidePlain")}
                    </button>
                  ) : unlockOpen ? (
                    <div className="sec-unlock">
                      <input
                        type="password"
                        className="sec-in"
                        autoFocus
                        placeholder={t("set.sec.unlockPlaceholder")}
                        value={unlockPw}
                        onChange={(e) => setUnlockPw(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && doUnlock()}
                      />
                      <button type="button" className="allow" onClick={doUnlock}>
                        {t("set.sec.unlock")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setUnlockOpen(false);
                          setUnlockPw("");
                          setUnlockErr("");
                        }}
                      >
                        {t("set.cancel")}
                      </button>
                      {unlockErr && <span className="sec-err">{unlockErr}</span>}
                    </div>
                  ) : (
                    <button type="button" className="sec-reveal-btn" onClick={() => setUnlockOpen(true)}>
                      <svg className="sec-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                      {t("set.sec.revealPlain")}
                    </button>
                  )}
                </div>
              )}

              <div className="sec-list">
                {secrets.length === 0 ? (
                  <div className="mcp-empty">{t("set.sec.empty")}</div>
                ) : (
                  secrets.map((s) => (
                    <div key={s.id} className="sec-row">
                      <div className="sec-row-left">
                        <div className="sec-row-top">
                          <span className="sec-name">{s.name}</span>
                          {s.envVar && <span className="sec-env">${s.envVar}</span>}
                        </div>
                        <div className="sec-row-sub">
                          <span className={"sec-mask" + (revealed ? " revealed" : "")}>
                            {revealed && revealed[s.id] != null ? revealed[s.id] : s.masked}
                          </span>
                          {s.note && <span className="sec-row-note">· {s.note}</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="sec-del"
                        title={t("set.sec.delete")}
                        onClick={async () => {
                          await window.minicc.secretsDelete(s.id);
                          reloadSecrets();
                        }}
                      >
                        {t("set.sec.delete")}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="btns">
          <button onClick={onClose}>{t("set.cancel")}</button>
          <button className="allow" onClick={() => save()}>
            {tab === "model" ? t("set.save") : t("set.saveOnly")}
          </button>
        </div>
        </div>
      </div>
    </div>

    {/* 添加中转站：独立小弹窗，不撑爆主设置页 */}
    {showAddStation && (
      <div className="perm-overlay add-st-overlay" onClick={() => setShowAddStation(false)}>
        <div className="add-st-dialog" onClick={(e) => e.stopPropagation()}>
          <h3>添加中转站</h3>
          <label className="field">
            <span>名称</span>
            <input
              autoFocus
              value={newStName}
              onChange={(e) => setNewStName(e.target.value)}
              placeholder="如：我的便宜中转"
            />
          </label>
          <label className="field">
            <span>Base URL（OpenAI 兼容端点）</span>
            <input
              value={newStUrl}
              onChange={(e) => setNewStUrl(e.target.value)}
              placeholder="如 https://xxx.com/v1"
            />
          </label>
          <p className="s-note">
            ⚠️ 填入 key = 把 key 交给该站，请只添加你信任的中转站。添加后回上一页填 API Key。
          </p>
          <div className="btns">
            <button onClick={() => setShowAddStation(false)}>取消</button>
            <button className="allow" onClick={addStation}>
              添加
            </button>
          </div>
        </div>
      </div>
    )}

    {/* 工具详情：点某个工具弹出，看完整描述 + 入参 Schema */}
    {toolSel && (
      <div className="perm-overlay add-st-overlay" onClick={() => setToolSel(null)}>
        <div className="add-st-dialog tool-detail" onClick={(e) => e.stopPropagation()}>
          <h3>
            {toolSel.name}
            {toolSel.readOnly && <span className="tool-ro">{t("set.tools.readOnly")}</span>}
          </h3>
          <p className="s-note tool-detail-desc">{toolSel.description}</p>
          <div className="tool-detail-label">{t("set.tools.detailSchema")}</div>
          <pre className="tools-json tool-detail-schema">
            {JSON.stringify(toolSel.inputSchema, null, 2)}
          </pre>
          <div className="btns">
            <button className="allow" onClick={() => setToolSel(null)}>
              {t("set.tools.close")}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// 应用级设置弹窗(与具体平台无关的开关放这里)
function AppSettingsModal({
  onClose,
  groupMode,
  onGroupMode,
  streamMode,
  streamSpeed,
  onStream,
  keepRecent,
  onKeepRecent,
}: {
  onClose: () => void;
  groupMode: "manual" | "date" | "project";
  onGroupMode: (m: "manual" | "date" | "project") => void;
  streamMode: "typewriter" | "stream" | "instant";
  streamSpeed: number;
  onStream: (mode: "typewriter" | "stream" | "instant", speed: number) => void;
  keepRecent: number;
  onKeepRecent: (n: number) => void;
}) {
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    window.minicc.getSettings().then((r: any) => setTheme(resolveTheme(r?.settings?.theme)));
  }, []);
  // 选主题：实时预览 + 立即持久化(spread 现有 settings 只改 theme)
  async function pickTheme(t: string) {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    const r: any = await window.minicc.getSettings();
    window.minicc.setSettings({ ...(r?.settings || {}), theme: t });
  }
  return (
    <div className="perm-overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>
        <div className="app-set-group">会话分组</div>
        <div className="theme-pick" style={{ marginBottom: "6px" }}>
          {[
            { id: "manual", label: "手动分组" },
            { id: "date", label: "按日期" },
            { id: "project", label: "按项目" },
          ].map((m) => (
            <button
              key={m.id}
              type="button"
              className={"theme-opt" + (groupMode === m.id ? " on" : "")}
              onClick={() => onGroupMode(m.id as any)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="app-set-hint" style={{ marginBottom: "14px" }}>
          手动：右键会话移动/新建分组、可拖拽排序；按日期/按项目：自动分组（项目名由 AI 按会话内容归纳）。
        </div>
        <div className="app-set-group">输出方式</div>
        <div className="theme-pick" style={{ marginBottom: "6px" }}>
          {[
            { id: "stream", label: "流式（一下出）" },
            { id: "typewriter", label: "打字机（匀速）" },
            { id: "instant", label: "回完一次性" },
          ].map((m) => (
            <button
              key={m.id}
              type="button"
              className={"theme-opt" + (streamMode === m.id ? " on" : "")}
              onClick={() => onStream(m.id as any, streamSpeed)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {streamMode === "typewriter" && (
          <div className="app-set-row" style={{ cursor: "default", gap: "10px" }}>
            <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>
              打字机速度
            </div>
            <input
              type="range"
              min={80}
              max={2000}
              step={20}
              value={streamSpeed}
              onChange={(e) => onStream("typewriter", Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <div className="app-set-hint" style={{ minWidth: 66, textAlign: "right" }}>
              {streamSpeed} 字/秒
            </div>
          </div>
        )}
        <div className="app-set-hint" style={{ marginBottom: "14px" }}>
          流式=收到即刻整批显示；打字机=匀速逐字，最丝滑；回完一次性=回复期间不显示、完成后整段出。
        </div>
        <div className="app-set-group">上下文压缩</div>
        <div className="app-set-row" style={{ cursor: "default", gap: "10px" }}>
          <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>
            保留最近条数
          </div>
          <input
            type="range"
            min={4}
            max={40}
            step={2}
            value={keepRecent}
            onChange={(e) => onKeepRecent(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <div className="app-set-hint" style={{ minWidth: 40, textAlign: "right" }}>
            {keepRecent} 条
          </div>
        </div>
        <div className="app-set-hint" style={{ marginBottom: "14px" }}>
          上下文超限时，会把更早的消息总结成要点摘要、保留最近这么多条原文。数字越大越不易“失忆”，但更费上下文。
        </div>
        <div className="app-set-group">界面主题</div>
        <div className="theme-pick" style={{ marginBottom: "14px" }}>
          {[
            { id: "light", label: "白色" },
            { id: "gold", label: "淡金" },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              className={"theme-opt theme-" + t.id + (theme === t.id ? " on" : "")}
              onClick={() => pickTheme(t.id)}
            >
              <span className="theme-sw" />
              {t.label}
            </button>
          ))}
        </div>
        <div className="app-set-group">Claude 订阅</div>
        <div className="app-set-row" style={{ cursor: "default" }}>
          <div className="app-set-text">
            <div className="app-set-label">账号信息自动读取</div>
            <div className="app-set-hint">
              用户名 / 邮箱 / 套餐直接从本机 Claude Code 配置（~/.claude.json）读取，随 Claude Code
              自动保持最新，无需登录或填 token。额度（5小时/周）发消息后从响应头刷新。
            </div>
          </div>
        </div>
        <div className="btns">
          <button className="allow" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
