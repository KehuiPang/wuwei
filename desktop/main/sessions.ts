// 会话持久化：会话列表 + 每会话消息存到 ~/.wuwei/。
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  existsSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../src/types.js";

const DIR = join(homedir(), ".wuwei");
const SDIR = join(DIR, "sessions");
const META = join(DIR, "sessions.json");
const GROUPS = join(DIR, "groups.json"); // 分组顺序(手动),新组前插=置顶
const TDIR = join(DIR, "trash"); // 回收站:软删除的会话正文文件挪这里
const TRASH = join(DIR, "trash.json"); // 回收站元信息(含 deletedAt),独立于 sessions.json
const TRASH_TTL = 7 * 24 * 3600 * 1000; // 回收站保留 7 天,过期自动彻底清除

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  usage?: { totalInput: number; totalOutput: number; lastInput: number };
  group?: string; // 所属分组名；空=未分组
  priority?: number; // 优先级排序权重：数字越大越靠前(默认 0)
  priorityTag?: string; // 优先级显示短标签(高/中/低 或 四象限缩写)；与 priority 权重配对
  order?: number; // 手动拖拽排序键(同优先级内按此升序；未拖过=按 -updatedAt)
  project?: string; // AI 推断的项目/主题(用于「按项目智能分组」)
  done?: boolean; // 已完成：排到最后、置灰
  discuss?: boolean; // 待讨论：该会话内容需过会议讨论，列表里打「议」徽标区分(独立于优先级/完成)
  running?: boolean; // 正在跑一轮(开跑置 true、结束置 false)；能跨重启存活→崩溃/强杀时残留 true
  interrupted?: boolean; // 上次运行被强制中断(启动时检测到残留 running=true 或内容明显干到一半)→提示恢复
  resumeDismissed?: boolean; // 用户点过「忽略」→内容启发式不再重复提示该会话(强杀 running 仍会重新提示)
}

function ensure() {
  mkdirSync(SDIR, { recursive: true });
}

export function listSessions(): SessionMeta[] {
  ensure();
  try {
    return JSON.parse(readFileSync(META, "utf8"));
  } catch {
    return [];
  }
}

function saveList(l: SessionMeta[]) {
  ensure();
  writeFileSync(META, JSON.stringify(l));
}

// —— 分组顺序(手动) ——
export function listGroups(): string[] {
  ensure();
  try {
    const g = JSON.parse(readFileSync(GROUPS, "utf8"));
    return Array.isArray(g) ? g.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveGroups(g: string[]) {
  ensure();
  writeFileSync(GROUPS, JSON.stringify(g));
}
// 清掉没有任何会话在用的空组(保持组列表干净)
function pruneGroups() {
  const used = new Set(listSessions().map((s) => s.group).filter(Boolean) as string[]);
  const kept = listGroups().filter((g) => used.has(g));
  saveGroups(kept);
}

// 把会话移动到分组(group 为空/未定义=移出分组)；新组名前插到组顺序=置顶
export function setSessionGroup(id: string, group?: string | null) {
  const name = (group || "").trim();
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return;
  s.group = name || undefined;
  saveList(l);
  if (name) {
    const g = listGroups();
    if (!g.includes(name)) saveGroups([name, ...g]); // 新组置顶
  }
  pruneGroups();
}

export function setSessionPriority(id: string, priority: number, tag?: string) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return;
  s.priority = Number.isFinite(priority) ? priority : 0;
  s.priorityTag = (tag || "").trim() || undefined;
  saveList(l);
}

// 手动拖拽排序：写入 order 键(前端算好的相邻中点值)
export function setSessionOrder(id: string, order: number) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s || !Number.isFinite(order)) return;
  s.order = order;
  saveList(l);
}

// AI 推断的项目/主题(用于按项目智能分组)
export function setSessionProject(id: string, project: string) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return;
  s.project = (project || "").trim() || undefined;
  saveList(l);
}

// 标记已完成(排到最后、置灰)
export function setSessionDone(id: string, done: boolean) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return;
  s.done = !!done || undefined;
  saveList(l);
}

// 标记待讨论(该会话内容需过会议讨论)：不影响排序，仅列表徽标区分
export function setSessionDiscuss(id: string, discuss: boolean) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return;
  s.discuss = !!discuss || undefined;
  saveList(l);
}

// 标记一轮是否在跑(跨重启存活)：开跑 true、结束 false。硬崩溃跳过收尾→残留 true=下次启动可识别。
export function setSessionRunning(id: string, running: boolean) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return; // 会话还没落盘(空会话)：无需标记
  const next = running || undefined;
  if (s.running === next) return; // 无变化不写盘
  s.running = next;
  if (running) s.interrupted = undefined; // 重新开跑→清掉旧的中断标记
  saveList(l);
}

