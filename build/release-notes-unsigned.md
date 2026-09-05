## Opening this build

This build is **ad-hoc signed but not notarized** — notarization requires a paid Apple Developer
account. macOS will say *"Apple could not verify Vibepaws is free of malware."* That is expected,
and here is how to open it:

1. Drag **Vibepaws** into your **Applications** folder, then double-click it.
2. macOS blocks it. Open **System Settings → Privacy & Security**.
3. Scroll down to **Security**. You'll see *"Vibepaws was blocked to protect your Mac."*
   Click **Open Anyway**.
4. Confirm once more. macOS remembers the choice — first launch only.

> On macOS Sequoia and later, Control-clicking the app no longer works as a shortcut for this.
> System Settings is the only route.

### Or install with Homebrew

```bash
brew tap junrong1/vibepaws https://github.com/junrong1/Vibepaws
brew trust junrong1/vibepaws        # Homebrew 6 requires this for third-party taps
brew install --cask vibepaws
```

This gives you `brew upgrade` for future versions. It does **not** skip the approval above —
Homebrew 6 removed `--no-quarantine`, so cask downloads are always quarantined. To skip the
System Settings trip, clear the flag yourself:

```bash
xattr -dr com.apple.quarantine /Applications/Vibepaws.app
```

### What "not notarized" does and doesn't mean

It means Apple hasn't scanned this build — not that the app is unsigned or modified. The signature
is complete and verifiable (`codesign --verify --deep --strict` passes), which is why you get an
approval prompt rather than *"Vibepaws is damaged."* Every release is built in CI from a public
tag, and the build is reproducible from source with `npm run dist:mac`.
