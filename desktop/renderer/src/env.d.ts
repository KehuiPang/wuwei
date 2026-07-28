// 渲染进程可见的 window.minicc 类型（来自 preload）
import type { WuweiMe } from "../../main/wuwei-auth.js";

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
export interface MiniccApi {
  send(sid: string, text: string, images?: string[]): void;
  inject(sid: string, text: string, images?: string[]): void;
  recallInject(sid: string, text: string): Promise<boolean>;
  stop(sid?: string): void;
  reset(): void;
  undoLast(): void;
  newSession(): void;
  switchSession(id: string): void;
  deleteSession(id: string): void;
  setSessionGroup(id: string, group?: string | null): void;
  setSessionPriority(id: string, priority: number, tag?: string): void;
  setSessionOrder(id: string, order: number): void;
  setSessionDone(id: string, done: boolean): void;
  reorderGroups(names: string[]): void;
  generateReport(group: string, sessionIds: string[]): void;
  setGroupMode(mode: "manual" | "date" | "project"): void;
  setStreamOutput(mode: "typewriter" | "stream" | "instant", speed: number): void;
  setKeepRecent(n: number): void;
  setAppSettings(patch: Record<string, boolean>): void;
  answerAsk(id: number, answers: unknown): void;
  codexResetCredits(): Promise<{ ok: boolean; availableCount?: number; credits?: any[]; error?: string }>;
  codexConsumeReset(creditId: string): Promise<{ ok: boolean; error?: string }>;
  setBrainPrompt(text: string | null): void;
  setSecretsPrompt(text: string | null): void;
  deleteExchange(sid: string, ordinal: number): void;
  bootstrap(): Promise<{ sessions: any[]; groups?: string[]; currentId: string; messages: any[]; usage?: any; rateLimits?: any }>;
  getSettings(): Promise<{ settings: any; backend: string; model: string; defaultPrompt?: string; defaultBrainPrompt?: string; defaultSecretsPrompt?: string }>;
  setSettings(s: any): void;
  getMemory(): Promise<string>;
  setMemory(text: string): void;
  draftGet(): Promise<{ text: string; images: string[] }>;
  draftSet(draft: { text: string; images: string[] }): void;
  // 本地知识网络 Brain
  brainGraph(): Promise<{ nodes: BrainNodeLite[]; edges: BrainEdgeLite[] }>;
  brainStats(): Promise<{ nodes: number; edges: number; embedded: number }>;
  brainRecall(query: string): Promise<string>;
  brainWarmup(): Promise<boolean>;
  brainSaveNode(node: Partial<BrainNodeLite> & { name: string }): Promise<void>;
  brainDeleteNode(id: string): Promise<void>;
  brainAddEdge(from: string, relation: string, to: string): Promise<void>;
  brainDeleteEdge(id: string): Promise<void>;
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
  wuweiLogout(): Promise<boolean>;
  wuweiDeviceId(): Promise<string>;
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
    minicc: MiniccApi;
  }
}
export {};
