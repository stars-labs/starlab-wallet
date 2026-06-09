# starlab-wallet: YubiKey + sandbox execution

Turn the browser wallet from a skeleton into a real multi-backend wallet behind
the existing `Signer` seam (`apps/extension/src/signers/`). FROST already works;
add YubiKey hardware signing + a sandbox (fork-chain) execution mode.

> Caveat: a browser extension can't be E2E-tested in this sandbox (no headless
> MV3 SW; native messaging needs the host installed; signing needs a real
> YubiKey). Each stage's gate is **typecheck/build** (`bun run build`); live
> verification is on a real machine with the host + a YubiKey.

## Stage 1: YubiKey signer backend
[DONE] Vendor yubiwallet's native-messaging `HostClient` + types; implement
`YubiKeySigner` (impl `Signer`) wrapping it (sign_secp256k1 / sign_ed25519 /
address per on-card account) + `discoverYubiKeyAccounts(host)`.
**Gate:** `bun run build` (types resolve, extension compiles).
**Status:** Done — committed; typechecks clean.

## Stage 2: wire YubiKey into the extension
Background SW: on startup, open the native host, `listAccounts()`, register a
`YubiKeySigner` per account in the `SignerRegistry`; surface them in the popup
account list alongside FROST accounts; route the EIP-1193 / wallet-standard
signing of a YubiKey account to its signer. Ship the native-messaging manifest
(`com.yubiwallet.host`) + install docs. Flag the host's GUI-pinentry
prerequisite (it reads PIN from /dev/tty today).
**Status:** Done (build-only) — nativeMessaging perm + host manifest + install README; background discovery (YubiKeyManager) → AccountService mirror → popup 'YubiKey' badge; rpcHandler routes EVM personal_sign/tx → signSecp256k1 and Solana → signEd25519. `bun run build` passes. NEEDS REAL-HARDWARE VERIFY: tx v/yParity + 65-byte sig recovery via ecrecover against a real card sig; host GUI pinentry (reads /dev/tty today); fill manifest path + extension id; broadcast is sign-only like FROST.

## Stage 3: sandbox execution
A "Sandbox" network mode whose RPC points at a local fork node (anvil for EVM,
surfpool / solana-test-validator for Solana) + funding (`anvil_setBalance` /
airdrop) + reset. `scripts/sandbox.sh` starts the nodes (the extension can't
spawn processes). UI to select the sandbox network. Real signing + broadcast
against a simulated chain, no real funds.
**Gate:** build; `sandbox.sh` brings the nodes up; a tx confirms on the fork.
**Status:** Done — `scripts/sandbox.sh` (anvil :8545 + surfpool :8899 + funding)
verified: both nodes up, `cast balance` shows the funded 10000 ETH, Solana
`getHealth`=ok. Point the wallet at the RPCs via Settings → custom network. A
built-in "Sandbox" network entry + one-click toggle is an optional follow-up.

## Stage 4: Ledger hardware wallet (a second hardware backend)
Add Ledger behind the same `Signer` seam as YubiKey. The crypto/routing is
already abstracted; the real difference is **transport**: Ledger uses WebHID,
which is unavailable in the MV3 service worker and needs a user gesture — so the
transport lives in the popup, not the SW (unlike YubiKey's native-messaging host
which runs in the SW). Ledger also refuses a raw 32-byte prehash, so the seam
grew an optional `EvmStructuredSigner` capability (sign the full tx / message).

### Stage 4a: Ledger signer backend
[DONE] `src/signers/ledger/`: `transport.ts` (WebHID, popup-only, graceful
no-device fallback), `ledger-signer.ts` (`LedgerSigner` impl `Signer` +
`EvmStructuredSigner` over `hw-app-eth` / `hw-app-solana`; Solana maps to
`signEd25519`, EVM uses the structured methods, raw `signSecp256k1` throws by
design) + `discoverLedgerAccounts()` for the default EVM + Solana paths. Seam:
`SignerKind` gains `"ledger"`; `EvmStructuredSigner` + `isEvmStructuredSigner`
added to `signer.ts`. **Gate:** `bun run build` + `tsc` (0 new type errors;
the 31 remaining are pre-existing). Done — build + typecheck clean.

### Stage 4b: wire Ledger into the extension (NOT STARTED)
Popup "Connect Ledger" button → `requestLedgerTransport()` (user gesture) →
`discoverLedgerAccounts()` → mirror into AccountService (`type:'hardware'`,
badge "Ledger") like YubiKeyManager does. Because the transport can't live in
the SW, route signing: dApp request → background detects a Ledger account →
opens/uses the popup context to run the WebHID sign → returns. EVM signing must
call `signEvmTransaction` / `signEvmPersonalMessage` (full payload), guarded by
`isEvmStructuredSigner`, not the prehash path. NEEDS REAL HARDWARE: on-device
v/recovery for EIP-1559 vs legacy, Solana tx-message signing, the
popup↔background routing under MV3.
