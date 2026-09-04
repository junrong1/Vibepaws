# 发布签名与公证

[English](release_signing.md)

构建这条链已经全部接好：hardened runtime、授权清单、`.app` 和 `.dmg` 两份产物各自的公证，以及一个
负责核对结果的验收脚本。仓库里没有、也不会有的是凭据。这篇文档讲的就是怎么把凭据补上。

没有凭据时 `npm run dist:mac` 照样成功 —— 它会打印 `skipped macOS application code signing`，
产出一个未签名的 `.app`。本地开发一直走的就是这条路，没有任何东西是坏的。

---

## 为什么这件事没得选

Gatekeeper 会隔离所有下载来的、既没有 Apple 开发者签名**又**没有公证的 app。用户看到的是
**「Vibepaws 已损坏，无法打开」** —— 不是「未签名」，不是「不受信任」。这句提示是会主动误导人的：
它读起来像是下载坏了，于是人重新下一次，再撞一次，然后来提 issue（[#1](https://github.com/junrong1/Vibepaws/issues/1)）。

真正的陷阱是这一切在你自己机器上永远复现不了。本地构建出来的 app 不带 quarantine 标记，
Gatekeeper 根本不会评估它，于是不管签名多离谱它都能正常启动，永远如此。
**「我这儿能打开」什么都证明不了。** `npm run verify:release` 就是为这件事存在的。

---

## 需要准备什么

| | 成本 | 在哪 |
| --- | --- | --- |
| Apple Developer Program 会员 | $99/年 | [developer.apple.com/programs](https://developer.apple.com/programs/) |
| **Developer ID Application** 证书 | 含在会员里 | Certificates, Identifiers & Profiles |
| App Store Connect **API key** | 含在会员里 | [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api) |

两条能省掉半个下午的提醒：

- 证书类型必须是 **Developer ID Application**。不是 Apple Development，不是 Apple Distribution，
  也不是 Mac App Distribution。只有 Developer ID 才能用于 App Store 之外的分发，选错了会在构建
  快结束时报一句看不懂的错。
- 优先用 **API key**，别用 Apple ID + 专用密码。API key 可以单独吊销，不牵连 Apple ID，
  也不会因为 2FA 状态变化而失效。这是 electron-builder 自己的建议
  （[#7859](https://github.com/electron-userland/electron-builder/issues/7859)）。

---

## 一次性配置

### 1. 证书

在 Xcode 里建（*Settings → Accounts → Manage Certificates → + → Developer ID Application*），
或者在开发者后台用 CSR 签发。然后确认这台机器能看见它：

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

给 CI 用的话，从「钥匙串访问」导出成带密码的 `.p12`，然后：

```bash
base64 -i Certificates.p12 | pbcopy     # → secret APPLE_CERTIFICATE_P12
```

### 2. 公证密钥

建一把 **Developer** 角色的 API key。`.p8` 只能下载一次，丢了就只能重新生成。
把 Key ID 和 Issuer ID 一起存好。

### 3. 环境变量

```bash
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8   # .p8 的路径
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
```

或者用 Apple ID 那一套：

```bash
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop     # appleid.apple.com 生成，不是登录密码
export APPLE_TEAM_ID=XXXXXXXXXX
```

选定哪一套就三个一起给。给一半比一个不给还糟 —— electron-builder 会抛错，但要等一次完整构建
跑到最后才抛。

---

## 发版

### 本地

```bash
npm run verify:release -- --preflight   # 30 秒，能在白等之前就发现证书没配
npm run dist:mac                        # 签名、公证、装订
npm run verify:release                  # 去问 macOS 到底成没成
```

公证要往 Apple 走一个来回，每份产物通常 1–5 分钟。

### 走 CI（推荐）

`.github/workflows/release.yml` 由任意 `v*` tag 触发。需要配这几个 repository secret：

| Secret | 值 |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | `.p12` 的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
| `APPLE_API_KEY_P8` | `.p8` 的原文内容 |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

```bash
git tag v0.1.1 && git push origin v0.1.1
```

流水线会把证书导进一个用完即毁的临时钥匙串，先体检、跑测试、构建、验收，销毁钥匙串，
最后把产物挂到 GitHub release 上。放在 CI 里还有一个比「方便」更重要的理由：
签名身份要是只躺在某一个人的钥匙串里，「谁能发版」就悄悄变成了「谁的电脑还在」。

---

## 各部分都是干什么的

| 路径 | 作用 |
| --- | --- |
| `build/entitlements.mac.plist` | 主进程的 hardened runtime 授权。刻意压到最小，每一条都注释了「不加会怎样」。 |
| `build/entitlements.mac.inherit.plist` | 同上，给 Electron 的子进程用。 |
| `build/notarize-dmg.cjs` | 公证并装订 `.dmg`。electron-builder 只管 `.app`。 |
| `scripts/verify_release.ts` | 构建前 `--preflight`，构建后完整验收。 |
| `scripts/packaging.test.ts` | 把配置钉住防回归，跟在 `npm test` 里。 |

### 为什么 dmg 要单独走一步

electron-builder 公证并装订 `.app`，然后拿这个已装订的 app 去打 dmg 和 zip。
所以用户把 app 从 dmg 里拖出来运行是没问题的 —— 票在 app 身上。

但用户**双击 dmg 那一刻**，Gatekeeper 评估的是 dmg 本身，而 dmg 自己没有票，于是弹警告。
「每次更新都要点隐私与安全性」这条抱怨说的就是这一下，也正是它让这件事成了阻塞项。
`build/notarize-dmg.cjs` 把 dmg 单独提交、单独装订，把这个口子堵上。

zip 是刻意不做的：这个格式没有地方存装订票，Apple 也不支持 staple 一个 zip。
里面的 app 已经装订过了，而这正是自动更新那条路需要的。

---

## 排查

| 现象 | 原因和处理 |
| --- | --- |
| `skipped macOS application code signing` | 钥匙串里没有 Developer ID 证书。本地是正常的，CI 里是 bug。先跑 preflight。 |
| `skipped macOS notarization` | 环境里没有凭据。同上。 |
| 签名成功，但 app 一启动就崩 | 缺授权，基本上都是 `allow-jit`。V8 拿不到可执行内存，进程直接被内核杀掉。未签名构建看不出来，只有签了名才会崩。 |
| 公证被拒，提示 binary is not signed | 包里有 Mach-O 没签到。`npm run verify:release` 会把具体是哪些列出来。通常是往 `extraResources` 里新加了东西。 |
| CI 报 `The specified item could not be found in the keychain` | `set-key-partition-list` 那步没跑，或者钥匙串没进搜索链。流水线里两件都做了，去看导入证书那步的输出。 |
| 公证通过了，用户还是被拦 | dmg 没装订。翻构建日志末尾的 `notarize-dmg` 那几行。 |
| Team ID 对不上 | 证书和 API key 不属于同一个 team。 |
