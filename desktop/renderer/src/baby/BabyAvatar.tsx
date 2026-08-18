// 数字婴儿 · 形象与状态机
// 一个纯 SVG 婴儿：头大身小、眼睛低位、腮红——婴儿的比例特征。
// 它此刻在干嘛(后端 activity) → 9 种状态，每种换一套眼睛/嘴/配件/动画；
// 开心值决定嘴型与腮红浓度，精力决定眼睛睁开的程度(累了眼皮就耷拉)。
// 动画一律 CSS(见 baby.css)，不引第三方库；prefers-reduced-motion 下自动静止。
import React from "react";

export type BabyState =
  | "sleep" // 睡着了(做梦整理知识)
  | "search" // 上网搜资料
  | "read" // 在知识宫殿翻资料
  | "think" // 消化理解
  | "wonder" // 想学点什么 / 先猜猜
  | "talk" // 和主人聊天
  | "listen" // 竖起耳朵听
  | "daydream" // 发会儿呆
  | "rest"; // 歇着(没在自主学习)

/** 后端 activity 文案 → 状态。文案在 baby_life.py/baby_server.py 的 set_activity()。 */
export function inferBabyState(activity: string, alive: boolean): BabyState {
  const t = activity || "";
  if (t.includes("睡着") || t.includes("做梦")) return "sleep";
  if (t.includes("上网") || t.includes("搜索")) return "search";
  if (t.includes("知识宫殿") || t.includes("翻资料")) return "read";
  if (t.includes("消化") || t.includes("理解")) return "think";
  if (t.includes("猜猜") || t.includes("学点什么") || t.includes("接下来")) return "wonder";
  if (t.includes("聊天") || t.includes("陪主人")) return "talk";
  if (t.includes("听")) return "listen";
  if (t.includes("发呆") || t.includes("发会儿")) return "daydream";
  if (t.includes("歇着")) return "rest";
  return alive ? "think" : "rest";
}

/** 剥掉后端文案里的 emoji 前缀(界面统一用 SVG 图标，不出现 emoji)。 */
export function stripActivityEmoji(s: string): string {
  return (s || "").replace(/^[\p{Extended_Pictographic}️‍\s]+/u, "").trim();
}

/** 状态 → 一句中文说明(activity 为空时的兜底文案)。 */
export const STATE_LABEL: Record<BabyState, string> = {
  sleep: "睡着了，正在做梦整理知识",
  search: "上网找资料中",
  read: "在知识宫殿里翻书",
  think: "正在消化刚学的东西",
  wonder: "在想接下来学点什么",
  talk: "正在跟你说话",
  listen: "竖起耳朵在听",
  daydream: "发会儿呆",
  rest: "歇着呢",
};

type Props = {
  state: BabyState;
  happiness?: number; // 0-100
  energy?: number; // 0-100
  alive?: boolean;
  size?: number;
  /** 迷你尺寸(侧边折叠条)：只留脸，不画配件与光晕 */
  minimal?: boolean;
};

export function BabyAvatar({
  state,
  happiness = 55,
  energy = 100,
  alive = false,
  size = 108,
  minimal = false,
}: Props) {
  const sleeping = state === "sleep";
  const tired = energy <= 28 && !sleeping;
  // 眼型：睡→闭眼；很开心且醒着→弯月笑眼；累→半睁；其余睁眼
  const eye: "closed" | "happy" | "half" | "open" = sleeping
    ? "closed"
    : happiness >= 78
      ? "happy"
      : tired
        ? "half"
        : "open";
  // 眼珠朝向：思考/好奇/发呆往上看，搜索时左右扫
  const look = state === "think" || state === "wonder" || state === "daydream" ? -2.6 : 0;
  const scan = state === "search";
  const mouth: "o" | "talk" | "grin" | "smile" | "flat" | "sad" = sleeping
    ? "o"
    : state === "talk"
      ? "talk"
      : happiness >= 85
        ? "grin"
        : happiness >= 58
          ? "smile"
          : happiness >= 45
            ? "flat"
            : "sad";
  const cheek = Math.max(0.18, Math.min(0.5, happiness / 200 + 0.12));

  return (
    <svg
      className={`bb bb-s-${state}` + (alive ? " bb-alive" : "") + (minimal ? " bb-mini" : "")}
      width={size}
      height={size}
      viewBox="0 0 160 160"
      role="img"
      aria-label={`数字婴儿：${STATE_LABEL[state]}`}
    >
      {!minimal && (
        <g className="bb-halo-g">
          <circle className="bb-halo" cx="80" cy="82" r="66" />
          <circle className="bb-ring" cx="80" cy="82" r="66" />
        </g>
      )}

      <g className="bb-float">
        <g className="bb-breath">
          {/* 身体：襁褓包被 */}
          <path
            className="bb-suit"
            d="M80 99c-21 0-36 10.5-39 27.5-1.5 8-2.1 12.9-2.1 16.5h82.2c0-3.6-.6-8.5-2.1-16.5C116 109.5 101 99 80 99Z"
          />
          <path className="bb-suit-2" d="M54 133h52c.5 3.4.8 6.6.8 10H53.2c0-3.4.3-6.6.8-10Z" />
          {/* 小手 */}
          <circle className="bb-hand" cx="36" cy="122" r="9" />
          <circle className="bb-hand" cx="124" cy="122" r="9" />

          {/* 耳朵 */}
          <circle className="bb-ear" cx="38.5" cy="72" r="8.4" />
          <circle className="bb-ear" cx="121.5" cy="72" r="8.4" />
          {/* 头 */}
          <ellipse className="bb-head" cx="80" cy="66" rx="42" ry="39" />
          {/* 呆毛：一撮翘起来的胎毛 */}
          <path className="bb-hair" d="M76.6 29.2c-1.6-8.4 2.2-13.8 9.8-14.6-3.6 3.4-4.2 6.6-1.2 9.6-3.2.8-6.1 2.4-8.6 5Z" />

          {/* 眼睛 */}
          <g className={"bb-eyes" + (scan ? " bb-scan" : "")}>
            {[62, 98].map((cx) => (
              <g key={cx}>
                {eye === "closed" && (
                  <path className="bb-lid" d={`M${cx - 8.2} 74q8.2 7 16.4 0`} />
                )}
                {eye === "happy" && (
                  <path className="bb-lid" d={`M${cx - 8.2} 77.5q8.2 -9.4 16.4 0`} />
                )}
                {(eye === "open" || eye === "half") && (
                  <g className="bb-blink">
                    <ellipse
                      className="bb-eye"
                      cx={cx}
                      cy={74 + look * 0.2}
                      rx="6.2"
                      ry={eye === "half" ? 4 : 7.4}
                    />
                    <circle className="bb-glint" cx={cx - 2.1} cy={71.2 + look} r="2.2" />
                    {eye === "half" && (
                      <path className="bb-lid" d={`M${cx - 7.2} 70.8h14.4`} />
                    )}
                  </g>
                )}
              </g>
            ))}
          </g>

          {/* 腮红 */}
          <ellipse className="bb-cheek" cx="47" cy="87" rx="8" ry="5.2" style={{ opacity: cheek }} />
          <ellipse className="bb-cheek" cx="113" cy="87" rx="8" ry="5.2" style={{ opacity: cheek }} />

          {/* 嘴 */}
          {mouth === "o" && <ellipse className="bb-mouth-fill" cx="80" cy="92" rx="3.4" ry="4.2" />}
          {mouth === "talk" && (
            <ellipse className="bb-mouth-fill bb-talkmouth" cx="80" cy="92.5" rx="5" ry="4.4" />
          )}
          {mouth === "grin" && (
            <path className="bb-mouth-fill" d="M69 89.5h22c0 6.6-4.9 10.4-11 10.4S69 96.1 69 89.5Z" />
          )}
          {mouth === "smile" && <path className="bb-mouth" d="M71.5 90.5q8.5 7.4 17 0" />}
          {mouth === "flat" && <path className="bb-mouth" d="M73.5 93h13" />}
          {mouth === "sad" && <path className="bb-mouth" d="M71.5 95.5q8.5 -6.4 17 0" />}
        </g>
      </g>

      {!minimal && <Props_ state={state} />}
    </svg>
  );
}

