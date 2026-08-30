// Provider 实现：把统一的 Message/Tool 语义翻译到具体后端。
// - AnthropicProvider：原生 Anthropic Messages API（流式）
// - OpenAIProvider：任意 OpenAI 兼容 /chat/completions（本地 vLLM 等），做消息与工具的双向转换
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResult,
  ProviderStreamHandlers,
  ToolSpec,
} from "../types.js";

// 界面语言（WUWEI_LANG 由主进程 applyEnvFromSettings 写入，CLI 同样可用）。
// 下面这些 throw 的 message 会被主进程原样 send("evt:error") 到聊天里的红色错误条，所以要跟随语言。
// 必须在调用处求值：放模块顶层 const 会在加载那刻把语言焊死，切语言不生效。
const tt = (zh: string, en: string) => (process.env.WUWEI_LANG === "en" ? en : zh);

// 无为托管网关的错误码 → 人话提示。网关出错时会返回 {error:{type:"gateway_error",code,...}}，
// 直接把原始 JSON 甩给用户看不懂(如「OpenAI 兼容端点报错 402: {...}」)，这里翻成中/英友好文案并给出下一步。
// 只对无为网关(baseUrl 含 /api/gateway)生效；第三方端点保持原样报错，不误翻。
function humanizeGatewayError(status: number, rawBody: string): string | null {
  let code = ""; let bal: number | undefined; let est: number | undefined;
  try {
    const j = JSON.parse(rawBody);
    const e = j?.error;
    if (!e || e.type !== "gateway_error") return null; // 不是网关结构化错误 → 交回原始处理
    code = String(e.code || "");
    if (typeof e.balance === "number") bal = e.balance;
    if (typeof e.estimated_cost === "number") est = e.estimated_cost;
  } catch {
    return null; // 非 JSON → 不是网关错误
  }
  const coins = (n?: number) => (typeof n === "number" ? String(n) : "");
  switch (code) {
    case "insufficient_balance": {
      const need = est != null ? tt(`（本次约需 ${coins(est)} 无为币，`, `(this request needs ~${coins(est)} coins, `) : tt("（", "(");
      const have = bal != null ? tt(`当前余额 ${coins(bal)}）`, `you have ${coins(bal)})`) : tt("）", ")");
      return tt(
        `无为币余额不足以支付本次请求${need}${have}。请前往充值，或改用免费模型继续。`,
        `Not enough coins for this request ${need}${have}. Please top up, or switch to a free model.`,
      );
    }
    case "daily_cap_reached":
      return tt(
        "已达今日使用上限。请明天再试，或到后台/会员页提升每日额度。",
        "Daily usage limit reached. Try again tomorrow, or raise your daily cap.",
      );
    case "free_quota_exhausted":
      return tt(
        "免费体验额度已用完。登录并充值即可继续使用付费模型，或换其它免费模型。",
        "Free trial quota used up. Sign in and top up to use paid models, or switch to another free model.",
      );
    case "free_daily_cap_reached":
      return tt("今日免费额度已用完（每人每天有额度上限）。升级会员即可继续，或明天再来。", "Today's free allowance is used up (daily cap per user). Upgrade to keep going, or come back tomorrow.");
    case "free_trial_disabled":
      return tt("免费体验暂时关闭，请登录后使用。", "Free trial is currently off. Please sign in.");
    case "anon_not_allowed":
    case "anon_login_required":
      return tt("该模型需登录后免费使用，请先登录。", "Sign in to use this model for free. Please log in first.");
    case "model_not_priced":
    case "unknown_hosted_model":
      return tt("该模型暂不可用，请换一个模型。", "This model is unavailable. Please pick another one.");
    default:
      return tt(`请求被网关拦下（${code || status}）。`, `Request blocked by gateway (${code || status}).`);
  }
}

