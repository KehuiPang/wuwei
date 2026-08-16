// 文档冷存储层：把知识宫殿等大文本目录分块 + 本地向量化，按需路由读原文。
// 概念网络（graph）负责"高价值概念点"的热索引；本层负责"需要细节时按需路由过去读的原文"。
//
// 存储架构（2026-07 从单个 33MB 的 docs.json 全量读写，改为分层增量）：
//   docs.jsonl      每块文本元数据一行(id/file/title/headingPath/text)，构建时覆盖写一次(文本，几 MB)
//   docs.vec        向量二进制：float32 定长记录，第 i 条对应 docs.jsonl 第 i 行；构建时逐批 append(真增量)
//   docs.meta.json  {version,dir,builtAt,dim,count}，count=已落盘的向量条数(断点续/加载以它为准)
//   docs.json       旧单文件格式：仅兼容读取/首启迁移的来源，迁移后保留作备份
// 为什么这么改：旧方案 (1) searchDocs/readDoc/docStats 每次调用都重读整个 33MB + JSON.parse；
//   (2) 构建时每批(16块)都把累积的全部块整写一遍 docs.json，建 3605 块要整写两百多次、写几百 MB 盘。
// 现在：读走内存缓存(只装载一次)；向量走紧凑二进制(3605块≈5.5MB，取代混在 JSON 里的向量)、逐批 append；
//   文本一次覆盖写。彻底告别大文件反复全量写。零 native 依赖。
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  copyFileSync,
  truncateSync,
} from "node:fs";
import { join, relative, extname } from "node:path";
import type { BrainDoc, BrainDocIndex } from "./types.js";
import { EMPTY_DOC_INDEX } from "./types.js";
import { BRAIN_DIR } from "./store.js";
import { embed, cosine } from "./embed.js";

export const DOCS_FILE = join(BRAIN_DIR, "docs.json"); // 旧格式：兼容读取/迁移来源
export const DOCS_JSONL = join(BRAIN_DIR, "docs.jsonl");
export const DOCS_VEC = join(BRAIN_DIR, "docs.vec");
export const DOCS_META = join(BRAIN_DIR, "docs.meta.json");

// brain_read_doc 的返回会显示在工具卡片里并进模型上下文，占位/截断提示要跟界面语言。
// 语言可运行时切换，所以调用时才求值，别固化成模块常量。
const tt = (zh: string, en: string) => (process.env.WUWEI_LANG === "en" ? en : zh);

const MAX_CHARS = 1100; // 单块目标上限：太长稀释语义、太短割裂上下文
const MIN_CHARS = 60; // 太短的碎块（单标题行等）并入相邻，不单独成块

interface DocsMeta {
  version: number;
  dir: string;
  builtAt: number;
  dim: number; // 向量维度(每条 float32 记录长度)
  count: number; // 已落盘向量条数(docs.vec 前 count 条有效)
}

// ——— 内存缓存单例：避免每次 searchDocs/readDoc/docStats 重读大文件 ———
let CACHE: BrainDocIndex | null = null;
export function invalidateDocsCache(): void {
  CACHE = null;
}

