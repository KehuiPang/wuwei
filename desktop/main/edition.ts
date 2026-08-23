// 应用版本(edition) 解析 —— 必须在任何读数据目录的模块(sessions/settings/brain/…)之前 import，
// 因为 ESM 按 import 顺序初始化模块：本模块顶层副作用会先把 WUWEI_DATA_DIR_NAME / WUWEI_EDITION 写进
// process.env，之后那些模块顶层 `const DIR = homedir()/(env||".wuwei")` 求值时才能拿到正确目录名。
//
// 三个版本完全独立(appId / 数据目录 / 单实例锁 / 窗口标题)：
//   wuwei  正式版        数据目录 ~/.wuwei        appId com.wuwei.app
//   minicc 独立品牌      数据目录 ~/.minicc       appId com.minicc.app
//   test   测试版        数据目录 ~/.wuwei-test   appId com.wuwei.test
//          与正式版同代码/同线上库，但本地数据/单实例锁独立，可与正式版【同时运行】、互不干扰，
//          用于上线前本地验收改动(埋点等)。识别：--edition=test / WUWEI_EDITION=test / exe或appName 含 wuwei-test。
import { app } from "electron";

export type Edition = "wuwei" | "minicc" | "test";

function resolveEdition(): Edition {
  const fromArgv = process.argv.find((a) => a.startsWith("--edition="));
  let raw = (fromArgv ? fromArgv.split("=")[1] : "") || process.env.WUWEI_EDITION || "";
  if (!raw) {
    try {
      const exeName = (process.execPath || "").toLowerCase();
      const appName = (app.getName() || "").toLowerCase();
      if (exeName.includes("wuwei-test") || appName.includes("wuwei-test")) raw = "test";
      else if (exeName.includes("minicc") || appName.includes("minicc")) raw = "minicc";
    } catch {
      /* ignore */
    }
  }
  const v = raw.trim().toLowerCase();
  if (v === "minicc") return "minicc";
  if (v === "test") return "test";
  return "wuwei";
}

export const EDITION: Edition = resolveEdition();
export const IS_MINICC = EDITION === "minicc";
export const IS_TEST = EDITION === "test";
export const APP_NAME = IS_MINICC ? "minicc" : IS_TEST ? "wuwei-test" : "无为";
export const APP_ID = IS_MINICC ? "com.minicc.app" : IS_TEST ? "com.wuwei.test" : "com.wuwei.app";
export const DATA_DIR_NAME = IS_MINICC ? ".minicc" : IS_TEST ? ".wuwei-test" : ".wuwei";

// 关键副作用：在其它模块初始化前写入环境变量。
process.env.WUWEI_DATA_DIR_NAME = DATA_DIR_NAME;
process.env.WUWEI_EDITION = EDITION;

// ⚠️ 必须在 app.requestSingleInstanceLock() 之前 setName：
// 单实例锁按 userData 目录(%APPDATA%\<name>)区分唯一性，而 userData 目录名由 app.getName() 决定。
// 若 setName 拖到 whenReady 才做，test 版在拿锁那一刻 name 还是默认值、userData 仍指向正式版目录，
// 就会和正式版撞锁、拿不到锁而自杀 → dev 模式下 test 与正式版无法并存。提前到这里即可各拿各的锁。
try {
  app.setName(APP_NAME);
} catch {
  /* ignore */
}

// 窗口标题/托盘提示等「显示用」名字：英文界面显示 Wuwei。测试版加 [测试] 后缀便于与正式版区分。
// ⚠️ 只用于显示，绝不能拿去 app.setName()——那会改 userData 目录名，切个语言就把用户数据全丢了。
export function appDisplayName(): string {
  if (IS_MINICC) return "minicc";
  const base = process.env.WUWEI_LANG === "en" ? "Wuwei" : "无为";
  return IS_TEST ? `${base}[测试]` : base;
}
