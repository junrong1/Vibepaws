# Vibepaws Homebrew cask.
#
# 为什么值得有这一份：一条命令装好、一条命令升级（brew upgrade），对一个「盯着 coding
# agent 的桌宠」的用户群来说，手边必然有终端，多半也已经有 Homebrew。
#
# 它**不能**替你省掉 Gatekeeper 那一下：Homebrew 6 已经把 `--no-quarantine` 删掉了
# （HOMEBREW_CASK_OPTS 也不再接受它），所有 cask 下载一律打 quarantine 标记。实测装完
# /Applications/Vibepaws.app 上确实有 com.apple.quarantine。所以走这条路同样要在
# 系统设置里放行一次，或者自己 `xattr -dr com.apple.quarantine /Applications/Vibepaws.app`。
#
# tap 的用法（仓库名不是 homebrew-*，所以要显式给 URL；Homebrew 6 还要求第三方 tap
# 先被 trust 一次，否则 cask 根本不给加载）：
#   brew tap junrong1/vibepaws https://github.com/junrong1/Vibepaws
#   brew trust junrong1/vibepaws
#   brew install --cask vibepaws
#
# version / sha256 由 scripts/update_cask.ts 在发版时按真实产物刷新 —— 手抄一次就会错一次。
cask "vibepaws" do
  version "0.1.1"
  sha256 "ba928860516d1bfe8ddafbeee559127df39b6214c45f8dfd41322bc3d53ed14d"

  url "https://github.com/junrong1/Vibepaws/releases/download/v#{version}/Vibepaws-#{version}-arm64.dmg"
  name "Vibepaws"
  desc "Desktop pet that watches your AI coding agents"
  homepage "https://github.com/junrong1/Vibepaws"

  depends_on macos: :sonoma
  depends_on arch: :arm64

  app "Vibepaws.app"

  # Core 的数据、宠物、EXP 记录都在 ~/.vibepaws；壳的窗口偏好在 userData 下。
  # zap 才删它们 —— 普通 uninstall 不该把用户养了两周的宠物一起带走。
  zap trash: [
    "~/.vibepaws",
    "~/Library/Application Support/Vibepaws",
    "~/Library/Logs/Vibepaws",
    "~/Library/Preferences/com.vibepaws.desktop.plist",
    "~/Library/Saved Application State/com.vibepaws.desktop.savedState",
  ]

  caveats <<~CAVEATS
    Vibepaws is ad-hoc signed but not notarized (that needs a paid Apple Developer account),
    so macOS will block it on first launch with "Apple could not verify...".

    Allow it once, either way:
      * System Settings -> Privacy & Security -> Security -> Open Anyway, or
      * xattr -dr com.apple.quarantine #{appdir}/Vibepaws.app

    Then connect a coding agent from Settings -> Connect your agent.
  CAVEATS
end
