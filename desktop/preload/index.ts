// preload：用 contextBridge 暴露最小安全 API 给渲染进程（隔离，不开 nodeIntegration）。
import { contextBridge, ipcRenderer } from "electron";
import type { WuweiMe, CatalogProviderDto } from "../main/wuwei-auth.js";

const EVENTS = [
  "evt:ready",
  "evt:assistant-delta",
  "evt:tool-start",
  "evt:tool-end",
  "evt:permission-request",
  "evt:ask-user",
  "evt:usage",
  "evt:ratelimits",
  "evt:compact",
  "evt:done",
  "evt:stopped",
  "evt:error",
  "evt:sessions",
  "evt:session-loaded",
  "evt:account",
  "evt:wuwei-me",
  "evt:tasks",
  "evt:mcp",
  "evt:browser",
  "evt:browser-activity",
  "evt:browser-detached",
  "evt:suggest",
  "evt:groups",
  "evt:assistant-replace",
  "evt:brain-docs",
  "evt:brain-concepts",
  "evt:handoff",
  "evt:trash",
  "evt:tray-settings",
  "evt:tray-check-update",
] as const;

// 把当前 edition(wuwei/minicc)暴露给渲染层，供动态设置窗口/文档标题。
// ⚠️ appName 在 preload 加载时就定死了：渲染进程的 env 是启动时从主进程继承的快照，
//    用户之后在设置里切语言，这里不会跟着变。渲染层要显示品牌名请用 i18n 的 splash.brand。
contextBridge.exposeInMainWorld("wuweiEdition", {
  edition: process.env.WUWEI_EDITION || "wuwei",
  appName:
    (process.env.WUWEI_EDITION || "wuwei") === "minicc"
      ? "minicc"
      : process.env.WUWEI_LANG === "en"
        ? "Wuwei"
        : "无为",
});

