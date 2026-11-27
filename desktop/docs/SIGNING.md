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

The updater needs its own signing key (`tauri signer generate`), separate from the OS certificates. See the `TODO(updater)` in `src-tauri/src/lib.rs`.
