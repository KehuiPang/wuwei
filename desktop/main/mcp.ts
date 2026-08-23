// 精简 MCP(Model Context Protocol) stdio 客户端：spawn 服务器进程，JSON-RPC over stdio(换行分隔)，
// 握手 → tools/list → 把每个 MCP 工具包成 minicc Tool 代理 tools/call。无重依赖，自研。
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import type { Tool, ToolResult } from "../../src/types.js";

export const MCP_CONFIG_PATH = join(homedir(), process.env.WUWEI_DATA_DIR_NAME || ".wuwei", "mcp.json");

interface McpServerCfg {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

// GUI 版 Electron 的 PATH 常缺 /usr/local/bin、homebrew、nvm → npx/node/uvx 找不到。补常见路径。
function augmentedPath(): string {
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    join(homedir(), ".local/bin"),
    join(homedir(), ".cargo/bin"),
  ];
  const cur = process.env.PATH || "";
  return [cur, ...extra].filter(Boolean).join(delimiter);
}

class McpClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  tools: Tool[] = [];
  toolInfos: { name: string; description: string }[] = []; // 原始工具名+描述(展示用)
  status: "connecting" | "ready" | "error" | "disabled" | "needs-config" = "connecting";
  error = "";
  constructor(public cfg: McpServerCfg) {}

  private write(msg: unknown) {
    try {
      this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
    } catch {
      /* ignore */
    }
  }
  private request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(process.env.WUWEI_LANG === "en"
            ? "MCP request timed out: " + method + " (the first npx/uvx run downloads deps and can be slow; or the command/args are wrong)"
            : "MCP 请求超时: " + method + "（首次 npx/uvx 会下载依赖，可能较慢；或命令/参数不对）"));
        }
      }, 60000); // 首次 npx 下载包可能慢，给足 60s
    });
  }
  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 忽略非 JSON 行(有些服务器往 stdout 打日志)
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
      else p.resolve(msg.result);
    }
  }
  async connect(): Promise<void> {
    try {
      // 展开 ~ 路径(spawn 不走 shell 不会自动展开)，让默认值 ~/Desktop 之类直接可用
      const args = (this.cfg.args || []).map((a) =>
        a === "~" ? homedir() : a.startsWith("~/") ? join(homedir(), a.slice(2)) : a,
      );
      this.proc = spawn(this.cfg.command, args, {
        env: { ...process.env, ...(this.cfg.env || {}), PATH: augmentedPath() },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const failAll = (msg: string) => {
        if (this.status !== "ready") {
          this.status = "error";
          if (!this.error) this.error = msg;
        }
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(new Error(this.error || msg));
        }
      };
      const enMsg = process.env.WUWEI_LANG === "en";
      this.proc.on("error", (e: any) => {
        failAll(
          e?.code === "ENOENT"
            ? enMsg
              ? `Command not found: ${this.cfg.command} (install it first, e.g. uvx needs uv)`
              : `命令不存在：${this.cfg.command}（需先安装它，如 uvx 要装 uv）`
            : e?.message || (enMsg ? "spawn failed" : "spawn 失败"),
        );
      });
      // 进程提前退出(如 npx 拉不到包/命令报错)→立即失败，不再干等超时
      this.proc.on("exit", (code) => {
        failAll(
          enMsg
            ? `Process exited (code ${code}): the command or package name may be invalid, or a dependency is missing`
            : `进程已退出(code ${code})：命令或包名可能无效、或依赖缺失`,
        );
      });
      this.proc.stdout!.setEncoding("utf8");
      this.proc.stdout!.on("data", (d: string) => {
        this.buf += d;
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (line) this.onLine(line);
        }
      });
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "minicc", version: "1.3" },
      });
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await this.request("tools/list", {});
      const raw = listed?.tools || [];
      this.tools = raw.map((t: any) => this.wrap(t));
      this.toolInfos = raw.map((t: any) => ({ name: t.name, description: t.description || "" }));
      this.status = "ready";
    } catch (e: any) {
      this.status = "error";
      this.error = e?.message || String(e);
      this.tools = [];
    }
  }
  private wrap(t: any): Tool {
    const client = this;
    return {
      name: this.cfg.name + "__" + t.name, // 加服务器前缀防撞名
      description: `[MCP:${this.cfg.name}] ${t.description || t.name}`,
      readOnly: false, // MCP 工具可能有副作用 → 走权限确认(手动模式)
      inputSchema: t.inputSchema || { type: "object", properties: {} },
      async run(input): Promise<ToolResult> {
        // 这两条会进工具卡片和模型上下文 → 跟随界面语言（在调用处判定，切语言即时生效）
        const en = process.env.WUWEI_LANG === "en";
        try {
          const r = await client.request("tools/call", { name: t.name, arguments: input });
          const content = (r?.content || [])
            .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
          return { content: content || (en ? "(no output)" : "(无输出)"), isError: !!r?.isError };
        } catch (e: any) {
          return { content: `${en ? "MCP call failed:" : "MCP 调用失败:"} ${e.message}`, isError: true };
        }
      },
    };
  }
  dispose() {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
  }
}

