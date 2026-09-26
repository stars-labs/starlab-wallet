# L3c interop harness — extension ↔ CLI conformance (#33)

The highest-value, highest-cost test layer: it crosses the **Rust-core ↔
independent-TypeScript/WASM** boundary. The extension acts as the DKG initiator;
`starlab-cli serve` nodes act as the other co-signers. We assert the
cross-implementation invariant from `docs/cli-conformance-testing.md` §5.4:
**all participants agree on the group public key**, and a threshold signature
produced with the extension in the mesh **verifies**.

```
   extension (TS + WASM)  ──┐
                            ├── signal server (room-scoped) ── WebRTC mesh ── DKG + signing
   2× starlab-cli serve ─┘            (Rust core)
```

## Files

| File | Role |
|---|---|
| `fixtures.ts` | Loads the built MV3 extension into a headed, persistent Chromium and resolves its extension id. |
| `cli-peers.ts` | Spawns N `starlab-cli serve` co-signers via `scripts/demo/serve_autojoin.py`; parses their `RESULT … dkg_complete/signature_complete` lines. |
| `extension-actions.ts` | All popup UI steps in one place: onboarding, room, create wallet, save, sign. |
| `boundary.pw.ts` | **Runnable smoke** — loads the extension, saves a strong room. No CLI/server needed. |
| `dkg-signing.pw.ts` | **Full interop** — ext + 2 CLI DKG + signing; group-key and signature cross-assert. |

> Specs use the `.pw.ts` suffix (not `.spec.ts`/`.test.ts`) so Bun's unit test
> runner ignores them; Playwright collects them via `testMatch: **/*.pw.ts`.

## Prerequisites

The CLI peers and the local signal server come from
[starlab-mpc](https://github.com/stars-labs/starlab-mpc), expected as a sibling
checkout (`../starlab-mpc`; override with `STARLAB_MPC_DIR`).

```bash
# in starlab-mpc
cargo build --release -p starlab-cli -p starlab-signal-server
# in this repo
bun run build                                  # produces apps/extension/.output/chrome-mv3
```

## Run

```bash
cd apps/extension
# Smoke only (no signal server / CLI): proves the harness + extension load.
bun run test:interop:smoke

# Full interop on a private local signal server (recommended, self-contained):
INTEROP_SIGNAL=local bun run test:interop
INTEROP_SIGNAL=local INTEROP_CURVE=ed25519 bun run test:interop
# …or against a shared server:
INTEROP_SIGNAL=wss://panda.qzz.io bun run test:interop
```

Env knobs: `INTEROP_SIGNAL` (`local` = spawn a fresh `starlab-signal-server`
per test), `INTEROP_CURVE` (secp256k1|ed25519), `INTEROP_PW`,
`STARLAB_MPC_DIR`, `PLAYWRIGHT_CHROME_PATH`, and `INTEROP_BROWSER_LOG=1` to
mirror the offscreen document's console (WebRTC + FROST rounds) into the
test output.

## Environment requirements (verified)

- **Headed Chromium.** MV3 extension service workers don't load headless, so
  a display-less run needs `xvfb-run`.
- **Chromium, not Google Chrome.** Branded Chrome (137+) ignores
  `--load-extension`. On Nix:
  ```bash
  nix shell nixpkgs#xvfb-run nixpkgs#chromium -c bash -c \
    'PLAYWRIGHT_CHROME_PATH=$(which chromium) INTEROP_SIGNAL=local xvfb-run -a bun run test:interop'
  ```
- The fixture disables Chromium's mDNS host-candidate hiding: every peer runs
  on one machine and the Rust peers can't resolve `.local` candidates.
- A private server per test matters: CLI peers auto-join any DKG they see,
  so a stale session on a shared server captures them.

## Status

Against starlab-mpc `main` + stars-labs/starlab-mpc#110 (frost-native
identifiers, JSON-or-binary decoding, `to_frost_wire`), with the extension
speaking the CLI's native `DKG_ROUND*:` / `SIGN_*:` frames:

- **DKG — passing** for secp256k1 and ed25519: extension-initiated, two CLI
  peers, all three agree on the group key.
- **Signing — the extension-participation assertion fails, deliberately.**
  The CLI signs with whichever threshold-many commitments arrive first and
  doesn't announce joins, so the two CLI peers complete a 2-of-3 signature
  among themselves before the extension's ceremony starts. This needs a
  protocol decision (proposer-chosen signer list in the signing announce).

Not yet covered: CLI-initiated DKG/signing with the extension joining, and
mixed extension/CLI reshare.