// 清掉中断标记(用户点「继续」后：要恢复，别再拦)
export function clearInterrupted(id: string) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s || !s.interrupted) return;
  s.interrupted = undefined;
  saveList(l);
}

// 用户点「忽略」：清中断标记 + 记 resumeDismissed，内容启发式不再重复提示(强杀 running 仍会重新提示)
export function dismissResume(id: string) {
  const l = listSessions();
  const s = l.find((x) => x.id === id);
  if (!s) return;
  s.interrupted = undefined;
  s.resumeDismissed = true;
  saveList(l);
}

// 读原始消息(不修复)：内容启发式要看真实末尾结构，repair 会补占位掩盖"半截"特征
function readRaw(id: string): any[] {
  try {
    const m = JSON.parse(readFileSync(join(SDIR, id + ".json"), "utf8"));
    return Array.isArray(m) ? m : [];
  } catch {
    return [];
  }
}
// 内容启发式：会话是否"明显干到一半"——正常收尾=末条助手纯文字回复；否则视为半截：
//  ① 末条助手带 tool_use(调了工具没等到结果/没继续) ② 末条纯 tool_result(工具跑完助手没给结论)
//  ③ 末条用户消息(用户发了就退、AI 一个字没回)
function looksIncomplete(msgs: any[]): boolean {
  if (!msgs.length) return false;
  const last = msgs[msgs.length - 1];
  const blocks = last?.content || [];
  if (last.role === "assistant") return blocks.some((b: any) => b.type === "tool_use");
  if (last.role === "user")
    return (
      blocks.some((b: any) => b.type === "tool_result") ||
      blocks.some((b: any) => b.type === "text" && b.text?.trim())
    );
  return false;
}

// 启动时调用一次(设置开关开时)：
//  - 残留 running=true → 上次被强制中断/崩溃 → 置 interrupted、清 running(强信号，无条件)。
//  - heuristic=true 时，额外对「最近 24h、未完成标记、未忽略过」的会话做内容启发式，明显半截的也置 interrupted。
// 返回所有 interrupted 会话(含历史遗留未处理的)。
export function markInterruptedOnStartup(heuristic: boolean): { id: string; title: string }[] {
  const l = listSessions();
  const now = Date.now();
  const RECENT = 24 * 3600 * 1000;
  let changed = false;
  for (const s of l) {
    if (s.running) {
      s.running = undefined;
      s.interrupted = true;
      changed = true;
      continue;
    }
    if (
      heuristic &&
      !s.interrupted &&
      !s.resumeDismissed &&
      !s.done &&
      s.updatedAt >= now - RECENT &&
      looksIncomplete(readRaw(s.id))
    ) {
      s.interrupted = true;
      changed = true;
    }
  }
  if (changed) saveList(l);
  return l.filter((s) => s.interrupted).map((s) => ({ id: s.id, title: s.title }));
}

// 组顺序整体重排(拖拽组头)
export function setGroupsOrder(names: string[]) {
  if (!Array.isArray(names)) return;
  saveGroups(names.filter((x) => typeof x === "string"));
}

// 历史是否合法：user/assistant 交替 + 每个 tool_use 都有紧跟的配对 tool_result
function isValidHistory(msgs: any[]): boolean {
  for (let i = 0; i < msgs.length; i++) {
    if (i > 0 && msgs[i].role === msgs[i - 1].role) return false;
    if (msgs[i].role === "assistant") {
      const ids = (msgs[i].content || []).filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
      if (ids.length) {
        const nxt = msgs[i + 1];
        if (!nxt || nxt.role !== "user") return false;
        const rids = (nxt.content || []).filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id);
        if (ids.some((id: string) => !rids.includes(id))) return false;
      }
    }
  }
  return true;
}

