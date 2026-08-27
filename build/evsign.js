// electron-builder 自定义 Windows 签名钩子 —— 用 EV Sign(evsign.cn) 云签名。
//
// 为什么用钩子而不是"打包完再签"：electron-builder 打完包会生成 latest.yml，
// 里面记录每个安装包的 sha512 供 electron-updater 校验。若签名发生在打包之后，
// 文件字节变了、sha512 对不上，老用户自动更新会全部校验失败。
// win.sign 钩子在打包过程中、生成清单之前逐个文件调用本函数，签完再算 sha512，
// 自动更新链路才不会断。
//
// 触发条件：electron-builder 配置里设了 -c.win.sign=build/evsign.js 且环境变量 EVSIGN_KEY 有值。
// 未设 EVSIGN_KEY → 直接跳过(打未签名包)，绝不阻断发版。
const { execFileSync } = require("node:child_process");

exports.default = async function sign(configuration) {
  const file = configuration.path; // 待签名文件绝对路径(exe / 卸载程序等)
  const key = process.env.EVSIGN_KEY;
  if (!key) {
    console.warn(`[evsign] EVSIGN_KEY 未设置，跳过签名: ${file}`);
    return;
  }
  // CI 里把 CLI 下载到固定路径并用 EVSIGN_CLIENT 指过来；本地签名默认走 PATH 里的 evsign-client
  const cli = process.env.EVSIGN_CLIENT || "evsign-client";
  console.log(`[evsign] 云签名: ${file}`);
  // 参数：文件路径(必须带引号已由 execFile 数组化处理) / -key 许可证 / -t digicert 加时间戳(证书过期后签名依旧有效)
  // 返回 0=成功、非 0=失败(execFileSync 会抛错，让打包整体失败，避免发出未签名却以为已签的包)
  execFileSync(cli, [file, "-key", key, "-t", "digicert"], { stdio: "inherit" });
  console.log(`[evsign] 已签名: ${file}`);
};