let clients: McpClient[] = [];

export function loadMcpConfig(): McpServerCfg[] {
  try {
    const raw = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8"));
    // 支持两种写法：数组，或 Claude 风格 { "mcpServers": { name: {command,args} } }
    if (Array.isArray(raw)) return raw;
    if (raw?.mcpServers)
      return Object.entries(raw.mcpServers).map(([name, v]: any) => ({ name, ...v }));
    return [];
  } catch {
    return [];
  }
}

export function mcpTools(): Tool[] {
  return clients.flatMap((c) => c.tools);
}
// 按 MCP 服务器分组的工具（给「工具」面板展示用）：只列连上的
export function mcpToolsBySource(): { server: string; tools: Tool[] }[] {
  return clients
    .filter((c) => c.tools.length > 0)
    .map((c) => ({ server: c.cfg.name, tools: c.tools }));
}
export function mcpStatus() {
  return clients.map((c) => ({
    name: c.cfg.name,
    status: c.status,
    error: c.error,
    disabled: !!c.cfg.disabled,
    toolInfos: c.toolInfos,
  }));
}

// (重)连接所有已配置的 MCP 服务器；禁用的也建对象但不连(status=disabled，便于 UI 展示可再启用)
export async function connectMcp(onChange?: () => void): Promise<void> {
  clients.forEach((c) => c.dispose());
  clients = [];
  const cfgs = loadMcpConfig().filter((c) => c.command);
  clients = cfgs.map((c) => new McpClient(c));
  await Promise.all(
    clients.map((c) => {
      if (c.cfg.disabled) {
        c.status = "disabled";
        return Promise.resolve();
      }
      // 含 <占位> 的配置(如 <目录路径>/<token>)先别连，避免用无效参数启动服务器→30s 超时假失败
      if (JSON.stringify(c.cfg).includes("<")) {
        c.status = "needs-config";
        c.error = process.env.WUWEI_LANG === "en"
          ? "Config still has <placeholders> to fill in (click “Advanced: edit JSON”, replace them, then save)"
          : "配置里还有 <占位> 待填写（点「高级：编辑 JSON」替换后再保存）";
        return Promise.resolve();
      }
      return c.connect().then(() => onChange?.());
    }),
  );
  onChange?.();
}

export interface RegistryItem {
  name: string; // 短名(装进 mcp.json 用)
  fullName: string; // 注册中心全名
  description: string;
  command: string;
  args: string[];
  repo: string;
  version: string;
}
// 在线搜索官方 MCP Registry(游标分页)，返回可本地安装(npm/pypi)的服务器 + 下一页游标
export async function searchMcpRegistry(
  query: string,
  cursor?: string,
): Promise<{ results: RegistryItem[]; nextCursor: string }> {
  const q = query.trim();
  if (!q) return { results: [], nextCursor: "" };
  try {
    const url =
      "https://registry.modelcontextprotocol.io/v0/servers?search=" +
      encodeURIComponent(q) +
      "&limit=30" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const res = await fetch(url, { headers: { "User-Agent": "minicc" } });
    const j: any = await res.json();
    const arr: any[] = j?.servers || [];
    const results: RegistryItem[] = [];
    for (const it of arr) {
      const s = it.server || it;
      const pkgs: any[] = s.packages || [];
      const npm = pkgs.find((p) => (p.registryType || p.registry_type) === "npm");
      const pypi = pkgs.find((p) => (p.registryType || p.registry_type) === "pypi");
      let command = "";
      let args: string[] = [];
      if (npm) {
        command = "npx";
        args = ["-y", npm.identifier];
      } else if (pypi) {
        command = "uvx";
        args = [pypi.identifier];
      } else continue; // oci/docker/remote-only 本地 stdio 装不了，跳过
      const short = String(s.name || "")
        .split("/")
        .pop()!
        .replace(/[^a-zA-Z0-9_-]/g, "-");
      results.push({
        name: short || s.name,
        fullName: s.name || short,
        description: s.description || "",
        command,
        args,
        repo: s.repository?.url || "",
        version: s.version || "",
      });
    }
    return { results, nextCursor: j?.metadata?.nextCursor || "" };
  } catch {
    return { results: [], nextCursor: "" };
  }
}