// 修复被中断搞坏的历史(连续同角色 / 悬空 tool_use / tool_result 错位)，产出合法可继续的序列
function repairHistory(msgs: any[]): any[] {
  const out: any[] = [];
  const ph = (t: string) => ({ type: "text", text: t });
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (m.role === "assistant") {
      if (prev && prev.role === "assistant") out.push({ role: "user", content: [ph("继续")] });
      out.push(m);
      continue;
    }
    const toolResults = (m.content || []).filter((b: any) => b.type === "tool_result");
    const others = (m.content || []).filter((b: any) => b.type !== "tool_result");
    if (prev && prev.role === "assistant" && prev.content.some((b: any) => b.type === "tool_use")) {
      // 紧跟 tool_use：按其 id 顺序补齐 tool_result(有就用，缺就占位)
      const ids = prev.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
      const byId = new Map(toolResults.map((r: any) => [r.tool_use_id, r]));
      out.push({
        role: "user",
        content: ids.map(
          (id: string) => byId.get(id) || { type: "tool_result", tool_use_id: id, content: "(已停止)", is_error: true },
        ),
      });
      if (others.length) {
        out.push({ role: "assistant", content: [ph("(已停止)")] });
        out.push({ role: "user", content: others });
      }
    } else {
      if (prev && prev.role === "user") out.push({ role: "assistant", content: [ph("(已停止)")] });
      // 落单 tool_result(前面不是 tool_use)会致 400 → 丢弃，只保留其它内容
      out.push({ role: "user", content: others.length ? others : [ph("(已停止)")] });
    }
  }
  return out;
}

export function loadMessages(id: string): Message[] {
  try {
    const msgs = JSON.parse(readFileSync(join(SDIR, id + ".json"), "utf8"));
    // 只在检测到损坏时修复(干净会话原样返回)，自愈被中断搞坏的历史
    return isValidHistory(msgs) ? msgs : (repairHistory(msgs) as Message[]);
  } catch {
    return [];
  }
}

// —— 会话正文异步合并写 ——
// 大会话(可达十几MB)每步全量同步 stringify+writeFileSync 会阻塞主进程事件循环(实测~85ms/次)，
// 多步任务×多会话并发时把主线程卡住→IPC(如停止)被饿死、点了没反应。改为:
// 每会话只保留"最新待写快照"，单飞后台写；密集调用自动合并(只写最后一次)、写盘走异步、
// 每次写后 setImmediate 让出主线程给 IPC 喘息。stringify 仍在主线程但每个 flush 周期只做一次。
const pendingBody = new Map<string, Message[]>(); // id → 最新待写消息(引用最新态)
const savingBody = new Set<string>(); // 正在后台写的会话
async function flushBody(id: string): Promise<void> {
  savingBody.add(id);
  try {
    while (pendingBody.has(id)) {
      const msgs = pendingBody.get(id)!;
      pendingBody.delete(id);
      try {
        await writeFile(join(SDIR, id + ".json"), JSON.stringify(msgs));
      } catch {
        /* 写盘失败不致命：下次 saveSession 会再排一次 */
      }
      await new Promise((r) => setImmediate(r)); // 让出主线程,IPC/渲染得以处理
    }
  } finally {
    savingBody.delete(id);
  }
}
// 兜底(退出前)：把还没落盘的会话同步刷完，避免丢最后一段
export function flushAllSessionsSync(): void {
  for (const [id, msgs] of pendingBody) {
    try {
      writeFileSync(join(SDIR, id + ".json"), JSON.stringify(msgs));
    } catch {
      /* ignore */
    }
  }
  pendingBody.clear();
}

export function saveSession(
  id: string,
  messages: Message[],
  title: string,
  now: number,
  usage?: SessionMeta["usage"],
) {
  ensure();
  pendingBody.set(id, messages); // 正文异步合并写(不阻塞事件循环)
  if (!savingBody.has(id)) void flushBody(id);
  const all = listSessions(); // 元信息小(~KB)，保持同步，列表即时更新
  const prev = all.find((s) => s.id === id); // 保留已设的分组/优先级，别被每轮落盘抹掉
  const l = all.filter((s) => s.id !== id);
  l.unshift({
    id,
    title,
    updatedAt: now,
    usage,
    group: prev?.group,
    priority: prev?.priority,
    priorityTag: prev?.priorityTag,
    order: prev?.order,
    project: prev?.project,
    done: prev?.done,
    discuss: prev?.discuss, // 保留待讨论标记，别被每轮落盘抹掉
    running: prev?.running, // 保留运行/中断标记，别被每轮落盘抹掉(否则崩溃检测失效)
    interrupted: prev?.interrupted,
    resumeDismissed: prev?.resumeDismissed,
  });
  saveList(l);
}