// Claude Code 订阅版(OAuth) 请求时，服务端要求 system 首段是官方身份，否则拒绝。
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// —— 临时错误自动退避重试（429 限速 / 503 / 5xx / engine overloaded / 网络抖动）——
// 只在「开始读流之前」重试，故不会重复出字；并发撞限速会自己缓一下继续，不用手动重发。
function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15000) + Math.floor(Math.random() * 400);
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
// 客户端系统串（供无为网关做游客画像；只发给无为网关，不泄露给第三方厂商）。
const CLIENT_OS = (() => {
  try {
    const p = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : String(process.platform);
    const ver = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion?.() || "";
    return `${p} ${ver}`.trim();
  } catch {
    return process.platform || "";
  }
})();
async function fetchWithRetry(url: string, init: RequestInit, retries = 4): Promise<Response> {
  // 无为网关：带上 X-Client-OS，后台「用量记录」据此显示游客系统。
  if (CLIENT_OS && typeof url === "string" && /wuweiai\.io\/api\/gateway/.test(url)) {
    const h = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
    h.set("X-Client-OS", CLIENT_OS);
    init = { ...init, headers: h };
  }
  const signal = init.signal as AbortSignal | undefined;
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, init);
    } catch (e: any) {
      if (e?.name === "AbortError" || signal?.aborted || attempt >= retries) throw e;
      await sleep(backoffMs(attempt), signal); // 网络错误退避重试
      continue;
    }
    const transient = res.status === 429 || res.status === 503 || (res.status >= 500 && res.status < 600);
    if (transient && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20000) : backoffMs(attempt);
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      await sleep(wait, signal);
      continue;
    }
    return res;
  }
}

// ---------- Anthropic（同时支持 api-key 与订阅 OAuth）----------
class AnthropicProvider implements Provider {
  name = "anthropic";
  private client: Anthropic;
  private oauth: boolean;
  private lastHeaders?: Headers; // 每次响应头(用于解析订阅额度)
  constructor(private cfg: Config) {
    this.oauth = cfg.authMode === "oauth";
    // 自定义 fetch：截获响应头，供 complete 后解析订阅额度(anthropic-ratelimit-*)
    const capFetch = async (url: any, init?: any): Promise<Response> => {
      const res = await fetch(url, init);
      try {
        this.lastHeaders = res.headers;
      } catch {
        /* ignore */
      }
      return res;
    };
    if (this.oauth) {
      // 订阅 OAuth：Authorization: Bearer <token> + anthropic-beta:oauth；不带 x-api-key
      this.client = new Anthropic({
        authToken: cfg.oauthToken,
        baseURL: cfg.baseUrl,
        defaultHeaders: { "anthropic-beta": cfg.anthropicBeta },
        fetch: capFetch,
        maxRetries: 4, // 429/5xx 自动退避重试(并发撞限速更稳)
      });
    } else {
      this.client = new Anthropic({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl,
        fetch: capFetch,
        maxRetries: 4,
      });
    }
  }

  async complete(
    system: string,
    messages: Message[],
    tools: ToolSpec[],
    handlers: ProviderStreamHandlers,
  ): Promise<ProviderResult> {
    // —— prompt 缓存断点(Anthropic 需显式标记,否则一律不缓存、cache_read 恒为0) ——
    // 在 system 末块、tools 末项、历史末条各打一个 ephemeral 断点,缓存"系统提示+工具+历史"这段
    // 稳定前缀;下一步重发时命中缓存(读价约1/10),多步循环省下绝大部分输入。Claude Code 同款做法。
    // ttl:"1h" → 缓存活 1 小时(默认 ephemeral 只 5 分钟)。用户两轮之间思考几分钟,
    // 下一轮仍能命中缓存(读价约1/10),不必每轮重写。经真机验证:仅需请求体 ttl,无需额外 beta 头。
    const CC = { type: "ephemeral" as const, ttl: "1h" };
    // system 统一成 text-block 数组，末块打断点(空提示词不发空块,Anthropic 拒收→400)
    const sysBlocks: Anthropic.TextBlockParam[] = this.oauth
      ? [
          { type: "text", text: CLAUDE_CODE_IDENTITY },
          ...(system && system.trim() ? [{ type: "text", text: system } as Anthropic.TextBlockParam] : []),
        ]
      : system && system.trim()
        ? [{ type: "text", text: system }]
        : [];
    // cache_control 是 GA 特性但当前 SDK 类型未收录,运行时照发→用 any 赋值绕过类型
    if (sysBlocks.length) (sysBlocks[sysBlocks.length - 1] as any).cache_control = CC;
    const systemParam: string | Anthropic.TextBlockParam[] = sysBlocks.length ? sysBlocks : system;

    const toolParams = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    })) as Anthropic.Tool[];
    if (toolParams.length) (toolParams[toolParams.length - 1] as any).cache_control = CC;

    const msgParams = toAnthropicMessages(messages);
    // 历史末条(通常是 user/tool_result)的末块打断点:缓存到当前历史;下一步命中该前缀
    const lastMsg = msgParams[msgParams.length - 1];
    if (lastMsg && Array.isArray(lastMsg.content) && lastMsg.content.length) {
      (lastMsg.content[lastMsg.content.length - 1] as { cache_control?: typeof CC }).cache_control = CC;
    }

    const stream = this.client.messages.stream(
      {
        model: this.cfg.model,
        max_tokens: this.cfg.maxTokens,
        system: systemParam,
        messages: msgParams,
        tools: toolParams,
      },
      { signal: handlers.signal },
    );

    stream.on("text", (delta) => handlers.onText?.(delta));
    const final = await stream.finalMessage();

    const content: ContentBlock[] = [];
    for (const block of final.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use")
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
    }
    const stopReason =
      final.stop_reason === "tool_use"
        ? "tool_use"
        : final.stop_reason === "max_tokens"
          ? "max_tokens"
          : final.stop_reason === "end_turn"
            ? "end_turn"
            : "other";
    return {
      content,
      stopReason,
      usage: (() => {
        // Anthropic：input_tokens 不含缓存，缓存读/写另计；累加成"总输入"并拆出命中/新增
        const au: any = final.usage ?? {};
        const cacheRead = au.cache_read_input_tokens ?? 0;
        const cacheCreate = au.cache_creation_input_tokens ?? 0;
        const freshIn = au.input_tokens ?? 0;
        return {
          inputTokens: freshIn + cacheRead + cacheCreate,
          outputTokens: au.output_tokens ?? 0,
          cacheHitTokens: cacheRead,
          cacheMissTokens: freshIn + cacheCreate,
        };
      })(),
      rateLimits: this.oauth ? parseUnifiedRate(this.lastHeaders) : undefined,
    };
  }
}

