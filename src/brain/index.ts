// Brain 门面：对外统一的异步 API（工具层与主进程 IPC 都调这里）。
// 组合 store（图存取）+ embed（本地向量）实现：语义+关键词混合检索、
// 概念/关系的写入与纠错、命中强化、供系统提示用的"概念目录"。
import type { BrainGraph, BrainNode, BrainEdge } from "./types.js";
import {
  getGraph,
  persistEmbedding,
  persistNodeEdit,
  findNode,
  upsertNode,
  upsertEdge,
  reinforce,
  removeNode,
  removeEdge,
  normId,
  type NodeInput,
} from "./store.js";
import { embed, cosine, warmupEmbedder, embeddingReady } from "./embed.js";
import { searchDocs, readDoc, buildDocIndex, docStats, type BuildProgress } from "./docs.js";

export type { BrainGraph, BrainNode, BrainEdge } from "./types.js";
export { warmupEmbedder, embeddingReady } from "./embed.js";
export { BRAIN_DIR, GRAPH_FILE } from "./store.js";
export { readDoc, docStats, DOCS_FILE, loadDocIndex } from "./docs.js";
export type { BuildProgress } from "./docs.js";

// 文档冷存储扫描开关：主进程按设置 setDocsEnabled(...) 同步；关掉后 recall 不再连带扫『相关文档』。
let docsEnabled = true;
export function setDocsEnabled(on: boolean) {
  docsEnabled = on !== false;
}

// 构建/重建文档冷存储索引（知识宫殿等目录）
export async function buildDocs(dir: string, onProgress?: (p: BuildProgress) => void) {
  return buildDocIndex(dir, onProgress);
}

// 把节点编码用的文本（名+别名+类型+摘要+属性）拼成一段，供 embedding
function nodeText(n: BrainNode): string {
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => `${k}:${v}`)
    .join("；");
  return [n.name, n.aliases.join(" "), n.type, n.summary, attrs].filter(Boolean).join(" ");
}

// 确保节点有最新 embedding（缺失才算，批量）
async function ensureEmbeddings(nodes: BrainNode[]): Promise<void> {
  const need = nodes.filter((n) => !n.embedding || n.embedding.length === 0);
  if (!need.length) return;
  const vecs = await embed(need.map(nodeText), "passage");
  if (!vecs) return; // 模型不可用 → 保持无向量，检索退化为关键词
  need.forEach((n, i) => {
    n.embedding = vecs[i];
    persistEmbedding(n.id, vecs[i]); // 增量落盘该节点向量
  });
}

// 关键词命中打分：query 提到概念名/别名给高分（中文无分词，靠双向 includes）
function kwScore(query: string, n: BrainNode): number {
  const q = query.toLowerCase();
  const words = q.split(/[\s,，、。/:：()（）]+/).filter((w) => w.length >= 2);
  let s = 0;
  for (const nm of [n.name, ...n.aliases]) {
    const k = nm.toLowerCase();
    if (!k) continue;
    if (q.includes(k)) s += 3;
    else if (words.some((w) => k.includes(w) || w.includes(k))) s += 1;
  }
  return s;
}

function renderNode(n: BrainNode, edgesOut: { relation: string; to: string }[]): string {
  const lines = [`◆ ${n.name} [${n.type}]${n.summary ? " — " + n.summary : ""}`];
  for (const [k, v] of Object.entries(n.attrs)) lines.push(`   · ${k}: ${v}`);
  if (edgesOut.length) {
    const grp: Record<string, string[]> = {};
    for (const e of edgesOut) (grp[e.relation] ||= []).push(e.to);
    for (const [rel, tos] of Object.entries(grp)) lines.push(`   → ${rel}: ${tos.join("、")}`);
  }
  return lines.join("\n");
}

export interface RecallResult {
  text: string; // 给模型看的紧凑子图文本
  hitNames: string[]; // 命中的节点主名（供 UI/日志）
}

