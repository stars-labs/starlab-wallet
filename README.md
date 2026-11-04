# Starlab Wallet

Starlab Wallet is a browser wallet with shared signing across devices. It
supports threshold ECDSA for Ethereum and FROST for Bitcoin, Solana and Sui,
with encrypted device shares and public account/address derivation. The popup
includes assets, activity, Receive, Ethereum Send, connected apps, network and
account management, backups, and signing approvals.

## Install a development build

Use a current Chromium browser and Bun 1.4.4 (the version recorded in
`packageManager`). Build the shared types before running WXT installation scripts:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build:types
(cd apps/extension && bun run postinstall)
bun run check
bun run build
```

Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**,
and choose `apps/extension/.output/chrome-mv3`. Pin **Starlab Wallet** in the
browser toolbar. After rebuilding, use **Reload** on the extension card.

To create a distributable development ZIP:

```bash
cd apps/extension
bun run zip
```

Extract the generated ZIP before using **Load unpacked**. This is a development
build, not a Chrome Web Store release. Firefox build scripts exist, but a build
alone does not establish runtime support for the offscreen signing flow; the
verified browser path is Chromium.

## Use the wallet

1. Open the extension and choose **YubiKey** to create a passwordless local
   vault, or choose **Password**. YubiKey setup requires a FIDO2 key with
   WebAuthn PRF support; follow the browser's PIN and touch prompts. Each device
   stores its own encrypted share and still needs the other signing devices.
2. Choose **Create wallet** on one device. Select the devices and threshold,
   then share the invitation with the other participants. On each invited
   device, use **Accept & join** and keep the clients connected until setup
   finishes. All clients must use the same signal-server room.
3. Select the wallet, account and network. **Receive** shows that account's
   address and QR code. Verify the network before transferring funds.
4. For Ethereum on Account 0, choose **Send**, enter the recipient and amount,
   then **Review transfer**. Verify the amount, address and fee before
   **Confirm send**. Enough participating devices must approve the request;
   each approving device unlocks its local share. Activity shows submission
   and confirmation. Other unsupported Send combinations remain disabled.
5. Use **Sign message** for the supported chain's message-signing flow. A
   signing request on another device can be approved or declined. Verify what
   you are signing on the requesting device before approving its digest.
6. Open **Settings** to manage connected apps, appearance, networks, contacts,
   spending limits and backups. Disconnecting a dApp removes its wallet
   connection; existing on-chain token approvals are managed separately.
7. In **Backup**, acknowledge that the file contains key material, choose a
   backup password and export the encrypted share. Restore with **Restore
   from backup** using the password assigned to that backup. A single share
   backup is not the complete wallet and does not remove the signing threshold.

Locking and reopening preserve the encrypted wallet. Unlock this device to
resume; keep the required co-signers online for a new signing ceremony. Never
share an unencrypted device share or a password with another participant.

**Share refresh currently covers Bitcoin, Solana and Sui. Ethereum ECDSA shares
are unchanged by refresh.** Dropping a device through FROST refresh does not
remove that device's Ethereum share. Follow the recovery guidance for the
chain you use.

## Passwordless vaults

A new or empty vault can use YubiKey for setup and unlock without a wallet
password. Existing password-protected wallets are not automatically converted.
This uses the browser's WebAuthn PRF flow; the native host described below is
only needed for hardware signing accounts. Unsupported keys fail with an error.

For a hardware vault, verify your YubiKey in **Settings** before exporting a
backup, then choose a separate password for the portable backup file. Keep a
recoverable share backup before relying on one physical key. Physical YubiKey
compatibility still needs verification on your device.

When updating an unpacked build, replace files in the **same directory** and
click **Reload** on its extension card. A different directory can change the
extension identity and prevent access to the existing WebAuthn credential.

## Hardware accounts

**Add hardware or watch-only account** exposes Ledger, YubiKey and watch-only
account flows. Ledger uses WebHID and requires the appropriate device app.
YubiKey requires the separately installed
[`yubiwallet`](https://github.com/stars-labs/yubiwallet) native host; see the
[native-messaging guide](apps/extension/integration/native-messaging/README.md).
Hardware integration tests and UI fixtures do not replace verification on a
physical device. Watch-only accounts cannot sign.

## Local simulation

Start local fork nodes with Foundry (`anvil`/`cast`) and `surfpool` installed:

```bash
scripts/sandbox.sh --fund-eth 0xYourEthAddr --fund-sol YourSolAddr
```

Then choose **Settings → Sandbox mode → Enter sandbox**. The wallet switches
to local EVM/Solana networks; **Exit sandbox** restores the previous networks.
The script owns the node processes because an extension cannot start them.
Simulation still requires real signing approvals, but uses local-chain funds.

## Development and verification

```bash
bun run dev
bun test
cd apps/extension
bun run test:interop
```

Interop tests exercise actual WASM and native CLI clients. Some cases require
network namespaces and the engine CLI; use the committed CI workflow for the
full setup. Production builds must not enable insecure fixture-prime hooks.

The [visual acceptance](docs/design/wallet-visual-acceptance.md) and
[glass/compact-layout evidence](docs/design/glass-and-motion.md) record the
Rabby, MetaMask and Phantom comparison and rendered interface checks. Real
three-client Sepolia transaction evidence is maintained in the
[engine repository](https://github.com/stars-labs/starlab-mpc/blob/a41cba9/docs/testing/SEPOLIA_LIVE_ACCEPTANCE.md).

## Repository layout

- `apps/extension/`: WXT/Svelte popup, service worker, offscreen signing,
  injected provider, account integrations and tests.
- `packages/@starlab/types/`: shared TypeScript types.
- `packages/@starlab/core-wasm/`: committed WASM artifact from
  [`starlab-mpc`](https://github.com/stars-labs/starlab-mpc).

To refresh WASM, build it in the engine repository and copy its
`packages/@starlab/core-wasm/pkg/` here. The native engine revision and artifact
hash must remain reviewable together; this repository does not rebuild Rust
as part of the extension build.
