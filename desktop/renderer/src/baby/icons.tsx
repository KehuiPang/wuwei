// 数字婴儿 · 图标系统（VI 标准的一部分）
// 规范：24×24 视框 / 线性描边 / stroke=currentColor / stroke-width 1.7 / 圆头圆角 / 不带填充色。
// 全部走 currentColor，颜色由外层文字色决定，天然适配 4 套主题(玄墨/月白/暖金/…)。
// 尺寸档：14(页脚小图标) 16(正文内联) 18(卡片标题) 20(标签页/主按钮)。
import React from "react";

type P = { size?: number; className?: string };

function S({ size = 16, className, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* ——— 导航 / 结构 ——— */
export const IcBaby = (p: P) => (
  <S {...p}>
    <path d="M12 3.5c-3.6 0-6.2 2.6-6.2 6.1 0 3.9 2.8 6.9 6.2 6.9s6.2-3 6.2-6.9c0-3.5-2.6-6.1-6.2-6.1Z" />
    <path d="M12 3.5V2" />
    <path d="M9.6 10.2h.01M14.4 10.2h.01" />
    <path d="M10.4 13.1c.9.7 2.3.7 3.2 0" />
    <path d="M7.5 19.5c1.2 1 2.8 1.5 4.5 1.5s3.3-.5 4.5-1.5" />
  </S>
);
export const IcHome = (p: P) => (
  <S {...p}>
    <path d="M3.5 10.5 12 4l8.5 6.5" />
    <path d="M5.5 9.6V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.6" />
    <path d="M10 20v-5h4v5" />
  </S>
);
export const IcBrain = (p: P) => (
  <S {...p}>
    <path d="M12 4.6c-3.9 0-7 2.8-7 6.4 0 2 1 3.8 2.5 5V19h9v-3c1.5-1.2 2.5-3 2.5-5 0-3.6-3.1-6.4-7-6.4Z" />
    <path d="M12 4.6V19" />
    <path d="M8.6 9.2c1.4.3 2.3 1.2 2.6 2.6M15.4 9.2c-1.4.3-2.3 1.2-2.6 2.6" />
  </S>
);
export const IcBack = (p: P) => (
  <S {...p}>
    <path d="M19 12H5" />
    <path d="M11 6l-6 6 6 6" />
  </S>
);
export const IcChevron = (p: P) => (
  <S {...p}>
    <path d="M6 9.5 12 15l6-5.5" />
  </S>
);
export const IcPanelLeft = (p: P) => (
  <S {...p}>
    <rect x="3.2" y="4.5" width="17.6" height="15" rx="2.4" />
    <path d="M10 4.5v15" />
    <path d="M6.9 10.4 5.5 12l1.4 1.6" />
  </S>
);
export const IcPanelRight = (p: P) => (
  <S {...p}>
    <rect x="3.2" y="4.5" width="17.6" height="15" rx="2.4" />
    <path d="M10 4.5v15" />
    <path d="M5.1 10.4 6.5 12l-1.4 1.6" />
  </S>
);
export const IcRefresh = (p: P) => (
  <S {...p}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v4h-4" />
  </S>
);
export const IcSend = (p: P) => (
  <S {...p}>
    <path d="M4.5 12h13" />
    <path d="M12.5 6.5 18.5 12l-6 5.5" />
  </S>
);

/* ——— 卡片标题 ——— */
export const IcPulse = (p: P) => (
  <S {...p}>
    <path d="M3 12.5h3.4l2-5.2 3.2 9.4 2.3-6 1.6 1.8H21" />
  </S>
);
export const IcSprout = (p: P) => (
  <S {...p}>
    <path d="M12 20v-7" />
    <path d="M12 13c0-2.8-2.1-5-4.8-5H5.4C5.4 11 7.6 13 10.3 13H12Z" />
    <path d="M12 13c0-2.4 1.9-4.4 4.3-4.4h2.3c0 2.4-1.9 4.4-4.3 4.4H12Z" />
  </S>
);
export const IcJournal = (p: P) => (
  <S {...p}>
    <path d="M5 4.6A1.6 1.6 0 0 1 6.6 3h11.8a1 1 0 0 1 1 1v14.4H6.6A1.6 1.6 0 0 0 5 20V4.6Z" />
    <path d="M5 18.4A1.6 1.6 0 0 0 6.6 21h12.8" />
    <path d="M9 7.6h6.4M9 11h4.6" />
  </S>
);
export const IcChat = (p: P) => (
  <S {...p}>
    <path d="M20.5 11.6c0 3.9-3.8 7-8.5 7-.9 0-1.8-.1-2.6-.3L4 20l1.3-3.4C4.1 15.3 3.5 13.5 3.5 11.6c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" />
  </S>
);

/* ——— 生命 / 主操作 ——— */
export const IcInfinity = (p: P) => (
  <S {...p}>
    <path d="M8.4 8.6c2 0 2.6 3.4 4.6 3.4s2.6-3.4 4.6-3.4a3.4 3.4 0 0 1 0 6.8c-2 0-2.6-3.4-4.6-3.4S10.4 15.4 8.4 15.4a3.4 3.4 0 0 1 0-6.8Z" />
  </S>
);
export const IcPause = (p: P) => (
  <S {...p}>
    <path d="M9.5 5.5v13M14.5 5.5v13" />
  </S>
);

/* ——— 生命体征指标 ——— */
export const IcBolt = (p: P) => (
  <S {...p}>
    <path d="M13.2 3 5.8 13.2h5L10.2 21l7.6-10.4h-5L13.2 3Z" />
  </S>
);
export const IcHeart = (p: P) => (
  <S {...p}>
    <path d="M12 20.2c-2.1-1.5-8-5.5-8-10a4.4 4.4 0 0 1 8-2.5 4.4 4.4 0 0 1 8 2.5c0 4.5-5.9 8.5-8 10Z" />
  </S>
);
export const IcNodes = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="5.5" r="2.3" />
    <circle cx="5.5" cy="17" r="2.3" />
    <circle cx="18.5" cy="17" r="2.3" />
    <path d="M10.4 7.4 7 14.9M13.6 7.4 17 14.9M7.8 17h8.4" />
  </S>
);
export const IcSunrise = (p: P) => (
  <S {...p}>
    <path d="M3.5 18.5h17" />
    <path d="M7.4 14.6a4.6 4.6 0 0 1 9.2 0" />
    <path d="M12 3v3.2M5.2 6.2l1.6 1.6M18.8 6.2l-1.6 1.6" />
  </S>
);
export const IcClock = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.4V12l3.1 2" />
  </S>
);

