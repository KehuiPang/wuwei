// Brain 图的持久化 + 增删改查 + 权重强化。
//
// 存储架构（2026-07 从「单文件 JSON 全量重写」改为增量）：
//   ~/.wuwei/brain/graph.snapshot.json  完整快照(含 embedding)，仅在压缩时原子写一次
//   ~/.wuwei/brain/graph.log.jsonl      增量日志，每次改动 append 一行(O(1)，不重写大文件)
//   ~/.wuwei/brain/graph.json           旧格式(兼容读取/首启迁移的来源，保留作历史备份)
//
// 为什么这么改：旧方案每次 brain_learn/brain_link/命中强化都 loadGraph→整文件覆盖，
// 大文件(含所有向量)反复重写、且并发时后写覆盖先写导致丢数据。现在：
//   1) 进程内维护「内存单例」——所有读写都在同一对象上，JS 单线程天然串行，不再相互覆盖；
//   2) 每次改动只 append 一条日志——增量、抗并发、崩溃可 replay 恢复；
//   3) 日志超阈值时压缩成新快照并截断日志——文件不无限膨胀。
// 零 native 依赖(不引入 better-sqlite3，沿用项目躲开 native 的一贯做法)。
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrainGraph, BrainNode, BrainEdge } from "./types.js";
import { EMPTY_GRAPH } from "./types.js";

// 目录可用 WUWEI_BRAIN_DIR 覆盖(自测用临时目录，不碰真实数据)；兼容旧 MINICC_BRAIN_DIR 测试变量。
export const BRAIN_DIR = process.env.WUWEI_BRAIN_DIR || process.env.MINICC_BRAIN_DIR || join(homedir(), process.env.WUWEI_DATA_DIR_NAME || ".wuwei", "brain");
export const GRAPH_FILE = join(BRAIN_DIR, "graph.json"); // 旧格式：兼容读取/迁移来源
export const SNAPSHOT_FILE = join(BRAIN_DIR, "graph.snapshot.json");
export const LOG_FILE = join(BRAIN_DIR, "graph.log.jsonl");

// 规范化成稳定 key：trim + 小写 + 折叠内部空白（中文原样保留）
export function normId(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// ——— 日志 op 类型（紧凑）———
// {t:1, n:node(无embedding)} 落/覆盖节点  | {t:2, e:edge} 落/覆盖边
// {t:3, i:id, v:number[]|null} 设/清 embedding | {t:4, i:id} 删节点 | {t:5, i:id} 删边
type Op =
  | { t: 1; n: Omit<BrainNode, "embedding"> }
  | { t: 2; e: BrainEdge }
  | { t: 3; i: string; v: number[] | null }
  | { t: 4; i: string }
  | { t: 5; i: string };

// ——— 内存单例 ———
let G: BrainGraph | null = null;
let logLines = 0; // 当前日志行数，用于触发压缩

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

// 把一条 op 叠加到 Map 态(replay 用)。节点 put 保留已有 embedding(embedding 由 t:3 单独管)。
function applyOp(nodeById: Map<string, BrainNode>, edgeById: Map<string, BrainEdge>, op: Op): void {
  switch (op.t) {
    case 1: {
      const prev = nodeById.get(op.n.id);
      nodeById.set(op.n.id, { ...(op.n as BrainNode), embedding: prev?.embedding });
      break;
    }
    case 2:
      edgeById.set(op.e.id, op.e);
      break;
    case 3: {
      const n = nodeById.get(op.i);
      if (n) {
        if (op.v) n.embedding = op.v;
        else delete n.embedding; // 内容变→作废旧向量
      }
      break;
    }
    case 4:
      nodeById.delete(op.i);
      break;
    case 5:
      edgeById.delete(op.i);
      break;
  }
}

// 启动装载：快照(优先) → 否则旧 graph.json(迁移，附带备份) → 否则空；再 replay 增量日志。
function boot(): BrainGraph {
  let base: BrainGraph | null = null;
  let migratedFromLegacy = false;

  if (existsSync(SNAPSHOT_FILE)) {
    base = readJson<BrainGraph>(SNAPSHOT_FILE);
  } else if (existsSync(GRAPH_FILE)) {
    base = readJson<BrainGraph>(GRAPH_FILE);
    if (base) {
      migratedFromLegacy = true;
      // 铁律：改库先备份。迁移前把旧文件另存一份(存在就不重复备份)
      try {
        const bak = GRAPH_FILE + ".premigrate.bak";
        if (!existsSync(bak)) copyFileSync(GRAPH_FILE, bak);
      } catch {
        /* 备份失败不阻断 */
      }
    }
  }
  if (!base || !Array.isArray(base.nodes) || !Array.isArray(base.edges)) {
    base = { ...EMPTY_GRAPH, nodes: [], edges: [] };
  }

  const nodeById = new Map(base.nodes.map((n) => [n.id, n] as const));
  const edgeById = new Map(base.edges.map((e) => [e.id, e] as const));
  logLines = 0;
  if (existsSync(LOG_FILE)) {
    const raw = (() => {
      try {
        return readFileSync(LOG_FILE, "utf8");
      } catch {
        return "";
      }
    })();
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        applyOp(nodeById, edgeById, JSON.parse(s) as Op);
        logLines++;
      } catch {
        /* 跳过坏行 */
      }
    }
  }

  const g: BrainGraph = {
    version: base.version || 1,
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()],
  };
  G = g;
  // 从旧格式迁移：立刻落一份快照走新路(旧 graph.json 保留作历史备份，不删)
  if (migratedFromLegacy) writeSnapshot();
  return g;
}

