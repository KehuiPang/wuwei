import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WuweiMe, CatalogProviderDto } from "../../main/wuwei-auth.js";
import { getLang, setLang as persistLang, makeT, type Lang, type T } from "./i18n.js";
import { BRAND_LOGOS } from "./brandLogos.js";
import { WECHAT_CS_QR } from "./wechatCsQr.js";
import { QRCodeSVG } from "qrcode.react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { BabyAvatar, inferBabyState } from "./baby/BabyAvatar.js";
import { BabyHero } from "./baby/BabyHero.js";
import { BabyPyramid } from "./baby/BabyPyramid.js";
import * as Ic from "./baby/icons.js";

// 数字婴儿生命体征：后端 /alive/status 一次给全，界面状态卡片全靠它渲染
type BabyVitals = {
  alive?: boolean;
  age?: string;
  ticks?: number;
  energy?: number;
  mood?: string;
  happiness?: number;
  concepts?: number;
  curiosity?: number;
  activity?: string;
  wakeups?: number;
  recent?: string[];
};

// anchor：搜索定位锚点 "<消息序号>:u"(用户) / "<消息序号>:<内容块序号>"(助手)，
// 与主进程搜索索引里的锚点一一对应；渲染成 data-anchor，搜索结果点进来靠它滚到位。
type Item =
  | { type: "user"; text: string; images?: string[]; ts?: number; anchor?: string }
  | { type: "assistant"; text: string; ts?: number; usage?: UsageSnap; anchor?: string }
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
// 盖在助手消息上的用量快照；round=本轮自足值(直接读,不靠跨轮做差)
type RoundUsage = {
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
  steps: number;
  lastInput: number;
};
type UsageSnap = {
  totalInput: number;
  totalOutput: number;
  lastInput: number;
  totalCacheHit?: number;
  totalCacheMiss?: number;
  totalSteps?: number;
  round?: RoundUsage;
};
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
  discuss?: boolean;
}

// 优先级方案：高/中/低 + 艾森豪威尔四象限。weight 用于排序(大在前)，tag=徽标短标签，label=全称
const PRIO_HL = [
  { tag: "高", weight: 3, label: "高", labelEn: "High" },
  { tag: "中", weight: 2, label: "中", labelEn: "Medium" },
  { tag: "低", weight: 1, label: "低", labelEn: "Low" },
];
const PRIO_QUAD = [
  { tag: "重急", weight: 4, label: "紧急重要", labelEn: "Urgent & important" },
  { tag: "重", weight: 3, label: "不紧急重要", labelEn: "Important, not urgent" },
  { tag: "急", weight: 2, label: "紧急不重要", labelEn: "Urgent, not important" },
  { tag: "缓", weight: 1, label: "不紧急不重要", labelEn: "Neither" },
];
const PRIO_TITLE: Record<string, string> = Object.fromEntries(
  [...PRIO_HL, ...PRIO_QUAD].map((p) => [p.tag, p.label]),
);

// 图片放大预览：模块级 opener，供 ItemView(消息里的图) 调用，避免逐层传 props
let openImageLightbox: ((src: string) => void) | null = null;
// 图片右键菜单：模块级 opener（同上，消息里的图在顶层组件 ItemView 里）
let openImageMenu: ((x: number, y: number, src: string) => void) | null = null;

// 把图片(dataURL/url)复制到系统剪贴板。统一过 canvas 转 png，兼容 jpeg(剪贴板只保证 png)。
async function copyImageToClipboard(src: string): Promise<boolean> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

// 保存图片到本地(浏览器下载)。dataURL 直接可下。
function saveImage(src: string): void {
  const a = document.createElement("a");
  a.href = src;
  a.download = `wuwei-image-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// 占用条的兜底窗口：仅在主进程还没把 evt:ready 的真实 ctxWindow 送过来时用。
// 真实值来自 src/config.ts contextWindowFor()(订阅通道另有封顶)，别在这里判断模型。
const CTX_MAX = 1_000_000;

// 把持久化的 messages 还原成展示用 items
function messagesToItems(messages: any[]): Item[] {
  const items: Item[] = [];
  const toolById: Record<string, Extract<Item, { type: "tool" }>> = {};
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
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
        items.push({
          type: "user",
          text,
          images: imgs.length ? imgs : undefined,
          ts: m.ts,
          anchor: `${mi}:u`,
        });
    } else {
      for (let bi = 0; bi < m.content.length; bi++) {
        const b = m.content[bi];
        if (b.type === "text" && b.text)
          items.push({ type: "assistant", text: b.text, ts: m.ts, usage: m.usage, anchor: `${mi}:${bi}` });
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

// —— 搜索命中高亮 ——
// 用 CSS Custom Highlight API 给关键词上底色：不插 <mark>、不动 DOM 结构，
// React 之后再重渲染也不会跟它打架（老内核不支持就只留整块闪一下的兜底效果）。
const SEARCH_HL = "wuwei-search";
function clearSearchHighlight(): void {
  try {
    (CSS as any).highlights?.delete(SEARCH_HL);
  } catch {
    /* 不支持就算了 */
  }
}
// 在 root 里找出关键词的所有出现位置并高亮，返回第一处的 Range（用来滚到确切位置）
function highlightMatches(root: HTMLElement, q: string): Range | null {
  clearSearchHighlight();
  const key = (q || "").toLowerCase();
  if (!key) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = (n.nodeValue || "").toLowerCase();
    for (let p = text.indexOf(key); p >= 0; p = text.indexOf(key, p + key.length)) {
      const r = document.createRange();
      r.setStart(n, p);
      r.setEnd(n, p + key.length);
      ranges.push(r);
    }
  }
  if (!ranges.length) return null;
  try {
    const HL = (window as any).Highlight;
    if (HL && (CSS as any).highlights) (CSS as any).highlights.set(SEARCH_HL, new HL(...ranges));
  } catch {
    /* 不支持高亮 API：照样返回位置，至少能滚到点上 */
  }
  return ranges[0];
}

// 设置总目标后发给 AI 的那段工作方式约定（设置→运行模式里可改，{目标} 会被替换成你写的目标）
const DEFAULT_GOAL_PROMPT = `【这个对话的总目标】{目标}

从现在起你按这个目标自主推进，工作方式：
1. 先把目标拆成可执行的步骤列出来，不用问我要不要拆；
2. 然后自己一步步做下去，每做完一步简短报告进展，接着继续下一步，不用等我批准；
3. 能自己查资料、自己验证、自己决策的一律自己来，无关紧要的选择自己定；
4. 只有这几种情况停下来问我：需要我提供你拿不到的东西(服务器/账号/密钥/付费/线下信息)；要做删除、上线、写生产、花钱、对外发送这类不可逆或影响他人的动作；目标方向上出现分歧要我拍板；
5. 我随时可能插话补充信息，听完照做，然后继续朝目标推进；
6. 每轮结尾用一句话说清"下一步做什么"，方便自动接力。
现在开始，先给拆解方案，然后直接动手做第一步。`;
const goalPromptOf = () => localStorage.getItem("wuwei-goal-prompt") || DEFAULT_GOAL_PROMPT;

// 一沾这些就别替用户拿主意——宁可停下来等人，也不能自动替他决定
const RISKY_ASK = /删除|清空|覆盖|抹掉|销毁|上线|发布|部署|生产|正式环境|prod\b|线上|付款|支付|下单|花钱|转账|发邮件|发消息|通知(客户|用户|大家)|授权|权限|密钥|token|密码|回滚|重置|drop\s+table|truncate|rm\s+-rf|强制推送|force\s*push/i;
// 自定义红线拆成"一行一条"。**只按换行拆**，绝不再按顿号拆——
// 一行是一个完整意思(如"删除或清空任何数据、文件、数据库表、代码分支")，
// 顿号是这条意思内部的列举，拆开会把"文件"这种词变成独立关键词导致误伤。
function splitRules(rules: string): string[] {
  return (rules || "").split(/\n+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}
/** 这道题能不能超时自动替他答：内置危险词 + 用户自己写的红线，命中任一就返回 0(死等)。
 *  关键词模式下自定义红线只做"整行字面包含"匹配(描述性的行不会误伤;要按意思拦请用智能识别)。 */
function askAutoSecFor(qs: any[], sec: number, rules = ""): number {
  if (!sec || sec <= 0) return 0;
  const lines = splitRules(rules);
  for (const q of qs || []) {
    const blob = [q.question, q.header, ...(q.options || []).map((o: any) => `${o.label} ${o.description || ""}`)].join(" ");
    if (RISKY_ASK.test(blob)) return 0;
    if (lines.some((line) => blob.includes(line))) return 0;
  }
  return sec;
}
/** 命中了哪条红线：返回 {word, src}。src=builtin(内置)/custom(自定义)/smart(智能识别)。没命中返回 null。
 *  给弹窗做灰字提示用——让用户知道"为啥没自动倒计时"，好决定要不要去调红线。 */
function riskyHitOf(qs: any[], rules = ""): { word: string; src: "builtin" | "custom" | "smart" } | null {
  const lines = splitRules(rules);
  for (const q of qs || []) {
    const blob = [q.question, q.header, ...(q.options || []).map((o: any) => `${o.label} ${o.description || ""}`)].join(" ");
    const m = blob.match(RISKY_ASK);
    if (m) return { word: m[0], src: "builtin" };
    const line = lines.find((x) => blob.includes(x));
    if (line) return { word: line.length > 16 ? line.slice(0, 16) + "…" : line, src: "custom" };
  }
  return null;
}

// 从服务端报错里抠出它真正认的上下文上限（"prompt is too long: 303245 tokens > 200000 maximum"）。
// 各家订阅通道的实际窗口未必等于模型标称值(如 Claude 订阅给不到 API 的 1M)，与其在客户端猜，
// 不如报错一次就把真值学下来，回填占用条——从此显示的就是这条链路的真实上限。
function parseServerCtxLimit(raw: string): number {
  const m = (raw || "").match(/(?:prompt is too long|too many tokens)[:\s]*[\d,]+\s*tokens\s*>\s*([\d,]+)/i);
  if (m) return Number(m[1].replace(/,/g, "")) || 0;
  const m2 = (raw || "").match(/maximum context length is\s*([\d,]+)/i);
  return m2 ? Number(m2[1].replace(/,/g, "")) || 0 : 0;
}

// 把后端/SDK 的原始报错（多为英文）归纳成一句中文提示，避免把整段英文甩给用户。
// 返回值以「出错：」开头，鉴权类务必含 isAuthError 能识别的关键词（未授权/凭证），以便触发一键授权条。
function friendlyError(raw: string, t: T): string {
  const r = raw || "";
  // 无为托管网关的业务错误 → 友好文案（优先，避免被下方通用 401/429 规则吃掉）
  if (/insufficient_balance/i.test(r)) return t("err.insufficientBalance", "无为币余额不足：请点账号头像「充值」后，再使用无为托管模型。");
  if (/free_quota_exhausted/i.test(r)) return t("err.freeQuota", "免费体验次数已用完：登录即可继续使用（注册送 100 无为币）。");
  if (/free_trial_disabled/i.test(r)) return t("err.freeDisabled", "免费体验暂未开放：请登录使用，或稍后再试。");
  if (/daily_cap_reached/i.test(r)) return t("err.dailyCap", "今日免费额度已用完：明日自动恢复，登录可解锁更高额度。");
  if (/gateway_not_configured/i.test(r)) return t("err.gatewayNotConfigured", "无为托管暂不可用（服务维护中）：请稍后再试，或切换到其它模型。");
  if (/unknown_hosted_model/i.test(r)) return t("err.unknownModel", "该无为托管模型暂不可用，请换一个模型。");
  if (/upstream_error/i.test(r)) return t("err.upstream", "模型服务商暂时不可用：请稍后重试。");
  if (/gateway_error[\s\S]*(invalid_token|no_token)/i.test(r))
    return t("err.tokenExpired", "无为账号登录已过期：请重新登录后再用托管模型。");
  if (/authentication method|apiKey or authToken|x-api-key|unauthorized|\b401\b|invalid.*key|api key/i.test(r))
    return t("err.auth", "出错：当前模型未授权或缺少凭证（API Key / 订阅授权），请先完成授权。");
  // 上下文超限：必须排在限流规则之前。服务端原文常含 "exceed"，会被下面的 429 规则误吞成「触发限流」，
  // 于是用户干等半天也没用——真正的解法是开新会话或删消息。能解析出数字就把「已用/上限」摆出来。
  const ctxOver = r.match(/(?:prompt is too long|too many tokens)[:\s]*([\d,]+)\s*tokens\s*>\s*([\d,]+)/i);
  if (
    ctxOver ||
    /context[_ ](length|window|limit)|context length|model_context_window_exceeded|input length and max_tokens exceed|maximum context/i.test(r)
  ) {
    const head = t("err.ctxOverflow", "出错：这轮对话太长，超出模型的上下文上限。");
    const tip = t("err.ctxOverflowTip", "开个新对话接着做（可用「交接」把要点带过去），或删掉部分历史消息。");
    if (ctxOver) {
      const used = fmtTok(Number(ctxOver[1].replace(/,/g, "")));
      const max = fmtTok(Number(ctxOver[2].replace(/,/g, "")));
      return `${head}（${t("err.ctxUsed", "已用")} ${used} / ${t("err.ctxLimit", "上限")} ${max}）${tip}`;
    }
    return head + tip;
  }
  // 限流：去掉了原先过宽的 exceed/quota——它们把上下文超限也吞进来了，导致提示完全误导。
  if (/rate.?limit|\b429\b|too many requests|retry.?after|overloaded_error|quota/i.test(r))
    return t("err.rateLimit", "出错：请求过于频繁或额度已用尽（触发限流），请稍后再试。");
  // 长回复被中途切断（undici 的 TypeError: terminated / premature close 等）：
  // 网关已做退避重连+路由兜底，还走到这里说明确实没救回来 → 明确告诉用户「回复继续即可接着做」，别甩英文原文。
  if (/\bterminated\b|premature close|other side closed|aborted|ECONNABORTED/i.test(r))
    return t("err.interrupted", "出错：与模型的连接中断了（长回复被切断）。回复「继续」即可从中断处接着做。");
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang/i.test(r))
    return t("err.network", "出错：网络连接失败，请检查网络 / 代理后重试。");
  // 上下文超长已在上面单独处理，这里只剩真正的请求错误(模型名/参数)
  if (/\b400\b|invalid_request|bad request/i.test(r))
    return t("err.badRequest", "出错：请求有误（可能是模型名或参数不对）。");
  if (/\b5\d\d\b|server error|internal error|overloaded/i.test(r))
    return t("err.server", "出错：服务端错误或繁忙，请稍后重试。");
  // 未知错误：只取首行 + 截断，加前缀，不整段英文轰炸
  return t("err.prefix", "出错：") + (r.split("\n")[0] || r).slice(0, 120);
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

// 无为 主标·橙色 sparkle 星星（沿用初版 app 图标的四角星几何，缩放到 24 视口；
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
// 签到（未签）：日历 + 加号；已签：日历 + 对勾。线性 currentColor，无为简约风。
function CheckinIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3M12 12.2v4M10 14.2h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CheckinDoneIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3M9 14l2.2 2.2L15.5 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <circle cx="195.48" cy="150.04" r="10" fill="#C05F3C" />
    </svg>
  );
}

// ── 付费三界面 v2（定稿 2026-07-30）：共用组件 + SKU/套餐数据（朱=积分包 / 金=会员）──
function PayEnso({ size = 50 }: { size?: number }) {
  return (
    <svg className="pay-enso" viewBox="0 0 240 240" width={size} height={size} aria-hidden="true">
      <g transform="rotate(-8 120 118)">
        <path d="M152.04 193.48 A82 82 0 1 1 195.48 150.04" fill="none" stroke="#16191E" strokeWidth="9.5" strokeLinecap="round" />
        <circle cx="195.48" cy="150.04" r="7.6" fill="#C05F3C" />
      </g>
    </svg>
  );
}
function PaySpark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M8 1.4l1.5 5.1 5.1 1.5-5.1 1.5L8 14.6 6.5 9.5 1.4 8l5.1-1.5z" />
    </svg>
  );
}
function PayCloseX({ onClick }: { onClick: () => void }) {
  return (
    <button className="pay-x" aria-label={makeT(getLang())("msg.close", "关闭")} onClick={onClick}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}
function PayArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}
function PackIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
    </svg>
  );
}

// 价格显示：EN 显示美元、CN 显示人民币。仅影响展示；实收金额始终以后端按 sku 查表为准。
const money = (en: boolean, cn: number, usd: number): string => (en ? `$${usd}` : `¥${cn}`);
// 客户端(人民币)sku → 网页 Paddle 的美元 sku。英文用户走网页结账(系统浏览器)。
const EN_SKU: Record<string, string> = {
  plan_pro: "plan_pro_en",
  plan_pro_5x: "plan_plus_en",
  plan_pro_50x: "plan_max_en",
  pack_s: "pack_s_en",
  pack_m: "pack_m_en",
  pack_l: "pack_l_en",
  pack_100: "pack_test_en", // $1 测试档（海外 Paddle）
};
// sku：下单时传给后端，服务端据此查金额/币量（价格以后端为准，绝不信任客户端）。价/币量已对齐 wuwei-site coin_catalog。
type CoinPack = { sku: string; coins: number; bonus: number; price: number; priceUsd: number; desc: string; descEn: string; badge?: string; badgeEn?: string; badgeType?: "rec" | "val" };
// 积分包（按需充值，价对齐库：pack_s/m/l = ¥19/69/199 · $3.99/12.99/39.99，币量 800/3000/9000 CN=EN）。
const COIN_PACKS: CoinPack[] = [
  { sku: "pack_s", coins: 800, bonus: 0, price: 19, priceUsd: 3.99, desc: "按需充值，随用随充", descEn: "Pay as you go" },
  { sku: "pack_m", coins: 3000, bonus: 0, price: 69, priceUsd: 12.99, desc: "常用档", descEn: "Popular", badge: "推荐", badgeEn: "Recommended", badgeType: "rec" },
  { sku: "pack_l", coins: 9000, bonus: 0, price: 199, priceUsd: 39.99, desc: "高频 / 团队", descEn: "Heavy / team", badge: "最超值", badgeEn: "Best value", badgeType: "val" },
];
// 测试专用档：仅当后端 flags 含 "coinpack_test" 时展示。CN ¥1 / EN $1（海外走 Paddle pack_test_en）。
const TEST_COIN_PACK: CoinPack = { sku: "pack_100", coins: 100, bonus: 0, price: 1, priceUsd: 1, desc: "测试专用 · 小额验证", descEn: "Test · small verification", badge: "测试", badgeEn: "Test", badgeType: "val" };
// 月付阶梯（价/币量/签到 对齐库 coin_catalog）：CN plan_pro/5x/50x = ¥29/99/899；EN pro/plus/max = $6.99/19.99/199。
type ProPlan = { id: "pro" | "pro5x" | "pro50x"; sku: string; name: string; nameEn: string; price: number; priceUsd: number; unit: string; unitEn: string; coins: number; coinsEn: number; signin: number; saved: number; sub: string; subEn: string; note: string; noteEn: string; tag: string; tagEn: string; tagType: "rec" | "pop" };
// ── 思考档位（effort）──────────────────────────────────────────────
// 档位越高，模型思考越深、工具调用越多、前言越长，也就越慢越贵；降档能明显缩短单步耗时，
// 在服务端有函数时长上限时，这是「一次跑完 vs 中途被掐断」的关键开关。
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
// 认这个参数的模型：Claude 4.5 以后（含 Sonnet 4.6/5、Opus 4.5~5、Fable/Mythos）与 GPT-5 / o 系。
// 其它模型不显示选择器，免得给了个按了没反应的开关。
const EFFORT_MODELS = /claude-(opus-4-[5-9]|opus-[5-9]|sonnet-[5-9]|sonnet-4-6|fable|mythos)|gpt-5|\bo3\b|\bo4\b/i;
const EFFORT_OPTIONS: { id: Effort; zh: string; en: string; zhDesc: string; enDesc: string }[] = [
  { id: "low", zh: "快", en: "Fast", zhDesc: "最快最省，适合简单改动和问答", enDesc: "Fastest and cheapest — simple edits and Q&A" },
  { id: "medium", zh: "平衡", en: "Balanced", zhDesc: "推荐。多数任务够用，不容易超时", enDesc: "Recommended. Enough for most tasks, less likely to time out" },
  { id: "high", zh: "深入", en: "Deep", zhDesc: "复杂任务更靠谱，但明显更慢", enDesc: "Better on complex work, noticeably slower" },
  { id: "xhigh", zh: "很深", en: "Deeper", zhDesc: "长链路重构、疑难排查", enDesc: "Long refactors and hard debugging" },
  { id: "max", zh: "极致", en: "Max", zhDesc: "最强也最慢，容易触发超时", enDesc: "Strongest and slowest — prone to timeouts" },
];
function effortLabel(e: Effort, lang: string): string {
  const o = EFFORT_OPTIONS.find((x) => x.id === e);
  if (!o) return e;
  return lang === "en" ? o.en : o.zh;
}

// 订阅版模型显示名(Claude/Codex 订阅是硬编码 preset，无 catalog label)：统一格式，避免下拉里
// 一会儿 "GPT-5.6 Terra"(空格) 一会儿 "gpt-5.6-sol"(连字符) 混着显示。优先级高于 catalog label。
const MODEL_LABEL_OVERRIDES: Record<string, string> = {
  // Codex(GPT) 订阅
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  // Claude 订阅
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};

const PRO_PLANS: ProPlan[] = [
  { id: "pro", sku: "plan_pro", name: "无为 Pro", nameEn: "Wuwei Pro", price: 29, priceUsd: 6.99, unit: "/月", unitEn: "/mo", coins: 1000, coinsEn: 2000, signin: 20, saved: 0, sub: "包月托管额度 · 每日签到 20", subEn: "Monthly hosted quota · 20/day check-in", note: "", noteEn: "", tag: "入门", tagEn: "Starter", tagType: "pop" },
  { id: "pro5x", sku: "plan_pro_5x", name: "无为 Plus", nameEn: "Wuwei Plus", price: 99, priceUsd: 19.99, unit: "/月", unitEn: "/mo", coins: 5000, coinsEn: 6000, signin: 40, saved: 46, sub: "5× 额度 · 每日签到 40", subEn: "5× quota · 40/day check-in", note: "省 32%", noteEn: "Save 32%", tag: "最受欢迎", tagEn: "Most popular", tagType: "rec" },
  { id: "pro50x", sku: "plan_pro_50x", name: "无为 Max", nameEn: "Wuwei Max", price: 899, priceUsd: 199, unit: "/月", unitEn: "/mo", coins: 50000, coinsEn: 70000, signin: 100, saved: 551, sub: "50× 额度 · 每日签到 100", subEn: "50× quota · 100/day check-in", note: "省 38%", noteEn: "Save 38%", tag: "顶配", tagEn: "Top tier", tagType: "pop" },
];
const PRO_FEATS: [string, string][] = [
  ["托管额度", "不用自己配接口额度"],
  ["专属客服", "问题优先响应处理"],
  ["多任务并行", "同时跑多个会话"],
  ["脑网络记忆", "持续学习，长期记忆"],
];
const PRO_FEATS_EN: [string, string][] = [
  ["Hosted credits", "No API key needed"],
  ["Priority support", "Faster responses"],
  ["Parallel tasks", "Run multiple chats at once"],
  ["Brain memory", "Learns and remembers long-term"],
];

// ② 购买积分包（朱系）：站内选档；CN 走扫码，EN 走网页 Paddle 结账。
function CoinPackModal({ packs, onClose, onCheckout, onUpgrade, t, lang }: { packs: CoinPack[]; onClose: () => void; onCheckout: (pack: CoinPack) => void; onUpgrade: () => void; t: T; lang: Lang }) {
  const en = lang === "en";
  const [sel, setSel] = useState(() => { const i = packs.findIndex((x) => x.badgeType === "rec"); return i >= 0 ? i : 0; }); // 默认选中"推荐"档
  const p = packs[sel];
  return (
    <div className="perm-overlay pay-overlay" onClick={onClose}>
      <div className="pay-card" onClick={(e) => e.stopPropagation()}>
        <PayCloseX onClick={onClose} />
        <div className="pay-top">
          <PayEnso />
          <h2>{t("pay.coinpack.title", "购买积分包")}</h2>
          <p>{t("pay.coinpack.sub", "按需充值，用多少买多少，即充即用，永久有效")}</p>
        </div>
        <div className="pay-rows">
          {packs.map((pack, i) => (
            <button key={pack.coins} className={"pay-rw" + (i === sel ? " sel" : "")} onClick={() => setSel(i)}>
              {pack.badge && <span className={"pay-rbadge " + pack.badgeType}>{en ? pack.badgeEn : pack.badge}</span>}
              <span className="pay-rw-ic">
                <PackIcon />
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="pay-amt">
                  {pack.coins.toLocaleString()}
                  <span className="u"> {t("pay.credits", "无为币")}</span>
                </span>
                <span className="pay-desc" style={{ display: "block" }}>
                  {en ? pack.descEn : pack.desc}
                  {pack.bonus > 0 && <em> +{pack.bonus} {t("pay.bonusWord", "赠送")}</em>}
                </span>
              </span>
              <span className="pay-price">{money(en, pack.price, pack.priceUsd)}</span>
            </button>
          ))}
        </div>
        <button className="pay-cta red" onClick={() => onCheckout(p)}>
          {t("pay.coinpack.ctaPrefix", "确认购买")} {money(en, p.price, p.priceUsd)}
        </button>
        <div className="pay-cancel">
          <button onClick={onUpgrade} style={{ color: "#A97F2E", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <PaySpark size={12} /> {t("pay.coinpack.upgrade", "升级会员 · 更多优惠 →")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ③ 升级无为 Pro（金系）：档位选择 + 2×2 权益；CN 走扫码，EN 走网页 Paddle 结账。
function PlanModal({ onClose, onCheckout, t, lang }: { onClose: () => void; onCheckout: (plan: ProPlan) => void; t: T; lang: Lang }) {
  const en = lang === "en";
  const [sel, setSel] = useState<ProPlan["id"]>("pro5x");
  const selPlan = PRO_PLANS.find((x) => x.id === sel)!;
  const feats = en ? PRO_FEATS_EN : PRO_FEATS;
  return (
    <div className="perm-overlay pay-overlay" onClick={onClose}>
      <div className="pay-card plan" onClick={(e) => e.stopPropagation()}>
        <PayCloseX onClick={onClose} />
        <div className="pay-top">
          <PayEnso />
          <h2>{t("pay.plan.title", "升级无为 Pro")}</h2>
          <p>{t("pay.plan.sub", "托管额度、专属客服、多任务并行。用得越多，选越高档越划算。")}</p>
        </div>
        <div className="pay-plans">
          {PRO_PLANS.map((plan) => (
            <button key={plan.id} className={"pay-pc" + (plan.id === sel ? " sel" : "")} onClick={() => setSel(plan.id)}>
              <span className={"pay-tag " + plan.tagType}>{en ? plan.tagEn : plan.tag}</span>
              <span className="pay-pc-r1">
                <span className="pay-pc-nm">
                  <PaySpark size={13} /> {en ? plan.nameEn : plan.name}
                </span>
                <span className="pay-pc-pr">
                  {money(en, plan.price, plan.priceUsd)}
                  <span className="u">{en ? plan.unitEn : plan.unit}</span>
                </span>
              </span>
              <span className="pay-pc-r2" style={{ display: "block" }}>
                {en ? plan.subEn : plan.sub}
                {(en ? plan.noteEn : plan.note) && (
                  <>
                    {" · "}
                    <em>{en ? plan.noteEn : plan.note}</em>
                  </>
                )}
              </span>
            </button>
          ))}
        </div>
        <div className="pay-feats">
          {feats.map(([tt, ss]) => (
            <div key={tt} className="pay-f">
              <div className="pay-ft">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {tt}
              </div>
              <div className="pay-fs">{ss}</div>
            </div>
          ))}
        </div>
        <button className="pay-cta gold" onClick={() => onCheckout(selPlan)}>
          {t("pay.plan.cta", "升级 {name} ¥{p}/月").replace("{name}", en ? selPlan.nameEn : selPlan.name).replace("{p}", en ? String(selPlan.priceUsd) : String(selPlan.price))}
        </button>
        <div className="pay-fnote">
          <span className="ok">✓</span> {t("pay.plan.footAny", "随时可升级")}　<span className="ok">✓</span> {t("pay.plan.footSame", "功能权益与官网一致")}
        </div>
      </div>
    </div>
  );
}
// 付费闭环辅助
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addMonths(base: Date, n: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + n);
  return d;
}
// 占位二维码（后端下单后替换为真实收款码）
function QrPlaceholder() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" fill="#fff" />
      <g fill="#16191E">
        <rect x="6" y="6" width="26" height="26" /><rect x="12" y="12" width="14" height="14" fill="#fff" /><rect x="16" y="16" width="6" height="6" />
        <rect x="68" y="6" width="26" height="26" /><rect x="74" y="12" width="14" height="14" fill="#fff" /><rect x="78" y="16" width="6" height="6" />
        <rect x="6" y="68" width="26" height="26" /><rect x="12" y="74" width="14" height="14" fill="#fff" /><rect x="16" y="78" width="6" height="6" />
        <rect x="40" y="10" width="6" height="6" /><rect x="52" y="10" width="6" height="6" /><rect x="40" y="22" width="6" height="6" /><rect x="60" y="40" width="6" height="6" /><rect x="72" y="40" width="6" height="6" /><rect x="84" y="52" width="6" height="6" /><rect x="40" y="40" width="6" height="6" /><rect x="48" y="48" width="6" height="6" /><rect x="40" y="60" width="6" height="6" /><rect x="52" y="64" width="6" height="6" /><rect x="64" y="60" width="6" height="6" /><rect x="72" y="72" width="6" height="6" /><rect x="84" y="72" width="6" height="6" /><rect x="60" y="84" width="6" height="6" /><rect x="48" y="84" width="6" height="6" />
      </g>
    </svg>
  );
}

type PayOrder = { kind: "pack"; pack: CoinPack } | { kind: "plan"; plan: ProPlan };
// 支付宝图标：官方矢量 logo(蓝底+白色变形"支"，来源 Simple Icons)。.ico 仅 32px 高分屏会糊，用 SVG 保清晰
function AlipayMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" style={{ borderRadius: 9, flex: "0 0 auto", display: "block" }} role="img" aria-label={getLang() === "en" ? "Alipay" : "支付宝"}>
      <rect width="24" height="24" rx="4" fill="#fff" />
      <path fill="#1677FF" d="M19.695 15.07c3.426 1.158 4.203 1.22 4.203 1.22V3.846c0-2.124-1.705-3.845-3.81-3.845H3.914C1.808.001.102 1.722.102 3.846v16.31c0 2.123 1.706 3.845 3.813 3.845h16.173c2.105 0 3.81-1.722 3.81-3.845v-.157s-6.19-2.602-9.315-4.119c-2.096 2.602-4.8 4.181-7.607 4.181-4.75 0-6.361-4.19-4.112-6.949.49-.602 1.324-1.175 2.617-1.497 2.025-.502 5.247.313 8.266 1.317a16.796 16.796 0 0 0 1.341-3.302H5.781v-.952h4.799V6.975H4.77v-.953h5.81V3.591s0-.409.411-.409h2.347v2.84h5.744v.951h-5.744v1.704h4.69a19.453 19.453 0 0 1-1.986 5.06c1.424.52 2.702 1.011 3.654 1.333m-13.81-2.032c-.596.06-1.71.325-2.321.869-1.83 1.608-.735 4.55 2.968 4.55 2.151 0 4.301-1.388 5.99-3.61-2.403-1.182-4.438-2.028-6.637-1.809" />
    </svg>
  );
}
// 微信支付图标：清晰矢量微信标（用户 .ico 仅 16px 会糊，改用 SVG）
function WechatMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 48 48" style={{ borderRadius: 9, flex: "0 0 auto", display: "block" }} role="img" aria-label={getLang() === "en" ? "WeChat Pay" : "微信支付"}>
      <rect width="48" height="48" rx="12" fill="#07C160" />
      <path d="M20 12.5C12.8 12.5 7 17.2 7 23c0 3.3 1.9 6.2 4.9 8.1l-1.2 3.7 4.4-2.2c1.4.4 2.9.6 4.5.6.4 0 .9 0 1.3-.06-.3-1-.5-2-.5-3.1 0-6 5.6-10.8 12.6-10.8.5 0 1 .01 1.5.07C32.9 16.1 27 12.5 20 12.5z" fill="#fff" />
      <circle cx="15.5" cy="20.5" r="1.7" fill="#07C160" />
      <circle cx="24.5" cy="20.5" r="1.7" fill="#07C160" />
      <path d="M43 31.2c0-4.7-4.7-8.5-10.5-8.5-6.1 0-10.6 4.3-10.6 9 0 4.7 4.7 8.5 10.6 8.5 1.4 0 2.8-.2 4-.6l3.6 1.9-1-3.2c2.4-1.6 3.9-4 3.9-6.6z" fill="#fff" />
      <circle cx="29" cy="30" r="1.4" fill="#07C160" />
      <circle cx="36.5" cy="30" r="1.4" fill="#07C160" />
    </svg>
  );
}
// 下单错误码 → 用户可读文案
function payErrMsg(code?: string): string {
  const en = getLang() === "en";
  switch (code) {
    case "wechat_not_ready": return en ? "WeChat Pay coming soon — please use Alipay" : "微信支付即将开通，请先用支付宝";
    case "not_logged_in": return en ? "Session expired, please sign in again" : "登录已过期，请重新登录后再试";
    case "alipay_not_configured": return en ? "Payment not available yet, please try later" : "支付暂未开通，请稍后再试";
    case "unknown_sku": return en ? "This option isn't available for purchase" : "该档位暂不可购买";
    default: return en ? "Order failed, please retry" : "下单失败，请稍后重试";
  }
}
// 微信支付开关：微信商户尚未开通，先隐藏，只留支付宝；开通后翻成 true 即恢复。
const WECHAT_PAY_ENABLED = false;

// 客服微信号（二维码 WECHAT_CS_QR 从 ./wechatCsQr 引入，默认显示大成微信码）。
const WECHAT_CS_ID = "dacheng8803";
// 联系客服弹窗（共享）：支付遇到问题 / 账号菜单都可打开。扫码或搜号加客服微信，加不上可点「直接留言」进留言表单。
function ContactSupportModal({ onClose, onLeaveMessage, t }: { onClose: () => void; onLeaveMessage: () => void; t: T }) {
  const [copied, setCopied] = useState(false);
  const copyId = () => {
    void navigator.clipboard
      ?.writeText(WECHAT_CS_ID)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="perm-overlay pay-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div className="pay-card" onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}>
        <PayCloseX onClick={onClose} />
        <div className="pay-top" style={{ paddingBottom: 4 }}>
          <PayEnso size={44} />
          <h2>{t("pay.support.title", "联系客服")}</h2>
        </div>
        <div style={{ padding: "0 30px 28px" }}>
        {getLang() === "en" ? (
          // 英文版：海外不用微信，只给留言反馈入口
          <>
            <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 18px", lineHeight: 1.6 }}>
              Having trouble? Leave us a message and we&apos;ll reply as soon as we can.
            </p>
            <button
              onClick={onLeaveMessage}
              className="allow"
              style={{ border: "none", background: "var(--spark)", color: "#fff", fontSize: 14, fontWeight: 600, borderRadius: 10, padding: "10px 22px", cursor: "pointer" }}
            >
              Leave a message
            </button>
          </>
        ) : (
          // 中文版：客服微信二维码 + 微信号 + 加不上走留言
          <>
            <p style={{ fontSize: 12.5, color: "var(--text-dim)", margin: "0 0 14px" }}>
              {t("pay.support.hint", "遇到问题？扫码或搜索微信号，添加客服「大成」")}
            </p>
            <div
              style={{
                width: 184,
                height: 184,
                margin: "0 auto 12px",
                borderRadius: 14,
                background: "#fff",
                border: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
            >
              {WECHAT_CS_QR ? (
                <img src={WECHAT_CS_QR} alt={t("pay.support.qrAlt", "客服微信二维码")} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
              ) : (
                <span style={{ fontSize: 12, color: "#8A93A0" }}>{t("pay.support.qrAlt", "客服微信二维码")}</span>
              )}
            </div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                background: "var(--bg-soft)",
                borderRadius: 10,
                padding: "8px 12px",
                marginBottom: 14,
              }}
            >
              <span style={{ fontSize: 13, color: "var(--text)" }}>
                {t("pay.support.wechatId", "微信号")} <b style={{ letterSpacing: 0.5 }}>{WECHAT_CS_ID}</b>
              </span>
              <button
                onClick={copyId}
                style={{ border: "none", background: "var(--spark)", color: "#fff", fontSize: 12, borderRadius: 7, padding: "4px 10px", cursor: "pointer" }}
              >
                {copied ? t("pay.support.copied", "已复制") : t("pay.support.copy", "复制")}
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
              {t("pay.support.cantAddPre", "加不上微信？")}
              <span onClick={onLeaveMessage} style={{ color: "var(--spark)", cursor: "pointer", fontWeight: 600 }}>
                {t("pay.support.leaveLink", "直接留言")}
              </span>
              {t("pay.support.cantAddPost", "，客服会尽快回复你。")}
            </p>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

// 留言表单：加不上微信时走这里。留言内容 + 可粘贴图片 + 联系方式 → 提交到后端（wuwei-site 留言管理可见）。
function LeaveMessageModal({ onClose, onBack, t }: { onClose: () => void; onBack?: () => void; t: T }) {
  const [msg, setMsg] = useState("");
  const [contact, setContact] = useState("");
  const [images, setImages] = useState<string[]>([]); // data URL 缩略
  const [phase, setPhase] = useState<"edit" | "sending" | "done">("edit");
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<string | null>(null); // 点击缩略图看大图
  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (!f) continue;
        const r = new FileReader();
        r.onload = () => setImages((xs) => (xs.length >= 4 ? xs : [...xs, String(r.result)]));
        r.readAsDataURL(f);
      }
    }
  };
  const submit = async () => {
    if (!msg.trim()) return setErr(t("pay.msg.needContent", "请先填写留言内容"));
    setPhase("sending");
    setErr("");
    try {
      const r = await window.wuwei.submitSupportMessage?.({ message: msg.trim(), contact: contact.trim(), images });
      if (r?.ok) setPhase("done");
      else {
        setPhase("edit");
        setErr(r?.error || t("pay.msg.submitFail", "提交失败，请稍后重试，或直接加客服微信 {id}").replace("{id}", WECHAT_CS_ID));
      }
    } catch {
      setPhase("edit");
      setErr(t("pay.msg.submitFail", "提交失败，请稍后重试，或直接加客服微信 {id}").replace("{id}", WECHAT_CS_ID));
    }
  };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    background: "var(--bg-soft)",
    color: "var(--text)",
    borderRadius: 10,
    fontSize: 13,
    padding: "10px 12px",
    outline: "none",
  };
  return (
    <>
    <div className="perm-overlay pay-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div className="pay-card" onClick={(e) => e.stopPropagation()}>
        <PayCloseX onClick={onClose} />
        <div className="pay-top" style={{ paddingBottom: 4 }}>
          <PayEnso size={40} />
          <h2>{t("pay.msg.title", "留言反馈")}</h2>
        </div>
        <div style={{ padding: "0 30px 28px" }}>
          {phase === "done" ? (
            <div style={{ textAlign: "center", padding: "18px 0 6px" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("pay.msg.doneTitle", "✓ 留言已提交")}</div>
              <div style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.7, marginBottom: 18 }}>
                {t("pay.msg.doneDesc", "我们已收到你的留言，客服会尽快通过你留的联系方式回复你。")}
              </div>
              <button
                onClick={onClose}
                style={{ width: "100%", padding: "10px", borderRadius: 10, border: "none", background: "var(--spark)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                {t("pay.msg.done", "完成")}
              </button>
            </div>
          ) : (
            <>
              {/* 被采纳有奖：鼓励高质量反馈，后台采纳后可发无为币/会员 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--spark-soft, rgba(230,126,34,.08))", border: "1px solid var(--spark-border, rgba(230,126,34,.2))", borderRadius: 10, padding: "9px 12px", marginBottom: 12 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--spark)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto" }} aria-hidden="true">
                  <path d="M12 15l-2 5 2-1.2L14 20l-2-5" />
                  <circle cx="12" cy="9" r="6" />
                  <path d="M12 6.5l1 2 2.2.2-1.6 1.5.5 2.1L12 11.2 9.9 12.3l.5-2.1L8.8 8.7l2.2-.2z" />
                </svg>
                <span style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
                  {t("pay.msg.rewardHint", "有价值的反馈被采纳后，可获无为币或会员奖励 🎁")}
                </span>
              </div>
              <textarea
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onPaste={onPaste}
                placeholder={t("pay.msg.placeholder", "描述你遇到的问题（可直接粘贴截图）…")}
                rows={4}
                style={{ ...inputStyle, resize: "vertical", minHeight: 90, marginBottom: 10, lineHeight: 1.6 }}
              />
              {images.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                  {images.map((src, i) => (
                    <div key={i} style={{ position: "relative", width: 56, height: 56, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                      <img
                        src={src}
                        alt=""
                        onClick={() => setPreview(src)}
                        title={t("pay.msg.viewLarge", "点击查看大图")}
                        style={{ width: "100%", height: "100%", objectFit: "cover", cursor: "zoom-in" }}
                      />
                      <button
                        onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))}
                        style={{ position: "absolute", top: 1, right: 1, width: 16, height: 16, borderRadius: "50%", border: "none", background: "rgba(0,0,0,.55)", color: "#fff", fontSize: 11, lineHeight: "16px", cursor: "pointer", padding: 0 }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>{t("pay.msg.imgHint", "可在上方文本框内粘贴图片，最多 4 张")}</div>
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder={t("pay.msg.contactPlaceholder", "联系方式（微信 / 手机 / 邮箱，方便客服回复）")}
                style={{ ...inputStyle, marginBottom: 10 }}
              />
              {err && <div style={{ fontSize: 12, color: "#C0392B", marginBottom: 10, lineHeight: 1.5 }}>{err}</div>}
              <div style={{ display: "flex", gap: 10 }}>
                {onBack && (
                  <button
                    onClick={onBack}
                    style={{ flex: "0 0 auto", padding: "10px 16px", borderRadius: 10, border: "1px solid var(--border)", background: "none", color: "var(--text-dim)", fontSize: 13, cursor: "pointer" }}
                  >
                    {t("pay.msg.back", "返回")}
                  </button>
                )}
                <button
                  onClick={submit}
                  disabled={phase === "sending"}
                  style={{ flex: 1, padding: "10px", borderRadius: 10, border: "none", background: "var(--spark)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: phase === "sending" ? "default" : "pointer", opacity: phase === "sending" ? 0.7 : 1 }}
                >
                  {phase === "sending" ? t("pay.msg.sending", "提交中…") : t("pay.msg.submit", "提交留言")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
    {preview && (
      <div
        onClick={() => setPreview(null)}
        style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(0,0,0,.82)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}
      >
        <img src={preview} alt="" style={{ maxWidth: "92%", maxHeight: "92%", objectFit: "contain", borderRadius: 8, boxShadow: "0 10px 40px rgba(0,0,0,.5)" }} />
      </div>
    )}
    </>
  );
}
// 消息中心：拉取当前用户消息，分类展示（系统/奖励/活动/反馈回复），进入即标记全部已读并回传未读数给父组件更新红点。
type UserMessage = {
  id: number;
  category: string;
  title: string;
  body: string;
  reward: { kind: "coins" | "membership"; amount: number; plan?: string } | null;
  readAt: string | null;
  createdAt: string;
};
function MessageCenterModal({ onClose, onRead, lang, t }: { onClose: () => void; onRead: (unread: number) => void; lang: string; t: T }) {
  const en = lang === "en";
  const [msgs, setMsgs] = useState<UserMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  // 分类元数据：标签 + 主题色（承 VI，语义化）
  const CATS: Record<string, { zh: string; en: string; color: string }> = {
    system: { zh: "系统通知", en: "System", color: "#6B7280" },
    reward: { zh: "奖励", en: "Reward", color: "#E67E22" },
    activity: { zh: "活动", en: "Activity", color: "#3B82F6" },
    feedback: { zh: "反馈回复", en: "Feedback", color: "#10B981" },
  };
  const catLabel = (c: string) => (CATS[c] ? (en ? CATS[c].en : CATS[c].zh) : c);
  const catColor = (c: string) => CATS[c]?.color || "#6B7280";
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await window.wuwei.getMessages().catch(() => null);
      if (!alive) return;
      const list = r?.messages || [];
      setMsgs(list);
      setLoading(false);
      // 进入消息中心即视为已读：标记全部 + 通知父级清红点
      if ((r?.unread || 0) > 0) {
        window.wuwei.markMessagesRead({ all: true }).then((rr) => onRead(rr?.unread ?? 0)).catch(() => {});
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const relTime = (iso: string) => {
    const d = new Date(iso).getTime();
    if (!d) return "";
    const s = Math.floor((Date.now() - d) / 1000);
    if (s < 60) return en ? "just now" : "刚刚";
    if (s < 3600) return `${Math.floor(s / 60)}${en ? "m ago" : " 分钟前"}`;
    if (s < 86400) return `${Math.floor(s / 3600)}${en ? "h ago" : " 小时前"}`;
    if (s < 2592000) return `${Math.floor(s / 86400)}${en ? "d ago" : " 天前"}`;
    return new Date(iso).toLocaleDateString();
  };
  const rewardText = (r: NonNullable<UserMessage["reward"]>) => {
    if (r.kind === "coins") return en ? `+${r.amount} coins` : `无为币 +${r.amount}`;
    const plan = (r.plan || "Pro").replace(/^\w/, (c) => c.toUpperCase());
    return en ? `${plan} +${r.amount}d` : `${plan} 会员 +${r.amount}天`;
  };
  const cats = ["all", "system", "reward", "activity", "feedback"];
  const shown = filter === "all" ? msgs : msgs.filter((m) => m.category === filter);
  return (
    <div className="perm-overlay pay-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div className="pay-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460, width: "92%" }}>
        <PayCloseX onClick={onClose} />
        <div className="pay-top" style={{ paddingBottom: 4 }}>
          <PayEnso size={40} />
          <h2>{en ? "Message Center" : "消息中心"}</h2>
        </div>
        {/* 分类筛选 */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 30px 12px" }}>
          {cats.map((c) => {
            const active = filter === c;
            return (
              <button
                key={c}
                onClick={() => setFilter(c)}
                style={{
                  padding: "4px 12px",
                  borderRadius: 999,
                  border: `1px solid ${active ? "var(--spark)" : "var(--border)"}`,
                  background: active ? "var(--spark)" : "transparent",
                  color: active ? "#fff" : "var(--text-dim)",
                  fontSize: 12,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {c === "all" ? (en ? "All" : "全部") : catLabel(c)}
              </button>
            );
          })}
        </div>
        <div style={{ padding: "0 30px 28px", maxHeight: 440, overflowY: "auto" }}>
          {loading ? (
            <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13, padding: "40px 0" }}>{en ? "Loading…" : "加载中…"}</div>
          ) : shown.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 10, opacity: 0.6 }}>
                <path d="M4 5h16v11H7l-3 3z" />
              </svg>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{en ? "No messages yet" : "暂无消息"}</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {shown.map((m) => (
                <div
                  key={m.id}
                  style={{
                    position: "relative",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    padding: "12px 14px",
                    background: m.readAt ? "transparent" : "var(--bg-soft)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: catColor(m.category), background: catColor(m.category) + "1A", borderRadius: 6, padding: "2px 7px" }}>
                      {catLabel(m.category)}
                    </span>
                    {m.reward && (
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: "var(--spark)", borderRadius: 6, padding: "2px 7px" }}>
                        🎁 {rewardText(m.reward)}
                      </span>
                    )}
                    {!m.readAt && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#E5484D", flex: "0 0 auto" }} />}
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", flex: "0 0 auto" }}>{relTime(m.createdAt)}</span>
                  </div>
                  {m.title && <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", marginBottom: 4, lineHeight: 1.4 }}>{m.title}</div>}
                  <div style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{m.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
// 脑网络功能介绍弹窗（会员专享）：欢迎页案例卡 / 非会员点灰置脑网络菜单时弹出。
function BrainIntroModal({ onClose, onUpgrade, t }: { onClose: () => void; onUpgrade: () => void; t: T }) {
  const feats: [React.ReactNode, string, string][] = [
    [
      <><path d="M12 3a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2 3 3 0 0 0 5-2v-3.2A3.5 3.5 0 0 0 16 7a4 4 0 0 0-4-4Z" /><path d="M12 7v12" /></>,
      t("pay.brain.f1t", "持续学习 · 长期记忆"),
      t("pay.brain.f1s", "模拟人脑，把聊天里有价值的概念与经验自动沉淀进脑网络"),
    ],
    [
      <><path d="M9 12h6" /><path d="M8 8a4 4 0 0 0 0 8h1" /><path d="M16 8a4 4 0 0 1 0 8h-1" /></>,
      t("pay.brain.f2t", "跨对话自动调用"),
      t("pay.brain.f2s", "下次自动调用你的经验与记忆，不必重复交代"),
    ],
    [
      <><path d="M3 17l6-6 4 4 8-8" /><path d="M17 7h4v4" /></>,
      t("pay.brain.f3t", "越用越懂你"),
      t("pay.brain.f3s", "用得越久，脑网络越丰富，无为越理解你"),
    ],
    [
      <><path d="M6.5 8a3.5 3.5 0 1 0 0 7c2.5 0 3-2 5.5-3.5S17 8 19.5 8a3.5 3.5 0 1 1 0 7c-2.5 0-3-2-5.5-3.5S9 8 6.5 8Z" /></>,
      t("pay.brain.f4t", "突破上下文限制"),
      t("pay.brain.f4s", "记忆不受单次对话长度限制，越用你的脑网络越有价值"),
    ],
  ];
  return (
    <div className="perm-overlay pay-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div className="pay-card" onClick={(e) => e.stopPropagation()} style={{ width: 440 }}>
        <PayCloseX onClick={onClose} />
        <div className="pay-top" style={{ paddingBottom: 6 }}>
          <div style={{ margin: "0 auto 12px", width: 52, height: 52, borderRadius: 15, background: "linear-gradient(150deg,#274A63,#1E232B)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 22px -8px rgba(39,74,99,.7)" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6F9FAD" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2 3 3 0 0 0 5-2v-3.2A3.5 3.5 0 0 0 16 7a4 4 0 0 0-4-4Z" />
              <circle cx="9" cy="9" r="1" fill="#C05F3C" stroke="none" />
              <circle cx="15" cy="12" r="1" fill="#C05F3C" stroke="none" />
              <circle cx="11" cy="15" r="1" fill="#C05F3C" stroke="none" />
            </svg>
          </div>
          <h2>{t("pay.brain.title", "脑网络 · 无为的长期记忆")}</h2>
          <p>{t("pay.brain.sub", "像人脑一样持续学习你的对话，把有价值的经验沉淀下来，跨对话自动调用——用得越久，无为越懂你。")}</p>
        </div>
        <div style={{ padding: "4px 30px 20px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 18 }}>
            {feats.map(([icon, tt, ss], i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "0 0 auto", marginTop: 1 }} aria-hidden="true">
                  {icon}
                </svg>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.35 }}>{tt}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 2 }}>{ss}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: "#A97F2E", background: "rgba(201,162,75,.12)", padding: "4px 12px", borderRadius: 20, marginBottom: 14 }}>
            <PaySpark size={12} /> {t("pay.brain.membersOnly", "会员专享功能")}
          </div>
          <button
            onClick={onUpgrade}
            style={{ width: "100%", padding: "12px", borderRadius: 12, border: "none", background: "linear-gradient(135deg,#c9a24b,#a97f2e)", color: "#fff", fontSize: 14.5, fontWeight: 700, cursor: "pointer", boxShadow: "0 10px 22px -8px rgba(169,127,46,.6)" }}
          >
            {t("pay.brain.cta", "开通 Pro 解锁脑网络")}
          </button>
        </div>
      </div>
    </div>
  );
}
// 付款页（国内支付宝/微信扫码）：向后端下单拿二维码串 → 渲染真 QR → 轮询订单状态，到账自动跳成功页。
// 国外 Paddle 走托管结账(不自建卡表单)，待接 Paddle.js。
function PayCheckoutModal({ order, onClose, onPaid, onContactSupport, onNeedLogin }: { order: PayOrder; onClose: () => void; onPaid: (balance?: number, orderId?: string) => void; onContactSupport: () => void; onNeedLogin: () => void }) {
  const en = getLang() === "en";
  const [method, setMethod] = useState<"ali" | "wx">("ali");
  const isPlan = order.kind === "plan";
  const sku = order.kind === "pack" ? order.pack.sku : order.plan.sku;
  const title = order.kind === "pack" ? `${order.pack.coins.toLocaleString()} ${en ? "credits" : "无为币"}` : order.plan.name;
  const gift =
    order.kind === "pack"
      ? order.pack.bonus > 0
        ? `${en ? `+${order.pack.bonus} bonus · ${order.pack.descEn}` : `含赠送 ${order.pack.bonus} · ${order.pack.desc}`}`
        : (en ? order.pack.descEn : order.pack.desc)
      : order.plan.note
        ? `${en ? `${order.plan.subEn} · ${order.plan.noteEn}` : `${order.plan.sub} · ${order.plan.note}`}`
        : (en ? order.plan.subEn : order.plan.sub);
  const price = order.kind === "pack" ? order.pack.price : order.plan.price;
  const unit = isPlan ? (en ? order.plan.unitEn : order.plan.unit) : "";
  const methodName = method === "ali" ? "支付宝" : "微信";

  const [qr, setQr] = useState("");
  const [orderId, setOrderId] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");
  const [errDetail, setErrDetail] = useState(""); // 后端/支付宝真实报错，便于诊断
  const [reloadKey, setReloadKey] = useState(0); // 递增即重新下单，刷新二维码
  const refresh = () => setReloadKey((k) => k + 1);

  // 切支付方式 / 首次打开 / 手动刷新：向后端下单，拿二维码串
  useEffect(() => {
    let alive = true;
    setPhase("loading"); setQr(""); setOrderId(""); setErrMsg(""); setErrDetail("");
    const channel = method === "ali" ? "alipay" : "wechat";
    window.wuwei
      .payCreate(sku, channel)
      .then((r) => {
        if (!alive) return;
        // 登录失效：不在二维码框里显示死错误，直接关支付页 → 弹登录框（任何充值/升级入口统一走这）
        if (r?.error === "not_logged_in") { onNeedLogin(); return; }
        if (!r || r.error || !r.qr || !r.orderId) {
          setPhase("error"); setErrMsg(payErrMsg(r?.error)); setErrDetail(/[一-龥]/.test(r?.message || "") ? r!.message! : ""); return;
        }
        setQr(r.qr); setOrderId(r.orderId); setPhase("ready");
      })
      .catch(() => { if (alive) { setPhase("error"); setErrMsg(en ? "Network error, please retry" : "网络异常，请重试"); } });
    return () => { alive = false; };
  }, [method, sku, reloadKey]);

  // 轮询订单状态：到账即走成功页（后端会主动查单兜底 notify）
  useEffect(() => {
    if (phase !== "ready" || !orderId) return;
    let alive = true;
    const t = setInterval(async () => {
      const s = await window.wuwei.payStatus(orderId).catch(() => null);
      if (!alive || !s) return;
      if (s.status === "paid") { clearInterval(t); onPaid(s.balance, orderId); }
      else if (s.status === "failed" || s.status === "expired") { clearInterval(t); setPhase("error"); setErrMsg(en ? "Order expired, please reorder" : "订单已失效，请重新下单"); }
    }, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [phase, orderId, onPaid]);

  return (
    <div className="perm-overlay pay-overlay" onClick={onClose}>
      <div className="pay-card" onClick={(e) => e.stopPropagation()}>
        <PayCloseX onClick={onClose} />
        <div className="pay-top" style={{ paddingBottom: 8 }}>
          <PayEnso size={46} />
          <h2>{en ? "Confirm payment" : "确认支付"}</h2>
        </div>
        <div className={"paych-order" + (isPlan ? " gold" : "")}>
          <div className="paych-order-row">
            <div>
              <div className="paych-order-nm">{title}</div>
              <div className="paych-order-gift">{gift}</div>
            </div>
            <div className="paych-order-amt">
              ¥{price}
              {unit && <span className="u">{unit}</span>}
            </div>
          </div>
        </div>
        <div className="paych-sect">{en ? "Choose payment method" : "选择支付方式"}</div>
        <div className="paych-pays">
          <button className={"paych-pay" + (method === "ali" ? " sel-ali" : "")} onClick={() => setMethod("ali")}>
            <AlipayMark />
            <span className="paych-pay-nm">{en ? "Alipay" : "支付宝"}</span>
            <span className="paych-rd" />
          </button>
          {WECHAT_PAY_ENABLED && (
            <button className={"paych-pay" + (method === "wx" ? " sel-wx" : "")} onClick={() => setMethod("wx")}>
              <WechatMark />
              <span className="paych-pay-nm">{en ? "WeChat Pay" : "微信支付"}</span>
              <span className="paych-rd" />
            </button>
          )}
        </div>
        <div className="paych-qr">
          {phase === "ready" && qr ? (
            <QRCodeSVG value={qr} size={168} level="M" marginSize={2} />
          ) : phase === "error" ? (
            <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: 8, boxSizing: "border-box" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C0392B" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><circle cx="12" cy="16.4" r="0.4" fill="#C0392B" stroke="none" />
              </svg>
              <div style={{ fontSize: 11.5, color: "#C0392B", textAlign: "center", lineHeight: 1.4 }}>{errMsg}</div>
            </div>
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, boxSizing: "border-box" }}>
              {/* 朱赭品牌色转圈(复用全局 tspin 动画) */}
              <div style={{ width: 28, height: 28, borderRadius: "50%", border: "3px solid #ECEFF2", borderTopColor: "#C05F3C", animation: "tspin 0.8s linear infinite" }} />
              <div style={{ fontSize: 12, color: "#8A93A0", whiteSpace: "nowrap" }}>{en ? "Generating QR code…" : "生成支付二维码…"}</div>
            </div>
          )}
        </div>
        <div className="paych-qrtip">
          {phase === "ready" ? (
            en
              ? <>Scan with <b style={{ color: method === "ali" ? "#1677FF" : "#07C160" }}>{method === "ali" ? "Alipay" : "WeChat"}</b> to pay ¥{price} — redirects automatically once received</>
              : <>请使用 <b style={{ color: method === "ali" ? "#1677FF" : "#07C160" }}>{methodName}</b> 扫码支付 ¥{price}，到账后自动跳转</>
          ) : phase === "error" ? (
            errDetail ? <span style={{ color: "#C0392B", wordBreak: "break-all" }}>{errDetail}</span> : (en ? "Try another method or retry later" : "换个支付方式或稍后重试")
          ) : ""}
        </div>
        {phase !== "loading" && (
          <button
            type="button"
            className="paych-refresh"
            onClick={refresh}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, margin: "2px auto 0", width: "fit-content", background: "none", border: "none", color: "#8A93A0", fontSize: 12, cursor: "pointer", padding: "2px 6px" }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v5h-5" />
            </svg>
            {en ? "Refresh QR code" : "刷新二维码"}
          </button>
        )}
        <div className="paych-secure">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          {en ? <>Payment secured by <b>Alipay</b></> : <>支付安全由<b>支付宝</b>官方保障</>}
        </div>
        <div className="paych-alt">
          <button onClick={onContactSupport}>{en ? "Payment issue?" : "支付遇到问题？"}</button>
        </div>
      </div>
    </div>
  );
}

type PayResult =
  | { kind: "coin"; added: number; bonus: number; balance: number; order: string }
  | { kind: "pro"; planName: string; expire: string; giftCoins: number; signin: number; perks: string[]; saved?: number; order: string }
  | { kind: "fail" };
// 支付结果页：积分到账 / Pro 月付·年付开通 / 失败。真实由 webhook 驱动，此处按订单即时展示。
function PayResultModal({ result, onClose, onRetry }: { result: PayResult; onClose: () => void; onRetry: () => void }) {
  const en = getLang() === "en";
  return (
    <div className="perm-overlay pay-overlay" onClick={onClose}>
      <div className={"pay-card payres-card" + (result.kind === "pro" ? " pro" : "")} onClick={(e) => e.stopPropagation()}>
        <PayCloseX onClick={onClose} />
        {result.kind === "coin" && (
          <>
            <div className="payres-ico">
              <div className="payres-mark ok">
                <svg viewBox="0 0 24 24" fill="none" stroke="#3E9E6E" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </div>
              <div className="payres-ttl">{en ? "Payment successful" : "支付成功"}</div>
              <div className="payres-desc">{en ? "Credits added — enjoy Wuwei hosted models" : "无为币已到账，尽情使用无为托管模型"}</div>
            </div>
            <div className="payres-box">
              <div className="payres-b1">{en ? "Added this time" : "本次到账"}</div>
              <div className="payres-b2">
                <span className="pay-coin" /> +{result.added.toLocaleString()}
                <span className="u">{en ? "credits" : "无为币"}</span>
              </div>
              <div className="payres-b3">
                <span>{result.bonus > 0 ? (en ? `+${result.bonus} bonus` : `含赠送 ${result.bonus}`) : (en ? "instant" : "即充即用")}</span>
                <span>{en ? "Balance" : "当前余额"} <b>{result.balance.toLocaleString()}</b></span>
              </div>
            </div>
            <div className="payres-btns"><button className="payres-btn pri ok" onClick={onClose}>{en ? "Start using" : "开始使用"}</button></div>
            {result.order && <div className="payres-foot">{en ? `Order ${result.order}` : `订单号 ${result.order}`}</div>}
          </>
        )}
        {result.kind === "pro" && (
          <>
            <div className="payres-ico">
              <div className="payres-mark gold">
                <svg viewBox="0 0 24 24" fill="none" stroke="#A97F2E" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </div>
              <div className="payres-ttl">
                {en ? "Activated" : "开通成功"} <span className="payres-pill"><PaySpark size={11} /> {result.planName}</span>
              </div>
              <div className="payres-desc">
                {en ? `${result.planName} activated — enjoy all member benefits` : `${result.planName} 已开通，尊享全部会员权益`}
              </div>
            </div>
            <div className="payres-box gold">
              <div className="payres-b1">{en ? "Valid until" : "会员有效期"}</div>
              <div className="payres-b2">{en ? result.expire : `至 ${result.expire}`}</div>
              <div className="payres-b3">
                <span>{en ? `Daily check-in ${result.signin}` : `每日签到 ${result.signin}`}</span>
              </div>
            </div>
            <div className="payres-perks">
              {result.perks.map((pk) => (<span key={pk}>{pk}</span>))}
            </div>
            <div className="payres-btns"><button className="payres-btn pri gold" onClick={onClose}>{en ? "Start using" : "开始使用"}</button></div>
            <div className="payres-foot">
              {result.saved ? (en ? `Saved ¥${result.saved} · order ${result.order}` : `已省 ¥${result.saved} · 订单号 ${result.order}`) : (en ? "We'll remind you before renewal" : "到期前提醒续费")}
            </div>
          </>
        )}
        {result.kind === "fail" && (
          <>
            <div className="payres-ico">
              <div className="payres-mark err">
                <svg viewBox="0 0 24 24" fill="none" stroke="#C0483C" strokeWidth="2.6" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </div>
              <div className="payres-ttl err">{en ? "Payment not completed" : "支付未完成"}</div>
              <div className="payres-desc">{en ? "This order wasn't charged — retry or try another method" : "这笔订单没有扣款，可重新支付或换个方式"}</div>
            </div>
            <div className="payres-reason">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
              <span>{en ? "Possible causes: payment timeout, cancellation, or bank decline. If charged, you'll be refunded to the original method." : "可能原因：支付超时、主动取消或银行未通过。若已扣款，费用原路退回。"}</span>
            </div>
            <div className="payres-btns">
              <button className="payres-btn pri err" onClick={onRetry}>{en ? "Pay again" : "重新支付"}</button>
              <button className="payres-btn ghost" onClick={onRetry}>{en ? "Change method" : "更换支付方式"}</button>
            </div>
            <div className="payres-foot">{en ? "Still stuck? Contact support" : "仍有问题？联系客服"}</div>
          </>
        )}
      </div>
    </div>
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

// —— 会话右键菜单图标（统一简约线性 · currentColor · 无为 VI）——
function HandoffIcon({ size = 15 }: { size?: number }) {
  // 主干下行 → 向右分叉 → 箭头：表意「从本对话交接/分流到一个新对话」
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M7 4v6a4 4 0 0 0 4 4h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 11l3.5 3-3.5 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DoneIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DiscussIcon({ size = 15 }: { size?: number }) {
  // 带小尾巴的对话气泡 = 待讨论
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M5 5h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9l-4 3.5V15H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
function PlusIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function ReportIcon({ size = 15 }: { size?: number }) {
  // 带横线的文档 = 一键生成日报
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <rect x="5" y="4" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.5 9h7M8.5 12.5h7M8.5 16h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function RestoreSizeIcon({ size = 14 }: { size?: number }) {
  // 四角箭头回中心 = 尺寸复位(恢复默认/跟随输入框)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FoldIcon({ size = 14 }: { size?: number }) {
  // 缩小/折叠 = 一条横线（与右上角窗口最小化图标一致，简洁）
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M6 12h12" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
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

// 邮箱输入自动补全的常用后缀（国内外主流邮箱，按常用度排序）
const EMAIL_SUFFIXES = [
  "gmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "foxmail.com",
  "outlook.com",
  "hotmail.com",
  "sina.com",
  "139.com",
  "yeah.net",
];

// 应用内登录框（邮箱密码登录 / 邮箱验证码注册 / 手机验证码直登注册 / Google浏览器兜底）
// 后端契约（需 wuwei-site 实现）：
//   POST /api/auth/password    {identifier,password}     → {access_token,refresh_token,expires_at}|{error}
//   POST /api/auth/send-code   {target}                  → {ok}|{error}   (target=邮箱或手机号)
//   POST /api/auth/register    {email,code,password}     → {...tokens}|{error}
//   POST /api/auth/verify-code {target,code}             → {...tokens}|{error}  (无账号自动注册)
// 登录方式开关：手机号 / 微信后端尚未接通，先隐藏；接通后翻成 true 即恢复。
const PHONE_LOGIN_ENABLED = false;
const WECHAT_LOGIN_ENABLED = false;

// 登录激励卡（居中弹窗）：未登录发消息时先弹这张（免费顶级模型 + 注册得 100 无为币），
// 点「登录」再切到真正的登录表单。比一上来就甩登录框更干净、转化更好。
function LoginIntroModal({ lang, t, onClose, onLogin }: { lang: Lang; t: T; onClose: () => void; onLogin: () => void }) {
  const zh = lang === "zh";
  return (
    <>
      <div className="mq-overlay" onClick={onClose} />
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
        <div
          style={{
            width: 300,
            maxWidth: "90vw",
            background: "var(--bg-raised)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: "22px 22px 20px",
            boxShadow: "0 16px 44px rgba(0,0,0,.28)",
            position: "relative",
            textAlign: "center",
          }}
        >
          <button
            onClick={onClose}
            title={makeT(getLang())("msg.close", "关闭")}
            style={{ position: "absolute", top: 8, right: 10, width: 26, height: 26, background: "none", border: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: "pointer" }}
          >
            ×
          </button>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              margin: "4px auto 12px",
              background: "linear-gradient(135deg,#C87551,#A34E30)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 5px 16px rgba(192,95,60,.35)",
            }}
          >
            <GiftIcon size={22} color="#F4F6F8" />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 7, lineHeight: 1.3, letterSpacing: 0.2, color: "var(--text)" }}>
            {zh ? (
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
            {zh ? "无需自备 API Key，登录即用" : "No API key needed — just sign in"}
          </div>
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
              { k: "claude", n: "Claude" },
              { k: "gpt", n: "GPT" },
              { k: "deepseek", n: "DeepSeek" },
              { k: "kimi", n: "Kimi" },
            ].map((m) => (
              <span key={m.k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  style={{ width: 18, height: 18, borderRadius: 5, background: "#fff", boxShadow: "0 0 0 1px rgba(0,0,0,.06)", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}
                >
                  <img src={BRAND_LOGOS[m.k]} alt="" width={13} height={13} style={{ display: "block", objectFit: "contain" }} />
                </span>
                {m.n}
              </span>
            ))}
          </div>
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
            {zh ? "新用户送 100 无为币" : "New users get 100 credits"}
          </div>
          <button
            onClick={onLogin}
            style={{ width: "100%", padding: "10px", borderRadius: 10, border: "none", background: "#C05F3C", color: "#F4F6F8", fontSize: 14, fontWeight: 600, letterSpacing: 2, cursor: "pointer", boxShadow: "0 3px 12px rgba(192,95,60,.3)" }}
          >
            {t("login.signin")}
          </button>
        </div>
      </div>
    </>
  );
}

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
  // 记住登录：账号历史 + 打开时自动填最近一个账号密码
  const [accounts, setAccounts] = useState<{ email: string; password: string }[]>([]);
  const [showAcctDrop, setShowAcctDrop] = useState(false); // 账号输入下拉历史
  useEffect(() => {
    // 兼容旧 preload：新 IPC 未注入时(主进程未重启)优雅跳过，绝不因此白屏
    if (typeof window.wuwei?.rememberGet !== "function") return;
    void window.wuwei
      .rememberGet()
      .then((d) => {
        if (!d) return;
        setAccounts(d.accounts || []);
        const last = d.accounts?.find((a) => a.email === d.last) || d.accounts?.[0];
        if (last) {
          setEmail(last.email);
          setPassword(last.password || "");
        }
      })
      .catch(() => {});
  }, []);

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
    const r = await window.wuwei.wuweiSendCode(target, lang, purpose);
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
    if (mode === "email-login") res = await window.wuwei.wuweiPasswordLogin(email.trim(), password);
    // 找回密码复用 register 接口：验证码校验通过后重设密码并直接登录
    else if (mode === "email-register" || mode === "email-reset")
      res = await window.wuwei.wuweiRegister(email.trim(), code.trim(), password);
    else res = await window.wuwei.wuweiCodeLogin(phone.trim(), code.trim());
    setBusy(false);
    if (res.me) {
      // 登录/注册/改密成功且有密码 → 记住账号密码(手机验证码模式无密码不记)
      if (mode !== "phone" && password) void window.wuwei.rememberSet?.(email.trim(), password);
      onSuccess(res.me, mode === "email-register" ? "register" : mode === "email-reset" ? "reset" : "login");
    } else setErr(friendlyErr(res.error));
  }
  async function googleLogin() {
    setBusy(true);
    setErr("");
    const me = await window.wuwei.wuweiLogin();
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
            title={makeT(getLang())("msg.close", "关闭")}
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
              <div style={{ position: "relative", marginBottom: 9 }}>
                <input
                  style={{ ...inputStyle, marginBottom: 0 }}
                  placeholder={t("login.email")}
                  value={email}
                  autoComplete="off"
                  onChange={(e) => { setEmail(e.target.value); setShowAcctDrop(true); }}
                  onFocus={() => setShowAcctDrop(true)}
                  onBlur={() => setTimeout(() => setShowAcctDrop(false), 150)}
                />
                {showAcctDrop && (() => {
                  const q = email.trim().toLowerCase();
                  const list = accounts.filter((a) => !q || a.email.toLowerCase().includes(q));
                  // 常用邮箱后缀补全：输入前缀(未打 @ 或域名没打完)时，列出 前缀@常用后缀，方便快速填完整邮箱
                  const raw = email.trim();
                  const atIdx = raw.indexOf("@");
                  const local = atIdx >= 0 ? raw.slice(0, atIdx) : raw;
                  const domainPart = atIdx >= 0 ? raw.slice(atIdx + 1).toLowerCase() : "";
                  const savedSet = new Set(list.map((a) => a.email.toLowerCase()));
                  const suffixSug =
                    local && !/\s/.test(local)
                      ? EMAIL_SUFFIXES
                          .filter((d) => !domainPart || (d.startsWith(domainPart) && d !== domainPart))
                          .map((d) => `${local}@${d}`)
                          .filter((full) => !savedSet.has(full.toLowerCase()))
                      : [];
                  if (!list.length && !suffixSug.length) return null;
                  return (
                    <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, marginTop: 3, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 8px 22px rgba(0,0,0,.24)", overflow: "hidden", maxHeight: 220, overflowY: "auto" }}>
                      {list.map((a) => (
                        <div
                          key={a.email}
                          onMouseDown={(ev) => { ev.preventDefault(); setEmail(a.email); setPassword(a.password || ""); setShowAcctDrop(false); }}
                          onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-soft)")}
                          onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                          style={{ padding: "8px 11px", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.email}</span>
                          {a.password ? <span style={{ fontSize: 10.5, color: "var(--text-muted)", flex: "0 0 auto" }}>{getLang() === "en" ? "Saved" : "已记住"}</span> : null}
                        </div>
                      ))}
                      {suffixSug.map((full) => (
                        <div
                          key={full}
                          onMouseDown={(ev) => { ev.preventDefault(); setEmail(full); setShowAcctDrop(false); }}
                          onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-soft)")}
                          onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                          style={{ padding: "8px 11px", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {full.slice(0, full.indexOf("@"))}
                            <span style={{ color: "var(--spark)" }}>{full.slice(full.indexOf("@"))}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
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
                onChange={(e) => {
                  const v = e.target.value;
                  setPassword(v);
                  // 用户手动清空密码 → 忘记该账号记住的密码(账号仍保留供下拉)
                  if (v === "" && email.trim()) void window.wuwei.rememberClearPassword?.(email.trim());
                }}
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
              ? mode === "email-register"
                ? t("login.busyRegister")
                : mode === "email-reset"
                  ? t("login.busyReset")
                  : t("login.busyLogin")
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
  // AI 弹的选择框：按会话 id 存，避免「A 会话弹的框在 B 会话冒出来」。只有当前会话才直接弹 AskModal。
  const [asks, setAsks] = useState<Record<string, { id: number; questions: AskQuestion[] }>>({});
  // 非当前会话发起的 ask → 右上角通知(点击切过去/✕忽略/30s自动消失)
  const [askToasts, setAskToasts] = useState<{ askId: number; sid: string; title: string }[]>([]);
  const dropToast = (askId: number) => setAskToasts((t) => t.filter((x) => x.askId !== askId));
  const clearAsk = (sid: string) => {
    setAsks((m) => {
      if (!(sid in m)) return m;
      const n = { ...m };
      delete n[sid];
      return n;
    });
    setAskToasts((t) => t.filter((x) => x.sid !== sid));
  };
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
  const [imgMenu, setImgMenu] = useState<{ x: number; y: number; src: string } | null>(null); // 图片右键菜单
  openImageMenu = (x, y, src) => setImgMenu({ x, y, src });
  useEffect(() => {
    // 大图预览/图片菜单：Esc 关闭
    if (!lightbox && !imgMenu) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLightbox(null);
        setImgMenu(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [lightbox, imgMenu]);
  const [suggestion, setSuggestion] = useState(""); // 输入框幽灵提示：下一步动作建议(Tab 补全)
  const [interruptedSessions, setInterruptedSessions] = useState<{ id: string; title: string }[]>([]); // 上次被强杀、待恢复的任务
  // 运行模式按【会话】各记各的：manual=每步问权限；auto=自动放行权限；cont=智能继续(自动放行+跑完自己接着推进)
  const [modeBySid, setModeBySid] = useState<Record<string, "manual" | "auto" | "cont">>(() => {
    try { return JSON.parse(localStorage.getItem("wuwei-mode-by-sid") || "{}"); } catch { return {}; }
  });
  const modeRef = useRef(modeBySid);
  modeRef.current = modeBySid;
  const modeOf = (sid: string) => modeRef.current[sid] || "auto"; // 默认 auto(=旧 autoMode 默认放行权限)
  const [contN, setContN] = useState(0); // 当前会话已连续自动继续多少次
  const contBySid = useRef(new Map<string, number>()); // 计数也按会话各算各的
  const setMode = (sid: string, m: "manual" | "auto" | "cont") => {
    setModeBySid((prev) => {
      const next = { ...prev, [sid]: m };
      localStorage.setItem("wuwei-mode-by-sid", JSON.stringify(next));
      return next;
    });
    contBySid.current.set(sid, 0);
    setContN(0);
  };
  // 告诉主进程哪些会话开着智能继续：它们在后台跑完也要算下一步建议，好自己接着推进
  useEffect(() => {
    window.wuwei.setContSessions?.(Object.keys(modeBySid).filter((s) => modeBySid[s] === "cont"));
  }, [modeBySid]);
  // 「手动」模式默认藏起来(底部只留 自动/连推)，需要每步确认权限的人在设置里开
  const [showManual, setShowManual] = useState(() => localStorage.getItem("wuwei-show-manual") === "1");
  useEffect(() => {
    const onToggle = (e: any) => setShowManual(!!e.detail);
    window.addEventListener("wuwei-show-manual", onToggle);
    return () => window.removeEventListener("wuwei-show-manual", onToggle);
  }, []);
  // 安全阀都可调(设置→运行模式)：最多连推几轮、发出前留多久反悔、选择题等多少秒
  const [contMax, setContMax] = useState(() => {
    const v = localStorage.getItem("wuwei-cont-max");
    return v === null ? 30 : Math.max(0, Number(v) || 0); // 0 = 不限
  });
  const [contDelay, setContDelay] = useState(() => {
    const v = localStorage.getItem("wuwei-cont-delay");
    return v === null ? 1200 : Number(v) || 0;
  });
  const [askAutoSec, setAskAutoSec] = useState(() => {
    const v = localStorage.getItem("wuwei-ask-auto-sec");
    return v === null ? 3 : Number(v) || 0; // 0=永远等你
  });
  const [suggestWait, setSuggestWait] = useState(0); // ASK 兜底倒计时：N 秒后仍自动发这句
  // 会话总目标 + 自定义红线
  const [goal, setGoal] = useState<{ text: string; active: boolean; done?: boolean } | null>(null);
  const [goalEdit, setGoalEdit] = useState<null | { sid: string; text: string }>(null);
  const [stopRules, setStopRules] = useState("");
  // 红线识别方式:keyword=关键词匹配(快,选项提到词就拦) / smart=智能识别(LLM判是否真触发危险动作,少误伤)
  const [redlineMode, setRedlineMode] = useState<"keyword" | "smart">(() =>
    localStorage.getItem("wuwei-redline-mode") === "keyword" ? "keyword" : "smart"); // 默认智能识别(描述性红线按意思判)
  useEffect(() => {
    const on = (e: any) => setRedlineMode(e.detail === "smart" ? "smart" : "keyword");
    window.addEventListener("wuwei-redline-mode", on);
    return () => window.removeEventListener("wuwei-redline-mode", on);
  }, []);
  // 智能识别的判定结果(按 askId 存):pending=判定中,risky=危险则停,reason=危险动作说明
  const [askRisk, setAskRisk] = useState<Record<number, { pending: boolean; risky: boolean; reason: string }>>({});
  // 完整历史归档保留天数(0=永久)。启动时清理一次过期归档
  useEffect(() => {
    const v = localStorage.getItem("wuwei-transcript-days");
    window.wuwei.pruneTranscripts?.(v === null ? 30 : Math.max(0, Number(v) || 0));
  }, []);
  const contMaxRef = useRef(contMax); contMaxRef.current = contMax;
  const contDelayRef = useRef(contDelay); contDelayRef.current = contDelay;
  const askAutoSecRef = useRef(askAutoSec); askAutoSecRef.current = askAutoSec;
  const redlineModeRef = useRef(redlineMode); redlineModeRef.current = redlineMode;
  const stopRulesRef = useRef(stopRules); stopRulesRef.current = stopRules;
  const lastSuggestRef = useRef<{ text: string; canContinue: boolean; auto: boolean }>({ text: "", canContinue: false, auto: false });
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [trash, setTrash] = useState<import("./env").TrashItem[]>([]); // 回收站:软删除的会话(7天自动清)
  const [showTrash, setShowTrash] = useState(false);
  // —— 全局搜索(搜所有对话正文) ——
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState<import("./env").SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchSel, setSearchSel] = useState(0); // 键盘上下选中的结果行
  // 待跳转的目标：切会话是异步的(等 evt:session-loaded)，先记下来，会话加载完再滚过去
  const jumpRef = useRef<{ sid: string; anchor: string; q: string } | null>(null);
  // —— 数字婴儿(AGI 板块) ——
  const [agiEnabled, setAgiEnabled] = useState(() => localStorage.getItem("wuwei-agi-enabled") === "1"); // 默认隐藏，实验功能，设置里手动开
  const [agiExpanded, setAgiExpanded] = useState(() => localStorage.getItem("minicc-agi-expanded") !== "0"); // 侧栏 AGI 区展开
  const [agiView, setAgiView] = useState<null | "baby">(null); // 主区是否显示数字婴儿面板
  const [babyExists, setBabyExists] = useState(() => localStorage.getItem("minicc-baby-exists") === "1");
  const [babyDiary, setBabyDiaryState] = useState("");
  const [babyCurious, setBabyCuriousState] = useState("");
  const [babyChatLog, setBabyChatLog] = useState<{ role: "you" | "baby"; text: string; ts?: number }[]>([]);
  const [babyChatInput, setBabyChatInput] = useState("");
  const [babyBusy, setBabyBusy] = useState<string>(""); // 正在执行的操作描述(禁用按钮)
  const [babyAlive, setBabyAlive] = useState(false); // 无限生命循环开关(它持续自主活着)
  const [babyActivity, setBabyActivity] = useState(""); // 它此刻正在干嘛(学习/搜索/睡觉/发呆/对话)
  const [babyVitals, setBabyVitals] = useState<BabyVitals>({}); // 生命体征(轮询 /alive/status 的结构化字段)
  // 三张卡片各自折叠 + 左栏整体折叠(都记住上次的选择)
  const [babyCards, setBabyCards] = useState<Record<string, boolean>>(() => {
    try { return { status: true, curious: true, diary: true, ...JSON.parse(localStorage.getItem("minicc-baby-cards") || "{}") }; }
    catch { return { status: true, curious: true, diary: true }; }
  });
  const [babyLeftOpen, setBabyLeftOpen] = useState(() => localStorage.getItem("minicc-baby-left") !== "0");
  const [brainView, setBrainView] = useState<"graph" | "pyramid">("graph"); // 记忆网络:网络图/金字塔
  const [babyPyramid, setBabyPyramid] = useState<any>(null);
  const [brainFull, setBrainFull] = useState(false); // 记忆网络/金字塔全屏看
  const [babyTidy, setBabyTidy] = useState(false); // 正在整理知识(重建金字塔)
  // 「重新读取」的状态:转圈中 / 上次读成的时间 / 失败原因(以前全吞掉,点了像没反应)
  const [brainLoad, setBrainLoad] = useState<{ busy: boolean; at: number; err: string }>({ busy: false, at: 0, err: "" });
  const toggleCard = (k: string) =>
    setBabyCards((m) => {
      const n = { ...m, [k]: !m[k] };
      localStorage.setItem("minicc-baby-cards", JSON.stringify(n));
      return n;
    });
  const babyChatRef = useRef<HTMLDivElement>(null); // 聊天区容器(自动吸底)
  const babyChatStick = useRef(true); // 是否吸底(用户上滚>60px则暂不吸)
  const [babyTab, setBabyTab] = useState<"home" | "brain">("home"); // 数字婴儿面板 tab
  const [babyGraphData, setBabyGraphData] = useState<{ nodes: any[]; edges: any[] }>({ nodes: [], edges: [] });
  const sessionsRef = useRef<SessionMeta[]>([]); // 事件回调里取会话标题(ask 通知文案)
  sessionsRef.current = sessions;
  const [groups, setGroups] = useState<string[]>([]); // 分组顺序(新组置顶)
  const [groupMode, setGroupMode] = useState<"manual" | "date" | "project">("manual"); // 分组模式
  const [streamMode, setStreamMode] = useState<"typewriter" | "stream" | "instant">("stream"); // 输出方式
  const [streamSpeed, setStreamSpeed] = useState(400); // 打字机速度(字符/秒)
  const [keepRecent, setKeepRecent] = useState(12); // 上下文压缩保留最近N条
  // 完整对话历史查看器(压缩前的原始交流):右键会话→查看完整历史
  const [historyView, setHistoryView] = useState<null | { sid: string; title: string; items: Item[]; compacted: boolean; loading: boolean }>(null);
  const [effort, setEffort] = useState<Effort>("medium"); // 思考档位：越高越深入也越慢越贵
  const [showEffortPicker, setShowEffortPicker] = useState(true); // 底栏是否显示档位选择器
  const [showEffortMenu, setShowEffortMenu] = useState(false);
  // 底栏三个下拉(平台/模型/档位)共用一个定位值：菜单都挂在 .model-quick(relative) 上，
  // 若固定 left:0 就会全部贴容器最左，离点击的按钮很远。点谁就记谁的 offsetLeft，菜单据此对齐。
  const [mqMenuLeft, setMqMenuLeft] = useState(0);
  const openMqMenu = (e: React.MouseEvent<HTMLElement>) => setMqMenuLeft(e.currentTarget.offsetLeft);
  const [askToastAuto, setAskToastAuto] = useState(true); // 别的会话提醒是否自动消失
  const [askToastSec, setAskToastSec] = useState(30); // 自动消失秒数
  const askToastAutoRef = useRef(askToastAuto); // 事件回调里读最新值(避免闭包旧值)
  askToastAutoRef.current = askToastAuto;
  const askToastSecRef = useRef(askToastSec);
  askToastSecRef.current = askToastSec;
  const streamModeRef = useRef(streamMode);
  streamModeRef.current = streamMode;
  const streamSpeedRef = useRef(streamSpeed);
  streamSpeedRef.current = streamSpeed;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [ctxMenu, setCtxMenu] = useState<{ sid: string; x: number; y: number } | null>(null); // 会话右键菜单
  const [handoffBusy, setHandoffBusy] = useState(false); // 正在生成交接文档(总结→开新会话)
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
  // 切到某会话后，它的 ask 通知就没必要留着了(框已在眼前)
  useEffect(() => {
    setAskToasts((t) => t.filter((x) => x.sid !== currentId));
  }, [currentId]);
  const [showUsage, setShowUsage] = useState(false);
  // Codex 限额重置(免费重置额度)
  const [codexResets, setCodexResets] = useState<{ availableCount: number; credits: any[] } | null>(null);
  const [resetConfirm, setResetConfirm] = useState<string | null>(null); // 正在二次确认的 creditId
  const [resetMsg, setResetMsg] = useState("");
  const [showTasks, setShowTasks] = useState(false); // 运行中任务列表弹窗
  const [showBrowser, setShowBrowser] = useState(false); // 内置浏览器面板(可视化AI操作)
  const [browserMode, setBrowserMode] = useState<"split" | "full">("split"); // 半屏/全屏
  const [browserDetached, setBrowserDetached] = useState(false); // 是否弹成独立窗口
  const [browserWidth, setBrowserWidth] = useState(500); // 浏览器面板宽度(可拖动分隔条调；主区有 400 最小宽兜底不被压没)
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
  const [catalog, setCatalog] = useState<CatalogProviderDto[] | null>(null); // 后台 AI 提供商目录(默认序/显隐/模型)，null=回退硬编码 PRESETS
  const [hiddenProviders, setHiddenProviders] = useState<string[]>([]); // 隐藏的平台
  const [removedProviders, setRemovedProviders] = useState<string[]>([]); // 已删除的平台
  const [providerOverrides, setProviderOverrides] = useState<Record<string, { label?: string; baseUrl?: string }>>({}); // 平台改名/改端点
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [sidebarW, setSidebarW] = useState(
    () => Number(localStorage.getItem("wuwei-sidebar-w")) || 232,
  );
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("wuwei-sidebar-collapsed") === "1",
  );
  const sidebarWRef = useRef(sidebarW);
  sidebarWRef.current = sidebarW;
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // 输入框草稿持久化：文字+粘贴的截图实时落盘(~/.wuwei/draft.json)，重开/更新后自动恢复。
  // draftLoadedRef 保证「先加载完再回写」，避免初始空草稿把已存内容冲掉。
  const draftLoadedRef = useRef(false);
  useEffect(() => {
    window.wuwei
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
  // 草稿落盘：节流+trailing，而非纯防抖。纯防抖在连续快速打字时每次输入都重置计时器→一直不落盘→
  // 重启就丢一大段。节流保证连打时也每 ~400ms 落一次(最多丢最后一小段)；用 ref 读最新值，
  // 避免 trailing 触发时存到旧文本。
  const draftValsRef = useRef<{ text: string; images: string[] }>({ text: input, images: pendingImages });
  draftValsRef.current = { text: input, images: pendingImages };
  const draftTimerRef = useRef<number | null>(null);
  const draftLastSaveRef = useRef(0);
  useEffect(() => {
    if (!draftLoadedRef.current) return;
    const flush = () => {
      draftTimerRef.current = null;
      draftLastSaveRef.current = Date.now();
      window.wuwei.draftSet(draftValsRef.current); // 读 ref=最新文字/图片
    };
    const since = Date.now() - draftLastSaveRef.current;
    const GAP = 400;
    if (since >= GAP) flush(); // 距上次够久→立即落盘(leading)
    else if (draftTimerRef.current == null)
      draftTimerRef.current = window.setTimeout(flush, GAP - since); // 否则排一次 trailing，别在每次输入时清它
  }, [input, pendingImages]);
  // 关窗/刷新前兜底再落一次(尽量少丢；硬 kill 无法拦，靠上面的节流兜底)
  useEffect(() => {
    const onUnload = () => {
      if (draftLoadedRef.current) window.wuwei.draftSet(draftValsRef.current);
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);
  // 脑网络后台进度：主进程为真相源，无论设置弹窗开没开都持续订阅，供底部状态栏实时显示。
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
    window.wuwei.brainDocProgress?.().then((s: any) => setIdxProg(s)).catch(() => {});
    window.wuwei.brainConceptProgress?.().then((s: any) => setConProg(s)).catch(() => {});
    const off = window.wuwei.onEvent((ch, p: any) => {
      if (ch === "evt:brain-docs") setIdxProg(p);
      else if (ch === "evt:brain-concepts") setConProg(p);
      else if (ch === "evt:tray-settings") setShowSettings(true); // 托盘菜单「设置」→ 打开设置面板
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
  const [coinPackOpen, setCoinPackOpen] = useState(false); // ② 购买积分包弹窗
  const [planOpen, setPlanOpen] = useState(false); // ③ 升级套餐弹窗
  const [payCheckout, setPayCheckout] = useState<PayOrder | null>(null); // ④ 付款页(扫码)
  const [payResult, setPayResult] = useState<PayResult | null>(null); // ⑤ 支付结果页
  const [showLoginForm, setShowLoginForm] = useState(false); // 应用内登录框
  const [showLoginIntro, setShowLoginIntro] = useState(false); // 未登录发消息先弹的登录激励卡（点登录再切登录框）
  const [showSupport, setShowSupport] = useState(false); // 联系客服弹窗（支付遇到问题 / 账号菜单都可开）
  const [showLeaveMsg, setShowLeaveMsg] = useState(false); // 留言表单（客服弹窗内点「直接留言」/ 账号菜单「留言反馈」进入）
  const [leaveMsgFromSupport, setLeaveMsgFromSupport] = useState(false); // 区分来源：从客服弹窗进=显返回；从菜单直接进=无返回
  const [showMsgCenter, setShowMsgCenter] = useState(false); // 消息中心弹窗
  const [msgUnread, setMsgUnread] = useState(0); // 消息中心未读数（菜单红点）
  const [showBrainIntro, setShowBrainIntro] = useState(false); // 脑网络功能介绍弹窗（会员专享）
  const [checkinToast, setCheckinToast] = useState(""); // 每日签到到账轻量提示
  const [checkinDone, setCheckinDone] = useState(false); // 今日是否已签到（手动签或已签后置 true）
  const [checkinBusy, setCheckinBusy] = useState(false); // 签到请求中，防重复点击
  const [checkinPop, setCheckinPop] = useState<{ amount: number; streak?: number } | "already" | null>(null); // 居中签到弹窗
  const [loginResume, setLoginResume] = useState(false); // 登录成功后是否续发刚才拦下的消息
  const [lang, setLangState] = useState<Lang>(getLang()); // 界面语言
  const t = makeT(lang);
  function changeLang(l: Lang) {
    persistLang(l);
    setLangState(l);
    // 同步到主进程 settings.app.lang → 刷新 WUWEI_LANG，让主进程 tt()/工具描述/系统提示默认跟随界面语言
    window.wuwei.setAppSettings({ lang: l });
  }
  const [webLoginBusy, setWebLoginBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false); // 失败处一键授权 Claude 进行中
  const [codexBusy, setCodexBusy] = useState(false); // Codex 一键授权进行中
  // 无为账号（B2：全新正交账号态，≠模型商账号，独立身份区。最终顶栏样式待小美定稿换皮）
  const [wuwei, setWuwei] = useState<{
    user: { id: string; email: string | null; name: string | null; avatar: string | null };
    coin: { balance: number; lastSignin?: string | null };
    membership?: {
      tier: "free" | "pro_month" | "pro_year";
      expireAt?: string | number;
      plan?: string | null; // 档位显示名 Pro/Plus/Max
      weeklyQuota?: { active: boolean; remainingPct: number; resetsAt: string | null };
    };
    flags?: string[];
    providers?: { hidden?: string[] };
  } | null>(null);
  // 灰度开关（C2）：订阅版是否显示，完全由后端 flags 决定，默认隐藏。客户端只渲染不判定。
  const showSubscription = !!wuwei?.flags?.includes("subscription");
  const isPro = (wuwei?.membership?.tier ?? "free") !== "free"; // 会员态：脑网络等专享功能门控
  const [wuweiBusy, setWuweiBusy] = useState(false);
  const [coinShortage, setCoinShortage] = useState<{ message: string; balance?: number } | null>(null);
  // 客户端公告：启动拉取，未读过该版本(version)且 active 才弹；读过存本地，同版本不再弹，后台更新(version 变)则再弹。
  const [announce, setAnnounce] = useState<{ version: string; title: string; body: string } | null>(null);
  // 自动更新：版本号 + 检查态 + 新版就绪(已下载好，点即装)
  const [appVer, setAppVer] = useState("");
  const [updateReady, setUpdateReady] = useState<{ version: string; notes: string } | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false); // 升级弹窗开关：药丸/菜单点击才开，下载好不再自动弹
  const [updateMsg, setUpdateMsg] = useState(""); // 「检查中/已是最新/发现新版下载中…」等提示
  const [hasUpdate, setHasUpdate] = useState(false); // 有新版可用(小红点标志)：发现新版即 true
  // 左下角「重启更新」药丸：新版下载好后常驻显示，点主体即装、点叉关闭；关掉的版本记 localStorage，同版本不再弹、更新的版本会重新出现
  const [updateChipHidden, setUpdateChipHidden] = useState<string>(() => { try { return localStorage.getItem("wuwei_dismissed_update_chip") || ""; } catch { return ""; } });
  const [dlProgress, setDlProgress] = useState<{ percent: number; bytesPerSecond: number } | null>(null); // 更新下载进度(0-100)，下载完清空
  async function refreshWuweiForShortage(message: string) {
    setCoinShortage({ message });
    try {
      const me = await window.wuwei.wuweiMe();
      if (me) {
        setWuwei(me);
        setCoinShortage({ message, balance: me.coin.balance });
      }
    } catch {
      /* 弹窗仍然保留充值入口 */
    }
  }
  async function doWuweiLogout() {
    await window.wuwei.wuweiLogout();
    setWuwei(null);
    setCheckinDone(false);
  }
  // 手动签到：账号面板点「签到」触发。后端幂等，给币则弹 toast + 刷新余额；无论刚签/已签都标记当天完成。
  async function doCheckin() {
    if (checkinBusy || checkinDone) return;
    setCheckinBusy(true);
    try {
      const r = await window.wuwei.checkin();
      if (r?.success && (r.amount ?? 0) > 0) {
        setCheckinPop({ amount: r.amount ?? 0, streak: r.streak }); // 居中成功弹窗
        window.wuwei.wuweiMe().then((m) => { if (m) setWuwei(m); }).catch(() => {});
      } else if (r) {
        setCheckinPop("already"); // 今日已签到，也给个反馈
      }
      if (r) setCheckinDone(true);
      if (r) setTimeout(() => setCheckinPop(null), 2800); // 自动消失
    } catch {
      /* 忽略，稍后可重试 */
    } finally {
      setCheckinBusy(false);
    }
  }
  // 海外结账：英文用户点购买/升级 → 系统浏览器打开网页 Paddle 结账页(已验证可付+webhook发币)。
  // clientSku=人民币档 sku，经 EN_SKU 映射成美元档 sku。内嵌 3DS 走不通，故用系统浏览器。
  function startEnCheckout(clientSku: string) {
    const enSku = EN_SKU[clientSku];
    if (!enSku) return;
    const uid = wuwei?.user.id;
    const email = wuwei?.user.email ?? "";
    const url =
      `https://wuweiai.io/en/checkout?sku=${encodeURIComponent(enSku)}` +
      (uid ? `&uid=${encodeURIComponent(uid)}&email=${encodeURIComponent(email)}` : "");
    window.wuwei.openExternal(url);
  }
  // 应用内登录框成功回调：更新账号 + 关框 + (若从发送门槛来)续发刚才拦下的消息
  function onWuweiLoggedIn(me: WuweiMe, action?: "login" | "register" | "reset") {
    setWuwei(me);
    setShowLoginForm(false);
    const en = getLang() === "en";
    const who = me.user.name || me.user.email || (en ? "user" : "用户");
    const msg =
      action === "register"
        ? (en ? `✓ Registered — welcome to Wuwei! Signed in: ${who}` : `✓ 注册成功，欢迎加入无为！已登录：${who}`)
        : action === "reset"
          ? (en ? `✓ Password reset, signed in automatically: ${who}` : `✓ 密码已重置，已自动登录：${who}`)
          : (en ? `✓ Signed in: ${who}` : `✓ 已登录：${who}`);
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
      const ok = await window.wuwei.codexLogin();
      push({
        type: "notice",
        text: ok
          ? (lang === "en" ? "✓ Codex authorized — switched to the Codex subscription, ready to chat." : "✓ Codex 授权成功，已切到 Codex 订阅，可以直接对话了。")
          : (lang === "en" ? "Codex authorization didn't complete (cancelled/timeout/port 1455 in use). If codex CLI is running locally, close it and retry." : "Codex 授权未完成（取消/超时/端口 1455 被占）。若本机在跑 codex CLI 请先关掉再试。"),
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
    reason: getLang() === "en" ? "Checking connection…" : "检测连通状态…",
  });
  const [showConn, setShowConn] = useState(false); // 状态灯说明气泡
  const thinkStartRef = useRef<number | null>(null); // 本轮开始时间（思考计时）
  const charsRef = useRef(0); // 本轮已流式字符数（估算 token）
  const turnTextRef = useRef(""); // 本轮已生成的正文(含 instant 模式还没揭示的),供状态栏悬停预览
  // 已"总是允许"的工具（记住授权，跨重启，手动模式下不再提示）
  const alwaysAllowRef = useRef<Set<string>>(
    new Set((() => {
      try {
        return JSON.parse(localStorage.getItem("wuwei-allow") || "[]");
      } catch {
        return [];
      }
    })()),
  );
  const streamRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // 用户是否贴着底部：滚上去看历史时暂停自动吸底，滚回底部再恢复
  // 强制吸底截止时间戳(0=不强制)。切换会话/发消息后的这段时间里，滚动是"内容异步撑高"引起的，
  // 不是用户意图：期间无条件吸底，且不让这些程序滚动改写 atBottomRef——
  // 否则内容刚替换那一帧 scrollTop 还是 0 而 scrollHeight 已很大，会被判成"用户已离底"，
  // 把后面几次兜底吸底全挡掉，表现就是"要点两下才到底部"。
  const forceBottomUntilRef = useRef(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false); // 离底(=已暂停吸底)：显示"回到底部"按钮
  const [serverCtxMax, setServerCtxMax] = useState(0); // 服务端报错里学到的真实上下文上限(0=还没学到)
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
    window.wuwei.getSettings().then((r) => {
      setCurProviderId(r?.settings?.providerId || "");
      setStations(r?.settings?.customStations || []);
      setProviderOrder(r?.settings?.providerOrder || []);
      setHiddenProviders(r?.settings?.hiddenProviders || []);
      setRemovedProviders((r?.settings as any)?.removedProviders || []);
      setProviderOverrides((r?.settings as any)?.providerOverrides || {});
      setGroupMode((r?.settings as any)?.groupMode || "manual");
      setStreamMode((r?.settings as any)?.streamMode || "stream");
      setStreamSpeed((r?.settings as any)?.streamSpeed || 400);
      setKeepRecent((r?.settings as any)?.keepRecent || 12);
      setEffort((r?.settings as any)?.effort || "medium");
      setShowEffortPicker((r?.settings as any)?.showEffortPicker !== false); // 默认显示
      setAskToastAuto((r?.settings as any)?.askToastAutoDismiss !== false); // 默认开
      setAskToastSec((r?.settings as any)?.askToastDismissSec || 30);
      // 应用主题(深色已下线，默认白色；存量 dark 回退白色)
      const theme = resolveTheme((r?.settings as any)?.theme);
      document.documentElement.setAttribute("data-theme", theme);
    });
    document.documentElement.setAttribute("data-platform", window.wuwei.platform);
  }, [showSettings]);
  // 后台「AI 提供商」目录：默认序 / 显隐 / 模型（含免费）由后台可配。带登录 token 拉(应用每用户显隐)。
  // 拉不到(离线/老后端)→ catalog=null → 全量回退硬编码 PRESETS + PROVIDER_ORDER，保证永远能用。
  useEffect(() => {
    window.wuwei.wuweiCatalog?.().then((c) => setCatalog(c && c.length ? c : null)).catch(() => setCatalog(null));
  }, [wuwei?.user?.id]);

  // 内置平台 + 用户自定义供应商：先应用用户的删除/改名/改端点覆盖，再按托管登录+后台可见性过滤，
  // 最后按用户自定义顺序排、隐藏项不进切换菜单
  const backendHidden = wuwei?.providers?.hidden ?? []; // 后台下发的隐藏供应商(全局+按用户)
  // 把后台目录并入内置预设：已知平台沿用本地元数据(kind/baseUrl/note)、仅用 catalog 覆盖模型列表；
  // 后台新增的平台则整条按 catalog 构造。免费模型 id 收集给下拉打「免费」标。catalog=null 时原样返回。
  const freeModelIds = new Set<string>();
  const modelBadges = new Map<string, string>(); // 后台配的模型角标(如「快」)，下拉里显示
  const modelLabels = new Map<string, string>(); // 后台配的模型显示名(如 gpt-5.6→"GPT-5.6 Sol")，下拉里优先显示 label
  const mergedPresets = mergeCatalogIntoPresets(PRESETS, catalog, freeModelIds, curProviderId, modelBadges, modelLabels);
  const catalogOrder = catalog ? catalog.slice().sort((a, b) => a.sort - b.sort).map((p) => p.id) : undefined;
  const providerListRaw = arrangePresets(
    // 托管平台需登录可见；anon(免登录)平台未登录也可见；后台隐藏的一律不显示(供应商上下架由后台控制)
    applyProviderEdits([...mergedPresets, ...stations.map(stationToPreset)], providerOverrides, removedProviders).filter(
      // 游客也显示全部平台(含托管)——点托管平台发消息时才引导登录(见发送门槛)；仅按后台隐藏过滤。
      (p) => !backendHidden.includes(p.id),
    ),
    providerOrder,
    hiddenProviders,
    false,
    catalogOrder,
  );
  // 未登录：免费体验(anon)恒置顶(稳定排序，其余相对序不变)——访客第一眼就是免费体验，也是唯一可用项。
  const providerList = wuwei ? providerListRaw : [...providerListRaw].sort((a, b) => (b.anon ? 1 : 0) - (a.anon ? 1 : 0));
  const curPreset = providerList.find((p) => p.id === curProviderId);
  // 动态实时模型(从平台 /models 拉)并入预设，去重；预设在前(保证旗舰置顶)，实时补充新模型；
  // 再并入当前生效的模型(meta.model)——自建端点等没有预设列表时，配好的模型也能在快切里看到/切换。
  const quickModels = [
    ...new Set(
      [...(curPreset?.models ?? []), ...(liveModels[curProviderId] || []), meta.model].filter(
        Boolean,
      ) as string[],
    ),
  ];
  // 切换模型下拉展示：常用=预设旗舰(+当前选中项)，全部=预设+实时拉取全量
  const commonModels = curPreset?.models ?? [];
  const shownModels = showAllModels
    ? quickModels
    : [...new Set([...commonModels, ...(meta.model && !commonModels.includes(meta.model) ? [meta.model] : [])])];
  const hasMoreModels = quickModels.length > commonModels.length;
  async function quickModel(m: string) {
    // 访客门禁：未登录时仅「免费体验(anon)」平台可切它自己的免费模型；其它一律引导登录
    if (!wuwei && !curPreset?.anon) {
      setShowModelMenu(false);
      setShowLoginIntro(true);
      return;
    }
    const r = await window.wuwei.getSettings();
    const cur = r?.settings;
    if (cur) window.wuwei.setSettings({ ...cur, model: m });
    setShowModelMenu(false);
  }

  // 连通状态检测：更新状态灯（红/黄/绿）
  async function runConnCheck() {
    setConn({ status: "checking", reason: lang === "en" ? "Checking connection…" : "检测连通状态…" });
    try {
      const r = await window.wuwei.checkConn();
      setConn(r);
    } catch {
      setConn({ status: "yellow", reason: lang === "en" ? "Check failed, please retry." : "检测失败，请重试。" });
    }
  }

  // ——— API Key 平台：一键获取 → 复制自动检测 → 通了自动设置 ———
  // 把验证过的 key 存进当前平台槽并切换生效
  async function saveApiKeyToSettings(key: string) {
    const r = await window.wuwei.getSettings();
    const s = r?.settings || {};
    const pid = s.providerId || curProviderId;
    const creds = { ...(s.creds || {}) };
    creds[pid] = { ...(creds[pid] || {}), apiKey: key };
    window.wuwei.setSettings({ ...s, apiKey: key, oauthToken: undefined, creds });
  }

  // 试一个候选 key：先测连通，通了才落库+提示成功。silent=剪贴板自动检测时不打扰
  async function tryApiKey(candidate: string, silent = false): Promise<boolean> {
    const key = (candidate || "").trim();
    if (!key || keyTestingRef.current) return false;
    keyTestingRef.current = true;
    setApiKeyBusy(true);
    try {
      const res = await window.wuwei.testKey(key);
      if (res.ok) {
        await saveApiKeyToSettings(key);
        push({ type: "notice", text: lang === "en" ? "✓ API Key verified and set — ready to use." : "✓ API Key 已验证通过并设置完成，可以直接使用了。" });
        setNeedAuth(false);
        setAuthDismissed(false);
        setApiKeyStep("idle");
        setApiKeyInput("");
        setConn({ status: "green", reason: lang === "en" ? "Connected, ready anytime." : "已连通，可随时使用。" });
        return true;
      }
      if (keyRejected(res.reason)) {
        // 真·鉴权失败：Key 无效，不保存
        if (!silent) push({ type: "notice", text: (lang === "en" ? "✗ This key is invalid (auth failed): " : "✗ 这个 Key 无效（鉴权失败）：") + res.reason });
        return false;
      }
      // Key 有效但请求未通过(余额/额度/账单等)：照样保存，给提醒；灯转黄
      await saveApiKeyToSettings(key);
      push({
        type: "notice",
        text: (lang === "en" ? "⚠ Key saved (valid), but the request didn't go through — usually an account balance/quota issue, not a key error: " : "⚠ Key 已保存（本身有效），但请求未通过，多为账户余额/额度问题，非 Key 错误：") + res.reason,
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
    if (curPreset?.keyUrl) window.wuwei.openExternal(curPreset.keyUrl);
    lastClipRef.current = "";
    setApiKeyInput("");
    setApiKeyStep("awaiting");
  }

  // 把拿到的 token 存进设置并切到 Claude 订阅后端
  async function saveClaudeToken(tok: string) {
    const r = await window.wuwei.getSettings();
    const s = r?.settings || {};
    const creds = { ...(s.creds || {}) };
    creds["claude-oauth"] = { ...(creds["claude-oauth"] || {}), oauthToken: tok };
    window.wuwei.setSettings({
      ...s,
      kind: "anthropic-oauth",
      providerId: "claude-oauth",
      model: s.model || "claude-opus-4-8",
      oauthToken: tok,
      apiKey: undefined,
      baseUrl: undefined,
      creds,
    });
    push({ type: "notice", text: lang === "en" ? "✓ Claude subscription authorized — please resend your last message." : "✓ Claude 订阅已授权，请重新发送刚才的消息。" });
    setNeedAuth(false); // 授权完成，收起授权条
    setAuthDismissed(false);
    setOauthStep("idle");
  }

  // 应用内弹窗授权(自行输账号密码，自动捕获)
  async function authorizeWindow() {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      const tok = await window.wuwei.claudeLogin();
      if (tok) await saveClaudeToken(tok);
      else push({ type: "notice", text: lang === "en" ? "Authorization didn't complete (cancelled/timeout), you can retry." : "授权未完成（已取消/超时），可重试。" });
    } finally {
      setAuthBusy(false);
    }
  }

  // 系统浏览器授权 第1步：开浏览器(复用已登录 Google)，进入「等回填授权码」态
  async function authorizeBrowser() {
    await window.wuwei.claudeOauthOpen();
    setCodeInput("");
    setOauthStep("awaiting-code");
    push({
      type: "notice",
      text: lang === "en" ? "Opened the authorization page in your browser: sign in and click \"Approve\", copy the code shown, come back and click \"Complete authorization\" (clipboard auto-read)." : "已在浏览器打开授权页：登录并点“同意”后，复制页面显示的授权码，回来点「完成授权」（会自动读剪贴板）。",
    });
  }

  // 系统浏览器授权 第2步：用授权码换 token（输入框留空则自动读剪贴板）
  async function completeBrowserAuth() {
    if (authBusy) return;
    setAuthBusy(true);
    try {
      let code = codeInput.trim();
      if (!code) code = (await window.wuwei.readClipboard()).trim();
      if (!code) {
        push({ type: "notice", text: lang === "en" ? "No code found: copy the authorization code in the browser first, or paste it into the box, then click complete." : "没读到授权码：请先在浏览器复制授权码，或粘贴进输入框再点完成。" });
        return;
      }
      const tok = await window.wuwei.claudeOauthExchange(code);
      if (tok) await saveClaudeToken(tok);
      else push({ type: "notice", text: lang === "en" ? "The code is invalid or expired — click \"Sign in via browser\" and try again." : "授权码无效或已过期，请重新点「用浏览器登录」再试一次。" });
    } finally {
      setAuthBusy(false);
    }
  }

  // 快捷切换供应商：带出该平台已存的 key/baseUrl，默认用该平台第一个模型
  async function quickProvider(p: (typeof PRESETS)[number]) {
    // 访客门禁：未登录只能选「免费体验(anon)」，切到别的平台一律引导登录
    if (!wuwei && !p.anon) {
      setShowProviderMenu(false);
      setShowLoginIntro(true);
      return;
    }
    const r = await window.wuwei.getSettings();
    const cur = r?.settings || {};
    const slot = (cur.creds || {})[p.id] || {};
    window.wuwei.setSettings({
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

  // 启动即把当前界面语言同步进主进程 settings.app.lang → WUWEI_LANG，
  // 保证主进程 tt()/工具描述/系统提示默认从一开始就跟随界面语言（此后已持久化，下次启动即正确）。
  useEffect(() => {
    window.wuwei.setAppSettings({ lang });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动更新：拿版本号 + 监听「发现新版下载中/已下载好」事件
  useEffect(() => {
    window.wuwei.getAppVersion().then(setAppVer).catch(() => {});
    const off = window.wuwei.onEvent((ch, p: any) => {
      // 自动下载不打扰用户，只在「更新」项标小红点；下载好了才弹「升级」提示
      if (ch === "evt:update-available") setHasUpdate(true);
      else if (ch === "evt:update-progress") setDlProgress({ percent: Math.round(p?.percent ?? 0), bytesPerSecond: p?.bytesPerSecond ?? 0 });
      else if (ch === "evt:update-downloaded") { setHasUpdate(true); setDlProgress(null); setUpdateReady({ version: p?.version || "", notes: p?.notes || "" }); }
      else if (ch === "evt:tray-check-update") checkUpdateRef.current(); // 托盘菜单「检查更新」→ 走与账号菜单同一套检查流程
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 今日已签到判定：拿到账号数据后，若最近签到日=今天(UTC，与后端签到日一致)则按钮直接显「已签到」且禁用，不用点了才知道。
  useEffect(() => {
    const last = wuwei?.coin.lastSignin;
    if (last && last === new Date().toISOString().slice(0, 10)) setCheckinDone(true);
  }, [wuwei?.coin.lastSignin]);

  async function checkUpdateNow() {
    setShowAcctMenu(false); // 关菜单，结果用居中弹窗显示
    setUpdateMsg(lang === "en" ? "Checking for updates…" : "正在检查更新…");
    const r = await window.wuwei.checkUpdate();
    if (r.available) {
      setHasUpdate(true);
      if (r.downloaded) {
        // 已下载好：直接弹「升级并重启」，不再停留在「下载中」
        setUpdateReady({ version: r.version || "", notes: r.notes || "" });
        setDlProgress(null);
        setUpdateMsg("");
        setShowUpdateModal(true);
      } else {
        setUpdateMsg(lang === "en" ? `New version v${r.version} found — downloading in the background. You'll be prompted to update when it's ready.` : `发现新版本 v${r.version}，正在后台下载，下载完成会提示你升级。`);
      }
    }
    else setUpdateMsg(r.error ? (lang === "en" ? "Can't check updates right now (dev build or no update source)." : "暂时无法检查更新（开发版或未配置更新源）。") : (lang === "en" ? `You're on the latest version (v${appVer}).` : `已是最新版本（v${appVer}）。`));
  }
  // 托盘菜单从主进程事件触发检查更新：用 ref 持有最新闭包，避免 onEvent(空依赖)调到旧的 lang/appVer
  const checkUpdateRef = useRef(checkUpdateNow);
  checkUpdateRef.current = checkUpdateNow;

  // 消息中心未读数：启动拉一次 + 每 5 分钟轮询（登录后才有；未登录返回 0）。面板打开会置 0。
  useEffect(() => {
    let alive = true;
    const pull = () => window.wuwei.getMessages().then((r) => { if (alive) setMsgUnread(r?.unread || 0); }).catch(() => {});
    pull();
    const timer = setInterval(pull, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [wuwei?.user?.id]);

  // 启动拉公告：active 且未读过该 version → 弹窗（标题/正文随界面语言）。读过或后台没发则不弹。
  useEffect(() => {
    window.wuwei.getAnnouncement().then((a) => {
      if (!a?.active || !a.version) return;
      let seen = "";
      try { seen = localStorage.getItem("wuwei_seen_announcement") || ""; } catch { /* ignore */ }
      if (seen === a.version) return; // 这版读过了，不再弹
      const title = (lang === "en" ? a.titleEn : a.titleZh) || a.titleZh || a.titleEn || "";
      const body = (lang === "en" ? a.bodyEn : a.bodyZh) || a.bodyZh || a.bodyEn || "";
      if (!title && !body) return;
      setAnnounce({ version: a.version, title, body });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const off = window.wuwei.onEvent((ch, payload: any) => {
      // 结构性事件(工具/完成/切换…)前先把累积的流式文本落定，保证顺序不乱
      if (ch !== "evt:assistant-delta" && pendingDeltaRef.current) flushDelta(true); // 段落边界整段吐
      switch (ch) {
        case "evt:ready":
          setMeta(payload);
          setServerCtxMax(0); // 换了模型/平台，上一条链路学到的上限不再适用
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
        case "evt:trash":
          setTrash(Array.isArray(payload) ? payload : []);
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
        case "evt:session-loaded": {
          setCurrentId(payload.id);
          // 搜索结果点进来的：目标不是底部而是命中那条 → 别吸底，交给下面的跳转 effect
          const jumping = jumpRef.current?.sid === payload.id;
          clearSearchHighlight(); // 上一次搜索的高亮不跨会话残留(要跳转的话下面会重新打)
          atBottomRef.current = !jumping; // 打开/切换会话：定位到最新(底部)，不用手滚
          forceBottomUntilRef.current = jumping ? 0 : Date.now() + 700; // 跳转时不吸底(=0)，交给跳转 effect
          setAwayFromBottom(false);
          setItems(messagesToItems(payload.messages));
          break;
        }
        case "evt:assistant-delta":
          if (payload.sid !== currentIdRef.current) break; // 只画当前可见会话
          charsRef.current += (payload.delta as string).length;
          turnTextRef.current += payload.delta; // 本轮全量正文(供悬停预览,instant 模式也能看到)
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
          // manual 模式每步问；auto/cont 自动放行(等价旧 autoMode)。按发起会话的模式判。
          if (modeOf(payload.sid || currentIdRef.current) !== "manual" || alwaysAllowRef.current.has(payload.name))
            window.wuwei.respondPermission(payload.id, "allow");
          else setPending(payload);
          break;
        case "evt:ask-user": {
          // AI 请用户选择：按发起会话 id 存。当前会话→直接弹框；别的会话→右上角通知，不打断当前对话。
          const askSid = payload.sid || currentIdRef.current;
          setAsks((m) => ({ ...m, [askSid]: { id: payload.id, questions: payload.questions || [] } }));
          const isCur0 = askSid === currentIdRef.current;
          // 后台会话到点自答的公共动作(当前会话交给 AskModal 的可见倒计时)
          const bgAutoAnswer = (sec: number) => {
            if (sec <= 0) return;
            window.setTimeout(() => {
              setAsks((m) => {
                if (m[askSid]?.id !== payload.id) return m; // 已被人回答/取消，别抢
                const qs = m[askSid].questions || [];
                window.wuwei.answerAsk(payload.id, {
                  list: qs.map(() => ({ selected: [], text: lang === "en" ? "You decide based on the overall goal — pick the most reasonable option and keep going." : "这个你按总目标自己定，挑最合理的选项继续。" })),
                });
                const n = { ...m }; delete n[askSid]; return n;
              });
            }, sec * 1000);
          };
          // 智能继续 cont 模式：红线判定分两种方式
          if (modeOf(askSid) === "cont") {
            if (redlineModeRef.current === "smart") {
              // 智能识别：先让 LLM 判"自主答会不会真触发危险动作"，结果存 askRisk 给 AskModal 用
              setAskRisk((r) => ({ ...r, [payload.id]: { pending: true, risky: false, reason: "" } }));
              window.wuwei.judgeAskRisk?.(payload.questions || [], stopRulesRef.current)
                .then((v) => {
                  setAskRisk((r) => ({ ...r, [payload.id]: { pending: false, risky: !!v?.risky, reason: v?.reason || "" } }));
                  if (!isCur0 && !v?.risky) bgAutoAnswer(askAutoSecRef.current); // 后台会话:判完安全再自答
                })
                .catch(() => setAskRisk((r) => ({ ...r, [payload.id]: { pending: false, risky: false, reason: "" } })));
            } else if (!isCur0) {
              // 关键词匹配 + 后台会话：不碰红线就到点自答(当前会话由 AskModal 处理)
              bgAutoAnswer(askAutoSecFor(payload.questions || [], askAutoSecRef.current, stopRulesRef.current));
            }
          }
          if (askSid !== currentIdRef.current) {
            const title = sessionsRef.current.find((s) => s.id === askSid)?.title || (lang === "en" ? "Another chat" : "其它会话");
            setAskToasts((t) => [...t.filter((x) => x.sid !== askSid), { askId: payload.id, sid: askSid, title }]);
            // 自动消失：按设置的开关与秒数(关掉则常驻，直到点开/✕忽略)
            if (askToastAutoRef.current) {
              window.setTimeout(() => dropToast(payload.id), Math.max(1, askToastSecRef.current) * 1000);
            }
          }
          break;
        }
        case "evt:usage":
          if (payload.sid !== currentIdRef.current) break; // 只显示当前会话用量
          setUsage(payload.usage);
          // 实时盖到本轮正在生成的最后一条助手气泡上：footer 悬停即见本轮 token(每完成一段就刷新)。
          // 仅当带 round(每步上报)才盖，避免 bootstrap/切会话的无 round 快照冲掉已有值。
          if (payload.usage?.round) {
            setItems((p) => {
              for (let k = p.length - 1; k >= 0; k--) {
                if (p[k].type === "assistant") {
                  const c = [...p];
                  c[k] = { ...(c[k] as any), usage: payload.usage };
                  return c;
                }
                if (p[k].type === "user") break; // 本轮还没出助手文字(如直接调工具)→先不盖，等出正文
              }
              return p;
            });
          }
          break;
        case "evt:ratelimits":
          setRate(payload);
          break;
        case "evt:suggest": {
          const sid = payload.sid;
          const cur = sid === currentIdRef.current;
          // 推理模型(z1 等)会带 <think>…</think>：只取思考后的正文当建议
          const go = splitThinking(payload.text || "").answer.trim();
          if (cur) {
            // 建议条/幽灵提示只画当前会话；后台会话不占屏幕，只在下面照常往下推进
            setSuggestion(go);
            lastSuggestRef.current = { text: go, canContinue: !!payload.canContinue, auto: false };
          }
          // 智能继续：只有"纯推进确认"(canContinue)才自动接话；危险/要你拿主意的一律停下。
          // 开没开看这个会话自己的模式——跟它在不在屏幕上无关，否则切走的会话就永远断在这儿。
          const n0 = contBySid.current.get(sid) || 0;
          if (modeOf(sid) !== "cont" || !go || (contMaxRef.current > 0 && n0 >= contMaxRef.current)) break;
          if (payload.canContinue) {
            if (cur) lastSuggestRef.current.auto = true;
            // 反悔窗口(设置里可调)：这期间你一打字或按停，autoContinue 里会再校验一次
            setTimeout(() => autoContinue(sid, go), Math.max(0, contDelayRef.current));
          } else if (
            // 判成 ASK 的兜底：只要这句本身不碰红线，就延时自动往下走；碰红线的才真停住等你
            askAutoSecFor([{ question: go, header: "", options: [] }], askAutoSecRef.current, stopRulesRef.current) > 0
          ) {
            const sec = Math.max(3, askAutoSecRef.current * 2);
            if (cur) setSuggestWait(sec); // 当前会话:屏上走秒，你随时能点"等我"
            else setTimeout(() => autoContinue(sid, go), sec * 1000); // 后台会话:静默等同样久再走
          }
          break;
        }
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
          push({ type: "notice", text: lang === "en" ? `Context compacted: ${payload.before} → ${payload.after} messages` : `上下文已压缩：${payload.before} → ${payload.after} 条消息` });
          break;
        case "evt:done":
          if (payload.sid === currentIdRef.current) thinkStartRef.current = null;
          setNeedAuth(false); // 成功完成一轮=鉴权已通，收起授权条
          setConn({ status: "green", reason: lang === "en" ? "Connected, ready anytime." : "已连通，可随时使用。" }); // 成功=绿灯
          break;
        case "evt:stopped":
          if (payload.sid !== currentIdRef.current) break;
          thinkStartRef.current = null;
          push({ type: "notice", text: lang === "en" ? "Stopped" : "已停止" });
          break;
        case "evt:handoff":
          // 交接进度反馈:总结中(在源会话提示)/完成(已切到新会话)/失败
          if (payload.phase === "summarizing")
            push({ type: "notice", text: lang === "en" ? "Summarizing valuable content, generating handoff doc…" : "正在总结有价值内容、生成交接文档…" });
          else if (payload.phase === "done")
            push({ type: "notice", text: lang === "en" ? "Handoff doc ready — continuing in a new chat →" : "交接文档已生成，已开新对话接着做 →" });
          break;
        case "evt:error": {
          if (payload.sid && payload.sid !== currentIdRef.current) break;
          thinkStartRef.current = null;
          const rawMsg = String(payload.message ?? payload);
          const friendly = friendlyError(rawMsg, t);
          // 服务端报了真实上限就记下来，占用条改按它算(比客户端按模型名猜准)
          const realLimit = parseServerCtxLimit(rawMsg);
          if (realLimit > 0) setServerCtxMax(realLimit);
          if (isCoinShortage(rawMsg) || isCoinShortage(friendly)) {
            setShowAcctMenu(false);
            void refreshWuweiForShortage(friendly);
          }
          // 免费体验触发上限/配额用尽/被关停 → 未登录则弹登录引导（"触发最大限制后才引导登录"）
          if (!wuwei && /daily_cap_reached|free_quota_exhausted|free_trial_disabled/i.test(rawMsg)) {
            setShowLoginIntro(true);
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
    // 强制窗内(刚切会话/刚发消息)无条件吸底；否则只有用户本来就贴着底部时才吸，往上滚看历史时不打扰
    const forcing = () => Date.now() < forceBottomUntilRef.current;
    if (!forcing() && !atBottomRef.current) return;
    const el = streamRef.current;
    if (!el) return;
    const toBottom = () => el.scrollTo({ top: el.scrollHeight });
    toBottom();
    // 二次校正：长会话/代码高亮/图片会在下一帧改变高度，再吸一次确保真到底
    requestAnimationFrame(() => {
      if (forcing() || atBottomRef.current) toBottom();
    });
    // 仅在强制窗内挂多帧兜底：切会话/发消息后内容(markdown/代码高亮/图片)会持续改变高度，
    // 多吸几次才能稳稳停在最新消息。流式输出时 items 高频变化，这里不能无条件挂定时器。
    if (!forcing()) return;
    const timers = [50, 130, 260, 450, 650].map((ms) =>
      setTimeout(() => {
        if (forcing() || atBottomRef.current) toBottom();
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [items, busy, pending]);

  // 搜索结果点进来：会话渲染好后滚到命中的那条消息，并把关键词高亮出来。
  // 和上面的「切会话吸底」互斥(session-loaded 里跳转时已把 forceBottomUntil 置 0、atBottom 置 false)。
  useEffect(() => {
    const jump = jumpRef.current;
    if (!jump || jump.sid !== currentId) return;
    const el = streamRef.current;
    if (!el || !items.length) return;
    jumpRef.current = null;
    atBottomRef.current = false;
    let stopped = false;
    let lastH = -1;
    let stable = 0;
    const t0 = Date.now();
    // markdown / 代码高亮 / 图片会连续几帧改高度，反复对齐直到高度稳定或超时
    const step = () => {
      if (stopped) return;
      const target =
        el.querySelector<HTMLElement>(`[data-anchor="${jump.anchor}"]`) ||
        el.querySelector<HTMLElement>(`[data-anchor^="${jump.anchor.split(":")[0]}:"]`);
      if (target) {
        target.classList.add("search-flash");
        const first = highlightMatches(target, jump.q); // 关键词整块高亮,返回第一处
        const box = (first || target).getBoundingClientRect();
        const cont = el.getBoundingClientRect();
        const delta = box.top - cont.top - el.clientHeight / 3; // 命中处落在视口上三分之一
        if (Math.abs(delta) > 2) el.scrollTop += delta;
        const h = el.scrollHeight;
        if (h === lastH) stable++;
        else {
          stable = 0;
          lastH = h;
        }
        if (stable >= 4) {
          window.setTimeout(() => target.classList.remove("search-flash"), 2400);
          return;
        }
      }
      if (Date.now() - t0 < 2000) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return () => {
      stopped = true;
    };
  }, [items, currentId]);

  useEffect(() => {
    setSuggestion(""); // 切换会话清掉上个会话的建议
  }, [currentId]);

  // 打开用量面板且当前是 Codex：拉取可用的免费限额重置次数
  useEffect(() => {
    if (!showUsage || curProviderId !== "codex") {
      setCodexResets(null);
      setResetConfirm(null);
      setResetMsg("");
      return;
    }
    window.wuwei.codexResetCredits().then((r) => {
      if (r.ok) setCodexResets({ availableCount: r.availableCount ?? 0, credits: r.credits ?? [] });
    });
  }, [showUsage, curProviderId]);
  const doConsumeReset = async (creditId: string) => {
    setResetConfirm(null);
    setResetMsg(lang === "en" ? "Resetting…" : "重置中…");
    const r = await window.wuwei.codexConsumeReset(creditId);
    if (r.ok) {
      setResetMsg(lang === "en" ? "✅ Reset! Quota refreshes after you send a message." : "✅ 已重置！发一条消息后额度会刷新。");
      const rr = await window.wuwei.codexResetCredits();
      if (rr.ok) setCodexResets({ availableCount: rr.availableCount ?? 0, credits: rr.credits ?? [] });
    } else {
      setResetMsg((lang === "en" ? "Reset failed: " : "重置失败：") + (r.error || ""));
    }
  };

  // 平台切换后拉该平台实时模型列表(/models)，并入下拉；延迟一点等主进程 applySettings 落定
  useEffect(() => {
    if (!curProviderId) return;
    const t = setTimeout(() => {
      window.wuwei.fetchModels().then((ids) => {
        if (ids && ids.length) setLiveModels((m) => ({ ...m, [curProviderId]: ids }));
      });
    }, 400);
    return () => clearTimeout(t);
  }, [curProviderId]);

  useEffect(() => {
    window.wuwei.getAccount().then(setAccount);
    window.wuwei
      .wuweiMe()
      .then((me) => {
        setWuwei(me);
        // 签到改为手动：点账号面板「签到」按钮才触发（见 doCheckin），登录不再自动签，
        // 这样点击时才真正到账并弹「+N credits」toast。
      })
      .catch(() => {});
    // 主动拉取当前后端/模型，避免 evt:ready 推送早于订阅被丢导致显示「…」
    window.wuwei.getSettings().then((r: any) => {
      if (r?.backend) setMeta((m) => ({ ...m, backend: r.backend, model: r.model || m.model }));
    });
    // 主动拉取会话列表+当前会话，避免启动推送早于监听导致空白页(需发消息才加载的bug)
    window.wuwei.bootstrap().then((r) => {
      if (!r) return;
      setSessions(r.sessions || []);
      setGroups(r.groups || []);
      if (r.currentId) setCurrentId(r.currentId);
      atBottomRef.current = true; // 初次打开：定位到最新(底部)
      setAwayFromBottom(false);
      setItems(messagesToItems(r.messages || []));
      if (r.usage) setUsage(r.usage);
      if (r.rateLimits) setRate(r.rateLimits);
      if (r.interrupted?.length) setInterruptedSessions(r.interrupted); // 上次被强杀的任务→提示恢复
    });
  }, []);

  // 崩溃恢复：点「继续」让 AI 接着未完成的工作；点「忽略」只清标记。
  function resumeInterrupted(id: string) {
    window.wuwei.resumeSession(id);
    setInterruptedSessions((l) => l.filter((x) => x.id !== id));
  }
  function dismissInterrupted(id: string) {
    window.wuwei.dismissInterrupted(id);
    setInterruptedSessions((l) => l.filter((x) => x.id !== id));
  }

  // API Key 等待态：轮询剪贴板，检测到像 key 的新内容就自动验证+设置(零手填)
  useEffect(() => {
    if (apiKeyStep !== "awaiting") return;
    const timer = setInterval(async () => {
      if (keyTestingRef.current) return;
      const clip = (await window.wuwei.readClipboard()).trim();
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
      localStorage.setItem("wuwei-sidebar-w", String(sidebarWRef.current));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function toggleCollapse(v: boolean) {
    setCollapsed(v);
    localStorage.setItem("wuwei-sidebar-collapsed", v ? "1" : "0");
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
    atBottomRef.current = true; // 发新消息=想看这轮回复：重新贴底,后续流式自动吸底(哪怕刚才滚上去看历史)
    forceBottomUntilRef.current = Date.now() + 700; // 多帧兜底吸底：AI 回复开始撑高度/异步渲染时也稳稳落到最新，不用手滚一下
    setAwayFromBottom(false);
    setRunningSet((s) => new Set(s).add(currentId)); // 乐观置为运行中(主进程随后 evt:tasks 校准)
    thinkStartRef.current = Date.now();
    charsRef.current = 0;
    turnTextRef.current = ""; // 新一轮:清掉上轮预览缓冲
    window.wuwei.send(currentId, text, imgs.length ? imgs : undefined);
  }

  // —— 智能继续：自动接话 ——
  const runningSetRef = useRef(runningSet); runningSetRef.current = runningSet;
  const inputRef = useRef(input); inputRef.current = input;
  const suggestionRef = useRef(suggestion); suggestionRef.current = suggestion;
  // 后台会话没有输入框/建议条，直接投递给它自己的 sid，不碰当前屏幕。
  // (只在最后落笔前再校验一次各种闸门，因为从收到建议到真发出去中间隔着"反悔窗口")
  const autoContinue = (sid: string, text: string) => {
    const go = (text || "").trim();
    if (!go || !sid) return;
    if (modeOf(sid) !== "cont") return; // 这期间被关掉了智能继续/点了暂停
    if (runningSetRef.current.has(sid)) return; // 它又跑起来了(用户手动发了/上一轮还没完)
    const cur = sid === currentIdRef.current;
    if (cur && inputRef.current.trim()) return; // 当前会话:你正在打字就别抢
    const n = (contBySid.current.get(sid) || 0) + 1;
    if (contMaxRef.current > 0 && n > contMaxRef.current) return; // 连推轮数封顶(0=不限)
    contBySid.current.set(sid, n);
    setRunningSet((s) => new Set(s).add(sid)); // 乐观置运行中(主进程随后 evt:tasks 校准)
    if (cur) {
      setContN(n);
      setSuggestion("");
      // 关键:自主推进≠用户意图看回复。只有你本来就贴着底时才继续吸底；
      // 你滚上去看历史时(atBottomRef=false)绝不把你拽回底部，随它在下面自己更新。
      if (atBottomRef.current) {
        forceBottomUntilRef.current = Date.now() + 700;
        setAwayFromBottom(false);
      }
      thinkStartRef.current = Date.now();
      charsRef.current = 0;
      turnTextRef.current = "";
      push({ type: "user", text: go, ts: Date.now() }); // 只有看得见的会话才画气泡
    }
    window.wuwei.send(sid, go);
  };
  // ASK 兜底倒计时：每秒减一，减到头仍然把这句发出去(智能继续下不该干等)
  useEffect(() => {
    if (suggestWait <= 0) return;
    const t = setTimeout(() => {
      if (suggestWait > 1) { setSuggestWait(suggestWait - 1); return; }
      setSuggestWait(0);
      const go = suggestionRef.current.trim();
      if (!go) return;
      lastSuggestRef.current = { text: go, canContinue: false, auto: true };
      autoContinue(currentIdRef.current, go);
    }, 1000);
    return () => clearTimeout(t);
  }, [suggestWait]);
  useEffect(() => { if (input.trim()) setSuggestWait(0); }, [input]); // 你一动手就别自动发了
  // 切会话/启动时读这个会话的总目标 + 全局红线
  useEffect(() => {
    let alive = true;
    window.wuwei.goalGet?.(currentId).then((gg) => { if (alive) setGoal(gg || null); }).catch(() => {});
    return () => { alive = false; };
  }, [currentId]);
  useEffect(() => {
    window.wuwei.stopRulesGet?.().then((tt) => setStopRules(tt || "")).catch(() => {});
    const onRules = (e: any) => setStopRules(String(e.detail || ""));
    window.addEventListener("wuwei-stop-rules", onRules);
    return () => window.removeEventListener("wuwei-stop-rules", onRules);
  }, []);
  // 设置面板改了连推安全阀 → 同步到运行时状态
  useEffect(() => {
    const onCont = (e: any) => {
      if (typeof e.detail?.max === "number") setContMax(e.detail.max);
      if (typeof e.detail?.delay === "number") setContDelay(e.detail.delay);
      if (typeof e.detail?.askSec === "number") setAskAutoSec(e.detail.askSec);
    };
    window.addEventListener("wuwei-cont-cfg", onCont);
    return () => window.removeEventListener("wuwei-cont-cfg", onCont);
  }, []);
  // 定好目标就交给它自己跑：这段话是给 AI 的工作方式约定
  function startGoal(text: string) {
    const tx = text.trim();
    if (!tx) return;
    const sid = currentId;
    window.wuwei.goalSet?.(sid, { text: tx, active: true });
    setGoal({ text: tx, active: true });
    setMode(sid, "cont"); // 自动开智能继续
    setGoalEdit(null);
    const tpl = goalPromptOf();
    doSend(tpl.includes("{目标}") ? tpl.replaceAll("{目标}", tx) : `【总目标】${tx}\n\n${tpl}`, []);
  }

  // 打开某会话的完整历史(压缩前原文 + 当前)，用聊天布局渲染
  async function openHistory(sid: string, title: string) {
    setHistoryView({ sid, title, items: [], compacted: false, loading: true });
    try {
      const r = await window.wuwei.getTranscript(sid);
      setHistoryView({ sid, title, items: messagesToItems(r.full || []), compacted: !!r.compacted, loading: false });
    } catch {
      setHistoryView({ sid, title, items: [], compacted: false, loading: false });
    }
  }

  function clearComposer() {
    setInput("");
    setPendingImages([]);
    if (taRef.current) taRef.current.style.height = "auto";
    window.wuwei.draftSet({ text: "", images: [] }); // 发送后立即清空落盘草稿
  }

  // 真正把消息投递出去(注入 or 新发)——已入库密钥由主进程兜底脱敏
  function dispatchMessage(text: string, imgs: string[], inject: boolean) {
    if (inject) {
      push({ type: "user", text, images: imgs.length ? imgs : undefined, ts: Date.now() });
      if (text) {
        history.current.push(text);
        histIdx.current = history.current.length;
      }
      window.wuwei.inject(currentId, text, imgs.length ? imgs : undefined);
    } else {
      doSend(text, imgs);
    }
  }

  // 上一条是否「被中断」：两种来源——
  //   ① 网关重连全失败后优雅收尾，会以助手正文补一句「回复「继续」…」（finish_reason=stop，不算报错）
  //   ② 客户端到网关这段自己断了 → notice 走 friendlyError 的 err.interrupted 文案
  const lastWasInterrupted = useMemo(() => {
    const last = items[items.length - 1];
    if (!last || (last.type !== "notice" && last.type !== "assistant")) return false;
    return /连接中断|被切断|回复「继续」|dropped|cut off|reply "continue"/i.test(last.text || "");
  }, [items]);

  // 被中断 → 给输入框挂「继续」幽灵提示：按 Tab 即填入（复用既有补全机制），或点提示条的「继续」直接发
  useEffect(() => {
    if (!busy && lastWasInterrupted) setSuggestion(lang === "en" ? "continue" : "继续");
  }, [busy, lastWasInterrupted, lang]);

  // override：不经过输入框直接发一句（如中断后点「继续」）。缺省仍用输入框内容。
  // 防御 typeof：万一哪个 onClick 直接写成 {submit}，传进来的是 MouseEvent，
  // 对它调 .trim() 会当场抛异常把整个界面炸成白屏——这里一律只认字符串。
  function submit(override?: string) {
    const text = (typeof override === "string" ? override : input).trim();
    if (!text && pendingImages.length === 0) return;
    if (text === "/reset") {
      window.wuwei.reset();
      setInput("");
      return;
    }
    // 未登录发任何消息 → 先弹居中的登录激励卡(免费顶级模型 + 注册得 100 无为币)，
    // 用户点「登录」再切到登录表单，比一上来就甩登录框干净、转化更好。
    // 例外：选中的是 anon(免登录免费体验)平台 → 直接放行，让未登录用户零摩擦试用。
    if (!wuwei && !curPreset?.anon) {
      setShowLoginIntro(true);
      return;
    }
    // 前置拦截仅针对「真的没额度可用」：余额≤0 且 会员周额度也没有(非会员/额度用尽)。
    // 会员本周订阅额度还有(remainingPct>0) → 放行，用量走周额度(服务端按额度扣，见网关预检)，
    // 否则付费会员余额为0会被客户端提前误拦、根本发不出请求。
    const wq = wuwei?.membership?.weeklyQuota;
    const hasWeeklyQuota = !!wq?.active && (wq.remainingPct ?? 0) > 0;
    if (curPreset?.hosted && wuwei && wuwei.coin.balance <= 0 && !hasWeeklyQuota) {
      void refreshWuweiForShortage(lang === "en" ? "Out of credits: top up to keep using Wuwei hosted models." : "无为币余额不足：请充值后再使用无为托管模型。");
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
    const scan = text ? window.wuwei.secretsScan?.(text) : undefined;
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
            await window.wuwei.secretsAdd({ name: c.suggestedName, value: c.value, note: c.note, force: true });
          } else if (choice === "overwrite") {
            await window.wuwei.secretsUpdate(c.existing.id, { note: c.note });
          } // ignore: 不动
        } else {
          if (!sp.checked[i]) continue;
          await window.wuwei.secretsAdd({ name: c.suggestedName, value: c.value, note: c.note });
        }
      }
      // 存好后重新扫描:刚入库的这批也会被替换成占位符
      try {
        outText = (await window.wuwei.secretsScan(sp.text))?.redacted ?? sp.redacted;
      } catch {
        outText = sp.redacted;
      }
    }
    setSecretPrompt(null);
    dispatchMessage(outText, sp.imgs, sp.inject);
    clearComposer();
  }

  const stop = () => window.wuwei.stop(currentId);

  // ——— 侧栏分组/排序辅助 ———
  const orderKey = (s: SessionMeta) => (s.order != null ? s.order : -s.updatedAt);
  // 相对时间(最新消息多久前)：随 now(每15s)更新
  const relTime = (ts: number): string => {
    const sec = Math.max(0, Math.floor((now - ts) / 1000));
    if (sec < 60) return t("rel.sec", "{n}秒前").replace("{n}", String(sec));
    const min = Math.floor(sec / 60);
    if (min < 60) return t("rel.min", "{n}分钟前").replace("{n}", String(min));
    const hr = Math.floor(min / 60);
    if (hr < 24) return t("rel.hour", "{n}小时前").replace("{n}", String(hr));
    const day = Math.floor(hr / 24);
    if (day < 30) return t("rel.day", "{n}天前").replace("{n}", String(day));
    const mo = Math.floor(day / 30);
    return mo < 12 ? t("rel.month", "{n}个月前").replace("{n}", String(mo)) : t("rel.year", "{n}年前").replace("{n}", String(Math.floor(mo / 12)));
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
    const en = getLang() === "en";
    if (diff <= 0) return en ? "Today" : "今天";
    if (diff === 1) return en ? "Yesterday" : "昨天";
    if (diff <= 7) return en ? "Last 7 days" : "近 7 天";
    if (diff <= 30) return en ? "Last 30 days" : "近 30 天";
    if (d.getFullYear() === now.getFullYear())
      return en ? d.toLocaleString("en-US", { month: "long" }) : `${d.getMonth() + 1} 月`;
    return en ? `${d.getFullYear()}` : `${d.getFullYear()} 年`;
  };
  const RECENT_BUCKETS = getLang() === "en" ? ["Today", "Yesterday", "Last 7 days", "Last 30 days"] : ["今天", "昨天", "近 7 天", "近 30 天"];
  const dateRank = (b: string) =>
    RECENT_BUCKETS.indexOf(b) >= 0 ? RECENT_BUCKETS.indexOf(b) : 100; // 具体月/年桶排后面，用桶内最新时间兜底排序
  // 会话所属分组(按当前模式)
  const groupOf = (s: SessionMeta): string =>
    groupMode === "date" ? dateBucket(s.updatedAt) : groupMode === "project" ? s.project || (lang === "en" ? "Uncategorized" : "未归类") : s.group || "";

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
      window.wuwei.setSessionGroup(id, target.group || null);
    window.wuwei.setSessionOrder(id, newOrder);
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
    window.wuwei.reorderGroups([...next, ...rest]);
  }

  function changeGroupMode(m: "manual" | "date" | "project") {
    setGroupMode(m);
    window.wuwei.setGroupMode(m);
  }
  function changeStream(mode: "typewriter" | "stream" | "instant", speed: number) {
    setStreamMode(mode);
    setStreamSpeed(speed);
    window.wuwei.setStreamOutput(mode, speed);
  }
  function changeKeepRecent(n: number) {
    setKeepRecent(n);
    window.wuwei.setKeepRecent(n);
  }
  function changeShowEffortPicker(v: boolean) {
    setShowEffortPicker(v);
    if (!v) setShowEffortMenu(false); // 关掉显示时顺手收起已展开的菜单
    void (async () => {
      const r = await window.wuwei.getSettings();
      window.wuwei.setSettings({ ...((r?.settings as any) || {}), showEffortPicker: v });
    })();
  }
  function changeAskToast(auto: boolean, sec: number) {
    setAskToastAuto(auto);
    setAskToastSec(sec);
    window.wuwei.setAskToast(auto, sec);
  }

  function answerPerm(decision: "allow" | "deny") {
    if (!pending) return;
    window.wuwei.respondPermission(pending.id, decision);
    setPending(null);
  }

  function allowAlways() {
    if (!pending) return;
    alwaysAllowRef.current.add(pending.name);
    localStorage.setItem("wuwei-allow", JSON.stringify([...alwaysAllowRef.current]));
    window.wuwei.respondPermission(pending.id, "allow");
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
      if (searchOpen) return; // 搜索框里在打字：y/n/a/Esc 归搜索用，别当权限快捷键
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
  }, [pending, busy, searchOpen]);

  // —— 全局搜索 ——
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const openSearch = () => {
    setSearchOpen(true);
    setSearchSel(0);
  };
  // 打开时选中上次的关键词：想接着看就直接回车，想换词直接打字即可覆盖
  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.select());
  }, [searchOpen]);
  // ⌘/Ctrl+F 打开搜索
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  // 输入防抖 300ms 再去主进程搜（首次会建索引，之后是内存里扫）
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchQ.trim();
    if (!q) {
      setSearchRes(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let dead = false;
    const t = window.setTimeout(async () => {
      try {
        const r = await window.wuwei.searchSessions(q);
        if (dead) return;
        setSearchRes(r);
        setSearchSel(0);
      } catch {
        if (!dead) setSearchRes({ hits: [], total: 0, sessions: 0, truncated: false });
      } finally {
        if (!dead) setSearching(false);
      }
    }, 300);
    return () => {
      dead = true; // 打字很快时丢掉上一次的结果，避免旧结果盖新结果
      clearTimeout(t);
    };
  }, [searchQ, searchOpen]);
  // 点某条结果：切到那个会话并滚到命中的位置（同会话则直接滚）
  const gotoHit = (hit: import("./env").SearchHit) => {
    setSearchOpen(false);
    const q = searchQ.trim();
    if (hit.anchor) jumpRef.current = { sid: hit.sid, anchor: hit.anchor, q };
    if (hit.sid !== currentIdRef.current) {
      window.wuwei.switchSession(hit.sid);
      return;
    }
    if (!hit.anchor) return; // 标题命中且就在当前会话：无需跳转
    // 已经在这个会话：主进程不会再发 session-loaded，自己触发一次跳转
    setItems((p) => [...p]);
  };

  // ——— AGI 板块:数字婴儿 操作 ———
  async function babyRefresh() {
    try {
      const [di, cu] = await Promise.all([window.wuwei.babyDiary(), window.wuwei.babyCurious()]);
      setBabyDiaryState(di || ""); setBabyCuriousState(cu || "");
    } catch { /* 轮询失败不打扰界面，下一轮再来 */ }
  }
  // 读网络图/金字塔。**故意会往外抛错**：要静默的调用点自己 .catch(()=>{})。
  async function loadBabyGraph() {
    const g = JSON.parse(await window.wuwei.babyGraph());
    setBabyGraphData({ nodes: g.nodes || [], edges: g.edges || [] });
  }
  async function loadBabyPyramid() {
    setBabyPyramid(JSON.parse(await window.wuwei.babyPyramid()));
  }
  // 「重新读取」：转圈 + 读完报「已更新 时:分:秒」+ 失败把原因显出来。
  async function reloadBabyBrain() {
    if (brainLoad.busy) return;
    setBrainLoad({ busy: true, at: 0, err: "" });
    try {
      await Promise.all([loadBabyGraph(), loadBabyPyramid()]);
      setBrainLoad({ busy: false, at: Date.now(), err: "" });
    } catch (e: any) {
      setBrainLoad({ busy: false, at: 0, err: String(e?.message || e).slice(0, 80) });
    }
  }
  // 「整理知识」：让它主动做一次深度整理(自组织重建整座金字塔)，完事刷新两个视图。
  async function babyTidyUp() {
    if (babyTidy) return;
    setBabyTidy(true);
    try {
      const note = await window.wuwei.babyReorganize();
      setBabyChatLog((l) => [...l, { role: "baby", text: `（整理完知识了）${note || ""}`, ts: Date.now() }]);
      await Promise.all([loadBabyGraph().catch(() => {}), loadBabyPyramid().catch(() => {}), babyRefresh()]);
    } finally { setBabyTidy(false); }
  }
  async function toggleBabyAlive() {
    if (babyAlive) { setBabyAlive(false); try { await window.wuwei.babyAliveStop(); } catch {} }
    else { setBabyAlive(true); try { await window.wuwei.babyAliveStart(); } catch {} }
  }
  async function babyDoChat() {
    const msg = babyChatInput.trim(); if (!msg || babyBusy) return;
    setBabyChatInput("");
    setBabyChatLog((l) => [...l, { role: "you", text: msg, ts: Date.now() }]);
    setBabyBusy("它在想…");
    try {
      const ans = await window.wuwei.babyChat(msg);
      setBabyChatLog((l) => [...l, { role: "baby", text: ans || "(没说话)", ts: Date.now() }]);
      await babyRefresh(); // 聊天可能上网学到新东西(进记忆/日志)，刷新状态区
    } finally { setBabyBusy(""); }
  }
  function createBaby() {
    setBabyExists(true); localStorage.setItem("minicc-baby-exists", "1");
    setAgiView("baby"); babyRefresh();
  }
  function deleteBaby() {
    if (!confirm("确定删除这个数字婴儿的对接吗?(不会删它的记忆数据,只从界面移除)")) return;
    setBabyExists(false); localStorage.setItem("minicc-baby-exists", "0");
    if (agiView === "baby") setAgiView(null);
  }
  function openBaby() {
    setAgiView("baby"); babyRefresh();
    // 同步"是否正在持续活着"(重开面板/重启后恢复开关状态)
    window.wuwei.babyAliveStatus().then((s: string) => { try { setBabyAlive(!!JSON.parse(s).alive); } catch {} }).catch(() => {});
  }
  // 聊天区自动吸底(新消息/它在想时滚到最新)，用户主动上滚>60px 时不打断
  useEffect(() => {
    const el = babyChatRef.current;
    if (el && babyChatStick.current) el.scrollTop = el.scrollHeight;
  }, [babyChatLog, babyBusy]);
  // AGI 板块显隐开关(设置里切换)
  useEffect(() => {
    const onToggle = (e: any) => setAgiEnabled(!!e.detail);
    window.addEventListener("wuwei-agi-toggle", onToggle);
    return () => window.removeEventListener("wuwei-agi-toggle", onToggle);
  }, []);
  // 面板打开就每 2 秒轮询：更新"它在干嘛"活动状态 + 进度；活着时每轮刷状态区，歇着每 10 轮刷一次
  useEffect(() => {
    if (agiView !== "baby") return;
    let n = 0;
    const tick = async () => {
      try {
        const j = JSON.parse(await window.wuwei.babyAliveStatus());
        setBabyActivity(j.activity || "");
        setBabyAlive(!!j.alive);
        setBabyVitals(j);
        if (j.alive || n % 10 === 0) babyRefresh();
      } catch { /* ignore */ }
      n++;
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, [agiView]);
  // 记忆网络全屏时 Esc 退出
  useEffect(() => {
    if (!brainFull) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setBrainFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [brainFull]);

  // 优先用服务端亲口报过的上限(实测值)，其次主进程按模型算的值，最后才是兜底常量
  const ctxWin = serverCtxMax || meta.ctxWindow || CTX_MAX;
  const ctxPct = Math.min(100, Math.round((usage.lastInput / ctxWin) * 100));
  const ctxWinLabel = ctxWin >= 1_000_000 ? (ctxWin / 1_000_000).toFixed(1) + "M" : Math.round(ctxWin / 1000) + "k";

  return (
    <div className={"shell" + (showBrowser && !browserDetached && browserMode === "full" ? " browser-full" : "")}>
      {/* 侧边栏：会话历史（可拖宽/可折叠） */}
      {!collapsed && (
      <div className="sidebar" style={{ width: sidebarW }}>
        <div className="sidebar-top">
          <button className="icon-btn" title={t("side.search", "搜索所有对话内容（⌘/Ctrl+F）")} onClick={openSearch}>
            <SearchIcon />
          </button>
          <button className="icon-btn" title={t("side.collapse", "收起侧栏")} onClick={() => toggleCollapse(true)}>
            «
          </button>
        </div>
        <button className="new-session" onClick={() => window.wuwei.newSession()}>
          {t("session.new")}
        </button>
        {/* AGI 板块：数字婴儿入口(迁自 minicc)。默认隐藏，设置里开 */}
        {agiEnabled && (
        <div className="agi-panel">
          <div className="agi-head" onClick={() => { const v = !agiExpanded; setAgiExpanded(v); localStorage.setItem("minicc-agi-expanded", v ? "1" : "0"); }}>
            <span className="agi-title">
              <svg className="agi-glyph" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 4.5a3 3 0 0 0-3 3 2.6 2.6 0 0 0-1.4 4.6A2.6 2.6 0 0 0 9 16.8a3 3 0 0 0 3 1.7" />
                <path d="M12 4.5a3 3 0 0 1 3 3 2.6 2.6 0 0 1 1.4 4.6A2.6 2.6 0 0 1 15 16.8a3 3 0 0 1-3 1.7" />
                <path d="M12 4.5v14" />
              </svg>
              AGI
            </span>
            <span className="agi-caret">{agiExpanded ? "▾" : "▸"}</span>
          </div>
          {agiExpanded && (
            <div className="agi-items">
              {babyExists ? (
                <div className={"agi-item" + (agiView === "baby" ? " active" : "")}>
                  <span className="agi-item-name" onClick={openBaby} title={lang === "en" ? "Open digital baby" : "点击进入数字婴儿"}>
                    <BabyGlyph />
                    {lang === "en" ? "Digital Baby" : "数字婴儿"}
                  </span>
                  <span className="agi-item-del" title={lang === "en" ? "Remove" : "删除对接"} onClick={deleteBaby}>✕</span>
                </div>
              ) : (
                <div className="agi-add" onClick={createBaby} title={lang === "en" ? "Add digital baby" : "新增并对接数字婴儿"}>＋ {lang === "en" ? "Add Digital Baby" : "新增数字婴儿"}</div>
              )}
            </div>
          )}
        </div>
        )}
        <div className="session-list">
          {sessions.length === 0 && <div className="empty">{lang === "en" ? "No conversations yet" : "暂无历史对话"}</div>}
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
                onClick={() => window.wuwei.switchSession(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setGroupInputSid(null);
                  setCtxMenu({ sid: s.id, x: e.clientX, y: e.clientY });
                }}
              >
                {runningSet.has(s.id) && <span className="s-run" title={t("thinking.running", "运行中")} />}
                {s.priorityTag && (
                  <span
                    className={"s-prio p" + (s.priority || 0)}
                    title={PRIO_TITLE[s.priorityTag] || s.priorityTag}
                  >
                    {s.priorityTag}
                  </span>
                )}
                {s.discuss && <span className="s-discuss" title={t("side.discuss", "待讨论：需过会议讨论")}>{t("side.discussBadge", "议")}</span>}
                {s.done && <span className="s-done" title={t("side.done", "已完成")}>✓</span>}
                <span className="s-title">{s.title}</span>
                <span className="s-time" title={new Date(s.updatedAt).toLocaleString()}>
                  {relTime(s.updatedAt)}
                </span>
                <button
                  className="s-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.wuwei.deleteSession(s.id);
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
              window.wuwei.setSessionGroup(ctxMenu.sid, g);
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
                    className="ctx-item ctx-ico"
                    disabled={handoffBusy}
                    onClick={async () => {
                      const sid = ctxMenu.sid;
                      close();
                      setHandoffBusy(true);
                      try {
                        const r = await window.wuwei.handoffSession(sid);
                        if (!r?.ok)
                          push({ type: "notice", text: lang === "en" ? "Handoff failed: nothing to distill from this chat" : "交接失败：该会话暂无可提炼的内容" });
                        else if (r.goalCarried && r.newId) {
                          // 源会话带总目标 → 新会话自动开智能继续，交接后接着朝目标自主推进
                          setMode(r.newId, "cont");
                          push({ type: "notice", text: lang === "en" ? "Goal carried to the new chat — smart-continue on, advancing automatically." : "已把总目标带到新对话，并自动开启智能继续，接着朝目标推进。" });
                        }
                      } finally {
                        setHandoffBusy(false);
                      }
                    }}
                    title={t("ctx.handoffTip", "总结本对话有价值的内容，生成交接文档，并开一个干净的新对话接着做(解决上下文被污染)")}
                  >
                    <HandoffIcon />
                    <span>{t("ctx.handoff", "总结并交接到新对话")}</span>
                  </button>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item ctx-ico"
                    title={lang === "en" ? "Set an overall goal for this chat; it self-decomposes and drives step by step until done" : "给这个对话定一个大目标，它自己拆解、自己一步步推进，做完为止"}
                    onClick={() => {
                      const sid = ctxMenu.sid;
                      close();
                      window.wuwei.goalGet?.(sid)
                        .then((g) => setGoalEdit({ sid, text: g?.text || "" }))
                        .catch(() => setGoalEdit({ sid, text: "" }));
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="8" />
                      <circle cx="12" cy="12" r="3.4" />
                    </svg>
                    <span>{lang === "en" ? "Set overall goal…" : "设置总目标…"}</span>
                  </button>
                  <button
                    className="ctx-item ctx-ico"
                    title={lang === "en" ? "View the full conversation including exchanges before context compaction" : "查看完整对话，包括上下文压缩前的交流(半夜自主推进跑久了也能回看)"}
                    onClick={() => {
                      const sid = ctxMenu.sid;
                      const title = sessions.find((x) => x.id === sid)?.title || (lang === "en" ? "Conversation" : "对话");
                      close();
                      openHistory(sid, title);
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a2 2 0 0 1 2 2v11.5a1.5 1.5 0 0 1-1.5 1.5H7a3 3 0 0 1-3-3V5.5z" />
                      <path d="M8 8.5h8M8 12h8M8 15.5h5" />
                    </svg>
                    <span>{lang === "en" ? "View full history…" : "查看完整历史…"}</span>
                  </button>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item ctx-ico ctx-done"
                    onClick={() => {
                      window.wuwei.setSessionDone(ctxMenu.sid, !s.done);
                      close();
                    }}
                  >
                    <DoneIcon />
                    <span>{s.done ? t("ctx.markUndone", "取消完成") : t("ctx.markDone", "标记完成")}</span>
                  </button>
                  <button
                    className="ctx-item ctx-ico ctx-discuss"
                    onClick={() => {
                      window.wuwei.setSessionDiscuss(ctxMenu.sid, !s.discuss);
                      close();
                    }}
                  >
                    <DiscussIcon />
                    <span>{s.discuss ? t("ctx.unmarkDiscuss", "取消待讨论") : t("ctx.markDiscuss", "标记待讨论")}</span>
                  </button>
                  <div className="ctx-sep" />
                  <div className="ctx-head">{t("ctx.moveToGroup", "移动到分组")}</div>
                  {groups
                    .filter((g) => g !== s.group)
                    .map((g) => (
                      <button key={g} className="ctx-item" onClick={() => move(g)}>
                        {g}
                      </button>
                    ))}
                  {s.group && (
                    <button className="ctx-item" onClick={() => move(null)}>
                      {t("ctx.moveOut", "移出「{g}」").replace("{g}", s.group)}
                    </button>
                  )}
                  {groupInputSid === ctxMenu.sid ? (
                    <input
                      className="ctx-input"
                      autoFocus
                      placeholder={t("ctx.newGroupPlaceholder", "新组名，回车创建")}
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
                      className="ctx-item ctx-ico ctx-new"
                      onClick={() => {
                        setGroupInputSid(ctxMenu.sid);
                        setNewGroupName("");
                      }}
                    >
                      <PlusIcon />
                      <span>{t("ctx.newGroup", "新建分组…")}</span>
                    </button>
                  )}
                  <div className="ctx-sep" />
                  <div className="ctx-head">{t("ctx.priority", "优先级")}</div>
                  <div className="ctx-prio">
                    <button
                      className={"ctx-prio-b" + (!s.priorityTag ? " on" : "")}
                      onClick={() => {
                        window.wuwei.setSessionPriority(ctxMenu.sid, 0, "");
                        close();
                      }}
                    >
                      {t("ctx.prioNone", "无")}
                    </button>
                    {PRIO_HL.map((p) => (
                      <button
                        key={p.tag}
                        className={"ctx-prio-b" + (s.priorityTag === p.tag ? " on" : "")}
                        onClick={() => {
                          window.wuwei.setSessionPriority(ctxMenu.sid, p.weight, p.tag);
                          close();
                        }}
                      >
                        {lang === "en" ? p.labelEn : p.label}
                      </button>
                    ))}
                  </div>
                  <div className="ctx-head">{t("ctx.quadrant", "四象限（重要/紧急）")}</div>
                  <div className="ctx-quad">
                    {PRIO_QUAD.map((p) => (
                      <button
                        key={p.tag}
                        className={"ctx-quad-b p" + p.weight + (s.priorityTag === p.tag ? " on" : "")}
                        onClick={() => {
                          window.wuwei.setSessionPriority(ctxMenu.sid, p.weight, p.tag);
                          close();
                        }}
                      >
                        {lang === "en" ? p.labelEn : p.label}
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
                  <div className="ctx-head">{lang === "en" ? `Group "${groupCtx.name}"` : `分组「${groupCtx.name}」`}</div>
                  <button
                    className="ctx-item ctx-ico ctx-new"
                    onClick={() => {
                      const ids = sessions.filter((s) => groupOf(s) === groupCtx.name).map((s) => s.id);
                      window.wuwei.generateReport(groupCtx.name, ids);
                      close();
                    }}
                  >
                    <ReportIcon />
                    <span>{lang === "en" ? "Generate daily report" : "一键生成日报"}</span>
                  </button>
                </div>
              </>
            );
          })()}
        {trash.length > 0 && (
          <button
            className="trash-entry"
            title={lang === "en" ? "Trash: deleted chats are here, restorable; auto-cleared after 7 days" : "回收站：已删除的对话在这里，可恢复；7 天后自动清除"}
            onClick={() => setShowTrash(true)}
          >
            <TrashIcon /> {lang === "en" ? "Trash" : "回收站"} <span className="trash-count">{trash.length}</span>
          </button>
        )}
        {(() => {
          const name =
            account.nickname || account.email || account.label || (account.loggedIn ? (lang === "en" ? "Signed in" : "已登录") : (lang === "en" ? "Not signed in" : "未登录"));
          return (
            <>
              {/* 下载进度：正在下载新版时显示实时百分比进度条（下载完成后由「发现新版本」药丸接替） */}
              {dlProgress && !updateReady && (
                <div style={{ padding: "0 10px", marginTop: 12, marginBottom: 4, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
                      <span>{lang === "en" ? "Downloading update…" : "正在下载更新…"}</span>
                      <span>{dlProgress.percent}%</span>
                    </div>
                    <div style={{ height: 4, borderRadius: 999, background: "var(--bg-raised)", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${dlProgress.percent}%`, background: "var(--accent)", transition: "width .2s" }} />
                    </div>
                  </div>
                </div>
              )}
              {/* 更新药丸：新版下载好即独立悬浮在账号分隔线之上（不属于账号边框）；点整卡=弹升级窗(不直接重启)，点右上角叉=关闭该版本不再提示 */}
              {updateReady && updateReady.version !== updateChipHidden && (
                <div style={{ padding: "0 10px", marginTop: 12, marginBottom: 10, position: "relative", zIndex: 1, WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                  <div
                    className="update-chip"
                    role="button"
                    onClick={() => setShowUpdateModal(true)}
                    title={lang === "en" ? `New version v${updateReady.version} available` : `发现新版本 v${updateReady.version}`}
                  >
                    <span className="update-chip__icon">
                      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 16.5V8" />
                        <path d="M8.5 11.5 12 8l3.5 3.5" />
                      </svg>
                    </span>
                    <span className="update-chip__text">
                      <span className="update-chip__title">{lang === "en" ? "New version" : "发现新版本"}</span>
                      <span className="update-chip__ver">v{updateReady.version}</span>
                    </span>
                    <span className="update-chip__arrow">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </span>
                    <button
                      className="update-chip__x"
                      onClick={(e) => { e.stopPropagation(); const v = updateReady.version; setUpdateChipHidden(v); try { localStorage.setItem("wuwei_dismissed_update_chip", v); } catch {} }}
                      title={lang === "en" ? "Dismiss" : "关闭"}
                      aria-label={lang === "en" ? "Dismiss" : "关闭"}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            <div className="sidebar-foot">
              {/* 订阅版入口（C2 占位）：默认隐藏，仅当后端 flags 含 "subscription" 才出现。
                  后台可按用户名/机器指纹对指定客户端单独放开——判定全在后端，客户端只渲染。 */}
              {showSubscription && (
                <button
                  onClick={() => push({ type: "notice", text: lang === "en" ? "Subscription entry (rollout enabled). Subscription page/benefits coming soon." : "订阅版入口（灰度已放开）。具体订阅页/权益后续接入。" })}
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
                  <span style={{ color: "#C05F3C" }}>✨</span> {lang === "en" ? "Subscription" : "订阅版"}
                </button>
              )}
              <button className="acct-btn" onClick={() => setShowAcctMenu((v) => {
                const next = !v;
                // 打开菜单时顺手拉一次最新账号/余额/会员/周额度（后台改了这里也能立刻看到）
                if (next && wuwei) window.wuwei.wuweiMe().then((m) => { if (m) setWuwei(m); }).catch(() => {});
                return next;
              })}>
                <div className={"acct-av" + (wuwei ? "" : " off")}>
                  {/* 未登录的头像首字也要跟语言：中文「游」/英文 G，别让英文界面里冒出个汉字 */}
                  <UserAvatar
                    url={wuwei?.user.avatar}
                    fallback={(wuwei?.user.name || wuwei?.user.email || t("acct.guestInitial", "游")).slice(0, 1).toUpperCase()}
                  />
                </div>
                <div
                  className="acct-name"
                  title={wuwei ? wuwei.user.name || wuwei.user.email || (lang === "en" ? "Wuwei user" : "无为用户") : t("acct.notLoggedIn")}
                >
                  {wuweiBusy ? (lang === "en" ? "Signing in…" : "登录中…") : wuwei ? wuwei.user.name || wuwei.user.email || (lang === "en" ? "Wuwei user" : "无为用户") : t("acct.guest")}
                </div>
                <span className="acct-caret">⋯</span>
              </button>
              {showAcctMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowAcctMenu(false)} />
                  <div className="acct-menu">
                    {/* 无为账号（与模型商账号合并进同一入口）。未登录只给登录入口，设置等登录后才显示 */}
                    {wuwei ? (
                      (() => {
                        const tier = wuwei.membership?.tier ?? "free";
                        const isPro = tier !== "free";
                        // 徽标/会员条：主标显档位名(Pro/Plus/Max，后端按套餐档给)，档位(月付/年付)作小灰字
                        const tierMain = tier === "free" ? (lang === "en" ? "Free" : "免费版") : (wuwei.membership?.plan || "Pro");
                        const tierQual = tier === "pro_year" ? (lang === "en" ? "yearly" : "年付") : tier === "pro_month" ? (lang === "en" ? "monthly" : "月付") : "";
                        const tierLabel = tierMain + (tierQual ? " " + tierQual : "");
                        const exp = wuwei.membership?.expireAt;
                        const expStr = exp ? new Date(exp).toISOString().slice(0, 10) : "";
                        // 快到期(≤7天)才提示到期日 + 续费按钮；刚买还早就别催，只显「生效中」
                        const daysLeft = exp ? Math.ceil((new Date(exp).getTime() - Date.now()) / 86400000) : Infinity;
                        const nearExpiry = daysLeft <= 7;
                        const bal = wuwei.coin.balance;
                        const openPack = () => { setShowAcctMenu(false); setCoinPackOpen(true); }; // 充值→购买积分包弹窗
                        const openPlan = () => { setShowAcctMenu(false); setPlanOpen(true); }; // 开通/续费→升级套餐弹窗
                        // 已登录但没昵称/邮箱时的兜底首字：中文取「无」(无为)，英文取 W
                        const initial = (wuwei.user.name || wuwei.user.email || t("acct.userInitial", "无")).slice(0, 1).toUpperCase();
                        const Spark = () => (
                          <svg className="acct-spark" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path d="M8 1.4l1.5 5.1 5.1 1.5-5.1 1.5L8 14.6 6.5 9.5 1.4 8l5.1-1.5z" />
                          </svg>
                        );
                        return (
                          <>
                            {/* 身份区：头像(Pro金光晕) + 昵称 + tier chip + 邮箱 */}
                            <div className="acct-id">
                              <div className={"acct-avatar" + (isPro ? " pro" : "")}>
                                <UserAvatar url={wuwei.user.avatar} fallback={initial} />
                              </div>
                              <div className="acct-id-txt">
                                <div className="acct-nm">
                                  <span className="acct-name">{wuwei.user.name || wuwei.user.email || (lang === "en" ? "Wuwei user" : "无为用户")}</span>
                                  {/* 顶部 chip 只显 Pro/Free 主标；月付/年付档位交给下方会员卡，避免同一行重复又过长 */}
                                  <span className={"acct-tier " + (isPro ? "pro" : "free")}>
                                    {isPro && <Spark />}
                                    {tierMain}
                                  </span>
                                </div>
                                {wuwei.user.email && <div className="acct-mail">{wuwei.user.email}</div>}
                              </div>
                            </div>

                            {/* 无为币钱包卡 */}
                            <div className="acct-wallet">
                              <div className="acct-wallet-row">
                                <div>
                                  <div className="acct-wallet-lbl">
                                    <CoinIcon size={14} /> {t("usage.coinBal", "无为币余额")}
                                  </div>
                                  <div className="acct-bal">
                                    {bal.toLocaleString()}
                                  </div>
                                </div>
                                {bal <= 0 && !isPro && (
                                  <button className="acct-topup" onClick={openPack}>
                                    {lang === "en" ? "Top up" : "充值"}
                                  </button>
                                )}
                              </div>
                              {bal > 0 || isPro ? (
                                <button
                                  type="button"
                                  className={"acct-checkin" + (checkinDone ? " done" : "")}
                                  disabled={checkinDone || checkinBusy}
                                  onClick={doCheckin}
                                  title={
                                    checkinDone
                                      ? t("menu.checkedInTitle", "今日已签到")
                                      : isPro
                                        ? t("menu.hintProGift", "会员每月赠币 · 每日签到再领更多")
                                        : t("menu.hintDailyCheckin", "每日签到领 10 无为币")
                                  }
                                >
                                  {checkinBusy ? <span className="acct-checkin-spin" aria-hidden="true" /> : checkinDone ? <CheckinDoneIcon size={13} /> : <CheckinIcon size={13} />}
                                  <span>{checkinBusy ? t("menu.checkinBusy", "签到中…") : checkinDone ? t("menu.checkedInShort", "已签到") : t("menu.checkinShort", "签到")}</span>
                                </button>
                              ) : (
                                <div className="acct-hint zero">{t("menu.hintTopup", "充值解锁更多对话额度")}</div>
                              )}
                            </div>

                            {/* 会员条：Pro 平时不显(顶部 chip 已标档位，避免重复)，仅快到期(≤7天)时作续费提醒出现；免费=靛青升级引导 */}
                            {isPro ? (
                              nearExpiry ? (
                                <div className="acct-memb on">
                                  <div>
                                    <div className="acct-memb-ttl">
                                      <Spark /> {tierMain}{tierQual && <span className="acct-tier-q">{tierQual}</span>}
                                    </div>
                                    <div className="acct-memb-sub">
                                      {lang === "en" ? `Expires ${expStr}` : `${expStr} 到期`}
                                    </div>
                                  </div>
                                  <button className="acct-renew" onClick={openPlan}>
                                    {lang === "en" ? "Renew" : "续费"}
                                  </button>
                                </div>
                              ) : null
                            ) : bal <= 0 ? (
                              // 只在无为币用完(余额=0)后才推会员——自然的升级时机，不打扰仍有币的用户
                              <div className="acct-memb up" onClick={openPlan}>
                                <div>
                                  <div className="acct-memb-ttl">
                                    <span className="acct-crown">
                                      <Spark />
                                    </span>{" "}
                                    {lang === "en" ? "Upgrade to Pro" : "开通 Pro 会员"}
                                  </div>
                                  <div className="acct-memb-sub">{lang === "en" ? "More quota · better value · from $6.99/mo" : "更多额度 · 更省 · ¥29/月起"}</div>
                                </div>
                                <span className="acct-go">{lang === "en" ? "Upgrade now" : "立即开通"}</span>
                              </div>
                            ) : null}

                            <div className="acct-sep" />
                            <div className="acct-items">
                              <button className="acct-it" onClick={openPack}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="3" y="5" width="18" height="14" rx="2.5" />
                                  <path d="M3 10h18M7 15h4" />
                                </svg>
                                {t("menu.donate", "充值")}
                              </button>
                              {/* 消息中心：奖励到账/活动/系统/反馈回复通知；有未读标红点 */}
                              <button
                                className="acct-it"
                                onClick={() => {
                                  setShowAcctMenu(false);
                                  setShowMsgCenter(true);
                                }}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                                  <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                                </svg>
                                <span style={{ flex: 1, textAlign: "left", whiteSpace: "nowrap" }}>{lang === "en" ? "Messages" : "消息中心"}</span>
                                {msgUnread > 0 && (
                                  <span style={{ flex: "0 0 auto", fontSize: 10, fontWeight: 700, color: "#fff", background: "#E5484D", borderRadius: 999, padding: "1px 6px", minWidth: 16, textAlign: "center", whiteSpace: "nowrap" }}>
                                    {msgUnread > 99 ? "99+" : msgUnread}
                                  </span>
                                )}
                              </button>
                              <button
                                className="acct-it"
                                onClick={() => {
                                  setShowAcctMenu(false);
                                  setSettingsTab("general");
                                  setShowSettings(true);
                                }}
                              >
                                <GearIcon size={16} />
                                {t("acct.settings")}
                              </button>
                              <button
                                className="acct-it"
                                onClick={() => {
                                  setShowAcctMenu(false);
                                  setShowSupport(true);
                                }}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
                                  <rect x="3" y="13" width="4" height="6" rx="1.5" />
                                  <rect x="17" y="13" width="4" height="6" rx="1.5" />
                                  <path d="M20 19a4 4 0 0 1-4 4h-2" />
                                </svg>
                                {t("menu.contactSupport", "联系客服")}
                              </button>
                              {/* 留言反馈：直接开留言弹窗（被采纳有奖）；与客服弹窗内「直接留言」共用同一表单 */}
                              <button
                                className="acct-it"
                                onClick={() => {
                                  setShowAcctMenu(false);
                                  setLeaveMsgFromSupport(false);
                                  setShowLeaveMsg(true);
                                }}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M21 11.5a8.5 8.5 0 0 1-11.7 7.9L4 20l1.4-4A8.5 8.5 0 1 1 21 11.5z" />
                                  <path d="M8.5 11.5h7M8.5 8.5h4" />
                                </svg>
                                {t("menu.feedback", "留言反馈")}
                              </button>
                              {/* 帮助 · 检查更新：平时只显「更新」，有新版才标小红点；点击弹窗看结果/版本信息 */}
                              <button className="acct-it" onClick={() => (updateReady ? (setShowAcctMenu(false), setShowUpdateModal(true)) : checkUpdateNow())}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <circle cx="12" cy="12" r="9" />
                                  <path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 2.5" />
                                  <circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
                                </svg>
                                <span style={{ flex: 1, textAlign: "left", whiteSpace: "nowrap" }}>{lang === "en" ? "Updates" : "更新"}</span>
                                {hasUpdate && (
                                  <span style={{ flex: "0 0 auto", fontSize: 10, fontWeight: 700, color: "#fff", background: "#E5484D", borderRadius: 999, padding: "1px 6px", whiteSpace: "nowrap" }}>
                                    {lang === "en" ? "new" : "新"}
                                  </span>
                                )}
                              </button>
                              <button
                                className="acct-it danger"
                                onClick={() => {
                                  setShowAcctMenu(false);
                                  void doWuweiLogout();
                                }}
                              >
                                <LogoutIcon size={16} />
                                {t("acct.logout")}
                              </button>
                            </div>
                          </>
                        );
                      })()
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
                            { k: "claude", n: "Claude" },
                            { k: "gpt", n: "GPT" },
                            { k: "deepseek", n: "DeepSeek" },
                            { k: "kimi", n: "Kimi" },
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
                          {lang === "zh" ? "新用户送 100 无为币" : "New users get 100 credits"}
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
            </>
          );
        })()}
        <div className="resizer" onMouseDown={startResize} />
      </div>
      )}

      {/* 主区 */}
      <div className="main">
        {/* 数字婴儿面板(迁自 minicc)：agiView==="baby" 时占据主区 */}
        {agiView === "baby" && (
          <div className="baby-panel">
            <div className="baby-header">
              {babyTab === "home" && (
                <button className="baby-rail-btn" title={babyLeftOpen ? "收起状态面板" : "展开状态面板"}
                  onClick={() => { const v = !babyLeftOpen; setBabyLeftOpen(v); localStorage.setItem("minicc-baby-left", v ? "1" : "0"); }}>
                  {babyLeftOpen ? <Ic.IcPanelLeft size={17} /> : <Ic.IcPanelRight size={17} />}
                </button>
              )}
              <span className="baby-brand">
                <span className="by-mark"><Ic.IcBaby size={17} /></span>
                数字婴儿
                <span className="baby-brand-sub">{babyVitals.age || "—"} · {babyVitals.mood || "—"}</span>
              </span>
              <div className="baby-tabs">
                <button className={"baby-tab" + (babyTab === "home" ? " on" : "")} onClick={() => setBabyTab("home")}>
                  <Ic.IcHome size={15} />主界面
                </button>
                <button className={"baby-tab" + (babyTab === "brain" ? " on" : "")}
                  onClick={() => { setBabyTab("brain"); void reloadBabyBrain(); }}>
                  <Ic.IcBrain size={15} />记忆网络
                </button>
              </div>
              <button className="baby-close" onClick={() => setAgiView(null)} title="返回对话">
                <Ic.IcBack size={15} />返回
              </button>
            </div>
            {babyTab === "brain" ? (
              <div className={"baby-brain" + (brainFull ? " fs" : "")}>
                <div className="baby-brain-bar">
                  <div className="by-seg">
                    <button className={brainView === "graph" ? "on" : ""} onClick={() => { setBrainView("graph"); loadBabyGraph().catch(() => {}); }}>
                      <Ic.IcNodes size={14} />网络图
                    </button>
                    <button className={brainView === "pyramid" ? "on" : ""} onClick={() => { setBrainView("pyramid"); loadBabyPyramid().catch(() => {}); }}>
                      <Ic.IcPyramid size={14} />金字塔
                    </button>
                  </div>
                  <div className="by-brain-stats">
                    <span><b>{babyGraphData.nodes.length}</b> 概念</span>
                    <span><b>{babyGraphData.edges.length}</b> 关联</span>
                    {!!babyPyramid?.stats && (
                      <>
                        <span><b>{babyPyramid.stats.depth}</b> 层</span>
                        <span><b>{babyPyramid.stats.loose}</b> 没固化</span>
                      </>
                    )}
                    {/* 读取反馈：数字不变时页面看不出差别，靠这行区分"读到了但没变" vs "根本没读到" */}
                    {brainLoad.err ? (
                      <span className="by-load-err" title={brainLoad.err}>读取失败：{brainLoad.err}</span>
                    ) : brainLoad.at > 0 ? (
                      <span className="by-load-ok">已更新 {new Date(brainLoad.at).toLocaleTimeString()}</span>
                    ) : null}
                  </div>
                  <button className="by-tidy ghost" style={{ marginLeft: "auto" }}
                    onClick={() => setBrainFull((v) => !v)} title={brainFull ? "退出全屏 (Esc)" : "全屏看"}>
                    {brainFull ? <Ic.IcShrink size={14} /> : <Ic.IcExpand size={14} />}
                    {brainFull ? "退出全屏" : "全屏"}
                  </button>
                  {brainFull && (
                    <button className="by-tidy ghost" title="回到对话"
                      onClick={() => { setBrainFull(false); setAgiView(null); }}>
                      <Ic.IcBack size={14} />返回对话
                    </button>
                  )}
                  <button className="by-tidy ghost" data-busy-self="1" disabled={babyTidy || brainLoad.busy}
                    onClick={() => void reloadBabyBrain()} title="重新读一遍当前的网络/金字塔">
                    <span className={brainLoad.busy ? "by-spin" : ""} style={{ display: "flex" }}><Ic.IcRefresh size={14} /></span>
                    {brainLoad.busy ? "读取中…" : "重新读取"}
                  </button>
                  <button className="by-tidy" data-busy-self="1" disabled={babyTidy} onClick={babyTidyUp}
                    title="让它把学过的东西重新自组织成一座金字塔(会真的改变塔的形状，要跑一会儿)">
                    <span className={babyTidy ? "by-spin" : ""} style={{ display: "flex" }}><Ic.IcSparkle size={14} /></span>
                    {babyTidy ? "整理中…" : "整理知识"}
                  </button>
                </div>
                <div className="baby-brain-canvas">
                  {brainView === "graph" ? (
                    <>
                      <BabyBrainGraph nodes={babyGraphData.nodes} edges={babyGraphData.edges} />
                      {babyGraphData.nodes.length === 0 && (
                        <div className="baby-brain-empty">它还没学到概念～让它活着或者跟它聊聊，这里就会长出知识网络</div>
                      )}
                    </>
                  ) : (
                    <BabyPyramid data={babyPyramid} />
                  )}
                </div>
                <div className="baby-brain-tip">
                  <Ic.IcSparkle size={12} />
                  {brainView === "graph"
                    ? "位置=语义远近(意思相近的自然抱团) · 大小=层级与连接数(睡梦涌现的上层认知更大) · 虚线=抽象自 · 悬停看详情、拖动钉住、滚轮缩放"
                    : "从上往下：塔尖 → 各层抽象 → 地基(它一个个学来的概念) · 虚线框=还没被收编进任何上层的碎知识"}
                </div>
              </div>
            ) : (
            <div className="baby-body">
              {babyLeftOpen ? (
              <div className="baby-left">
                <div className="baby-card">
                  <div className="by-card-head" onClick={() => toggleCard("status")}>
                    <span className="by-card-ico"><Ic.IcPulse size={15} /></span>
                    <span className="by-card-t">状态</span>
                    <span className="by-card-meta">{babyAlive ? "活着" : "歇着"}</span>
                    <span className={"by-caret" + (babyCards.status ? "" : " off")}><Ic.IcChevron size={15} /></span>
                  </div>
                  {babyCards.status && (
                    <div className="by-card-body">
                      <BabyHero vitals={babyVitals} alive={babyAlive} activity={babyActivity}
                        busy={babyBusy} onToggleAlive={toggleBabyAlive} />
                    </div>
                  )}
                </div>
                <div className="baby-card">
                  <div className="by-card-head" onClick={() => toggleCard("curious")}>
                    <span className="by-card-ico"><Ic.IcSprout size={15} /></span>
                    <span className="by-card-t">它好奇的</span>
                    <span className="by-card-meta">{babyVitals.curiosity ?? 0}</span>
                    <span className={"by-caret" + (babyCards.curious ? "" : " off")}><Ic.IcChevron size={15} /></span>
                  </div>
                  {babyCards.curious && (
                    <div className="by-card-body">
                      <AutoStickPre className="baby-pre baby-scroll" text={babyCurious || "(暂无)"} />
                    </div>
                  )}
                </div>
                <div className="baby-card">
                  <div className="by-card-head" onClick={() => toggleCard("diary")}>
                    <span className="by-card-ico"><Ic.IcJournal size={15} /></span>
                    <span className="by-card-t">成长日志</span>
                    <span className="by-card-meta">{babyVitals.ticks ?? 0} 跳</span>
                    <span className={"by-caret" + (babyCards.diary ? "" : " off")}><Ic.IcChevron size={15} /></span>
                  </div>
                  {babyCards.diary && (
                    <div className="by-card-body">
                      <AutoStickPre className="baby-pre baby-scroll" text={babyDiary || "(暂无)"} />
                    </div>
                  )}
                </div>
              </div>
              ) : (
              <div className="baby-rail" title="展开状态面板">
                <button className="baby-rail-btn" onClick={() => { setBabyLeftOpen(true); localStorage.setItem("minicc-baby-left", "1"); }}>
                  <Ic.IcPanelRight size={17} />
                </button>
                <BabyAvatar state={inferBabyState(babyActivity, babyAlive)} happiness={babyVitals.happiness ?? 55}
                  energy={babyVitals.energy ?? 100} alive={babyAlive} size={32} minimal />
                <span className={"baby-rail-dot" + (babyAlive ? " live" : "")} />
                <span className="baby-rail-vert">{babyAlive ? "活着" : "歇着"}</span>
              </div>
              )}
              <div className="baby-right">
                <div className="by-chat-head">
                  <span className="by-card-ico"><Ic.IcChat size={15} /></span>跟它聊天
                </div>
                <div className="by-thread" ref={babyChatRef}
                  onScroll={(e) => { const el = e.currentTarget; babyChatStick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
                  {babyChatLog.length === 0 && (
                    <div className="by-empty">
                      <div className="by-empty-art">
                        <BabyAvatar state={inferBabyState(babyActivity, babyAlive)} happiness={babyVitals.happiness ?? 55}
                          energy={babyVitals.energy ?? 100} alive={babyAlive} size={88} />
                      </div>
                      问问它学了什么、对什么好奇、心情怎么样
                      <br />
                      它听不懂的会自己上网去查，然后记住
                    </div>
                  )}
                  {babyChatLog.map((m, i) =>
                    m.role === "you" ? (
                      <div className="by-turn user-block" key={i}>
                        <div className="msg user"><div className="body">{m.text}</div></div>
                        <div className="turn-foot user">
                          <div className="tf-actions"><CopyBtn text={m.text} /></div>
                          {!!m.ts && <span className="tf-time">{relTime(m.ts, now)}</span>}
                        </div>
                      </div>
                    ) : (
                      <div className="by-turn" key={i}>
                        <AssistantMsg text={m.text} />
                        <div className="turn-foot">
                          <div className="tf-actions"><CopyBtn text={m.text} /></div>
                          {!!m.ts && <span className="tf-time">{relTime(m.ts, now)}</span>}
                        </div>
                      </div>
                    ),
                  )}
                  {!!babyBusy && (
                    <div className="by-turn">
                      <span className="by-typing"><i /><i /><i /></span>
                    </div>
                  )}
                </div>
                <div className="by-composer">
                  <div className="input-wrap">
                    <textarea
                      rows={1}
                      value={babyChatInput}
                      placeholder="跟它说点什么…（Enter 发送，Shift+Enter 换行）"
                      onChange={(e) => {
                        setBabyChatInput(e.target.value);
                        e.target.style.height = "auto";
                        e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          babyDoChat();
                          (e.target as HTMLTextAreaElement).style.height = "auto";
                        }
                      }}
                    />
                    <button className={"send-btn" + (babyChatInput.trim() && !babyBusy ? " active" : "")}
                      onClick={babyDoChat} disabled={!babyChatInput.trim() || !!babyBusy} title="发送 (Enter)">
                      <Ic.IcSend size={18} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
            )}
          </div>
        )}
        <div
          className={
            "titlebar" +
            (collapsed && window.wuwei.platform === "darwin" ? " tb-collapsed" : "")
          }
        >
          <span className="tb-title">
            <WuweiMark />
            {(() => {
              const st = sessions.find((s) => s.id === currentId)?.title;
              // 还没生成智能标题(仍是默认「新对话/New chat」)就显示品牌名，跟随界面语言
              const isDefault = !st || st === "新对话" || st === "New chat";
              return isDefault ? (lang === "en" ? "Wuwei" : "无为") : st;
            })()}
          </span>
          <span className="tb-spacer" />
          {showBrowser && browserDetached && (
            <span className="tb-browser-wrap">
              <button
                className="tb-browser"
                title={t("hdr.browserDetached", "浏览器（独立窗口）")}
                onClick={() => setShowBrowserMenu((v) => !v)}
              >
                <svg
                  className="tb-browser-ico"
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <rect
                    x="1.6"
                    y="2.6"
                    width="12.8"
                    height="10.8"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <path d="M1.6 5.7h12.8" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="4" cy="4.15" r="0.62" fill="currentColor" />
                  <circle cx="6.1" cy="4.15" r="0.62" fill="currentColor" />
                </svg>
                <span className="tb-caret">▾</span>
              </button>
              {showBrowserMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowBrowserMenu(false)} />
                  <div className="tb-browser-menu">
                    <button
                      onClick={() => {
                        setBrowserMode("split");
                        window.wuwei.browserReattach();
                        setShowBrowserMenu(false);
                      }}
                    >
                      {lang === "en" ? "Dock to split" : "收回为半屏"}
                    </button>
                    <button
                      onClick={() => {
                        setBrowserMode("full");
                        window.wuwei.browserReattach();
                        setShowBrowserMenu(false);
                      }}
                    >
                      {lang === "en" ? "Dock to full" : "收回为全屏"}
                    </button>
                    <button
                      className="tb-bm-close"
                      onClick={() => {
                        window.wuwei.browserReattach();
                        setShowBrowser(false);
                        setShowBrowserMenu(false);
                      }}
                    >
                      {lang === "en" ? "Close browser" : "关闭浏览器"}
                    </button>
                  </div>
                </>
              )}
            </span>
          )}
          {window.wuwei.platform !== "darwin" && (
            <span className="win-ctrl">
              <button className="wc-btn" title={t("win.minimize", "最小化")} onClick={() => window.wuwei.winMinimize()}>
                ─
              </button>
              <button className="wc-btn" title={t("win.maximize", "最大化")} onClick={() => window.wuwei.winMaximize()}>
                ☐
              </button>
              <button
                className="wc-btn wc-close"
                title={t("win.close", "关闭")}
                onClick={() => window.wuwei.winClose()}
              >
                ✕
              </button>
            </span>
          )}
        </div>

        {collapsed && (
          <div className="toolbar-min">
            <button className="icon-btn" title={t("side.expand", "展开侧栏")} onClick={() => toggleCollapse(false)}>
              »
            </button>
            <button className="icon-btn" title={t("side.search", "搜索所有对话内容（⌘/Ctrl+F）")} onClick={openSearch}>
              <SearchIcon />
            </button>
          </div>
        )}

        <div
          className="stream"
          ref={streamRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 只认"真的贴着底"(留 48px 容差抵消行高取整/惯性回弹)。
            // 早先按"距底一屏"算贴底，结果往上滚半屏看历史会被下一段流式输出硬拽回底部，上面的内容就看不成了。
            // 强制窗内的滚动来自"切会话/发消息后内容异步撑高"，不是用户意图——
            // 此时若按当帧位置判定，会把 atBottomRef 误写成 false，兜底吸底就全被挡掉了。
            if (Date.now() < forceBottomUntilRef.current) return;
            const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
            if (atBottomRef.current !== atBottom) setAwayFromBottom(!atBottom); // 只在跨越边界时 setState，滚动中不空转渲染
            atBottomRef.current = atBottom;
          }}
        >
          {items.length === 0 && (
            <div className="welcome">
              <div className="wc-hero">
                <WuweiLogo size={58} />
                <p className="wc-eyebrow">{lang === "en" ? "One intention, everything follows" : "一念既出，万事自成"}</p>
                <h1 className="wc-h1">
                  {lang === "en" ? "One sentence, and " : "一句话，让 "}
                  <span className="wc-spark">{lang === "en" ? "AI gets it done" : "AI 替你干活"}</span>
                </h1>
                <p className="wc-lead">
                  {lang === "en"
                    ? "Describe what you need and AI breaks it into tasks, calls AI Agents, runs the steps, and brings back results. Great for coding, editing docs, research, organizing files, and running workflows."
                    : "把需求说清楚，AI 会拆解任务、调用 AI Agent、执行步骤并回收结果。适合写代码、改文档、查资料、整理文件、跑流程。"}
                </p>
                <div className="wc-feats">
                  {[
                    { zh: "免费开始", en: "Free to start", path: <><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" /><circle cx="7" cy="7" r="1.3" /></> },
                    { zh: "切换顶级模型", en: "Switch top models", path: <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></> },
                    { zh: "秒级响应", en: "Instant responses", path: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /> },
                    // 国内直连仅中文版显示（对海外用户无意义）
                    ...(lang === "en" ? [] : [{ zh: "国内直连", en: "Fast in China", path: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z" /></> }]),
                  ].map((f) => (
                    <span className="wc-feat" key={f.zh}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{f.path}</svg>
                      {lang === "en" ? f.en : f.zh}
                    </span>
                  ))}
                </div>
              </div>
              <div className="wc-flow">
                <div className="wc-step">
                  <em>{lang === "en" ? "You ask" : "你说"}</em>
                  <b>{lang === "en" ? "Say what you want done" : "说出你想完成的事"}</b>
                </div>
                <span className="wc-arrow" aria-hidden="true">→</span>
                <div className="wc-step">
                  <em>{lang === "en" ? "AI works" : "AI 做"}</em>
                  <b>{lang === "en" ? "AI Agents break it down, call tools, run it" : "AI Agent 拆解任务、调用工具、自动执行"}</b>
                </div>
                <span className="wc-arrow" aria-hidden="true">→</span>
                <div className="wc-step">
                  <em>{lang === "en" ? "You get" : "交付"}</em>
                  <b>{lang === "en" ? "Results, file paths, how to verify" : "拿到结果、文件路径、验证方法"}</b>
                </div>
              </div>
              {/* 脑网络入口 + 特性标签：先隐藏（改 false→true 即恢复） */}
              {false && (
                <>
                  <button className="wc-brain" onClick={() => setShowBrainIntro(true)} title={t("wc.brainTitle", "了解脑网络")}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2 3 3 0 0 0 5-2v-3.2A3.5 3.5 0 0 0 16 7a4 4 0 0 0-4-4Z" />
                    </svg>
                    <span className="wc-brain-tx">
                      <b>{lang === "en" ? "Brain" : "脑网络"}</b>
                      {lang === "en" ? " keeps learning · long-term memory that knows you better the more you use it" : "持续学习 · 长期记忆，用得越久无为越懂你"}
                    </span>
                    <svg className="wc-brain-arr" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 3l5 5-5 5" />
                    </svg>
                  </button>
                  <div className="wc-tags">{lang === "en" ? "Fewer steps · no interruptions · results-first · traceable execution" : "少步骤 · 不中断 · 结果导向 · 可追溯执行"}</div>
                </>
              )}
            </div>
          )}
          {(() => {
            const turns = groupTurns(items);
            let userOrd = -1; // 已见的用户输入序号(与主进程 messages 里的用户输入一一对应)
            // 上一 AI 回合末的累计用量，用于算本轮增量(输入/输出/缓存命中/新增/步数)
            let prevCum = { totalInput: 0, totalOutput: 0, totalCacheHit: 0, totalCacheMiss: 0, totalSteps: 0 };
            const canDel = !busy; // 运行中不允许删(历史正在变)
            const delExchange = (ord: number) => {
              if (ord < 0) return;
              window.wuwei.deleteExchange(currentId, ord);
            };
            // 撤回一条用户消息(像微信撤回)：收回 + 文字放回输入框可改可重发
            const recallUser = async (it: Extract<Item, { type: "user" }>, ord: number) => {
              if (busy) {
                // 运行中：只有还没被 AI 处理(仍在注入缓冲)的才能干净撤回
                const ok = await window.wuwei.recallInject(currentId, it.text);
                if (ok) {
                  setItems((p) => p.filter((x) => x !== it));
                  setInput((cur) => cur || it.text);
                } else {
                  push({
                    type: "notice",
                    text: lang === "en" ? "This message is already being processed and can't be retracted; press Esc to stop, then undo to edit." : "这条已开始处理，无法撤回；可按 Esc 停止后再撤回编辑。",
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
                      onResend={busy ? undefined : () => doSend(uItem.text, uItem.images || [])}
                    />
                  );
                }
                return <ItemView key={i} item={t.item} now={now} />;
              }
              const ord = userOrd; // AI 回合归属最近一条用户输入这一轮
              const aiTs = aiTurnTs(t.blocks);
              const lastTurn = i === turns.length - 1; // 只有最后一个回合可能正在流
              // 本轮 token = 本轮末累计 − 上轮末累计(输入含每步重发上下文的真实消耗)；上下文=最近一次请求输入量
              const endCum = aiTurnUsage(t.blocks);
              let tok:
                | { inT: number; outT: number; steps: number; hit: number; miss: number; split: boolean }
                | undefined;
              if (endCum?.round) {
                // 本轮自足值:缓存命中/真正新增各自独立,单价能分开算,不受历史污染
                const r = endCum.round;
                tok = { inT: r.input, outT: r.output, steps: r.steps, hit: r.cacheHit, miss: r.cacheMiss, split: true };
                prevCum = {
                  totalInput: endCum.totalInput,
                  totalOutput: endCum.totalOutput,
                  totalCacheHit: endCum.totalCacheHit ?? 0,
                  totalCacheMiss: endCum.totalCacheMiss ?? 0,
                  totalSteps: endCum.totalSteps ?? 0,
                };
              } else if (endCum) {
                // 旧快照(无 round):只能按累计做差给总量,缓存拆分不可靠→不显示
                tok = {
                  inT: Math.max(0, endCum.totalInput - prevCum.totalInput),
                  outT: Math.max(0, endCum.totalOutput - prevCum.totalOutput),
                  steps: Math.max(0, (endCum.totalSteps ?? 0) - prevCum.totalSteps),
                  hit: 0,
                  miss: 0,
                  split: false,
                };
                prevCum = {
                  totalInput: endCum.totalInput,
                  totalOutput: endCum.totalOutput,
                  totalCacheHit: endCum.totalCacheHit ?? prevCum.totalCacheHit,
                  totalCacheMiss: endCum.totalCacheMiss ?? prevCum.totalCacheMiss,
                  totalSteps: endCum.totalSteps ?? prevCum.totalSteps,
                };
              }
              return (
                <div className="aiturn" key={i}>
                  <div className="aiturn-body">
                    {t.blocks.map((b, j) =>
                      b.kind === "item" ? (
                        <AssistantMsg
                          key={j}
                          text={(b.item as Extract<Item, { type: "assistant" }>).text}
                          anchor={(b.item as Extract<Item, { type: "assistant" }>).anchor}
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
                        <button className="tf-icon del" title={makeT(getLang())("msg.delete", "删除这轮问答(含提问与回复)")} onClick={() => delExchange(ord)}>
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                    {aiTs && (
                      <span className="tf-time" title={new Date(aiTs).toLocaleString()}>
                        {relTime(aiTs)}
                      </span>
                    )}
                    {tok && (
                      <span className="tf-tok">
                        <span className="tf-tok-badge">
                          {/* ↑ 显示「新增输入」(真正新花的·贵)，不显示总输入(含缓存重发的累计，看着大但没意义)；
                              无 round 明细的旧快照才回退到总输入。完整拆分见悬浮面板。 */}
                          {tok.steps > 0 ? `${tok.steps}${lang === "en" ? " steps" : "步"} · ` : ""}↑{fmtTok(tok.split ? tok.miss : tok.inT)} ↓{fmtTok(tok.outT)}
                        </span>
                        <span className="tf-tok-pop">
                          {tok.steps > 0 && (
                            <span>
                              <b>{lang === "en" ? "Steps this turn" : "本次步数"}</b>
                              <em>{tok.steps}{lang === "en" ? "" : " 步"}</em>
                            </span>
                          )}
                          {tok.steps > 0 && (
                            <span>
                              <b>{lang === "en" ? "Context per step" : "每步上下文"}</b>
                              <em>≈{fmtTok(Math.round(tok.inT / tok.steps))}{lang === "en" ? " (avg)" : "（平均）"}</em>
                            </span>
                          )}
                          {tok.split ? (
                            // 有缓存拆分：突出「新增输入」(真花钱)，总输入/缓存命中降为淡色副行(折叠感)
                            <>
                              <span className="tf-tok-div" style={{ fontWeight: 600 }}>
                                <b>{lang === "en" ? "New input" : "新增输入"}</b>
                                <em style={{ color: "var(--accent, #C05F3C)", fontWeight: 700 }}>{tok.miss.toLocaleString()}{lang === "en" ? " (costly)" : "（花钱）"}</em>
                              </span>
                              <span className="tf-tok-sub" style={{ opacity: 0.55 }}>
                                <b>{lang === "en" ? "· Total input" : "· 总输入"}</b>
                                <em>{tok.inT.toLocaleString()}</em>
                              </span>
                              <span className="tf-tok-sub" style={{ opacity: 0.55 }}>
                                <b>{lang === "en" ? "· Cache hit" : "· 缓存命中"}</b>
                                <em>{tok.hit.toLocaleString()}{lang === "en" ? " (cheap)" : "（便宜）"}</em>
                              </span>
                            </>
                          ) : (
                            <span className="tf-tok-div">
                              <b>{lang === "en" ? "Total input" : "总输入"}</b>
                              <em>{tok.inT.toLocaleString()}</em>
                            </span>
                          )}
                          <span style={{ fontWeight: 600 }}>
                            <b>{lang === "en" ? "New output" : "新增输出"}</b>
                            <em style={{ color: "var(--accent, #C05F3C)", fontWeight: 700 }}>{tok.outT.toLocaleString()}</em>
                          </span>
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              );
            });
          })()}
          {busy && !pending && (
            <ThinkingBar startRef={thinkStartRef} charsRef={charsRef} textRef={turnTextRef} items={items} />
          )}
        </div>

        {/* 离底时才出现：一键回到最新并恢复自动跟随(不点就一直停在你正看的位置) */}
        {awayFromBottom && (
          <button
            className="to-bottom"
            title={t("stream.toBottom", "回到最新")}
            onClick={() => {
              const el = streamRef.current;
              if (!el) return;
              el.scrollTo({ top: el.scrollHeight });
              atBottomRef.current = true;
              setAwayFromBottom(false);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </button>
        )}

        <div className="composer" ref={composerRef}>
          {/* 鉴权提示条：检测到缺授权后常驻，直到授权成功或用户手动 × 关闭 */}
          {needAuth && !authDismissed && (
            <div className="err-fix err-auth">
              <button className="err-close" title={makeT(getLang())("msg.close", "关闭")} onClick={() => setAuthDismissed(true)}>
                ×
              </button>
              {curPreset?.kind === "anthropic-oauth" ? (
                // Claude 订阅：一键 OAuth
                oauthStep === "awaiting-code" ? (
                  <>
                    <span>{lang === "en" ? "🔑 After approving in the browser, paste the code here → (leave blank to auto-read clipboard):" : "🔑 浏览器同意后，复制页面上的授权码 →（留空则自动读剪贴板）："}</span>
                    <div className="err-auth-actions">
                      <input
                        className="code-input"
                        value={codeInput}
                        onChange={(e) => setCodeInput(e.target.value)}
                        placeholder={t("authbar.pasteCodePh", "粘贴授权码（可留空自动读剪贴板）")}
                      />
                      <button className="allow" onClick={completeBrowserAuth} disabled={authBusy}>
                        {authBusy ? (lang === "en" ? "Verifying…" : "校验中…") : (lang === "en" ? "Complete authorization" : "完成授权")}
                      </button>
                      <button onClick={() => setOauthStep("idle")} disabled={authBusy}>
                        {lang === "en" ? "Back" : "返回"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span>{lang === "en" ? "🔑 Claude subscription needs authorization. Sign in with one click:" : "🔑 Claude 订阅需要授权才能使用，可一键登录授权："}</span>
                    <div className="err-auth-actions">
                      <button className="allow" onClick={authorizeBrowser} disabled={authBusy}>
                        {lang === "en" ? "Sign in via browser (recommended · reuse logged-in account)" : "用浏览器登录（推荐·复用已登录账号）"}
                      </button>
                      <button onClick={authorizeWindow} disabled={authBusy}>
                        {authBusy ? (lang === "en" ? "Authorizing…" : "授权中…") : (lang === "en" ? "Sign in in-app" : "应用内登录")}
                      </button>
                      <button onClick={() => setShowSettings(true)}>{lang === "en" ? "Set key in Settings" : "去设置填 Key"}</button>
                    </div>
                  </>
                )
              ) : curPreset?.kind === "codex" ? (
                // Codex 订阅：应用内一键 ChatGPT 授权(无需本机 codex CLI)
                <>
                  <span>
                    {lang === "en" ? <>🔑 Codex subscription needs ChatGPT login. Click <b>One-click authorize</b> below to open your system browser and sign in to ChatGPT (no local codex needed).</> : <>🔑 Codex 订阅需要 ChatGPT 登录。点下方<b>一键授权</b>，会开系统浏览器登录 ChatGPT（本机无需装 codex）。</>}
                  </span>
                  <div className="err-auth-actions">
                    <button className="allow" onClick={doCodexLogin} disabled={codexBusy}>
                      {codexBusy ? (lang === "en" ? "Authorizing… (finish login in browser)" : "授权中…（浏览器完成登录）") : (lang === "en" ? "One-click authorize (ChatGPT login)" : "一键授权（ChatGPT 登录）")}
                    </button>
                  </div>
                </>
              ) : apiKeyStep === "awaiting" ? (
                // 已打开官网，等复制 key：自动检测剪贴板 + 可手动粘贴
                <>
                  <span>
                    {lang === "en" ? <>🔑 Opened the sign-up page. <b>Copy your API Key and it's auto-detected and set</b>, or paste it below and click done:</> : <>🔑 已打开获取页面。<b>复制 API Key 后会自动检测并设置</b>，也可粘贴到下方点完成：</>}
                  </span>
                  <div className="err-auth-actions">
                    <input
                      className="code-input"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder={t("authbar.keyDetectPh", "复制 Key 后自动检测；或粘贴到此")}
                      disabled={apiKeyBusy}
                    />
                    <button className="allow" onClick={() => tryApiKey(apiKeyInput)} disabled={apiKeyBusy}>
                      {apiKeyBusy ? (lang === "en" ? "Detecting…" : "检测中…") : (lang === "en" ? "Finish setup" : "完成设置")}
                    </button>
                    <button onClick={() => setApiKeyStep("idle")} disabled={apiKeyBusy}>
                      {lang === "en" ? "Back" : "返回"}
                    </button>
                  </div>
                </>
              ) : (
                // API Key 平台（通义千问 / DeepSeek / OpenAI / 智谱 …）：引导去各自官网拿 key
                <>
                  <span>
                    {t("authbar.platformNeedKey", "🔑 当前平台「{name}」需要配置 API Key 才能使用。").replace("{name}", String(curPreset ? pLabel(curPreset, lang) : meta.backend))}
                  </span>
                  <div className="err-auth-actions">
                    {curPreset?.keyUrl ? (
                      <button className="allow" onClick={startApiKeyFlow}>
                        {lang === "en" ? `Get an API Key for ${pLabel(curPreset, lang)} ↗` : `去获取 ${curPreset.label} 的 API Key ↗`}
                      </button>
                    ) : (
                      <button className="allow" onClick={() => setApiKeyStep("awaiting")}>
                        {lang === "en" ? "Paste API Key" : "粘贴 API Key"}
                      </button>
                    )}
                    <button onClick={() => setShowSettings(true)}>{lang === "en" ? "Set key in Settings" : "去设置填 Key"}</button>
                  </div>
                </>
              )}
            </div>
          )}
          {/* 非鉴权类错误：中断类主推「继续」（一键从中断处接着做），其它错误仍给「删除这条」。
              注意判断要中英都认——英文界面的报错以 "Error" 开头，旧代码只认「出错」，导致英文下这条提示条从不出现。 */}
          {!busy &&
            !needAuth &&
            items.length > 0 &&
            items[items.length - 1].type === "notice" &&
            /^(出错|Error)/.test((items[items.length - 1] as { type: "notice"; text: string }).text) && (
              <div className="err-fix">
                {lastWasInterrupted ? (
                  <>
                    <span>{t("err.fix.interrupted", "上一条回复被中断了")}</span>
                    <button className="primary" onClick={() => submit(lang === "en" ? "continue" : "继续")}>
                      {t("err.fix.continue", "继续")}
                    </button>
                  </>
                ) : (
                  <>
                    <span>{lang === "en" ? "The last message errored (may block further sends)" : "上一条消息出错了（可能卡住后续发送）"}</span>
                    <button onClick={() => window.wuwei.undoLast()}>{lang === "en" ? "Delete it and continue" : "删除这条并继续"}</button>
                  </>
                )}
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
          {goal && (
            <div className={"goal-bar" + (goal.active ? " on" : "") + (goal.done ? " done" : "")}>
              <span className="goal-ico">{goal.done ? "✓" : "◎"}</span>
              <span className="goal-text" title={goal.text}>{goal.text}</span>
              {goal.active ? (
                <>
                  <span className="goal-state">{lang === "en" ? "advancing" : "自主推进中"}{modeOf(currentId) === "cont" && contN > 0 ? (lang === "en" ? ` · step ${contN}` : ` · 第 ${contN} 步`) : ""}</span>
                  <button
                    onClick={() => {
                      const g = { text: goal.text, active: false, done: goal.done };
                      window.wuwei.goalSet?.(currentId, g);
                      setGoal(g);
                      setMode(currentId, "auto"); // 暂停 = 回到自动，不再替你接话
                    }}
                  >
                    {lang === "en" ? "Pause" : "暂停"}
                  </button>
                </>
              ) : (
                <>
                  {goal.done && <span className="goal-state">{lang === "en" ? "done" : "已完成"}</span>}
                  <button
                    className="on"
                    onClick={() => {
                      const g = { text: goal.text, active: true, done: false };
                      window.wuwei.goalSet?.(currentId, g);
                      setGoal(g);
                      setMode(currentId, "cont");
                      doSend(lang === "en" ? "Keep advancing toward the overall goal; continue where we left off." : "继续朝总目标推进，接着上次没做完的往下做。", []);
                    }}
                  >
                    {goal.done ? (lang === "en" ? "Restart" : "重新开始") : (lang === "en" ? "Resume" : "继续")}
                  </button>
                </>
              )}
              <button onClick={() => setGoalEdit({ sid: currentId, text: goal.text })}>{lang === "en" ? "Edit" : "改"}</button>
              {!goal.done && (
                <button
                  title={lang === "en" ? "Mark this goal as achieved" : "标记这个目标已达成（目标本身会一直留着，要清掉请到「改」里删除）"}
                  onClick={() => {
                    const g = { text: goal.text, active: false, done: true };
                    window.wuwei.goalSet?.(currentId, g);
                    setGoal(g);
                    setMode(currentId, "auto");
                  }}
                >
                  {lang === "en" ? "✓ Done" : "✓ 完成"}
                </button>
              )}
            </div>
          )}
          {suggestion && input === "" && (
            <div
              className="suggest-bar"
              title={t("suggest.title", "点击直接发送 · Tab 填入输入框再改")}
              onClick={() => {
                // 点击=一步到位直接发；想先改的走 Tab 填入输入框
                const s = suggestion;
                setSuggestion("");
                submit(s);
              }}
            >
              <svg className="suggest-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a6 6 0 0 0-3.4 10.9c.5.4.9 1 1 1.6h4.8c.1-.6.5-1.2 1-1.6A6 6 0 0 0 12 3z" />
                <path d="M9.6 18.5h4.8M10.5 21h3" />
              </svg>
              <span className="suggest-text">{suggestion}</span>
              {suggestWait > 0 ? (
                <button
                  className="suggest-wait"
                  title={lang === "en" ? "Smart-continue judged this a low-risk question; it will auto-send when the countdown ends. Click to wait for you." : "智能继续：这条判成想问你一句，但没碰红线，倒数完还是会自动发。点这里改成等你。"}
                  onClick={(e) => { e.stopPropagation(); setSuggestWait(0); }}
                >
                  {lang === "en" ? `auto-send in ${suggestWait}s · click to wait` : `${suggestWait}s 后自动发 · 点这等我`}
                </button>
              ) : (
                <span className="suggest-key">{modeOf(currentId) === "cont" ? (lang === "en" ? "smart-continue" : "智能继续中") : t("suggest.key", "Tab 填入")}</span>
              )}
              <button
                className="suggest-x"
                title={t("suggest.dismiss", "关闭建议")}
                aria-label={t("suggest.dismiss", "关闭建议")}
                onClick={(e) => {
                  e.stopPropagation(); // 别冒泡到整条(那会直接发送)
                  setSuggestWait(0); // 智能继续:关掉建议同时取消自动发送倒计时
                  setSuggestion("");
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 5l14 14M19 5L5 19" />
                </svg>
              </button>
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
              <button className="send-btn stop" onClick={stop} title={t("composer.stop", "停止")}>
                <span className="stop-sq" />
              </button>
            ) : (
              <button
                className={"send-btn" + (input.trim() || pendingImages.length ? " active" : "")}
                onClick={() => submit()} // 必须包一层：直接 onClick={submit} 会把 MouseEvent 当 override 传进去
                title={t("composer.send", "发送 (Enter)")}
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
                title={t("conn.lightTitle", "连通状态（点击查看）")}
                onClick={() => setShowConn((v) => !v)}
              />
              {showConn && (
                <>
                  <div className="mq-overlay" onClick={() => setShowConn(false)} />
                  <div className="conn-pop">
                    <div className="conn-pop-title">
                      <span className={`conn-dot conn-${conn.status}`} />
                      {conn.status === "green"
                        ? (lang === "en" ? "Connected" : "已连通")
                        : conn.status === "yellow"
                          ? (lang === "en" ? "Errors — not fully connected" : "有报错，未完全连通")
                          : conn.status === "red"
                            ? (lang === "en" ? "Not connected / not configured" : "未连通 / 未配置")
                            : (lang === "en" ? "Checking…" : "检测中…")}
                    </div>
                    <p className="conn-pop-reason">{conn.reason}</p>
                    <div className="conn-pop-actions">
                      <button
                        onClick={() => {
                          setShowConn(false);
                          void runConnCheck();
                        }}
                      >
                        {lang === "en" ? "Re-check" : "重新检测"}
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
                          {conn.status === "red" ? (lang === "en" ? "Configure / authorize" : "去配置 / 授权") : (lang === "en" ? "Resolve" : "去解决")}
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="mode-mini" title={modeOf(currentId) === "manual" ? t("mode.manualTip") : modeOf(currentId) === "cont" ? (lang === "en" ? "Smart-continue: auto-approve + keep advancing toward the goal after each turn" : "智能继续：自动放行权限 + 跑完一轮自己朝目标接着推进") : t("mode.autoTip")}>
              {(showManual || modeOf(currentId) === "manual") && (
                <button className={modeOf(currentId) === "manual" ? "on" : ""} onClick={() => setMode(currentId, "manual")}>
                  {t("mode.manual")}
                </button>
              )}
              <button className={modeOf(currentId) === "auto" ? "on" : ""} onClick={() => setMode(currentId, "auto")}>
                {t("mode.auto")}
              </button>
              <button className={modeOf(currentId) === "cont" ? "on" : ""} onClick={() => setMode(currentId, "cont")}>
                {lang === "en" ? "Smart-continue" : "智能继续"}
              </button>
            </div>

            {/* 脑网络后台进度：索引构建 / 概念抽取，实时可见，点击进设置查看 */}
            {(idxProg?.building || conProg?.running) && (
              <button
                className="brain-prog"
                title={t("brainprog.title", "点击打开脑网络")}
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
                    ? (lang === "en" ? `Index · scanning ${idxProg.files} docs` : `索引·扫描 ${idxProg.files} 文档`)
                    : (lang === "en" ? `Index ${idxProg.done}/${idxProg.total || "…"} chunks` : `索引 ${idxProg.done}/${idxProg.total || "…"} 块`)
                  : (lang === "en" ? `Extract ${conProg?.done}/${conProg?.total}` : `抽概念 ${conProg?.done}/${conProg?.total}`)}
              </button>
            )}

            <div className="model-quick">
              <button
                className="mq-btn mq-prov"
                title={curPreset ? pLabel(curPreset, lang) : meta.backend}
                onClick={(e) => {
                  openMqMenu(e);
                  setShowProviderMenu((v) => !v);
                }}
              >
                <span className="mq-txt">{(curPreset ? pLabel(curPreset, lang) : meta.backend).replace(/（.*$/, "").replace(/\s*\(.*$/, "")}</span>
                <span className="mq-caret">▾</span>
              </button>
              <span className="mq-mid">·</span>
              <button
                className="mq-btn mq-mod"
                title={meta.model}
                onClick={(e) => {
                  // 访客门禁：未登录且当前不是免费体验 → 点模型也引导登录
                  if (!wuwei && !curPreset?.anon) { setShowLoginIntro(true); return; }
                  openMqMenu(e);
                  setShowModelMenu((v) => !v);
                }}
              >
                <span className="mq-txt">{MODEL_LABEL_OVERRIDES[meta.model] || modelLabels.get(meta.model) || meta.model}</span>
                <span className="mq-caret">▾</span>
              </button>
              {/* 思考档位：只对支持 effort 的模型出现（Claude 4.5+/Sonnet 5、GPT-5、o 系）。
                  档位越高思考越深，也越慢越贵；时长受限时降档能明显提高「一次跑完」的概率。 */}
              {showEffortPicker && EFFORT_MODELS.test(meta.model) && (
                <>
                  <span className="mq-mid">·</span>
                  <button
                    className="mq-btn mq-eff"
                    title={t("eff.title", "思考档位：越高越深入，也越慢越贵")}
                    onClick={(e) => {
                      openMqMenu(e);
                      setShowEffortMenu((v) => !v);
                    }}
                  >
                    <span className="mq-txt">{effortLabel(effort, lang)}</span>
                    <span className="mq-caret">▾</span>
                  </button>
                </>
              )}
              {showEffortMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowEffortMenu(false)} />
                  <div className="mq-menu mq-menu-eff" style={{ left: mqMenuLeft }}>
                    <div className="mq-head">{t("eff.head", "思考档位")}</div>
                    {EFFORT_OPTIONS.map((o) => (
                      <button
                        key={o.id}
                        className={"mq-item mq-item-col" + (o.id === effort ? " on" : "")}
                        onClick={() => {
                          setEffort(o.id);
                          setShowEffortMenu(false);
                          void (async () => {
                            const r = await window.wuwei.getSettings();
                            window.wuwei.setSettings({ ...((r?.settings as any) || {}), effort: o.id });
                          })();
                        }}
                      >
                        <span className="mq-item-main">
                          {lang === "en" ? o.en : o.zh}
                          {o.id === effort && <span className="mq-check">✓</span>}
                        </span>
                        <span className="mq-item-sub">{lang === "en" ? o.enDesc : o.zhDesc}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {showProviderMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowProviderMenu(false)} />
                  <div className="mq-menu mq-menu-prov" style={{ left: mqMenuLeft }}>
                    <div className="mq-head">{lang === "en" ? "Switch provider" : "切换平台"}</div>
                    {providerList.map((p) => (
                      <button
                        key={p.id}
                        className={"mq-item" + (p.id === curProviderId ? " on" : "")}
                        onClick={() => quickProvider(p)}
                      >
                        <span>{pLabel(p, lang)}</span>
                        {p.id === curProviderId && <span className="mq-check">✓</span>}
                      </button>
                    ))}
                    <div className="mq-sep" />
                    <button
                      className="mq-item mq-more"
                      onClick={() => {
                        setShowProviderMenu(false);
                        if (!wuwei) { setShowLoginIntro(true); return; } // 访客：全部供应商设置需登录
                        setSettingsTab("platforms");
                        setShowSettings(true);
                      }}
                    >
                      {t("mq.allProviders", "全部供应商设置…")}
                    </button>
                  </div>
                </>
              )}
              {showModelMenu && (
                <>
                  <div className="mq-overlay" onClick={() => setShowModelMenu(false)} />
                  <div className="mq-menu" style={{ left: mqMenuLeft }}>
                    <div
                      className="mq-head"
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t("mq.switchModel", "切换模型")} · {curPreset ? pLabel(curPreset, lang) : meta.backend}
                      </span>
                      {hasMoreModels && (
                        <span style={{ display: "inline-flex", gap: 2, flex: "0 0 auto" }}>
                          {[
                            { k: false, t: lang === "en" ? "Common" : "常用" },
                            { k: true, t: lang === "en" ? "All" : "全部" },
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
                    {shownModels.length === 0 && <div className="mq-empty">{lang === "en" ? "No preset models — add one in Settings" : "无预设模型，去设置里填"}</div>}
                    {shownModels.map((m) => (
                      <button
                        key={m}
                        className={"mq-item" + (m === meta.model ? " on" : "")}
                        onClick={() => quickModel(m)}
                      >
                        <span>
                          {MODEL_LABEL_OVERRIDES[m] || modelLabels.get(m) || m}
                          {freeModelIds.has(m) && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 10,
                                padding: "1px 5px",
                                borderRadius: 4,
                                background: "#1f9d55",
                                color: "#fff",
                                verticalAlign: "middle",
                              }}
                            >
                              {lang === "en" ? "Free" : "免费"}
                            </span>
                          )}
                          {modelBadges.get(m) && modelBadges.get(m)!.toLowerCase() !== "free" && (
                            <span
                              style={{ marginLeft: 6, fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "#e8722c", color: "#fff", verticalAlign: "middle" }}
                            >
                              {modelBadges.get(m)}
                            </span>
                          )}
                        </span>
                        {m === meta.model && <span className="mq-check">✓</span>}
                      </button>
                    ))}
                    <div className="mq-sep" />
                    <button
                      className="mq-item mq-more"
                      onClick={() => {
                        setShowModelMenu(false);
                        if (!wuwei) { setShowLoginIntro(true); return; } // 访客：全部设置/换平台需登录
                        setSettingsTab("model");
                        setShowSettings(true);
                      }}
                    >
                      {t("mq.allSettings", "全部设置 / 换平台…")}
                    </button>
                  </div>
                </>
              )}
            </div>

            <span className="foot-spacer" />

            <span
              className="foot-status"
              title={t("foot.statusTitle", "运行状态 · 本轮上下文 token · 订阅额度(5小时/周)或余额。点击看详情")}
              onClick={() => setShowUsage((v) => !v)}
            >
              <span
                className={"fs-hit" + (busy || runningSet.size > 0 ? " fs-busy" : "") + (runningSet.size > 0 ? " fs-clickable" : "")}
                title={runningSet.size > 0 ? (lang === "en" ? "Click to view/stop running tasks" : "点击查看/停止运行中的任务") : undefined}
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
              <span className="fs-extra fs-hit">
                <span>
                  {t("foot.context")} {(usage.lastInput / 1000).toFixed(1)}k
                </span>
                {meta.sub && rate && typeof rate.primaryUsedPercent === "number" && (
                  <>
                    <span className="fs-dot">·</span>
                    {(rate.primaryWindowMinutes ?? 300) >= 1440 ? (
                      // 主窗口已是周尺度(Codex 168h)：只显示一个「周」用量，不再摆短窗口
                      <span>{lang === "en" ? "Week" : "周"} {rate.primaryUsedPercent}%</span>
                    ) : (
                      <>
                        <span>{lang === "en" ? "5h" : "5小时"} {rate.primaryUsedPercent}%</span>
                        <span className="fs-dot">·</span>
                        <span>{lang === "en" ? "Week" : "周"} {rate.secondaryUsedPercent ?? 0}%</span>
                      </>
                    )}
                  </>
                )}
                {!meta.sub && account.balance && (
                  <>
                    <span className="fs-dot">·</span>
                    <span>
                      {account.balance.total
                        ? (lang === "en" ? `Balance ¥${account.balance.total}` : `余额 ${account.balance.total} 元`)
                        : (lang === "en" ? `Spent ¥${account.balance.consumed}` : `已消耗 ${account.balance.consumed} 元`)}
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
              <div className="tp-head">{lang === "en" ? `Running tasks (${runningSet.size})` : `运行中的任务（${runningSet.size}）`}</div>
              {[...runningSet].map((sid) => {
                const meta = sessions.find((s) => s.id === sid);
                const title = meta?.title || (sid === currentId ? (lang === "en" ? "Current chat" : "当前会话") : (lang === "en" ? "Untitled chat" : "未命名会话"));
                return (
                  <div key={sid} className={"tp-item" + (sid === currentId ? " cur" : "")}>
                    <span className="tp-dot" />
                    <span
                      className="tp-title"
                      title={t("tasks.switchTo", "切换到该会话")}
                      onClick={() => {
                        if (sid !== currentId) window.wuwei.switchSession(sid);
                        setShowTasks(false);
                      }}
                    >
                      {title}
                    </span>
                    <button
                      className="tp-stop"
                      title={t("tasks.stopThis", "停止该任务")}
                      onClick={() => window.wuwei.stop(sid)}
                    >
                      {lang === "en" ? "Stop" : "停止"}
                    </button>
                  </div>
                );
              })}
              <div className="tp-foot">
                <button className="tp-stopall" onClick={() => [...runningSet].forEach((s) => window.wuwei.stop(s))}>
                  {lang === "en" ? "Stop all" : "全部停止"}
                </button>
              </div>
            </div>
          </>
        )}

        {showUsage && (
          <div className="usage-panel">
            <div className="u-row">
              <span>{t("usage.ctxWindow", "上下文窗口")}</span>
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
                  title={t("usage.webLoginTitle", "登录对应网站授权后自动刷新余额/额度")}
                  onClick={async () => {
                    if (webLoginBusy) return;
                    setWebLoginBusy(true);
                    await window.wuwei.webLogin(account.providerId!);
                    setWebLoginBusy(false);
                  }}
                >
                  <span>
                    {account.providerId === "kimi-sub"
                      ? account.expired
                        ? t("usage.quotaExpired", "额度登录已过期")
                        : t("usage.quotaNoLogin", "额度未登录")
                      : account.expired
                        ? t("usage.balExpired", "余额登录已过期")
                        : t("usage.balNoLogin", "余额未登录")}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {webLoginBusy ? t("usage.loggingIn", "登录中…") : t("usage.clickLogin", "点此登录")}
                    <RefreshIcon size={13} />
                  </span>
                </div>
              )}

            {meta.sub && rate ? (
              // 订阅类后端(Codex/Claude)：显示 5小时/周额度
              <>
                {rate.planType && (
                  <div className="u-row">
                    <span>{t("usage.plan", "订阅套餐")}</span>
                    <span style={{ textTransform: "capitalize" }}>
                      {rate.planType}
                      {rate.creditsUnlimited ? t("usage.unlimited", " · 无限") : ""}
                    </span>
                  </div>
                )}
                {typeof rate.primaryUsedPercent === "number" && (
                  <LimitRow
                    // 主窗口≥24h(如 Codex 现在的 168h=7天)：本身就是周尺度，直接标「周限额」，不再单列短窗口
                    label={(rate.primaryWindowMinutes ?? 300) >= 1440 ? t("limit.weekly", "周限额") : windowLabel(rate.primaryWindowMinutes)}
                    used={rate.primaryUsedPercent}
                    resetSec={rate.primaryResetAfterSeconds}
                  />
                )}
                {(rate.primaryWindowMinutes ?? 300) < 1440 && typeof rate.secondaryUsedPercent === "number" && (
                  <LimitRow
                    label={t("limit.weekly", "周限额")}
                    used={rate.secondaryUsedPercent}
                    resetSec={rate.secondaryResetAfterSeconds}
                  />
                )}
                {curProviderId === "codex" && codexResets && codexResets.availableCount > 0 && (
                  <div className="u-reset">
                    <div className="u-row">
                      <span>{t("usage.limitReset", "限额重置")}</span>
                      <span>{t("usage.availCount", "可用 {n} 次").replace("{n}", String(codexResets.availableCount))}</span>
                    </div>
                    {codexResets.credits
                      .filter((c) => c.status === "available")
                      .map((c) => (
                        <div key={c.id} className="u-reset-item">
                          <div className="u-reset-info">
                            <span className="u-reset-title">{c.title || "Full reset"}</span>
                            {c.expires_at && (
                              <span className="u-reset-exp">{t("usage.expiresOn", "{d} 到期").replace("{d}", new Date(c.expires_at).toLocaleDateString())}</span>
                            )}
                          </div>
                          {resetConfirm === c.id ? (
                            <span className="u-reset-confirm">
                              {t("usage.useThis", "用掉这次？")}
                              <button className="allow" onClick={() => doConsumeReset(c.id)}>
                                {t("usage.confirm", "确认")}
                              </button>
                              <button onClick={() => setResetConfirm(null)}>{lang === "en" ? "Cancel" : "取消"}</button>
                            </span>
                          ) : (
                            <button className="u-reset-btn" onClick={() => setResetConfirm(c.id)}>
                              {t("usage.useReset", "使用重置")}
                            </button>
                          )}
                        </div>
                      ))}
                    {resetMsg && <div className="u-reset-msg">{resetMsg}</div>}
                  </div>
                )}
                <div className="u-note">{t("usage.subNote", "数据来自订阅额度（发一条消息后刷新）。")}</div>
              </>
            ) : curPreset?.hosted || curProviderId.startsWith("wuwei-") ? (
              // 无为托管：显示无为币余额（未登录则引导登录）
              wuwei ? (
                <>
                  {wuwei.membership?.weeklyQuota?.active ? (() => {
                    // 订阅版：隐藏无为币余额，只显本周「已用百分比」进度条(用多少涨多少) + 重置日
                    const wq = wuwei.membership!.weeklyQuota!;
                    const usedPct = Math.max(0, Math.min(100, 100 - wq.remainingPct));
                    const rd = wq.resetsAt ? new Date(wq.resetsAt) : null;
                    const rs = rd ? (lang === "en" ? rd.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : `${rd.getMonth() + 1}月${rd.getDate()}日`) : "";
                    return (
                      <div style={{ margin: "2px 0 4px" }}>
                        <div className="u-row" style={{ marginBottom: 4 }}>
                          <span>{lang === "en" ? "This week" : "本周额度"}</span>
                          <span>{lang === "en" ? `${usedPct}% used${rs ? ` · resets ${rs}` : ""}` : `已用 ${usedPct}%${rs ? ` · ${rs} 重置` : ""}`}</span>
                        </div>
                        <div className="u-bar"><div className="u-fill" style={{ width: usedPct + "%" }} /></div>
                      </div>
                    );
                  })() : (
                    <div className="u-row">
                      <span>{t("usage.coinBal", "无为币余额")}</span>
                      <span>{t("usage.coinAmount", "{n} 无为币").replace("{n}", wuwei.coin.balance.toLocaleString())}</span>
                    </div>
                  )}
                  <div className="u-row">
                    <span>{t("usage.sessTokens", "本会话 tokens")}</span>
                    <span>
                      ↑{usage.totalInput.toLocaleString()} ↓{usage.totalOutput.toLocaleString()}
                    </span>
                  </div>
                  {/* 订阅版隐藏「按token扣无为币」说明——不让订阅用户感知币数 */}
                  {!wuwei.membership?.weeklyQuota?.active && (
                    <div className="u-note">{t("usage.hostedNote", "无为托管按 token×单价扣无为币（余额随对话刷新）。")}</div>
                  )}
                </>
              ) : curPreset?.anon ? (
                // 免登录免费体验：不显余额，给零摩擦提示 + 登录解锁引导
                <div
                  className="u-row"
                  style={{ color: "#C05F3C", cursor: "pointer", alignItems: "center" }}
                  onClick={() => {
                    setLoginResume(false);
                    setShowLoginForm(true);
                  }}
                >
                  <span>{t("usage.freeTrial", "免费体验中 · 每日有限次数")}</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{t("usage.loginUnlock", "登录解锁更多 →")}</span>
                </div>
              ) : (
                <div
                  className="u-row"
                  style={{ color: "#C05F3C", cursor: "pointer", alignItems: "center" }}
                  onClick={() => {
                    setLoginResume(false);
                    setShowLoginForm(true);
                  }}
                >
                  <span>{t("usage.coinBal", "无为币余额")}</span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{t("usage.loginToView", "登录后查看 · 点此登录")}</span>
                </div>
              )
            ) : account.balance ? (
              // 计费类后端(DeepSeek 等)：显示账户余额 + 本会话已消耗
              <>
                {account.balance.total && (
                  <div className="u-row">
                    <span>{t("usage.acctBal", "账户余额")}</span>
                    <span>{t("usage.yuanAmount", "{n} 元").replace("{n}", String(account.balance.total))}</span>
                  </div>
                )}
                {account.balance.consumed && (
                  <div className="u-row">
                    <span>{t("usage.sessConsumed", "本会话已消耗")}</span>
                    <span>≈ {t("usage.yuanAmount", "{n} 元").replace("{n}", String(account.balance.consumed))}</span>
                  </div>
                )}
                <div className="u-row">
                  <span>{t("usage.sessTokens", "本会话 tokens")}</span>
                  <span>
                    ↑{usage.totalInput.toLocaleString()} ↓{usage.totalOutput.toLocaleString()}
                  </span>
                </div>
                <div className="u-note">
                  {account.balance.total
                    ? t("usage.balNote", "余额实时来自 {label} 账户（每轮对话后刷新）。").replace("{label}", account.label ?? "")
                    : t("usage.consumeNote", "消耗按 token×单价估算（每轮对话后刷新）。")}
                </div>
              </>
            ) : (
              // 无额度/无余额信息：显示 token 统计
              <>
                <div className="u-row">
                  <span>{t("usage.totalIn", "本会话累计输入")}</span>
                  <span>{usage.totalInput.toLocaleString()} tokens</span>
                </div>
                <div className="u-row">
                  <span>{t("usage.totalOut", "本会话累计输出")}</span>
                  <span>{usage.totalOutput.toLocaleString()} tokens</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {showBrowser && (
        <BrowserPanel
          t={t}
          info={browserInfo}
          mode={browserMode}
          detached={browserDetached}
          width={browserWidth}
          onResize={setBrowserWidth}
          onMode={setBrowserMode}
          onDetach={() => window.wuwei.browserDetach()}
          onReattach={() => window.wuwei.browserReattach()}
          onClose={() => {
            if (browserDetached) window.wuwei.browserReattach();
            setShowBrowser(false);
          }}
        />
      )}
      {/* 全局搜索：搜所有对话正文，下拉给「会话标题 + 关键词上下文摘要」，点一下切过去并滚到命中位置 */}
      {searchOpen && (
        <>
          <div className="mq-overlay" onClick={() => setSearchOpen(false)} />
          <div className="search-modal">
            <div className="search-bar">
              <SearchIcon />
              <input
                className="search-input"
                ref={searchInputRef}
                autoFocus
                placeholder={lang === "en" ? "Search all conversations…" : "搜索所有对话的内容…"}
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => {
                  const hits = searchRes?.hits || [];
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSearchOpen(false);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSearchSel((i) => Math.min(i + 1, hits.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSearchSel((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const h = hits[searchSel];
                    if (h) gotoHit(h);
                  }
                }}
              />
              {searchQ && (
                <button
                  className="search-clear"
                  title={lang === "en" ? "Clear" : "清空"}
                  onMouseDown={(e) => e.preventDefault()} // 别把焦点从输入框抢走，清空后接着打字
                  onClick={() => setSearchQ("")}
                >
                  ×
                </button>
              )}
              <button className="search-x" title={lang === "en" ? "Close (Esc)" : "关闭（Esc）"} onClick={() => setSearchOpen(false)}>
                ×
              </button>
            </div>
            <div className="search-stat">
              {searching
                ? lang === "en"
                  ? "Searching…（first run builds an index, a few seconds）"
                  : "搜索中…（第一次会先建索引，稍等几秒）"
                : searchRes
                  ? searchRes.hits.length
                    ? lang === "en"
                      ? `${searchRes.total} matches · ${searchRes.sessions} conversations${searchRes.truncated ? "（showing the most relevant）" : ""} · ↑↓ to select, Enter to jump`
                      : `共 ${searchRes.total} 处匹配 · ${searchRes.sessions} 个会话${searchRes.truncated ? "（只列出最相关的一部分）" : ""} · ↑↓ 选择，回车跳转`
                    : lang === "en"
                      ? `No content matching "${searchQ.trim()}"`
                      : `没找到包含「${searchQ.trim()}」的内容`
                  : lang === "en"
                    ? "Search across all questions and replies; click a result to jump to it"
                    : "搜所有对话的提问与回复；点结果直接跳到原文位置"}
            </div>
            {searchRes && searchRes.hits.length > 0 && (
              <div className="search-list">
                {searchRes.hits.map((h, i) => (
                  <div
                    key={h.sid + "|" + h.anchor + "|" + i}
                    className={"search-row" + (i === searchSel ? " sel" : "")}
                    ref={(el) => {
                      if (i === searchSel && el) el.scrollIntoView({ block: "nearest" });
                    }}
                    onMouseEnter={() => setSearchSel(i)}
                    onClick={() => gotoHit(h)}
                  >
                    <div className="search-row-top">
                      <span className="search-row-title" title={h.title}>
                        {h.title || (lang === "en" ? "New chat" : "新对话")}
                      </span>
                      <span className={"search-role " + h.role}>
                        {h.role === "user"
                          ? lang === "en" ? "Me" : "我"
                          : h.role === "assistant"
                            ? "AI"
                            : lang === "en" ? "Title" : "标题"}
                      </span>
                      <span className="search-row-time">{relTime(h.updatedAt, now)}</span>
                    </div>
                    <div className="search-snip">
                      {h.pre}
                      <mark>{h.match}</mark>
                      {h.post}
                      {h.more > 0 && (
                        <span className="search-more">
                          {lang === "en" ? `+${h.more} more here` : `本条另有 ${h.more} 处`}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      {historyView && (
        <>
          <div className="mq-overlay" onClick={() => setHistoryView(null)} />
          <div className="history-modal">
            <div className="history-head">
              <span className="history-title" title={historyView.title}>
                {historyView.title} · {lang === "en" ? "Full history" : "完整历史"}
                {historyView.compacted && <span className="history-badge">{lang === "en" ? "incl. pre-compaction" : "含压缩前原文"}</span>}
              </span>
              <button className="history-close" title={lang === "en" ? "Close" : "关闭"} onClick={() => setHistoryView(null)}>✕</button>
            </div>
            <div className="history-body stream">
              {historyView.loading ? (
                <div className="history-empty">{lang === "en" ? "Loading…" : "加载中…"}</div>
              ) : historyView.items.length === 0 ? (
                <div className="history-empty">{lang === "en" ? "No history for this conversation yet." : "这个对话暂无历史记录。"}</div>
              ) : (
                historyView.items.map((it, i) => <ItemView key={i} item={it} now={now} />)
              )}
            </div>
          </div>
        </>
      )}
      {goalEdit && (
        <>
          <div className="mq-overlay" onClick={() => setGoalEdit(null)} />
          <div className="goal-modal">
            <div className="goal-modal-h">◎ {lang === "en" ? "Overall goal for this conversation" : "这个对话的总目标"}</div>
            <div className="goal-modal-sub">
              {lang === "en"
                ? "Describe what you want to achieve. After you click Start, it switches to smart-continue, breaks the task down and drives it step by step — only stopping to ask when something truly needs you (servers, accounts, spending, going live)."
                : "写清楚你要达成什么。点「开始执行」后它会自动切到智能继续，自己拆解任务、一步步做下去，只有真正需要你出面的（服务器、账号、花钱、上线这类）才会停下来问你。"}
            </div>
            <textarea
              autoFocus
              rows={6}
              value={goalEdit.text}
              placeholder={lang === "en" ? "e.g. Research all the latest relevant literature, map out the directions, converge on the most valuable one, then implement/test/iterate until a verifiable result." : "例：把最前沿的相关文献全部调研一遍，梳理出有哪些研究方向，收敛出最有价值的一条，然后一步步实践、测试、迭代，直到跑出可验证的结果。"}
              onChange={(e) => setGoalEdit({ ...goalEdit, text: e.target.value })}
            />
            <div className="goal-modal-b">
              {goal && (
                <button
                  className="ghost"
                  onClick={() => {
                    window.wuwei.goalSet?.(goalEdit.sid, null);
                    if (goalEdit.sid === currentId) setGoal(null);
                    setGoalEdit(null);
                  }}
                >
                  {lang === "en" ? "Delete goal" : "删除目标"}
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button className="ghost" onClick={() => setGoalEdit(null)}>{lang === "en" ? "Cancel" : "取消"}</button>
              <button
                className="ghost"
                onClick={() => {
                  const tx = goalEdit.text.trim();
                  const g = tx ? { text: tx, active: false, done: false } : null;
                  window.wuwei.goalSet?.(goalEdit.sid, g);
                  if (goalEdit.sid === currentId) setGoal(g);
                  setGoalEdit(null);
                }}
              >
                {lang === "en" ? "Save only" : "只保存"}
              </button>
              <button className="primary" disabled={!goalEdit.text.trim()} onClick={() => startGoal(goalEdit.text)}>
                {lang === "en" ? "Start" : "开始执行"}
              </button>
            </div>
          </div>
        </>
      )}
      {showTrash && (
        <>
          <div className="mq-overlay" onClick={() => setShowTrash(false)} />
          <div className="trash-modal">
            <div className="trash-head">
              <span className="trash-head-t"><TrashIcon /> {lang === "en" ? "Trash" : "回收站"}</span>
              <span className="trash-sub">{lang === "en" ? "Deleted chats can be restored; auto-cleared after 7 days" : "已删除的对话可恢复，7 天后自动清除"}</span>
              <button className="trash-x" title={lang === "en" ? "Close" : "关闭"} onClick={() => setShowTrash(false)}>×</button>
            </div>
            <div className="trash-list">
              {trash.length === 0 && <div className="empty">{lang === "en" ? "Trash is empty" : "回收站是空的"}</div>}
              {trash.map((ti) => {
                const leftMs = ti.deletedAt + 7 * 24 * 3600 * 1000 - Date.now();
                const leftDays = Math.max(0, Math.ceil(leftMs / (24 * 3600 * 1000)));
                const title = ti.title || (lang === "en" ? "New chat" : "新对话");
                return (
                  <div key={ti.id} className="trash-row">
                    <div className="trash-info">
                      <div className="trash-title" title={title}>{title}</div>
                      <div className="trash-meta">
                        {ti.group ? (lang === "en" ? `Group "${ti.group}" · ` : `分组「${ti.group}」· `) : ""}
                        {lang === "en" ? `deleted ${relTime(ti.deletedAt, now, t)} · clears in ${leftDays}d` : `删除于 ${relTime(ti.deletedAt, now, t)} · ${leftDays} 天后清除`}
                      </div>
                    </div>
                    <button className="trash-restore" onClick={() => window.wuwei.restoreSession(ti.id)}>
                      {lang === "en" ? "Restore" : "恢复"}
                    </button>
                    <button
                      className="trash-purge"
                      title={lang === "en" ? "Delete permanently, cannot undo" : "彻底删除,不可恢复"}
                      onClick={() => {
                        if (confirm(lang === "en" ? `Permanently delete "${title}"? This cannot be undone.` : `彻底删除「${title}」？此操作不可恢复。`))
                          window.wuwei.purgeTrash(ti.id);
                      }}
                    >
                      {lang === "en" ? "Delete" : "彻底删除"}
                    </button>
                  </div>
                );
              })}
            </div>
            {trash.length > 0 && (
              <div className="trash-foot">
                <button
                  className="trash-empty"
                  onClick={() => {
                    if (confirm(lang === "en" ? `Empty trash? This permanently deletes ${trash.length} chat(s).` : `清空回收站？将彻底删除 ${trash.length} 个对话，不可恢复。`))
                      window.wuwei.emptyTrash();
                  }}
                >
                  {lang === "en" ? "Empty trash" : "清空回收站"}
                </button>
              </div>
            )}
          </div>
        </>
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
          showEffortPicker={showEffortPicker}
          onShowEffortPicker={changeShowEffortPicker}
          lang={lang}
          onLang={changeLang}
          t={t}
          askToastAuto={askToastAuto}
          askToastSec={askToastSec}
          onAskToast={changeAskToast}
          isPro={isPro}
          onBrainLocked={() => {
            setShowSettings(false);
            setShowBrainIntro(true);
          }}
        />
      )}
      {/* 每日签到：窗口居中小弹窗，自动消失。点任意处也可关。 */}
      {checkinPop && (
        <div className="checkin-pop-overlay" onClick={() => setCheckinPop(null)}>
          <div className="checkin-pop" onClick={(e) => e.stopPropagation()}>
            <div className="checkin-pop-ic">
              <CheckinDoneIcon size={30} />
            </div>
            {checkinPop === "already" ? (
              <div className="checkin-pop-title">{t("checkin.popAlready", "今日已签到")}</div>
            ) : (
              <>
                <div className="checkin-pop-title">{t("checkin.popTitle", "签到成功")}</div>
                <div className="checkin-pop-amt">
                  <CoinIcon size={18} /> +{checkinPop.amount} {t("pay.credits", "无为币")}
                </div>
                {checkinPop.streak && checkinPop.streak > 1 && (
                  <div className="checkin-pop-sub">{t("checkin.popStreak", "连续签到 {d} 天").replace("{d}", String(checkinPop.streak))}</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {/* 脑网络功能介绍：欢迎页案例 / 非会员点灰置菜单弹出；点开通跳升级 Pro */}
      {showBrainIntro && (
        <BrainIntroModal
          t={t}
          onClose={() => setShowBrainIntro(false)}
          onUpgrade={() => {
            setShowBrainIntro(false);
            setPlanOpen(true);
          }}
        />
      )}
      {/* 联系客服弹窗：支付遇到问题 / 账号菜单「联系客服」都可打开 */}
      {showSupport && (
        <ContactSupportModal
          t={t}
          onClose={() => setShowSupport(false)}
          onLeaveMessage={() => {
            setShowSupport(false);
            setLeaveMsgFromSupport(true);
            setShowLeaveMsg(true);
          }}
        />
      )}
      {/* 留言表单：客服弹窗点「直接留言」进入(带返回)；账号菜单「留言反馈」直接进入(无返回) */}
      {showLeaveMsg && (
        <LeaveMessageModal
          t={t}
          onClose={() => setShowLeaveMsg(false)}
          onBack={
            leaveMsgFromSupport
              ? () => {
                  setShowLeaveMsg(false);
                  setLeaveMsgFromSupport(false);
                  setShowSupport(true);
                }
              : undefined
          }
        />
      )}
      {/* 消息中心：账号菜单进入；进入即标全部已读并清红点 */}
      {showMsgCenter && (
        <MessageCenterModal
          t={t}
          lang={lang}
          onClose={() => setShowMsgCenter(false)}
          onRead={(u) => setMsgUnread(u)}
        />
      )}
      {/* 未登录发消息先弹的居中登录激励卡；点登录再切到下面的登录框 */}
      {showLoginIntro && (
        <LoginIntroModal
          lang={lang}
          t={t}
          onClose={() => setShowLoginIntro(false)}
          onLogin={() => {
            setShowLoginIntro(false);
            setLoginResume(true);
            setShowLoginForm(true);
          }}
        />
      )}
      {/* 应用内登录框：邮箱/手机号/Google。未登录点发送(loginResume)或点账号登录时弹出 */}
      {showLoginForm && (
        <WuweiLoginModal
          incentive={false} /* 激励已由前置的 LoginIntroModal 展示，登录框保持干净，避免重复。loginResume 仍用于登录后续发消息 */
          lang={lang}
          t={t}
          onClose={() => {
            setShowLoginForm(false);
            setLoginResume(false);
          }}
          onSuccess={onWuweiLoggedIn}
        />
      )}
      {/* 检查更新结果：居中弹窗提示（检查中/已最新/发现新版下载中） */}
      {updateMsg && (
        <div className="perm-overlay" onClick={() => setUpdateMsg("")}>
          <div className="add-st-dialog" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: "6px 2px 2px", fontSize: 14, lineHeight: 1.6 }}>{updateMsg}</div>
            {dlProgress && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
                  <span>{lang === "en" ? "Downloading…" : "下载中…"}</span>
                  <span>{dlProgress.percent}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 999, background: "var(--bg-raised)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${dlProgress.percent}%`, background: "var(--accent)", transition: "width .2s" }} />
                </div>
              </div>
            )}
            <div className="btns" style={{ marginTop: 14, justifyContent: "flex-end" }}>
              <button className="allow" onClick={() => setUpdateMsg("")}>{lang === "en" ? "OK" : "知道了"}</button>
            </div>
          </div>
        </div>
      )}
      {/* 新版已下载好：点药丸/菜单才弹此窗，提示一键升级重启（含改进说明）。「稍后」只关弹窗，药丸保留 */}
      {showUpdateModal && updateReady && (
        <div className="perm-overlay" onClick={() => setShowUpdateModal(false)}>
          <div className="add-st-dialog" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>{lang === "en" ? `New version v${updateReady.version} is ready` : `新版本 v${updateReady.version} 已就绪`}</h3>
            <div className="s-note" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, maxHeight: 240, overflow: "auto" }}>
              {updateReady.notes || (lang === "en" ? "Improvements and fixes. Update now to restart into the new version." : "包含改进与修复。点击升级将立即重启到新版本。")}
            </div>
            <div className="btns" style={{ marginTop: 16 }}>
              <button onClick={() => setShowUpdateModal(false)}>{lang === "en" ? "Later" : "稍后"}</button>
              <button className="allow" onClick={() => window.wuwei.installUpdate()}>{lang === "en" ? "Update & restart" : "升级并重启"}</button>
            </div>
          </div>
        </div>
      )}
      {/* 客户端公告弹窗：打开即弹(未读过该版本)，读完关闭存本地，同版本不再弹 */}
      {announce && (() => {
        const closeAnnounce = () => { try { localStorage.setItem("wuwei_seen_announcement", announce.version); } catch { /* ignore */ } setAnnounce(null); };
        return (
          <div className="perm-overlay" onClick={closeAnnounce}>
            <div className="add-st-dialog announce-dialog" style={{ maxWidth: 500, width: "92vw", position: "relative", paddingTop: 22 }} onClick={(e) => e.stopPropagation()}>
              <button className="announce-x" aria-label={lang === "en" ? "Close" : "关闭"} title={lang === "en" ? "Close" : "关闭"} onClick={closeAnnounce}>×</button>
              <h3 style={{ marginTop: 0, paddingRight: 28 }}>{announce.title}</h3>
              <div className="s-note" style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, maxHeight: "68vh", overflow: "auto" }}>{announce.body}</div>
            </div>
          </div>
        );
      })()}
      {/* ① 无为币不足触发弹窗（v2）：金色升级Pro在上(更划算) + 朱色购买积分包在下 */}
      {coinShortage && (
        <div className="perm-overlay pay-overlay" onClick={() => setCoinShortage(null)}>
          <div className="pay-card" onClick={(e) => e.stopPropagation()}>
            <PayCloseX onClick={() => setCoinShortage(null)} />
            <div className="pay-top">
              <PayEnso />
              <h2>{lang === "en" ? "Out of credits" : "无为币不足"}</h2>
              <p>{lang === "en" ? "Balance used up — pick a way to keep using Wuwei hosted models" : "余额已用尽 —— 选一种方式，继续使用无为托管模型"}</p>
            </div>
            <div className="pay-bal">
              <div className="pay-bal-l">{lang === "en" ? "Available balance" : "当前可用余额"}</div>
              <div className="pay-bal-v">
                <span className="pay-coin" /> {coinShortage.balance != null ? coinShortage.balance : wuwei?.coin.balance ?? 0}
                <small>{lang === "en" ? "credits" : "无为币"}</small>
              </div>
            </div>
            <div className="pay-opts">
              {(() => {
                // 按当前会员等级显示"下一级"：free/未登录→Pro，Pro→Plus，Plus→Max；Max 已顶配→不显升级卡
                const cur = wuwei?.membership?.plan ?? null; // 服务端给的档位名 Pro/Plus/Max，free 时 null
                const nextTier = cur === "Max" ? null : cur === "Plus" ? "Max" : cur === "Pro" ? "Plus" : "Pro";
                const nextPlan = nextTier ? PRO_PLANS.find((p) => p.nameEn === "Wuwei " + nextTier) : null;
                if (!nextPlan) return null; // 已是 Max：无更高等级，只保留购买积分包
                return (
                  <button
                    className="pay-opt pay-opt-plan"
                    onClick={() => {
                      setCoinShortage(null);
                      setPlanOpen(true);
                    }}
                  >
                    <span className="pay-badge">{lang === "en" ? "Better value" : "更划算"}</span>
                    <span className="pay-oi">
                      <PaySpark size={20} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="pay-ot">{lang === "en" ? `Upgrade to ${nextPlan.nameEn}` : `升级${nextPlan.name}`}</span>
                      <span className="pay-os" style={{ display: "block" }}>
                        {lang === "en" ? `From $${nextPlan.priceUsd}/mo · hosted quota, resets weekly` : `¥${nextPlan.price}/月 · 托管额度 · 每周重置`}
                      </span>
                    </span>
                    <span className="pay-arr">
                      <PayArrow />
                    </span>
                  </button>
                );
              })()}
              <button
                className="pay-opt pay-opt-pack"
                onClick={() => {
                  setCoinShortage(null);
                  setCoinPackOpen(true);
                }}
              >
                <span className="pay-oi">
                  <PackIcon size={21} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="pay-ot">{lang === "en" ? "Buy a credit pack" : "购买积分包"}</span>
                  <span className="pay-os" style={{ display: "block" }}>
                    {lang === "en" ? "Top up as needed — pay for what you use, instant" : "按需充值，用多少买多少，即充即用"}
                  </span>
                </span>
                <span className="pay-arr">
                  <PayArrow />
                </span>
              </button>
            </div>
            <div className="pay-foot">
              <button onClick={() => void refreshWuweiForShortage(coinShortage.message)}>{lang === "en" ? "↻ Refresh balance" : "↻ 刷新余额"}</button>
              <button onClick={() => setCoinShortage(null)}>{lang === "en" ? "Not now" : "暂不需要"}</button>
            </div>
          </div>
        </div>
      )}
      {coinPackOpen && (
        <CoinPackModal
          t={t}
          lang={lang}
          packs={wuwei?.flags?.includes("coinpack_test") ? [TEST_COIN_PACK, ...COIN_PACKS] : COIN_PACKS}
          onClose={() => setCoinPackOpen(false)}
          onCheckout={(pack) => {
            setCoinPackOpen(false);
            if (lang === "en") { startEnCheckout(pack.sku); return; } // 海外走网页 Paddle 结账
            setPayCheckout({ kind: "pack", pack });
          }}
          onUpgrade={() => {
            setCoinPackOpen(false);
            setPlanOpen(true);
          }}
        />
      )}
      {planOpen && (
        <PlanModal
          t={t}
          lang={lang}
          onClose={() => setPlanOpen(false)}
          onCheckout={(plan) => {
            setPlanOpen(false);
            if (lang === "en") { startEnCheckout(plan.sku); return; } // 海外走网页 Paddle 结账
            setPayCheckout({ kind: "plan", plan });
          }}
        />
      )}
      {payCheckout && (
        <PayCheckoutModal
          order={payCheckout}
          onClose={() => setPayCheckout(null)}
          onPaid={(balance, orderId) => {
            const o = payCheckout;
            const ord = orderId || ""; // 真实后端订单号（拿不到就留空，不再瞎编）
            if (o.kind === "pack") {
              const added = o.pack.coins + o.pack.bonus;
              setPayResult({ kind: "coin", added, bonus: o.pack.bonus, balance: balance ?? (wuwei?.coin.balance ?? 0) + added, order: ord });
            } else {
              setPayResult({
                kind: "pro",
                planName: o.plan.name,
                expire: fmtDate(addMonths(new Date(), 1)), // 月付：+1 个月
                giftCoins: o.plan.coins,
                signin: o.plan.signin,
                perks: (lang === "en" ? PRO_FEATS_EN : PRO_FEATS).map(([tt]) => tt), // 各档同样的会员权益
                saved: o.plan.saved || undefined,
                order: ord,
              });
            }
            setPayCheckout(null);
            void window.wuwei.wuweiMe().then((me) => { if (me) setWuwei(me); }).catch(() => {}); // 拉最新余额/会员(接后端后即真数据)
          }}
          onContactSupport={() => setShowSupport(true)}
          onNeedLogin={() => {
            setPayCheckout(null);   // 关掉支付页
            setWuwei(null);         // 本地登录态失效，账号菜单回落到「登录」
            setLoginResume(false);
            setShowLoginForm(true); // 直接弹登录框
          }}
        />
      )}
      {payResult && (
        <PayResultModal
          result={payResult}
          onClose={() => setPayResult(null)}
          onRetry={() => {
            setPayResult(null);
            setCoinShortage(null);
          }}
        />
      )}
      {secretPrompt && (
        <div className="perm-overlay" onClick={() => setSecretPrompt(null)}>
          <div className="add-st-dialog sec-prompt" onClick={(e) => e.stopPropagation()}>
            <h3>{lang === "en" ? "🔒 Possible secret detected" : "🔒 检测到疑似密钥"}</h3>
            <p className="s-note">
              {lang === "en"
                ? "Found the sensitive info below. Check the items to store in the local secret manager — they're encrypted and replaced with placeholders before being sent to the AI, then auto-recognized each time after."
                : "发现下面的敏感信息。勾选要存入本地密钥管理器的项——存入后会加密保存,并在发给 AI 前用占位符替换,之后每次自动识别。"}
            </p>
            <div className="sec-cand-list">
              {secretPrompt.candidates.map((c, i) =>
                c.existing ? (
                  // 值已在保险箱、但这次描述不同→让用户三选一
                  <div key={i} className="sec-cand sec-cand-dup">
                    <div className="sec-cand-dup-top">
                      <span className="sec-cand-kind dup">{lang === "en" ? "Exists" : "已存在"}</span>
                      <span className="sec-cand-val">{c.masked}</span>
                      <span className="sec-cand-meta">
                        {lang === "en" ? "Old note: " : "旧备注："}{c.existing.note || (lang === "en" ? "(none)" : "（无）")} → {lang === "en" ? "new: " : "新："}<b>{c.note}</b>
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
                          {opt === "new" ? (lang === "en" ? "Save as new" : "存为新的一条") : opt === "overwrite" ? (lang === "en" ? "Overwrite note" : "覆盖备注") : (lang === "en" ? "Don't save" : "不存")}
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
              <button onClick={() => setSecretPrompt(null)}>{lang === "en" ? "Cancel send" : "取消发送"}</button>
              <button onClick={() => confirmSecretPrompt(false)}>{lang === "en" ? "Send without saving" : "不存,直接发"}</button>
              <button className="allow" onClick={() => confirmSecretPrompt(true)}>
                {lang === "en" ? "Save, replace & send" : "存入并替换后发送"}
              </button>
            </div>
          </div>
        </div>
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img
            src={lightbox}
            alt=""
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              openImageMenu?.(e.clientX, e.clientY, lightbox);
            }}
          />
          <button
            className="lightbox-close"
            title={t("lightbox.close", "关闭 (Esc)")}
            onClick={(e) => {
              e.stopPropagation();
              setLightbox(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      {imgMenu && (
        <div
          className="img-menu-overlay"
          onClick={() => setImgMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setImgMenu(null);
          }}
        >
          <div
            className="img-menu"
            style={{ left: Math.min(imgMenu.x, window.innerWidth - 168), top: Math.min(imgMenu.y, window.innerHeight - 130) }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={async () => {
                const src = imgMenu.src;
                setImgMenu(null);
                const ok = await copyImageToClipboard(src);
                if (!ok) push({ type: "notice", text: lang === "en" ? "Failed to copy image (try \"Save image\" instead)" : "复制图片失败（可改用「保存图片」）" });
              }}
            >
              {lang === "en" ? "Copy image" : "复制图片"}
            </button>
            <button
              onClick={() => {
                saveImage(imgMenu.src);
                setImgMenu(null);
              }}
            >
              {lang === "en" ? "Save image…" : "保存图片…"}
            </button>
            <button
              onClick={() => {
                setLightbox(imgMenu.src);
                setImgMenu(null);
              }}
            >
              {lang === "en" ? "View full size" : "查看大图"}
            </button>
          </div>
        </div>
      )}

      {asks[currentId] && (() => {
        const a = asks[currentId];
        const cont = modeOf(currentId) === "cont";
        // 红线识别:两种方式算出"能不能自动倒计时/命中了啥"
        let autoSec = 0;
        let redlineHit: { word: string; src: "builtin" | "custom" | "smart" } | null = null;
        let judging = false;
        if (cont) {
          if (redlineMode === "smart") {
            const rk = askRisk[a.id];
            if (!rk || rk.pending) judging = true; // 判定中：先不倒计时
            else if (rk.risky) redlineHit = { word: rk.reason || (lang === "en" ? "a risky action" : "涉及危险动作"), src: "smart" };
            else autoSec = askAutoSec; // 判定安全：走倒计时(用原始秒数设置，不再做关键词拦截)
          } else {
            autoSec = askAutoSecFor(a.questions || [], askAutoSec, stopRules);
            redlineHit = riskyHitOf(a.questions || [], stopRules);
          }
        }
        return (
        <AskModal
          key={a.id}
          t={t}
          lang={lang}
          data={a}
          anchor={composerRef}
          autoSec={autoSec}
          redlineHit={redlineHit}
          judging={judging}
          onAuto={() => {
            // 倒计时到点：按总目标替你选(不勾具体项，让 AI 挑最合理的继续)
            window.wuwei.answerAsk(a.id, {
              list: (a.questions || []).map(() => ({ selected: [], text: lang === "en" ? "You decide based on the overall goal — pick the most reasonable option and keep going." : "这个你按总目标自己定，挑最合理的选项继续。" })),
            });
            clearAsk(currentId);
          }}
          onSubmit={(list, images) => {
            window.wuwei.answerAsk(a.id, { list, images });
            clearAsk(currentId);
          }}
          onCancel={() => {
            window.wuwei.answerAsk(a.id, { cancelled: true });
            clearAsk(currentId);
          }}
        />
        );
      })()}

      {/* 别的会话发起的 ask → 右上角通知：点击切过去选择 / ✕ 忽略 / 30s 自动消失 */}
      {askToasts.some((x) => x.sid !== currentId) && (
        <div className="ask-toasts">
          {askToasts
            .filter((x) => x.sid !== currentId)
            .map((t) => (
              <div
                key={t.askId}
                className="ask-toast"
                onClick={() => {
                  window.wuwei.switchSession(t.sid);
                  dropToast(t.askId);
                }}
              >
                <div className="ask-toast-body">
                  <div className="ask-toast-title">{makeT(getLang())("asktoast.title", "🔔 有会话在等你选择")}</div>
                  <div className="ask-toast-sub">
                    {makeT(getLang())("asktoast.sub", "「{title}」需要确认，点此切换过去").replace("{title}", t.title)}
                  </div>
                </div>
                <button
                  type="button"
                  className="ask-toast-x"
                  title={makeT(getLang())("asktoast.ignore", "忽略通知（该会话仍在等待，切过去即可回答）")}
                  onClick={(e) => {
                    e.stopPropagation();
                    dropToast(t.askId);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
        </div>
      )}

      {/* 崩溃恢复：上次被强制中断的任务→贴输入框上方的非模态框(仿 ask_user)，问是否继续 */}
      {interruptedSessions.length > 0 && (
        <ResumeBox
          sessions={interruptedSessions}
          anchor={composerRef}
          onResume={resumeInterrupted}
          onDismiss={dismissInterrupted}
          onDismissAll={() => interruptedSessions.forEach((s) => dismissInterrupted(s.id))}
        />
      )}

      {pending && (
        <div className="perm-overlay">
          <div className="perm">
            <h3>
              {lang === "en" ? "Allow " : "允许执行 "}<span className="tname">{pending.name}</span>{lang === "en" ? "?" : "？"}
            </h3>
            <div className="args">{JSON.stringify(pending.input, null, 2)}</div>
            <div className="btns">
              <button onClick={() => answerPerm("deny")}>{lang === "en" ? "Deny (N)" : "拒绝 (N)"}</button>
              <button onClick={allowAlways}>{lang === "en" ? "Always allow (A)" : "总是允许 (A)"}</button>
              <button className="allow" onClick={() => answerPerm("allow")}>
                {lang === "en" ? "Allow (Y)" : "允许 (Y)"}
              </button>
            </div>
            <div className="hint">{lang === "en" ? "Y allow once · A always allow this tool · N/Esc deny" : "Y 允许一次 · A 总是允许该工具 · N/Esc 拒绝"}</div>
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
  const en = getLang() === "en";
  if (running.length > 1) return en ? `Running ${running.length} operations in parallel` : `正在并行执行 ${running.length} 个操作`;
  // 前缀「正在」占了 2 个字，标签本身再收紧一点，别顶到右侧的耗时/token
  if (running.length === 1) return (en ? "" : "正在") + oneLineLabel(toolMetaRaw(running[0]).label, 48);
  if (chars === 0) return en ? (elapsed > 20 ? "Thinking deeply" : "Thinking") : (elapsed > 20 ? "深度思考中" : "思考中");
  return en ? "Generating reply" : "生成回复";
}

function ThinkingBar({
  startRef,
  charsRef,
  textRef,
  items,
}: {
  startRef: React.MutableRefObject<number | null>;
  charsRef: React.MutableRefObject<number>;
  textRef?: React.MutableRefObject<string>;
  items: Item[];
}) {
  const [, force] = useState(0);
  const [previewOn, setPreviewOn] = useState(false); // 悬停 token 数→预览已生成正文
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
  const runningNow = runningTools(items);
  const running = runningNow.length;
  const en = getLang() === "en";
  // 悬停看完整命令：单个工具在跑时给未截断的原文，其余情况就是状态本身
  const fullStatus = running === 1 ? toolMetaRaw(runningNow[0]).label : status;
  return (
    <div className="thinking">
      <span className="tspark">✳</span>
      {/* title 给完整内容：标签已截断，悬停能看全在跑什么 */}
      <span className="tstatus" title={fullStatus}>
        {status}…
      </span>
      <span
        className="tmeta tmeta-hover"
        onMouseEnter={() => setPreviewOn(true)}
        onMouseLeave={() => setPreviewOn(false)}
        title={en ? "Hover to preview generated text" : "悬停查看已生成的正文"}
      >
        {time} · {tokLabel} tokens · {running > 0 ? (en ? `${running} task(s) running` : `${running} 个任务执行中`) : (en ? "Working" : "执行中")}
        {previewOn && (() => {
          const preview = (textRef?.current || "").slice(-2000);
          return (
            <div className="tpreview">
              {preview
                ? preview
                : en
                  ? "(nothing generated yet; if it stays at 0 tokens, the model hasn't emitted its first token)"
                  : "（还没有已生成的正文；若一直 0 token，是模型还没吐出首字）"}
            </div>
          );
        })()}
      </span>
    </div>
  );
}

function fmtReset(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const en = getLang() === "en";
  if (d > 0) return en ? `resets in ${d}d ${h}h` : `${d}天${h}小时后重置`;
  if (h > 0) return en ? `resets in ${h}h ${m}m` : `${h}小时${m}分后重置`;
  return en ? `resets in ${m}m` : `${m}分后重置`;
}

// 额度窗口时长 → 友好标签：≥48h 用「N天限额」，否则「X小时限额」(数据来自订阅接口返回的窗口时长)
function windowLabel(min?: number, fallback = 300): string {
  const h = Math.round((min ?? fallback) / 60);
  const en = getLang() === "en";
  return h >= 48 ? (en ? `${Math.round(h / 24)}-day limit` : `${Math.round(h / 24)}天限额`) : (en ? `${h}-hour limit` : `${h}小时限额`);
}

function LimitRow({ label, used, resetSec }: { label: string; used: number; resetSec?: number }) {
  return (
    <div className="limit">
      <div className="u-row">
        <span>{label}</span>
        <span>
          {getLang() === "en" ? `${used}% used` : `已用 ${used}%`}
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
function relTime(ts: number, now: number, tt?: T): string {
  const t = tt ?? makeT(getLang());
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 10) return t("rel.now", "刚刚");
  if (s < 60) return t("rel.sec", "{n}秒前").replace("{n}", String(s));
  const m = Math.floor(s / 60);
  if (m < 60) return t("rel.min", "{n}分钟前").replace("{n}", String(m));
  const h = Math.floor(m / 60);
  if (h < 24) return t("rel.hour", "{n}小时前").replace("{n}", String(h));
  const d = Math.floor(h / 24);
  if (d < 7) return t("rel.day", "{n}天前").replace("{n}", String(d));
  const dt = new Date(ts);
  return t("rel.date", "{mo}月{d}日").replace("{mo}", String(dt.getMonth() + 1)).replace("{d}", String(dt.getDate()));
}


// 内置浏览器面板：与聊天同层的一列(半屏)/独占(全屏)/或弹成独立窗口。页面区是原生 WebContentsView，按此区域 bounds 贴合。
function BrowserPanel({
  t,
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
  t: T;
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
      const w = Math.min(window.innerWidth - 420, Math.max(360, window.innerWidth - ev.clientX));
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
      window.wuwei.browserShow({ x: r.x, y: r.y, width: r.width, height: r.height });
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
      window.wuwei.browserHide();
    };
  }, [detached]);

  // 独立窗口时不占任何主窗口空间(控件移到顶栏 🖥 图标的下拉)
  if (detached) return null;
  return (
    <div className={"browser-panel " + mode} style={mode === "split" ? { flexBasis: width } : undefined}>
      {mode === "split" && <div className="bp-resizer" onMouseDown={startResize} title={t("browser.resize", "拖动调整宽度")} />}
      <div className="bp-bar">
        <button className="bp-nav" disabled={!info.canGoBack} onClick={() => window.wuwei.browserNav("back")} title={t("browser.back", "后退")}>
          ‹
        </button>
        <button
          className="bp-nav"
          disabled={!info.canGoForward}
          onClick={() => window.wuwei.browserNav("forward")}
          title={t("browser.forward", "前进")}
        >
          ›
        </button>
        <button className="bp-nav" onClick={() => window.wuwei.browserNav("reload")} title={t("browser.reload", "刷新")}>
          ⟳
        </button>
        <input
          className="bp-url"
          value={urlEdit}
          onChange={(e) => setUrlEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") window.wuwei.browserNav("open", urlEdit);
          }}
          placeholder={t("browser.urlPlaceholder", "输入网址回车打开")}
        />
        {info.loading && <span className="bp-loading">…</span>}
        <button className={"bp-mode" + (mode === "split" ? " on" : "")} onClick={() => onMode("split")} title={t("browser.split", "半屏(与聊天并排)")}>
          ◫
        </button>
        <button className={"bp-mode" + (mode === "full" ? " on" : "")} onClick={() => onMode("full")} title={t("browser.full", "全屏浏览器")}>
          ▢
        </button>
        <button className="bp-mode" onClick={onDetach} title={t("browser.detach", "弹成独立窗口(可拖动)")}>
          ⇱
        </button>
        <button className="bp-close" onClick={onClose} title={t("browser.close", "关闭浏览器面板")}>
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
  onResend,
}: {
  item: Item;
  now: number;
  onDelete?: () => void;
  onEdit?: () => void;
  onResend?: () => void;
}) {
  if (item.type === "user")
    return (
      <div className="user-block" data-anchor={item.anchor}>
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
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openImageMenu?.(e.clientX, e.clientY, src);
                    }}
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
            {onResend && (
              <button
                className="tf-icon"
                title={makeT(getLang())("msg.resend", "重新发送（把这条的文字和图片原样再发一次，切换模型后重试很方便）")}
                onClick={onResend}
              >
                <ResendIcon />
              </button>
            )}
            {onEdit && (
              <button
                className="tf-icon"
                title={makeT(getLang())("msg.edit", "撤回并编辑（收回这条，文字回到输入框可改可重发）")}
                onClick={onEdit}
              >
                ↩
              </button>
            )}
            {onDelete && (
              <button className="tf-icon del" title={makeT(getLang())("msg.delete", "删除这轮问答(含提问与回复)")} onClick={onDelete}>
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
  if (item.type === "assistant") return <AssistantMsg text={item.text} anchor={item.anchor} />;
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
// 简洁放大镜(全局搜索)：线性描边，随文字色
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
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
// 重发图标(循环箭头)
function ResendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

// ask_user：AI 弹出的可点击选择框(单选/多选/可多问)
type AskOption = { label: string; description?: string };
type AskQuestion = { question: string; header?: string; multiSelect?: boolean; options: AskOption[] };
// 崩溃恢复框：仿 ask_user，贴输入框上方对齐，非模态。列出被中断的任务，逐个「继续 / 忽略」。
function ResumeBox({
  sessions,
  anchor,
  onResume,
  onDismiss,
  onDismissAll,
}: {
  sessions: { id: string; title: string }[];
  anchor: React.RefObject<HTMLDivElement | null>;
  onResume: (id: string) => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}) {
  // 对齐到输入框：同左、同宽、贴其正上方 8px(与 AskModal 一致)
  const [box, setBox] = useState<{ left: number; width: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const upd = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;
      setBox({ left: r.left + padL, width: r.width - padL - padR, bottom: window.innerHeight - (r.top + padT) + 8 });
    };
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
  const many = sessions.length > 1;
  const en = getLang() === "en";
  return (
    <div
      className="ask resume-ask"
      style={box ? { left: box.left, width: box.width, bottom: box.bottom } : { visibility: "hidden" }}
    >
      <div className="ask-qhead">
        <span className="ask-tag">{en ? "⚠ Task interrupted" : "⚠ 任务被中断"}</span>
        <span className="ask-title">
          {many
            ? (en ? `${sessions.length} tasks were running when you last quit — let the AI continue?` : `上次退出时有 ${sessions.length} 个任务正在运行，要让 AI 接着继续吗？`)
            : (en ? "This task was interrupted last time it ran — let the AI continue?" : "上次这个任务运行时被中断，要让 AI 接着继续吗？")}
        </span>
      </div>
      <div className="resume-rows">
        {sessions.map((s) => (
          <div key={s.id} className="resume-row">
            <span className="resume-title" title={s.title}>💬 {s.title || (en ? "New chat" : "新对话")}</span>
            <span className="resume-btns">
              <button type="button" className="allow" onClick={() => onResume(s.id)}>
                {en ? "Continue" : "继续"}
              </button>
              <button type="button" onClick={() => onDismiss(s.id)}>
                {en ? "Ignore" : "忽略"}
              </button>
            </span>
          </div>
        ))}
      </div>
      {many && (
        <div className="resume-foot">
          <button type="button" onClick={onDismissAll}>
            {en ? "Ignore all" : "全部忽略"}
          </button>
        </div>
      )}
    </div>
  );
}

function AskModal({
  data,
  anchor,
  onSubmit,
  onCancel,
  t,
  lang,
  autoSec = 0,
  onAuto,
  redlineHit,
  judging = false,
}: {
  data: { id: number; questions: AskQuestion[] };
  anchor: React.RefObject<HTMLDivElement | null>; // 输入框(composer)，用于对齐定位
  onSubmit: (list: { selected: string[]; text?: string }[], images: string[]) => void;
  onCancel: () => void;
  t: T;
  lang?: Lang;
  autoSec?: number; // 智能继续:>0 则显示倒计时，到点自动按目标替你定(0=不自动)
  onAuto?: () => void; // 倒计时到点的回调(父组件提交"你自己定"的答案)
  redlineHit?: { word: string; src: "builtin" | "custom" | "smart" } | null; // 命中红线才有值:显示灰字说明为啥没自动
  judging?: boolean; // 智能识别模式:LLM 判定中(先不倒计时，显示"智能判断中…")
}) {
  const qs = data.questions;
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [imgs, setImgs] = useState<Record<number, string[]>>({}); // 每题附带的截图(dataURL)
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0); // 分步：一次只问一题，答完再出下一题
  const q = qs[step];
  const isLast = step === qs.length - 1;
  const curMulti = !!q.multiSelect;
  const curImgs = imgs[step] || [];
  // 读图片文件为 dataURL，追加到当前题
  const addImgFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => setImgs((m) => ({ ...m, [step]: [...(m[step] || []), reader.result as string] }));
      reader.readAsDataURL(f);
    }
  };
  const buildList = (s: Record<number, string[]>) =>
    qs.map((_, qi) => ({ selected: s[qi] || [], text: (other[qi] || "").trim() || undefined }));
  const allImgs = () => qs.flatMap((_, qi) => imgs[qi] || []); // 所有题的截图汇总一并回传
  const answeredAt = (s: Record<number, string[]>, qi: number) =>
    (s[qi]?.length || (other[qi] || "").trim().length || (imgs[qi]?.length || 0)) > 0;
  const curAnswered = answeredAt(sel, step);
  // 进入下一题；已是最后一题则整体提交
  const advance = (s: Record<number, string[]> = sel) => {
    if (!answeredAt(s, step)) return;
    if (isLast) onSubmit(buildList(s), allImgs());
    else setStep((v) => v + 1);
  };
  const pick = (label: string, multi: boolean) => {
    const cur = sel[step] || [];
    const next = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : cur.includes(label) ? [] : [label];
    const merged = { ...sel, [step]: next };
    setSel(merged);
    // 单选即进：自动进入下一题/提交。但本题已附截图时不自动交——留时间让用户补完图文再手动提交
    if (!multi && next.length && !curImgs.length) advance(merged);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 智能继续：可见倒计时。你一旦动手(选了/输入了/翻到下一题)就停表，交回你自己决定
  const touched = step > 0 || Object.values(sel).some((a) => a?.length) ||
    Object.values(other).some((s) => (s || "").trim()) || Object.values(imgs).some((a) => a?.length);
  const [left, setLeft] = useState(autoSec);
  const [autoCancelled, setAutoCancelled] = useState(false);
  // autoSec 变化就把倒计时重置(关键:智能识别是异步的，判定中 autoSec=0，判完才变 3——
  // 若不重置，left 仍停在 0，倒计时 effect 会当场判 left<=0 立即自动提交，把你正在输入的文字/图片顶掉)
  useEffect(() => { setLeft(autoSec); }, [autoSec]);
  const autoOn = autoSec > 0 && !touched && !autoCancelled && !!onAuto;
  useEffect(() => {
    if (!autoOn) return;
    if (left <= 0) { onAuto?.(); return; }
    const tm = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(tm);
  }, [autoOn, left]);
  // 对齐到输入框：同左、同宽、贴其正上方 8px
  const [box, setBox] = useState<{ left: number; width: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const el = anchor.current;
    if (!el) return;
    const upd = () => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el); // composer 有左右 padding，对齐到内容区(真正的输入条)
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;
      setBox({ left: r.left + padL, width: r.width - padL - padR, bottom: window.innerHeight - (r.top + padT) + 8 });
    };
    upd();
    window.addEventListener("resize", upd);
    // 直接观察输入框尺寸：浏览器面板开合等布局变化 window resize 监听不到，用 ResizeObserver 才能自动跟随复位
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", upd);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
  // 手动尺寸覆盖：拖右上角手柄放大/缩小后记住宽高；null=跟随输入框自动尺寸
  const panelRef = useRef<HTMLDivElement>(null);
  const [userSize, setUserSize] = useState<{ w: number; h: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false); // 折叠成小条：挡住后面内容时先缩起来看，再展开选择
  function onResizeDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const startW = userSize?.w ?? panelRef.current?.offsetWidth ?? box?.width ?? 360;
    const startH = userSize?.h ?? panelRef.current?.offsetHeight ?? 240;
    const leftEdge = box?.left ?? 0;
    const move = (ev: MouseEvent) => {
      const maxW = Math.max(260, window.innerWidth - leftEdge - 12);
      const maxH = Math.round(window.innerHeight * 0.9);
      // 右上角手柄：右移加宽；底边锚定，上移(clientY 变小)即向上长高
      const w = Math.min(maxW, Math.max(260, startW + (ev.clientX - sx)));
      const h = Math.min(maxH, Math.max(120, startH + (sy - ev.clientY)));
      setUserSize({ w, h });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  // 单个单选题靠点击即交，不显示按钮；多选题/多题分步/已附截图时显示「下一步/提交」
  const showPrimary = curMulti || qs.length > 1 || curImgs.length > 0;
  // 折叠态：只剩一个小条(不挡后面内容)，点「展开」还原
  if (box && collapsed) {
    return (
      <div className="ask ask-collapsed" style={{ left: box.left, bottom: box.bottom }}>
        <span className="ask-collapsed-title">{getLang() === "en" ? "A choice is waiting" : "有个选择待处理"}</span>
        <button type="button" className="ask-expand" onClick={() => setCollapsed(false)}>
          {getLang() === "en" ? "Expand" : "展开"}
        </button>
      </div>
    );
  }
  return (
    <div
      ref={panelRef}
      className="ask"
      style={
        box
          ? {
              left: box.left,
              width: userSize ? userSize.w : box.width,
              bottom: box.bottom,
              ...(userSize ? { height: userSize.h, maxHeight: "none" } : null),
            }
          : { visibility: "hidden" }
      }
    >
      {/* 右上角：复位(仅放大后显示) + 折叠 + 调尺寸手柄 */}
      {userSize && (
        <button
          type="button"
          className="ask-ctl ask-restore"
          title={t("ask.restoreSize", "恢复默认宽高(跟随输入框)")}
          onClick={() => setUserSize(null)}
        >
          <RestoreSizeIcon />
        </button>
      )}
      <button
        type="button"
        className="ask-ctl ask-fold"
        title={t("ask.fold", "折叠(先看后面的内容，再展开选择)")}
        onClick={() => setCollapsed(true)}
      >
        <FoldIcon />
      </button>
      <span className="ask-resize" onMouseDown={onResizeDown} title={t("ask.resize", "拖动调整大小")} />
      <div className="ask-q">
        <div className="ask-qhead">
          {q.header && <span className="ask-tag">{q.header}</span>}
          <span className="ask-title">{q.question}</span>
          {q.multiSelect && <span className="ask-multi">{getLang() === "en" ? "Multi-select" : "可多选"}</span>}
        </div>
        {autoOn && (
          <div className="ask-auto">
            <span className="ask-auto-txt">
              {(lang || getLang()) === "en"
                ? `Smart-continue: auto-picking the best option toward the goal in ${left}s`
                : `智能继续：${left} 秒后按总目标自动替你选`}
            </span>
            <button type="button" className="ask-auto-wait" onClick={() => setAutoCancelled(true)}>
              {(lang || getLang()) === "en" ? "let me choose" : "我自己选"}
            </button>
          </div>
        )}
        {!autoOn && judging && (
          <div className="ask-redline">
            {(lang || getLang()) === "en" ? "Smart-continue: checking whether this is safe to auto-decide…" : "智能继续：正在判断这题能不能替你定…"}
          </div>
        )}
        {!autoOn && !judging && redlineHit && (
          <div className="ask-redline" title={(lang || getLang()) === "en" ? "Smart-continue won't auto-decide on this; adjust in Settings → Smart-continue" : "智能继续不替你定这类；可在 设置→智能继续 调整"}>
            {(() => {
              const srcZh = redlineHit.src === "custom" ? "你自定义的" : redlineHit.src === "smart" ? "智能识别" : "内置";
              const srcEn = redlineHit.src === "custom" ? "your custom rule" : redlineHit.src === "smart" ? "smart-detected" : "built-in";
              return (lang || getLang()) === "en"
                ? `Redline hit: “${redlineHit.word}” (${srcEn}) — waiting for you, no auto-pick. Adjust in Settings → Smart-continue.`
                : `命中红线「${redlineHit.word}」（${srcZh}），不自动替你选、停下等你。想改去 设置→智能继续。`;
            })()}
          </div>
        )}
        <div className="ask-opts">
          {q.options.map((o, oi) => {
            const on = (sel[step] || []).includes(o.label);
            return (
              <button key={oi} type="button" className={"ask-opt" + (on ? " on" : "")} onClick={() => pick(o.label, curMulti)}>
                <span className="ask-opt-label">{o.label}</span>
                {o.description && <span className="ask-opt-desc">{o.description}</span>}
              </button>
            );
          })}
        </div>
        {curImgs.length > 0 && (
          <div className="img-strip ask-imgs">
            {curImgs.map((src, i) => (
              <div className="thumb" key={i}>
                <img src={src} alt="" />
                <button
                  type="button"
                  title={t("msg.remove", "移除")}
                  onClick={() => setImgs((m) => ({ ...m, [step]: (m[step] || []).filter((_, j) => j !== i) }))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="ask-other-row">
          <input
            className="ask-other"
            placeholder={t("ask.otherPlaceholder", "其它（手动输入或粘贴/添加截图，可选）")}
            value={other[step] || ""}
            onFocus={() => setAutoCancelled(true)} // 一点进手动输入框就取消自动提交，别抢你正在打的字/图
            onChange={(e) => setOther((o) => ({ ...o, [step]: e.target.value }))}
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
                addImgFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && curAnswered) advance();
            }}
          />
          <button
            type="button"
            className="ask-attach"
            title={t("ask.addShot", "添加截图")}
            onClick={() => { setAutoCancelled(true); fileRef.current?.click(); }}
          >
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) addImgFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      <div className="ask-foot">
        <button type="button" onClick={onCancel}>
          {getLang() === "en" ? "Cancel" : "取消"}
        </button>
        {qs.length > 1 && (
          <span className="ask-step">
            {step + 1} / {qs.length}
          </span>
        )}
        <span className="ask-foot-spacer" />
        {step > 0 && (
          <button type="button" onClick={() => setStep((v) => v - 1)}>
            {getLang() === "en" ? "Back" : "上一步"}
          </button>
        )}
        {showPrimary && (
          <button type="button" className="allow" disabled={!curAnswered} onClick={() => advance()}>
            {isLast ? (getLang() === "en" ? "Submit" : "提交") : (getLang() === "en" ? "Next" : "下一步")}
          </button>
        )}
      </div>
    </div>
  );
}
// 复制按钮：点后短暂显示绿色勾 + "已复制"提示
// 智能继续：自定义红线编辑(设置面板)
function StopRulesSettings({ lang }: { lang: Lang }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    window.wuwei.stopRulesGet?.().then((t) => setText(t || "")).catch(() => {});
  }, []);
  return (
    <>
      <div className="app-set-row" style={{ cursor: "default" }}>
        <div className="app-set-label">{lang === "en" ? "When it must stop and ask me (add your own)" : "必须停下来问我的情况（自己加）"}</div>
      </div>
      <textarea
        rows={5}
        style={{ width: "100%", boxSizing: "border-box", resize: "vertical", background: "var(--bg-input)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: 10, padding: "10px 12px", fontFamily: "var(--sans)", fontSize: 13, lineHeight: 1.6, outline: "none" }}
        value={text}
        placeholder={lang === "en" ? "one per line, e.g.\ntouch the prod DB / prod containers\nemail or message anyone\nchange nginx config" : "一行一条，例：\n碰线上库 / prod 容器\n给任何人发邮件或短信\n改 nginx 配置\n跑超过 10 分钟的任务"}
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
        onBlur={() => {
          window.wuwei.stopRulesSet?.(text);
          window.dispatchEvent(new CustomEvent("wuwei-stop-rules", { detail: text }));
          setSaved(true);
        }}
      />
      <div style={{ fontSize: 11, opacity: saved ? 0.75 : 0.45, margin: "4px 0 10px" }}>
        {saved ? (lang === "en" ? "Saved (saves when you leave the box)" : "已保存（离开输入框即保存）") : (lang === "en" ? "Click elsewhere to save" : "改完点一下别处即保存")}
      </div>
    </>
  );
}

// 智能继续：连推安全阀(设置面板)
function ContSettings({ lang }: { lang: Lang }) {
  const [max, setMax] = useState(() => {
    const v = localStorage.getItem("wuwei-cont-max");
    return v === null ? 30 : Math.max(0, Number(v) || 0);
  });
  const [delay, setDelay] = useState(() => {
    const v = localStorage.getItem("wuwei-cont-delay");
    return v === null ? 1200 : Number(v) || 0;
  });
  const [askSec, setAskSec] = useState(() => {
    const v = localStorage.getItem("wuwei-ask-auto-sec");
    return v === null ? 3 : Number(v) || 0;
  });
  const pushCfg = (m: number, d: number, a: number) => {
    localStorage.setItem("wuwei-cont-max", String(m));
    localStorage.setItem("wuwei-cont-delay", String(d));
    localStorage.setItem("wuwei-ask-auto-sec", String(a));
    window.dispatchEvent(new CustomEvent("wuwei-cont-cfg", { detail: { max: m, delay: d, askSec: a } }));
  };
  return (
    <>
      <div className="app-set-row" style={{ cursor: "default", gap: "10px" }}>
        <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>{lang === "en" ? "Smart-continue max rounds" : "智能继续最多连推"}</div>
        <span style={{ flex: 1 }} />
        <input
          type="number"
          min={0}
          value={max}
          style={{ width: 96, textAlign: "right", padding: "4px 8px", fontFamily: "var(--mono)", background: "var(--bg-input)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: 8, outline: "none" }}
          onChange={(e) => { const v = Math.max(0, Math.floor(Number(e.target.value) || 0)); setMax(v); pushCfg(v, delay, askSec); }}
        />
        <div className="app-set-hint" style={{ minWidth: 56, textAlign: "right" }}>
          {max <= 0 ? (lang === "en" ? "∞" : "不限") : (lang === "en" ? "rounds" : "轮")}
        </div>
      </div>
      <div style={{ fontSize: 11, opacity: .5, margin: "-2px 0 8px" }}>
        {lang === "en" ? "Any number; 0 = unlimited, keeps going until the goal is done (you can stop or switch to auto anytime)." : "自己填，多大都行；填 0 就是不限轮数，一直推到目标做完（随时能按停或切回自动）。"}
      </div>
      <div className="app-set-row" style={{ cursor: "default", gap: "10px" }}>
        <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>{lang === "en" ? "Undo window before sending" : "发出前反悔窗口"}</div>
        <input type="range" min={0} max={10000} step={100} value={delay} style={{ flex: 1 }} onChange={(e) => { const v = Number(e.target.value); setDelay(v); pushCfg(max, v, askSec); }} />
        <div className="app-set-hint" style={{ minWidth: 44, textAlign: "right" }}>
          {delay === 0 ? (lang === "en" ? "instant" : "立即") : (delay / 1000).toFixed(1) + (lang === "en" ? "s" : " 秒")}
        </div>
      </div>
      <div className="app-set-row" style={{ cursor: "default", gap: "10px" }}>
        <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>{lang === "en" ? "Auto-answer choices after" : "选择题多久由它自己定"}</div>
        <input type="range" min={0} max={30} step={1} value={askSec} style={{ flex: 1 }} onChange={(e) => { const v = Number(e.target.value); setAskSec(v); pushCfg(max, delay, v); }} />
        <div className="app-set-hint" style={{ minWidth: 44, textAlign: "right" }}>
          {askSec === 0 ? (lang === "en" ? "always wait" : "一直等我") : askSec + (lang === "en" ? "s" : " 秒")}
        </div>
      </div>
    </>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={"tf-icon" + (done ? " ok" : "")}
      title={done ? (getLang() === "en" ? "Copied" : "已复制") : (getLang() === "en" ? "Copy" : "复制")}
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
// 用户头像：Google 头像(lh3.googleusercontent.com)带 Referer 会被 403 → referrerPolicy=no-referrer；
// 仍加载失败(裂图)则退回首字母，绝不显示破图。
function UserAvatar({ url, fallback }: { url?: string | null; fallback: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <>{fallback}</>;
  return <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

// 抽取开头的 <think>…</think>（推理模型思考流，provider 已把 reasoning_content 也归一成 <think>）。
// open=true 表示流式中 <think> 还没闭合（正在思考）。只认开头，避免误伤正文里的代码/文本。
function splitThinking(text: string): { think: string; answer: string; open: boolean } {
  const closed = text.match(/^\s*<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\s*/i);
  if (closed) return { think: closed[1].trim(), answer: text.slice(closed[0].length), open: false };
  const opening = text.match(/^\s*<think(?:ing)?>([\s\S]*)$/i);
  if (opening) return { think: opening[1], answer: "", open: true };
  return { think: "", answer: text, open: false };
}

// 可折叠「深度思考」块：思考时自动展开，思考完自动收起（用户仍可点开）。
function ThinkBlock({ content, live }: { content: string; live?: boolean }) {
  const en = getLang() === "en";
  if (!content.trim() && !live) return null;
  return (
    <details className="think-block" open={live ? true : undefined}>
      <summary>
        <svg className="tk-ico" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.5c.32 3.6 2.28 5.56 5.9 5.88-3.62.32-5.58 2.28-5.9 5.9-.32-3.62-2.28-5.58-5.9-5.9 3.62-.32 5.58-2.28 5.9-5.88Z" />
          <path d="M18.6 13.8c.16 1.82 1.14 2.8 2.96 2.96-1.82.16-2.8 1.14-2.96 2.96-.16-1.82-1.14-2.8-2.96-2.96 1.82-.16 2.8-1.14 2.96-2.96Z" />
        </svg>
        <span>{en ? "Deep thinking" : "深度思考"}</span>
        {live && <span className="tk-live">{en ? "thinking…" : "思考中…"}</span>}
      </summary>
      <div className="tk-body">{content.trim()}</div>
    </details>
  );
}

// 数字婴儿：简约线性头像图标(替代 👶 emoji，跟随 currentColor)
function BabyGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg className="agi-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="13" r="7.5" />
      <path d="M11.8 5.5c.2-1.3 1.2-2 2.4-1.5" />
      <path d="M9.6 12.4v.5M14.4 12.4v.5" />
      <path d="M10 15.7c.9.7 3.1.7 4 0" />
    </svg>
  );
}

// —— 数字婴儿：自动吸底 pre + 知识网络力导向图(迁自 minicc) ——
function AutoStickPre({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >{text}</pre>
  );
}

function BabyBrainGraph({ nodes, edges }: { nodes: any[]; edges: any[] }) {
  // 画布随概念数放大：概念越多铺得越开，节点才不会挤成一坨(看全貌时整体缩放显示，
  // 滚轮放大读细节)。固定 1400×900 装 200+ 概念必然重叠。
  const spread = Math.min(3.4, Math.max(1, Math.sqrt(nodes.length / 55)));
  const W = Math.round(1400 * spread), H = Math.round(900 * spread);
  // 概念来源 → 固定语义色(不再用哈希随机色)：一眼分清哪些是自己上网学的、哪些是睡梦里涌现的
  const TYPE_COLOR: Record<string, string> = {
    "网络学的": "#6f9fad",
    "聊天学的": "#c05f3c",
    "知识宫殿": "#5c8a73",
    "天生好奇": "#c8933f",
    "睡梦里涌现的": "#9a7fbe",
    "好奇待学": "#8b949c",
    "概念": "#8b949c",
  };
  const color = (n: any) => {
    if (typeof n === "string") return TYPE_COLOR[n] || "#8b949c";
    if (n?.isDao) return "#c05f3c";
    if (n?.level === "abstract") return ["#9a7fbe", "#8a6fb4", "#7a5faa", "#6a4fa0"][Math.min(3, (n.depth || 1) - 1)];
    return TYPE_COLOR[n?.type] || "#8b949c";
  };
  // 节点大小：层级为主(睡梦涌现的上层认知更大、塔尖最大)，连接数为辅
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) { d.set(e.from, (d.get(e.from) || 0) + 1); d.set(e.to, (d.get(e.to) || 0) + 1); }
    return d;
  }, [edges]);
  const radiusOf = (n: any) => {
    const deg = degree.get(n.id) || 0;
    if (n.isDao) return 26;
    if (n.level === "abstract") return 11 + (n.depth || 1) * 3.6 + Math.min(7, (n.children?.length || 0) * 0.45);
    return 4.2 + Math.min(6.5, deg * 0.75);
  };
  // 布局：以「语义坐标」为骨架——后端把概念向量降到 2 维，意思相近的天然在一起、
  // 不相干的隔得远。力学只做两件事：把上层认知拉到它孩子们中间、把挤在一起的推开，
  // 不再让弹簧把语义结构揉乱(所以有锚定力把每个点拽回它的语义位置)。
  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    const vel = new Map<string, { vx: number; vy: number }>();
    const anchor = new Map<string, { x: number; y: number }>();
    const byId = new Map<string, any>(nodes.map((n) => [n.id, n]));
    const MX = 150, MY = 90;
    let seed = 20240814;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const hasSem = nodes.some((n) => typeof n.sx === "number");
    for (const n of nodes) {
      const p = typeof n.sx === "number"
        ? { x: MX + n.sx * (W - 2 * MX), y: MY + n.sy * (H - 2 * MY) }
        : { x: W / 2 + (rnd() - 0.5) * 700, y: H / 2 + (rnd() - 0.5) * 500 };
      pos.set(n.id, { ...p });
      anchor.set(n.id, { ...p });
      vel.set(n.id, { vx: 0, vy: 0 });
    }
    // 上层认知的锚点挪到它收编的那批概念的质心：塔尖自然浮在整片知识的正中
    for (const n of nodes) {
      if (n.level !== "abstract" || !n.children?.length) continue;
      let sx = 0, sy = 0, k = 0;
      for (const c of n.children) { const p = anchor.get(c); if (p) { sx += p.x; sy += p.y; k++; } }
      if (k) {
        const a = anchor.get(n.id)!;
        a.x = hasSem ? a.x * 0.35 + (sx / k) * 0.65 : sx / k;
        a.y = hasSem ? a.y * 0.35 + (sy / k) * 0.65 : sy / k;
        pos.set(n.id, { ...a });
      }
    }
    const ids = nodes.map((n) => n.id);
    // 每个节点的占位框 = 圆 + 右边那截标签(只算常显标签的)。
    // 只按圆心距离防重叠是不够的——挤在一起的其实是文字，框算进标签才真的分得开。
    const box = new Map<string, { w: number; h: number; ox: number }>();
    for (const n of nodes) {
      const r = radiusOf(n);
      const abs = n.level === "abstract";
      const showLabel = abs || r >= 8.5;
      const fs = abs ? Math.min(17, 11 + (n.depth || 1) * 1.6) : 10.5;
      const nm = String(n.name || "").slice(0, 22);
      let lw = 0;
      if (showLabel) for (const ch of nm) lw += /[⺀-鿿＀-￯]/.test(ch) ? fs : fs * 0.56;
      box.set(n.id, {
        w: 2 * r + (lw ? lw + 8 : 0),
        h: Math.max(2 * r, showLabel ? fs * 1.35 : 2 * r),
        ox: lw ? (lw + 8) / 2 : 0,
      });
    }
    const PADX = 16, PADY = 9; // 框与框之间还要留的呼吸空间
    const separate = (k: number) => {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const A = pos.get(ids[i])!, B = pos.get(ids[j])!;
        const ba = box.get(ids[i])!, bb = box.get(ids[j])!;
        const dx = A.x + ba.ox - (B.x + bb.ox), dy = A.y - B.y;
        const ox = (ba.w + bb.w) / 2 + PADX - Math.abs(dx);
        if (ox <= 0) continue;
        const oy = (ba.h + bb.h) / 2 + PADY - Math.abs(dy);
        if (oy <= 0) continue;
        const va = vel.get(ids[i])!, vb = vel.get(ids[j])!;
        if (ox < oy) { // 沿更省力的那个轴推开
          const f = (dx >= 0 ? 1 : -1) * ox * k;
          va.vx += f; vb.vx -= f;
        } else {
          const f = (dy >= 0 ? 1 : -1) * oy * k;
          va.vy += f; vb.vy -= f;
        }
      }
    };
    const ANCHOR_K = hasSem ? 0.026 : 0.002; // 有语义坐标就以它为准，否则退回向心力
    const ITER = ids.length > 200 ? 220 : 380;
    for (let it = 0; it < ITER; it++) {
      separate(0.24);
      for (const e of edges) {
        const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
        // 层级边(抽象自)拉得紧→同一个上层认知的概念抱成一团；普通关联很松，只给一点点牵引
        const belong = e.kind === "belong";
        const rest = belong ? 78 : 150, k = belong ? 0.028 : 0.006;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, f = (d - rest) * k;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        const va = vel.get(e.from)!, vb = vel.get(e.to)!;
        va.vx += fx; va.vy += fy; vb.vx -= fx; vb.vy -= fy;
      }
      for (const id of ids) {
        const p = pos.get(id)!, v = vel.get(id)!, a = anchor.get(id)!;
        const isAbs = byId.get(id)?.level === "abstract";
        const ak = isAbs ? ANCHOR_K * 1.6 : ANCHOR_K; // 上层认知更贴紧它孩子的质心
        v.vx += (a.x - p.x) * ak; v.vy += (a.y - p.y) * ak;
        v.vx *= 0.84; v.vy *= 0.84; p.x += v.vx; p.y += v.vy;
      }
    }
    // 收尾：只解重叠，不再拉锚点/弹簧——保证最后谁也不压着谁
    for (let it = 0; it < 130; it++) {
      separate(0.5);
      for (const id of ids) {
        const p = pos.get(id)!, v = vel.get(id)!, b = box.get(id)!;
        v.vx *= 0.55; v.vy *= 0.55; p.x += v.vx; p.y += v.vy;
        p.x = Math.max(b.w / 2 + 10, Math.min(W - b.w / 2 - 10, p.x)); // 别飘出画布
        p.y = Math.max(b.h / 2 + 10, Math.min(H - b.h / 2 - 10, p.y));
      }
    }
    return pos;
  }, [nodes, edges]);
  const [override, setOverride] = useState<Map<string, { x: number; y: number }>>(new Map());
  const gp = (id: string) => override.get(id) || layout.get(id) || { x: W / 2, y: H / 2 };
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<{ kind: "node" | "edge"; id: string; mx: number; my: number } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id?: string; kind: "node" | "pan"; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const nodeById = useMemo(() => { const m = new Map<string, any>(); for (const n of nodes) m.set(n.id, n); return m; }, [nodes]);
  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const vx = ((cx - r.left) / r.width) * W, vy = ((cy - r.top) / r.height) * H;
    return { x: (vx - view.x) / view.k, y: (vy - view.y) / view.k };
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current; if (!d) return;
      const w = toWorld(e.clientX, e.clientY);
      if (d.kind === "node" && d.id) { d.moved = true; setOverride((m) => { const n = new Map(m); n.set(d.id!, { x: w.x, y: w.y }); return n; }); }
      else { const r = svgRef.current!.getBoundingClientRect(); const scale = W / r.width; setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx) * scale, y: d.oy + (e.clientY - d.sy) * scale })); }
    };
    const up = (e: MouseEvent) => { const d = dragRef.current; if (d && d.kind === "node" && !d.moved && d.id) setSel(d.id); dragRef.current = null; };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  });
  useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const r = svg.getBoundingClientRect(); const vx = ((e.clientX - r.left) / r.width) * W, vy = ((e.clientY - r.top) / r.height) * H; setView((v) => { const wx = (vx - v.x) / v.k, wy = (vy - v.y) / v.k; const k = Math.max(0.3, Math.min(4, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); return { k, x: vx - wx * k, y: vy - wy * k }; }); };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);
  const selNode = sel ? nodeById.get(sel) : null;
  const hoverNode = hover?.kind === "node" ? nodeById.get(hover.id) : null;
  const hoverEdge = hover?.kind === "edge" ? edges.find((e) => e.id === hover.id) : null;
  return (
    <div className="bbg-wrap">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="bbg-svg"
        onMouseDown={(e) => { const w = toWorld(e.clientX, e.clientY); dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false }; setSel(null); }}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges.map((e) => { const a = gp(e.from), b = gp(e.to); if (!a || !b) return null; const on = sel && (e.from === sel || e.to === sel); const belong = e.kind === "belong"; return (
            <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={on ? "var(--accent)" : belong ? "#9a7fbe" : "#8b949c"}
              strokeWidth={on ? 1.8 : belong ? 1 : 0.6}
              strokeDasharray={belong ? "4 4" : undefined}
              strokeOpacity={sel && !on ? 0.12 : belong ? 0.5 : 0.34}
              onMouseEnter={(ev) => setHover({ kind: "edge", id: e.id, mx: ev.clientX, my: ev.clientY })} onMouseLeave={() => setHover(null)} />
          ); })}
          {nodes.map((n) => {
            const p = gp(n.id); const r = radiusOf(n); const abs = n.level === "abstract";
            const dim = sel && sel !== n.id && !edges.some((e) => (e.from === sel && e.to === n.id) || (e.to === sel && e.from === n.id));
            // 标签只给"够大的"节点常显(小概念挤在一起会糊成一片)，放大到 1.5 倍以上或选中/悬停时全显
            const showLabel = abs || r >= 8.5 || view.k >= 1.5 || sel === n.id || hover?.id === n.id;
            return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`} style={{ cursor: "pointer", opacity: dim ? 0.22 : 1 }}
              onMouseDown={(ev) => { ev.stopPropagation(); const w = toWorld(ev.clientX, ev.clientY); dragRef.current = { id: n.id, kind: "node", sx: ev.clientX, sy: ev.clientY, ox: 0, oy: 0, moved: false }; }}
              onMouseEnter={(ev) => setHover({ kind: "node", id: n.id, mx: ev.clientX, my: ev.clientY })} onMouseLeave={() => setHover(null)}>
              {abs && <circle r={r + 7} fill={color(n)} opacity={0.13} />}
              <circle r={r} fill={color(n)} stroke={sel === n.id ? "var(--text)" : "var(--bg)"} strokeWidth={sel === n.id ? 2.4 : abs ? 2 : 1} />
              {showLabel && (
                <text x={r + 3} y={abs ? 5 : 3.6} fontSize={abs ? Math.min(17, 11 + (n.depth || 1) * 1.6) : 10.5}
                  fontWeight={abs ? 700 : 400} fill="var(--text)" style={{ pointerEvents: "none" }}>
                  {n.name.length > 22 ? n.name.slice(0, 21) + "…" : n.name}
                </text>
              )}
            </g>
          ); })}
        </g>
      </svg>
      {(hoverNode || hoverEdge) && (
        <div className="bbg-tip" style={{ left: Math.min((hover!.mx - (svgRef.current?.getBoundingClientRect().left || 0)) + 14, W), top: (hover!.my - (svgRef.current?.getBoundingClientRect().top || 0)) + 14 }}>
          {hoverNode ? (<>
            <div className="bbg-tip-h"><span className="bbg-dot" style={{ background: color(hoverNode) }} />{hoverNode.name}</div>
            <div className="bbg-tip-type">
              {hoverNode.level === "abstract"
                ? (hoverNode.isDao ? "塔尖 · 万物归一" : `第 ${hoverNode.depth} 层抽象 · 收敛了 ${hoverNode.children?.length || 0} 个`)
                : hoverNode.type + (hoverNode.parent ? ` · 归入「${hoverNode.parent}」` : " · 还没固化")}
            </div>
            {hoverNode.summary && <div className="bbg-tip-sum">{hoverNode.summary}</div>}
          </>) : (<>
            <div className="bbg-tip-h">{hoverEdge.relation}</div>
            <div className="bbg-tip-sum">{hoverEdge.from} → {hoverEdge.to}</div>
          </>)}
        </div>
      )}
      {selNode && (
        <div className="bbg-detail">
          <div className="bbg-detail-h"><span className="bbg-dot" style={{ background: color(selNode) }} />{selNode.name}<button onClick={() => setSel(null)}><Ic.IcBack size={13} /></button></div>
          <div className="bbg-detail-type">
            {selNode.level === "abstract"
              ? (selNode.isDao ? "塔尖 · 万物归一" : `第 ${selNode.depth} 层抽象认知`)
              : `类型：${selNode.type}`}
          </div>
          {selNode.level === "abstract" && !!selNode.children?.length && (
            <div className="bbg-detail-row"><b>由这些收敛而来（{selNode.children.length}）</b><div>{selNode.children.join("、")}</div></div>
          )}
          {selNode.level !== "abstract" && (
            <div className="bbg-detail-row"><b>固化情况</b><div>{selNode.parent ? `已归入「${selNode.parent}」` : "还没被收编进任何上层认知"}</div></div>
          )}
          {selNode.summary && <div className="bbg-detail-row"><b>它的理解</b><div>{selNode.summary}</div></div>}
          {selNode.attrs && Object.entries(selNode.attrs).map(([k, v]) => (<div key={k} className="bbg-detail-row"><b>{k}</b><div>{String(v)}</div></div>))}
        </div>
      )}
    </div>
  );
}

const AssistantMsg = React.memo(function AssistantMsg({
  text,
  streaming,
  anchor,
}: {
  text: string;
  streaming?: boolean;
  anchor?: string; // 搜索定位锚点(见 Item.anchor)
}) {
  const { think, answer, open } = splitThinking(text);
  const thinkEl = (think || (streaming && open)) ? <ThinkBlock content={think} live={streaming && open} /> : null;
  if (!streaming) {
    return (
      <div className="aimsg" data-anchor={anchor}>
        {thinkEl}
        {answer && <MarkdownView text={answer} highlight={true} />}
      </div>
    );
  }
  const cut = answer.lastIndexOf("\n\n"); // 最后一个段落边界
  const committed = cut >= 0 ? answer.slice(0, cut) : "";
  const tail = cut >= 0 ? answer.slice(cut + 2) : answer;
  return (
    <div className="aimsg" data-anchor={anchor}>
      {thinkEl}
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
      <button className={"code-copy" + (done ? " ok" : "")} onClick={copy} title={makeT(getLang())("code.copy", "复制代码")}>
        {done ? (getLang() === "en" ? "✓ Copied" : "✓ 已复制") : (getLang() === "en" ? "Copy" : "复制")}
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
                if (href) window.wuwei.openExternal(href);
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
  const en = getLang() === "en";
  if (/\b(test|pytest|jest|vitest|go test|npm (run )?test)\b/.test(c)) return en ? "Test" : "测试";
  if (/(electron-vite build|vite build|tsc\b|\b(npm|yarn|pnpm) (run )?build\b|cargo build|go build|\bmake\b)/.test(c))
    return en ? "Build" : "构建";
  if (/(electron-builder|--dir|\bpkg\b|package)/.test(c)) return en ? "Package" : "打包";
  if (/\b(deploy|scp|rsync|publish)\b|docker (push|cp)|rm -rf .*app|cp -R .*\.app|xattr/.test(c))
    return en ? "Deploy" : "部署";
  if (/\b(install|pip install|npm i\b|yarn add|apt|brew install)\b/.test(c)) return en ? "Install deps" : "安装依赖";
  if (/\bgit\b/.test(c)) return en ? "Git" : "Git 操作";
  if (/\b(grep|rg|ag|ack)\b/.test(c)) return en ? "Search" : "搜索内容";
  if (/\b(ls|find|tree|du|stat|fd)\b/.test(c)) return en ? "List dir" : "浏览目录";
  if (/\b(cat|head|tail|less|more|sed|awk)\b/.test(c)) return en ? "View file" : "查看文件";
  if (/\b(mkdir|touch|cp|mv|rm|chmod|ln)\b/.test(c)) return en ? "File op" : "文件操作";
  if (/\b(node|python3?|electron|osascript|open|kill|pkill)\b|(^|\s)\.\//.test(c)) return en ? "Run" : "运行";
  return en ? "Run command" : "执行命令";
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
  const uniq = acts.length ? acts : [getLang() === "en" ? "Run command" : "执行命令"];
  return { label: uniq.slice(0, 4).join(" · "), category: uniq[0] };
}

// 工具的图标 + 意图描述 + 类别（分组用）+ 行数增删
// 工具标签压成单行并截断：命令/URL/搜索词可能很长、还可能带换行，
// 原样拼进标签会把同一行右侧的耗时/token/状态挤掉(甚至撑成多行)。完整内容展开后在 .tcmd 里看。
function oneLineLabel(s: string, max = 64): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
function toolMeta(item: Extract<Item, { type: "tool" }>): {
  icon: string;
  label: string;
  category: string;
  add?: number;
  del?: number;
} {
  const m = toolMetaRaw(item);
  return { ...m, label: oneLineLabel(m.label) };
}
// 未截断的原始标签(悬停提示用完整版)
function toolMetaRaw(item: Extract<Item, { type: "tool" }>): {
  icon: string;
  label: string;
  category: string;
  add?: number;
  del?: number;
} {
  const inp = item.input as any;
  const en = getLang() === "en";
  switch (item.name) {
    case "bash": {
      const bi = bashIntent(String(inp.command || ""));
      return { icon: "⌘", label: bi.label, category: bi.category };
    }
    case "powershell":
      return { icon: "⌘", label: (en ? "PowerShell: " : "PowerShell：") + String(inp.command || ""), category: en ? "Windows command" : "Windows 命令" };
    case "read_file":
      return {
        icon: "◎",
        label: (en ? "Read " : "读取 ") + baseName(String(inp.path || "")),
        category: en ? "Read file" : "读取文件",
      };
    case "write_file":
      return {
        icon: "✎",
        label: (en ? "Create " : "新建 ") + baseName(String(inp.path || "")),
        category: en ? "Create file" : "新建文件",
        add: String(inp.content ?? "").length, // 字符数
      };
    case "edit_file":
      return {
        icon: "✎",
        label: (en ? "Edit " : "编辑 ") + baseName(String(inp.path || "")),
        category: en ? "Edit file" : "编辑文件",
        add: String(inp.new_string ?? "").length, // 新增字符数
        del: String(inp.old_string ?? "").length, // 删除字符数
      };
    case "glob":
      return { icon: "⌕", label: en ? "Find files" : "查找文件", category: en ? "Search" : "搜索内容" };
    case "grep":
      return { icon: "⌕", label: en ? "Search content" : "搜索内容", category: en ? "Search" : "搜索内容" };
    case "web_search":
      return { icon: "🌐", label: (en ? "Web search: " : "搜索网络：") + String(inp.query || ""), category: en ? "Web search" : "联网搜索" };
    case "web_fetch":
      return { icon: "🌐", label: (en ? "Fetch page " : "抓取网页 ") + String(inp.url || ""), category: en ? "Read page" : "读取网页" };
    case "browser_open":
      return { icon: "🖥", label: (en ? "Browser open " : "浏览器打开 ") + String(inp.url || ""), category: en ? "Browser" : "浏览器" };
    case "browser_read":
      return { icon: "🖥", label: en ? "Read current page" : "读取当前页面", category: en ? "Browser" : "浏览器" };
    case "browser_click":
      return { icon: "🖥", label: (en ? "Click " : "点击 ") + String(inp.selector || ""), category: en ? "Browser" : "浏览器" };
    case "remember":
      return { icon: "✦", label: (en ? "Remember: " : "记住：") + String(inp.text || ""), category: en ? "Save memory" : "写入记忆" };
    default:
      return { icon: "•", label: item.name, category: item.name };
  }
}

// 工具输入预览：展开后显示"具体在执行啥"(运行中也能看)
function toolInputPreview(item: Extract<Item, { type: "tool" }>): string {
  const inp = (item.input || {}) as any;
  const en = getLang() === "en";
  switch (item.name) {
    case "bash":
      return "$ " + String(inp.command || "");
    case "powershell":
      return "PS> " + String(inp.command || "");
    case "read_file":
      return (en ? "Read " : "读取 ") + String(inp.path || "");
    case "write_file":
      return (en ? "Write " : "写入 ") + String(inp.path || "");
    case "edit_file":
      return (en ? "Edit " : "编辑 ") + String(inp.path || "");
    case "grep":
      return (en ? `Search "${inp.pattern ?? ""}"` : `搜索 “${inp.pattern ?? ""}”`) + (inp.path ? (en ? `  ·  path ${inp.path}` : `  ·  路径 ${inp.path}`) : "");
    case "glob":
      return (en ? `Match ${inp.pattern ?? inp.glob ?? ""}` : `匹配 ${inp.pattern ?? inp.glob ?? ""}`) + (inp.path ? (en ? `  ·  path ${inp.path}` : `  ·  路径 ${inp.path}`) : "");
    case "web_search":
      return (en ? `Web search: ${inp.query ?? ""}` : `搜索网络：${inp.query ?? ""}`);
    case "web_fetch":
      return (en ? `Fetch ${inp.url ?? ""}` : `抓取 ${inp.url ?? ""}`);
    case "browser_open":
      return (en ? `Browser open ${inp.url ?? ""}` : `浏览器打开 ${inp.url ?? ""}`);
    case "browser_click":
      return (en ? `Click ${inp.selector ?? ""}` : `点击 ${inp.selector ?? ""}`);
    case "remember":
      return (en ? `Remember: ${inp.text ?? ""}` : `记住：${inp.text ?? ""}`);
    default: {
      const s = JSON.stringify(inp);
      return s === "{}" ? "" : s;
    }
  }
}

const ToolView = React.memo(function ToolView({ item }: { item: Extract<Item, { type: "tool" }> }) {
  const [open, setOpen] = useState(false); // 默认折叠
  const m = toolMeta(item);
  const en = getLang() === "en";
  const running = item.status === "running";
  const diff = renderDiff(item);
  const cmd = (item.name === "bash" || item.name === "powershell") ? String((item.input as any).command || "") : "";
  const inputStr = toolInputPreview(item);
  // 有输入/结果/diff 都可展开——运行中也能点开看正在执行的输入
  const hasDetail = !!diff || !!item.result || !!inputStr;
  return (
    <div className="tool">
      <div className="trow" onClick={() => hasDetail && setOpen((v) => !v)}>
        <span className="tlabel" title={toolMetaRaw(item).label}>
          {m.label}
        </span>
        {(m.add != null || m.del != null) && (
          <span
            className="tdelta"
            title={en ? `+${m.add ?? 0} chars${m.del != null ? ` · -${m.del} chars` : ""}` : `新增 ${m.add ?? 0} 字符${m.del != null ? ` · 删除 ${m.del} 字符` : ""}`}
          >
            {m.add != null && <span className="add">+{m.add}</span>}
            {m.del != null && <span className="del">-{m.del}</span>}
            <span className="tunit">{en ? " chars" : " 字符"}</span>
          </span>
        )}
        <span className="tspacer" />
        <span className={"tstat " + (running ? "run" : item.isError ? "err" : "ok")}>
          {running ? (en ? "Running" : "运行中") : item.isError ? (en ? "Failed" : "失败") : (en ? "Done" : "完成")}
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
  const en = getLang() === "en";
  const mainCat = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || (en ? "Actions" : "操作");
  return (
    <div className="tool">
      <div className="trow" onClick={() => setOpen((v) => !v)}>
        <span className="tlabel">
          {mainCat} · {tools.length}{en ? " steps" : " 步"}{running ? `（${done}/${tools.length}）` : ""}
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
// 取一个 AI 回合末尾的累计用量快照(回合内最后一条带 usage 的助手文字)
function aiTurnUsage(blocks: RenderBlock[]): UsageSnap | undefined {
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    if (b.kind === "item" && b.item.type === "assistant" && (b.item as any).usage)
      return (b.item as any).usage as UsageSnap;
  }
  return undefined;
}
// token 数紧凑显示：1234→1.2k，1200000→1.2M
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
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
  return arr.length > lines ? arr.slice(0, lines).join("\n") + (getLang() === "en" ? "\n…(truncated)" : "\n…（已截断）") : text;
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
  anon?: boolean; // 未登录也可见/可用(匿名试用免费模型；hosted 平台但免登录，靠设备/IP 每日护栏)
}

// 用户自定义中转站
type Station = { id: string; label: string; baseUrl: string; relay?: boolean };
// 自定义供应商/中转站 → 伪预设(OpenAI 兼容)，并入平台下拉。relay=true 才加「（中转）」后缀
// 模块级函数拿不到组件里的 lang，直接读 getLang()
function stationToPreset(s: Station): Preset {
  const en = getLang() === "en";
  return {
    id: s.id,
    label: s.relay ? s.label + (en ? " (relay)" : "（中转）") : s.label,
    kind: "openai",
    baseUrl: s.baseUrl,
    keyUrl: "",
    keyHint: "sk-...",
    models: [],
    note: s.relay
      ? en
        ? "Custom relay (OpenAI-compatible — one key, many platforms). Enter the model name from the relay's docs; free text is fine."
        : "自定义中转站（OpenAI 兼容，一个 key 直连多平台）。模型名按该站文档填，可自定义输入。"
      : en
        ? "Self-hosted / custom provider (OpenAI-compatible endpoint, e.g. your own vLLM or Ollama). Model name is free text."
        : "自建/自定义供应商（OpenAI 兼容端点，如公司 vLLM/Ollama）。模型名可自定义输入。",
    fixedBaseUrl: true,
    custom: true,
  };
}

// 应用用户对平台的「删除/改名/改端点」覆盖：过滤掉 removed，再按 overrides 改 label/baseUrl(含内置平台)
function applyProviderEdits(
  presets: Preset[],
  overrides: Record<string, { label?: string; baseUrl?: string }>,
  removed: string[],
): Preset[] {
  return presets
    .filter((p) => !removed.includes(p.id))
    .map((p) => {
      const o = overrides[p.id];
      if (!o) return p;
      return { ...p, label: o.label ?? p.label, baseUrl: o.baseUrl ?? p.baseUrl };
    });
}

// 私有版：保留 Codex/Claude 两种订阅后端，其余为各平台 API Key 预设（模型 id 均取自官网 2026-07）
const PRESETS: Preset[] = [
  {
    // 免费体验：无需登录、无需 Key，直接试用智谱免费模型（GLM-*-Flash）。走网关匿名分支，靠设备/IP 每日护栏防滥用。
    id: "wuwei-free",
    label: "免费体验（无需登录）",
    kind: "openai",
    baseUrl: "https://wuweiai.io/api/gateway/v1",
    keyUrl: "",
    keyHint: "",
    models: ["glm-4.7-flash", "glm-4-flash", "glm-z1-flash", "glm-4v-flash"],
    note: "免费体验：无需登录、无需 Key，直接试用智谱免费大模型（GLM-*-Flash）。每台设备每日有限次数，登录后可解锁更多模型与更高额度。",
    fixedBaseUrl: true,
    hosted: true,
    anon: true,
  },
  {
    // 无为托管：走网关、用无为币按 token 扣费，无需自己的 Key。仅灰度放开的用户可见。
    id: "wuwei-deepseek",
    label: "无为托管 · DeepSeek",
    kind: "openai",
    baseUrl: "https://wuweiai.io/api/gateway/v1",
    keyUrl: "",
    keyHint: "",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    note: "无为托管额度：无需自己的 Key，按实际 token 消耗扣无为币（余额在账号菜单查看）。模型与直连 DeepSeek 一致（V4 Pro/Flash）。",
    fixedBaseUrl: true,
    hosted: true,
  },
  {
    id: "wuwei-zhipu",
    label: "无为托管 · 智谱",
    kind: "openai",
    baseUrl: "https://wuweiai.io/api/gateway/v1",
    keyUrl: "",
    keyHint: "",
    models: ["glm-5.2"],
    note: "无为托管：无需自己的 Key，按 token 扣无为币。智谱 GLM-5.2 旗舰。",
    fixedBaseUrl: true,
    hosted: true,
  },
  {
    id: "wuwei-kimi",
    label: "无为托管 · Kimi",
    kind: "openai",
    baseUrl: "https://wuweiai.io/api/gateway/v1",
    keyUrl: "",
    keyHint: "",
    models: ["kimi-k3"],
    note: "无为托管：无需自己的 Key，按 token 扣无为币。Kimi K3 旗舰。",
    fixedBaseUrl: true,
    hosted: true,
  },
  {
    id: "wuwei-claude",
    label: "无为托管 · Claude",
    kind: "openai",
    baseUrl: "https://wuweiai.io/api/gateway/v1",
    keyUrl: "",
    keyHint: "",
    models: ["claude-opus-4-8"],
    note: "无为托管：无需自己的 Key，按 token 扣无为币。Claude Opus 4.8。",
    fixedBaseUrl: true,
    hosted: true,
  },
  {
    id: "wuwei-gpt",
    label: "无为托管 · GPT",
    kind: "openai",
    baseUrl: "https://wuweiai.io/api/gateway/v1",
    keyUrl: "",
    keyHint: "",
    models: ["gpt-5.5", "gpt-5.6"],
    note: "无为托管：无需自己的 Key，按 token 扣无为币。GPT-5.5 / 5.6。",
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
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ],
    note: "使用本机 ~/.codex 登录态，无需填写凭证。切换后看状态灯/实际请求为准（不通会亮黄灯）。",
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
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
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
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    note: "V4 Pro/Flash（deepseek-chat/deepseek-reasoner 已于 2026-07-24 停用，已移除）",
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

// 供应商目录英文覆盖（仅 EN 显示时用；缺省回退中文）。key = preset.id。不改 PRESETS 本体。
const PRESET_EN: Record<string, { label?: string; note?: string; keyHint?: string }> = {
  "wuwei-deepseek": { label: "Wuwei Hosted · DeepSeek", note: "Hosted credits: no key needed — charged per actual token usage (balance in the account menu). Same models as DeepSeek direct (V4 Pro/Flash)." },
  "wuwei-zhipu": { label: "Wuwei Hosted · Zhipu", note: "Hosted: no key needed, credits charged per token. Zhipu GLM-5.2 flagship." },
  "wuwei-kimi": { label: "Wuwei Hosted · Kimi", note: "Hosted: no key needed, credits charged per token. Kimi K3 flagship." },
  "wuwei-claude": { label: "Wuwei Hosted · Claude", note: "Hosted: no key needed, credits charged per token. Claude Opus 4.8." },
  "wuwei-gpt": { label: "Wuwei Hosted · GPT", note: "Hosted: no key needed, credits charged per token. GPT-5.5 / 5.6." },
  codex: { label: "Codex subscription (ChatGPT login)", note: "Uses your local ~/.codex login — no credentials needed. Only gpt-5.5 is device-verified; whether other models route through the subscription depends — watch the status light / actual requests after switching (a failure shows amber)." },
  "claude-oauth": { label: "Claude subscription (Claude Code)", keyHint: "sk-ant-oat… (auto-filled after one-click authorize above)" },
  "wuwei-free": { label: "Free trial (no login)", note: "Free trial: no login, no API key — try Zhipu's free models (GLM-*-Flash) right away. Limited uses per device per day; sign in to unlock more models and higher limits." },
  anthropic: { label: "Claude API Key (Anthropic)" },
  openai: { label: "OpenAI (GPT)", note: "gpt-5.6-terra balanced / sol strongest / luna cheapest" },
  openrouter: { label: "OpenRouter (all providers)", note: "One key for Claude / GPT / Gemini and more. Use “vendor/model” slugs (full list at openrouter.ai/models), or pick “Custom” to enter any slug." },
  deepseek: { label: "DeepSeek", note: "V4 Pro/Flash (deepseek-chat/deepseek-reasoner retired 2026-07-24, removed)" },
  qwen: { label: "Tongyi Qwen (Alibaba Bailian)" },
  doubao: { label: "Doubao (Volcano Ark)", keyHint: "Volcano Ark API Key", note: "Doubao usually needs an endpoint ID (ep-...) created under Ark “Online Inference”; dated model names change — use “Custom” to fill the latest." },
  zhipu: { label: "Zhipu GLM (BigModel)", keyHint: "Zhipu API Key", note: "glm-5.2 flagship (1M context); glm-5v-turbo / glm-4.6v are vision multimodal (text+image)" },
  kimi: { label: "Kimi (Moonshot)", note: "kimi-k3 flagship (2.8T/1M context); for the international site use https://api.moonshot.ai/v1; kimi-latest and *-vision-preview support text+image" },
  "kimi-sub": { label: "Kimi Code subscription (membership)", keyHint: "sk-... (created in the Kimi Code console for members)", note: "Uses membership subscription quota (not pay-as-you-go API). base=/coding/v1; flagship model is k3 (≠ the open-platform kimi-k3). Create keys in the Kimi Code console — up to 5, shown only once. ⚠ Official rule: don't change the User-Agent to impersonate other tools, or your membership may be banned." },
  hunyuan: { label: "Tencent Hunyuan (Yuanbao)", keyHint: "Hunyuan API Key", note: "Yuanbao maps to the Tencent Hunyuan API; hunyuan-vision supports text+image" },
  grok: { label: "Grok (xAI)", note: "grok-4.x is natively multimodal (text+image); grok-4.3 is the 1M-context flagship" },
  custom: { label: "Local / self-hosted endpoint (vLLM, Ollama, etc.)", keyHint: "Can be left blank locally", note: "Any OpenAI-compatible endpoint — just fill your Base URL + model name" },
};
const pLabel = (p: Preset, lang: Lang) => (lang === "en" && PRESET_EN[p.id]?.label) || p.label;
const pKeyHint = (p: Preset, lang: Lang) => (lang === "en" && PRESET_EN[p.id]?.keyHint) || p.keyHint;
const pNote = (p: Preset, lang: Lang) => (lang === "en" ? PRESET_EN[p.id]?.note ?? p.note : p.note);

// 菜单/下拉里的展示顺序(不改 PRESETS 定义本身，PRESETS[0]=codex 仍作默认)
// 默认平台顺序（无为托管整块置顶；后台 /api/catalog 会下发覆盖此默认序，用户本地拖动的顺序仍最优先）。
// 此常量是离线兜底：拉不到 catalog 时用它排。与后台迁移 ai_provider.sort 保持一致。
const PROVIDER_ORDER = [
  "wuwei-free",
  "wuwei-claude",
  "wuwei-gpt",
  "wuwei-deepseek",
  "wuwei-kimi",
  "wuwei-zhipu",
  "claude-oauth",
  "codex",
  "kimi-sub",
  "deepseek",
  "zhipu",
  "anthropic",
  "openrouter",
  "openai",
  "qwen",
  "doubao",
  "minimax",
  "hunyuan",
  "grok",
  "custom",
];

// 依据用户自定义顺序(order)+隐藏集(hidden)对预设列表排序/过滤。
// order 里没有的(新平台/新中转站)按内置 PROVIDER_ORDER 默认序、再按原始相对序补到末尾——保证永不漏显示。
// includeHidden=true 时保留隐藏项(设置里的平台管理列表用)，false 时过滤掉(切换菜单/正常展示用)。
// 把后台目录并入内置预设：
//  - catalog=null(离线/老后端) → 原样返回 base，全量回退硬编码，行为不变；
//  - 已知 id(在 base 里) → 保留本地 kind/baseUrl/keyUrl/note 等元数据，仅当 catalog 给了模型时覆盖 models；
//  - 未知 id(后台新增平台) → 整条按 catalog 字段构造 OpenAI 兼容 Preset；
//  - catalog 未含的内置平台视为"后台已隐藏"不返回，但强制保留 keepId(当前选中)避免用户被甩飞；
//  - 顺带收集免费模型 id 到 freeSet（给模型下拉打「免费」标）。
function mergeCatalogIntoPresets(
  base: Preset[],
  catalog: CatalogProviderDto[] | null,
  freeSet: Set<string>,
  keepId?: string,
  badgeMap?: Map<string, string>,
  labelMap?: Map<string, string>,
): Preset[] {
  if (!catalog || catalog.length === 0) return base;
  const byId = new Map(base.map((p) => [p.id, p]));
  const out: Preset[] = [];
  const seen = new Set<string>();
  for (const c of catalog) {
    for (const m of c.models) {
      if (m.free) freeSet.add(m.id);
      if (m.badge && badgeMap) badgeMap.set(m.id, m.badge);
      // 后台配了显示名且与 id 不同 → 记下，下拉里优先显示 label(如 gpt-5.6→"GPT-5.6 Sol")
      if (labelMap && m.label && m.label !== m.id) labelMap.set(m.id, m.label);
    }
    const models = c.models.map((m) => m.id);
    const local = byId.get(c.id);
    if (local) {
      // 已知平台：保留本地元数据，模型用 catalog 覆盖；anon(未登录可见)由后台控制，跟随 catalog。
      out.push({ ...local, ...(models.length ? { models } : {}), anon: c.anon });
    } else {
      out.push({
        id: c.id,
        label: c.label,
        kind: (c.kind as Kind) || "openai",
        baseUrl: c.baseUrl,
        keyUrl: c.keyUrl,
        keyHint: c.keyHint,
        models,
        note: c.note,
        fixedBaseUrl: c.hosted || !!c.baseUrl,
        custom: c.custom,
        hosted: c.hosted,
        anon: c.anon,
      });
    }
    seen.add(c.id);
  }
  // 强制保留当前选中平台（即便后台把它隐藏了），避免正在用的平台从下拉里消失导致无法发送
  if (keepId && !seen.has(keepId)) {
    const cur = byId.get(keepId);
    if (cur) out.push(cur);
  }
  return out;
}

function arrangePresets(
  all: Preset[],
  order: string[] | undefined,
  hidden: string[] | undefined,
  includeHidden: boolean,
  defaultOrder?: string[], // 后台 catalog 下发的默认序；缺省用内置 PROVIDER_ORDER。用户 order 永远最优先。
): Preset[] {
  const userRank = new Map((order || []).map((id, i) => [id, i]));
  const defRank = new Map((defaultOrder && defaultOrder.length ? defaultOrder : PROVIDER_ORDER).map((id, i) => [id, i]));
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

type ModelCap = { noTools?: boolean; vision?: boolean };
type CredSlot = { apiKey?: string; baseUrl?: string; oauthToken?: string; nickname?: string; model?: string; noTools?: boolean; vision?: boolean; modelCaps?: Record<string, ModelCap>; customModels?: string[] };

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

// MCP 目录英文覆盖（仅 EN 用；缺省回退中文）。key=name；fields key = env 名或 `arg{下标}`。
const MCP_EN: Record<string, { label?: string; desc?: string; fields?: Record<string, { label?: string; hint?: string }> }> = {
  filesystem: { label: "Filesystem", desc: "Read/write & search files in allowed dirs", fields: { arg2: { label: "Accessible directory", hint: "Directory the AI can read/write; defaults to Desktop — keep it or point to your project dir" } } },
  puppeteer: { label: "Puppeteer browser", desc: "Headless browser control/screenshots, works out of the box" },
  memory: { label: "Knowledge-graph memory", desc: "Persistent knowledge-graph memory, works out of the box" },
  "sequential-thinking": { label: "Sequential thinking", desc: "Structured multi-step reasoning, works out of the box" },
  github: { desc: "Repo / issue / PR operations", fields: { GITHUB_PERSONAL_ACCESS_TOKEN: { hint: "Generate at github.com/settings/tokens with repo scope" } } },
  "brave-search": { label: "Brave Search", desc: "Web search", fields: { BRAVE_API_KEY: { hint: "Free at brave.com/search/api" } } },
  postgres: { desc: "Query Postgres (read-only)", fields: { arg2: { label: "Connection string", hint: "postgresql://user:password@host:5432/dbname" } } },
  slack: { desc: "Read/write Slack messages", fields: { SLACK_BOT_TOKEN: { hint: "Starts with xoxb-" }, SLACK_TEAM_ID: { hint: "Starts with T" } } },
};
const mcpLabel = (c: CatalogItem, lang: Lang) => (lang === "en" && MCP_EN[c.name]?.label) || c.label;
const mcpDesc = (c: CatalogItem, lang: Lang) => (lang === "en" && MCP_EN[c.name]?.desc) || c.desc;
const mcpFieldEn = (name: string, key: string, kind: "label" | "hint", fallback: string, lang: Lang) =>
  (lang === "en" && MCP_EN[name]?.fields?.[key]?.[kind]) || fallback;

// 内置工具描述的英文（仅设置页 Tools 标签显示用；模型侧描述仍走 src/tools 原文）。按工具名。
const TOOL_DESC_EN: Record<string, string> = {
  read_file: "Read a text file's content with line numbers. For viewing code/files.",
  write_file: "Write/overwrite a file (creates it and parent dirs if missing).",
  edit_file: "Make an exact string replacement in a file. old_string must appear exactly once, or it errors.",
  bash: "Run a shell command in the working dir (bash on macOS/Linux; Windows defaults to WSL bash). Returns stdout+stderr and exit code.",
  powershell: "Run native Windows commands (PowerShell first, auto-falls back to cmd). For junctions/symlinks, the registry, services/processes, WMI and other native Windows work — more reliable than wrapping cmd inside bash. Falls back to a normal shell off Windows.",
  glob: "Find files by glob pattern (e.g. '**/*.ts'), returns matching paths.",
  grep: "Search file contents by regex/string, returns matching lines (file:line:content).",
  remember: "Save a long-term memory (preferences, facts, project background); auto-loaded in future chats.",
  web_search: "Search the web — returns titles/links/snippets of relevant pages. For latest info, research, and docs.",
  web_fetch: "Fetch a web page and return its main text content.",
  ask_user: "Pop up clickable options for the user to choose/confirm, instead of asking in prose.",
  brain_recall: "Recall relevant concepts and relations from the local Brain (knowledge graph).",
  brain_learn: "Add a concept / knowledge node to the local Brain.",
  brain_link: "Create a relation between two concepts in the Brain.",
  brain_forget: "Remove a concept or relation from the Brain.",
  brain_read_doc: "Read the full source of a document indexed in the Brain.",
  browser_open: "Open a web page URL in the built-in browser (can run JS; better than web_fetch for dynamic/interactive pages). After opening, use browser_read for text and browser_click to click elements.",
  browser_read: "Read the visible text of the built-in browser's current page (open one first with browser_open).",
  browser_click: "Click an element matching a CSS selector on the built-in browser's current page (buttons/links etc). Follow with browser_read to see changes.",
};
const toolDesc = (name: string, fallback: string, lang: Lang) => (lang === "en" && TOOL_DESC_EN[name]) || fallback;
// 记忆默认种子头 # 记忆 / # Memory 跟随界面语言互换（只换开头那一行 H1，用户后加的内容不动）
function swapMemHeader(text: string, lang: Lang): string {
  return lang === "en" ? text.replace(/^# 记忆(\s|$)/, "# Memory$1") : text.replace(/^# Memory(\s|$)/, "# 记忆$1");
}
const TOOL_SOURCE_EN: Record<string, string> = { "内置工具": "Built-in tools", "浏览器": "Browser" };
const TOOL_PARAM_EN: Record<string, Record<string, string>> = {
  read_file: { path: "File path (relative or absolute)", offset: "Start line (1-based), optional", limit: "Lines to read, default 2000" },
  write_file: { path: "File path (relative or absolute)", content: "Full content to write" },
  edit_file: { path: "File path", old_string: "Exact text to replace (must be unique in the file)", new_string: "Replacement text", replace_all: "Replace all occurrences, default false" },
  bash: { command: "Shell command to run", timeout_ms: "Timeout in ms, default 120000" },
  powershell: { command: "Command to run (PowerShell syntax; the same string is run as cmd syntax when falling back)", timeout_ms: "Timeout in ms, default 120000" },
  glob: { pattern: "Glob pattern, e.g. **/*.ts", path: "Search root directory, default working dir" },
  grep: { pattern: "Regex/string to search for", path: "Directory/file to search, default working dir", glob: "Filter by file type, e.g. '*.ts' (optional)" },
  web_search: { query: "Search query" },
  web_fetch: { url: "Web page URL (http/https)" },
  // ask_user 的问题/选项说明嵌在 items 里，逐层替换(见 localizeToolGroups)
  ask_user: {
    questions: "One or more questions to ask the user",
    question: "The question text",
    header: "Very short label (optional, e.g. “Approach”, “File”)",
    multiSelect: "Allow multiple selections (default: single-select)",
    options: "Clickable options",
    label: "Option text",
    description: "Option explanation (optional)",
  },
  remember: { text: "One line to remember long-term (concise, self-contained)" },
  browser_open: { url: "Web page URL to open" },
  browser_click: { selector: "CSS selector of the element to click" },
  brain_recall: { query: "Topic/concept to recall, e.g. 'figcheck deploy', 'fig07 server'", limit: "Max concepts to return, default 6" },
  brain_learn: {
    name: "Primary concept name, e.g. 'figcheck', 'deploy_view_prod.sh'",
    type: "Type: project / server / script / caveat / command / concept…",
    summary: "One-line summary",
    aliases: "Aliases, optional",
    attrs: "Structured key-value attributes, e.g. {git: '~/...', test_env: 'fig01', deploy: '...'}",
  },
  brain_link: { from: "Source concept", to: "Target concept", relation: "Relation: deploy script / test env / prod server / contains service / caveat / related…" },
  brain_forget: { name: "Concept name to remove" },
  brain_read_doc: { ref: "Document relative path or chunk id (the file value returned by brain_recall)" },
};
type ToolGroupRaw = { source: string; kind: "builtin" | "browser" | "mcp"; tools: { name: string; description: string; readOnly: boolean; inputSchema: any }[] };
// 把 getTools 返回的分组按语言彻底本地化：source 名、工具描述、inputSchema 参数说明（List/JSON 视图共用）。
function localizeToolGroups(groups: ToolGroupRaw[], lang: Lang): ToolGroupRaw[] {
  if (lang !== "en") return groups;
  return groups.map((g) => ({
    ...g,
    source: TOOL_SOURCE_EN[g.source] ?? g.source,
    tools: g.tools.map((tl) => {
      const pmap = TOOL_PARAM_EN[tl.name];
      let schema = tl.inputSchema;
      if (pmap && schema && typeof schema === "object") {
        // 逐层下钻：ask_user 的问题/选项说明嵌在 items.properties 里，只译顶层会漏中文
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
        schema = walk(schema);
      }
      return { ...tl, description: TOOL_DESC_EN[tl.name] ?? tl.description, inputSchema: schema };
    }),
  }));
}

// 迁移：把已装服务器里的旧 <占位> 自动补成目录里的默认值(如 sqlite 的 <db路径>→~/wuwei.db)，让老配置也开箱可用
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

// Brain 属性 <-> 文本（每行「键: 值」）互转，供脑网络面板编辑属性
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

// 概念网络力导向图：纯本地 SVG 简易力模拟(斥力+边弹簧+向心+阻尼)，无外部库(CSP 安全)。
// 点节点=选中(联动右侧编辑)+固定详情卡；拖节点=挪位置并钉住(脱离力学，双击解除)；
// 点边=看边详情；鼠标悬停节点/边=浮动详情提示。节点大小=权重，颜色=类型。
function ConceptGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: import("./env").BrainNodeLite[];
  edges: import("./env").BrainEdgeLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const W = 1000;
  const H = 700;
  const posRef = useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const pinnedRef = useRef<Set<string>>(new Set()); // 被拖动过=钉住的节点，力学不再拉走
  const dragRef = useRef<
    // node: ox/oy=抓取点与节点中心的世界坐标偏移(保持不跳)；cx/cy=按下时屏幕坐标(判断是否越过拖动阈值)
    | { kind: "node"; id: string; moved: boolean; ox: number; oy: number; cx: number; cy: number }
    | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
    | null
  >(null);
  const viewRef = useRef({ x: 0, y: 0, k: 1 }); // 画布平移(x,y)+缩放(k)，滚轮缩放/拖背景平移
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null); // 外层容器(定位浮动详情卡)
  const tipRef = useRef<HTMLDivElement | null>(null); // 浮动详情卡 DOM(跟随鼠标，直接改 style 不触发重渲染)
  const cursorRef = useRef({ x: 0, y: 0 }); // 最近一次鼠标在容器内的相对坐标
  // 悬停(hover)优先显示，其次是点击固定(pinned)的详情
  const [hover, setHover] = useState<{ kind: "node" | "edge"; id: string } | null>(null);
  const [pinInfo, setPinInfo] = useState<{ kind: "node" | "edge"; id: string } | null>(null);
  const [, forceRender] = useState(0);
  const seedRef = useRef(12345);
  const rnd = () => {
    seedRef.current = (seedRef.current * 1103515245 + 12345) & 0x7fffffff;
    return seedRef.current / 0x7fffffff;
  };
  // 同步节点集合到位置表(新节点随机撒点,消失的删掉)
  useEffect(() => {
    const pos = posRef.current;
    const ids = new Set(nodes.map((n) => n.id));
    for (const id of [...pos.keys()]) if (!ids.has(id)) pos.delete(id);
    for (const n of nodes)
      if (!pos.has(n.id))
        pos.set(n.id, { x: W / 2 + (rnd() - 0.5) * 500, y: H / 2 + (rnd() - 0.5) * 380, vx: 0, vy: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);
  // 力模拟:概念面板打开时持续跑,边跑边渲染
  useEffect(() => {
    let raf = 0;
    let alive = true;
    const tick = () => {
      const pos = posRef.current;
      const arr = nodes.map((n) => pos.get(n.id)).filter(Boolean) as {
        x: number;
        y: number;
        vx: number;
        vy: number;
      }[];
      const N = arr.length;
      for (let i = 0; i < N; i++)
        for (let j = i + 1; j < N; j++) {
          const a = arr[i];
          const b = arr[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2);
          const f = 7000 / d2;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      for (const e of edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (d - 130) * 0.02;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (!p) continue;
        const dr = dragRef.current;
        if ((dr?.kind === "node" && dr.id === n.id) || pinnedRef.current.has(n.id)) {
          // 正在拖 或 已钉住：位置固定，只清速度(仍对别的节点施加斥力/弹簧)
          p.vx = 0;
          p.vy = 0;
          continue;
        }
        p.vx += (W / 2 - p.x) * 0.0015;
        p.vy += (H / 2 - p.y) * 0.0015;
        p.vx *= 0.9;
        p.vy *= 0.9;
        p.x += p.vx;
        p.y += p.vy;
        p.x = Math.max(24, Math.min(W - 24, p.x));
        p.y = Math.max(24, Math.min(H - 24, p.y));
      }
      forceRender((t) => (t + 1) & 0xffff);
      if (alive) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [nodes, edges]);
  const toVB = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * W, y: ((cy - r.top) / r.height) * H };
  };
  // 拖拽:全局监听 move/up；未移动即视为点击=选中
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const vb = toVB(e.clientX, e.clientY);
      if (d.kind === "node") {
        // 越过 3px 才算拖动，避免手抖把点击误判成拖拽(否则点不动就选不中)
        if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 3) return;
        d.moved = true;
        const p = posRef.current.get(d.id);
        if (p) {
          const view = viewRef.current;
          // 屏幕→世界坐标(去掉平移/缩放)，再加抓取偏移：节点跟随光标移动的距离，而不是把中心吸到光标
          p.x = (vb.x - view.x) / view.k + d.ox;
          p.y = (vb.y - view.y) / view.k + d.oy;
          p.vx = 0;
          p.vy = 0;
        }
      } else {
        viewRef.current.x = d.ox + (vb.x - d.sx); // 平移画布
        viewRef.current.y = d.oy + (vb.y - d.sy);
      }
    };
    const up = () => {
      const d = dragRef.current;
      if (d && d.kind === "node") {
        if (d.moved) {
          pinnedRef.current.add(d.id); // 拖动过=钉住，之后力学不再拉走
          forceRender((t) => (t + 1) & 0xffff);
        } else {
          onSelect(d.id); // 未移动=点击=选中(联动右侧编辑)
          setPinInfo({ kind: "node", id: d.id }); // 并固定详情卡展示全内容
        }
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelect]);
  // 滚轮缩放(以光标为中心)。用原生非被动监听才能 preventDefault、不连带滚动设置面板。
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vb = toVB(e.clientX, e.clientY);
      const v = viewRef.current;
      const wx = (vb.x - v.x) / v.k;
      const wy = (vb.y - v.y) / v.k;
      const k = Math.max(0.25, Math.min(5, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      v.k = k;
      v.x = vb.x - wx * k;
      v.y = vb.y - wy * k;
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 在空白处按下=开始平移画布；同时收起点击固定的详情卡
  const onBgDown = (e: React.MouseEvent) => {
    const vb = toVB(e.clientX, e.clientY);
    const v = viewRef.current;
    dragRef.current = { kind: "pan", sx: vb.x, sy: vb.y, ox: v.x, oy: v.y };
    setPinInfo(null);
  };
  const color = (type: string) => {
    let h = 0;
    for (const c of type) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
    return `hsl(${h % 360}, 60%, 55%)`;
  };
  // 鼠标在容器内移动:记录相对坐标并让详情卡跟随光标(直接改 DOM，避免高频重渲染)
  const onWrapMove = (e: React.MouseEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    cursorRef.current = { x, y };
    positionTip(x, y, r.width, r.height);
  };
  const positionTip = (x: number, y: number, w: number, h: number) => {
    const tip = tipRef.current;
    if (!tip) return;
    const tw = tip.offsetWidth || 240;
    const th = tip.offsetHeight || 120;
    let lx = x + 16;
    let ly = y + 16;
    if (lx + tw > w) lx = Math.max(4, x - tw - 16);
    if (ly + th > h) ly = Math.max(4, h - th - 4);
    tip.style.left = lx + "px";
    tip.style.top = ly + "px";
  };
  // 详情卡出现/切换目标时，用最近光标位置摆好(点击固定时光标可能不在动)
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const { x, y } = cursorRef.current;
    positionTip(x, y, r.width, r.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, pinInfo]);

  const pos = posRef.current;
  const maxW = Math.max(1, ...nodes.map((n) => n.weight || 1));
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const info = hover || pinInfo; // 悬停优先，其次点击固定
  const infoNode = info?.kind === "node" ? byId.get(info.id) : undefined;
  const infoEdge = info?.kind === "edge" ? edges.find((e) => e.id === info.id) : undefined;
  const fmtTime = (t?: number) => {
    if (!t) return "";
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%", height: "100%" }}
      onMouseMove={onWrapMove}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={onBgDown}
        style={{ width: "100%", height: "100%", display: "block", cursor: "grab", userSelect: "none" }}
      >
        <g transform={`translate(${viewRef.current.x},${viewRef.current.y}) scale(${viewRef.current.k})`}>
          {edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const on = info?.kind === "edge" && info.id === e.id;
            return (
              <g key={e.id || "e" + i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on ? "var(--accent, #e0533d)" : "var(--border-strong, #bbb)"} strokeWidth={on ? 2 : 1} opacity={on ? 0.9 : 0.5} />
                {/* 透明加粗命中线:让又细又斜的边也好悬停/点击 */}
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover({ kind: "edge", id: e.id })}
                  onMouseLeave={() => setHover((h) => (h?.kind === "edge" && h.id === e.id ? null : h))}
                  onMouseDown={(ev) => {
                    ev.stopPropagation(); // 别触发背景平移
                    setPinInfo({ kind: "edge", id: e.id });
                  }}
                />
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} fontSize={9} fill="var(--text-2, #999)" textAnchor="middle" style={{ pointerEvents: "none" }}>
                  {e.relation}
                </text>
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const r = 6 + (Math.min(n.weight, maxW) / maxW) * 10;
            const sel = n.id === selectedId;
            const on = info?.kind === "node" && info.id === n.id;
            const pinned = pinnedRef.current.has(n.id);
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation(); // 别冒泡到背景平移，否则拖节点变成拖画布
                  const vb = toVB(ev.clientX, ev.clientY);
                  const view = viewRef.current;
                  // 记录抓取点相对节点中心的偏移(世界坐标)：拖动时保持这个偏移，节点不跳
                  const ox = p.x - (vb.x - view.x) / view.k;
                  const oy = p.y - (vb.y - view.y) / view.k;
                  dragRef.current = { kind: "node", id: n.id, moved: false, ox, oy, cx: ev.clientX, cy: ev.clientY };
                }}
                onDoubleClick={(ev) => {
                  ev.stopPropagation();
                  pinnedRef.current.delete(n.id); // 双击解除固定，节点重回力学布局
                  forceRender((t) => (t + 1) & 0xffff);
                }}
                onMouseEnter={() => setHover({ kind: "node", id: n.id })}
                onMouseLeave={() => setHover((h) => (h?.kind === "node" && h.id === n.id ? null : h))}
                style={{ cursor: "pointer" }}
              >
                {pinned && <circle r={r + 4} fill="none" stroke="var(--accent, #e0533d)" strokeWidth={1} strokeDasharray="2 2" opacity={0.7} />}
                <circle r={r} fill={color(n.type)} stroke={sel || on ? "var(--accent, #e0533d)" : "#fff"} strokeWidth={sel || on ? 3 : 1.2} />
                <text y={r + 12} fontSize={11} fill="var(--text, #333)" textAnchor="middle" fontWeight={sel ? 700 : 400} style={{ pointerEvents: "none" }}>
                  {n.name}
                </text>
              </g>
            );
          })}
        </g>
        {nodes.length === 0 && (
          <text x={W / 2} y={H / 2} fontSize={16} fill="var(--text-2, #999)" textAnchor="middle">
            {makeT(getLang())("set.brain.graphEmpty", "暂无概念——点上方「抽取概念」或对话中让模型 brain_learn")}
          </text>
        )}
      </svg>

      {/* 浮动详情卡:悬停即显，点击节点/边固定；pointerEvents:none 不挡鼠标避免闪烁 */}
      {info && (infoNode || infoEdge) && (
        <div
          ref={tipRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            maxWidth: 300,
            pointerEvents: "none",
            background: "var(--panel, #fff)",
            color: "var(--text, #222)",
            border: "1px solid var(--border, #ddd)",
            borderRadius: 8,
            boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
            padding: "10px 12px",
            fontSize: 12,
            lineHeight: 1.5,
            zIndex: 20,
            whiteSpace: "normal",
            wordBreak: "break-word",
          }}
        >
          {infoNode && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: color(infoNode.type), flex: "0 0 auto" }} />
                <span style={{ fontWeight: 700, fontSize: 13 }}>{infoNode.name}</span>
                <span style={{ color: "var(--text-2, #888)" }}>{infoNode.type}</span>
              </div>
              {infoNode.summary && <div style={{ marginBottom: 4 }}>{infoNode.summary}</div>}
              {infoNode.aliases?.length > 0 && (
                <div style={{ color: "var(--text-2, #888)", marginBottom: 4 }}>{makeT(getLang())("brain.info.aliases", "别名")}{getLang() === "en" ? ": " : "："}{infoNode.aliases.join(getLang() === "en" ? ", " : "、")}</div>
              )}
              {Object.keys(infoNode.attrs || {}).length > 0 && (
                <div style={{ marginBottom: 4 }}>
                  {Object.entries(infoNode.attrs).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", gap: 6 }}>
                      <span style={{ color: "var(--text-2, #888)", flex: "0 0 auto" }}>{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ color: "var(--text-2, #888)", fontSize: 11 }}>
                {getLang() === "en" ? `Weight ${infoNode.weight} · Hits ${infoNode.hits}` : `权重 ${infoNode.weight} · 命中 ${infoNode.hits}`}
                {infoNode.updatedAt ? (getLang() === "en" ? ` · Updated ${fmtTime(infoNode.updatedAt)}` : ` · 更新 ${fmtTime(infoNode.updatedAt)}`) : ""}
              </div>
              {pinInfo?.kind === "node" && !hover && (
                <div style={{ color: "var(--text-2, #aaa)", fontSize: 11, marginTop: 4 }}>{getLang() === "en" ? "Drag to reposition & pin · double-click to unpin" : "拖动可挪位并钉住 · 双击解除固定"}</div>
              )}
            </>
          )}
          {infoEdge && (
            <>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
                {byId.get(infoEdge.from)?.name || infoEdge.from}
                <span style={{ color: "var(--accent, #e0533d)" }}> ──{infoEdge.relation}→ </span>
                {byId.get(infoEdge.to)?.name || infoEdge.to}
              </div>
              <div style={{ color: "var(--text-2, #888)", marginBottom: 4 }}>{getLang() === "en" ? "Relation: " : "关系："}{infoEdge.relation}</div>
              <div style={{ color: "var(--text-2, #888)", fontSize: 11 }}>
                {getLang() === "en" ? `Weight ${infoEdge.weight} · Hits ${infoEdge.hits}` : `权重 ${infoEdge.weight} · 命中 ${infoEdge.hits}`}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4, flex: "0 0 auto", opacity: 0.75 }} aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
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
  showEffortPicker,
  onShowEffortPicker,
  lang,
  onLang,
  t,
  askToastAuto,
  askToastSec,
  onAskToast,
  isPro,
  onBrainLocked,
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
  showEffortPicker: boolean;
  onShowEffortPicker: (v: boolean) => void;
  lang: Lang;
  onLang: (l: Lang) => void;
  t: T;
  askToastAuto: boolean;
  askToastSec: number;
  onAskToast: (auto: boolean, sec: number) => void;
  isPro: boolean;
  onBrainLocked: () => void;
}) {
  // 界面主题（并入设置页「外观」）
  const [uiTheme, setUiTheme] = useState("light");
  useEffect(() => {
    window.wuwei.getSettings().then((r: any) => setUiTheme(resolveTheme(r?.settings?.theme)));
  }, []);
  async function pickTheme(t: string) {
    setUiTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    const r: any = await window.wuwei.getSettings();
    window.wuwei.setSettings({ ...(r?.settings || {}), theme: t });
  }
  // 会话提醒(自动消失/倒计时)：本页先暂存草稿,点「保存」才提交——走独立 IPC(setAskToast),
  // 与模型/凭证的大配置(settings:set)分开落盘、互不覆盖。弹窗每次开都重新挂载,草稿从 props 初始化=最新已存值。
  const [toastAutoDraft, setToastAutoDraft] = useState(askToastAuto);
  const [toastSecDraft, setToastSecDraft] = useState(askToastSec);
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
  const [sysPromptDefault, setSysPromptDefault] = useState(""); // 中文默认模板
  const [sysPromptDefaultEn, setSysPromptDefaultEn] = useState(""); // 英文默认模板(随界面语言实时切)
  const [sysPromptTouched, setSysPromptTouched] = useState(false); // 是否自定义过(否则存 undefined=用默认)
  // 脑网络说明提示词(脑网络页「提示词」视图查看/编辑) + 密钥说明提示词(密钥页查看/编辑)
  const [brainView, setBrainView] = useState<"graph" | "prompt">("graph"); // 脑网络页：可视化 / 提示词
  const [brainPrompt, setBrainPrompt] = useState("");
  const [brainPromptDefault, setBrainPromptDefault] = useState("");
  const [brainPromptDefaultEn, setBrainPromptDefaultEn] = useState("");
  const [brainPromptTouched, setBrainPromptTouched] = useState(false);
  const [secretsPrompt, setSecretsPrompt] = useState("");
  const [secretsPromptDefault, setSecretsPromptDefault] = useState("");
  const [secretsPromptDefaultEn, setSecretsPromptDefaultEn] = useState("");
  const [secretsPromptTouched, setSecretsPromptTouched] = useState(false);
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
  // 默认目录跟随界面语言：英文界面别塞中文路径
  const [docDir, setDocDir] = useState(lang === "en" ? "~/Documents/knowledge" : "~/Documents/tanxun/知识宫殿");
  const [docBuilding, setDocBuilding] = useState(false);
  const [docProg, setDocProg] = useState("");
  credsRef.current = creds;
  const loadedRef = useRef<any>({}); // 保存加载时的完整 settings，保存时 spread 保留 theme/app 等本页不管的字段
  // 三个应用级开关(app.*)：undefined 一律视为「开」，保持历史默认；改动即时落盘+热更(走独立 settings:set-app，不重启 provider)
  const [secretsDetect, setSecretsDetect] = useState(true); // 发送前扫描/拦截疑似新密钥
  const [brainOn, setBrainOn] = useState(true); // 启用本地脑网络 Brain
  const [brainDocsOn, setBrainDocsOn] = useState(true); // recall 连带扫描『相关文档』
  const [resumeDetect, setResumeDetect] = useState(true); // 启动时检测被中断/干到一半的任务并提示恢复
  const setAppToggle = (patch: Record<string, boolean>) => {
    const cur = loadedRef.current || {};
    loadedRef.current = { ...cur, app: { ...(cur.app || {}), ...patch } }; // 同步本地，避免后续「保存」把开关刷回
    window.wuwei.setAppSettings(patch);
  };
  const [stations, setStations] = useState<Station[]>([]); // 自定义中转站
  const [newStName, setNewStName] = useState(""); // 新增中转站：名称
  const [newStUrl, setNewStUrl] = useState(""); // 新增中转站：baseURL
  const [newModelName, setNewModelName] = useState(""); // 给当前平台手动加模型：输入框
  const [editStationId, setEditStationId] = useState<string | null>(null); // 非空=编辑该中转站(改名/改URL)，空=新增
  const [newStRelay, setNewStRelay] = useState(false); // 新增/编辑：类型 false=自建供应商 true=中转站(仅影响显示后缀/用途说明)
  const [showAddStation, setShowAddStation] = useState(false); // 添加中转站独立弹窗
  const stationsRef = useRef(stations);
  stationsRef.current = stations;
  const [order, setOrder] = useState<string[]>([]); // 平台自定义顺序(全量 id 列表)
  const [hidden, setHidden] = useState<string[]>([]); // 隐藏的平台
  const orderRef = useRef(order);
  orderRef.current = order;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [removed, setRemoved] = useState<string[]>([]); // 已删除的平台(含内置)
  const removedRef = useRef(removed);
  removedRef.current = removed;
  const [overrides, setOverrides] = useState<Record<string, { label?: string; baseUrl?: string }>>({}); // 改名/改端点
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const [editIsBuiltin, setEditIsBuiltin] = useState(false); // 编辑对象是否内置平台(内置只改名)
  const [dragOverIdx, setDragOverIdx] = useState(-1); // 拖拽悬停到第几行(高亮)
  const dragIdxRef = useRef(-1); // 拖起始行
  const [tab, setTab] = useState<
    "general" | "display" | "model" | "platforms" | "prompt" | "memory" | "brain" | "mcp" | "tools" | "secrets"
  >((initialTab as any) || "model"); // 设置分块标签页(左侧菜单)
  const [maxed, setMaxed] = useState(false); // 设置弹窗最大化(脑网络等大结构需放大看)
  const [memory, setMemory] = useState(""); // 全局长期记忆
  const memoryTouchedRef = useRef(false); // 是否改过记忆(保存时才写)
  // ── 本地脑网络 Brain ──
  const [brainNodes, setBrainNodes] = useState<import("./env").BrainNodeLite[]>([]);
  const [brainEdges, setBrainEdges] = useState<import("./env").BrainEdgeLite[]>([]);
  const [brainStat, setBrainStat] = useState<{ nodes: number; edges: number; embedded: number }>({ nodes: 0, edges: 0, embedded: 0 });
  const [brainFilter, setBrainFilter] = useState(""); // 概念列表过滤
  const [brainSel, setBrainSel] = useState<string | null>(null); // 选中编辑的节点 id
  const [brainDraft, setBrainDraft] = useState<import("./env").BrainNodeLite | null>(null); // 编辑草稿
  const [brainLeftOpen, setBrainLeftOpen] = useState(true); // 左侧概念列表：可收起给图谱腾地方
  const [brainRightOpen, setBrainRightOpen] = useState(true); // 右侧详情编辑：可收起(选中仍在，收成小条)
  const [brainRecallQ, setBrainRecallQ] = useState(""); // 检索测试输入
  const [brainRecallOut, setBrainRecallOut] = useState(""); // 检索测试结果
  const [brainWarming, setBrainWarming] = useState(false); // 模型预热中
  const [brainWarmMsg, setBrainWarmMsg] = useState(""); // 预热结果提示
  const [conExtract, setConExtract] = useState<{ running: boolean; phase: string; total: number; done: number; created: number; cur?: string } | null>(null); // 概念抽取进度
  const [brainNewEdge, setBrainNewEdge] = useState({ relation: "", to: "" }); // 给选中节点加关系
  const reloadBrain = () =>
    Promise.all([window.wuwei.brainGraph(), window.wuwei.brainStats()]).then(([g, st]) => {
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
    window.wuwei.getTools().then((r) => {
      setToolGroups(localizeToolGroups(r.groups, lang));
      setToolTotal(r.total);
    });
  }, [tab, lang]);
  // 切到「脑网络」页时拉一次图谱 + 文档库统计，并监听建索引/概念抽取进度。
  // 关键：主进程是进度真相源——重开设置时先查一次当前状态回填，避免"关了再开状态就没了"。
  useEffect(() => {
    if (tab !== "brain") return;
    reloadBrain();
    window.wuwei.brainDocStats().then((s) => {
      setDocStat(s);
      if (s.dir) setDocDir(s.dir);
    });
    // 回填：索引是否正在构建 + 向量模型是否已就绪 + 概念抽取是否在跑
    window.wuwei.brainDocProgress().then((d) => {
      if (d?.building) {
        setDocBuilding(true);
        setDocProg(
          d.phase === "scan"
            ? (lang === "en" ? `Found ${d.files} docs, vectorizing…` : `扫描到 ${d.files} 个文档，开始向量化…`)
            : (lang === "en" ? `Vectorizing ${d.done}/${d.total} chunks…` : `向量化 ${d.done}/${d.total} 块…`),
        );
      }
    });
    window.wuwei.brainEmbedReady().then((r) => {
      if (r) setBrainWarmMsg(lang === "en" ? "✓ Embedding model ready — semantic search enabled." : "✓ 向量模型就绪，语义检索已启用。");
    });
    window.wuwei.brainConceptProgress().then((c) => setConExtract(c));
    const off = window.wuwei.onEvent((ch, p) => {
      if (ch === "evt:brain-docs") {
        const d = p as { building?: boolean; phase: string; files?: number; total?: number; done?: number };
        if (d.phase === "scan") setDocProg(lang === "en" ? `Found ${d.files} docs, vectorizing…` : `扫描到 ${d.files} 个文档，开始向量化…`);
        else if (d.phase === "embed") setDocProg(lang === "en" ? `Vectorizing ${d.done}/${d.total} chunks…` : `向量化 ${d.done}/${d.total} 块…`);
        else if (d.phase === "done") {
          setDocProg(lang === "en" ? `✓ Done, ${d.total} chunks total` : `✓ 完成，共 ${d.total} 块`);
          setDocBuilding(false);
          window.wuwei.brainDocStats().then(setDocStat);
        } else if (d.phase === "error") {
          setDocProg(lang === "en" ? "✗ Build failed" : "✗ 构建失败");
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
  const [secEdit, setSecEdit] = useState<string | null>(null); // 正在编辑的密钥 id
  const [secEditDraft, setSecEditDraft] = useState({ name: "", envVar: "", note: "" });
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
    const r = await window.wuwei.secretsReveal(unlockPw);
    if (!r.ok) {
      setUnlockErr(r.error || (lang === "en" ? "Verification failed" : "验证失败"));
      return;
    }
    const map: Record<string, string> = {};
    for (const it of r.items || []) map[it.id] = it.value;
    setRevealed(map);
    setUnlockOpen(false);
    setUnlockPw("");
  }
  const reloadSecrets = () =>
    window.wuwei.secretsList().then((r) => {
      setSecrets(r.entries);
      setSecretsAvail(r.available);
    });
  useEffect(() => {
    if (tab === "secrets") reloadSecrets();
  }, [tab]);
  async function addSecret() {
    setSecErr("");
    if (!secNew.value.trim()) {
      setSecErr(t("set.sec.needValue", "请填入密钥值"));
      return;
    }
    const r = await window.wuwei.secretsAdd({
      name: secNew.name.trim() || undefined,
      envVar: secNew.envVar.trim() || undefined,
      value: secNew.value,
      note: secNew.note.trim() || undefined,
    });
    if (!r.ok) {
      setSecErr(r.error || (lang === "en" ? "Add failed" : "添加失败"));
      return;
    }
    setSecNew({ name: "", envVar: "", value: "", note: "" });
    reloadSecrets();
  }
  async function doImportEnv() {
    const r = await window.wuwei.secretsImportEnv(secImportText);
    if (r.ok) {
      setSecImportText("");
      setSecImportOpen(false);
      reloadSecrets();
    } else setSecErr(r.error || (lang === "en" ? "Import failed" : "导入失败"));
  }
  // 内置平台 + 中转站(合并成一份预设列表；下拉与查找都用它)
  const allPresets = applyProviderEdits(
    [...PRESETS, ...stations.map(stationToPreset)],
    overrides,
    removed,
  );
  const orderedPresets = arrangePresets(allPresets, order, hidden, true);
  const preset = allPresets.find((p) => p.id === pid) ?? PRESETS[0];
  // 模型下拉：预设在前(旗舰置顶)+ 平台实时拉到的新模型(liveModels) + 该平台记住/当前选的模型(自建端点等
  // 没有预设列表时也能在下拉里看到并切换)，去重去空。
  const modelOptions = [
    ...new Set(
      [
        ...(preset.models ?? []),
        ...(creds[pid]?.customModels ?? []), // 用户为该平台手动加的模型
        ...(liveModels[pid] || []),
        creds[pid]?.model,
        model,
      ].filter(Boolean) as string[],
    ),
  ];
  // 给当前平台增/删自定义模型(存进该平台槽的 customModels，保存时随 creds 落盘)
  function addCustomModel(name: string) {
    const m = name.trim();
    if (!m) return;
    const slot = credsRef.current[pid] || {};
    if ((slot.customModels || []).includes(m) || (preset.models || []).includes(m)) {
      setModel(m); // 已在列表→直接选中
      return;
    }
    const next = { ...credsRef.current, [pid]: { ...slot, customModels: [...(slot.customModels || []), m] } };
    credsRef.current = next;
    setCreds(next);
    setModel(m); // 加完即选中
  }
  function delCustomModel(name: string) {
    const slot = credsRef.current[pid] || {};
    const next = {
      ...credsRef.current,
      [pid]: { ...slot, customModels: (slot.customModels || []).filter((x) => x !== name) },
    };
    credsRef.current = next;
    setCreds(next);
    if (model === name) setModel(preset.models[0] || (next[pid].customModels || [])[0] || "");
  }
  // 当前「模型」的能力开关(工具调用/看图)：按模型名存 modelCaps[model]，回退旧的平台级(迁移兼容)
  const curCaps: ModelCap =
    creds[pid]?.modelCaps?.[model] || { noTools: creds[pid]?.noTools, vision: creds[pid]?.vision };
  function setModelCap(patch: ModelCap) {
    if (!model) return;
    const slot = credsRef.current[pid] || {};
    const caps = { ...(slot.modelCaps || {}) };
    caps[model] = { ...(caps[model] || { noTools: slot.noTools, vision: slot.vision }), ...patch };
    const next = { ...credsRef.current, [pid]: { ...slot, modelCaps: caps } };
    credsRef.current = next;
    setCreds(next);
  }

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
      model: slot.model || "", // 该平台记住的模型(空=用预设默认)
      noTools: !!slot.noTools, // 该平台/模型不发 tools 参数
      vision: !!slot.vision, // 该平台/模型强制看图
    };
  }

  // 语言切换时，记忆里的默认种子头 # 记忆/# Memory 跟着换（用户内容不动）
  useEffect(() => {
    setMemory((cur) => swapMemHeader(cur, lang));
  }, [lang]);
  // 语言切换时，未自定义的「默认提示词」跟着切中英（系统/脑网络/密钥三段）
  useEffect(() => {
    if (!sysPromptTouched && sysPromptDefaultEn) setSysPrompt(lang === "en" ? sysPromptDefaultEn : sysPromptDefault);
    if (!brainPromptTouched && brainPromptDefaultEn) setBrainPrompt(lang === "en" ? brainPromptDefaultEn : brainPromptDefault);
    if (!secretsPromptTouched && secretsPromptDefaultEn) setSecretsPrompt(lang === "en" ? secretsPromptDefaultEn : secretsPromptDefault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);
  useEffect(() => {
    window.wuwei.getMemory().then((m) => setMemory(swapMemHeader(m || "", lang)));
    window.wuwei.getMcp().then((r) => {
      const mig = migrateMcpDefaults(r?.config || "");
      setMcpConfig(mig.text);
      setMcpStatus(r?.status || []);
      if (mig.changed) {
        window.wuwei.setMcp(mig.text); // 自动把旧占位补默认值→重连(sqlite等直接可用)
        setTimeout(() => window.wuwei.getMcp().then((x) => setMcpStatus(x?.status || [])), 2800);
      }
    });
  }, []);
  const reloadMcpStatus = () => window.wuwei.getMcp().then((r) => setMcpStatus(r?.status || []));
  // 写回 MCP 配置(标准 {mcpServers}) + 重连 + 稍后刷新状态
  function writeMcp(servers: Record<string, McpServer>) {
    const text = JSON.stringify({ mcpServers: servers }, null, 2);
    setMcpConfig(text);
    mcpTouchedRef.current = false;
    window.wuwei.setMcp(text);
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
        if ("arg" in f) fields.push({ label: mcpFieldEn(name, "arg" + f.arg, "label", f.label, lang), hint: mcpFieldEn(name, "arg" + f.arg, "hint", f.hint, lang), kind: "arg", idx: f.arg });
        else fields.push({ label: mcpFieldEn(name, f.env, "label", f.label, lang), hint: mcpFieldEn(name, f.env, "hint", f.hint, lang), kind: "env", key: f.env });
      }
    } else {
      args.forEach((a, i) => {
        if (a.includes("<")) fields.push({ label: (lang === "en" ? "Arg " : "参数 ") + (i + 1), hint: "", kind: "arg", idx: i });
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
      window.wuwei.searchMcp(q).then((r) => {
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
    window.wuwei.searchMcp(q, mcpCursor).then((r) => {
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
    window.wuwei.getSettings().then((r) => {
      const s = r?.settings;
      if (!s) return;
      loadedRef.current = s; // 存完整 settings，保存时 spread 保留本页不管的字段
      // 三个应用级开关：undefined 视为开
      setSecretsDetect(s.app?.secretsDetect !== false);
      setBrainOn(s.app?.brainEnabled !== false);
      setBrainDocsOn(s.app?.brainDocs !== false);
      setResumeDetect(s.app?.resumeDetect !== false);
      const sts: Station[] = s.customStations || [];
      setStations(sts);
      stationsRef.current = sts;
      const ord = s.providerOrder || [];
      setOrder(ord);
      orderRef.current = ord;
      const hid = s.hiddenProviders || [];
      setHidden(hid);
      hiddenRef.current = hid;
      const rmv = (s as any).removedProviders || [];
      setRemoved(rmv);
      removedRef.current = rmv;
      const ovr = (s as any).providerOverrides || {};
      setOverrides(ovr);
      overridesRef.current = ovr;
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
      // 当前平台的模型：顶层 s.model(上次生效值) 优先，其次槽记住的，再回退预设默认
      const curModel = s.model || f.model || p.models[0] || "";
      setModel(curModel);
      setApiKey(f.apiKey);
      setBaseUrl(f.baseUrl);
      setOauthToken(f.oauthToken);
      setNickname(f.nickname);
      setPlatPromptOn(typeof f.systemPrompt === "string");
      setPlatPrompt(typeof f.systemPrompt === "string" ? f.systemPrompt : "");
      setCustomModel(!!curModel && !p.models.includes(curModel));
      // 系统提示词：有自定义(含空串)就用它+标记已改；否则显示默认模板(未改，保存时不写入=跟随默认)
      const defZh = r?.defaultPrompt || "";
      const defEn = (r as any)?.defaultPromptEn || defZh;
      setSysPromptDefault(defZh);
      setSysPromptDefaultEn(defEn);
      const def = lang === "en" ? defEn : defZh; // 按当前界面语言选默认
      if (typeof s.systemPrompt === "string") {
        setSysPrompt(s.systemPrompt);
        setSysPromptTouched(true);
      } else {
        setSysPrompt(def);
        setSysPromptTouched(false);
      }
      // 脑网络说明提示词：有覆盖就用它+标记已改，否则回填默认(未改，保存不写=跟随默认)
      const bDefZh = (r as any)?.defaultBrainPrompt || "";
      const bDefEn = (r as any)?.defaultBrainPromptEn || bDefZh;
      setBrainPromptDefault(bDefZh);
      setBrainPromptDefaultEn(bDefEn);
      if (typeof s.brainPrompt === "string") {
        setBrainPrompt(s.brainPrompt);
        setBrainPromptTouched(true);
      } else {
        setBrainPrompt(lang === "en" ? bDefEn : bDefZh);
        setBrainPromptTouched(false);
      }
      // 密钥说明提示词：同上
      const sDefZh = (r as any)?.defaultSecretsPrompt || "";
      const sDefEn = (r as any)?.defaultSecretsPromptEn || sDefZh;
      setSecretsPromptDefault(sDefZh);
      setSecretsPromptDefaultEn(sDefEn);
      if (typeof s.secretsPrompt === "string") {
        setSecretsPrompt(s.secretsPrompt);
        setSecretsPromptTouched(true);
      } else {
        setSecretsPrompt(lang === "en" ? sDefEn : sDefZh);
        setSecretsPromptTouched(false);
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
        model: model || undefined, // 切走前记住当前平台选的模型
        systemPrompt: platPromptOn ? platPrompt : undefined,
      },
    };
    credsRef.current = merged;
    setCreds(merged);
    const f = slotFields(merged, id, p);
    setPid(id);
    // 优先用目标平台记住的模型，没有才回退到预设默认(不再无脑重置成默认，切回来模型还在)
    const targetModel = f.model || p.models[0] || "";
    setModel(targetModel);
    setApiKey(f.apiKey);
    setBaseUrl(f.baseUrl);
    setOauthToken(f.oauthToken);
    setNickname(f.nickname);
    setPlatPromptOn(typeof f.systemPrompt === "string");
    setPlatPrompt(typeof f.systemPrompt === "string" ? f.systemPrompt : "");
    setCustomModel(!!targetModel && !p.models.includes(targetModel)); // 记住的模型不在预设列表→自定义输入态
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
    if (!silent) setSKeyMsg(lang === "en" ? "Checking…" : "检测中…");
    try {
      const res = await window.wuwei.testKey(key, keyOverride());
      if (res.ok) {
        setApiKey(key);
        persist({ apiKeyOverride: key, close: false }); // 保存但不关，留在弹窗看结果
        setSKeyWaiting(false);
        setSKeyMsg(lang === "en" ? "✓ API Key verified and set — ready to use (you can close this window)." : "✓ API Key 已验证通过并设置完成，可直接使用（可关闭本窗）。");
        return true;
      }
      if (keyRejected(res.reason)) {
        if (!silent) setSKeyMsg((lang === "en" ? "✗ Key invalid (auth failed): " : "✗ Key 无效（鉴权失败）：") + res.reason);
        return false;
      }
      // Key 有效但请求未通过(余额/额度/账单等)：照样保存并提醒
      setApiKey(key);
      persist({ apiKeyOverride: key, close: false });
      setSKeyWaiting(false);
      setSKeyMsg((lang === "en" ? "⚠ Key saved (valid), but the request didn't go through — usually an account balance/quota issue: " : "⚠ Key 已保存（本身有效），但请求未通过，多为账户余额/额度问题：") + res.reason);
      return true;
    } finally {
      sKeyTestingRef.current = false;
    }
  }

  // 点「去获取」：开官网 + 进入等待态(启动剪贴板自动检测)
  function startGetKey() {
    if (preset.keyUrl) window.wuwei.openExternal(preset.keyUrl);
    sLastClipRef.current = "";
    setSKeyMsg(lang === "en" ? "Opened the sign-up page: copy your API Key and it'll be auto-filled and verified…" : "已打开获取页面：复制 API Key 后会自动填入并验证…");
    setSKeyWaiting(true);
  }

  // 等待态：轮询剪贴板，检测到像 key 的新内容就自动验证+设置
  useEffect(() => {
    if (!sKeyWaiting) return;
    const timer = setInterval(async () => {
      if (sKeyTestingRef.current) return;
      const clip = (await window.wuwei.readClipboard()).trim();
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
      const tok = await window.wuwei.claudeLogin();
      if (tok) {
        setOauthToken(tok);
        save(tok);
      } else alert(lang === "en" ? "Authorization didn't go through (cancelled, timed out, or failed). Please try again." : "授权未完成（已取消/超时/失败），请重试。");
    } finally {
      setClaudeBusy(false);
    }
  }

  // 系统浏览器授权 第1步：开浏览器(复用已登录 Google)，进入等回填授权码
  async function claudeOpenBrowser() {
    await window.wuwei.claudeOauthOpen();
    setSCode("");
    setSAwaitCode(true);
  }

  // 系统浏览器授权 第2步：用授权码换 token（留空则自动读剪贴板）
  async function claudeCompleteBrowser() {
    if (claudeBusy) return;
    setClaudeBusy(true);
    try {
      let code = sCode.trim();
      if (!code) code = (await window.wuwei.readClipboard()).trim();
      if (!code) {
        alert(lang === "en" ? "No authorization code found. Copy it from the browser first, or paste it into the box." : "没读到授权码：请先在浏览器复制授权码，或粘贴进输入框。");
        return;
      }
      const tok = await window.wuwei.claudeOauthExchange(code);
      if (tok) {
        setSAwaitCode(false);
        setOauthToken(tok);
        save(tok);
      } else alert(lang === "en" ? "The code is invalid or expired — click \"Sign in via browser\" and try again." : "授权码无效或已过期，请重新点「用浏览器登录」。");
    } finally {
      setClaudeBusy(false);
    }
  }

  // 落库(可指定 key/token 覆盖，绕开 setState 异步)；close=false 时保存但不关闭弹窗
  async function persist(opts?: { apiKeyOverride?: string; oauthOverride?: string; close?: boolean }) {
    const apiKind = preset.kind === "anthropic-apikey" || preset.kind === "openai";
    const prevSlot = credsRef.current[pid] || {};
    const slot: CredSlot = {
      ...prevSlot, // 保留 avatar/webToken 等本页不动的字段，别保存时抹掉头像/登录态
      // 空则回退到已存的 key/token，绝不用空把原凭证覆盖掉(防误抹)
      apiKey: apiKind
        ? cleanKey(opts?.apiKeyOverride ?? apiKey) || prevSlot.apiKey || undefined
        : undefined,
      baseUrl: preset.kind === "openai" ? baseUrl.trim() || preset.baseUrl : undefined,
      // OAuth Token 只读、由授权流程填入，不存在「误留空」；故清空即真清空(不回退旧值)，
      // 便于过期后手动清掉、改用下方 API Key。授权流程用 oauthOverride 传入新 token。
      oauthToken:
        preset.kind === "anthropic-oauth"
          ? cleanKey(opts?.oauthOverride ?? oauthToken) || undefined
          : undefined,
      nickname: nickname.trim() || prevSlot.nickname || undefined,
      systemPrompt: platPromptOn ? platPrompt : undefined, // 本平台专属提示词(关掉=undefined 跟随全局)
      model: model || prevSlot.model || undefined, // 记住本平台选的模型，切走再切回不丢
      // noTools/vision/modelCaps 由 ...prevSlot 原样保留(按模型存在 modelCaps，切模型时即时更新 creds)
      // 手输的自定义模型自动收进列表(下次在下拉里可选/可删)；预设自带的不入
      customModels: (() => {
        const base = prevSlot.customModels || [];
        return model && !(preset.models || []).includes(model) && !base.includes(model)
          ? [...base, model]
          : base.length
            ? base
            : undefined;
      })(),
    };
    const newCreds = { ...credsRef.current, [pid]: slot }; // 存进当前平台的槽(用最新creds,别丢其它槽)
    // 只发本页负责的字段(模型/凭证/平台/系统提示/中转站)。主进程 settings:set 会合并到磁盘,
    // 其余字段(会话提醒/保留条数/输出方式/主题/app 开关等各走独立 IPC)一律不碰、不覆盖。
    window.wuwei.setSettings({
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
    if (memoryTouchedRef.current) window.wuwei.setMemory(memory); // 手动改过记忆才写盘
    if (mcpTouchedRef.current) window.wuwei.setMcp(mcpConfig); // 改过 MCP 配置才写盘+重连
    if (opts?.close !== false) onClose();
  }

  // 新增中转站：校验 baseURL，落库，选中它
  function addStation() {
    const label = newStName.trim();
    let url = newStUrl.trim();
    if (!label || !url) {
      alert(lang === "en" ? "Please fill in both the relay name and the Base URL." : "请填写中转站名称和 Base URL。");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const id = "st_" + crypto.randomUUID().slice(0, 8);
    const st: Station = { id, label, baseUrl: url, relay: newStRelay || undefined };
    const next = [...stationsRef.current, st];
    stationsRef.current = next;
    setStations(next);
    setNewStName("");
    setNewStUrl("");
    // 直接切到新站(带出空槽)，并持久化列表；旧平台槽展开保留 model/systemPrompt/avatar 等本页不动的字段
    const merged = {
      ...credsRef.current,
      [pid]: { ...(credsRef.current[pid] || {}), apiKey, baseUrl, oauthToken, nickname, model: model || undefined },
    };
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
    const r = await window.wuwei.getSettings();
    const s = r?.settings || {};
    window.wuwei.setSettings({ ...s, customStations: next });
  }

  // 打开「编辑供应商」弹窗：自定义站带出名称/URL/类型；内置平台只改名(带出当前显示名)
  function openEditStation(id?: string) {
    const tid = id || pid;
    const st = stationsRef.current.find((x) => x.id === tid);
    if (st) {
      setEditIsBuiltin(false);
      setEditStationId(st.id);
      setNewStName(st.label);
      setNewStUrl(st.baseUrl);
      setNewStRelay(!!st.relay);
      setShowAddStation(true);
      return;
    }
    // 内置平台：只改显示名(端点仍在上一页 Base URL 改)
    const bp = PRESETS.find((x) => x.id === tid);
    if (!bp) return;
    setEditIsBuiltin(true);
    setEditStationId(tid);
    setNewStName(overridesRef.current[tid]?.label ?? pLabel(bp, lang));
    setNewStUrl("");
    setShowAddStation(true);
  }
  // 保存编辑：内置→写 providerOverrides.label；自定义站→改 label/URL/类型
  function saveStationEdit() {
    const label = newStName.trim();
    if (!label) {
      alert(lang === "en" ? "Please fill in a name." : "请填写名称。");
      return;
    }
    if (editIsBuiltin) {
      const id = editStationId!;
      const bp = PRESETS.find((x) => x.id === id);
      const ovr = { ...overridesRef.current };
      // 与预设原名相同=清掉覆盖(恢复默认名)，否则存 label 覆盖
      if (bp && (label === bp.label || label === pLabel(bp, lang))) delete ovr[id];
      else ovr[id] = { ...(ovr[id] || {}), label };
      overridesRef.current = ovr;
      setOverrides(ovr);
      loadedRef.current = { ...loadedRef.current, providerOverrides: ovr };
      setShowAddStation(false);
      setEditStationId(null);
      setEditIsBuiltin(false);
      void persistProviderMeta({ providerOverrides: ovr });
      return;
    }
    let url = newStUrl.trim();
    if (!url) {
      alert(lang === "en" ? "Please fill in the Base URL." : "请填写 Base URL。");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const next = stationsRef.current.map((s) =>
      s.id === editStationId ? { ...s, label, baseUrl: url, relay: newStRelay || undefined } : s,
    );
    stationsRef.current = next;
    setStations(next);
    if (pid === editStationId) setBaseUrl(url); // 改的是当前选中站→同步端点输入框
    setShowAddStation(false);
    setEditStationId(null);
    void persistStationsOnly(next);
  }
  // 删除平台：自定义站→删站；内置→加入 removedProviders(可一键恢复)。删到当前平台则切回第一个可用平台
  function deleteProvider(id: string) {
    const isStation = stationsRef.current.some((x) => x.id === id);
    if (isStation) {
      deleteStation(id);
      return;
    }
    const rmv = removedRef.current.includes(id) ? removedRef.current : [...removedRef.current, id];
    removedRef.current = rmv;
    setRemoved(rmv);
    loadedRef.current = { ...loadedRef.current, removedProviders: rmv };
    void persistProviderMeta({ removedProviders: rmv });
    if (pid === id) {
      const fallback = applyProviderEdits([...PRESETS, ...stationsRef.current.map(stationToPreset)], overridesRef.current, rmv)[0];
      if (fallback) changePreset(fallback.id);
    }
  }
  // 一键恢复所有已删除的平台
  function restoreRemovedProviders() {
    removedRef.current = [];
    setRemoved([]);
    loadedRef.current = { ...loadedRef.current, removedProviders: [] };
    void persistProviderMeta({ removedProviders: [] });
  }
  // 拉最新 settings 再合并 removedProviders/providerOverrides(别覆盖本页不管的字段)
  async function persistProviderMeta(patch: { removedProviders?: string[]; providerOverrides?: Record<string, { label?: string; baseUrl?: string }> }) {
    const r = await window.wuwei.getSettings();
    const s = r?.settings || {};
    window.wuwei.setSettings({ ...s, ...patch });
  }

  // 只更新平台顺序/隐藏(拉最新 settings 再合并，避免覆盖本页不管的字段)
  async function persistArrangement(ord: string[], hid: string[]) {
    const r = await window.wuwei.getSettings();
    const s = r?.settings || {};
    window.wuwei.setSettings({ ...s, providerOrder: ord, hiddenProviders: hid });
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
    // 先提交本页暂存的小配置(会话提醒)——走各自独立 IPC,与下面的大配置(模型/凭证)分开落盘、互不覆盖。
    onAskToast(toastAutoDraft, toastSecDraft);
    persist({ oauthOverride: typeof oauthOverride === "string" ? oauthOverride : undefined, close: true });
  }

  return (
    <>
    <div className="perm-overlay settings-overlay">
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
          <button
            type="button"
            className={"set-tab" + (tab === "brain" ? " on" : "") + (isPro ? "" : " locked")}
            onClick={() => (isPro ? setTab("brain") : onBrainLocked())}
            title={isPro ? undefined : t("set.brain.proOnly", "脑网络为会员专享功能")}
          >
            {t("set.tab.brain")}
            {!isPro && <LockGlyph />}
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
                title={maxed ? t("set.win.restore", "还原窗口大小") : t("set.win.maximize", "最大化（同时把整个窗口最大化铺满屏幕）")}
                onClick={async () => {
                  const next = !maxed;
                  setMaxed(next);
                  // 进入最大化时,把整个应用窗口也最大化——否则 96vw 弹窗只铺满小窗口、铺不满屏幕
                  if (next && !(await window.wuwei.winIsMaximized?.())) window.wuwei.winMaximize();
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
              <button type="button" className="set-win-btn" title={t("win.close", "关闭")} onClick={onClose}>
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
              <div className="app-set-group">{t("set.g.grouping", "会话分组")}</div>
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
              {/* 完整对话历史归档：压缩前原文永不丢，右键会话→查看完整历史。这里设保留天数 */}
              <div className="app-set-group">{lang === "en" ? "Full history archive" : "完整对话历史归档"}</div>
              <div className="app-set-row" style={{ cursor: "default", gap: "10px" }}>
                <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>{lang === "en" ? "Keep archived logs for" : "归档日志保留"}</div>
                <span style={{ flex: 1 }} />
                <input
                  type="number"
                  min={0}
                  defaultValue={(() => { const v = localStorage.getItem("wuwei-transcript-days"); return v === null ? 30 : Math.max(0, Number(v) || 0); })()}
                  style={{ width: 88, textAlign: "right", padding: "4px 8px", fontFamily: "var(--mono)", background: "var(--bg-input)", color: "var(--text)", border: "1px solid var(--border-strong)", borderRadius: 8, outline: "none" }}
                  onChange={(e) => localStorage.setItem("wuwei-transcript-days", String(Math.max(0, Math.floor(Number(e.target.value) || 0))))}
                />
                <div className="app-set-hint" style={{ minWidth: 48, textAlign: "right" }}>{lang === "en" ? "days" : "天"}</div>
              </div>
              <div className="app-set-hint" style={{ marginBottom: "16px" }}>
                {lang === "en"
                  ? "Every exchange is archived before context compaction, so you can review what happened before it was summarized (right-click a conversation → View full history). 0 = keep forever. Cleanup runs on next launch."
                  : "每次上下文压缩前都会把原始交流归档，之后可回看被摘要前的完整对话（右键会话→查看完整历史）。填 0 = 永久保留。清理在下次启动时执行。"}
              </div>
              <div className="app-set-group">{t("set.g.effortGroup", "思考档位")}</div>
              <div className="app-set-row" style={{ cursor: "default" }}>
                <div className="app-set-text">
                  <div className="app-set-label">{t("set.g.effortPicker", "在底栏显示档位选择器")}</div>
                  <div className="app-set-hint">
                    {t(
                      "set.g.effortPickerHint",
                      "开启后可在输入框下方随时切换「快 / 平衡 / 深入」。档位越高思考越深，也越慢越贵；任务老是跑到一半中断时，调低一档往往就能一次跑完。只对支持该参数的模型显示（Claude 4.5 以上、GPT-5 系）。",
                    )}
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="app-set-toggle"
                  checked={showEffortPicker}
                  onChange={(e) => onShowEffortPicker(e.target.checked)}
                />
              </div>
              <div className="app-set-hint" style={{ marginBottom: "16px" }} />
              <div className="app-set-group">{t("set.g.remindGroup", "会话提醒")}</div>
              <div className="app-set-row" style={{ cursor: "default" }}>
                <div className="app-set-text">
                  <div className="app-set-label">{t("set.g.autoDismiss", "提醒自动消失")}</div>
                  <div className="app-set-hint">
                    {t("set.g.autoDismissHint", "别的会话「在等你选择」时右上角的提醒：开启则倒计时后自动消失；关闭则常驻，直到你点开处理或手动 ✕ 忽略。改动点「保存」后生效。")}
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="app-set-toggle"
                  checked={toastAutoDraft}
                  onChange={(e) => setToastAutoDraft(e.target.checked)}
                />
              </div>
              {toastAutoDraft && (
                <div className="app-set-row" style={{ cursor: "default", gap: "10px", marginBottom: "16px" }}>
                  <div className="app-set-label" style={{ whiteSpace: "nowrap" }}>
                    {t("set.g.countdown", "消失倒计时")}
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={120}
                    step={5}
                    value={toastSecDraft}
                    onChange={(e) => setToastSecDraft(Number(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <div className="app-set-hint" style={{ minWidth: 44, textAlign: "right" }}>
                    {t("set.g.seconds", "{n} 秒").replace("{n}", String(toastSecDraft))}
                  </div>
                </div>
              )}
              <div className="app-set-group">{t("set.g.taskResumeGroup", "任务恢复")}</div>
              <div className="app-set-row" style={{ cursor: "default", marginBottom: "16px" }}>
                <div className="app-set-text">
                  <div className="app-set-label">{t("set.g.taskResume", "检测中断的任务并提示恢复")}</div>
                  <div className="app-set-hint">
                    {t("set.g.taskResumeHint", "打开时若发现被强制关闭、或明显干到一半就退出的任务，在输入框上方提示是否让 AI 接着继续。关闭则不再提示。")}
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="app-set-toggle"
                  checked={resumeDetect}
                  onChange={(e) => {
                    setResumeDetect(e.target.checked);
                    setAppToggle({ resumeDetect: e.target.checked });
                  }}
                />
              </div>

              {/* 智能继续：连推安全阀 + 自定义红线 */}
              <div className="app-set-group">{lang === "en" ? "Smart-continue" : "智能继续（连推 / 自主推进）"}</div>
              <div className="app-set-row" style={{ cursor: "default", marginBottom: "6px" }}>
                <div className="app-set-text">
                  <div className="app-set-label">{lang === "en" ? "Show \"Manual\" mode (approve every tool step)" : "显示「手动」模式（每步都确认权限）"}</div>
                  <div className="app-set-hint">
                    {lang === "en" ? "Off by default — the bottom bar shows only Auto / Smart-continue. Turn on if you want to approve each tool call." : "默认关——底部只显示 自动 / 连推。想每一步都自己点确认再开。"}
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="app-set-toggle"
                  defaultChecked={localStorage.getItem("wuwei-show-manual") === "1"}
                  onChange={(e) => {
                    localStorage.setItem("wuwei-show-manual", e.target.checked ? "1" : "0");
                    window.dispatchEvent(new CustomEvent("wuwei-show-manual", { detail: e.target.checked }));
                  }}
                />
              </div>
              <ContSettings lang={lang} />
              <div style={{ height: 8 }} />
              {/* 红线识别方式：智能识别(LLM判是否真危险) / 关键词匹配(选项含词即停) */}
              <div className="app-set-row" style={{ cursor: "default", marginBottom: "2px" }}>
                <div className="app-set-label">{lang === "en" ? "Redline detection" : "红线识别方式"}</div>
              </div>
              <div className="theme-pick" style={{ marginBottom: "6px" }}>
                {[
                  { id: "smart", label: lang === "en" ? "Smart (AI)" : "智能识别" },
                  { id: "keyword", label: lang === "en" ? "Keywords" : "关键词匹配" },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={"theme-opt" + ((localStorage.getItem("wuwei-redline-mode") === "keyword" ? "keyword" : "smart") === m.id ? " on" : "")}
                    onClick={() => {
                      localStorage.setItem("wuwei-redline-mode", m.id);
                      window.dispatchEvent(new CustomEvent("wuwei-redline-mode", { detail: m.id }));
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="app-set-hint" style={{ marginBottom: "12px" }}>
                {lang === "en"
                  ? "Keywords: stop whenever an option text contains a risky word (fast, may over-trigger). Smart: an AI judges whether auto-deciding would really execute a dangerous action (fewer false stops, one quick call per question)."
                  : "关键词匹配：选项文字里出现危险词就停（快，但偶尔误伤）。智能识别：让 AI 判断「自主选下去会不会真触发危险动作」（更少误停，每题多一次快速判定）。"}
              </div>
              <StopRulesSettings lang={lang} />
              <div className="app-set-hint" style={{ marginBottom: "16px" }} />

              {/* AGI 板块(实验性)：默认关，开了侧栏才出现「数字婴儿」入口 */}
              <div className="app-set-group">{lang === "en" ? "AGI (experimental)" : "AGI 板块（实验性）"}</div>
              <div className="app-set-row" style={{ cursor: "default", marginBottom: "6px" }}>
                <div className="app-set-text">
                  <div className="app-set-label">{lang === "en" ? "Show AGI section (Digital Baby) in the sidebar" : "在侧边栏显示 AGI 板块（数字婴儿）"}</div>
                  <div className="app-set-hint">
                    {lang === "en"
                      ? "A curiosity-driven digital baby that self-learns, grows and chats. Needs a local Python backend — set agi.babyDir & agi.python in ~/.wuwei/config.json."
                      : "好奇心驱动、自主学习成长并能聊天的数字婴儿。依赖本地 Python 后端——需在 ~/.wuwei/config.json 配 agi.babyDir 与 agi.python。"}
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="app-set-toggle"
                  defaultChecked={localStorage.getItem("wuwei-agi-enabled") === "1"}
                  onChange={(e) => {
                    localStorage.setItem("wuwei-agi-enabled", e.target.checked ? "1" : "0");
                    window.dispatchEvent(new CustomEvent("wuwei-agi-toggle", { detail: e.target.checked }));
                  }}
                />
              </div>
              <div className="app-set-hint" style={{ marginBottom: "16px" }} />
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
                      {pLabel(p, lang)}
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
                    setEditStationId(null);
                    setNewStName("");
                    setNewStUrl("");
                    setNewStRelay(false);
                    setEditIsBuiltin(false);
                    setShowAddStation(true);
                  }}
                >
                  {t("set.m.addStation")}
                </button>
                {preset.custom && (
                  <button type="button" className="station-edit" onClick={openEditStation}>
                    {lang === "en" ? "Edit" : "编辑"}
                  </button>
                )}
                {preset.custom && (
                  <button type="button" className="station-del" onClick={() => deleteStation(pid)}>
                    {t("set.m.delete")}{lang === "en" ? ` “${pLabel(preset, lang).replace(/（中转）$/, "")}”` : `「${preset.label.replace(/（中转）$/, "")}」`}
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

              {/* 模型列表管理：手动加/删该平台的模型(自定义加的可删，预设自带的不可删) */}
              <div className="model-list-mgr">
                <div className="mlm-head">{t("set.m.modelList", "该平台模型列表")}</div>
                <div className="mlm-chips">
                  {modelOptions.length === 0 && <span className="mlm-empty">{t("set.m.noModels", "还没有模型，下面加一个")}</span>}
                  {modelOptions.map((m) => {
                    const isCustom = (creds[pid]?.customModels || []).includes(m);
                    return (
                      <span key={m} className={"mlm-chip" + (m === model ? " on" : "")}>
                        <button type="button" className="mlm-pick" title={t("set.m.pickTitle", "选用该模型")} onClick={() => { setModel(m); setCustomModel(false); }}>
                          {m}
                        </button>
                        {isCustom && (
                          <button type="button" className="mlm-del" title={t("set.m.delTitle", "从列表删除")} onClick={() => delCustomModel(m)}>
                            ✕
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
                <div className="mlm-add">
                  <input
                    value={newModelName}
                    onChange={(e) => setNewModelName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); addCustomModel(newModelName); setNewModelName(""); }
                    }}
                    placeholder={t("set.m.addModelPlaceholder", "加模型名，如 qwen2.5-vl-72b-instruct")}
                  />
                  <button type="button" onClick={() => { addCustomModel(newModelName); setNewModelName(""); }}>
                    ＋ {t("set.m.add", "添加")}
                  </button>
                </div>
              </div>

              {/* 该模型能力开关(按【模型】各存各的，切模型即时切换；保存后生效) */}
              <div className="model-caps">
                <div className="model-caps-head">
                  {t("set.m.capsFor", "能力开关 · 针对模型")} <b>{model || t("set.m.noneSel", "（未选）")}</b>
                </div>
                <label className="cap-row" title={t("set.m.toolcallTitle", "关掉后请求不带 tools 参数——自建 vLLM/llama-server 未开工具支持时(一带 tools 就报错)请关掉；关掉后该模型只能纯对话、不能调工具/跑 agent")}>
                  <input
                    type="checkbox"
                    checked={!curCaps.noTools}
                    disabled={!model}
                    onChange={(e) => setModelCap({ noTools: !e.target.checked })}
                  />
                  <span className="cap-text">
                    <b>{t("set.m.toolcall", "工具调用 / Agent")}</b>
                    <em>{t("set.m.toolcallHint", "关掉=请求不带 tools 参数（自建端点不支持工具调用时关掉，否则报错；关掉后只能纯对话）")}</em>
                  </span>
                </label>
                <label className="cap-row" title={t("set.m.visionTitle", "模型名含 vl/vision/omni 等会自动按多模态处理；名字不含但确实能看图的模型，在这里手动开启")}>
                  <input
                    type="checkbox"
                    checked={!!curCaps.vision}
                    disabled={!model}
                    onChange={(e) => setModelCap({ vision: e.target.checked })}
                  />
                  <span className="cap-text">
                    <b>{t("set.m.vision", "看图 / 视觉")}</b>
                    <em>{t("set.m.visionHint", "强制按多模态处理并发送真图片；纯文本模型别开（会 400）。名字含 vl/vision 的已自动识别")}</em>
                  </span>
                </label>
              </div>

              {(preset.kind === "anthropic-apikey" || preset.kind === "openai") && preset.keyUrl && (
                <div className="key-guide">
                  {t("set.m.noKey")}
                  <a onClick={startGetKey}>
                    {lang === "zh" ? `去 ${preset.label} 官网获取（复制后自动填入验证）↗` : `Get one from ${pLabel(preset, lang)} ↗`}
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

              {pNote(preset, lang) && <p className="s-note">{pNote(preset, lang)}</p>}

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
                      <div className="key-wrap oauth">
                        <input type={showKey ? "text" : "password"} value={oauthToken} readOnly />
                        <button
                          type="button"
                          className="eye-btn"
                          onClick={() => setShowKey((v) => !v)}
                          title={showKey ? t("set.m.hide") : t("set.m.show")}
                        >
                          <EyeIcon off={showKey} />
                        </button>
                        <button
                          type="button"
                          className="eye-btn clr"
                          onClick={() => setOauthToken("")}
                          title={t("set.m.clearToken", "清空授权 Token（过期后清掉，改用下方 API Key；点保存后生效）")}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M5 7h14M10 7V5.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V7M7 7l.8 11a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L18 7" />
                          </svg>
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                        {lang === "en" ? "When the auth token expires, click ✕ on the right to clear and \"Save\", then switch to the API Key below." : "授权 Token 过期后点右侧 ✕ 清空并「保存」，即可改用下方 API Key。"}
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
                        const ok = await window.wuwei.codexLogin();
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
                      placeholder={pKeyHint(preset, lang)}
                    />
                    <button
                      type="button"
                      className="eye-btn"
                      onClick={() => setShowKey((v) => !v)}
                      title={showKey ? (lang === "en" ? "Hide" : "隐藏") : (lang === "en" ? "Show" : "显示")}
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
              <div className="prov-manage-bar">
                <button
                  type="button"
                  className="station-add-btn"
                  onClick={() => {
                    setEditStationId(null);
                    setNewStName("");
                    setNewStUrl("");
                    setNewStRelay(false);
                    setEditIsBuiltin(false);
                    setShowAddStation(true);
                  }}
                >
                  {t("set.st.addBtn", "＋ 添加供应商 / 中转站")}
                </button>
              </div>
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
                      <span className="prov-name">{pLabel(p, lang)}</span>
                      <button
                        type="button"
                        className="prov-mini"
                        title={p.custom ? t("set.st.editBtnCustom", "编辑名称 / 端点 / 类型") : t("set.st.renameBtn", "重命名该平台")}
                        onClick={() => openEditStation(p.id)}
                      >
                        {t("set.st.editShort", "编辑")}
                      </button>
                      <button
                        type="button"
                        className="prov-mini del"
                        title={p.custom ? t("set.st.delCustom", "删除该自定义供应商") : t("set.st.delBuiltin", "删除该平台(可一键恢复默认)")}
                        disabled={orderedPresets.length <= 1}
                        onClick={() => deleteProvider(p.id)}
                      >
                        {t("set.st.delShort", "删除")}
                      </button>
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
              {removed.length > 0 && (
                <div className="prov-restore">
                  {lang === "en" ? `${removed.length} default provider(s) removed` : `已删除 ${removed.length} 个默认平台`}
                  <button type="button" className="link-inline" onClick={restoreRemovedProviders}>
                    {lang === "en" ? "Restore defaults" : "恢复默认平台"}
                  </button>
                </div>
              )}
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
                      setSysPrompt(lang === "en" ? sysPromptDefaultEn : sysPromptDefault);
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
                    : `Override for “${pLabel(preset, lang)}” (this provider only)`}
                </span>
              </label>
              {platPromptOn && (
                <label className="field pp-grow">
                  <span>{lang === "en" ? `“${pLabel(preset, lang)}” ` : `「${preset.label}」`}{t("set.pr.overrideLabelSuffix")}</span>
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
                <code>~/.wuwei/memory.md</code>{lang === "zh" ? "。" : "."}
              </p>
            </div>
          )}

          {/* ── 板块 · 脑网络 Brain（概念图谱：查看/检索/编辑）── */}
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
                <div className="prompt-pane" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflowY: "auto" }}>
                  {/* 视图切换：可视化网络 / 脑网络说明提示词 */}
                  <div
                    style={{
                      order: -3,
                      display: "flex",
                      alignSelf: "flex-start",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      overflow: "hidden",
                    }}
                  >
                    {(["graph", "prompt"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setBrainView(v)}
                        style={{
                          padding: "4px 16px",
                          border: "none",
                          cursor: "pointer",
                          fontSize: 13,
                          background: brainView === v ? "var(--accent)" : "transparent",
                          color: brainView === v ? "#fff" : "var(--text)",
                        }}
                      >
                        {v === "graph" ? t("set.brain.viewGraph", "可视化") : t("set.brain.viewPrompt", "提示词")}
                      </button>
                    ))}
                  </div>
                  {/* 总开关：关掉后不注入脑网络说明、不再提供 brain_* 工具 */}
                  <div className="app-set-row" style={{ order: -2, cursor: "default" }}>
                    <div className="app-set-text">
                      <div className="app-set-label">{t("set.brain.enableTitle", "启用脑网络")}</div>
                      <div className="app-set-hint">
                        {t("set.brain.enableHint", "开：给模型注入脑网络说明并提供 brain_recall / brain_learn 等工具。关：完全停用（下面的概念/文档仍在，随时可重新开启）。")}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      className="app-set-toggle"
                      checked={brainOn}
                      onChange={(e) => {
                        setBrainOn(e.target.checked);
                        setAppToggle({ brainEnabled: e.target.checked });
                      }}
                    />
                  </div>
                  {/* 子开关：recall 是否连带扫描『相关文档』(文档冷存储) */}
                  <div className="app-set-row" style={{ order: -1, cursor: "default", opacity: brainOn ? 1 : 0.5 }}>
                    <div className="app-set-text">
                      <div className="app-set-label">{t("set.brain.scanDocsTitle", "检索时扫描相关文档")}</div>
                      <div className="app-set-hint">
                        {t("set.brain.scanDocsHint", "开：brain_recall 除概念子图外，还返回知识宫殿等文档库的相关原文片段。关：只返回概念子图、不扫文档。")}
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      className="app-set-toggle"
                      checked={brainDocsOn}
                      disabled={!brainOn}
                      onChange={(e) => {
                        setBrainDocsOn(e.target.checked);
                        setAppToggle({ brainDocs: e.target.checked });
                      }}
                    />
                  </div>
                  {brainView === "prompt" ? (
                    <>
                      <label className="field pp-grow">
                        <span>{t("set.brain.promptLabel", "脑网络说明提示词")} {brainPromptTouched ? t("set.pr.customized", "（已自定义）") : t("set.pr.default", "（默认）")}</span>
                        <textarea
                          className="sysprompt-area pp-fill"
                          value={brainPrompt}
                          onChange={(e) => {
                            setBrainPrompt(e.target.value);
                            setBrainPromptTouched(true);
                          }}
                          onBlur={() => window.wuwei.setBrainPrompt(brainPromptTouched ? brainPrompt : null)}
                          placeholder={t("set.brain.promptPlaceholder", "（留空 = 用默认脑网络说明）")}
                        />
                      </label>
                      <p className="s-note pp-fixed">
                        {t("set.brain.promptNote", "这段会拼进系统提示词，告诉模型如何使用本地脑网络（brain_recall/brain_learn/brain_link）。改完失焦即保存并热更当前所有会话；「已沉淀的概念」目录会自动追加在其后。")}
                        {brainPromptTouched && (
                          <button
                            type="button"
                            className="link-inline"
                            onClick={() => {
                              setBrainPrompt(lang === "en" ? brainPromptDefaultEn : brainPromptDefault);
                              setBrainPromptTouched(false);
                              window.wuwei.setBrainPrompt(null);
                            }}
                          >
                            {t("set.pr.restore", "恢复默认")}
                          </button>
                        )}
                      </p>
                    </>
                  ) : (
                  <>
                  <div style={{ order: -2, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
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
                        const ok = await window.wuwei.brainWarmup();
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
                          setBrainRecallOut((await window.wuwei.brainRecall(brainRecallQ)) || t("set.brain.noHit"));
                      }}
                    />
                    <button
                      type="button"
                      onClick={async () =>
                        setBrainRecallOut((await window.wuwei.brainRecall(brainRecallQ)) || t("set.brain.noHit"))
                      }
                    >
                      {t("set.brain.recall")}
                    </button>
                  </div>
                  {brainRecallOut && (
                    <div style={{ position: "relative", flex: "0 0 auto" }}>
                      <button
                        type="button"
                        onClick={() => setBrainRecallOut("")}
                        title={t("set.brain.closeResult", "关闭结果")}
                        style={{ position: "absolute", top: 4, right: 4, zIndex: 1, width: 20, height: 20, lineHeight: "18px", textAlign: "center", padding: 0, borderRadius: 4, border: "none", background: "rgba(127,127,127,0.15)", cursor: "pointer", fontSize: 13 }}
                      >
                        ✕
                      </button>
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
                          paddingRight: 28,
                          borderRadius: 6,
                        }}
                      >
                        {brainRecallOut}
                      </pre>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 12, flex: "1 1 auto", minHeight: 200 }}>
                    {/* 左：概念列表（可收起成竖条，给中间图谱腾空间） */}
                    {brainLeftOpen ? (
                    <div style={{ width: 220, flex: "0 0 220px", display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="s-note" style={{ margin: 0, flex: 1, fontWeight: 600 }}>{t("set.brain.conceptList", "概念列表")}</span>
                        <button type="button" className="brain-col-btn" title={t("set.brain.collapseList", "收起概念列表")} onClick={() => setBrainLeftOpen(false)}>
                          ◀
                        </button>
                      </div>
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
                            type: lang === "en" ? "Concept" : "概念",
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
                    ) : (
                      <button
                        type="button"
                        className="brain-col-rail"
                        title={t("set.brain.expandList", "展开概念列表")}
                        onClick={() => setBrainLeftOpen(true)}
                      >
                        <span className="brain-rail-arrow">▶</span>
                        <span className="brain-rail-label">{t("set.brain.conceptList", "概念列表")}</span>
                      </button>
                    )}

                    {/* 中：概念网络力导向图（占最大空间，点节点选中、拖节点挪位） */}
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        minHeight: 0,
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        background: "rgba(127,127,127,0.04)",
                        overflow: "hidden",
                      }}
                    >
                      <ConceptGraph
                        nodes={brainNodes}
                        edges={brainEdges}
                        selectedId={brainSel}
                        onSelect={(id) => {
                          const n = brainNodes.find((x) => x.id === id);
                          if (n) {
                            setBrainSel(id);
                            setBrainDraft({ ...n, attrs: { ...n.attrs }, aliases: [...n.aliases] });
                          }
                        }}
                      />
                    </div>

                    {/* 右：详情编辑（仅选中概念时出现；可收起成竖条，或叉掉取消选中让图谱铺满） */}
                    {brainDraft && !brainRightOpen && (
                      <div style={{ flex: "0 0 26px", width: 26, display: "flex", flexDirection: "column", gap: 4, minHeight: 0 }}>
                        <button
                          type="button"
                          className="brain-col-btn"
                          title={t("set.brain.closeDetail", "关闭详情（取消选中）")}
                          onClick={() => {
                            setBrainDraft(null);
                            setBrainSel(null);
                          }}
                          style={{ padding: "2px 0" }}
                        >
                          ✕
                        </button>
                        <button
                          type="button"
                          className="brain-col-rail"
                          title={t("set.brain.expandDetail", "展开详情")}
                          onClick={() => setBrainRightOpen(true)}
                          style={{ flex: "1 1 auto", width: "auto" }}
                        >
                          <span className="brain-rail-arrow">◀</span>
                          <span className="brain-rail-label">{t("set.brain.detail", "概念详情")}</span>
                        </button>
                      </div>
                    )}
                    {brainDraft && brainRightOpen && (
                      <div style={{ width: 300, flex: "0 0 300px", minHeight: 0, overflow: "auto" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span className="s-note" style={{ margin: 0, flex: 1, fontWeight: 600 }}>{t("set.brain.detail", "概念详情")}</span>
                            <button type="button" className="brain-col-btn" title={t("set.brain.collapseDetail", "收起详情")} onClick={() => setBrainRightOpen(false)}>
                              ▶
                            </button>
                            <button
                              type="button"
                              className="brain-col-btn"
                              title={t("set.brain.closeDetail", "关闭详情（取消选中）")}
                              onClick={() => {
                                setBrainDraft(null);
                                setBrainSel(null);
                              }}
                            >
                              ✕
                            </button>
                          </div>
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
                                        await window.wuwei.brainDeleteEdge(ed.id);
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
                                      await window.wuwei.brainAddEdge(
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
                                await window.wuwei.brainSaveNode({
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
                                  await window.wuwei.brainDeleteNode(brainDraft.id);
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
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      order: -1,
                      borderBottom: "1px solid var(--border)",
                      paddingBottom: 10,
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
                        disabled={docBuilding || conExtract?.running}
                        onClick={async () => {
                          const picked = await window.wuwei.selectFolder();
                          if (picked) setDocDir(picked);
                        }}
                      >
                        {t("set.brain.docBrowse")}
                      </button>
                      <button
                        type="button"
                        disabled={docBuilding || conExtract?.running || !docDir.trim()}
                        onClick={async () => {
                          setDocBuilding(true);
                          setDocProg(t("set.brain.docPreparing"));
                          try {
                            const s = await window.wuwei.brainBuildDocs(docDir.trim());
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
                          const r = await window.wuwei.brainExtractConcepts({ all: false });
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
                          const r = await window.wuwei.brainExtractConcepts({ all: true });
                          if (!r.started) setBrainWarmMsg("✗ " + (r.reason || t("set.brain.extractFail")));
                        }}
                      >
                        {t("set.brain.extractAll")}
                      </button>
                      {conExtract?.running && (
                        <button type="button" className="allow" onClick={() => window.wuwei.brainStopConcepts()}>
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
                    {t("set.brain.footDesc")}
                  </p>
                  </>
                  )}
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
                              {mcpLabel(c, lang)} <code>{c.name}</code>
                            </span>
                            <span className="mcp-cat-desc">{mcpDesc(c, lang)}</span>
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
                                  title={t("set.mcp.clickDetail", "点击看详情")}
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
                                        onClick={() => window.wuwei.openExternal(r.repo)}
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
                      {mcpRawEdit ? t("set.mcp.collapseJson", "收起 JSON") : t("set.mcp.advJson", "高级：编辑 JSON")}
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
                        placeholder={lang === "en" ? '{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "..."] } } }' : '{ "mcpServers": { "名称": { "command": "npx", "args": ["-y", "..."] } } }'}
                      />
                      <button
                        type="button"
                        className="link-inline"
                        onClick={() => {
                          window.wuwei.setMcp(mcpConfig);
                          mcpTouchedRef.current = false;
                          setTimeout(reloadMcpStatus, 2800);
                        }}
                      >
                        {t("set.mcp.saveReconnect", "保存并重连")}
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
                        {g.tools.map((tool) => (
                          <button
                            key={tool.name}
                            type="button"
                            className="tool-row"
                            onClick={() => setToolSel(tool)}
                          >
                            <span className="tool-name">
                              {tool.name}
                              {tool.readOnly && <span className="tool-ro">{t("set.tools.readOnly")}</span>}
                            </span>
                            <span className="tool-desc">{toolDesc(tool.name, tool.description, lang)}</span>
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

              <div className="app-set-row" style={{ cursor: "default" }}>
                <div className="app-set-text">
                  <div className="app-set-label">{t("set.sec.detectTitle", "发送前检测疑似新密钥")}</div>
                  <div className="app-set-hint">
                    {t("set.sec.detectHint", "开：发送前扫描文本、发现疑似新密钥就弹窗让你确认是否入库。关：不再扫描拦截——传很长的临时 token 时不会被切成一堆弹窗。（已入库密钥仍会自动脱敏，不受此开关影响。）")}
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="app-set-toggle"
                  checked={secretsDetect}
                  onChange={(e) => {
                    setSecretsDetect(e.target.checked);
                    setAppToggle({ secretsDetect: e.target.checked });
                  }}
                />
              </div>

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
                  secrets.map((s) =>
                    secEdit === s.id ? (
                      // 编辑态：改名称/环境变量名/备注(值不动)
                      <div key={s.id} className="sec-row sec-row-edit">
                        <div className="sec-edit-fields">
                          <input
                            className="sec-in"
                            placeholder={t("set.sec.editName", "名称")}
                            value={secEditDraft.name}
                            onChange={(e) => setSecEditDraft((d) => ({ ...d, name: e.target.value }))}
                          />
                          <input
                            className="sec-in"
                            placeholder={t("set.sec.editEnvPlaceholder", "环境变量名 (如 DB_PASSWORD)")}
                            value={secEditDraft.envVar}
                            onChange={(e) => setSecEditDraft((d) => ({ ...d, envVar: e.target.value }))}
                          />
                          <input
                            className="sec-in"
                            placeholder={t("set.sec.editNote", "备注 (可选)")}
                            value={secEditDraft.note}
                            onChange={(e) => setSecEditDraft((d) => ({ ...d, note: e.target.value }))}
                          />
                          <div className="sec-edit-actions">
                            <button
                              type="button"
                              className="allow"
                              disabled={!secEditDraft.name.trim()}
                              onClick={async () => {
                                await window.wuwei.secretsUpdate(s.id, {
                                  name: secEditDraft.name.trim(),
                                  envVar: secEditDraft.envVar.trim() || undefined,
                                  note: secEditDraft.note.trim(),
                                });
                                setSecEdit(null);
                                reloadSecrets();
                              }}
                            >
                              {lang === "en" ? "Save" : "保存"}
                            </button>
                            <button type="button" onClick={() => setSecEdit(null)}>
                              {lang === "en" ? "Cancel" : "取消"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
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
                        <div className="sec-row-actions">
                          <button
                            type="button"
                            className="sec-edit-btn"
                            title={t("set.sec.editTitle", "改名称/备注")}
                            onClick={() => {
                              setSecEditDraft({ name: s.name, envVar: s.envVar || "", note: s.note || "" });
                              setSecEdit(s.id);
                            }}
                          >
                            {lang === "en" ? "Edit" : "编辑"}
                          </button>
                          <button
                            type="button"
                            className="sec-del"
                            title={t("set.sec.delete")}
                            onClick={async () => {
                              await window.wuwei.secretsDelete(s.id);
                              reloadSecrets();
                            }}
                          >
                            {t("set.sec.delete")}
                          </button>
                        </div>
                      </div>
                    ),
                  )
                )}
              </div>

              {/* 密钥说明提示词：拼进系统提示词的那段，查看/修改 */}
              <details className="sec-prompt" style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
                  {t("set.sec.promptLabel", "密钥说明提示词")} {secretsPromptTouched ? t("set.pr.customized", "（已自定义）") : t("set.pr.default", "（默认）")}{t("set.sec.promptViewEdit", " — 查看/修改")}
                </summary>
                <label className="field" style={{ marginTop: 8, display: "block" }}>
                  <textarea
                    className="sysprompt-area"
                    style={{ minHeight: 140, width: "100%" }}
                    value={secretsPrompt}
                    onChange={(e) => {
                      setSecretsPrompt(e.target.value);
                      setSecretsPromptTouched(true);
                    }}
                    onBlur={() => window.wuwei.setSecretsPrompt(secretsPromptTouched ? secretsPrompt : null)}
                    placeholder={t("set.sec.promptPlaceholder", "（留空 = 用默认密钥说明）")}
                  />
                </label>
                <p className="s-note">
                  {t("set.sec.promptNote", "这段会拼进系统提示词，告诉模型密钥走本地保险箱/环境变量、不索取明文。改完失焦即保存并热更当前所有会话。")}
                  {secretsPromptTouched && (
                    <button
                      type="button"
                      className="link-inline"
                      onClick={() => {
                        setSecretsPrompt(lang === "en" ? secretsPromptDefaultEn : secretsPromptDefault);
                        setSecretsPromptTouched(false);
                        window.wuwei.setSecretsPrompt(null);
                      }}
                    >
                      {t("set.pr.restore", "恢复默认")}
                    </button>
                  )}
                </p>
              </details>
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

    {/* 添加/编辑 供应商/中转站：独立小弹窗，不撑爆主设置页 */}
    {showAddStation && (
      <div className="perm-overlay add-st-overlay" onClick={() => { setShowAddStation(false); setEditStationId(null); setEditIsBuiltin(false); }}>
        <div className="add-st-dialog" onClick={(e) => e.stopPropagation()}>
          <h3>{editIsBuiltin ? t("set.st.renameTitle", "重命名平台") : editStationId ? t("set.st.editTitle", "编辑供应商 / 中转站") : t("set.st.addTitle", "添加供应商 / 中转站")}</h3>

          {!editIsBuiltin && (
            <div className="st-field">
              <span className="st-label">{t("set.st.type", "类型")}</span>
              <div className="theme-pick">
                <button
                  type="button"
                  className={"theme-opt" + (!newStRelay ? " on" : "")}
                  onClick={() => setNewStRelay(false)}
                >
                  {t("set.st.selfhost", "自建供应商")}
                </button>
                <button
                  type="button"
                  className={"theme-opt" + (newStRelay ? " on" : "")}
                  onClick={() => setNewStRelay(true)}
                >
                  {t("set.st.relayType", "中转站")}
                </button>
              </div>
              <p className="st-hint">
                {newStRelay
                  ? t("set.st.relayHint", "中转站：一个 key 直连多平台（OpenAI 兼容）。名字会带「（中转）」后缀。")
                  : t("set.st.selfhostHint", "自建供应商：你自己的 OpenAI 兼容端点，如公司 vLLM / Ollama / llama-server。")}
              </p>
            </div>
          )}

          <div className="st-field">
            <span className="st-label">{t("set.st.name", "名称")}</span>
            <input
              className="st-input"
              autoFocus
              value={newStName}
              onChange={(e) => setNewStName(e.target.value)}
              placeholder={editIsBuiltin ? t("set.st.namePhBuiltin", "显示名") : newStRelay ? t("set.st.namePhRelay", "如：我的便宜中转") : t("set.st.namePhSelf", "如：公司 Qwen")}
            />
          </div>

          {!editIsBuiltin && (
            <div className="st-field">
              <span className="st-label">{t("set.st.baseUrlLabel", "Base URL（OpenAI 兼容端点）")}</span>
              <input
                className="st-input"
                value={newStUrl}
                onChange={(e) => setNewStUrl(e.target.value)}
                placeholder={t("set.st.baseUrlPh", "如 http://192.168.2.195:8000/v1")}
              />
            </div>
          )}

          <p className="st-note">
            {editIsBuiltin
              ? t("set.st.noteBuiltin", "只改这个平台的显示名（端点/密钥/模型都不变；改回原名即恢复默认）。")
              : editStationId
                ? t("set.st.noteEdit", "改名 / 改类型 / 改端点地址；API Key 与模型在上一页各自保留不变。")
                : t("set.st.noteAdd", "添加后回上一页填 API Key、模型名。⚠️ 填 key = 把 key 交给该端点，请只添加你信任的。")}
          </p>
          <div className="btns">
            <button onClick={() => { setShowAddStation(false); setEditStationId(null); setEditIsBuiltin(false); }}>{t("set.st.cancel", "取消")}</button>
            <button className="allow" onClick={editStationId ? saveStationEdit : addStation}>
              {editStationId ? t("set.st.save", "保存") : t("set.st.add", "添加")}
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
          <p className="s-note tool-detail-desc">{toolDesc(toolSel.name, toolSel.description, lang)}</p>
          <div className="tool-detail-label">{t("set.tools.detailSchema")}</div>
          <pre className="tools-json tool-detail-schema">
            {JSON.stringify(toolSel.inputSchema, null, 2)}
          </pre>
          <div className="btns" style={{ marginTop: 16 }}>
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
    window.wuwei.getSettings().then((r: any) => setTheme(resolveTheme(r?.settings?.theme)));
  }, []);
  // 选主题：实时预览 + 立即持久化(spread 现有 settings 只改 theme)
  async function pickTheme(t: string) {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    const r: any = await window.wuwei.getSettings();
    window.wuwei.setSettings({ ...(r?.settings || {}), theme: t });
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
