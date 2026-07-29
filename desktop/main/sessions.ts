// 会话持久化：会话列表 + 每会话消息存到 ~/.wuwei/。
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../src/types.js";

const DIR = join(homedir(), ".wuwei");
const SDIR = join(DIR, "sessions");
const META = join(DIR, "sessions.json");
const GROUPS = join(DIR, "groups.json"); // 分组顺序(手动),新组前插=置顶

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
  });
  saveList(l);
}

export function deleteSession(id: string) {
  try {
    rmSync(join(SDIR, id + ".json"));
  } catch {
    /* ignore */
  }
  saveList(listSessions().filter((s) => s.id !== id));
  pruneGroups();
}

// 从首条用户消息推导标题
export function deriveTitle(messages: Message[]): string {
  for (const m of messages) {
    if (m.role === "user") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) {
          const t = b.text.trim().replace(/\s+/g, " ");
          return t.length > 24 ? t.slice(0, 24) + "…" : t;
        }
      }
    }
  }
  return "新对话";
}
