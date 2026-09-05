# Vibepaws Homebrew cask.
#
# 为什么值得有这一份：没有 Apple Developer 会员，.dmg 只能是 ad-hoc 签名 + 未公证，
# 用户双击会撞上「Apple 无法验证」，得去系统设置 → 隐私与安全性里点「仍要打开」。
# 而 `brew install --cask --no-quarantine` 根本不会给产物打 quarantine 标记，
# Gatekeeper 也就不会评估它 —— 一条命令，没有弹窗，没有四次点击。
#
# 这对 Vibepaws 的用户群尤其合适：会去装一个「盯着 coding agent 的桌宠」的人，
# 手边必然有终端，多半也已经有 Homebrew。
#
# tap 的用法（仓库名不是 homebrew-*，所以要显式给 URL）：
#   brew tap junrong1/vibepaws https://github.com/junrong1/Vibepaws
#   brew install --cask --no-quarantine vibepaws
#
# version / sha256 由 scripts/update_cask.ts 在发版时按真实产物刷新 —— 手抄一次就会错一次。
cask "vibepaws" do
  version "0.1.0"
  sha256 "ba928860516d1bfe8ddafbeee559127df39b6214c45f8dfd41322bc3d53ed14d"

  url "https://github.com/junrong1/Vibepaws/releases/download/v#{version}/Vibepaws-#{version}-arm64.dmg"
  name "Vibepaws"
  desc "Desktop pet that watches your AI coding agents"
  homepage "https://github.com/junrong1/Vibepaws"

  depends_on macos: ">= :sonoma"
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
    Vibepaws is ad-hoc signed but not notarized (that needs a paid Apple Developer account).
    Installing with --no-quarantine skips Gatekeeper entirely, which is why there is no prompt.

    Connect a coding agent from Settings -> Connect your agent, or run:
      npm run adapter:install -- --global
  CAVEATS
end
