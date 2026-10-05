# YubiWallet native-messaging host

Starlab Wallet talks to a YubiKey through the **YubiWallet native host**
(`stars-labs/yubiwallet`) over Chrome [native messaging]. The host runs
outside the browser, drives the card (PIV / OpenPGP applets), collects the
PIN itself (local GUI pinentry — never through the extension), and performs the
actual ECDSA/EdDSA signing.

The extension only reaches the host from the **background service worker**
(`chrome.runtime.connectNative("com.yubiwallet.host")`). If the host is not
installed the extension degrades gracefully: `discoverYubiKeyAccounts()`
returns `[]`, no YubiKey accounts appear, and the FROST/MPC flow is
unaffected.

## Install

1. Build / install the `yubiwallet-host` binary. Browser-compatible GUI PIN
   collection requires host revision
   [`55283e6`](https://github.com/stars-labs/yubiwallet/tree/55283e6b9740f65025b15170f082679ca1d52ee4)
   ([host PR](https://github.com/stars-labs/yubiwallet/pull/19)); the earlier
   terminal-only host cannot collect a PIN when launched by the browser.
   Follow that revision's installation guide. Install `pinentry-qt`, or set
   `YUBIWALLET_PINENTRY` to a local GUI pinentry executable in the host launcher.
   A PIN must not be placed in the extension, manifest, command line or logs.

2. Copy `com.yubiwallet.host.json` (next to this README) into the browser's
   native-messaging-hosts directory and edit the two placeholders:

   - `path` → the **absolute** path to the installed host binary.
   - `allowed_origins[0]` → `chrome-extension://<YOUR_EXTENSION_ID>/`
     (find the id at `chrome://extensions` with Developer Mode on).

   Per-OS / per-browser locations:

   | Browser | macOS | Linux |
   |---|---|---|
   | Chrome | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` | `~/.config/google-chrome/NativeMessagingHosts/` |
   | Chromium | `~/Library/Application Support/Chromium/NativeMessagingHosts/` | `~/.config/chromium/NativeMessagingHosts/` |
   | Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` |

   The file name **must** be `com.yubiwallet.host.json` (matches the
   `name` field and the `HOST_NAME` in `src/signers/yubikey/host-client.ts`).

   Firefox uses a `allowed_extensions` array keyed by the add-on id instead of
   `allowed_origins`; see the Mozilla native-messaging docs.

3. Plug in a supported, provisioned YubiKey and reload the extension.
   Discovered accounts appear with a **YubiKey** badge. The host opens the local
   PIN dialog when required. Cancelling that dialog returns an operation error.

Host unit, framed-process and build checks pass; physical-card signing was not
verified in this environment. Firefox packaging alone does not prove wallet
cryptographic runtime support.

[native messaging]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
