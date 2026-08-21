// Agent 主循环：Claude Code 的心脏。
//   组装消息 → 请求模型 → 若要调工具则执行并回灌 → 循环 → 直到模型给最终文字。
// P2：累计 token 用量 + 上下文过长时自动压缩（把旧历史总结成一段，保留最近若干条）。
import type {
  ContentBlock,
  Message,
  Provider,
  Tool,
  ToolContext,
} from "../types.js";

// 会显示给用户的文案跟随界面语言(WUWEI_LANG 由桌面端 applyEnvFromSettings 写入，CLI 侧同样可用)。
// ⚠ 必须在「调用时」求值，绝不能把 tt(...) 的结果存进模块顶层 const——那会在模块加载那刻把语言焊死，切语言不生效。
const tt = (zh: string, en: string) => (process.env.WUWEI_LANG === "en" ? en : zh);

export type PermissionDecision = "allow" | "deny";

export interface AgentOptions {
  compactThreshold?: number; // 上一轮 input tokens 超过此值触发压缩（0=关闭）
  keepRecent?: number; // 压缩时保留最近多少条原始消息
}

export interface SessionUsage {
  totalInput: number;
  totalOutput: number;
  lastInput: number; // 最近一次请求的输入 token，≈当前上下文大小
  totalCacheHit: number; // 累计缓存命中输入 token（算钱用）
  totalCacheMiss: number; // 累计缓存未命中输入 token
  totalSteps: number; // 累计模型请求次数（多步工具时每步一次；用于算"本轮步数"）
}

// 本轮(一次 send)自足的用量：每轮从 0 起累加，直接盖在助手消息上，
// 不靠跨轮累计做差 → 不受历史/跨版本污染，缓存命中与真正新增各自独立、单价能分开算。
export interface RoundUsage {
  input: number; // 本轮总输入(每步重发上下文累加)
  output: number; // 本轮总输出
  cacheHit: number; // 本轮缓存命中的输入 token（便宜）
  cacheMiss: number; // 本轮真正新增的输入 token（贵）
  steps: number; // 本轮模型请求次数
  lastInput: number; // 本轮最后一次请求的输入量(≈当前上下文)
}
// onUsage 上报的用量 = 会话累计 + 本轮自足值
export type UsageReport = SessionUsage & { round?: RoundUsage };

export interface AgentHooks {
  onText?(delta: string): void;
  requestPermission?(tool: Tool, input: Record<string, unknown>): Promise<PermissionDecision>;
  onToolStart?(id: string, name: string, input: Record<string, unknown>): void;
  onToolEnd?(id: string, result: string, isError: boolean): void;
  onAssistantDone?(): void;
  onUsage?(u: UsageReport): void; // 每步回报累计用量 + 本轮自足值
  onRateLimits?(rl: import("../types.js").RateLimits): void; // 订阅额度快照
  onCompact?(before: number, after: number): void; // 压缩发生时回报条数变化
  onCompactArchive?(dropped: Message[]): void; // 压缩前把将被丢弃的原始消息交出去，供上层归档(永不压缩的完整日志)
  onStep?(): void; // 每完成一段(助手消息/工具结果)后回调：用于即时落盘，重启不丢进度
  onRecover?(cleanedText: string): void; // 模型把工具调用当文本吐出→兜底解析后，回传清理后的正文供前端修正显示
}

// 去掉落单的短英文噪音文本块(如 "count")：模型偶发把杂词和工具调用一起吐出。
// 只删「纯 1-15 个英文字母、无空格无标点无中文」的独立文本块，正常正文(含中文/标点/空格)不动。
function stripStrayText(content: ContentBlock[]): ContentBlock[] {
  const kept = content.filter(
    (b) => !(b.type === "text" && /^[A-Za-z]{1,15}$/.test(((b as any).text || "").trim())),
  );
  return kept.length === content.length ? content : kept;
}

