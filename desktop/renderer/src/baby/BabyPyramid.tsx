// 数字婴儿 · 知识金字塔
// 后端睡觉时会把概念自组织成一座塔：底层是它一个个学来的具体概念，
// 往上每层都是聚类涌现出来的抽象认知，塔尖是"道"。这里把整座塔摊开：
// 谁抽象自谁一眼可见，还没被收编的碎知识用虚线单列出来。
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as Ic from "./icons.js";

type PNode = {
  name: string;
  desc?: string;
  parent?: string;
  children?: string[];
  depth?: number;
  isDao?: boolean;
  learnedAt?: number;
  source?: string;
};
type Data = { layers?: { depth: number; nodes: PNode[] }[]; stats?: Record<string, number> };

export function BabyPyramid({ data }: { data: Data | null }) {
  const [sel, setSel] = useState<string | null>(null);
  const [looseOnly, setLooseOnly] = useState(false);
  const [zoom, setZoom] = useState<"sm" | "md" | "lg">(
    () => (localStorage.getItem("minicc-baby-pyr-zoom") as any) || "md",
  );
  const setZ = (z: "sm" | "md" | "lg") => { setZoom(z); localStorage.setItem("minicc-baby-pyr-zoom", z); };
  const [q, setQ] = useState("");
  const [hitIdx, setHitIdx] = useState(0);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());

  const layers = data?.layers || [];
  const stats = data?.stats || {};
  const byName = useMemo(() => {
    const m = new Map<string, PNode>();
    for (const L of layers) for (const n of L.nodes) m.set(n.name, n);
    return m;
  }, [layers]);

  // 搜索：名字或它的理解里包含关键词就算命中
  const hits = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return [] as string[];
    const out: string[] = [];
    for (const L of layers)
      for (const n of L.nodes)
        if (n.name.toLowerCase().includes(k) || (n.desc || "").toLowerCase().includes(k)) out.push(n.name);
    return out;
  }, [q, layers]);
  const hitSet = useMemo(() => new Set(hits), [hits]);
  // 命中后自动选中当前那个 → 它的整条脉络被点亮，并滚到眼前
  const cur = hits.length ? hits[Math.min(hitIdx, hits.length - 1)] : null;
  useEffect(() => {
    if (!cur) return;
    setSel(cur);
    nodeRefs.current.get(cur)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cur]);

  // 选中一个节点时，把它的整条血脉(祖先 + 所有后代)点亮，其余压暗
  const lit = useMemo(() => {
    if (!sel) return null;
    const s = new Set<string>([sel]);
    const down = (nm: string) => {
      for (const c of byName.get(nm)?.children || []) {
        if (!s.has(c)) {
          s.add(c);
          down(c);
        }
      }
    };
    down(sel);
    let cur = byName.get(sel)?.parent;
    while (cur && !s.has(cur)) {
      s.add(cur);
      cur = byName.get(cur)?.parent;
    }
    return s;
  }, [sel, byName]);

  if (!data) return <div className="byp"><div className="byp-empty">正在读取它的知识金字塔…</div></div>;
  if (!layers.length)
    return <div className="byp"><div className="byp-empty">它还没学到东西，塔还没开始长。</div></div>;

  const top = layers[0];
  const maxDepth = Number(stats.depth || 0);

  // 数量核对：各层加起来应该正好等于它学过的全部概念数
  const sum = layers.reduce((a, L) => a + L.nodes.length, 0);
  const leafCount = layers.find((L) => L.depth === 0)?.nodes.length || 0;

  return (
    <div className={"byp zoom-" + zoom}>
      <div className="byp-sum">
        <span className="byp-sum-k">各层数量</span>
        {layers.filter((L) => L.depth > 0).map((L) => (
          <span key={L.depth}>第{L.depth}层 <b>{L.nodes.length}</b></span>
        ))}
        <span>地基 <b>{leafCount}</b></span>
        <span className="byp-sum-eq">
          合计 <b>{sum}</b> / 它学过 <b>{stats.total ?? sum}</b>
          {stats.total != null && sum !== stats.total ? "（对不上）" : "（对得上）"}
        </span>
        <span className="byp-sum-loose">还没固化 <b>{stats.loose ?? 0}</b></span>
        <div className="byp-find">
          <Ic.IcSearch size={13} />
          <input
            value={q}
            placeholder="搜一个概念，看它的整条脉络"
            onChange={(e) => { setQ(e.target.value); setHitIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits.length) setHitIdx((i) => (i + 1) % hits.length);
              if (e.key === "Escape") { setQ(""); setSel(null); }
            }}
          />
          {!!q && (
            <>
              <span className="byp-find-n">{hits.length ? `${Math.min(hitIdx, hits.length - 1) + 1}/${hits.length}` : "没找到"}</span>
              {hits.length > 1 && (
                <>
                  <button onClick={() => setHitIdx((i) => (i - 1 + hits.length) % hits.length)} title="上一个">↑</button>
                  <button onClick={() => setHitIdx((i) => (i + 1) % hits.length)} title="下一个 (Enter)">↓</button>
                </>
              )}
              <button onClick={() => { setQ(""); setSel(null); }} title="清空">×</button>
            </>
          )}
        </div>
        <div className="by-seg byp-zoom">
          {(["sm", "md", "lg"] as const).map((z) => (
            <button key={z} className={zoom === z ? "on" : ""} onClick={() => setZ(z)}>
              {z === "sm" ? "紧凑" : z === "md" ? "标准" : "放大"}
            </button>
          ))}
        </div>
      </div>

      {!stats.abstract && (
        <div className="byp-empty" style={{ padding: "10px 0 18px" }}>
          它还没把知识整理成塔——点右上角「整理知识」，让它把学过的东西自己理一遍。
        </div>
      )}

      {layers.map((L) => {
        const isLeaf = L.depth === 0;
        let ns = L.nodes;
        if (isLeaf && looseOnly) ns = ns.filter((n) => !n.parent);
        const shown = ns; // 全部铺开，不分页——要的就是"一眼看到全部"
        return (
          <div className="byp-layer" key={L.depth}>
            <div className="byp-layer-h">
              <span className="byp-layer-n">
                {isLeaf
                  ? "地基 · 它一个个学来的概念"
                  : L.depth === maxDepth
                    ? top.nodes.some((n) => n.isDao)
                      ? "塔尖 · 万物归一"
                      : `第 ${L.depth} 层 · 最高层认知`
                    : `第 ${L.depth} 层抽象`}
              </span>
              <span className="byp-layer-d">{ns.length} 个</span>
              <span className="byp-layer-line" />
              {isLeaf && (
                <button className="byp-more" onClick={() => setLooseOnly((v) => !v)}>
                  {looseOnly ? "看全部" : `只看还没固化的（${stats.loose || 0}）`}
                </button>
              )}
            </div>
            <div className="byp-row">
              {shown.map((n, i) => {
                const loose = isLeaf && !n.parent;
                const isHit = hitSet.has(n.name);
                const cls =
                  "byp-node" +
                  (n.isDao ? " dao" : "") +
                  (isLeaf ? " leaf" : L.depth === 1 ? " lv1" : "") +
                  (loose ? " loose" : "") +
                  (sel === n.name ? " on" : "") +
                  (isHit ? " hit" : "") +
                  (cur === n.name ? " hit-cur" : "") +
                  (lit && !lit.has(n.name) && !isHit ? " dim" : "");
                return (
                  <button
                    key={n.name}
                    ref={(el) => { if (el) nodeRefs.current.set(n.name, el); else nodeRefs.current.delete(n.name); }}
                    className={cls}
                    title={n.desc || n.name}
                    onClick={() => setSel(sel === n.name ? null : n.name)}
                  >
                    <span className="byp-idx">{i + 1}</span>
                    {n.isDao && <Ic.IcSparkle size={13} />}
                    {n.name}
                    {!!(n.children && n.children.length) && (
                      <span className="byp-node-n">{n.children.length}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {sel && byName.get(sel)?.desc && (
        <div className="bbg-detail" style={{ position: "static", width: "auto", marginTop: 6 }}>
          <div className="bbg-detail-h">
            {sel}
            <button onClick={() => setSel(null)}>
              <Ic.IcBack size={13} />
            </button>
          </div>
          <div className="bbg-detail-row">
            <b>它的理解</b>
            <div>{byName.get(sel)!.desc}</div>
          </div>
          {!!byName.get(sel)!.parent && (
            <div className="bbg-detail-row">
              <b>被抽象进</b>
              <div>{byName.get(sel)!.parent}</div>
            </div>
          )}
          {!!byName.get(sel)!.children?.length && (
            <div className="bbg-detail-row">
              <b>由这些收敛而来（{byName.get(sel)!.children!.length}）</b>
              <div>{byName.get(sel)!.children!.join("、")}</div>
            </div>
          )}
        </div>
      )}

      <div className="byp-foot">
        <span className="byp-legend">
          <span className="byp-swatch dao" />塔尖（万物归一）
        </span>
        <span className="byp-legend">
          <span className="byp-swatch" />睡梦里涌现的抽象层
        </span>
        <span className="byp-legend">
          <span className="byp-swatch loose" />还没固化的碎知识
        </span>
        <span className="byp-legend">点一个节点看它的血脉：往上归到哪、往下由谁收敛而来</span>
      </div>
    </div>
  );
}
