/**
 * 无证书构建的 ad-hoc 签名钩子（electron-builder afterPack）。
 *
 * 没有 Developer ID 时 electron-builder 干脆**跳过签名** —— 于是产物处在一个比"没签名"
 * 更糟的状态：内部那些 Mach-O 带着链接器给的 ad-hoc 签名，而 .app 这一层连
 * Contents/_CodeSignature 都没有。Gatekeeper 对它的判词是
 *   code has no resources but signature indicates they must be present
 * 也就是**签名损坏**，而不是"签名有效但不受信任"。这两者对用户是两种完全不同的遭遇：
 *
 *   · 签名损坏  → "Vibepaws 已损坏，无法打开" → 只能扔进废纸篓，没有任何放行入口
 *   · 有效但不受信任 → "Apple 无法验证…" → 系统设置 → 隐私与安全性 →「仍要打开」
 *
 * macOS Sequoia 拿掉了 Control-click 打开那条老路之后，"系统设置里放行"就是**唯一**的
 * 放行入口；而想走到那一步，签名必须先是有效的。所以这里补一次完整的 ad-hoc 签名：
 * 它不会让 app 变得受信任（那需要 Apple 签发的证书），但它把"死路"变成"多点四下"。
 *
 * 有真证书时整个钩子是 no-op —— 签名照旧由 electron-builder 用 Developer ID 做。
 *
 * 实测（macOS 26 / Electron 43）：ad-hoc + hardened runtime 之后 app 照常启动，
 * Core 跑在 Electron 自带的 Node 上，/health 通过 —— JIT 那几条授权没有被 ad-hoc 破坏。
 */

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

/** 钥匙串里有没有可用于分发的 Developer ID。有就什么都不做。 */
function hasDeveloperId() {
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    return out.includes("Developer ID Application");
  } catch {
    return false;
  }
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  if (hasDeveloperId()) {
    console.log("[vibepaws] 找到 Developer ID —— 跳过 ad-hoc 签名，交给 electron-builder 正常签");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${appName}.app`);
  if (!existsSync(appPath)) {
    console.warn(`[vibepaws] ⚠ 找不到 ${appPath} —— 跳过 ad-hoc 签名`);
    return;
  }

  const entitlements = join(__dirname, "entitlements.mac.plist");
  try {
    execFileSync(
      "codesign",
      [
        "--force",
        "--deep", // 内部的 framework / helper 一起签，少一个整份签名就是无效的
        "--sign",
        "-", // ad-hoc：没有身份，但签名本身是完整且自洽的
        "--options",
        "runtime", // 与 build.mac.hardenedRuntime 保持一致，否则授权不生效
        "--entitlements",
        entitlements,
        appPath,
      ],
      { stdio: "inherit" },
    );
    // 签完立刻自查：ad-hoc 签名失败是静默的，而它一旦失败，用户拿到的就是"已损坏"
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
    console.log("[vibepaws] ✓ 已 ad-hoc 签名（未受信任，但用户可以在系统设置里放行）");
  } catch (err) {
    // 不抛：本地构建不该因为签名失败而整个失败，但这条必须显眼
    console.error(`[vibepaws] ⚠ ad-hoc 签名失败，产物会以「已损坏」示人: ${String(err)}`);
  }
};