function ensureDir(): void {
  mkdirSync(BRAIN_DIR, { recursive: true });
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// 读文本元数据行(不含向量)
function readChunkLines(): BrainDoc[] {
  if (!existsSync(DOCS_JSONL)) return [];
  const out: BrainDoc[] = [];
  let raw = "";
  try {
    raw = readFileSync(DOCS_JSONL, "utf8");
  } catch {
    return [];
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as BrainDoc);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

// 覆盖写全部块文本(原子：tmp→rename)。一次写，不反复。
function writeChunkLines(chunks: BrainDoc[]): void {
  ensureDir();
  const body = chunks
    .map((c) => JSON.stringify({ id: c.id, file: c.file, title: c.title, headingPath: c.headingPath, text: c.text }))
    .join("\n");
  const tmp = DOCS_JSONL + ".tmp";
  writeFileSync(tmp, body ? body + "\n" : "", "utf8");
  renameSync(tmp, DOCS_JSONL);
}

// 把一批向量按顺序 append 到 docs.vec(float32 二进制)。返回本批条数。
function appendVectors(batch: number[][], dim: number): number {
  if (!batch.length) return 0;
  const f32 = new Float32Array(dim * batch.length);
  batch.forEach((v, i) => f32.set(v.slice(0, dim), i * dim));
  ensureDir();
  appendFileSync(DOCS_VEC, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  return batch.length;
}

function writeMeta(m: DocsMeta): void {
  ensureDir();
  const tmp = DOCS_META + ".tmp";
  writeFileSync(tmp, JSON.stringify(m), "utf8");
  renameSync(tmp, DOCS_META);
}

// 读 docs.vec 前 n 条向量(每条 dim 个 float32)，赋给 chunks[i].embedding
function attachVectors(chunks: BrainDoc[], dim: number, count: number): void {
  if (!dim || !count || !existsSync(DOCS_VEC)) return;
  let buf: Buffer;
  try {
    buf = readFileSync(DOCS_VEC);
  } catch {
    return;
  }
  const recs = Math.floor(buf.length / (dim * 4));
  const n = Math.min(recs, count, chunks.length);
  const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  for (let i = 0; i < n; i++) {
    chunks[i].embedding = Array.from(all.subarray(i * dim, i * dim + dim));
  }
}

// 从旧单文件 docs.json 迁移到新分层格式(备份旧文件，保留)。仅首启无新格式时触发。
function migrateLegacy(old: BrainDocIndex): void {
  const chunks = old.chunks || [];
  writeChunkLines(chunks);
  // 旧块可能各带向量：按顺序 append，dim 取第一条有向量的长度
  const withVec = chunks.filter((c) => c.embedding?.length);
  const dim = withVec.length ? withVec[0].embedding!.length : 0;
  try {
    if (existsSync(DOCS_VEC)) truncateSync(DOCS_VEC, 0);
  } catch {
    /* 无则忽略 */
  }
  let count = 0;
  if (dim) {
    // 只有当"前缀连续都有向量"时才逐条 append(向量按块顺序，遇到第一个缺向量即停，防止错位)
    const batch: number[][] = [];
    for (const c of chunks) {
      if (c.embedding?.length === dim) batch.push(c.embedding);
      else break;
    }
    count = appendVectors(batch, dim);
  }
  writeMeta({ version: 1, dir: old.dir || "", builtAt: old.builtAt || Date.now(), dim, count });
  try {
    const bak = DOCS_FILE + ".premigrate.bak";
    if (existsSync(DOCS_FILE) && !existsSync(bak)) copyFileSync(DOCS_FILE, bak);
  } catch {
    /* 备份失败不阻断 */
  }
}

// 装载文档索引(内存缓存)。优先新分层格式；否则迁移旧 docs.json；都没有=空。
export function loadDocIndex(): BrainDocIndex {
  if (CACHE) return CACHE;
  let idx: BrainDocIndex;
  if (existsSync(DOCS_JSONL) && existsSync(DOCS_META)) {
    const meta = readJson<DocsMeta>(DOCS_META);
    const chunks = readChunkLines();
    if (meta) attachVectors(chunks, meta.dim, meta.count);
    idx = { version: 1, dir: meta?.dir || "", builtAt: meta?.builtAt || 0, chunks };
  } else if (existsSync(DOCS_FILE)) {
    const old = readJson<BrainDocIndex>(DOCS_FILE);
    if (old && Array.isArray(old.chunks)) {
      migrateLegacy(old);
      idx = old; // 迁移前的内存态即最终态(含向量)
    } else {
      idx = { ...EMPTY_DOC_INDEX };
    }
  } else {
    idx = { ...EMPTY_DOC_INDEX };
  }
  CACHE = idx;
  return idx;
}

// 仅供测试：丢弃缓存，强制下次 loadDocIndex 从磁盘重载(模拟重启)
export function _resetDocsForTest(): void {
  CACHE = null;
}

// 递归收集目录下的 .md 文件（跳过隐藏目录/备份）
function collectMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (extname(e.name).toLowerCase() === ".md" && !/_bak(_|\.)/.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

// 把一个 markdown 文件按标题层级分块，块内超长按段落/字数硬切；保留标题面包屑
export function chunkMarkdown(raw: string, relPath: string): BrainDoc[] {
  const lines = raw.split("\n");
  const stack: { level: number; text: string }[] = []; // 标题栈，构造面包屑
  const chunks: BrainDoc[] = [];
  let buf: string[] = [];
  let curTitle = "";
  let curPath = "";

  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (text.length < MIN_CHARS && !chunks.length) return; // 开头零碎丢弃
    if (text.length < MIN_CHARS && chunks.length) {
      // 太短并入上一块（避免碎片）
      chunks[chunks.length - 1].text += "\n" + text;
      return;
    }
    // 超长按段落/字数硬切
    for (const piece of splitLong(text, MAX_CHARS)) {
      chunks.push({
        id: `${relPath}#${chunks.length}`,
        file: relPath,
        title: curTitle,
        headingPath: curPath,
        text: piece,
      });
    }
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush(); // 新标题前先收束当前块
      const level = m[1].length;
      const text = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
      curTitle = text;
      curPath = stack.map((s) => s.text).join(" › ");
      buf.push(line);
    } else {
      buf.push(line);
      if (buf.join("\n").length >= MAX_CHARS) flush();
    }
  }
  flush();
  return chunks;
}

// 超长文本按空行段落聚合到 ~max 一块；单段仍超长则按字数硬切
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && (cur + "\n\n" + p).length > max) {
      out.push(cur);
      cur = "";
    }
    if (p.length > max) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface BuildProgress {
  phase: "scan" | "embed" | "done";
  files?: number;
  total?: number;
  done?: number;
}

// 构建/重建索引：扫描目录 → 分块 → 文本一次覆盖写 → 向量逐批 append。onProgress 汇报进度。
// ★增量 + 断点续：复用旧索引里「同 id 且文本没变」的块向量(没改的文档不重算)；向量按块顺序
//   逐批 append 到 docs.vec、meta.count 随之推进 → 中途重启后从没算的续，不再从头、不再整写大文件。
export async function buildDocIndex(
  dir: string,
  onProgress?: (p: BuildProgress) => void,
): Promise<BrainDocIndex> {
  const files = collectMarkdown(dir);
  onProgress?.({ phase: "scan", files: files.length });
  const chunks: BrainDoc[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(f, "utf8");
      chunks.push(...chunkMarkdown(raw, relative(dir, f)));
    } catch {
      /* 跳过读不了的文件 */
    }
  }
  // 复用已有向量：key = 稳定 id + 文本内容(内容变了就重算)。旧索引同目录才复用。
  const prev = loadDocIndex();
  const reuse = new Map<string, number[]>();
  if (prev.dir === dir) {
    for (const c of prev.chunks) if (c.embedding?.length) reuse.set(c.id + " " + c.text, c.embedding);
  }

  // 文本一次覆盖写(几 MB)；向量从头逐批 append(复用的直接写回、缺的现算)，不再反复整写大文件
  writeChunkLines(chunks);
  try {
    if (existsSync(DOCS_VEC)) truncateSync(DOCS_VEC, 0);
  } catch {
    /* 无则忽略 */
  }
  let dim = reuse.size ? (reuse.values().next().value as number[]).length : 0;
  let count = 0;
  const flushMeta = () => writeMeta({ version: 1, dir, builtAt: Date.now(), dim, count });
  flushMeta();
  onProgress?.({ phase: "embed", total: chunks.length, done: 0 });

  const BATCH = 16;
  let broke = false;
  for (let i = 0; i < chunks.length && !broke; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const need = slice.filter((c) => !reuse.get(c.id + " " + c.text)); // 本批需现算的块
    if (need.length) {
      const vecs = await embed(
        need.map((c) => (c.headingPath ? c.headingPath + "\n" + c.text : c.text)),
        "passage",
      );
      if (!vecs) break; // 模型不可用：停在已落盘处，文本仍在(关键词检索)，下次续
      need.forEach((c, j) => (c.embedding = vecs[j]));
      if (!dim && vecs[0]) dim = vecs[0].length;
    }
    for (const c of slice) if (!c.embedding) c.embedding = reuse.get(c.id + " " + c.text); // 复用填回
    // 按块顺序 append；遇到无向量的块即停(保证向量与块顺序连续对齐，不错位)
    const toWrite: number[][] = [];
    for (const c of slice) {
      if (c.embedding?.length === dim) toWrite.push(c.embedding);
      else {
        broke = true;
        break;
      }
    }
    count += appendVectors(toWrite, dim);
    flushMeta(); // 推进 count，重启从这里续
    onProgress?.({ phase: "embed", total: chunks.length, done: count });
  }

  const idx: BrainDocIndex = { version: 1, dir, builtAt: Date.now(), chunks };
  CACHE = idx; // 直接更新缓存，避免下次重读
  onProgress?.({ phase: "done", total: chunks.length, done: count });
  return idx;
}

