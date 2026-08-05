// Claude 订阅一键授权：app 内直接跑 Claude Code 的 OAuth（PKCE）流程，
// 免去手动 `claude setup-token` + 复制粘贴。产出长期 token(sk-ant-oat01…)，
// 与 provider.ts 里 authMode=oauth 走的 Authorization:Bearer + anthropic-beta:oauth 完全对应。
//
// 原理同 Claude Code 官方登录：浏览器打开授权页 → 用户登录+同意 → 回调地址带回 code
// → 后台用 code + code_verifier 换 access_token。全程主进程 fetch，无 CORS 限制。
import { BrowserWindow, shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { log } from "./logger.js";

// Claude Code 的公开 OAuth 客户端参数（与官方 CLI 一致；订阅额度，不额外计费）
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ClaudeOAuthResult {
  token: string; // access_token (sk-ant-oat01…)，写入 settings.oauthToken
  refreshToken?: string;
  expiresAt?: number; // epoch 毫秒
}

// —— app 自己的 OAuth 令牌 sidecar：存 refresh_token/过期时间，供静默续期。
// 独立于 settings.json（渲染层 setSettings 会整包覆盖，放这里不被冲掉），也绝不动 ~/.claude.json。
const AUTH_FILE = join(homedir(), process.env.WUWEI_DATA_DIR_NAME || ".wuwei", "claude-oauth.json");
export interface ClaudeAuthStore {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}
export function saveClaudeAuth(a: ClaudeAuthStore): void {
  try {
    mkdirSync(dirname(AUTH_FILE), { recursive: true });
    writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2));
  } catch (e) {
    log("claudeOAuth", "写 sidecar 失败", String(e));
  }
}
export function loadClaudeAuth(): ClaudeAuthStore | null {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return null;
  }
}

// 用 refresh_token 换新 access_token（Anthropic 会轮换 refresh_token，务必存回新的）。
export async function claudeOAuthRefresh(refreshToken: string): Promise<ClaudeOAuthResult | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token) {
      log("claudeOAuth", "refresh 失败 status=", res.status, "resp=", JSON.stringify(j).slice(0, 200));
      return null;
    }
    const r: ClaudeOAuthResult = {
      token: j.access_token,
      refreshToken: j.refresh_token || refreshToken, // 未轮换则沿用旧的
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    };
    saveClaudeAuth({ accessToken: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt });
    return r;
  } catch (e) {
    log("claudeOAuth", "refresh 异常", String(e));
    return null;
  }
}

// 从回调 URL 里取出 code 与 state（Claude 有时把 code 拼成 "code#state"）
function parseCallback(rawUrl: string): { code: string; state: string } | null {
  try {
    const u = new URL(rawUrl);
    let code = u.searchParams.get("code") || "";
    let state = u.searchParams.get("state") || "";
    if (code.includes("#")) {
      const [c, s] = code.split("#");
      code = c;
      state = state || s || "";
    }
    return code ? { code, state } : null;
  } catch {
    return null;
  }
}

async function exchangeToken(
  code: string,
  state: string,
  verifier: string,
  redirectUri: string = REDIRECT_URI, // 回环流程要传本地地址，须与授权时一致
): Promise<ClaudeOAuthResult | null> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) {
    log("claudeOAuth", "换 token 失败 status=", res.status, "resp=", JSON.stringify(j).slice(0, 300));
    return null;
  }
  log("claudeOAuth", "✓ 拿到 access_token", String(j.access_token).slice(0, 12) + "…");
  const result: ClaudeOAuthResult = {
    token: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
  };
  // 落 sidecar：后续静默续期靠它（refresh_token + 过期时间）
  saveClaudeAuth({ accessToken: result.token, refreshToken: result.refreshToken, expiresAt: result.expiresAt });
  return result;
}