const api = {
  // ——— AGI 板块:数字婴儿 ———
  agiCfg: () => ipcRenderer.invoke("agi:cfg") as Promise<any>,
  babyStatus: () => ipcRenderer.invoke("agi:baby:status") as Promise<string>,
  babyDiary: () => ipcRenderer.invoke("agi:baby:diary") as Promise<string>,
  babyCurious: () => ipcRenderer.invoke("agi:baby:curious") as Promise<string>,
  babyLive: (n: number) => ipcRenderer.invoke("agi:baby:live", n) as Promise<string>,
  babyPraise: () => ipcRenderer.invoke("agi:baby:praise") as Promise<string>,
  babyScold: () => ipcRenderer.invoke("agi:baby:scold") as Promise<string>,
  babySeed: (concept: string) => ipcRenderer.invoke("agi:baby:seed", concept) as Promise<string>,
  babyChat: (msg: string) => ipcRenderer.invoke("agi:baby:chat", msg) as Promise<string>,
  babyAliveStart: () => ipcRenderer.invoke("agi:baby:alivestart") as Promise<string>,
  babyAliveStop: () => ipcRenderer.invoke("agi:baby:alivestop") as Promise<string>,
  babyAliveStatus: () => ipcRenderer.invoke("agi:baby:alivestatus") as Promise<string>,
  babyGraph: () => ipcRenderer.invoke("agi:baby:graph") as Promise<string>,
  babyPyramid: () => ipcRenderer.invoke("agi:baby:pyramid") as Promise<string>,
  babyReorganize: () => ipcRenderer.invoke("agi:baby:reorganize") as Promise<string>,

  send: (sid: string, text: string, images?: string[]) =>
    ipcRenderer.send("chat:send", sid, text, images),
  inject: (sid: string, text: string, images?: string[]) =>
    ipcRenderer.send("chat:inject", sid, text, images),
  recallInject: (sid: string, text: string) =>
    ipcRenderer.invoke("chat:recall-inject", sid, text) as Promise<boolean>,
  stop: (sid?: string) => ipcRenderer.send("chat:stop", sid),
  reset: () => ipcRenderer.send("chat:reset"),
  undoLast: () => ipcRenderer.send("chat:undo-last"),
  newSession: () => ipcRenderer.send("session:new"),
  handoffSession: (sid: string) =>
    ipcRenderer.invoke("session:handoff", sid) as Promise<{ ok: boolean; newId?: string }>, // 一键总结→开新会话接着做
  switchSession: (id: string) => ipcRenderer.send("session:switch", id),
  resumeSession: (id: string) => ipcRenderer.send("session:resume", id), // 崩溃恢复:继续中断的任务
  dismissInterrupted: (id: string) => ipcRenderer.send("session:dismiss-interrupted", id), // 崩溃恢复:忽略
  deleteSession: (id: string) => ipcRenderer.send("session:delete", id),
  // 全局搜索:跨所有会话搜正文,返回标题+上下文摘要+跳转锚点
  searchSessions: (q: string) => ipcRenderer.invoke("session:search", q) as Promise<any>,
  // 完整对话日志:归档(压缩前原文)+当前持久化，拼成完整历史
  getTranscript: (sid: string) => ipcRenderer.invoke("session:transcript", sid) as Promise<{ archived: any[]; live: any[]; full: any[]; compacted: boolean }>,
  pruneTranscripts: (days: number) => ipcRenderer.invoke("session:pruneTranscripts", days) as Promise<void>,
  // 智能继续:会话总目标 / 自定义红线 / 后台推进会话集合
  goalGet: (sid: string) => ipcRenderer.invoke("chat:goalGet", sid) as Promise<{ text: string; active: boolean; done?: boolean } | null>,
  goalSet: (sid: string, goal: { text: string; active: boolean; done?: boolean } | null) =>
    ipcRenderer.invoke("chat:goalSet", sid, goal) as Promise<void>,
  stopRulesGet: () => ipcRenderer.invoke("chat:stopRulesGet") as Promise<string>,
  stopRulesSet: (t: string) => ipcRenderer.invoke("chat:stopRulesSet", t) as Promise<void>,
  setContSessions: (ids: string[]) => ipcRenderer.send("chat:cont-sessions", ids),
  suggestNow: (sid: string) => ipcRenderer.invoke("chat:suggest", sid) as Promise<void>,
  judgeAskRisk: (questions: any[], rules?: string) => ipcRenderer.invoke("chat:judgeAskRisk", questions, rules) as Promise<{ risky: boolean; reason: string }>,
  // 回收站:软删除的会话可恢复,7 天后自动彻底清除
  listTrash: () => ipcRenderer.invoke("session:list-trash") as Promise<any[]>,
  restoreSession: (id: string) => ipcRenderer.send("session:restore", id),
  purgeTrash: (id: string) => ipcRenderer.send("session:purge", id),
  emptyTrash: () => ipcRenderer.send("session:empty-trash"),
  setSessionGroup: (id: string, group?: string | null) =>
    ipcRenderer.send("session:set-group", id, group),
  setSessionPriority: (id: string, priority: number, tag?: string) =>
    ipcRenderer.send("session:set-priority", id, priority, tag),
  setSessionOrder: (id: string, order: number) =>
    ipcRenderer.send("session:set-order", id, order),
  setSessionDone: (id: string, done: boolean) => ipcRenderer.send("session:set-done", id, done),
  setSessionDiscuss: (id: string, discuss: boolean) =>
    ipcRenderer.send("session:set-discuss", id, discuss),
  reorderGroups: (names: string[]) => ipcRenderer.send("session:reorder-groups", names),
  generateReport: (group: string, sessionIds: string[]) =>
    ipcRenderer.send("report:generate", group, sessionIds),
  setGroupMode: (mode: "manual" | "date" | "project") =>
    ipcRenderer.send("settings:set-group-mode", mode),
  setStreamOutput: (mode: "typewriter" | "stream" | "instant", speed: number) =>
    ipcRenderer.send("settings:set-stream", mode, speed),
  setKeepRecent: (n: number) => ipcRenderer.send("settings:set-keep-recent", n),
  setAskToast: (autoDismiss: boolean, sec: number) =>
    ipcRenderer.send("settings:set-ask-toast", autoDismiss, sec),
  setAppSettings: (patch: Record<string, boolean>) => ipcRenderer.send("settings:set-app", patch),
  answerAsk: (id: number, answers: unknown) => ipcRenderer.send("ask:answer", id, answers),
  codexResetCredits: () => ipcRenderer.invoke("codex:reset-credits"),
  codexConsumeReset: (creditId: string) => ipcRenderer.invoke("codex:consume-reset", creditId),
  setBrainPrompt: (text: string | null) => ipcRenderer.send("settings:set-brain-prompt", text),
  setSecretsPrompt: (text: string | null) => ipcRenderer.send("settings:set-secrets-prompt", text),
  deleteExchange: (sid: string, ordinal: number) =>
    ipcRenderer.send("session:delete-exchange", sid, ordinal),
  bootstrap: () => ipcRenderer.invoke("session:bootstrap") as Promise<any>,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s: unknown) => ipcRenderer.send("settings:set", s),
  getMemory: () => ipcRenderer.invoke("memory:get") as Promise<string>,
  setMemory: (text: string) => ipcRenderer.send("memory:set", text),
  // 输入框草稿(文字+粘贴的图)实时存本地，重开自动恢复
  draftGet: () => ipcRenderer.invoke("draft:get") as Promise<{ text: string; images: string[] }>,
  draftSet: (draft: { text: string; images: string[] }) => ipcRenderer.send("draft:set", draft),
  // 本地知识网络 Brain
  brainGraph: () =>
    ipcRenderer.invoke("brain:graph") as Promise<{
      nodes: {
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
      }[];
      edges: { id: string; from: string; to: string; relation: string; weight: number; hits: number }[];
    }>,
  brainStats: () =>
    ipcRenderer.invoke("brain:stats") as Promise<{ nodes: number; edges: number; embedded: number }>,
  brainRecall: (query: string) => ipcRenderer.invoke("brain:recall", query) as Promise<string>,
  brainWarmup: () => ipcRenderer.invoke("brain:warmup") as Promise<boolean>,
  brainSaveNode: (node: unknown) => ipcRenderer.invoke("brain:save-node", node) as Promise<void>,
  brainDeleteNode: (id: string) => ipcRenderer.invoke("brain:delete-node", id) as Promise<void>,
  brainAddEdge: (from: string, relation: string, to: string) =>
    ipcRenderer.invoke("brain:add-edge", from, relation, to) as Promise<void>,
  brainDeleteEdge: (id: string) => ipcRenderer.invoke("brain:delete-edge", id) as Promise<void>,
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder") as Promise<string | null>,
  brainDocStats: () =>
    ipcRenderer.invoke("brain:doc-stats") as Promise<{ chunks: number; files: number; dir: string; builtAt: number }>,
  brainBuildDocs: (dir: string) =>
    ipcRenderer.invoke("brain:build-docs", dir) as Promise<{ chunks: number; files: number; dir: string; builtAt: number }>,
  brainReadDoc: (ref: string) => ipcRenderer.invoke("brain:read-doc", ref) as Promise<string>,
  // 索引构建进度 / 向量模型是否就绪(主进程真相源,关弹窗不丢)
  brainDocProgress: () =>
    ipcRenderer.invoke("brain:doc-progress") as Promise<{ building: boolean; phase: string; files: number; total: number; done: number; error?: string }>,
  brainEmbedReady: () => ipcRenderer.invoke("brain:embed-ready") as Promise<boolean>,
  // 概念抽取(用 k3 从已索引文档批量抽概念)：触发/查进度/停止
  brainExtractConcepts: (opts?: { all?: boolean }) =>
    ipcRenderer.invoke("brain:extract-concepts", opts || {}) as Promise<{ started: boolean; reason?: string }>,
  brainConceptProgress: () =>
    ipcRenderer.invoke("brain:concept-progress") as Promise<{ running: boolean; phase: string; total: number; done: number; created: number; skipped: number; cur?: string }>,
  brainStopConcepts: () => ipcRenderer.send("brain:stop-concepts"),
  getMcp: () =>
    ipcRenderer.invoke("mcp:get") as Promise<{
      config: string;
      status: { name: string; status: string; error: string; tools: number }[];
    }>,
  setMcp: (text: string) => ipcRenderer.send("mcp:set", text),
  // 本地密钥管理器
  secretsList: () =>
    ipcRenderer.invoke("secrets:list") as Promise<{
      entries: { id: string; name: string; envVar: string; masked: string; note?: string; createdAt: number }[];
      available: boolean;
    }>,
  secretsAdd: (input: { name?: string; envVar?: string; value: string; note?: string; force?: boolean }) =>
    ipcRenderer.invoke("secrets:add", input) as Promise<{ ok: boolean; error?: string; entry?: any }>,
  secretsUpdate: (id: string, patch: { name?: string; envVar?: string; note?: string; value?: string }) =>
    ipcRenderer.invoke("secrets:update", id, patch) as Promise<{ ok: boolean; error?: string }>,
  secretsDelete: (id: string) => ipcRenderer.invoke("secrets:delete", id) as Promise<{ ok: boolean }>,
  secretsImportEnv: (text: string) =>
    ipcRenderer.invoke("secrets:import-env", text) as Promise<{ ok: boolean; count?: number; error?: string }>,
  secretsScan: (text: string) =>
    ipcRenderer.invoke("secrets:scan", text) as Promise<{
      redacted: string;
      candidates: {
        value: string;
        masked: string;
        kind: string;
        suggestedName: string;
        note?: string;
        existing?: { id: string; name: string; note?: string };
      }[];
    }>,
  secretsReveal: (pw: string) =>
    ipcRenderer.invoke("secrets:reveal", pw) as Promise<{
      ok: boolean;
      error?: string;
      items?: { id: string; value: string }[];
    }>,
  getTools: () =>
    ipcRenderer.invoke("tools:get") as Promise<{
      groups: {
        source: string;
        kind: "builtin" | "browser" | "mcp";
        tools: { name: string; description: string; readOnly: boolean; inputSchema: any }[];
      }[];
      total: number;
    }>,
  searchMcp: (query: string, cursor?: string) =>
    ipcRenderer.invoke("mcp:search", query, cursor) as Promise<{
      results: {
        name: string;
        fullName: string;
        description: string;
        command: string;
        args: string[];
        repo: string;
        version: string;
      }[];
      nextCursor: string;
    }>,
  browserShow: (b: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("browser:show", b),
  browserHide: () => ipcRenderer.send("browser:hide"),
  browserNav: (action: string, arg?: string) => ipcRenderer.send("browser:nav", action, arg),
  browserDetach: () => ipcRenderer.send("browser:detach"),
  browserReattach: () => ipcRenderer.send("browser:reattach"),
  getAccount: () => ipcRenderer.invoke("account:get"),
  logout: () => ipcRenderer.send("account:logout"),
  webLogin: (pid: string) => ipcRenderer.invoke("account:web-login", pid),
  // 应用内弹窗授权(自行输账号密码)
  claudeLogin: () => ipcRenderer.invoke("account:claude-login") as Promise<string | null>,
  // Codex 一键授权(应用内 ChatGPT OAuth，本地 1455 回环，写 ~/.codex/auth.json)
  codexLogin: () => ipcRenderer.invoke("account:codex-login") as Promise<boolean>,
  // 无为账号登录(B2：本地回环中转 → /api/me 拿 user+coin，独立于 codex/claude)
  wuweiLogin: () => ipcRenderer.invoke("account:wuwei-login") as Promise<WuweiMe | null>,
  wuweiMe: () => ipcRenderer.invoke("account:wuwei-me") as Promise<WuweiMe | null>,
  wuweiCatalog: () => ipcRenderer.invoke("account:wuwei-catalog") as Promise<CatalogProviderDto[] | null>,
  wuweiLogout: () => ipcRenderer.invoke("account:wuwei-logout") as Promise<boolean>,
  wuweiDeviceId: () => ipcRenderer.invoke("account:wuwei-device-id") as Promise<string>,
  // 记住登录：多账号历史(自动填充 + 账号下拉)
  rememberGet: () =>
    ipcRenderer.invoke("login:remember-get") as Promise<{ last?: string; accounts: { email: string; password: string }[] }>,
  rememberSet: (email: string, password: string) =>
    ipcRenderer.invoke("login:remember-set", email, password) as Promise<boolean>,
  rememberClearPassword: (email: string) =>
    ipcRenderer.invoke("login:remember-clear-password", email) as Promise<boolean>,
  // 客服留言：留言内容 + 图片(data URL) + 联系方式 → 后端(wuwei-site 留言管理可见)
  submitSupportMessage: (payload: { message: string; contact: string; images: string[] }) =>
    ipcRenderer.invoke("support:message", payload) as Promise<{ ok?: boolean; error?: string }>,
  // 每日签到（幂等）：返回 {success, amount, balanceAfter, streak, message} 或 null
  checkin: () =>
    ipcRenderer.invoke("account:checkin") as Promise<{ success?: boolean; amount?: number; balanceAfter?: number; streak?: number; message?: string } | null>,
  // 客户端公告（公开）：返回当前发布中的公告 + version(updated_at)，未发布/异常 → {active:false}
  getAnnouncement: () =>
    ipcRenderer.invoke("announcement:get") as Promise<{ active: boolean; version?: string; titleZh?: string; titleEn?: string; bodyZh?: string; bodyEn?: string }>,
  // 消息中心：拉取当前用户的消息列表 + 未读数（需登录，未登录返回空）
  getMessages: () =>
    ipcRenderer.invoke("messages:list") as Promise<{
      messages: Array<{
        id: number;
        category: string; // system | reward | activity | feedback
        title: string;
        body: string;
        reward: { kind: "coins" | "membership"; amount: number; plan?: string } | null;
        readAt: string | null;
        createdAt: string;
      }>;
      unread: number;
    }>,
  // 消息中心：标记已读（传 ids 标指定，或 all=true 全部已读）→ 返回剩余未读数
  markMessagesRead: (arg: { ids?: number[]; all?: boolean }) =>
    ipcRenderer.invoke("messages:read", arg) as Promise<{ ok: boolean; unread: number }>,
  // 当前应用版本号（帮助菜单显示）
  getAppVersion: () => ipcRenderer.invoke("app:version") as Promise<string>,
  // 手动检查更新：返回是否有新版 + 版本号（未打包/无更新源时 available:false）
  checkUpdate: () => ipcRenderer.invoke("updater:check") as Promise<{ available: boolean; downloaded?: boolean; version?: string; notes?: string; error?: string }>,
  // 立即安装已下载好的更新并重启
  installUpdate: () => ipcRenderer.send("updater:install"),
  // 扫码支付：下单拿二维码串 + 轮询订单状态
  payCreate: (sku: string, channel: string) =>
    ipcRenderer.invoke("pay:create", sku, channel) as Promise<{
      orderId?: string;
      qr?: string;
      channel?: string;
      amountFen?: number;
      coins?: number;
      bonus?: number;
      error?: string;
      message?: string;
    }>,
  payStatus: (orderId: string) =>
    ipcRenderer.invoke("pay:status", orderId) as Promise<{ status: string; balance?: number } | null>,
  // 应用内登录（不跳浏览器）：邮箱密码 / 邮箱注册 / 手机(或邮箱)验证码 / 发验证码
  wuweiPasswordLogin: (identifier: string, password: string) =>
    ipcRenderer.invoke("account:wuwei-password-login", identifier, password) as Promise<{ me?: WuweiMe; error?: string }>,
  wuweiRegister: (email: string, code: string, password: string) =>
    ipcRenderer.invoke("account:wuwei-register", email, code, password) as Promise<{ me?: WuweiMe; error?: string }>,
  wuweiCodeLogin: (target: string, code: string) =>
    ipcRenderer.invoke("account:wuwei-code-login", target, code) as Promise<{ me?: WuweiMe; error?: string }>,
  wuweiSendCode: (target: string, lang?: string, purpose?: string) =>
    ipcRenderer.invoke("account:wuwei-send-code", target, lang, purpose) as Promise<true | string>,
  fetchModels: () => ipcRenderer.invoke("models:fetch") as Promise<string[]>,
  // 系统浏览器授权：第1步开浏览器，第2步用授权码换 token
  claudeOauthOpen: () => ipcRenderer.invoke("account:claude-oauth-open") as Promise<boolean>,
  claudeOauthExchange: (code: string) =>
    ipcRenderer.invoke("account:claude-oauth-exchange", code) as Promise<string | null>,
  readClipboard: () => ipcRenderer.invoke("util:read-clipboard") as Promise<string>,
  platform: process.platform,
  winMinimize: () => ipcRenderer.send("win:minimize"),
  winMaximize: () => ipcRenderer.send("win:maximize"),
  winIsMaximized: () => ipcRenderer.invoke("win:is-maximized") as Promise<boolean>,
  winClose: () => ipcRenderer.send("win:close"),
  checkConn: () =>
    ipcRenderer.invoke("conn:check") as Promise<{ status: "green" | "yellow" | "red"; reason: string }>,
  testKey: (key: string, override?: { provider?: string; baseUrl?: string; model?: string }) =>
    ipcRenderer.invoke("conn:test-key", key, override) as Promise<{ ok: boolean; reason: string }>,
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  respondPermission: (id: number, decision: "allow" | "deny") =>
    ipcRenderer.send("perm:respond", id, decision),
  // 统一事件订阅：cb(channel, payload)
  onEvent: (cb: (channel: string, payload: unknown) => void) => {
    const handlers: Array<[string, (...a: unknown[]) => void]> = [];
    for (const ch of EVENTS) {
      const h = (_e: unknown, payload: unknown) => cb(ch, payload);
      ipcRenderer.on(ch, h);
      handlers.push([ch, h]);
    }
    // 返回清理函数：卸载全部监听，避免重复注册(HMR/重挂载时监听叠加→事件被重复处理)
    return () => {
      for (const [ch, h] of handlers) ipcRenderer.removeListener(ch, h);
    };
  },
};

// 渲染进程桥接对象：暴露为 window.wuwei
contextBridge.exposeInMainWorld("wuwei", api);

