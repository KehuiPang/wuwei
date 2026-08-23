// 全局对话搜索：跨所有会话搜正文（问题/回复），给前端做「标题 + 上下文摘要 + 跳转锚点」。
//
// 为什么要单独建索引：~/.wuwei/sessions 里工具结果占了绝大头（实测 326MB 原始 JSON 里
// 只有 5MB 是 user/assistant 正文）。每次搜索都全量 JSON.parse 要 2.4s 且会阻塞主进程事件循环。
// 所以这里只抽正文建轻量索引落盘（~/.wuwei/search-index.json），之后：
//   · 冷启动第一次搜索：解析一遍全部会话（分文件 setImmediate 让出主线程，不饿死 IPC）；
//   · 之后只对 mtime/size 变了的会话重新解析；
//   · 正在跑的会话每步落盘都会调 noteSessionSaved()，直接拿内存里的 messages 增量更新，
//     不再解析那个动辄十几 MB 的文件。
import { readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), process.env.WUWEI_DATA_DIR_NAME || ".wuwei");
const SDIR = join(DIR, "sessions");
const IDX_FILE = join(DIR, "search-index.json");

const PER_SESSION = 4; // 单个会话最多返回几条命中（避免一个会话刷屏）
const MAX_HITS = 80; // 总条数上限
const PRE_CTX = 50; // 摘要里关键词前保留的字数
const POST_CTX = 90; // 摘要里关键词后保留的字数

// 一条可搜索正文：[消息序号, 锚点(用户消息="u" / 助手消息=内容块序号), 文本]
type Entry = [number, string | number, string];
interface SessionIdx {
  m: number; // 文件 mtimeMs
  s: number; // 文件大小
  n: number; // 已索引到第几条消息（增量更新用）
  e: Entry[];
}
interface IndexFile {
  v: number;
  sessions: Record<string, SessionIdx>;
}

export interface SearchHit {
  sid: string;
  title: string;
  updatedAt: number;
  role: "user" | "assistant" | "title";
  mi: number; // 消息序号（标题命中为 -1）
  anchor: string; // 前端定位锚点 "<消息序号>:u" / "<消息序号>:<块序号>"；标题命中为空
  pre: string; // 摘要：关键词之前
  match: string; // 摘要：命中的原文（大小写按原文）
  post: string; // 摘要：关键词之后
  more: number; // 同一条消息里还有多少处匹配
}
export interface SearchResult {
  hits: SearchHit[];
  total: number; // 总匹配处数（不受返回条数上限影响）
  sessions: number; // 命中的会话数
  truncated: boolean; // 是否因为上限截断了
}

let idx: IndexFile | null = null;
let dirty = false;
const memFresh = new Set<string>(); // 已由 noteSessionSaved 用内存数据更新过，无需再解析文件
let saveTimer: NodeJS.Timeout | null = null;
let freshening: Promise<void> | null = null; // 同一时刻只跑一次增量索引

function emptyIdx(): IndexFile {
  return { v: 1, sessions: {} };
}

async function loadIdx(): Promise<IndexFile> {
  if (idx) return idx;
  let loaded: IndexFile;
  try {
    const j = JSON.parse(await readFile(IDX_FILE, "utf8"));
    loaded = j && j.v === 1 && j.sessions ? (j as IndexFile) : emptyIdx();
  } catch {
    loaded = emptyIdx(); // 没索引/坏索引：从空开始，下面会重建
  }
  idx = loaded;
  return loaded;
}

// 索引落盘节流：任务跑起来时每步都会 saveSession→更新索引，
// 而索引整体有几 MB，写太勤纯属浪费 I/O。最多每分钟写一次；
// 万一没写成也不影响正确性——下次搜索发现 mtime 对不上，只会重解析那一个会话。
async function flushIdx(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!idx || !dirty) return;
  dirty = false;
  try {
    await writeFile(IDX_FILE, JSON.stringify(idx));
  } catch {
    /* 索引写盘失败不致命：下次搜索重建 */
  }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushIdx();
  }, 60_000);
}

// 从消息数组抽正文（只要 user/assistant 的 text 块；工具结果不进索引）
function extractEntries(messages: any[], from = 0): Entry[] {
  const out: Entry[] = [];
  for (let i = from; i < messages.length; i++) {
    const m = messages[i];
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    if (m.role === "user") {
      // 用户消息在前端合并成一条气泡显示 → 索引里也合并成一条
      let t = "";
      for (const b of content) if (b?.type === "text" && b.text) t += (t ? "\n" : "") + b.text;
      if (t.trim()) out.push([i, "u", t]);
    } else if (m.role === "assistant") {
      content.forEach((b: any, bi: number) => {
        if (b?.type === "text" && b.text && b.text.trim()) out.push([i, bi, b.text]);
      });
    }
  }
  return out;
}

// 会话落盘时顺手更新索引（拿现成的 messages，避免以后回头解析大文件）。
// 索引还没建立过就直接跳过：首次搜索时会统一解析，不在每步落盘的热路径上白干活。
export function noteSessionSaved(id: string, messages: any[]): void {
  if (!idx) return;
  const cur = idx.sessions[id];
  if (cur && messages.length >= cur.n) {
    // 增量：只重抽「最后一条已索引消息 + 新增的」（最后一条可能还在被补写）
    const from = Math.max(0, cur.n - 1);
    while (cur.e.length && (cur.e[cur.e.length - 1][0] as number) >= from) cur.e.pop();
    cur.e.push(...extractEntries(messages, from));
    cur.n = messages.length;
  } else {
    // 首次 / 历史被压缩或删过（变短）→ 整条重建
    idx.sessions[id] = { m: 0, s: 0, n: messages.length, e: extractEntries(messages) };
  }
  memFresh.add(id);
  dirty = true;
  scheduleSave();
}

