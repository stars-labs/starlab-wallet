# YubiWallet native-messaging host

Starlab Wallet talks to a YubiKey through the **YubiWallet native host**
(`stars-labs/yubiwallet`) over Chrome [native messaging]. The host runs
outside the browser, drives the card (PIV / OpenPGP applets), collects the
PIN itself (env or pinentry — never through the extension), and performs the
actual ECDSA/EdDSA signing.

The extension only reaches the host from the **background service worker**
(`chrome.runtime.connectNative("com.yubiwallet.host")`). If the host is not
installed the extension degrades gracefully: `discoverYubiKeyAccounts()`
returns `[]`, no YubiKey accounts appear, and the FROST/MPC flow is
unaffected.

## Install

1. Build / install the `yubiwallet` host binary from
   [`stars-labs/yubiwallet`](https://github.com/stars-labs/yubiwallet).

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

3. Plug in the YubiKey and reload the extension. YubiKey accounts show up in
   the popup account list with a **YubiKey** badge.

[native messaging]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