// 解析 Claude 订阅(OAuth)响应头里的统一额度(账号级共享，和 Claude Code 同一池)
// 真实头(实测)：anthropic-ratelimit-unified-{5h,7d}-utilization=已用比例(0~1) / -reset=epoch 秒
function parseUnifiedRate(H?: Headers): ProviderResult["rateLimits"] | undefined {
  if (!H) return undefined;
  const usedPct = (k: string) => {
    const v = H.get(k);
    return v == null || v === "" ? undefined : Math.round(Number(v) * 100);
  };
  const resetSecs = (k: string) => {
    const v = H.get(k);
    if (!v) return undefined;
    const n = Number(v); // epoch 秒
    return Number.isNaN(n) ? undefined : Math.max(0, Math.round(n - Date.now() / 1000));
  };
  const p5 = usedPct("anthropic-ratelimit-unified-5h-utilization");
  const pw = usedPct("anthropic-ratelimit-unified-7d-utilization");
  if (p5 == null && pw == null) return undefined;
  return {
    primaryUsedPercent: p5,
    primaryWindowMinutes: 300,
    primaryResetAfterSeconds: resetSecs("anthropic-ratelimit-unified-5h-reset"),
    secondaryUsedPercent: pw,
    secondaryWindowMinutes: 7 * 24 * 60,
    secondaryResetAfterSeconds: resetSecs("anthropic-ratelimit-unified-7d-reset"),
  };
}

// ---------- OpenAI 兼容（本地模型/vLLM） ----------
class OpenAIProvider implements Provider {
  name = "openai";
  constructor(private cfg: Config) {}

