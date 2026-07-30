import React, { useEffect, useState } from "react";

/**
 * 无为 · 开屏启动动画（整屏遮罩）
 *
 * 玄墨黑底 → ensō 圆相一笔描成（月白笔）→ 收笔落「一点朱」→「无为」+ slogan 依次浮现 → 定格 → 淡出进主界面。
 * 主窗口原生底色已是玄墨黑(#16191e)，与此遮罩同底 → 从窗口打开到圆相描绘无缝衔接，盖住渲染层加载的黑色中间态。
 *
 * 设计定稿：wuwei-site/design/splash/（董事长 2026-07-30 确认）。
 * ⚠️ Logo 关键约束：圆相直接采用官方主标矢量几何，禁止改成近似版——
 *   path `M152.04 193.48 A82 82 0 1 1 195.48 150.04`（82r 圆弧，月白 #F4F6F8，笔宽 9.5，圆头）
 *   一点朱 `circle cx=195.48 cy=150.04 r=7.6 fill=#C05F3C`（收笔右端），整组 rotate(-8 120 118)，viewBox 0 0 240 240。
 *
 * 每次启动只播一次（sessionStorage 门控：Electron 每次启动是全新 renderer 会话 → 播；HMR/重渲染不复播）。
 * 已做 prefers-reduced-motion 降级。
 */

const SPLASH_KEY = "wuwei_splash_shown";
const HOLD_MS = 2400; // 动画定格保持后开始淡出
const HOLD_MS_REDUCED = 500; // 降级：几乎直接进主界面
const FADE_MS = 560; // 淡出时长（与 CSS transition 对齐）

export function Splash() {
  // 首次挂载即决定：本次启动没播过才播（避免 HMR / 重渲染复播）
  const [phase, setPhase] = useState<"play" | "fade" | "done">(() => {
    try {
      return sessionStorage.getItem(SPLASH_KEY) ? "done" : "play";
    } catch {
      return "play";
    }
  });

  useEffect(() => {
    if (phase !== "play") return;
    try {
      sessionStorage.setItem(SPLASH_KEY, "1");
    } catch {
      /* 隐私模式等无 sessionStorage：仍正常播这一次 */
    }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const t = setTimeout(() => setPhase("fade"), reduce ? HOLD_MS_REDUCED : HOLD_MS);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "fade") return;
    const t = setTimeout(() => setPhase("done"), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "done") return null;

  return (
    <div
      className={"wsplash" + (phase === "fade" ? " wsplash--out" : "")}
      role="img"
      aria-label="无为一念之门圆相 · 启动动画"
    >
      <style>{SPLASH_CSS}</style>
      <section className="wsplash-lockup">
        <svg className="wsplash-mark" viewBox="0 0 240 240" aria-hidden="true">
          <g transform="rotate(-8 120 118)">
            {/* 官方主标几何：82r 圆弧描边动画（stroke-dashoffset 1→0） */}
            <path className="wsplash-enso" pathLength={1} d="M152.04 193.48 A82 82 0 1 1 195.48 150.04" />
            {/* 收笔一点朱：在圆相描完后点上 */}
            <circle className="wsplash-spark" cx={195.48} cy={150.04} r={7.6} />
          </g>
        </svg>

        <div className="wsplash-word">
          <h1 className="wsplash-brand">无为</h1>
          <p className="wsplash-slogan">一念既出，万事自成。</p>
        </div>
        <div className="wsplash-line" aria-hidden="true" />
      </section>
    </div>
  );
}

const SPLASH_CSS = `
.wsplash {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #F4F6F8;
  background:
    linear-gradient(180deg, rgba(244, 246, 248, 0.045), transparent 35%),
    linear-gradient(145deg, #12151A 0%, #16191E 46%, #1A2027 100%);
  font-family: "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  transition: opacity ${FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1);
}
.wsplash--out { opacity: 0; pointer-events: none; }

/* 细栅格底纹（低存在感） */
.wsplash::before {
  position: absolute;
  inset: 0;
  content: "";
  pointer-events: none;
  background:
    linear-gradient(90deg, rgba(244, 246, 248, 0.035) 1px, transparent 1px),
    linear-gradient(180deg, rgba(244, 246, 248, 0.026) 1px, transparent 1px);
  background-size: 96px 96px;
  -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 22%, #000 78%, transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0%, #000 22%, #000 78%, transparent 100%);
  opacity: 0.26;
}

.wsplash-lockup {
  position: relative;
  z-index: 1;
  display: grid;
  justify-items: center;
  gap: 30px;
  transform: translateY(8px);
  animation: wsplash-settle 2.1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
}

.wsplash-mark {
  width: clamp(140px, 23vmin, 216px);
  aspect-ratio: 1;
  display: block;
  overflow: visible;
  filter: drop-shadow(0 22px 44px rgba(0, 0, 0, 0.26));
}

/* 官方主标几何：82r 圆弧 + 收笔一点朱，整体 -8° 微倾 */
.wsplash-enso {
  fill: none;
  stroke: #F4F6F8;
  stroke-width: 9.5;
  stroke-linecap: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: wsplash-draw 1.28s cubic-bezier(0.32, 0.02, 0.12, 1) 0.15s forwards;
}

.wsplash-spark {
  fill: #C05F3C;
  opacity: 0;
  transform: scale(0.2);
  transform-origin: 195.48px 150.04px;
  transform-box: view-box;
  animation: wsplash-spark 0.62s cubic-bezier(0.2, 0.9, 0.2, 1) 1.28s forwards;
}

.wsplash-word { display: grid; justify-items: center; gap: 12px; }

.wsplash-brand {
  margin: 0;
  color: #F4F6F8;
  font-size: clamp(28px, 5vmin, 46px);
  font-weight: 500;
  letter-spacing: 0.02em;
  line-height: 1;
  opacity: 0;
  transform: translateY(12px);
  animation: wsplash-reveal 0.82s ease-out 1.18s forwards;
}

.wsplash-slogan {
  margin: 0;
  color: rgba(244, 246, 248, 0.74);
  font-size: clamp(14px, 2.2vmin, 18px);
  font-weight: 400;
  line-height: 1.6;
  opacity: 0;
  transform: translateY(10px);
  animation: wsplash-reveal 0.9s ease-out 1.38s forwards;
}
.wsplash-slogan::before,
.wsplash-slogan::after {
  display: inline-block;
  width: 24px;
  height: 1px;
  margin: 0 13px 4px;
  content: "";
  background: rgba(183, 192, 199, 0.34);
}

.wsplash-line {
  width: min(192px, 42vw);
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(111, 159, 173, 0.45), transparent);
  opacity: 0;
  transform: scaleX(0.4);
  animation: wsplash-quiet 0.8s ease-out 1.7s forwards;
}

@keyframes wsplash-draw {
  0%   { stroke-dashoffset: 1; opacity: 0.32; }
  22%  { opacity: 1; }
  100% { stroke-dashoffset: 0; opacity: 1; }
}
@keyframes wsplash-spark {
  0%   { opacity: 0; transform: scale(0.2); }
  55%  { opacity: 1; transform: scale(1.22); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes wsplash-reveal { 100% { opacity: 1; transform: translateY(0); } }
@keyframes wsplash-quiet  { 100% { opacity: 1; transform: scaleX(1); } }
@keyframes wsplash-settle { 100% { transform: translateY(0); } }

@media (prefers-reduced-motion: reduce) {
  .wsplash *, .wsplash *::before, .wsplash *::after {
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
  }
}
`;
