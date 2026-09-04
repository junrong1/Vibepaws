# Signing and notarizing a release

[中文](release_signing.zh-CN.md)

Everything in the build is already wired: hardened runtime, entitlements, notarization of both the
`.app` and the `.dmg`, and a verifier that checks the result. What the repo does not and will not
contain is credentials. This document is how you supply them.

Without credentials `npm run dist:mac` still succeeds — it prints `skipped macOS application code
signing` and produces an unsigned `.app`. That is the normal local-development path and nothing
about it is broken.

---

## Why this is not optional

Gatekeeper quarantines any app downloaded without an Apple Developer signature *and* notarization.
The user sees **"Vibepaws is damaged and can't be opened"** — not "unsigned", not "untrusted".
The message actively misleads: it reads as a corrupt download, so people re-download, hit it again,
and file a bug ([#1](https://github.com/junrong1/Vibepaws/issues/1)).

The trap is that none of this reproduces on your own machine. An app you built locally never gets a
quarantine flag, so Gatekeeper never evaluates it. It launches fine, forever, no matter how broken
the signature is. **"It opens here" proves nothing.** That's what `npm run verify:release` is for.

---

## What you need

| | Cost | Where |
| --- | --- | --- |
| Apple Developer Program membership | $99/year | [developer.apple.com/programs](https://developer.apple.com/programs/) |
| **Developer ID Application** certificate | included | Certificates, Identifiers & Profiles |
| App Store Connect **API key** | included | [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api) |

Two notes that save an afternoon:

- The certificate type must be **Developer ID Application**. Not "Apple Development", not "Apple
  Distribution", not "Mac App Distribution". Only Developer ID is valid for shipping outside the
  App Store, and the other types fail with an unhelpful error late in the build.
- Prefer the **API key** over Apple ID + app-specific password. It can be revoked on its own without
  touching the Apple ID, and it doesn't break when 2FA state changes. This is electron-builder's own
  recommendation ([#7859](https://github.com/electron-userland/electron-builder/issues/7859)).

---

## One-time setup

### 1. Certificate

Create it in Xcode (*Settings → Accounts → Manage Certificates → + → Developer ID Application*), or
from a CSR on the developer portal. Then confirm the Mac can see it:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

For CI, export it from Keychain Access as a `.p12` with a password, then:

```bash
base64 -i Certificates.p12 | pbcopy     # → secret APPLE_CERTIFICATE_P12
```

### 2. Notarization key

Create an API key with the **Developer** role. You can download the `.p8` exactly once — losing it
means generating a new key. Keep the Key ID and Issuer ID alongside it.

### 3. Environment

```bash
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8   # path to the .p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
```

Or, if you'd rather use an Apple ID:

```bash
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop     # appleid.apple.com, not your password
export APPLE_TEAM_ID=XXXXXXXXXX
```

Give all three of whichever set you pick. A half-set is worse than none — electron-builder throws on
it, but only after a full build has already run.

---

## Releasing

### Locally

```bash
npm run verify:release -- --preflight   # 30 seconds; catches a missing cert before you wait
npm run dist:mac                        # signs, notarizes, staples
npm run verify:release                  # asks macOS whether it actually worked
```

Notarization is a round trip to Apple and usually takes 1–5 minutes per artifact.

### From CI (preferred)

`.github/workflows/release.yml` runs on any `v*` tag. Set these repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_API_KEY_P8` | contents of the `.p8`, verbatim |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

```bash
git tag v0.1.1 && git push origin v0.1.1
```

The workflow imports the certificate into a throwaway keychain, preflights, tests, builds, verifies,
destroys the keychain, and attaches the artifacts to a GitHub release. Keeping this in CI matters for
a reason beyond convenience: if the signing identity lives only in one person's keychain, then "who
can ship" quietly becomes "whose laptop still works."

---

## What the pieces are

| Path | Role |
| --- | --- |
| `build/entitlements.mac.plist` | Hardened-runtime entitlements for the main process. Deliberately minimal; every key is commented with what breaks without it. |
| `build/entitlements.mac.inherit.plist` | Same, for Electron's helper processes. |
| `build/notarize-dmg.cjs` | Notarizes and staples the `.dmg`. electron-builder only does the `.app`. |
| `scripts/verify_release.ts` | `--preflight` before, full verification after. |
| `scripts/packaging.test.ts` | Guards the config against regressions, in `npm test`. |

### Why the DMG needs its own step

electron-builder notarizes and staples the `.app`, then packs the already-stapled app into the dmg
and zip. So dragging the app out of the dmg and running it works — the ticket is on the app.

But the moment a user **double-clicks the dmg**, Gatekeeper evaluates the *dmg*, which has no ticket
of its own, and shows the warning. That's the "click through Privacy & Security on every update"
complaint that made this a blocking item. `build/notarize-dmg.cjs` submits and staples the dmg
separately to close it.

The zip is deliberately left alone: the format has nowhere to store a stapled ticket, and Apple
doesn't support stapling one. The app inside it is already stapled, which is what the update path
needs.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `skipped macOS application code signing` | No Developer ID cert in the keychain. Expected locally; a bug in CI. Run the preflight. |
| `skipped macOS notarization` | No credentials in the environment. Same check. |
| App is signed but crashes instantly on launch | An entitlement is missing — almost always `allow-jit`. V8 can't allocate executable memory and the kernel kills the process. Unsigned builds don't show this, only signed ones do. |
| Notarization rejected, "binary is not signed" | A Mach-O in the bundle didn't get signed. `npm run verify:release` lists exactly which ones. Usually something new added to `extraResources`. |
| `The specified item could not be found in the keychain` in CI | The `set-key-partition-list` step didn't run, or the keychain isn't in the search list. Both are handled in the workflow — check the import step's output. |
| Notarization accepted but users still get warned | The dmg wasn't stapled. Check the tail of the build log for the `notarize-dmg` step. |
| `Team ID` mismatch | The cert and the API key belong to different teams. |