// 会话被删除/彻底清除：从索引摘掉
export function dropFromIndex(id: string): void {
  if (!idx || !idx.sessions[id]) return;
  delete idx.sessions[id];
  memFresh.delete(id);
  dirty = true;
  scheduleSave();
}

// 把索引对齐到磁盘现状：删掉已不存在的会话，重新解析变过的会话。
export async function ensureFresh(ids: string[]): Promise<void> {
  if (freshening) return freshening; // 并发搜索共用同一次刷新
  freshening = (async () => {
    const ix = await loadIdx();
    const keep = new Set(ids);
    for (const id of Object.keys(ix.sessions)) {
      if (!keep.has(id)) {
        delete ix.sessions[id];
        dirty = true;
      }
    }
    for (const id of ids) {
      let st: { mtimeMs: number; size: number };
      try {
        st = await stat(join(SDIR, id + ".json"));
      } catch {
        continue; // 正文文件还没落盘（空会话）
      }
      const cur = ix.sessions[id];
      if (memFresh.has(id)) {
        // 内容已由内存更新过：只补记文件指纹，别再解析一遍
        memFresh.delete(id);
        if (cur) {
          cur.m = st.mtimeMs;
          cur.s = st.size;
          dirty = true;
          continue;
        }
      }
      if (cur && cur.m === st.mtimeMs && cur.s === st.size) continue;
      try {
        const msgs = JSON.parse(await readFile(join(SDIR, id + ".json"), "utf8"));
        if (Array.isArray(msgs)) {
          ix.sessions[id] = { m: st.mtimeMs, s: st.size, n: msgs.length, e: extractEntries(msgs) };
          dirty = true;
        }
      } catch {
        /* 坏文件跳过 */
      }
      await new Promise((r) => setImmediate(r)); // 每个大文件之间让出主线程，IPC/渲染不卡
    }
    if (dirty) await flushIdx(); // 搜索路径不是热路径：解析过就立刻落盘，下次开 app 免得重来
  })().finally(() => {
    freshening = null;
  });
  return freshening;
}

// 摘要用：把换行/多空白压成单空格，避免下拉里排版炸开
function flat(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function makeSnippet(text: string, pos: number, len: number) {
  const s = Math.max(0, pos - PRE_CTX);
  const e = Math.min(text.length, pos + len + POST_CTX);
  return {
    pre: (s > 0 ? "…" : "") + flat(text.slice(s, pos)),
    match: text.slice(pos, pos + len),
    post: flat(text.slice(pos + len, e)) + (e < text.length ? "…" : ""),
  };
}

export function searchSessions(
  query: string,
  metas: { id: string; title: string; updatedAt: number }[],
): SearchResult {
  const q = (query || "").trim().toLowerCase();
  const empty: SearchResult = { hits: [], total: 0, sessions: 0, truncated: false };
  if (!q || !idx) return empty;

  const hits: SearchHit[] = [];
  let total = 0;
  let sessionCount = 0;
  let truncated = false;
  const ordered = [...metas].sort((a, b) => b.updatedAt - a.updatedAt); // 最近用过的会话排前面

  for (const meta of ordered) {
    const si = idx.sessions[meta.id];
    const titleHit = (meta.title || "").toLowerCase().includes(q);
    if (!si && !titleHit) continue;
    let hitInThis = 0; // 本会话已发出的明细条数(受 PER_SESSION 限)
    let matched = titleHit; // 本会话是否有匹配(统计"命中几个会话",不受条数上限影响)

    if (titleHit) {
      total++;
      if (hits.length >= MAX_HITS) truncated = true; // 条数已封顶：只累计总数，不再发明细
      else {
        hitInThis++;
        const t = meta.title || "";
        const pos = t.toLowerCase().indexOf(q);
        hits.push({
          sid: meta.id,
          title: t,
          updatedAt: meta.updatedAt,
          role: "title",
          mi: -1,
          anchor: "",
          pre: t.slice(0, pos),
          match: t.slice(pos, pos + q.length),
          post: t.slice(pos + q.length),
          more: 0,
        });
      }
    }

    // 越新的消息越可能是用户在找的 → 从后往前扫
    for (let k = (si?.e.length ?? 0) - 1; k >= 0; k--) {
      const [mi, anchor, text] = si!.e[k];
      const low = text.toLowerCase();
      const pos = low.indexOf(q);
      if (pos < 0) continue;
      let count = 0;
      for (let p = pos; p >= 0; p = low.indexOf(q, p + q.length)) count++;
      total += count;
      matched = true;
      if (hitInThis >= PER_SESSION || hits.length >= MAX_HITS) {
        truncated = true;
        continue; // 仍继续数总数，只是不再返回明细
      }
      hitInThis++;
      hits.push({
        sid: meta.id,
        title: meta.title || "新对话",
        updatedAt: meta.updatedAt,
        role: anchor === "u" ? "user" : "assistant",
        mi,
        anchor: `${mi}:${anchor}`,
        ...makeSnippet(text, pos, q.length),
        more: count - 1,
      });
    }
    if (matched) sessionCount++;
  }
  return { hits, total, sessions: sessionCount, truncated };
}
