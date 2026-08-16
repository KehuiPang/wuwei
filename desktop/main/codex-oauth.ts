// Codex 订阅一键授权：app 内直接跑 Codex CLI 的 ChatGPT OAuth(PKCE + 本地 1455 回环)流程，
// 免去本机安装 codex CLI + `codex login`。产出 access_token + account_id，写入 ~/.codex/auth.json，
// 与 provider.ts 的 CodexProvider(Bearer access_token + chatgpt-account-id 头)完全对应。
//
// 参数取自开源 codex CLI(openai/codex, codex-rs/login/src/server.rs)：
//   authorize=https://auth.openai.com/oauth/authorize，token=…/oauth/token，
//   redirect=http://localhost:1455/auth/callback，scope=openid profile email offline_access，
//   额外 id_token_add_organizations=true & originator=codex_cli_rs，PKCE S256。
//   account_id = id_token JWT 的 ["https://api.openai.com/auth"].chatgpt_account_id。
import { shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const PORT = 1455;
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const SCOPES = "openid profile email offline_access";

// 界面语言（settings.ts 的 applyEnvFromSettings 写入）。回调页 HTML 是用户在浏览器里看的，得跟界面语言走。
// 语言可运行时切换，所以只在调用时求值，不做模块常量。
const tt = (zh: string, en: string) => (process.env.WUWEI_LANG === "en" ? en : zh);

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface CodexOAuthResult {
  accountId?: string;
  planType?: string;
}

// 解 JWT payload(中段 base64url)，从 ["https://api.openai.com/auth"] 取 chatgpt_account_id / plan
function parseIdToken(idToken: string): { accountId?: string; planType?: string } {
  try {
    const seg = idToken.split(".")[1];
    if (!seg) return {};
    const json = JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const auth = json["https://api.openai.com/auth"] || {};
    return { accountId: auth.chatgpt_account_id, planType: auth.chatgpt_plan_type };
  } catch {
    return {};
  }
}

async function exchangeCode(code: string, verifier: string): Promise<any | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  }).toString();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) {
    log("codexOAuth", "换 token 失败 status=", res.status, "resp=", JSON.stringify(j).slice(0, 300));
    return null;
  }
  return j;
}

// 写 ~/.codex/auth.json(与 codex CLI 同结构)，供 config.ts loadCodexCreds 读取
function writeAuthJson(tokens: { id_token: string; access_token: string; refresh_token?: string }, accountId?: string) {
  const dir = join(homedir(), ".codex");
  mkdirSync(dir, { recursive: true });
  const data = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || "",
      account_id: accountId || "",
    },
    last_refresh: new Date().toISOString(),
  };
  writeFileSync(join(dir, "auth.json"), JSON.stringify(data, null, 2), { mode: 0o600 });
  log("codexOAuth", "✓ 写入 ~/.codex/auth.json account_id=", accountId ? accountId.slice(0, 8) + "…" : "无");
}

// 跑完整登录：起本地 1455 回环服务器 → 开系统浏览器授权 → 收 code → 换 token → 写 auth.json。
export async function codexOAuthLogin(): Promise<CodexOAuthResult | null> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const authUrl =
    AUTHORIZE_URL +
    "?" +
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      originator: "codex_cli_rs",
      state,
    }).toString();

  return await new Promise<CodexOAuthResult | null>((resolve) => {
    let server: Server | null = null;
    let done = false;
    const finish = (v: CodexOAuthResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      try {
        server?.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };

    server = createServer(async (req, res) => {
      try {
        const u = new URL(req.url || "", REDIRECT_URI);
        if (u.pathname !== "/auth/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = u.searchParams.get("code") || "";
        const st = u.searchParams.get("state") || "";
        if (!code || st !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(
            tt(
              "<h2>授权失败</h2><p>state 不匹配或缺少 code，请回到 minicc 重试。</p>",
              "<h2>Authorization failed</h2><p>The state didn't match or the code was missing. Head back to the app and try again.</p>",
            ),
          );
          finish(null);
          return;
        }
        const tok = await exchangeCode(code, verifier);
        if (!tok) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }).end(
            tt(
              "<h2>换取令牌失败</h2><p>请回到 minicc 重试。</p>",
              "<h2>Couldn't get a token</h2><p>Head back to the app and try again.</p>",
            ),
          );
          finish(null);
          return;
        }
        const { accountId, planType } = tok.id_token ? parseIdToken(tok.id_token) : {};
        writeAuthJson(tok, accountId);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
          tt(
            "<h2>✓ 授权成功</h2><p>已完成 Codex(ChatGPT) 登录，可以关闭此页，回到 minicc 使用。</p>",
            "<h2>✓ You're authorized</h2><p>Codex (ChatGPT) sign-in is done. You can close this page and head back to the app.</p>",
          ),
        );
        finish({ accountId, planType });
      } catch (e) {
        log("codexOAuth", "回调处理异常", String(e));
        try {
          res.writeHead(500).end();
        } catch {
          /* ignore */
        }
        finish(null);
      }
    });

    server.on("error", (e: any) => {
      log("codexOAuth", "本地服务器启动失败", String(e?.code || e));
      finish(null); // 1455 被占(如 codex CLI 正在登录)等
    });

    server.listen(PORT, "127.0.0.1", () => {
      log("codexOAuth", "本地回环服务器已起 :1455，打开系统浏览器授权");
      void shell.openExternal(authUrl);
    });

    const killer = setTimeout(() => {
      log("codexOAuth", "5 分钟超时");
      finish(null);
    }, 300000);
  });
}
