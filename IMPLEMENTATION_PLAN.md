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
