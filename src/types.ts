// minicc 核心类型定义
// 这里刻意贴近 Anthropic Messages API 的消息模型（复刻 Claude Code 的底层语义）：
// 一条对话由 messages 组成；助手可能回文本，也可能回 tool_use；
// 我们本地执行工具后，把 tool_result 作为一条 user 消息塞回，继续循环。

export type Role = "user" | "assistant";

// 消息内容块：文本 / 模型要调工具 / 我们回给模型的工具结果
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string } // 用户发送的图片（data:image/...;base64,xxx）
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: Role;
  content: ContentBlock[];
  ts?: number; // 本地时间戳(仅持久化/展示"多久之前"，toAnthropic/toOpenAI 会剥掉不发给 API)
  // 累计用量快照(仅盖在助手消息上，供 UI 算"本轮 token"=本轮末累计−上轮末累计；不发给 API)
  usage?: { totalInput: number; totalOutput: number; lastInput: number };
}

// 一个工具 = 给模型看的 schema + 本地执行函数
export interface ToolSpec {
  name: string;
  description: string;
  // JSON Schema（Anthropic tools 的 input_schema 格式）
  inputSchema: Record<string, unknown>;
  // 只读工具可并行；有状态工具（Write/Edit/Bash）需串行确认
  readOnly: boolean;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal; // 中断信号：用户停止时传入，长命令(bash/grep)据此杀子进程
  env?: Record<string, string>; // 本地密钥注入(仅本机子进程可见，模型看不到)：bash 工具据此合并环境变量
  sessionId?: string; // 执行该工具的会话 id：ask_user 据此把选择框/通知绑到正确的会话(多会话并发时不串)
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool extends ToolSpec {
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// Provider 抽象：一次"请求模型 → 拿到助手回复（文本增量 + 可能的 tool_use）"
export interface ProviderStreamHandlers {
  onText?: (delta: string) => void; // 文本流式增量
  signal?: AbortSignal; // 中断信号：用户点停止时 abort，provider 传给 fetch/stream
}

export interface TokenUsage {
  inputTokens: number; // 本次请求的输入 token（≈当前上下文总大小）
  outputTokens: number;
  cacheHitTokens?: number; // 缓存命中的输入 token（便宜很多；DeepSeek 等返回）
  cacheMissTokens?: number; // 缓存未命中的输入 token
}

// 订阅额度快照（Codex 在 /responses 响应头返回；primary=5小时窗口，secondary=周窗口）
export interface RateLimits {
  planType?: string;
  primaryUsedPercent?: number;
  primaryWindowMinutes?: number;
  primaryResetAfterSeconds?: number;
  secondaryUsedPercent?: number;
  secondaryWindowMinutes?: number;
  secondaryResetAfterSeconds?: number;
  creditsBalance?: string;
  creditsUnlimited?: boolean;
}

export interface ProviderResult {
  // 助手这一轮产出的完整内容块（文本 + tool_use）
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage?: TokenUsage;
  rateLimits?: RateLimits;
}

export interface Provider {
  name: string;
  complete(
    system: string,
    messages: Message[],
    tools: ToolSpec[],
    handlers: ProviderStreamHandlers,
  ): Promise<ProviderResult>;
}