/* ——— 它在干嘛（活动状态） ——— */
export const IcMoon = (p: P) => (
  <S {...p}>
    <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z" />
  </S>
);
export const IcSearch = (p: P) => (
  <S {...p}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="M15.4 15.4 20 20" />
  </S>
);
export const IcBook = (p: P) => (
  <S {...p}>
    <path d="M3.6 5.2c2.7-1 5.6-1 8.4.6 2.8-1.6 5.7-1.6 8.4-.6v12.6c-2.7-1-5.6-1-8.4.6-2.8-1.6-5.7-1.6-8.4-.6V5.2Z" />
    <path d="M12 5.8v12.6" />
  </S>
);
export const IcQuestion = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M9.7 9.6a2.4 2.4 0 0 1 4.6.8c0 1.6-2.3 1.9-2.3 3.3" />
    <path d="M12 17.1h.01" />
  </S>
);
export const IcEar = (p: P) => (
  <S {...p}>
    <path d="M7 9.2a5 5 0 0 1 10 0c0 2.6-2.2 3.4-3.2 4.6-.8 1-.4 2.4-1.6 3.2" />
    <path d="M9.9 9.4a2.1 2.1 0 0 1 4.2 0" />
    <path d="M7.6 14.6C7 16.4 7.4 19 9.5 20.4" />
  </S>
);
export const IcCloud = (p: P) => (
  <S {...p}>
    <path d="M7.4 18.4a3.9 3.9 0 0 1-.5-7.8 5.1 5.1 0 0 1 9.7-1.2 3.9 3.9 0 0 1 .4 7.8Z" />
  </S>
);
export const IcLeaf = (p: P) => (
  <S {...p}>
    <path d="M5 19c-1.4-6.4 2.6-11.6 14-12-1 8.4-5.2 12.4-11.4 12.4" />
    <path d="M7 17.4c1.8-3.6 4.4-6 8-7.4" />
  </S>
);
export const IcSparkle = (p: P) => (
  <S {...p}>
    <path d="M12 3.6 13.5 9l5.4 1.5-5.4 1.5L12 17.4 10.5 12 5.1 10.5 10.5 9 12 3.6Z" />
    <path d="M18.6 16.4 19.3 18.6l2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7.7-2.2Z" />
  </S>
);

export const IcPyramid = (p: P) => (
  <S {...p}>
    <path d="M12 3.4 3.2 20.6h17.6L12 3.4Z" />
    <path d="M7.4 12h9.2M5.3 16.3h13.4" />
  </S>
);
export const IcExpand = (p: P) => (
  <S {...p}>
    <path d="M9 3.6H3.6V9M15 3.6h5.4V9M9 20.4H3.6V15M15 20.4h5.4V15" />
  </S>
);
export const IcShrink = (p: P) => (
  <S {...p}>
    <path d="M3.6 9H9V3.6M20.4 9H15V3.6M3.6 15H9v5.4M20.4 15H15v5.4" />
  </S>
);
export const IcLayers = (p: P) => (
  <S {...p}>
    <path d="M12 3.6 3.4 8 12 12.4 20.6 8 12 3.6Z" />
    <path d="M3.4 12.4 12 16.8l8.6-4.4M3.4 16.6 12 21l8.6-4.4" />
  </S>
);

/* 活动状态 → 图标（跟 BabyAvatar 的状态机同一套 key） */
export const ACTIVITY_ICON: Record<string, (p: P) => React.JSX.Element> = {
  sleep: IcMoon,
  search: IcSearch,
  read: IcBook,
  think: IcBrain,
  wonder: IcQuestion,
  talk: IcChat,
  listen: IcEar,
  daydream: IcCloud,
  rest: IcLeaf,
};
