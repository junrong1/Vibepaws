/**
 * DMG 公证钩子（electron-builder afterAllArtifactBuild）。
 *
 * 为什么需要这一步：electron-builder 只公证 .app —— MacTargetHelper.notarizeIfProvided()
 * 拿到的是 appPath，装订(staple)的票也贴在 .app 上。然后 dmg / zip 才用这个已装订的 .app 打包。
 *
 * 结果是：用户把 app 从 dmg 里拖出来运行，没问题（票在 app 身上）；
 * 但用户**双击 dmg 那一刻**，Gatekeeper 评估的是 dmg 本身，而 dmg 自己没有票 ——
 * 于是弹「无法验证开发者」。roadmap 0.13 里 clawd 用户抱怨的"每次更新都要点隐私与安全性"，
 * 就是这一下。所以 dmg 必须单独提交公证 + 单独装订。
 *
 * zip 不做：zip 格式没有地方存装订票，Apple 也不支持 staple 一个 zip。
 * 里面的 .app 已经装订过了，解压即用，这是自动更新那条路，本来就够。
 *
 * 没有凭据时整个钩子是 no-op —— 本地 `npm run dist:mac` 不会因为没有证书而失败。
 */

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");

/** 与 electron-builder 的 getNotarizeOptions 保持同一套优先级，避免两边认的凭据不一致。 */
function resolveCredentials(env) {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = env;
  if (APPLE_API_KEY || APPLE_API_KEY_ID || APPLE_API_ISSUER) {
    if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
      throw new Error("APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER 必须三个一起给");
    }
    return { kind: "api-key", args: ["--key", APPLE_API_KEY, "--key-id", APPLE_API_KEY_ID, "--issuer", APPLE_API_ISSUER] };
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = env;
  if (APPLE_ID || APPLE_APP_SPECIFIC_PASSWORD) {
    if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
      throw new Error("APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID 必须三个一起给");
    }
    return { kind: "apple-id", args: ["--apple-id", APPLE_ID, "--password", APPLE_APP_SPECIFIC_PASSWORD, "--team-id", APPLE_TEAM_ID] };
  }

  const { APPLE_KEYCHAIN, APPLE_KEYCHAIN_PROFILE } = env;
  if (APPLE_KEYCHAIN_PROFILE) {
    const args = ["--keychain-profile", APPLE_KEYCHAIN_PROFILE];
    if (APPLE_KEYCHAIN) args.push("--keychain", APPLE_KEYCHAIN);
    return { kind: "keychain", args };
  }

  return null;
}

/** dmg 没签过就别提交 —— 公证未签名产物必然被拒，报错信息还很难懂。 */
function isSigned(dmgPath) {
  try {
    execFileSync("codesign", ["--verify", "--strict", dmgPath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function notarizeDmg(context) {
  if (process.platform !== "darwin") return [];
  if (process.env.VIBEPAWS_SKIP_DMG_NOTARIZE === "1") {
    console.log("[vibepaws] ⚠ 跳过 dmg 公证：VIBEPAWS_SKIP_DMG_NOTARIZE=1");
    return [];
  }

  const dmgs = (context.artifactPaths ?? []).filter((p) => p.endsWith(".dmg") && existsSync(p));
  if (dmgs.length === 0) return [];

  let creds;
  try {
    creds = resolveCredentials(process.env);
  } catch (err) {
    // 凭据给了一半 —— 这是配置错误，不是"没打算签名"，必须让构建红掉。
    console.error(`[vibepaws] ✗ dmg 公证凭据不完整：${err.message}`);
    throw err;
  }

  if (!creds) {
    console.log("[vibepaws] ⚠ 跳过 dmg 公证：没有 Apple 凭据（本地未签名构建是正常的）");
    return [];
  }

  for (const dmg of dmgs) {
    if (!isSigned(dmg)) {
      console.log(`[vibepaws] ⚠ 跳过 dmg 公证：${dmg} 未签名`);
      continue;
    }

    console.log(`[vibepaws] 提交 dmg 公证（${creds.kind}）：${dmg}`);
    console.log("  ↳ 这一步要等 Apple 返回，通常 1–5 分钟");
    execFileSync("xcrun", ["notarytool", "submit", dmg, ...creds.args, "--wait"], { stdio: "inherit" });

    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "validate", dmg], { stdio: "inherit" });
    console.log(`[vibepaws] ✓ dmg 已公证并装订：${dmg}`);
  }

  // 就地改写，没有产生新产物
  return [];
}

module.exports = notarizeDmg;
module.exports.default = notarizeDmg;
