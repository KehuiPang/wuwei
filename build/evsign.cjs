// electron-builder 自定义 Windows 签名钩子 —— 用 EV Sign(evsign.cn) 云签名。
//
// 为什么用钩子而不是"打包完再签"：electron-builder 打完包会生成 latest.yml，
// 里面记录每个安装包的 sha512 供 electron-updater 校验。若签名发生在打包之后，
// 文件字节变了、sha512 对不上，老用户自动更新会全部校验失败。
// 签名钩子在打包过程中、生成清单之前逐个文件调用本函数，签完再算 sha512，
// 自动更新链路才不会断。
//
// 接法：electron-builder 26 用 -c.win.signtoolOptions.sign=build/evsign.cjs（注意是 .cjs：
// 本仓库 package.json 是 "type":"module"，用 CommonJS 的钩子必须 .cjs 扩展名，否则被当 ESM 报错）。
// 且需环境变量 EVSIGN_KEY 有值；未设 → 直接跳过(打未签名包)，绝不阻断发版。
const { execFileSync } = require("node:child_process");

exports.default = async function sign(configuration) {
  const file = configuration.path; // 待签名文件绝对路径
  const key = process.env.EVSIGN_KEY;
  if (!key) {
    console.warn(`[evsign] EVSIGN_KEY 未设置，跳过签名: ${file}`);
    return;
  }
  // 白名单：只签 wuwei 自己的产物 —— 主程序 wuwei.exe / 安装器 wuwei-*-setup.exe / 卸载器 Uninstall wuwei.exe，
  // 它们文件名都含 "wuwei"。electron-builder 还会把一堆第三方捆绑 exe 送来签：
  //   node_modules/@esbuild/esbuild.exe、resources/elevate.exe(NSIS 提权工具) 等，
  // 这些不是我们的软件、不在 EV Sign 白名单 → 会返回"此文件未审核"报错拖垮整个打包。
  // 跳过它们是正确的：Windows SmartScreen 只校验下载到的安装器和主程序签名，捆绑辅助 exe 未签名很正常。
  const base = file.replace(/\\/g, "/").split("/").pop() || "";
  if (!/wuwei/i.test(base)) {
    console.log(`[evsign] 跳过非 wuwei 自有文件(不在签名白名单): ${file}`);
    return;
  }
  // CI 里把 CLI 下载到固定路径并用 EVSIGN_CLIENT 指过来；本地签名默认走 PATH 里的 evsign-client
  const cli = process.env.EVSIGN_CLIENT || "evsign-client";
  console.log(`[evsign] 云签名: ${file}`);
  // -key 许可证 / -t digicert 加时间戳(证书过期后签名依旧有效)。
  // 返回非 0 时 execFileSync 抛错 → 本文件签名失败；打包后 CI 会再对安装器强制验签兜底。
  execFileSync(cli, [file, "-key", key, "-t", "digicert"], { stdio: "inherit" });
  console.log(`[evsign] 已签名: ${file}`);
};
