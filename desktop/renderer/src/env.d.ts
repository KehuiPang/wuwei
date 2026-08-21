// 渲染进程可见的 window.wuwei 类型（来自 preload）
import type { WuweiMe, CatalogProviderDto } from "../../main/wuwei-auth.js";

export interface BrainNodeLite {
  id: string;
  name: string;
  aliases: string[];
  type: string;
  summary: string;
  attrs: Record<string, string>;
  weight: number;
  hits: number;
  createdAt: number;
  updatedAt: number;
  lastHit?: number;
}
export interface BrainEdgeLite {
  id: string;
  from: string;
  to: string;
  relation: string;
  weight: number;
  hits: number;
}
export interface TrashItem {
  id: string;
  title: string;
  updatedAt: number;
  deletedAt: number;
  group?: string;
}

// 全局搜索命中：一条摘要 + 定位锚点（前端据此切会话并滚到那条消息）
export interface SearchHit {
  sid: string;
  title: string;
  updatedAt: number;
  role: "user" | "assistant" | "title";
  mi: number; // 消息序号（标题命中为 -1）
  anchor: string; // "<消息序号>:u" / "<消息序号>:<块序号>"；标题命中为空
  pre: string;
  match: string;
  post: string;
  more: number; // 同一条消息里还有多少处匹配
}
export interface SearchResult {
  hits: SearchHit[];
  total: number;
  sessions: number;
  truncated: boolean;
}

