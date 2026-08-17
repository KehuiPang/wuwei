// minicc 终端入口（P3：Ink TUI）。构造 Agent，渲染 <App/>。
import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import { makeProvider } from "./agent/provider.js";
import { Agent } from "./agent/loop.js";
import { systemPrompt } from "./agent/prompt.js";
import { ALL_TOOLS, TOOL_MAP } from "./tools/index.js";
import { App } from "./ui/app.js";

// CLI 没有设置界面，自己按系统语言定一次 WUWEI_LANG，内核里的 tt() 文案才跟得上。
// 逻辑与 desktop/main/settings.ts 的 detectSysLang 一致(src 不反向依赖 desktop，就地写一份)。
// 桌面端由 applyEnvFromSettings 写入，这里不覆盖已有值。
if (!process.env.WUWEI_LANG) {
  let lang = "zh";
  try {
    const opt = Intl.DateTimeFormat().resolvedOptions();
    const tz = (opt.timeZone || "").toLowerCase();
    const loc = (opt.locale || process.env.LC_ALL || process.env.LANG || "").toLowerCase();
    if (!/shanghai|chongqing|harbin|urumqi|kashgar|hong_kong|macau|taipei/.test(tz))
      lang = loc.startsWith("zh") ? "zh" : "en";
  } catch {
    /* 兜底中文（主力用户群）*/
  }
  process.env.WUWEI_LANG = lang;
}
const tt = (zh: string, en: string) => (process.env.WUWEI_LANG === "en" ? en : zh);

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  fail(
    tt(
      "minicc 需要在交互式终端(TTY)里运行。请打开 Terminal / iTerm，直接运行 minicc-pro。",
      "minicc needs an interactive terminal (TTY). Open Terminal / iTerm and run minicc-pro directly.",
    ),
  );
}

const cfg = loadConfig();
if (cfg.provider === "codex" && (!cfg.codexToken || !cfg.codexAccountId)) {
  fail(
    tt(
      "未取到 Codex 凭证。请先用 Codex app/CLI 以 ChatGPT 登录（~/.codex/auth.json），" +
        "或 export CODEX_ACCESS_TOKEN 和 CODEX_ACCOUNT_ID。",
      "No Codex credentials found. Sign in with the Codex app/CLI using ChatGPT first (~/.codex/auth.json), " +
        "or export CODEX_ACCESS_TOKEN and CODEX_ACCOUNT_ID.",
    ),
  );
}
if (cfg.provider === "anthropic" && cfg.authMode === "api-key" && !cfg.apiKey) {
  fail(
    tt(
      "未设置凭证。三选一：\n" +
        "  · API key : export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "  · 订阅OAuth: export MINICC_OAUTH_TOKEN=<access token>\n" +
        "  · 本地模型 : export MINICC_BASE_URL=http://<主机>:8000/v1 MINICC_MODEL=<名>",
      "No credentials set. Pick one:\n" +
        "  · API key    : export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "  · Subscription OAuth: export MINICC_OAUTH_TOKEN=<access token>\n" +
        "  · Local model: export MINICC_BASE_URL=http://<host>:8000/v1 MINICC_MODEL=<name>",
    ),
  );
}

const cwd = process.cwd();
const agent = new Agent(makeProvider(cfg), systemPrompt(cwd), ALL_TOOLS, { cwd }, TOOL_MAP, {
  compactThreshold: cfg.compactThreshold,
  keepRecent: cfg.keepRecentTurns,
});

const backend = cfg.provider === "anthropic" ? `anthropic/${cfg.authMode}` : cfg.provider;
render(<App agent={agent} provider={backend} model={cfg.model} />);