  async complete(
    system: string,
    messages: Message[],
    tools: ToolSpec[],
    handlers: ProviderStreamHandlers,
  ): Promise<ProviderResult> {
    // 默认按「支持图片」发送，只有已知的纯文本模型才降级成 [图片] 占位。
    //
    // 之前是反过来的——白名单列多模态模型。但白名单漏一个的代价是「永久静默降级」：
    // 用户贴了图，这里判成非视觉 → 图片被换成「[图片]」文本发出去，模型只能回「我看不见图」，
    // 谁也想不到是客户端把图丢了（claude 就这么漏了很久，直连正常、走托管就瞎）。
    // 黑名单漏一个的代价只是「报一次 400」，看得见、补一条就好。
    // 何况现在新模型默认都是多模态，纯文本才是少数派，名单该维护少数派。
    // 已知纯文本（按各家官方文档核实过，2026-08）：
    //  · 智谱 GLM-4/GLM-5 非 v 版 —— 官方明确写「输入/输出模态：文本」；GLM-4v/4.6v 才是视觉版
    //  · DeepSeek 全系 —— 官方特性列表(Json Output/Tool Calls/FIM…)没有视觉，V3/R1 一贯纯文本；
    //    若哪天出了 deepseek-vl 之类，含 vl 会自动放行
    //  · Moonshot 老的 moonshot-v1-*k（Kimi K2.6 起支持图片，K3 官方写明「1M 上下文与视觉理解」，故不列入）
    // ⚠️这些模型收到图片不一定报错——GLM-5.2 实测是「收下然后没反应」，比报 400 更难排查，
    //    所以宁可保守列进来，也别让用户对着空白等半天。
    const NON_VISION =
      /deepseek(?!.*vl)|moonshot-v1-\d+k$|glm-[45](?!.*v)|qwen-?(max|plus|turbo)|embedding|\bbge\b/i;
    const vision =
      this.cfg.vision === true
        ? true // 强制开：自建端点模型名不含 vl 但其实支持
        : this.cfg.vision === false
          ? false // 强制关：黑名单没覆盖到的纯文本模型，用 MINICC_VISION=0 兜底
          : !NON_VISION.test(this.cfg.model);
    const oaMessages = toOpenAIMessages(system, messages, vision);
    // 某些自建 vLLM 未开 --enable-auto-tool-choice，一带 tools 就 400；可用 disableTools 退化为纯对话
    const noTools = this.cfg.disableTools === true;
    const oaTools = noTools
      ? []
      : tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const base = (this.cfg.baseUrl ?? "http://localhost:8000/v1").replace(/\/$/, "");
    // 小上下文模型(如 8192 窗口的本地 vLLM)：若输出上限≥窗口，会把上下文顶满导致输入没空间报400。
    // 此时不发 max_tokens，让服务端按 (窗口 - 输入) 自适应，绝不越界。
    const ctxWin = this.cfg.contextWindow || 0;
    const sendMaxTokens = ctxWin && this.cfg.maxTokens >= ctxWin ? undefined : this.cfg.maxTokens;
    const res = await fetchWithRetry(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: sendMaxTokens,
        messages: oaMessages,
        tools: oaTools.length ? oaTools : undefined,
        stream: true, // SSE 流式：文字实时逐字打印
        stream_options: { include_usage: true }, // 末尾块带 usage
        // 思考档位：OpenAI 系与 OpenRouter 都认 reasoning.effort；无为托管网关会把它翻成
        // Anthropic 的 output_config.effort。未选档位就不带该字段，用服务端默认。
        reasoning: this.cfg.effort ? { effort: this.cfg.effort } : undefined,
      }),
      signal: handlers.signal,
    });
    if (!res.ok || !res.body) {
      const rawBody = await res.text();
      // 无为托管网关：把结构化错误(余额不足/达上限等)翻成人话，别甩原始 JSON 给用户。第三方端点保持原样。
      const isWuweiGateway = base.includes("/api/gateway");
      if (isWuweiGateway) {
        const friendly = humanizeGatewayError(res.status, rawBody);
        if (friendly) throw new Error(friendly);
      }
      throw new Error(
        `${tt("OpenAI 兼容端点报错", "OpenAI-compatible endpoint error")} ${res.status}: ${rawBody}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    let sawTool = false;
    let reasoningOpen = false; // 推理模型的 reasoning_content 流：包成 <think>…</think> 让渲染统一折叠
    // 死循环熔断：模型陷入重复轰炸(如无限吐"card")或输出超长时立即停止，避免越积越多卡死界面。
    // 按「行」判定(而非单 chunk)，防 token 拆分绕过：同一短行连续第 3 行(=换行两次后)即判死循环。
    const MAX_STREAM_CHARS = 120_000;
    let lineBuf = ""; // 当前累积的行
    let lastLine = ""; // 上一完整行(去空)
    let lineRepeat = 0; // 与上一行相同的连续次数
    let truncated = false;
    const feedGuard = (chunk: string): boolean => {
      for (const ch of chunk) {
        if (ch === "\n") {
          const line = lineBuf.trim();
          if (line && line.length <= 24 && line === lastLine) {
            if (++lineRepeat >= 2) return true; // 连续第 3 行相同 → 死循环
          } else {
            lineRepeat = 0;
          }
          lastLine = line;
          lineBuf = "";
        } else {
          lineBuf += ch;
          if (lineBuf.length > 400) lineBuf = lineBuf.slice(-400); // 超长单行防爆
        }
      }
      return text.length > MAX_STREAM_CHARS;
    };
    // 截掉尾部连续重复的短行(把"card\ncard\ncard…"清成一个)，返回清理后的正文。
    const cleanRepeatTail = (t: string): string => {
      const lines = t.split("\n");
      let i = lines.length - 1;
      while (i > 0 && lines[i].trim() === "") i--; // 跳过末尾空行
      const unit = lines[i]?.trim() ?? "";
      if (!unit || unit.length > 24) return t;
      let j = i;
      while (j > 0 && lines[j - 1].trim() === unit) j--;
      if (i - j < 2) return t; // 不足 3 行重复，不动
      lines.splice(j, lines.length - j, unit); // 只保留一个
      return lines.join("\n");
    };
    const toolAcc: Record<number, { id?: string; name?: string; args: string }> = {};
    let usage: {
      inputTokens: number;
      outputTokens: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    } = { inputTokens: 0, outputTokens: 0 };

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") break outer;
        let j: any;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        if (j.usage) {
          const inTok = j.usage.prompt_tokens ?? 0;
          // 各家自动缓存的命中字段名不一,尽量都兼容:
          // DeepSeek=prompt_cache_hit_tokens;Kimi/智谱/通用=prompt_tokens_details.cached_tokens;
          // 少数放在 usage 顶层 cached_tokens。缺失则按全部未命中兜底。
          const hit =
            j.usage.prompt_cache_hit_tokens ??
            j.usage.prompt_tokens_details?.cached_tokens ??
            j.usage.cached_tokens;
          const cacheHit = typeof hit === "number" ? hit : 0;
          const cacheMiss =
            typeof j.usage.prompt_cache_miss_tokens === "number"
              ? j.usage.prompt_cache_miss_tokens
              : Math.max(0, inTok - cacheHit);
          usage = {
            inputTokens: inTok,
            outputTokens: j.usage.completion_tokens ?? 0,
            cacheHitTokens: cacheHit,
            cacheMissTokens: cacheMiss,
          };
        }
        const ch = j.choices?.[0];
        if (!ch) continue;
        const d = ch.delta ?? {};
        // 推理模型（GLM-Z1/4.7-Flash 等）的独立思考流：包进 <think>…</think>，与原生 <think> 归一，渲染端统一折叠
        const rc = (d as { reasoning_content?: unknown }).reasoning_content;
        if (typeof rc === "string" && rc) {
          if (!reasoningOpen) {
            reasoningOpen = true;
            text += "<think>";
            handlers.onText?.("<think>");
          }
          text += rc;
          handlers.onText?.(rc);
          if (feedGuard(rc)) { truncated = true; break outer; }
        }
        if (typeof d.content === "string" && d.content) {
          if (reasoningOpen) {
            reasoningOpen = false;
            text += "</think>\n";
            handlers.onText?.("</think>\n");
          }
          text += d.content;
          handlers.onText?.(d.content); // 逐块推给渲染进程
          if (feedGuard(d.content)) { truncated = true; break outer; }
        }
        for (const tc of d.tool_calls ?? []) {
          sawTool = true;
          const idx = tc.index ?? 0;
          const acc = (toolAcc[idx] ??= { args: "" });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }

    if (reasoningOpen) {
      // 仅有思考、没跟正文就结束（罕见）：补上闭合，避免 <think> 悬空
      reasoningOpen = false;
      text += "</think>\n";
      handlers.onText?.("</think>\n");
    }
    // 死循环熔断：取消底层读取(让模型停) + 清掉尾部重复串 + onRecover 替换已显示的脏内容 + 标注。
    if (truncated) {
      try { await reader.cancel(); } catch { /* ignore */ }
      const note = tt(
        "\n\n⚠️ 已自动停止：检测到模型在重复输出（可能陷入死循环）。请换个模型或重述需求。",
        "\n\n⚠️ Auto-stopped: the model kept repeating (possible loop). Try another model or rephrase.",
      );
      text = cleanRepeatTail(text) + note;
      handlers.onRecover?.(text); // 把界面上累积的重复串替换成清理后的正文
    }
    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    for (const idx of Object.keys(toolAcc).map(Number).sort((a, b) => a - b)) {
      const acc = toolAcc[idx];
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(acc.args || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: acc.id ?? `call_${idx}`,
        name: acc.name ?? "unknown",
        input,
      });
    }
    return { content, stopReason: sawTool ? "tool_use" : "end_turn", usage };
  }
}

// data:image/png;base64,xxx → { mediaType, data }
function parseDataUrl(d: string): { mediaType: string; data: string } {
  const m = d.match(/^data:([^;]+);base64,(.*)$/);
  return m ? { mediaType: m[1], data: m[2] } : { mediaType: "image/png", data: d };
}

// 统一 Message[] → Anthropic 格式（text/tool_use/tool_result 直通，image 转 base64 source）
// 铁律:每个块都复制一份新对象,绝不返回 this.messages 里的原始引用——否则 complete() 给"末块"
// 打 cache_control 会改到历史原对象、并被持久化,几轮累积后缓存断点数超过 Anthropic 上限(4)→400。
// 同时剥掉任何历史遗留的 cache_control(清掉已被旧版污染的存档),断点只由 complete() 每次新鲜添加。
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === "image") {
        const { mediaType, data } = parseDataUrl(b.dataUrl);
        return { type: "image", source: { type: "base64", media_type: mediaType, data } };
      }
      const { cache_control, ...rest } = b as Record<string, unknown>; // 剥掉遗留断点
      void cache_control;
      return { ...rest }; // 复制新对象,避免按引用改动污染历史
    }),
  })) as unknown as Anthropic.MessageParam[];
}

// 把统一 Message[] 转成 OpenAI chat 格式；vision=false 时图片转文本占位(纯文本模型不认 image_url)
function toOpenAIMessages(system: string, messages: Message[], vision: boolean): any[] {
  // system 为空时不发空的 system 消息（部分端点如 Kimi Code 会 400: system must not be empty）
  const out: any[] = system && system.trim() ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as any).text)
        .join("");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b: any) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const am: any = { role: "assistant", content: text || null };
      if (toolCalls.length) am.tool_calls = toolCalls;
      out.push(am);
    } else {
      // user：可能是纯文本、图片，或若干 tool_result
      const toolResults = m.content.filter((b) => b.type === "tool_result");
      if (toolResults.length) {
        for (const r of toolResults as any[]) {
          out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
        }
        const text = m.content
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) out.push({ role: "user", content: text });
      } else {
        const images = m.content.filter((b) => b.type === "image") as any[];
        const text = m.content
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (images.length && vision) {
          const parts: any[] = [];
          if (text) parts.push({ type: "text", text });
          for (const im of images) parts.push({ type: "image_url", image_url: { url: im.dataUrl } });
          out.push({ role: "user", content: parts });
        } else if (images.length) {
          // 纯文本模型：图片转占位文本，避免 image_url 报 400 卡死历史（占位词跟随界面语言，别给英文用户塞中文）
          const note = images.map(() => tt("[图片]", "[Image]")).join(" ");
          out.push({ role: "user", content: text ? `${text}\n${note}` : note });
        } else {
          out.push({ role: "user", content: text });
        }
      }
    }
  }
  return out;
}

// ---------- Codex 订阅版（ChatGPT 登录，Responses API）----------
// 真机验证要点：endpoint=chatgpt.com/backend-api/codex/responses；
// 头需 Authorization:Bearer + chatgpt-account-id + originator:codex_cli_rs；
// body 走 Responses 格式(input/instructions/扁平 tools)；model 用主线名 gpt-5.5。
class CodexProvider implements Provider {
  name = "codex";
  // 整个会话复用同一 session_id：让 Codex 后端把每步请求路由到 KV cache 还热着的同一实例，
  // 重发的上下文才能命中 prompt 缓存(便宜)。之前每请求 randomUUID → 每步换后端、缓存全冷 → 输入按新增算、消耗飞快。
  private readonly sessionId = randomUUID();
  constructor(private cfg: Config) {}

  async complete(
    system: string,
    messages: Message[],
    tools: ToolSpec[],
    handlers: ProviderStreamHandlers,
  ): Promise<ProviderResult> {
    const body = {
      model: this.cfg.model,
      instructions: system, // Responses 用 instructions 而非 system
      input: toResponsesInput(messages),
      tools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      reasoning: { effort: "medium" },
    };

    const res = await fetchWithRetry(this.cfg.codexEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.codexToken}`,
        "chatgpt-account-id": this.cfg.codexAccountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        session_id: this.sessionId, // 稳定不变→缓存亲和,重发上下文命中 prompt 缓存
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": "codex_cli_rs/0.0.0",
      },
      body: JSON.stringify(body),
      signal: handlers.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(
        `${tt("Codex 端点", "Codex endpoint")} ${res.status}: ${(await res.text()).slice(0, 400)}`,
      );
    }

    // 订阅额度：从响应头读取（primary=5小时窗口，secondary=周窗口）
    const H = res.headers;
    const numH = (k: string) => {
      const v = H.get(k);
      return v === null || v === "" ? undefined : Number(v);
    };
    const rateLimits = {
      planType: H.get("x-codex-plan-type") ?? undefined,
      primaryUsedPercent: numH("x-codex-primary-used-percent"),
      primaryWindowMinutes: numH("x-codex-primary-window-minutes"),
      primaryResetAfterSeconds: numH("x-codex-primary-reset-after-seconds"),
      secondaryUsedPercent: numH("x-codex-secondary-used-percent"),
      secondaryWindowMinutes: numH("x-codex-secondary-window-minutes"),
      secondaryResetAfterSeconds: numH("x-codex-secondary-reset-after-seconds"),
      creditsBalance: H.get("x-codex-credits-balance") || undefined,
      creditsUnlimited: H.get("x-codex-credits-unlimited") === "True",
    };

    // 解析 Responses SSE，累积文本与 function_call
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const content: ContentBlock[] = [];
    let curText = "";
    let usage: { inputTokens: number; outputTokens: number; cacheHitTokens?: number; cacheMissTokens?: number } = {
      inputTokens: 0,
      outputTokens: 0,
    };
    const toolCalls: { call_id: string; name: string; args: string }[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const block of parts) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let ev: any;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          if (ev.type === "response.output_text.delta" && ev.delta) {
            curText += ev.delta;
            handlers.onText?.(ev.delta);
          } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
            toolCalls.push({
              call_id: ev.item.call_id,
              name: ev.item.name,
              args: ev.item.arguments ?? "{}",
            });
          } else if (ev.type === "response.completed" && ev.response?.usage) {
            const cached = ev.response.usage.input_tokens_details?.cached_tokens ?? 0;
            const inTok = ev.response.usage.input_tokens ?? 0;
            usage = {
              inputTokens: inTok,
              outputTokens: ev.response.usage.output_tokens ?? 0,
              cacheHitTokens: cached, // 缓存命中(重复读上下文,便宜);Responses 的 input_tokens 已含缓存
              cacheMissTokens: Math.max(0, inTok - cached), // 真正新增的输入
            };
          } else if (ev.type === "error" || ev.type === "response.failed") {
            throw new Error(
              `${tt("Codex 流错误:", "Codex stream error:")} ${JSON.stringify(ev).slice(0, 300)}`,
            );
          }
        }
      }
    }

    if (curText) content.push({ type: "text", text: curText });
    for (const tc of toolCalls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.args);
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: tc.call_id, name: tc.name, input });
    }
    return { content, stopReason: toolCalls.length ? "tool_use" : "end_turn", usage, rateLimits };
  }
}

// 统一 Message[] → Responses input[]（tool_use→function_call，tool_result→function_call_output）
function toResponsesInput(messages: Message[]): any[] {
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text)
          input.push({ role: "assistant", content: [{ type: "output_text", text: b.text }] });
        else if (b.type === "tool_use")
          input.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input),
          });
      }
    } else {
      // user：文本 / 图片 / 工具结果
      for (const b of m.content) {
        if (b.type === "tool_result")
          input.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content });
        else if (b.type === "text" && b.text)
          input.push({ role: "user", content: [{ type: "input_text", text: b.text }] });
        else if (b.type === "image")
          input.push({ role: "user", content: [{ type: "input_image", image_url: b.dataUrl }] });
      }
    }
  }
  return input;
}

export function makeProvider(cfg: Config): Provider {
  if (cfg.provider === "codex") return new CodexProvider(cfg);
  return cfg.provider === "openai" ? new OpenAIProvider(cfg) : new AnthropicProvider(cfg);
}
