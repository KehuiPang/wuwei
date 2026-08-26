// 运行配置：从环境变量读取，决定接哪个模型后端。
// 四条路：
//   1) Claude API key（provider=anthropic, authMode=api-key）—— ANTHROPIC_API_KEY(sk-ant-...)
//   2) Claude 订阅 OAuth（provider=anthropic, authMode=oauth）—— MINICC_OAUTH_TOKEN
//   3) OpenAI 兼容端点（provider=openai）—— MINICC_BASE_URL + MINICC_MODEL（本地 vLLM 等）
//   4) Codex 订阅版（provider=codex）—— ChatGPT 登录，走 Responses API + chatgpt.com/backend-api/codex
//      凭证优先取 env(CODEX_ACCESS_TOKEN/CODEX_ACCOUNT_ID)，否则读 ~/.codex/auth.json。
//      真机验证：model 必须用主线名(如 gpt-5.5)，gpt-5*-codex 后缀在订阅通道被拒。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

export type AuthMode = "api-key" | "oauth";

export interface Config {
  provider: "anthropic" | "openai" | "codex";
  authMode: AuthMode;
  model: string;
  apiKey: string;
  oauthToken: string;
  baseUrl?: string;
  vision?: boolean; // 强制按多模态处理(自建端点模型名不含 vl 时用)；MINICC_VISION=1
  disableTools?: boolean; // 不发工具(某些自建 vLLM 未开 --enable-auto-tool-choice 会 400)；MINICC_NO_TOOLS=1
  effort?: "low" | "medium" | "high" | "xhigh" | "max"; // 思考档位；MINICC_EFFORT，未设=用服务端默认
  maxTokens: number;
  anthropicBeta: string;
  // Codex 订阅
  codexToken: string;
  codexAccountId: string;
  codexEndpoint: string;
  // 上下文自动压缩
  contextWindow: number; // 该模型的上下文窗口(用于占用条 + 计算压缩阈值)
  compactThreshold: number; // 上一轮 input tokens 超过此值就压缩
  keepRecentTurns: number; // 压缩时保留最近多少条原始消息
}

// 各模型上下文窗口(按 model id 推断；不确定的取保守 128k，避免超限报错)
function contextWindowFor(model: string): number {
  const m = model.toLowerCase();
  if (/ox-alpha/.test(m)) return 1_000_000; // Ox Alpha(牛来) 旗舰 1M 上下文(不命中会掉进兜底 128k，提前触发无谓压缩)
  if (/claude-(opus|sonnet|fable|mythos)/.test(m)) return 1_000_000;
  if (/claude-haiku/.test(m)) return 200_000;
  if (/deepseek-v4/.test(m)) return 1_000_000; // V4 Pro/Flash 均 1M
  if (/minimax-m3/.test(m)) return 1_000_000;
  if (/minimax/.test(m)) return 200_000;
  if (/gpt-5/.test(m)) return 1_000_000; // GPT-5.x 模型窗口 ~1M(Codex 通道会在 loadConfig 里封到 400k)
  if (/gpt-4\.1|\bo3\b|\bo4/.test(m)) return 400_000;
  if (/qwen3?[.-]?(max|7)|qwen-max|qwen-plus/.test(m)) return 256_000;
  if (/doubao/.test(m)) return 256_000;
  if (/glm-5/.test(m)) return 1_000_000; // GLM-5.2/5.1 1M
  if (/glm-4/.test(m)) return 200_000;
  if (/moonshot-v1-8k/.test(m)) return 8_192;
  if (/moonshot-v1-32k/.test(m)) return 32_000;
  if (/moonshot-v1-128k/.test(m)) return 128_000;
  if (/\bk3\b|kimi-k3/.test(m)) return 1_000_000; // Kimi K3 旗舰 1M(订阅端 model id 就叫 k3)
  if (/kimi-for-coding|kimi/.test(m)) return 256_000; // Kimi Code K2.7 / K2.x / kimi-latest
  if (/hunyuan/.test(m)) return 256_000;
  if (/grok-4\.[35]/.test(m)) return 1_000_000; // grok-4.3/4.5 旗舰
  if (/grok/.test(m)) return 256_000;
  // 旧 deepseek-chat / gpt-4o / qwen-其它 / 未知 → 128k(保守；本地小窗口 vLLM 请在设置里手填上下文)
  return 128_000;
}

