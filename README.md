# Starlab Wallet

Browser **MPC wallet** (Chrome/Firefox, MV3 + WXT + Svelte). One wallet, three
account backends behind a single `Signer` abstraction:

1. **FROST** — multi-device threshold signing (DKG + signing over a WebRTC mesh),
   via the `@frost-mpc/core-wasm` engine. *(working today)*
2. **YubiKey** — single-sign with on-card keys (PIV / OpenPGP) via the
   [`yubiwallet`](https://github.com/stars-labs/yubiwallet) native-messaging
   host. *(planned)*
3. **Sandbox execution** — point a network at a local fork node (anvil / surfpool)
   to run "create → sign → broadcast" against a simulated chain, no real funds.
   *(planned)*

The EIP-1193 provider, transaction building, and dApp wiring are shared; only the
"produce a signature" step differs per account, so a dApp never sees which
backend signed.

## Layout

```
apps/extension/                 # the MV3 extension (WXT + Svelte)
packages/@frost-mpc/types/      # shared TS types (source; vendored from frost-mpc)
packages/@frost-mpc/core-wasm/  # FROST WASM (VENDORED build artifact, committed)
```

`@frost-mpc/core-wasm` is a **vendored build artifact** from
[`stars-labs/frost-mpc`](https://github.com/stars-labs/frost-mpc) — the engine's
Rust isn't built here. To refresh it: in `frost-mpc` run `bun run build:wasm`,
then copy its `packages/@frost-mpc/core-wasm/pkg/` over the one here. (Proper
decoupling once the `@frost-mpc` npm scope exists: publish `@frost-mpc/core-wasm`
+ `@frost-mpc/types` to npm and depend on the published versions.)

## Develop

```bash
bun install
bun run dev          # extension dev server (hot reload)
bun run build        # production build
```

## The Signer abstraction

`apps/extension/src/signers/` defines the seam:

```ts
interface Signer {
  kind: "frost" | "yubikey-piv" | "yubikey-openpgp";
  curve: "ed25519" | "secp256k1";
  address(chain): string;
  signEd25519(message): Promise<Uint8Array>;      // Solana / Sui
  signSecp256k1(prehash32): Promise<{ r; s; v }>; // EVM / BTC
}
```

- `FrostSigner` wraps the existing FROST flow (offscreen WebRTC + WASM).
- `YubiKeySigner` (planned) calls `chrome.runtime.connectNative` →
  the `yubiwallet` host.
