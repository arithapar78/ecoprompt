# Installing EcoPrompt Desktop (unsigned builds)

EcoPrompt Desktop is not yet code-signed. That does not mean it is unsafe. It means we have not paid Apple and Microsoft for the certificates that remove the first-launch warning. Your computer shows the warning for any app it has not seen signed.

You only do this once.

## Before you start (optional but recommended)

Check that your download is the file we published. On the release page, open `SHA256SUMS.txt`, then compare:

- **Mac:** `shasum -a 256 ~/Downloads/EcoPrompt_0.1.0_universal.dmg`
- **Windows (PowerShell):** `Get-FileHash $HOME\Downloads\EcoPrompt_0.1.0_x64-setup.exe -Algorithm SHA256`

The long string must match the one in `SHA256SUMS.txt` for that file name.

## Mac

1. Open the `.dmg` and drag **EcoPrompt** into **Applications**.
2. Open **EcoPrompt** from Applications. macOS says it "could not verify" the app and offers only **Done** and **Move to Trash**. Click **Done**. Do **not** move it to the Trash.
3. Open **System Settings → Privacy & Security** and scroll down to the message about "EcoPrompt" being blocked. Click **Open Anyway**.
4. Enter your password, then click **Open**.

Prefer Terminal? Run `xattr -cr /Applications/EcoPrompt.app` once, then open the app normally.

On macOS 14 and older, right-click (or Control-click) **EcoPrompt** and choose **Open** also works. On macOS 15 and newer, Apple removed that shortcut, so use steps 2-4.

EcoPrompt lives in the menu bar (top right). Closing its window does not quit it, and a small note tells you so. **Can't see the icon?** A crowded menu bar can hide it behind the camera notch. Just open EcoPrompt again from Applications and its window comes back. To quit, use the menu bar icon.

**If macOS says the app "is damaged":** that is the same unsigned-app check. Open Terminal and run `xattr -cr /Applications/EcoPrompt.app`, then open the app again.

## Windows

1. Run the `-setup.exe` you downloaded.
2. If **Windows protected your PC** (SmartScreen) appears, click **More info**, then **Run anyway**.
3. Follow the installer. EcoPrompt appears in the system tray (bottom right, you may need to click the **^** arrow).

If your browser warns when downloading, choose **Keep** (Edge/Chrome) first.

## Privacy

No account, no tracking. Your prompts and your energy history stay on your computer. The app only goes online if you click **Check for updates** in Settings, and then it only downloads one small file from GitHub.

## Uninstall

- **Mac:** quit EcoPrompt from the menu bar, delete it from Applications. Data: `~/Library/Application Support/com.learntav.ecoprompt/`.
- **Windows:** Settings → Apps → EcoPrompt → Uninstall.