// 兜底：模型偶尔把工具调用写成文本(<invoke name="x"><parameter name="y">…</parameter></invoke>)，
// 导致没有结构化 tool_use → 循环判定"结束"而自动停止，且屏上留一堆 XML 符号。
// 这里把这种泄漏的调用解析回来，转成真正的 tool_use 去执行，并给出去掉 XML 的干净正文。
function recoverLeakedToolCalls(
  content: ContentBlock[],
): { toolUses: Extract<ContentBlock, { type: "tool_use" }>[]; newContent: ContentBlock[] } | null {
  const text = content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  if (!/<(?:antml:)?invoke\s+name=/.test(text)) return null;
  const invokeRe = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g;
  const toolUses: any[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = invokeRe.exec(text))) {
    const name = m[1];
    const inner = m[2];
    const input: Record<string, unknown> = {};
    const paramRe = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g;
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(inner))) {
      const key = p[1];
      const t = String(p[2]).trim();
      let val: unknown = p[2];
      if (/^-?\d+(\.\d+)?$/.test(t)) val = Number(t);
      else if (t === "true" || t === "false") val = t === "true";
      else if (/^[[{]/.test(t)) {
        try {
          val = JSON.parse(t);
        } catch {
          /* 保留原字符串 */
        }
      }
      input[key] = val;
    }
    toolUses.push({ type: "tool_use", id: `leak_${Date.now()}_${i++}`, name, input });
  }
  if (!toolUses.length) return null;
  const cleanedText = text
    .replace(/<(?:antml:)?function_calls>[\s\S]*?<\/(?:antml:)?function_calls>/g, "")
    .replace(/<(?:antml:)?invoke\s+name="[^"]+"\s*>[\s\S]*?<\/(?:antml:)?invoke>/g, "")
    .trim();
  const newContent: ContentBlock[] = [];
  if (cleanedText) newContent.push({ type: "text", text: cleanedText } as ContentBlock);
  newContent.push(...(toolUses as ContentBlock[]));
  return { toolUses: toolUses as any, newContent };
}