// 返回内存单例(懒加载)。所有读写都基于它。
export function getGraph(): BrainGraph {
  if (!G) return boot();
  return G;
}

// —— 增量落盘 ——
function append(op: Op): void {
  ensureDir();
  appendFileSync(LOG_FILE, JSON.stringify(op) + "\n", "utf8");
  logLines++;
  maybeCompact();
}

// 原子写完整快照(含 embedding) + 截断日志。tmp→rename 保证不写坏。
function writeSnapshot(): void {
  if (!G) return;
  ensureDir();
  const tmp = SNAPSHOT_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(G), "utf8");
  renameSync(tmp, SNAPSHOT_FILE);
  writeFileSync(LOG_FILE, "", "utf8"); // 清空日志
  logLines = 0;
}

// 日志远多于实体规模时压缩(至少 300 行才考虑，避免小图频繁压缩)
function maybeCompact(): void {
  if (!G) return;
  const budget = Math.max(300, (G.nodes.length + G.edges.length) * 3);
  if (logLines > budget) writeSnapshot();
}

// 供上层显式触发压缩(可选)
export function compact(): void {
  if (!G) getGraph();
  writeSnapshot();
}

function persistNode(n: BrainNode): void {
  const { embedding, ...rest } = n;
  append({ t: 1, n: rest });
}
// 设置/清除某节点向量并落盘(index.ts 的 ensureEmbeddings 算完后调)
export function persistEmbedding(id: string, vec: number[] | null): void {
  append({ t: 3, i: id, v: vec && vec.length ? vec : null });
}
function persistEdge(e: BrainEdge): void {
  append({ t: 2, e });
}

// ——— 查询 ———
// 按 id / 主名 / 别名（均规范化）定位节点
export function findNode(g: BrainGraph, key: string): BrainNode | undefined {
  const k = normId(key);
  return g.nodes.find(
    (n) => n.id === k || normId(n.name) === k || n.aliases.some((a) => normId(a) === k),
  );
}

export interface NodeInput {
  name: string;
  type?: string;
  summary?: string;
  aliases?: string[];
  attrs?: Record<string, string>;
}

