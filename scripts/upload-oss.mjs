// CI 发布：把 release/ 下的安装包 + electron-updater 清单(latest*.yml) 传到阿里云 OSS。
// 供 electron-updater 自动更新 + 官网下载读取（bucket=wuwei-repo, public-read, 路径 updates/）。
// 凭证仅从环境变量读（GitHub Actions secrets），绝不硬编码。缺凭证则跳过(不挡发布)。
import OSS from "ali-oss";
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const KEY_ID = process.env.OSS_KEY_ID;
const KEY_SECRET = process.env.OSS_KEY_SECRET;
if (!KEY_ID || !KEY_SECRET) {
  console.log("[oss] 未配置 OSS_KEY_ID/SECRET，跳过 OSS 上传");
  process.exit(0);
}

const DIR = "release";
const BASE = "https://wuwei-repo.oss-cn-hangzhou.aliyuncs.com/updates/";
// 允许上传的产物类型：安装包 + 差分块 + 更新清单
const ALLOW = new Set([".exe", ".dmg", ".appimage", ".deb", ".zip", ".blockmap", ".yml"]);

const client = new OSS({
  region: "oss-cn-hangzhou",
  accessKeyId: KEY_ID,
  accessKeySecret: KEY_SECRET,
  bucket: "wuwei-repo",
  secure: true,
});

let files;
try {
  files = readdirSync(DIR).filter((f) => {
    const p = join(DIR, f);
    return statSync(p).isFile() && ALLOW.has(extname(f).toLowerCase());
  });
} catch {
  console.log(`[oss] 无 ${DIR}/ 目录，跳过`);
  process.exit(0);
}
if (!files.length) {
  console.log("[oss] release/ 无可上传产物");
  process.exit(0);
}

// 先传安装包，最后传 latest*.yml —— 保证更新器读到清单时对应包已就绪。
files.sort((a, b) => (a.endsWith(".yml") ? 1 : 0) - (b.endsWith(".yml") ? 1 : 0));

for (const f of files) {
  const key = `updates/${f}`;
  const local = join(DIR, f);
  const sizeMB = statSync(local).size / 1024 / 1024;
  try {
    if (sizeMB > 8) {
      await client.multipartUpload(key, local, { parallel: 4, partSize: 10 * 1024 * 1024 });
    } else {
      await client.put(key, local);
    }
    console.log(`[oss] ✓ ${BASE}${f}  (${sizeMB.toFixed(1)}MB)`);
  } catch (e) {
    console.error(`[oss] ✗ 上传失败 ${f}:`, e?.message || e);
    process.exit(1);
  }
}
console.log(`[oss] 完成，共 ${files.length} 个文件`);
