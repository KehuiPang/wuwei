// 工具集：每个工具 = JSON Schema（给模型）+ 本地执行函数。
// P1 版：Read / Write / Edit / Bash / Glob / Grep —— 覆盖"读代码、改文件、跑命令、搜索"。
import { promises as fs } from "node:fs";
import { resolve, isAbsolute, join, dirname } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "../types.js";
import * as brain from "../brain/index.js";

// 全局记忆文件：跨会话持久，注入到每次对话的系统提示词
export const MEMORY_FILE = join(homedir(), ".wuwei", "memory.md");

const pexec = promisify(exec);

function abs(ctx: ToolContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

// ---- Read ----
const readTool: Tool = {
  name: "read_file",
  description: "读取文本文件内容，返回带行号的内容。用于查看代码/文件。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（相对或绝对）" },
      offset: { type: "number", description: "起始行(1基)，可选" },
      limit: { type: "number", description: "读取行数，默认 2000" },
    },
    required: ["path"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const raw = await fs.readFile(abs(ctx, String(input.path)), "utf8");
      const lines = raw.split("\n");
      const offset = Math.max(1, Number(input.offset ?? 1));
      const limit = Number(input.limit ?? 2000);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice
        .map((l, i) => `${String(offset + i).padStart(6)}\t${l}`)
        .join("\n");
      return { content: body || "(空文件)" };
    } catch (e: any) {
      return { content: `读取失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Write ----
const writeTool: Tool = {
  name: "write_file",
  description: "写入/覆盖文件（不存在则创建，含父目录）。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const target = abs(ctx, String(input.path));
      await fs.mkdir(resolve(target, ".."), { recursive: true });
      await fs.writeFile(target, String(input.content), "utf8");
      return { content: `已写入 ${target}` };
    } catch (e: any) {
      return { content: `写入失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Edit（精确字符串替换）----
const editTool: Tool = {
  name: "edit_file",
  description: "对文件做精确字符串替换。old_string 必须在文件中唯一出现，否则报错。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean", description: "替换全部出现，默认 false" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const target = abs(ctx, String(input.path));
      const raw = await fs.readFile(target, "utf8");
      const oldStr = String(input.old_string);
      const newStr = String(input.new_string);
      const count = raw.split(oldStr).length - 1;
      if (count === 0) return { content: "未找到 old_string，未修改", isError: true };
      if (count > 1 && !input.replace_all)
        return {
          content: `old_string 出现 ${count} 次不唯一；请加长上下文或设 replace_all`,
          isError: true,
        };
      const next = input.replace_all
        ? raw.split(oldStr).join(newStr)
        : raw.replace(oldStr, newStr);
      await fs.writeFile(target, next, "utf8");
      return { content: `已编辑 ${target}（替换 ${input.replace_all ? count : 1} 处）` };
    } catch (e: any) {
      return { content: `编辑失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Bash ----
const bashTool: Tool = {
  name: "bash",
  description: "在工作目录执行 shell 命令（macOS/bash），返回 stdout+stderr。默认超时 120s。",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "number", description: "超时毫秒，默认 120000" },
    },
    required: ["command"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const { stdout, stderr } = await pexec(String(input.command), {
        cwd: ctx.cwd,
        timeout: Number(input.timeout_ms ?? 120000),
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
        signal: ctx.signal, // 用户停止→杀子进程,别再干等超时
        // 本地密钥以环境变量注入子进程：模型只写 $OPENAI_API_KEY 即可，全程不接触明文
        env: ctx.env ? { ...process.env, ...ctx.env } : process.env,
      });
      const out = [stdout, stderr].filter(Boolean).join("\n").trim();
      return { content: out || "(无输出)" };
    } catch (e: any) {
      const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
      return { content: out || `执行失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Glob（文件名匹配，借 bash+find/ripgrep 更稳，这里用简单 find）----
const globTool: Tool = {
  name: "glob",
  description: "按 glob 模式查找文件（如 '**/*.ts'），返回匹配路径列表。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "搜索根目录，默认工作目录" },
    },
    required: ["pattern"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const root = input.path ? abs(ctx, String(input.path)) : ctx.cwd;
      const results: string[] = [];
      const pattern = String(input.pattern);
      await walk(root, results, 20000);
      const rx = globToRegExp(pattern);
      const matched = results
        .map((p) => p.slice(root.length + 1))
        .filter((rel) => rx.test(rel))
        .slice(0, 500);
      return { content: matched.join("\n") || "(无匹配)" };
    } catch (e: any) {
      return { content: `glob 失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Grep（内容搜索，优先用系统 grep -r）----
const grepTool: Tool = {
  name: "grep",
  description: "在文件内容中搜索正则/字符串，返回命中行（文件:行号:内容）。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "搜索目录/文件，默认工作目录" },
      glob: { type: "string", description: "限定文件类型，如 '*.ts'（可选）" },
    },
    required: ["pattern"],
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = input.path ? abs(ctx, String(input.path)) : ctx.cwd;
    const include = input.glob ? `--include='${String(input.glob)}'` : "";
    const cmd = `grep -rniE ${include} -- ${shellQuote(String(input.pattern))} ${shellQuote(target)} | head -200`;
    try {
      const { stdout } = await pexec(cmd, {
        cwd: ctx.cwd,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
        signal: ctx.signal, // 用户停止→杀子进程
      });
      return { content: stdout.trim() || "(无命中)" };
    } catch (e: any) {
      // grep 无命中返回码 1，不算错误
      if (e.code === 1 && !e.stderr) return { content: "(无命中)" };
      return { content: e.stderr || `grep 失败: ${e.message}`, isError: true };
    }
  },
};

// ---- 辅助 ----
async function walk(dir: string, out: string[], cap: number): Promise<void> {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out, cap);
    else out.push(full);
    if (out.length >= cap) return;
  }
}

function globToRegExp(glob: string): RegExp {
  // 极简 glob → 正则：** 任意层级，* 单层，? 单字符
  let re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- Remember（写入全局记忆，跨会话）----
const rememberTool: Tool = {
  name: "remember",
  description:
    "把用户希望长期记住的信息（个人偏好、习惯、事实、项目背景、称呼等）追加到全局记忆，之后每次对话都会自动记得。当用户说“记住…/以后…/我喜欢…”等，或出现明显值得长期保留的信息时调用。每条一句、简洁、独立可理解。",
  readOnly: true, // 只写 minicc 自己的记忆文件，安全，不需要权限确认
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "要长期记住的一句话（简洁、自足）" },
    },
    required: ["text"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const text = String(input.text || "").trim();
      if (!text) return { content: "记忆内容为空，未写入", isError: true };
      await fs.mkdir(dirname(MEMORY_FILE), { recursive: true });
      let cur = "";
      try {
        cur = await fs.readFile(MEMORY_FILE, "utf8");
      } catch {
        /* 首次 */
      }
      const line = "- " + text;
      const seedHeader = process.env.WUWEI_LANG === "en" ? "# Memory" : "# 记忆";
      const next = cur.trim() ? cur.trimEnd() + "\n" + line + "\n" : seedHeader + "\n\n" + line + "\n";
      await fs.writeFile(MEMORY_FILE, next, "utf8");
      return { content: "已记住：" + text };
    } catch (e: any) {
      return { content: `写入记忆失败: ${e.message}`, isError: true };
    }
  },
};

// ---- 联网：web_search / web_fetch ----
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// 解析 DuckDuckGo html 版结果页(无需 key)
function parseDDG(html: string): { title: string; url: string; snippet: string }[] {
  const titleRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const items: { title: string; url: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html))) {
    let url = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith("//")) url = "https:" + url;
    items.push({ url, title: stripTags(m[2]) });
  }
  const snips: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = snipRe.exec(html))) snips.push(stripTags(s[1]));
  return items.map((it, i) => ({ ...it, snippet: snips[i] || "" }));
}

const webSearchTool: Tool = {
  name: "web_search",
  description:
    "在互联网搜索，返回相关网页的标题/链接/摘要。用于查最新信息、找资料、找文档。拿到链接后可用 web_fetch 读全文。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "搜索关键词" } },
    required: ["query"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const q = String(input.query || "").trim();
      if (!q) return { content: "搜索词为空", isError: true };
      const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
        signal: ctx.signal,
      });
      const html = await res.text();
      const results = parseDDG(html).slice(0, 8);
      if (!results.length) return { content: "(无结果，或搜索源暂时不可用，可改用 web_fetch 直接抓已知 URL)" };
      return {
        content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n"),
      };
    } catch (e: any) {
      return { content: `搜索失败: ${e.message}`, isError: true };
    }
  },
};

const webFetchTool: Tool = {
  name: "web_fetch",
  description: "抓取一个网页 URL 的正文（去 HTML 标签返回纯文本）。用于阅读文档、文章、API 页面等。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "网页 URL（http/https）" } },
    required: ["url"],
  },
  async run(input, ctx): Promise<ToolResult> {
    try {
      const url = String(input.url || "");
      if (!/^https?:\/\//i.test(url)) return { content: "URL 必须以 http:// 或 https:// 开头", isError: true };
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
        redirect: "follow",
        signal: ctx.signal,
      });
      const ct = res.headers.get("content-type") || "";
      let body = await res.text();
      if (/html|xml/i.test(ct) || /^\s*</.test(body)) body = htmlToText(body);
      else body = body.trim();
      const max = 12000;
      const text = body.length > max ? body.slice(0, max) + `\n…(已截断，共 ${body.length} 字符)` : body;
      return { content: `# ${url}（HTTP ${res.status}）\n\n${text || "(空)"}` };
    } catch (e: any) {
      return { content: `抓取失败: ${e.message}`, isError: true };
    }
  },
};

// ---- Brain：本地概念知识网络（结构化、可检索、越用越准）----
// 定位：把项目/服务器/脚本/注意事项等"高价值概念点"存成互相关联的网络，
// 开工前先 brain_recall 取相关子图，避免每次全量扫文档、省 token。
const brainRecallTool: Tool = {
  name: "brain_recall",
  description:
    "从本地知识网络检索与当前任务相关的概念子图（项目背景、部署脚本位置、服务器分布、注意事项等结构化信息）。**每次开始一个涉及具体项目/部署/环境的任务前，先调用它**，按返回的结构化信息行动，不要凭空猜或去全量翻文档。返回为空说明网络里还没这块知识。",
  readOnly: true, // 只读+轻量强化，安全，免权限确认，可并行
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "要检索的主题/概念，如 'figcheck 部署' 'fig07 服务器'" },
      limit: { type: "number", description: "返回概念数上限，默认 6" },
    },
    required: ["query"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const r = await brain.recall(String(input.query || ""), Number(input.limit) || 6);
      return { content: r.text || "(知识网络中暂无相关概念；可用 brain_learn 记住新发现的知识)" };
    } catch (e: any) {
      return { content: `检索失败: ${e.message}`, isError: true };
    }
  },
};