export interface WuweiApi {
  // ——— AGI 板块:数字婴儿 ———
  agiCfg(): Promise<any>;
  babyStatus(): Promise<string>;
  babyDiary(): Promise<string>;
  babyCurious(): Promise<string>;
  babyLive(n: number): Promise<string>;
  babyPraise(): Promise<string>;
  babyScold(): Promise<string>;
  babySeed(concept: string): Promise<string>;
  babyChat(msg: string): Promise<string>;
  babyAliveStart(): Promise<string>;
  babyAliveStop(): Promise<string>;
  babyAliveStatus(): Promise<string>;
  babyGraph(): Promise<string>;
  babyPyramid(): Promise<string>;
  babyReorganize(): Promise<string>;
  send(sid: string, text: string, images?: string[]): void;
  inject(sid: string, text: string, images?: string[]): void;
  recallInject(sid: string, text: string): Promise<boolean>;
  stop(sid?: string): void;
  reset(): void;
  undoLast(): void;
  newSession(): void;
  handoffSession(sid: string): Promise<{ ok: boolean; newId?: string; goalCarried?: boolean }>; // 一键总结→开新会话接着做(带目标则自动智能继续)
  switchSession(id: string): void;
  resumeSession(id: string): void;
  dismissInterrupted(id: string): void;
  deleteSession(id: string): void;
  searchSessions(q: string): Promise<SearchResult>; // 全局搜所有对话正文
  getTranscript(sid: string): Promise<{ archived: any[]; live: any[]; full: any[]; compacted: boolean }>; // 完整对话历史(含压缩前原文)
  pruneTranscripts(days: number): Promise<void>; // 按保留天数清理归档
  // 智能继续:会话总目标 / 自定义红线 / 后台推进集合
  goalGet(sid: string): Promise<{ text: string; active: boolean; done?: boolean } | null>;
  goalSet(sid: string, goal: { text: string; active: boolean; done?: boolean } | null): Promise<void>;
  stopRulesGet(): Promise<string>;
  stopRulesSet(t: string): Promise<void>;
  setContSessions(ids: string[]): void;
  suggestNow(sid: string): Promise<void>;
  judgeAskRisk(questions: any[], rules?: string): Promise<{ risky: boolean; reason: string }>;
  listTrash(): Promise<TrashItem[]>;
  restoreSession(id: string): void;
  purgeTrash(id: string): void;
  emptyTrash(): void;
  setSessionGroup(id: string, group?: string | null): void;
  setSessionPriority(id: string, priority: number, tag?: string): void;
  setSessionOrder(id: string, order: number): void;
  setSessionDone(id: string, done: boolean): void;
  setSessionDiscuss(id: string, discuss: boolean): void;
  reorderGroups(names: string[]): void;
  generateReport(group: string, sessionIds: string[]): void;
  setGroupMode(mode: "manual" | "date" | "project"): void;
  setStreamOutput(mode: "typewriter" | "stream" | "instant", speed: number): void;
  setKeepRecent(n: number): void;
  setAppSettings(patch: Record<string, boolean | string>): void;
  answerAsk(id: number, answers: unknown): void;
  codexResetCredits(): Promise<{ ok: boolean; availableCount?: number; credits?: any[]; error?: string }>;
  codexConsumeReset(creditId: string): Promise<{ ok: boolean; error?: string }>;
  setBrainPrompt(text: string | null): void;
  setSecretsPrompt(text: string | null): void;
  getAnnouncement(): Promise<{ active: boolean; version?: string; titleZh?: string; titleEn?: string; bodyZh?: string; bodyEn?: string }>;
  getAppVersion(): Promise<string>;
  checkUpdate(): Promise<{ available: boolean; version?: string; notes?: string; error?: string }>;
  installUpdate(): void;
  deleteExchange(sid: string, ordinal: number): void;
  bootstrap(): Promise<{ sessions: any[]; groups?: string[]; currentId: string; messages: any[]; usage?: any; rateLimits?: any; interrupted?: { id: string; title: string }[] }>;
  getSettings(): Promise<{ settings: any; backend: string; model: string; defaultPrompt?: string; defaultBrainPrompt?: string; defaultSecretsPrompt?: string }>;
  setSettings(s: any): void;
  getMemory(): Promise<string>;
  setMemory(text: string): void;
  draftGet(): Promise<{ text: string; images: string[] }>;
  draftSet(draft: { text: string; images: string[] }): void;
  // 本地脑网络 Brain
  brainGraph(): Promise<{ nodes: BrainNodeLite[]; edges: BrainEdgeLite[] }>;
  brainStats(): Promise<{ nodes: number; edges: number; embedded: number }>;
  brainRecall(query: string): Promise<string>;
  brainWarmup(): Promise<boolean>;
  brainSaveNode(node: Partial<BrainNodeLite> & { name: string }): Promise<void>;
  brainDeleteNode(id: string): Promise<void>;
  brainAddEdge(from: string, relation: string, to: string): Promise<void>;
  brainDeleteEdge(id: string): Promise<void>;
  selectFolder(): Promise<string | null>;
  brainDocStats(): Promise<{ chunks: number; files: number; dir: string; builtAt: number }>;
  brainBuildDocs(dir: string): Promise<{ chunks: number; files: number; dir: string; builtAt: number }>;
  brainReadDoc(ref: string): Promise<string>;
  brainDocProgress(): Promise<{ building: boolean; phase: string; files: number; total: number; done: number; error?: string }>;
  brainEmbedReady(): Promise<boolean>;
  brainExtractConcepts(opts?: { all?: boolean }): Promise<{ started: boolean; reason?: string }>;
  brainConceptProgress(): Promise<{ running: boolean; phase: string; total: number; done: number; created: number; skipped: number; cur?: string }>;
  brainStopConcepts(): void;
  getMcp(): Promise<{ config: string; status: { name: string; status: string; error: string; tools: number }[] }>;
  setMcp(text: string): void;
  secretsList(): Promise<{
    entries: { id: string; name: string; envVar: string; masked: string; note?: string; createdAt: number }[];
    available: boolean;
  }>;
  secretsAdd(input: { name?: string; envVar?: string; value: string; note?: string; force?: boolean }): Promise<{ ok: boolean; error?: string; entry?: any }>;
  secretsUpdate(id: string, patch: { name?: string; envVar?: string; note?: string; value?: string }): Promise<{ ok: boolean; error?: string }>;
  secretsDelete(id: string): Promise<{ ok: boolean }>;
  secretsImportEnv(text: string): Promise<{ ok: boolean; count?: number; error?: string }>;
  secretsScan(text: string): Promise<{
    redacted: string;
    candidates: {
      value: string;
      masked: string;
      kind: string;
      suggestedName: string;
      note?: string;
      existing?: { id: string; name: string; note?: string };
    }[];
  }>;
  secretsReveal(pw: string): Promise<{ ok: boolean; error?: string; items?: { id: string; value: string }[] }>;
  getTools(): Promise<{
    groups: {
      source: string;
      kind: "builtin" | "browser" | "mcp";
      tools: { name: string; description: string; readOnly: boolean; inputSchema: any }[];
    }[];
    total: number;
  }>;
  searchMcp(
    query: string,
    cursor?: string,
  ): Promise<{
    results: { name: string; fullName: string; description: string; command: string; args: string[]; repo: string; version: string }[];
    nextCursor: string;
  }>;
  browserShow(b: { x: number; y: number; width: number; height: number }): void;
  browserHide(): void;
  browserNav(action: string, arg?: string): void;
  browserDetach(): void;
  browserReattach(): void;
  getAccount(): Promise<{ loggedIn: boolean; email: string | null }>;
  logout(): void;
  webLogin(pid: string): Promise<boolean>;
  claudeLogin(): Promise<string | null>;
  codexLogin(): Promise<boolean>;
  wuweiLogin(): Promise<WuweiMe | null>;
  wuweiMe(): Promise<WuweiMe | null>;
  wuweiCatalog(): Promise<CatalogProviderDto[] | null>;
  wuweiLogout(): Promise<boolean>;
  wuweiDeviceId(): Promise<string>;
  rememberGet(): Promise<{ last?: string; accounts: { email: string; password: string }[] }>;
  rememberSet(email: string, password: string): Promise<boolean>;
  rememberClearPassword(email: string): Promise<boolean>;
  submitSupportMessage(payload: { message: string; contact: string; images: string[] }): Promise<{ ok?: boolean; error?: string }>;
  checkin(): Promise<{ success?: boolean; amount?: number; balanceAfter?: number; streak?: number; message?: string } | null>;
  payCreate(
    sku: string,
    channel: string,
  ): Promise<{
    orderId?: string;
    qr?: string;
    channel?: string;
    amountFen?: number;
    coins?: number;
    bonus?: number;
    error?: string;
    message?: string;
  }>;
  payStatus(orderId: string): Promise<{ status: string; balance?: number } | null>;
  wuweiPasswordLogin(identifier: string, password: string): Promise<{ me?: WuweiMe; error?: string }>;
  wuweiRegister(email: string, code: string, password: string): Promise<{ me?: WuweiMe; error?: string }>;
  wuweiCodeLogin(target: string, code: string): Promise<{ me?: WuweiMe; error?: string }>;
  wuweiSendCode(target: string, lang?: string, purpose?: string): Promise<true | string>;
  fetchModels(): Promise<string[]>;
  claudeOauthOpen(): Promise<boolean>;
  claudeOauthExchange(code: string): Promise<string | null>;
  readClipboard(): Promise<string>;
  platform: string;
  winMinimize(): void;
  winMaximize(): void;
  winIsMaximized(): Promise<boolean>;
  winClose(): void;
  checkConn(): Promise<{ status: "green" | "yellow" | "red"; reason: string }>;
  testKey(
    key: string,
    override?: { provider?: string; baseUrl?: string; model?: string },
  ): Promise<{ ok: boolean; reason: string }>;
  openExternal(url: string): void;
  respondPermission(id: number, decision: "allow" | "deny"): void;
  onEvent(cb: (channel: string, payload: unknown) => void): () => void;
}
declare global {
  interface Window {
    wuwei: WuweiApi;
  }
}
export {};