export interface DocHit {
  id: string;
  file: string;
  headingPath: string;
  snippet: string;
  score: number;
}

// 语义检索文档块（需要 query 向量；无向量时退化为关键词包含）
export async function searchDocs(query: string, limit = 4, preVec?: number[]): Promise<DocHit[]> {
  const idx = loadDocIndex();
  if (!idx.chunks.length) return [];
  const qv = preVec ? [preVec] : await embed([query], "query");
  let scored: { c: BrainDoc; score: number }[];
  if (qv) {
    scored = idx.chunks
      .filter((c) => c.embedding?.length)
      .map((c) => ({ c, score: cosine(qv[0], c.embedding!) }));
    scored.sort((a, b) => b.score - a.score);
    scored = scored.filter((s) => s.score >= 0.82).slice(0, limit); // 文档块绝对门槛，避免弱相关刷屏
  } else {
    const q = query.toLowerCase();
    scored = idx.chunks
      .filter((c) => c.text.toLowerCase().includes(q) || c.headingPath.toLowerCase().includes(q))
      .slice(0, limit)
      .map((c) => ({ c, score: 0 }));
  }
  return scored.map(({ c, score }) => ({
    id: c.id,
    file: c.file,
    headingPath: c.headingPath,
    snippet: c.text.length > 220 ? c.text.slice(0, 220) + "…" : c.text,
    score,
  }));
}