function pick(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

// 读取 Codex 凭证：优先 env，其次 ~/.codex/auth.json（ChatGPT 登录写入）
function loadCodexCreds(): { token: string; accountId: string } {
  const envToken = pick("CODEX_ACCESS_TOKEN");
  const envAcct = pick("CODEX_ACCOUNT_ID");
  if (envToken && envAcct) return { token: envToken, accountId: envAcct };
  try {
    const auth = JSON.parse(readFileSync(`${homedir()}/.codex/auth.json`, "utf8"));
    return {
      token: envToken || auth?.tokens?.access_token || "",
      accountId: envAcct || auth?.tokens?.account_id || "",
    };
  } catch {
    return { token: envToken, accountId: envAcct };
  }
}

export function loadConfig(): Config {
  const oauthToken = pick("MINICC_OAUTH_TOKEN");
  const explicit = pick("MINICC_PROVIDER");

  // 后端推断优先级：显式 > 本地端点 > 有 Claude 凭证 > 有 Codex 登录 > 默认 anthropic
  const hasClaudeCred = !!pick("ANTHROPIC_API_KEY") || !!oauthToken;
  const hasCodexAuth = existsSync(`${homedir()}/.codex/auth.json`);
  const provider: Config["provider"] =
    explicit === "openai" || explicit === "anthropic" || explicit === "codex"
      ? (explicit as Config["provider"])
      : pick("MINICC_BASE_URL")
        ? "openai"
        : hasClaudeCred
          ? "anthropic"
          : hasCodexAuth
            ? "codex"
            : "anthropic";

  const authMode: AuthMode =
    provider === "anthropic" && oauthToken ? "oauth" : "api-key";

  const codex = provider === "codex" ? loadCodexCreds() : { token: "", accountId: "" };

  const model =
    pick("MINICC_MODEL") ||
    (provider === "anthropic"
      ? "claude-sonnet-5"
      : provider === "codex"
        ? "gpt-5.5"
        : "qwen3-coder");

  const apiKey =
    provider === "anthropic" ? pick("ANTHROPIC_API_KEY") : pick("MINICC_API_KEY", "not-needed");

  let ctxWindow = Number(pick("MINICC_CONTEXT_WINDOW")) || contextWindowFor(model);
  // Codex 订阅通道对 gpt-5.x 封顶 400k(OpenAI Codex 自身限制，模型本身支持 1M 需走 API key)
  if (provider === "codex" && ctxWindow > 400_000) ctxWindow = 400_000;
  // Claude 订阅(OAuth)通道同理封顶 200k：1M 是 API key 通道的能力，订阅端给不到。
  // 不封的话占用条按 1M 算，用户看着「才 30 万、远没到 100 万」却一直报错，还会被误读成限流。
  // 实测上限以服务端报错为准(prompt is too long: X > Y)；要覆盖用 MINICC_CONTEXT_WINDOW。
  if (provider === "anthropic" && authMode === "oauth" && ctxWindow > 200_000) ctxWindow = 200_000;

  return {
    provider,
    authMode,
    model,
    apiKey,
    oauthToken,
    baseUrl: pick("MINICC_BASE_URL") || undefined,
    // 三态：未设置=undefined(交给模型名判断) / 1|true|yes=强制开 / 其余(如 0)=强制关。
    // 不能简写成 test(...) —— 那样「没设置」会等于 false，被下游当成「强制关」，图片全被丢掉。
    vision: pick("MINICC_VISION", "").trim()
      ? /^(1|true|yes)$/i.test(pick("MINICC_VISION", ""))
      : undefined,
    // 思考档位：低=快而省，高=深而慢。未设则不带该参数，由服务端/模型用自己的默认值。
    effort: (["low", "medium", "high", "xhigh", "max"] as const).includes(
      pick("MINICC_EFFORT", "").toLowerCase() as never,
    )
      ? (pick("MINICC_EFFORT", "").toLowerCase() as "low" | "medium" | "high" | "xhigh" | "max")
      : undefined,
    disableTools: /^(1|true|yes)$/i.test(pick("MINICC_NO_TOOLS", "")),
    maxTokens: Number(pick("MINICC_MAX_TOKENS", "8192")),
    anthropicBeta: pick("MINICC_ANTHROPIC_BETA", "oauth-2025-04-20"),
    codexToken: codex.token,
    codexAccountId: codex.accountId,
    codexEndpoint: pick(
      "MINICC_CODEX_ENDPOINT",
      "https://chatgpt.com/backend-api/codex/responses",
    ),
    contextWindow: ctxWindow,
    // 阈值默认=窗口的 80%(留 20% 余量再压缩)；env 可显式覆盖
    compactThreshold: pick("MINICC_COMPACT_THRESHOLD")
      ? Number(pick("MINICC_COMPACT_THRESHOLD"))
      : Math.floor(ctxWindow * 0.8),
    keepRecentTurns: Number(pick("MINICC_KEEP_RECENT", "12")),
  };
}
