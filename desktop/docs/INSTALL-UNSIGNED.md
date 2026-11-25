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
2. Open **Applications**, **right-click** (or Control-click) **EcoPrompt**, and choose **Open**.
3. A warning appears. Click **Open**.

If macOS only offers **Done** / **Move to Trash** (newer macOS versions):

1. Click **Done**.
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the message about "EcoPrompt" being blocked and click **Open Anyway**.
4. Enter your password, then click **Open**.

EcoPrompt lives in the menu bar (top right). Closing its window does not quit it.

**If macOS says the app "is damaged":** that is the same unsigned-app check. Open Terminal and run `xattr -cr /Applications/EcoPrompt.app`, then open the app again.

## Windows

1. Run the `-setup.exe` you downloaded.
2. If **Windows protected your PC** (SmartScreen) appears, click **More info**, then **Run anyway**.
3. Follow the installer. EcoPrompt appears in the system tray (bottom right, you may need to click the **^** arrow).

If your browser warns when downloading, choose **Keep** (Edge/Chrome) first.

## Privacy

No account, no tracking, no network calls. Your prompts and your energy history stay on your computer.

## Uninstall

- **Mac:** quit EcoPrompt from the menu bar, delete it from Applications. Data: `~/Library/Application Support/com.learntav.ecoprompt/`.
- **Windows:** Settings → Apps → EcoPrompt → Uninstall.