// 核心检索：query → 相关概念子图（不返回原文，省 token）。命中即强化。
export async function recall(query: string, limit = 6): Promise<RecallResult> {
  const g = getGraph();
  if (!g.nodes.length) return { text: "", hitNames: [] };

  await ensureEmbeddings(g.nodes);

  // 语义分（若模型可用）
  let semantic: Map<string, number> | null = null;
  const qv = await embed([query], "query");
  if (qv) {
    semantic = new Map();
    for (const n of g.nodes) if (n.embedding) semantic.set(n.id, cosine(qv[0], n.embedding));
  }

  // 综合分用于排序；语义减基线 0.76（e5 中文不相关基线≈0.79，相关≈0.9+）
  const SEM_STRONG = 0.84; // 纯语义种子的绝对门槛：低于此视为噪音，不单凭语义入选
  const scored = g.nodes.map((n) => {
    const kw = kwScore(query, n);
    const sem = semantic?.get(n.id) ?? 0;
    const score = kw + (sem > 0 ? Math.max(0, sem - 0.76) * 8 : 0);
    return { n, score, kw, sem };
  });
  scored.sort((a, b) => b.score - a.score);

  // 取种子：关键词命中，或语义足够强（绝对门槛，避免不相关概念因基线偏高被误召）
  const seeds = scored.filter((s) => s.kw > 0 || s.sem >= SEM_STRONG).slice(0, limit);

  // —— 概念子图（热索引）——
  let conceptText = "";
  const hitNames: string[] = [];
  if (seeds.length) {
    // 沿边扩展一跳：把种子的直接邻居也纳入（补全"部署脚本/服务器"等关联）
    const chosen = new Map<string, BrainNode>();
    const hitEdgeIds: string[] = [];
    for (const s of seeds) chosen.set(s.n.id, s.n);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const s of seeds) {
      for (const e of g.edges) {
        if (e.from === s.n.id) {
          hitEdgeIds.push(e.id);
          const nb = byId.get(e.to);
          if (nb && chosen.size < limit + 8) chosen.set(nb.id, nb);
        }
      }
    }
    const blocks: string[] = [];
    for (const n of chosen.values()) {
      const outs = g.edges
        .filter((e) => e.from === n.id)
        .map((e) => ({ relation: e.relation, to: byId.get(e.to)?.name || e.to }));
      blocks.push(renderNode(n, outs));
    }
    reinforce(g, [...chosen.keys()], hitEdgeIds); // 内部对命中实体各落一条增量日志
    conceptText = `【本地知识网络 · 命中】\n${blocks.join("\n")}`;
    hitNames.push(...seeds.map((s) => s.n.name));
  }

  // —— 文档冷存储（知识宫殿等原文块，需细节时路由过去读）——
  // 设置里关掉「扫描相关文档」后跳过，只返回概念子图。
  let docText = "";
  const docs = docsEnabled ? await searchDocs(query, 4, qv ? qv[0] : undefined) : [];
  if (docs.length) {
    docText =
      "【相关文档 · 需要细节用 brain_read_doc 读全文】\n" +
      docs
        .map((d) => `· ${d.file}${d.headingPath ? "  〖" + d.headingPath + "〗" : ""}\n  ${d.snippet}`)
        .join("\n");
  }

  return { text: [conceptText, docText].filter(Boolean).join("\n\n"), hitNames };
}

// 写入/更新一个概念节点（自动算 embedding）
export async function learn(input: NodeInput): Promise<{ created: boolean; name: string }> {
  const g = getGraph();
  const [node, created] = upsertNode(g, input); // 已落盘节点结构
  await ensureEmbeddings([node]); // 算完向量后增量落盘
  return { created, name: node.name };
}

// 建立/强化两个概念之间的关系（两端不存在会各自按名建一个占位节点）
export async function link(
  fromName: string,
  relation: string,
  toName: string,
): Promise<{ ok: boolean; msg: string }> {
  const g = getGraph();
  if (!findNode(g, fromName)) upsertNode(g, { name: fromName });
  if (!findNode(g, toName)) upsertNode(g, { name: toName });
  const e = upsertEdge(g, fromName, relation, toName); // 节点/边均已增量落盘
  if (!e) return { ok: false, msg: "关系两端相同或无法建立" };
  await ensureEmbeddings(g.nodes.filter((n) => !n.embedding));
  return { ok: true, msg: `${fromName} ──${relation}→ ${toName}` };
}

// 遗忘/纠错：删掉一个错误概念（连带其关系）
export function forget(name: string): boolean {
  return removeNode(getGraph(), name); // 内部落删除日志
}

// —— 供系统提示用的"概念目录"：高权重节点名，让模型知道有哪些可 recall ——
export function conceptIndex(max = 40): string[] {
  const g = getGraph();
  return [...g.nodes]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map((n) => n.name);
}

export function stats(): { nodes: number; edges: number; embedded: number } {
  const g = getGraph();
  return {
    nodes: g.nodes.length,
    edges: g.edges.length,
    embedded: g.nodes.filter((n) => n.embedding?.length).length,
  };
}

// —— 给设置面板用的读写（剥离 embedding，减小 IPC 体积）——
export interface GraphLite {
  nodes: Omit<BrainNode, "embedding">[];
  edges: BrainEdge[];
}
export function getGraphLite(): GraphLite {
  const g = getGraph();
  return {
    nodes: g.nodes.map(({ embedding, ...rest }) => rest),
    edges: g.edges,
  };
}

// UI 保存单个节点（手动编辑）：按 id 定位覆盖，内容变则作废向量
export async function saveNodeFromUI(patch: Partial<BrainNode> & { id?: string; name: string }): Promise<void> {
  const g = getGraph();
  const existing = patch.id ? g.nodes.find((n) => n.id === patch.id) : findNode(g, patch.name);
  if (existing) {
    Object.assign(existing, {
      name: patch.name ?? existing.name,
      aliases: patch.aliases ?? existing.aliases,
      type: patch.type ?? existing.type,
      summary: patch.summary ?? existing.summary,
      attrs: patch.attrs ?? existing.attrs,
      updatedAt: Date.now(),
      embedding: undefined,
    });
    persistNodeEdit(existing); // 落节点结构 + 作废旧向量
  } else {
    upsertNode(g, patch as NodeInput); // 已落盘
  }
  await ensureEmbeddings(g.nodes.filter((n) => !n.embedding)); // 重算向量并增量落盘
}

export function deleteNodeFromUI(id: string): void {
  const g = getGraph();
  const n = g.nodes.find((x) => x.id === id);
  if (n) removeNode(g, n.name); // 内部落删除日志
}

export function deleteEdgeFromUI(id: string): void {
  removeEdge(getGraph(), id); // 内部落删除日志
}

export async function addEdgeFromUI(fromName: string, relation: string, toName: string): Promise<void> {
  await link(fromName, relation, toName);
}
