// 用户设置持久化：模型后端(provider)与模型选择，存 ~/.wuwei/config.json。
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".wuwei");

// 系统语言自动判定（用户没手动设过界面语言时用）：中国时区 → 中文；否则按系统 locale/LANG，
// zh 开头 → 中文，其它 → 英文。不依赖 electron，CLI 侧同样可用。与 renderer i18n.getLang() 同逻辑。
export function detectSysLang(): "zh" | "en" {
  try {
    const opt = Intl.DateTimeFormat().resolvedOptions();
    const tz = (opt.timeZone || "").toLowerCase();
    if (/shanghai|chongqing|harbin|urumqi|kashgar|hong_kong|macau|taipei/.test(tz)) return "zh";
    const loc = (opt.locale || process.env.LC_ALL || process.env.LANG || "").toLowerCase();
    return loc.startsWith("zh") ? "zh" : "en";
  } catch {
    return "zh"; // 兜底中文（主力用户群）
  }
}

// 数据目录改名迁移：老版本存 ~/.minicc，改名后首启把老数据复制进 ~/.wuwei。
// force:false → 不覆盖已存在文件(保住 ~/.wuwei 里已有的 auth.json 等)；一次性(靠 marker)。
export function migrateFromMinicc(): void {
  try {
    const oldDir = join(homedir(), ".minicc");
    const marker = join(DIR, ".migrated-from-minicc");
    if (!existsSync(oldDir) || existsSync(marker)) return;
    mkdirSync(DIR, { recursive: true });
    cpSync(oldDir, DIR, { recursive: true, force: false, errorOnExist: false });
    writeFileSync(marker, new Date().toISOString());
  } catch {
    /* 迁移失败不阻塞启动，最坏是走全新数据 */
  }
}
const FILE = join(DIR, "config.json");
const RL = join(DIR, "ratelimits.json");
const USG = join(DIR, "usage.json");
const WIN = join(DIR, "window.json");
const SB = join(DIR, "session-balance.json");

// 每个会话的余额跟踪：last=最近一次余额, spent=累计消耗(每次余额下降就累加)。持久化，重启不丢。
export interface SessionBal {
  last: number;
  spent: number;
}
export function loadSessionBalances(): Record<string, SessionBal> {
  try {
    const raw = JSON.parse(readFileSync(SB, "utf8"));
    const out: Record<string, SessionBal> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number") out[k] = { last: v, spent: 0 }; // 迁移旧的纯数字格式
      else if (v && typeof v === "object") out[k] = v as SessionBal;
    }
    return out;
  } catch {
    return {};
  }
}
export function saveSessionBalances(m: Record<string, SessionBal>) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(SB, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

// token 用量快照持久化（上下文窗口占用别每次归零）
export function loadUsage(): unknown {
  try {
    return JSON.parse(readFileSync(USG, "utf8"));
  } catch {
    return null;
  }
}
export function saveUsage(u: unknown) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(USG, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}

// 窗口尺寸/位置持久化（下次按上次的开）
export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}
export function loadWindowBounds(): WindowBounds | null {
  try {
    return JSON.parse(readFileSync(WIN, "utf8"));
  } catch {
    return null;
  }
}
export function saveWindowBounds(b: WindowBounds) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(WIN, JSON.stringify(b));
  } catch {
    /* ignore */
  }
}