/** 状态配件层：睡觉的 Zzz、搜索的放大镜、思考的气泡…… */
function Props_({ state }: { state: BabyState }) {
  if (state === "sleep")
    return (
      <g className="bb-acc">
        {[0, 1, 2].map((i) => (
          <path
            key={i}
            className={`bb-z bb-z-${i}`}
            d="M0 0h9l-9 11h9"
            transform={`translate(${112 + i * 9} ${44 - i * 13}) scale(${1 - i * 0.18})`}
          />
        ))}
      </g>
    );
  if (state === "search")
    return (
      <g className="bb-acc bb-orbit">
        <g transform="translate(124 34)">
          <circle className="bb-acc-line" cx="0" cy="0" r="9.4" />
          <path className="bb-acc-line" d="M6.8 6.8 13 13" />
        </g>
      </g>
    );
  if (state === "read")
    return (
      <g className="bb-acc bb-sway">
        <g transform="translate(118 30)">
          <path className="bb-acc-line" d="M-11 -7c3.6-1.4 7.4-1.4 11 .8 3.6-2.2 7.4-2.2 11-.8v15c-3.6-1.4-7.4-1.4-11 .8-3.6-2.2-7.4-2.2-11-.8v-15Z" />
          <path className="bb-acc-line" d="M0 -6.2v15" />
        </g>
      </g>
    );
  if (state === "think")
    return (
      <g className="bb-acc">
        <circle className="bb-dot bb-dot-0" cx="112" cy="34" r="3" />
        <circle className="bb-dot bb-dot-1" cx="122" cy="26" r="4" />
        <circle className="bb-dot bb-dot-2" cx="134" cy="17" r="5.2" />
      </g>
    );
  if (state === "wonder")
    return (
      <g className="bb-acc bb-pop">
        <g transform="translate(120 28)">
          <path className="bb-acc-line" d="M-4.6 -6.4a4.8 4.8 0 0 1 9.2 1.6c0 3.2-4.6 3.8-4.6 6.6" />
          <path className="bb-acc-line" d="M0 6.4h.01" />
        </g>
      </g>
    );
  if (state === "talk")
    return (
      <g className="bb-acc">
        {[0, 1, 2].map((i) => (
          <path
            key={i}
            className={`bb-wave bb-wave-${i}`}
            d={`M${118 + i * 7} ${86 - i * 5}a${8 + i * 6} ${8 + i * 6} 0 0 1 0 ${16 + i * 10}`}
          />
        ))}
      </g>
    );
  if (state === "listen")
    return (
      <g className="bb-acc">
        {[0, 1, 2].map((i) => (
          <path
            key={i}
            className={`bb-wave bb-wave-${i}`}
            d={`M${42 - i * 7} ${86 - i * 5}a${8 + i * 6} ${8 + i * 6} 0 0 0 0 ${16 + i * 10}`}
            transform="scale(1,1)"
          />
        ))}
      </g>
    );
  if (state === "daydream")
    return (
      <g className="bb-acc bb-drift">
        <path
          className="bb-acc-line"
          d="M108 32a7 7 0 0 1-.9-13.9 9.2 9.2 0 0 1 17.4-2.2A7 7 0 0 1 125.2 32Z"
        />
      </g>
    );
  return null;
}