const brainLearnTool: Tool = {
  name: "brain_learn",
  description:
    "把一个高价值概念记进本地知识网络，或更新已有概念（同名自动合并、纠正旧信息）。用于沉淀固定不变的知识：项目是什么、git 路径、测试/线上环境、部署脚本位置、踩坑注意事项等。attrs 存结构化键值（如 {git:'~/...', 测试环境:'fig01'}）。发现旧记忆有误时，用同名 name 覆盖更新。",
  readOnly: true, // 只写 minicc 自己的知识库，安全
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "概念主名，如 'figcheck'、'deploy_view_prod.sh'" },
      type: { type: "string", description: "类型：项目/服务器/脚本/注意事项/命令/概念…" },
      summary: { type: "string", description: "一句话摘要" },
      aliases: { type: "array", items: { type: "string" }, description: "别名，可选" },
      attrs: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "结构化属性键值对，如 {git路径:'...', 测试环境:'fig01', 部署脚本:'...'}",
      },
    },
    required: ["name"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const r = await brain.learn({
        name: String(input.name),
        type: input.type ? String(input.type) : undefined,
        summary: input.summary ? String(input.summary) : undefined,
        aliases: Array.isArray(input.aliases) ? (input.aliases as string[]) : undefined,
        attrs: (input.attrs as Record<string, string>) || undefined,
      });
      return { content: `${r.created ? "已记住新概念" : "已更新概念"}：${r.name}` };
    } catch (e: any) {
      return { content: `写入失败: ${e.message}`, isError: true };
    }
  },
};

