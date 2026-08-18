// 数字婴儿 · 状态卡
// 它此刻的样子(形象随活动状态变) + 生命体征(精力/开心/年龄/心跳/概念/好奇) + 唯一主操作。
// 数据全部来自后端 /alive/status，不再解析纯文本。
import React from "react";
import { BabyAvatar, inferBabyState, stripActivityEmoji, STATE_LABEL } from "./BabyAvatar.js";
import * as Ic from "./icons.js";

type Vitals = {
  alive?: boolean;
  age?: string;
  ticks?: number;
  energy?: number;
  mood?: string;
  happiness?: number;
  concepts?: number;
  curiosity?: number;
  activity?: string;
  wakeups?: number;
  recent?: string[];
};

export function BabyHero({
  vitals,
  alive,
  activity,
  busy,
  onToggleAlive,
}: {
  vitals: Vitals;
  alive: boolean;
  activity: string;
  busy: string;
  onToggleAlive: () => void;
}) {
  const state = inferBabyState(activity, alive);
  const ActIcon = Ic.ACTIVITY_ICON[state] || Ic.IcSparkle;
  const energy = Math.round(vitals.energy ?? 0);
  const happy = Math.round(vitals.happiness ?? 0);
  const said = stripActivityEmoji(activity) || STATE_LABEL[state];

  return (
    <div className={`by-s-${state}`}>
      <div className="by-hero">
        <div className="by-hero-art">
          <BabyAvatar
            state={state}
            happiness={vitals.happiness ?? 55}
            energy={vitals.energy ?? 100}
            alive={alive}
            size={104}
          />
        </div>
        <div className="by-hero-info">
          <div className="by-name">
            它
            <span className={"by-badge" + (alive ? " live" : "")}>{alive ? "活着" : "歇着"}</span>
            {vitals.mood && <span className="by-badge">{vitals.mood}</span>}
          </div>
          <div className="by-act">
            <span className="by-act-ico">
              <ActIcon size={15} />
            </span>
            <span className="by-act-txt">{said}</span>
          </div>
          <div className="by-sub">
            {vitals.age || "—"} · 第 {vitals.ticks ?? 0} 次心跳
          </div>
        </div>
      </div>

      <div className="by-bars">
        <div className="by-bar-row">
          <span className="by-bar-ico" style={{ color: "var(--warn)" }}>
            <Ic.IcBolt size={13} />
          </span>
          <span className="by-bar-lab">精力</span>
          <span className="by-bar energy">
            <span style={{ width: `${Math.max(0, Math.min(100, energy))}%` }} />
          </span>
          <span className="by-bar-num">{energy}</span>
        </div>
        <div className="by-bar-row">
          <span className="by-bar-ico" style={{ color: "var(--spark)" }}>
            <Ic.IcHeart size={13} />
          </span>
          <span className="by-bar-lab">开心</span>
          <span className="by-bar happy">
            <span style={{ width: `${Math.max(0, Math.min(100, happy))}%` }} />
          </span>
          <span className="by-bar-num">{happy}</span>
        </div>
      </div>

      <div className="by-stats">
        <Stat icon={<Ic.IcNodes size={14} />} v={vitals.concepts ?? 0} k="已学概念" />
        <Stat icon={<Ic.IcSprout size={14} />} v={vitals.curiosity ?? 0} k="好奇清单" />
        <Stat icon={<Ic.IcClock size={14} />} v={vitals.ticks ?? 0} k="心跳数" />
        <Stat icon={<Ic.IcSunrise size={14} />} v={vitals.wakeups ?? 0} k="醒来次数" />
      </div>

      {!!(vitals.recent && vitals.recent.length) && (
        <div className="by-recent">
          {vitals.recent.slice(-5).map((c) => (
            <span className="by-chip" key={c} title={c}>
              {c}
            </span>
          ))}
        </div>
      )}

      <button className={"by-primary" + (alive ? " on" : "")} onClick={onToggleAlive}>
        {alive ? <Ic.IcPause size={15} /> : <Ic.IcInfinity size={16} />}
        {alive ? "让它歇会儿" : "让它一直活着"}
      </button>
      {!!busy && (
        <div className="by-busy">
          <span className="by-spin">
            <Ic.IcRefresh size={13} />
          </span>
          {busy}
        </div>
      )}
    </div>
  );
}

function Stat({ icon, v, k }: { icon: React.ReactNode; v: number | string; k: string }) {
  return (
    <div className="by-stat">
      <span className="by-stat-ico">{icon}</span>
      <span>
        <span className="by-stat-v">{v}</span>
        <br />
        <span className="by-stat-k">{k}</span>
      </span>
    </div>
  );
}