export class Agent {
  private messages: Message[] = [];
  private usage: SessionUsage = {
    totalInput: 0,
    totalOutput: 0,
    lastInput: 0,
    totalCacheHit: 0,
    totalCacheMiss: 0,
    totalSteps: 0,
  };
  private compactThreshold: number;
  private keepRecent: number;
  private pendingInject: { text: string; images: string[] }[] = []; // 运行中注入的新需求，循环边界取用
  private round: RoundUsage = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, steps: 0, lastInput: 0 }; // 本轮自足用量
  private softStop = false; // 温和停止:不切断当前输出，让本轮自然吐完并干净落历史后，在下个边界停

  constructor(
    private provider: Provider,
    private system: string,
    private tools: Tool[],
    private ctx: ToolContext,
    private toolMap: Map<string, Tool>,
    opts: AgentOptions = {},
  ) {
    this.compactThreshold = opts.compactThreshold ?? 60000;
    this.keepRecent = opts.keepRecent ?? 6;
  }

  // 温和停止:不 abort 当前模型流，让它把这轮自然吐完、完整落历史后，在下个循环边界干净停下。
  // 与 abort(硬中断)分开:硬中断会截断输出、留悬空 tool_use 需事后补 (已停止) 补丁；软停止不会。
  requestSoftStop() {
    this.softStop = true;
  }
  isSoftStopping(): boolean {
    return this.softStop;
  }

  // 收尾:把当前(已完整生成的)助手消息里想调的工具剥掉，只保留已写完的正文，
  // 让历史干净停在一条「完整的助手消息」上——不切断、不留截断疤，下次发消息无缝接续。
  private finishSoftStop(hooks: AgentHooks): void {
    this.pendingInject = []; // 停止即停干净:丢掉还没并入的注入消息，避免下一轮乱序冒出来
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") {
      const kept = last.content.filter((b) => b.type !== "tool_use");
      const hadToolUse = kept.length !== last.content.length;
      const hasText = kept.some((b) => b.type === "text" && ((b as any).text || "").trim());
      this.messages[this.messages.length - 1] = {
        role: "assistant",
        // 占位符跟随界面语言，且字面量与 desktop/main/sessions.ts 修复历史时注入的完全一致(半角括号)，两边才对得上
        content: hasText ? kept : [{ type: "text", text: tt("(已停止)", "(stopped)") }], // 极少数「纯工具无正文」才占位，但这是完整边界非截断
        ts: last.ts,
        usage: last.usage,
      };
      // 刚剥掉半截工具调用 → 通知前端把它从屏上抹掉，只留正文
      if (hadToolUse) {
        const t = (hasText ? kept : [])
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        hooks.onRecover?.(t);
      }
    }
    hooks.onStep?.();
    hooks.onAssistantDone?.();
  }

  // 运行中注入新需求：不打断当前步，在下一个循环边界并入历史，让模型综合权衡/优先处理
  injectUser(text: string, images: string[] = []) {
    if ((text && text.trim()) || images.length) this.pendingInject.push({ text, images });
  }
  private drainInject(): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    for (const p of this.pendingInject) {
      if (p.text && p.text.trim()) blocks.push({ type: "text", text: p.text });
      for (const im of p.images) blocks.push({ type: "image", dataUrl: im });
    }
    this.pendingInject = [];
    return blocks;
  }
  hasPendingInject(): boolean {
    return this.pendingInject.length > 0;
  }
  // 撤回一条尚未处理的注入消息(还在缓冲里)：命中返回 true，AI 从未看到它
  recallPendingInject(text: string): boolean {
    const i = this.pendingInject.findIndex((p) => p.text === text);
    if (i >= 0) {
      this.pendingInject.splice(i, 1);
      return true;
    }
    return false;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  // 供 UI 显示用：正式历史 + 尚未并入历史的注入消息(还在 pendingInject 缓冲里)。
  // 修复「运行中发的消息切走再切回就不见了」——切回时用正式历史整体重建，pending 注入还没 drain 进历史故被抹掉。
  // 只影响显示，不动 getMessages()(模型历史/标题/建议仍用它)。drain 后 pendingInject 清空，下次重建走正式历史，不重复。
  getDisplayMessages(): Message[] {
    if (this.pendingInject.length === 0) return this.messages;
    const pend: Message[] = this.pendingInject
      .filter((p) => (p.text && p.text.trim()) || p.images.length)
      .map((p) => ({
        role: "user" as const,
        content: [
          ...(p.text && p.text.trim() ? [{ type: "text", text: p.text } as ContentBlock] : []),
          ...p.images.map((im) => ({ type: "image", dataUrl: im }) as ContentBlock),
        ],
        ts: Date.now(),
      }));
    return [...this.messages, ...pend];
  }

  // 载入已保存的会话历史（切换/恢复会话时用）
  setMessages(msgs: Message[]): void {
    this.messages = msgs;
  }

  // 运行时切换模型后端（用户在设置里改 provider/model）
  setProvider(p: Provider): void {
    this.provider = p;
  }

  setSystem(s: string): void {
    this.system = s;
  }

  // 运行时更新工具集（如 MCP 服务器连接后动态加入其工具）
  setTools(tools: Tool[], toolMap: Map<string, Tool>): void {
    this.tools = tools;
    this.toolMap = toolMap;
  }

  // 运行时调整压缩参数(设置里改"保留最近N条"/阈值时热更)
  setCompactOpts(opts: { compactThreshold?: number; keepRecent?: number }): void {
    if (typeof opts.compactThreshold === "number") this.compactThreshold = opts.compactThreshold;
    if (typeof opts.keepRecent === "number" && opts.keepRecent > 0) this.keepRecent = opts.keepRecent;
  }

  getUsage(): SessionUsage {
    return this.usage;
  }

  setUsage(u: SessionUsage): void {
    // 兼容旧会话存档（无缓存明细字段）
    this.usage = {
      ...u,
      totalCacheHit: u.totalCacheHit ?? 0,
      totalCacheMiss: u.totalCacheMiss ?? 0,
      totalSteps: u.totalSteps ?? 0,
    };
  }

  async send(
    userInput: string,
    hooks: AgentHooks,
    signal?: AbortSignal,
    images?: string[],
  ): Promise<void> {
    const userContent: ContentBlock[] = [];
    if (userInput) userContent.push({ type: "text", text: userInput });
    for (const dataUrl of images ?? []) userContent.push({ type: "image", dataUrl });
    if (userContent.length === 0) return;
    this.ensureCanAcceptUser(); // 上一轮若被中断,先修好历史尾部,避免连续user/悬空tool_use致API 400
    this.messages.push({ role: "user", content: userContent, ts: Date.now() });
    this.round = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, steps: 0, lastInput: 0 }; // 本轮清零重记
    this.softStop = false; // 新一轮开始，清掉上一轮可能残留的软停止标志

    while (true) {
      if (signal?.aborted) return; // 已被用户硬中断(abort)
      // 温和停止:上一步(工具结果/助手)已干净入历史。若尾部是 user(tool_result)，补一条完整助手收尾，
      // 让历史停在助手消息上(完整边界，非截断)，下次发消息无缝接续，且不再触发新的模型请求。
      if (this.softStop) {
        this.pendingInject = []; // 停止即停干净:丢掉还没并入的注入消息
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === "user") {
          // 同上：与 sessions.ts 的占位字面量保持一致，并跟随界面语言
          this.messages.push({ role: "assistant", content: [{ type: "text", text: tt("(已停止)", "(stopped)") }], ts: Date.now() });
          hooks.onStep?.();
        }
        hooks.onAssistantDone?.();
        return;
      }
      // 上下文过长则先压缩，再请求模型（省 token / 防撑爆）
      await this.maybeCompact(hooks);

      const result = await this.provider.complete(this.system, this.messages, this.tools, {
        onText: hooks.onText,
        signal,
      });

      this.usage.totalSteps += 1; // 每次模型请求算一步(不管有没有返回 usage)
      this.round.steps += 1;
      if (result.usage) {
        const inTok = result.usage.inputTokens;
        const hit = result.usage.cacheHitTokens ?? 0;
        const miss = result.usage.cacheMissTokens ?? Math.max(0, inTok - hit);
        // 累计(给"当前上下文"/费用总览/持久化恢复)
        this.usage.totalInput += inTok;
        this.usage.totalOutput += result.usage.outputTokens;
        this.usage.lastInput = inTok;
        this.usage.totalCacheHit += hit;
        this.usage.totalCacheMiss += miss;
        // 本轮自足(每步各自独立累加,缓存命中/新增互不串)
        this.round.input += inTok;
        this.round.output += result.usage.outputTokens;
        this.round.cacheHit += hit;
        this.round.cacheMiss += miss;
        this.round.lastInput = inTok;
      }
      const snap: UsageReport = { ...this.usage, round: { ...this.round } };
      hooks.onUsage?.(snap); // 每步都上报(即使无 usage 也让步数实时刷新)
      if (result.rateLimits) hooks.onRateLimits?.(result.rateLimits);

      // 盖上用量快照(累计 + 本轮自足值)：UI 直接读本轮值,不靠跨轮做差;并存进历史供重开后仍可看
      this.messages.push({
        role: "assistant",
        content: result.content,
        ts: Date.now(),
        usage: {
          totalInput: this.usage.totalInput,
          totalOutput: this.usage.totalOutput,
          lastInput: this.usage.lastInput,
          totalCacheHit: this.usage.totalCacheHit,
          totalCacheMiss: this.usage.totalCacheMiss,
          totalSteps: this.usage.totalSteps,
          round: { ...this.round },
        },
      });
      hooks.onStep?.(); // 助手段落已入历史，即时落盘(重启不丢)

      let toolUses = result.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      let finalContent: ContentBlock[] = result.content;

      // 兜底1：没有结构化 tool_use 时，看是否把工具调用当文本写出来了(<invoke …>)，是则解析回来执行、继续跑
      if (toolUses.length === 0) {
        const recovered = recoverLeakedToolCalls(result.content);
        if (recovered) {
          toolUses = recovered.toolUses;
          finalContent = recovered.newContent;
        }
      }
      // 兜底2：有工具调用时，去掉像 "count" 这种落单短英文噪音文本块(模型偶发把杂词跟工具调用一起吐出)
      if (toolUses.length > 0) finalContent = stripStrayText(finalContent);

      // 内容被清理过 → 替换历史里那条 + 通知前端修正屏上显示
      if (finalContent !== result.content) {
        this.messages[this.messages.length - 1] = {
          role: "assistant",
          content: finalContent,
          ts: Date.now(),
        };
        const t = finalContent
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        hooks.onRecover?.(t);
      }

      // 温和停止检查点:此刻这轮模型已「完整」生成并入历史(不是被截断的半截)。
      // 剥掉它接下来想调的工具、保留已写完的正文，干净停在一条完整助手消息上就返回——
      // 既让 AI 把话说完，又不再执行新动作/发新请求，历史尾部合法，下次无缝接续。
      if (this.softStop) {
        this.finishSoftStop(hooks);
        return;
      }

      if (toolUses.length === 0) {
        // 助手已给出无工具的回复：若期间用户注入了新需求，接着处理它(不结束本回合)
        const inj = this.drainInject();
        if (inj.length) {
          this.messages.push({ role: "user", content: inj, ts: Date.now() });
          continue;
        }
        hooks.onAssistantDone?.();
        return;
      }

      // 结果按原顺序回填(并行也不乱序)；只读工具并行跑，写类工具串行(防写竞态/保权限提示有序)
      const resultsBlocks: ContentBlock[] = new Array(toolUses.length);
      const parallelJobs: Promise<void>[] = [];
      for (let idx = 0; idx < toolUses.length; idx++) {
        const call = toolUses[idx];
        const tool = this.toolMap.get(call.name);
        if (!tool) {
          resultsBlocks[idx] = {
            type: "tool_result",
            tool_use_id: call.id,
            content: tt(`未知工具: ${call.name}`, `Unknown tool: ${call.name}`), // 会显示在工具卡片里，跟随界面语言
            is_error: true,
          };
          continue;
        }
        // 已中断：不再启动新工具，直接填占位结果(仍保证每个 tool_use 都有配对 tool_result)
        if (signal?.aborted) {
          resultsBlocks[idx] = {
            type: "tool_result",
            tool_use_id: call.id,
            content: tt("(已停止)", "(stopped)"), // 会显示在工具卡片里，跟随界面语言
            is_error: true,
          };
          continue;
        }

        if (!tool.readOnly && hooks.requestPermission) {
          const decision = await hooks.requestPermission(tool, call.input);
          if (decision === "deny") {
            resultsBlocks[idx] = {
              type: "tool_result",
              tool_use_id: call.id,
              content: tt("用户拒绝了该操作。", "The user denied this action."), // 手动模式下高频出现，跟随界面语言
              is_error: true,
            };
            continue;
          }
        }

        const job = (async () => {
          hooks.onToolStart?.(call.id, call.name, call.input);
          const out = await tool.run(call.input, { ...this.ctx, signal }); // 传中断信号,停止时杀长命令
          hooks.onToolEnd?.(call.id, out.content, !!out.isError);
          resultsBlocks[idx] = {
            type: "tool_result",
            tool_use_id: call.id,
            content: out.content,
            is_error: out.isError,
          };
        })();
        if (tool.readOnly) parallelJobs.push(job); // 只读：并行
        else await job; // 写类：等它跑完再继续下一个，串行执行
      }
      await Promise.all(parallelJobs); // 等所有并行只读工具收齐
      // 兜底：任何漏填的位补上占位结果，确保 tool_use↔tool_result 一一配对(否则下次请求 400)
      for (let idx = 0; idx < toolUses.length; idx++) {
        if (!resultsBlocks[idx]) {
          resultsBlocks[idx] = {
            type: "tool_result",
            tool_use_id: toolUses[idx].id,
            content: tt("(已停止)", "(stopped)"),
            is_error: true,
          };
        }
      }

      // 运行中注入的新需求：并入本条 user 消息(tool_result + 文本/图片)，下一步模型即可看到并综合安排
      const inj = this.drainInject();
      if (inj.length) resultsBlocks.push(...inj);
      this.messages.push({ role: "user", content: resultsBlocks });
      hooks.onStep?.(); // 工具结果已入历史，即时落盘
      if (signal?.aborted) return; // 中断：tool_result 已入队(历史合法)，就此结束
    }
  }

  // 生成「工作交接文档」：把本会话历史里真正有价值的内容(目标/决策/涉及的文件命令参数机器/
  // 已完成/当前进展/未完成/下一步/坑)提炼成一份结构化中文文档，明确剔除跑题与噪音。
  // 用途：老对话上下文被污染/太长时，一键交接到一个干净的新对话接着做。用本会话自己的模型来总结。
  async makeHandoff(): Promise<string> {
    const msgs = [...this.messages]; // 快照:即使源会话还在跑，也按当下这份历史来总结，不受后续 mutate 影响
    let transcript = msgs
      .map((m) => {
        const parts = (m.content || [])
          .map((b: any) => {
            if (b.type === "text") return b.text;
            // 摘录标签也跟随界面语言：喂给模型的原文全英，产出的英文摘要/交接文档才不会中英夹杂
            if (b.type === "tool_use")
              return tt(
                `[调用 ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`,
                `[call ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`,
              );
            if (b.type === "tool_result")
              return tt(
                `[结果: ${String(b.content).slice(0, 500)}]`,
                `[result: ${String(b.content).slice(0, 500)}]`,
              );
            if (b.type === "image") return tt("[图片]", "[image]");
            return "";
          })
          .filter(Boolean)
          .join("\n");
        return parts
          ? tt(`${m.role === "user" ? "用户" : "助手"}：${parts}`, `${m.role === "user" ? "User" : "Assistant"}: ${parts}`)
          : "";
      })
      .filter((s) => s.length > 3)
      .join("\n\n");
    if (!transcript.trim()) return "";
    // 太长则掐头留尾(目标通常在开头、最新进展在结尾)，防喂给模型时超上下文
    const MAX = 80000;
    if (transcript.length > MAX) {
      transcript =
        transcript.slice(0, 6000) +
        tt("\n\n…(中间大段略去)…\n\n", "\n\n…(large middle section omitted)…\n\n") +
        transcript.slice(-(MAX - 6000));
    }
    // 交接文档正文整篇会作为新会话的第一条消息显示给用户 → 必须跟随界面语言(中英各小节一一对应)
    const res = await this.provider.complete(
      tt(
        "你是「工作交接文档」整理器。下面是一段可能很长、甚至跑题或被无关内容污染的工作对话。" +
          "请只抽取真正有价值的信息，产出一份结构清晰的中文交接文档，让接手者(另一个 AI 助手)不看原对话也能直接继续干活。" +
          "务必分节输出：\n" +
          "1) 目标/任务：用户到底要做什么；\n" +
          "2) 关键背景与决策：涉及的项目/仓库/机器/服务/文件路径/命令/参数/配置，已敲定的方案及理由；\n" +
          "3) 已完成：具体做了什么、改了哪些文件、验证结果；\n" +
          "4) 当前进展 / 未完成：正卡在哪、还差什么；\n" +
          "5) 下一步：接手者应立刻执行的具体动作(有序列出)；\n" +
          "6) 坑与注意事项：踩过的坑、红线、易错点。\n" +
          "要求：条目式、带具体名字(别泛泛而谈)、剔除跑题闲聊与噪音、不要复述无关内容。只输出交接文档本身。",
        "You turn messy work sessions into a handoff document. Below is a work conversation that may be very long, " +
          "off-topic, or polluted with unrelated content. Pull out only what actually matters and write a clearly " +
          "structured handoff document **in English**, so whoever picks this up (another AI assistant) can keep working " +
          "without ever reading the original conversation. " +
          "You must output these sections:\n" +
          "1) Goal / task: what the user is actually trying to get done;\n" +
          "2) Key context & decisions: the projects/repos/machines/services/file paths/commands/flags/config involved, " +
          "plus what has already been decided and why;\n" +
          "3) Done: what was actually built or changed, which files, and how it was verified;\n" +
          "4) Current state / not done: where it is stuck, what is still missing;\n" +
          "5) Next steps: the concrete actions whoever takes over should run right now (numbered, in order);\n" +
          "6) Gotchas & warnings: traps already hit, hard limits, easy mistakes.\n" +
          "Rules: use bullet points, name real things (no vague hand-waving), drop the off-topic chatter and noise, " +
          "don't restate anything irrelevant. Output only the handoff document itself.",
      ),
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: tt(
                `工作对话原文：\n${transcript}\n\n请输出交接文档：`,
                `Raw conversation:\n${transcript}\n\nNow write the handoff document:`,
              ),
            },
          ],
        },
      ],
      [],
      {},
    );
    return res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
  }

  // 让历史能安全接受新的 user 消息：修好上一轮中断残留的尾部，避免连续 user / 悬空 tool_use 致 API 400
  private ensureCanAcceptUser(): void {
    const last = this.messages[this.messages.length - 1];
    if (!last) return;
    if (last.role === "assistant") {
      // 悬空 tool_use(没配对 tool_result 会 400)→ 只剥掉 tool_use 块，保留已写的文字，别把整段回复丢了
      const hasToolUse = last.content.some((b) => b.type === "tool_use");
      if (hasToolUse) {
        const keptText = last.content.filter((b) => b.type === "text" && (b as any).text?.trim());
        this.messages[this.messages.length - 1] = {
          role: "assistant",
          content: keptText.length ? keptText : [{ type: "text", text: tt("(已停止)", "(stopped)") }],
        };
      }
      return;
    }
    // 末尾是 user(被中断未应答 / tool_result 结尾)→ 补一条占位 assistant 维持 user/assistant 交替
    this.messages.push({ role: "assistant", content: [{ type: "text", text: tt("(已停止)", "(stopped)") }] });
  }

  // —— 上下文压缩 ——
  private async maybeCompact(hooks: AgentHooks): Promise<void> {
    if (this.compactThreshold <= 0) return;
    if (this.usage.lastInput < this.compactThreshold) return;
    if (this.messages.length <= this.keepRecent + 1) return;

    const cut = this.findCutIndex();
    if (cut <= 0) return; // 找不到安全切点则不压

    const older = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);
    const before = this.messages.length;

    // 把旧历史摊平成文本摘录(含工具调用/结果的要点)，作为单条 user 消息去总结——
    // 比直接把原始消息(可能含未配对工具块)喂给模型稳得多，也更信息量足。
    const transcript = older
      .map((m) => {
        const parts = (m.content || [])
          .map((b: any) => {
            if (b.type === "text") return b.text;
            // 摘录标签也跟随界面语言：喂给模型的原文全英，产出的英文摘要/交接文档才不会中英夹杂
            if (b.type === "tool_use")
              return tt(
                `[调用 ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`,
                `[call ${b.name}: ${JSON.stringify(b.input).slice(0, 300)}]`,
              );
            if (b.type === "tool_result")
              return tt(
                `[结果: ${String(b.content).slice(0, 500)}]`,
                `[result: ${String(b.content).slice(0, 500)}]`,
              );
            if (b.type === "image") return tt("[图片]", "[image]");
            return "";
          })
          .filter(Boolean)
          .join("\n");
        return parts
          ? tt(`${m.role === "user" ? "用户" : "助手"}：${parts}`, `${m.role === "user" ? "User" : "Assistant"}: ${parts}`)
          : "";
      })
      .filter((s) => s.length > 3)
      .join("\n\n");

    let summaryText = "";
    try {
      // 摘要会在会话切换/重启后作为一条用户消息重新显示 → 跟随界面语言
      const res = await this.provider.complete(
        tt(
          "你是对话摘要器。把下面这段对话历史压缩成简洁但具体的中文要点摘要，务必保留：用户目标、" +
            "已完成的关键操作、涉及的文件/命令/参数/机器、关键结论与数据、当前进展、未决事项与下一步。" +
            "条列式，带上具体名字(别泛泛而谈)。只输出摘要本身。",
          "You are a conversation summarizer. Compress the conversation history below into a short but specific " +
            "bullet-point summary **in English**. You must keep: the user's goal, the key actions already taken, " +
            "the files/commands/flags/machines involved, key conclusions and numbers, where things stand now, " +
            "open questions and next steps. Use bullets and name real things (no vague hand-waving). " +
            "Output only the summary itself.",
        ),
        [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: tt(
                  `对话历史：\n${transcript}\n\n请输出要点摘要：`,
                  `Conversation history:\n${transcript}\n\nNow write the bullet-point summary:`,
                ),
              },
            ],
          },
        ],
        [],
        {},
      );
      if (res.usage) {
        this.usage.totalInput += res.usage.inputTokens;
        this.usage.totalOutput += res.usage.outputTokens;
        this.usage.totalCacheHit += res.usage.cacheHitTokens ?? 0;
        this.usage.totalCacheMiss +=
          res.usage.cacheMissTokens ??
          Math.max(0, res.usage.inputTokens - (res.usage.cacheHitTokens ?? 0));
      }
      summaryText = res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
    } catch {
      summaryText = ""; // 生成失败 → 下面直接放弃本次压缩，绝不丢历史
    }

    // ⚠ 摘要为空/失败：宁可不压、也不能把历史丢成空摘要(否则 AI 直接失忆)
    if (!summaryText) return;

    // 归档：把这批将被摘要顶替的原始消息交给上层写进"永不压缩的完整日志"。
    // 排除之前压缩生成的摘要消息本身(它不是真实对话，且它顶替的原始消息早已归档过)，避免重复。
    try {
      const isSummary = (m: Message) =>
        (m.content || []).some(
          (b: any) => b.type === "text" && /^【之前对话摘要】|^\[Summary of earlier conversation\]/.test(String(b.text || "").trim()),
        );
      const droppedReal = older.filter((m) => !isSummary(m));
      if (droppedReal.length) hooks.onCompactArchive?.(droppedReal);
    } catch { /* 归档失败绝不影响压缩主流程 */ }

    this.messages = [
      // 这条会被原样渲染成一条用户消息 → 标题跟随界面语言
      {
        role: "user",
        content: [
          {
            type: "text",
            text: tt(`【之前对话摘要】\n${summaryText}`, `[Summary of earlier conversation]\n${summaryText}`),
          },
        ],
      },
      ...recent,
    ];
    // 压缩后当前上下文变小，重置 lastInput 让下轮重新度量
    this.usage.lastInput = 0;
    hooks.onCompact?.(before, this.messages.length);
  }

  // 找安全切点：从"倒数第 keepRecent 条"往前找最近的"真正用户输入"边界，
  // 保证保留 >= keepRecent 条最近消息(不会像以前往后找越留越少)，且不拆散 tool_use/tool_result。
  private findCutIndex(): number {
    const target = Math.min(this.messages.length - this.keepRecent, this.messages.length - 1);
    for (let i = target; i >= 1; i--) {
      const m = this.messages[i];
      if (m.role === "user" && m.content.every((b) => b.type === "text")) return i;
    }
    return -1; // 前面没有干净的用户边界(极少)，放弃本次压缩
  }
}