// —— 回收站(软删除) ——
export interface TrashMeta extends SessionMeta {
  deletedAt: number; // 删除时间戳,7 天后自动彻底清除
}
function ensureTrash() {
  mkdirSync(TDIR, { recursive: true });
}
function saveTrash(l: TrashMeta[]) {
  ensureTrash();
  writeFileSync(TRASH, JSON.stringify(l));
}
function readTrash(): TrashMeta[] {
  try {
    const t = JSON.parse(readFileSync(TRASH, "utf8"));
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}
// 清掉超过 TTL 的回收站条目(彻底删正文文件)。返回仍在保留期内的条目。
function purgeExpired(list: TrashMeta[], now: number): TrashMeta[] {
  const kept: TrashMeta[] = [];
  let changed = false;
  for (const t of list) {
    if (now - (t.deletedAt || 0) >= TRASH_TTL) {
      try { rmSync(join(TDIR, t.id + ".json")); } catch { /* ignore */ }
      changed = true;
    } else kept.push(t);
  }
  if (changed) saveTrash(kept);
  return kept;
}
// 列出回收站(顺带清掉过期项);最近删的排前面
export function listTrash(now = Date.now()): TrashMeta[] {
  const kept = purgeExpired(readTrash(), now);
  return [...kept].sort((a, b) => b.deletedAt - a.deletedAt);
}

// 软删除:正文文件挪进 trash/,元信息进 trash.json(带 deletedAt),从会话列表摘掉。可恢复。
export function deleteSession(id: string, now = Date.now()) {
  pendingBody.delete(id); // 取消未落盘的正文写,避免挪走后又被重建
  ensureTrash();
  try {
    const src = join(SDIR, id + ".json");
    if (existsSync(src)) renameSync(src, join(TDIR, id + ".json"));
  } catch {
    /* 正文挪动失败也继续:至少元信息进回收站,不至于卡住删除 */
  }
  const meta = listSessions().find((s) => s.id === id);
  if (meta) {
    const t = readTrash().filter((x) => x.id !== id);
    t.unshift({ ...meta, running: undefined, interrupted: undefined, deletedAt: now });
    saveTrash(t);
  }
  saveList(listSessions().filter((s) => s.id !== id));
  pruneGroups();
}

// 从回收站恢复:正文挪回 sessions/,元信息回 sessions.json(去掉 deletedAt),原分组还在则复用。
export function restoreSession(id: string): boolean {
  const t = readTrash();
  const item = t.find((x) => x.id === id);
  if (!item) return false;
  try {
    const src = join(TDIR, id + ".json");
    if (existsSync(src)) renameSync(src, join(SDIR, id + ".json"));
  } catch {
    /* ignore */
  }
  saveTrash(t.filter((x) => x.id !== id));
  const { deletedAt: _drop, ...meta } = item;
  const l = listSessions().filter((s) => s.id !== id);
  l.unshift(meta);
  saveList(l);
  if (meta.group) {
    const g = listGroups();
    if (!g.includes(meta.group)) saveGroups([meta.group, ...g]); // 组被 prune 掉了就补回
  }
  return true;
}

// 彻底删除回收站里的某条(不可恢复)
export function purgeTrashItem(id: string) {
  try { rmSync(join(TDIR, id + ".json")); } catch { /* ignore */ }
  saveTrash(readTrash().filter((x) => x.id !== id));
}

// 清空回收站(全部彻底删除)
export function emptyTrash() {
  for (const t of readTrash()) {
    try { rmSync(join(TDIR, t.id + ".json")); } catch { /* ignore */ }
  }
  saveTrash([]);
}

// 启动时调用:清掉过期回收站项(顺带保证 trash 目录存在)
export function autoPurgeTrash(now = Date.now()) {
  purgeExpired(readTrash(), now);
}

// 从首条用户消息推导标题
// 交接会话的首条消息 = 固定套话前言 + "----" 分隔 + 真正的交接文档。
// 派生/智能标题若直接吃首条文本，标题永远是"【工作交接（来自上一个对话）】…"这段套话。
// 这里剥掉前言，只留分隔线之后的文档正文，让标题基于当下项目/内容来命名。
export function stripHandoffWrapper(text: string): string {
  const t = text || "";
  if (t.startsWith("【工作交接")) {
    const i = t.indexOf("\n----\n");
    if (i >= 0) {
      const body = t.slice(i + 6).trim();
      if (body) return body;
    }
  }
  return t;
}

export function deriveTitle(messages: Message[]): string {
  for (const m of messages) {
    if (m.role === "user") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) {
          let t = stripHandoffWrapper(b.text).trim().replace(/\s+/g, " ");
          // 去掉交接文档常见的分节前缀(如 "1) 目标/任务：")，让标题直奔主题
          t = t.replace(/^\d+\s*[).、．]\s*[^：:]{0,12}[：:]\s*/, "").trim();
          if (!t) t = b.text.trim().replace(/\s+/g, " ");
          return t.length > 24 ? t.slice(0, 24) + "…" : t;
        }
      }
    }
  }
  return "新对话";
}