// 构造一次 PKCE 授权：返回授权 URL、verifier、state
// 关键：与官方/参考实现一致——state 直接用 verifier（不是另造随机值），否则 claude.ai 授权端点报 Invalid request format
function buildAuth(redirectUri: string): { authUrl: string; verifier: string; state: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = verifier;
  const authUrl =
    AUTHORIZE_URL +
    "?" +
    new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
  return { authUrl, verifier, state };
}

// 【系统浏览器 + 授权码回填】用默认浏览器(Chrome 等)打开授权，可复用已登录的 Google 账号。
// Claude 只认固定官方回调(不收 localhost 回环)，故用两步：
//   1) open：开浏览器授权（redirect_uri=官方回调）；用户同意后回调页会显示一段授权码
//   2) exchange：把用户复制的授权码传回来换 token
// 两步间用模块级 pending 暂存 code_verifier / state。
let pending: { verifier: string; state: string } | null = null;

export function claudeOAuthOpenBrowser(): void {
  const { authUrl, verifier, state } = buildAuth(REDIRECT_URI);
  pending = { verifier, state };
  log("claudeOAuth", "系统浏览器打开授权 URL=", authUrl);
  void shell.openExternal(authUrl);
}

// 用回调页显示的授权码换 token；code 可能是 "code#state" 形式，自动拆分
export async function claudeOAuthExchange(input: string): Promise<ClaudeOAuthResult | null> {
  if (!pending) {
    log("claudeOAuth", "exchange 无 pending(未先 open 或已超时)");
    return null;
  }
  let code = (input || "").trim();
  let state = pending.state;
  if (code.includes("#")) {
    const [c, s] = code.split("#");
    code = c.trim();
    state = (s || "").trim() || state;
  }
  if (!code) return null;
  try {
    const r = await exchangeToken(code, state, pending.verifier, REDIRECT_URI);
    return r;
  } catch (e) {
    log("claudeOAuth", "exchange 异常", String(e));
    return null;
  } finally {
    pending = null;
  }
}

// 弹授权窗，走完整 OAuth。成功返回 token；用户关窗/超时/失败返回 null。
export async function claudeOAuthLogin(): Promise<ClaudeOAuthResult | null> {
  const { authUrl, verifier, state } = buildAuth(REDIRECT_URI);

  log("claudeOAuth", "打开授权窗", AUTHORIZE_URL);
  const iconPath = join(__dirname, "../../build/icon.png"); // 无为 logo（与主窗口同源）
  const w = new BrowserWindow({
    width: 520,
    height: 720,
    title: "无为 · 登录授权",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    webPreferences: { partition: "persist:claude-oauth" }, // 持久分区：登录态可复用
  });
  w.on("page-title-updated", (e) => e.preventDefault()); // 锁标题，不让 claude.ai 页面把它改成 "Claude"

  return await new Promise<ClaudeOAuthResult | null>((resolve) => {
    let done = false;
    const finish = (v: ClaudeOAuthResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      if (!w.isDestroyed()) w.close();
      resolve(v);
    };

    // 命中回调地址（?code=…）就拦下换 token；拦到后阻止真正导航到 console
    const onNav = async (e: { preventDefault: () => void } | null, url: string) => {
      if (!url.startsWith(REDIRECT_URI)) return;
      const cb = parseCallback(url);
      if (!cb) return;
      e?.preventDefault();
      log("claudeOAuth", "收到回调 code=", cb.code.slice(0, 8) + "…");
      try {
        finish(await exchangeToken(cb.code, cb.state || state, verifier));
      } catch (err) {
        log("claudeOAuth", "换 token 异常", String(err));
        finish(null);
      }
    };
    w.webContents.on("will-redirect", (e, url) => void onNav(e, url));
    w.webContents.on("will-navigate", (e, url) => void onNav(e, url));
    w.webContents.on("did-navigate", (_e, url) => void onNav(null, url));

    w.on("closed", () => finish(null));
    const killer = setTimeout(() => {
      log("claudeOAuth", "5 分钟超时");
      finish(null);
    }, 300000);

    w.loadURL(authUrl).catch((err) => {
      log("claudeOAuth", "loadURL 失败", String(err));
      finish(null);
    });
  });
}