// upsert：同名（或命中别名）则合并，否则新建。不计算 embedding（由上层门面填）。
// 改内存 + 落一条日志。返回 [节点, 是否新建]。
export function upsertNode(g: BrainGraph, input: NodeInput): [BrainNode, boolean] {
  const now = Date.now();
  let node = findNode(g, input.name);
  if (node) {
    if (input.type) node.type = input.type;
    if (input.summary) node.summary = input.summary;
    if (input.aliases?.length) {
      const set = new Set([...node.aliases.map(normId)]);
      for (const a of input.aliases) if (!set.has(normId(a)) && normId(a) !== node.id) node.aliases.push(a);
    }
    if (input.attrs) node.attrs = { ...node.attrs, ...input.attrs };
    node.updatedAt = now;
    node.embedding = undefined; // 内容变了 → 作废旧向量，上层重算
    persistNode(node);
    append({ t: 3, i: node.id, v: null }); // 同步作废日志里的旧向量
    return [node, false];
  }
  node = {
    id: normId(input.name),
    name: input.name.trim(),
    aliases: (input.aliases || []).filter((a) => normId(a) !== normId(input.name)),
    // 概念类型会显示在知识网络列表里，缺省值跟界面语言走
    type: input.type || (process.env.WUWEI_LANG === "en" ? "concept" : "概念"),
    summary: input.summary || "",
    attrs: input.attrs || {},
    weight: 1,
    hits: 0,
    createdAt: now,
    updatedAt: now,
  };
  g.nodes.push(node);
  persistNode(node);
  return [node, true];
}

function edgeId(fromId: string, relation: string, toId: string): string {
  return `${fromId}|${normId(relation)}|${toId}`;
}

// 建/强化一条关系边；from/to 用节点主名或别名解析。缺任一端则不建，返回 undefined。
export function upsertEdge(
  g: BrainGraph,
  fromKey: string,
  relation: string,
  toKey: string,
): BrainEdge | undefined {
  const from = findNode(g, fromKey);
  const to = findNode(g, toKey);
  if (!from || !to || from.id === to.id) return undefined;
  const now = Date.now();
  const id = edgeId(from.id, relation, to.id);
  let e = g.edges.find((x) => x.id === id);
  if (e) {
    e.updatedAt = now;
    persistEdge(e);
    return e;
  }
  e = { id, from: from.id, to: to.id, relation: relation.trim(), weight: 1, hits: 0, createdAt: now, updatedAt: now };
  g.edges.push(e);
  persistEdge(e);
  return e;
}

// 命中强化：被 recall 命中的节点/边 weight+hits 增长，越用越浮现（赫布式）。
// 只对受影响的实体各落一条日志(而非整图重写)。
export function reinforce(g: BrainGraph, nodeIds: string[], edgeIds: string[] = []): void {
  const now = Date.now();
  const ns = new Set(nodeIds);
  const es = new Set(edgeIds);
  for (const n of g.nodes)
    if (ns.has(n.id)) {
      n.hits += 1;
      n.weight += 1;
      n.lastHit = now;
      persistNode(n);
    }
  for (const e of g.edges)
    if (es.has(e.id)) {
      e.hits += 1;
      e.weight += 1;
      persistEdge(e);
    }
}

// 删节点（连带删除其所有边），各落删除日志(tombstone)
export function removeNode(g: BrainGraph, key: string): boolean {
  const node = findNode(g, key);
  if (!node) return false;
  const deadEdges = g.edges.filter((e) => e.from === node.id || e.to === node.id);
  g.nodes = g.nodes.filter((n) => n.id !== node.id);
  g.edges = g.edges.filter((e) => e.from !== node.id && e.to !== node.id);
  for (const e of deadEdges) append({ t: 5, i: e.id });
  append({ t: 4, i: node.id });
  return true;
}

export function removeEdge(g: BrainGraph, id: string): boolean {
  const before = g.edges.length;
  g.edges = g.edges.filter((e) => e.id !== id);
  const removed = g.edges.length < before;
  if (removed) append({ t: 5, i: id });
  return removed;
}

// UI 手动编辑覆盖节点结构后调用：落节点结构 + 作废旧向量(上层随后重算并 persistEmbedding)
export function persistNodeEdit(n: BrainNode): void {
  persistNode(n);
  append({ t: 3, i: n.id, v: null });
}

// —— 仅供测试：丢弃内存单例，强制下次 getGraph 从磁盘重新装载(模拟重启) ——
export function _resetForTest(): void {
  G = null;
  logLines = 0;
}
