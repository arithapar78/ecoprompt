# Signing and notarization

Releases are currently **ad-hoc signed** on Mac and **unsigned** on Windows. That is why macOS shows "could not verify" (Done / Move to Trash) and Windows shows SmartScreen. Users follow `INSTALL-UNSIGNED.md`.

The release workflow already supports real Mac signing. It turns on by itself once these repository secrets exist (Settings → Secrets and variables → Actions). No code change is needed.

## Mac: Developer ID + notarization (removes the warning completely)

Cost: Apple Developer Program, 99 USD/year. Needs an Apple ID with two-factor on.

1. Enroll at developer.apple.com/programs.
2. In Xcode or the developer portal, create a **Developer ID Application** certificate. Export it from Keychain Access as a `.p12` with a password.
3. Base64 it: `base64 -i certificate.p12 | pbcopy`.
4. Create an **app-specific password** at appleid.apple.com (Sign-In and Security).
5. Add these secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | the base64 text from step 3 |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` (`security find-identity -v -p codesigning`) |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | the 10-character team ID |

Push a new `desktop-v*` tag. The Mac job signs and notarizes (a few extra minutes). All six secrets must be set, otherwise the workflow logs "Apple secrets not set" and falls back to ad-hoc.

## Windows

Cost: about 100-400 USD/year for an OV/EV code-signing certificate (EV removes SmartScreen warnings immediately; OV builds reputation over time), or Azure Trusted Signing at roughly 10 USD/month for eligible organizations. Not wired into the workflow yet because it depends on which provider is chosen.

## Auto-update

Settings has a **Check for updates** button (never automatic). It reads `latest.json` from the latest GitHub release and verifies the download against the public key in `tauri.conf.json`.

The key pair was generated with `tauri signer generate`. The private key lives at `~/.tauri/ecoprompt-updater.key` on the maintainer's Mac (no password). **Back it up. If it is lost, installed apps can never be updated again.** Never commit it.

To enable update files in releases, add one repository secret:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `~/.tauri/ecoprompt-updater.key` (`cat ~/.tauri/ecoprompt-updater.key \| pbcopy`) |

Without it releases still build; they just have no `latest.json`, and the button says it could not check. Versions before the first updater-enabled release (0.1.6) cannot update themselves; users install that one manually.