const brainLinkTool: Tool = {
  name: "brain_link",
  description:
    "在两个概念间建立/强化一条有向关系，把知识串成网络。如 brain_link('figcheck','部署脚本','deploy_view_prod.sh')、('figcheck','线上服务器','fig03')。两端概念若不存在会自动占位创建。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "源概念名" },
      relation: { type: "string", description: "关系名：部署脚本/测试环境/线上服务器/包含服务/注意事项/关联…" },
      to: { type: "string", description: "目标概念名" },
    },
    required: ["from", "relation", "to"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const r = await brain.link(String(input.from), String(input.relation), String(input.to));
      return { content: r.msg, isError: !r.ok };
    } catch (e: any) {
      return { content: `建立关系失败: ${e.message}`, isError: true };
    }
  },
};

const brainForgetTool: Tool = {
  name: "brain_forget",
  description: "从知识网络删除一个错误/过时的概念（连带其所有关系）。仅在确认某概念确实错误时使用。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "要删除的概念名" } },
    required: ["name"],
  },
  async run(input): Promise<ToolResult> {
    try {
      const ok = brain.forget(String(input.name));
      return { content: ok ? `已忘记：${input.name}` : `未找到概念：${input.name}` };
    } catch (e: any) {
      return { content: `删除失败: ${e.message}`, isError: true };
    }
  },
};

const brainReadDocTool: Tool = {
  name: "brain_read_doc",
  description:
    "读取知识宫殿等文档库里某文件/文档块的原文。brain_recall 返回的『相关文档』只给摘要+路径；需要完整细节时用它按 file 路径读全文（长期大文本按需路由，不必全量扫）。",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "文档相对路径或块 id（brain_recall 返回的 file 值）" },
    },
    required: ["ref"],
  },
  async run(input): Promise<ToolResult> {
    try {
      return { content: brain.readDoc(String(input.ref || "")) };
    } catch (e: any) {
      return { content: `读取失败: ${e.message}`, isError: true };
    }
  },
};

export const ALL_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  webSearchTool,
  webFetchTool,
  rememberTool,
  brainRecallTool,
  brainLearnTool,
  brainLinkTool,
  brainForgetTool,
  brainReadDocTool,
];

export const TOOL_MAP: Map<string, Tool> = new Map(ALL_TOOLS.map((t) => [t.name, t]));
