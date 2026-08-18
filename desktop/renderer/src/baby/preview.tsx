// 数字婴儿设计预览页（只在开发时用：npx vite desktop/renderer → /preview-baby.html）
// 目的：Electron 面板不方便反复看，这里把 9 种状态的形象、状态卡、金字塔一次性摊开，
// 主题也能切，改完设计先在这里验收再进面板。不打进产物(electron-vite 只 build index.html)。
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../theme.css";
import "./baby.css";
import { BabyAvatar, STATE_LABEL, type BabyState } from "./BabyAvatar.js";
import { BabyHero } from "./BabyHero.js";
import { BabyPyramid } from "./BabyPyramid.js";
import * as Ic from "./icons.js";

const STATES: BabyState[] = ["sleep", "search", "read", "think", "wonder", "talk", "listen", "daydream", "rest"];

const PYRAMID = {
  layers: [
    { depth: 3, nodes: [{ name: "道", desc: "万物归一，学的一切都归于此", children: ["计算与信息", "生命与心智"], depth: 3, isDao: true }] },
    {
      depth: 2,
      nodes: [
        { name: "计算与信息", desc: "关于计算、存储与信息流动的一切", parent: "道", children: ["分布式系统", "机器学习"], depth: 2 },
        { name: "生命与心智", desc: "关于生命、认知与情绪", parent: "道", children: ["神经科学"], depth: 2 },
      ],
    },
    {
      depth: 1,
      nodes: [
        { name: "分布式系统", desc: "多台机器协作完成一件事", parent: "计算与信息", children: ["一致性哈希", "Raft", "消息队列"], depth: 1 },
        { name: "机器学习", desc: "从数据里学规律", parent: "计算与信息", children: ["注意力机制", "反向传播"], depth: 1 },
        { name: "神经科学", desc: "脑子怎么工作", parent: "生命与心智", children: ["突触可塑性"], depth: 1 },
      ],
    },
    {
      depth: 0,
      nodes: [
        { name: "一致性哈希", desc: "把 key 映射到环上", parent: "分布式系统", learnedAt: 12 },
        { name: "Raft", desc: "一种共识算法", parent: "分布式系统", learnedAt: 11 },
        { name: "消息队列", desc: "异步解耦", parent: "分布式系统", learnedAt: 9 },
        { name: "注意力机制", desc: "让模型自己决定看哪里", parent: "机器学习", learnedAt: 15 },
        { name: "反向传播", desc: "误差往回传，调整权重", parent: "机器学习", learnedAt: 8 },
        { name: "突触可塑性", desc: "用进废退", parent: "神经科学", learnedAt: 6 },
        { name: "阿弥陀佛", desc: "还没归类的碎知识", parent: "", learnedAt: 20 },
        { name: "连读变调", desc: "还没归类", parent: "", learnedAt: 19 },
        { name: "涅槃", desc: "还没归类", parent: "", learnedAt: 18 },
      ],
    },
  ],
  stats: { total: 21, abstract: 6, concrete: 9, loose: 3, fresh: 3, depth: 3, ticks: 180, lastConsolidateTick: 170 },
};

function Preview() {
  const [theme, setTheme] = useState("dark");
  const [happy, setHappy] = useState(72);
  const [energy, setEnergy] = useState(64);
  React.useEffect(() => {
    if (theme === "dark") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div style={{ padding: 24, minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <span className="baby-brand">
          <span className="by-mark"><Ic.IcBaby size={17} /></span>数字婴儿 · 设计预览
        </span>
        <div className="by-seg">
          {["dark", "light", "gold"].map((t) => (
            <button key={t} className={theme === t ? "on" : ""} onClick={() => setTheme(t)}>{t}</button>
          ))}
        </div>
        <label style={{ fontSize: 12 }}>开心 {happy}
          <input type="range" min={0} max={100} value={happy} onChange={(e) => setHappy(+e.target.value)} />
        </label>
        <label style={{ fontSize: 12 }}>精力 {energy}
          <input type="range" min={0} max={100} value={energy} onChange={(e) => setEnergy(+e.target.value)} />
        </label>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 24 }}>
        {STATES.map((s) => (
          <div key={s} className={"baby-card by-s-" + s} style={{ width: 168, textAlign: "center", padding: "10px 6px" }}>
            <BabyAvatar state={s} happiness={happy} energy={energy} alive size={128} />
            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>{s}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>{STATE_LABEL[s]}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="baby-card" style={{ width: 384 }}>
          <div className="by-card-head">
            <span className="by-card-ico"><Ic.IcPulse size={15} /></span>
            <span className="by-card-t">状态</span>
            <span className="by-card-meta">活着</span>
            <span className="by-caret"><Ic.IcChevron size={15} /></span>
          </div>
          <div className="by-card-body">
            <BabyHero
              vitals={{ age: "1.6天大", ticks: 180, energy, mood: "超级开心", happiness: happy, concepts: 151, curiosity: 179, wakeups: 10, recent: ["哲学词汇表", "连读变调", "阿弥陀佛", "涅槃", "宝宝"] }}
              alive activity="🧠 正在消化理解「注意力机制」" busy="" onToggleAlive={() => {}}
            />
          </div>
        </div>
        <div className="baby-card" style={{ flex: 1, minWidth: 520, maxHeight: 620, overflow: "auto" }}>
          <div className="by-card-head">
            <span className="by-card-ico"><Ic.IcPyramid size={15} /></span>
            <span className="by-card-t">知识金字塔</span>
          </div>
          <BabyPyramid data={PYRAMID as any} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