// 读原文：按 chunkId 或文件相对路径，返回整块/整文件（供 brain_read_doc 按需路由）
export function readDoc(idOrFile: string): string {
  const idx = loadDocIndex();
  if (!idx.dir) return tt("(尚未建立文档索引)", "(no document index built yet)");
  // 优先当 chunkId
  const chunk = idx.chunks.find((c) => c.id === idOrFile);
  if (chunk) {
    // 返回同文件全文更有用（一块往往不够）
    const full = readFullFile(idx.dir, chunk.file);
    return full ?? chunk.text;
  }
  // 当文件路径
  const byFile = readFullFile(idx.dir, idOrFile);
  if (byFile != null) return byFile;
  return tt(`(未找到：${idOrFile})`, `(not found: ${idOrFile})`);
}

function readFullFile(dir: string, relPath: string): string | null {
  try {
    const full = join(dir, relPath);
    // 防目录穿越：必须在 dir 内
    if (!full.startsWith(dir)) return null;
    statSync(full);
    const raw = readFileSync(full, "utf8");
    const MAX = 16000;
    return raw.length > MAX
      ? raw.slice(0, MAX) +
          tt(
            `\n…(已截断，全文 ${raw.length} 字符，路径 ${relPath})`,
            `\n…(truncated — full text is ${raw.length} chars, at ${relPath})`,
          )
      : raw;
  } catch {
    return null;
  }
}

export function docStats(): { chunks: number; files: number; dir: string; builtAt: number } {
  const idx = loadDocIndex();
  const files = new Set(idx.chunks.map((c) => c.file));
  return { chunks: idx.chunks.length, files: files.size, dir: idx.dir, builtAt: idx.builtAt };
}