// 订阅额度快照持久化（打开就显示上次，不必等发消息刷新）——按平台分开存，避免串台
// 存储结构：{ [providerId]: rateLimits }
export function loadRateLimits(pid?: string): unknown {
  try {
    const all = JSON.parse(readFileSync(RL, "utf8")) as Record<string, unknown> | null;
    if (!all || typeof all !== "object" || Array.isArray(all)) return null;
    return pid ? (all[pid] ?? null) : null;
  } catch {
    return null;
  }
}
export function saveRateLimits(pid: string, rl: unknown) {
  try {
    mkdirSync(DIR, { recursive: true });
    let all: Record<string, unknown> = {};
    try {
      const cur = JSON.parse(readFileSync(RL, "utf8"));
      if (cur && typeof cur === "object" && !Array.isArray(cur)) all = cur;
    } catch {
      /* 首次或旧格式，重建 */
    }
    all[pid] = rl;
    writeFileSync(RL, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export type ProviderKind = "codex" | "anthropic-oauth" | "anthropic-apikey" | "openai";

// 每个平台各存各的凭证（切平台自动带出对应的，不串号）
export interface CredSlot {
  apiKey?: string;
  baseUrl?: string;
  oauthToken?: string;
  nickname?: string; // 账号昵称：手填 或 浏览器登录抓取
  avatar?: string; // 头像(存成 data: URI)：浏览器登录后从控制台抓取
  webToken?: string; // 控制台 Bearer token：存下来后静默刷新账号信息，过期才需重登
  webHeaders?: Record<string, string>; // 额度接口所需的整套自定义头(如 Kimi 的 x-msh-*)：登录时抓真实请求头存下，静默刷新原样重放
  systemPrompt?: string; // 本平台专属系统提示词(覆盖全局)；未设=跟随全局默认。含空串=本平台强制空
  model?: string; // 该平台上次选用的模型：切平台带出各自记住的模型，别被目标平台默认值冲掉
  noTools?: boolean; // 【旧·平台级兜底】不发 tools 参数；新逻辑用 modelCaps 按模型存，这个仅作迁移兜底
  vision?: boolean; // 【旧·平台级兜底】强制多模态；同上
  modelCaps?: Record<string, { noTools?: boolean; vision?: boolean }>; // 按模型名各存能力开关(工具调用/看图)
  customModels?: string[]; // 用户为该平台手动增加的模型名(并入模型下拉/快切，可增删)
}

export interface Settings {
  kind: ProviderKind;
  providerId?: string; // UI 预设平台标识(codex/claude-oauth/anthropic/openai/deepseek/qwen/doubao/minimax/custom)
  model?: string;
  // 下面三个是「当前生效平台」的凭证(loadConfig 据此构造环境变量)；随平台切换镜像自 creds[providerId]
  apiKey?: string; // anthropic-apikey / openai
  baseUrl?: string; // openai 兼容端点
  oauthToken?: string; // anthropic 订阅
  creds?: Record<string, CredSlot>; // 按平台分槽保存的全部凭证
  app?: AppSettings; // 应用级设置(与具体平台无关)
  systemPrompt?: string; // 自定义系统提示词(全局)；未设=用默认模板。支持 {model}/{cwd} 占位符
  brainPrompt?: string; // 脑网络说明提示词覆盖；未设=用 DEFAULT_BRAIN_NOTE(在「知识网络」设置里查看/改)
  secretsPrompt?: string; // 密钥说明提示词覆盖；未设=用 SECRETS_SYSTEM_NOTE(在「密钥」设置里查看/改)
  customStations?: CustomStation[]; // 用户自定义的中转站(OpenAI 兼容)，显示在平台下拉里
  theme?: "dark" | "light" | "gray" | "gold"; // 界面主题(均遵循minicc VI；gold=原版怀旧)
  providerOrder?: string[]; // 用户自定义的平台展示顺序(存 providerId；缺省走内置默认序)
  hiddenProviders?: string[]; // 用户隐藏、不在切换菜单出现的平台(设置里仍可恢复)
  removedProviders?: string[]; // 用户"删除"的平台(含内置)：从平台管理列表与切换菜单彻底移除；可一键恢复默认
  providerOverrides?: Record<string, { label?: string; baseUrl?: string }>; // 改名/改端点(含内置平台)
  groupMode?: "manual" | "date" | "project"; // 侧栏分组模式：手动/按日期/按项目智能分组(默认 manual)
  streamMode?: "typewriter" | "stream" | "instant"; // 输出方式：打字机(匀速)/流式(一下出)/回完一次性
  streamSpeed?: number; // 打字机速度(字符/秒)，默认 400
  keepRecent?: number; // 上下文压缩时保留最近多少条原始消息(默认 12)
  effort?: "low" | "medium" | "high" | "xhigh" | "max"; // 思考档位：越高越深入也越慢越贵(默认 medium)
  showEffortPicker?: boolean; // 是否在底栏显示思考档位选择器(默认显示)
  askToastAutoDismiss?: boolean; // 别的会话「在等你选择」的右上角提醒是否自动消失(默认开=undefined 视为 true)
  askToastDismissSec?: number; // 自动消失倒计时秒数(默认 30)
}

// 自定义供应商/中转站：名称 + OpenAI 兼容端点(key 存 creds[id] 槽，同其它平台)
export interface CustomStation {
  id: string;
  label: string;
  baseUrl: string;
  relay?: boolean; // true=中转站(显示「（中转）」后缀) / false|undefined=自建供应商
}

// 应用级设置：放在专门的「设置」弹窗里，跨平台通用
export interface AppSettings {
  claudeAutoRefresh?: boolean; // Claude Code token 过期时用 refreshToken 自动刷新(默认关；有搞挂 Claude Code 登录的风险)
  secretsDetect?: boolean; // 发送前扫描/拦截疑似新密钥(默认开=undefined 视为 true)；关掉后长 token 不再被切成一堆弹窗
  brainEnabled?: boolean; // 启用本地知识网络 Brain：注入系统提示 + 提供 brain_* 工具(默认开)
  brainDocs?: boolean; // brain_recall 是否连带扫描文档冷存储的『相关文档』(默认开)
  resumeDetect?: boolean; // 启动时检测被中断/干到一半的任务并提示恢复(默认开=undefined 视为 true)
}

// 三个开关的取值：undefined 一律按「开」处理，保持历史默认行为，只让用户能主动关
export function secretsDetectEnabled(s: Settings | null): boolean {
  return s?.app?.secretsDetect !== false;
}
export function brainEnabled(s: Settings | null): boolean {
  return s?.app?.brainEnabled !== false;
}
export function brainDocsEnabled(s: Settings | null): boolean {
  return s?.app?.brainDocs !== false;
}
export function resumeDetectEnabled(s: Settings | null): boolean {
  return s?.app?.resumeDetect !== false;
}

export function loadSettings(): Settings | null {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveSettings(s: Settings) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

// 把设置映射成环境变量（loadConfig 会据此构造 Config，复用全部推断/凭证加载逻辑）
export function applyEnvFromSettings(s: Settings | null) {
  for (const k of [
    "MINICC_PROVIDER",
    "MINICC_MODEL",
    "MINICC_OAUTH_TOKEN",
    "MINICC_BASE_URL",
    "MINICC_API_KEY",
    "ANTHROPIC_API_KEY",
    "MINICC_VISION",
    "MINICC_NO_TOOLS",
    "MINICC_EFFORT",
  ]) {
    delete process.env[k];
  }
  // 界面语言 → env，供 CLI 侧（mcp 状态、remember 的默认记忆头 # 记忆/# Memory）跟随。
  // 用户未手动设过 lang → 按系统语言自动判定（海外默认英文），与 renderer i18n getLang() 一致。
  process.env.WUWEI_LANG =
    s?.app?.lang === "en" ? "en" : s?.app?.lang === "zh" ? "zh" : detectSysLang();
  if (!s) return; // 无设置：走 loadConfig 自动推断（有 ~/.codex 即 codex）
  if (s.model) process.env.MINICC_MODEL = s.model;
  // 当前生效模型的能力开关：优先按模型(modelCaps[model])，回退到旧的平台级(迁移兼容)
  const slot = s.creds?.[s.providerId || ""] || {};
  const caps = slot.modelCaps?.[s.model || ""] || {};
  if (caps.vision ?? slot.vision) process.env.MINICC_VISION = "1";
  if (caps.noTools ?? slot.noTools) process.env.MINICC_NO_TOOLS = "1";
  if (s.effort) process.env.MINICC_EFFORT = s.effort; // 思考档位 → 请求里的 reasoning.effort
  switch (s.kind) {
    case "codex":
      process.env.MINICC_PROVIDER = "codex";
      break;
    case "anthropic-oauth":
      process.env.MINICC_PROVIDER = "anthropic";
      if (s.oauthToken) process.env.MINICC_OAUTH_TOKEN = s.oauthToken;
      break;
    case "anthropic-apikey":
      process.env.MINICC_PROVIDER = "anthropic";
      if (s.apiKey) process.env.ANTHROPIC_API_KEY = s.apiKey;
      break;
    case "openai":
      process.env.MINICC_PROVIDER = "openai";
      if (s.baseUrl) process.env.MINICC_BASE_URL = s.baseUrl;
      if (s.apiKey) process.env.MINICC_API_KEY = s.apiKey;
      break;
  }
}
