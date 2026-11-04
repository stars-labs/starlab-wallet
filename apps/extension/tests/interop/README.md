# L3c interop harness — extension ↔ CLI conformance (#33)

The highest-value, highest-cost test layer: it crosses the **Rust-core ↔
independent-TypeScript/WASM** boundary. The extension acts as the DKG initiator;
`starlab-cli serve` nodes act as the other co-signers. We assert the
cross-implementation invariant from `docs/cli-conformance-testing.md` §5.4:
**all participants agree on all three group public keys**, and a threshold signature
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
WXT_INSECURE_TEST_PRIMES=1 bun run build         # isolated test build only
```

## Run

```bash
cd apps/extension
# Smoke only (no signal server / CLI): proves the harness + extension load.
bun run test:interop:smoke

# Full interop on a private local signal server (recommended, self-contained):
INTEROP_SIGNAL=local bun run test:interop
# …or against a shared server:
INTEROP_SIGNAL=wss://panda.qzz.io bun run test:interop
```

Env knobs: `INTEROP_SIGNAL` (`local` = spawn a fresh `starlab-signal-server`
per test), `INTEROP_PW`,
`STARLAB_MPC_DIR`, `STARLAB_CLI_BIN`, `STARLAB_SIGNAL_BIN`, `STARLAB_EXTENSION_DIR`, `PLAYWRIGHT_CHROME_PATH`, `INTEROP_BROWSER_LOG=1` to
mirror the offscreen document (WebRTC + FROST rounds) and background
(signal-server traffic, sessions) consoles into the test output, and
`INTEROP_CLI_LOG` / `SERVE_LOG_LEVEL` (e.g. `info`) for the one-shot CLI
commands' and the `serve` peers' own logs.

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

## Weak-network specs

Specs that inject network faults (`netns.ts`) run only inside a user network
namespace with `INTEROP_NETNS=1` and are skipped otherwise. No sudo needed:

```bash
nix shell nixpkgs#xvfb-run nixpkgs#chromium -c unshare --user --map-root-user --net bash -c '
  ip link set lo up
  ip link add d0 type dummy && ip addr add 10.99.0.1/24 dev d0 && ip link set d0 up
  ip route add default dev d0
  PLAYWRIGHT_CHROME_PATH=$(which chromium) INTEROP_NETNS=1 INTEROP_SIGNAL=local \
    xvfb-run -a bun run test:interop'
```

The dummy interface and default route are required: webrtc-rs skips loopback,
and its mDNS multicast join fails with `ENODEV` when there is no route.

## Validation scope

The unified suite replaces the previous single-curve matrix. Current test and
artifact results belong to the associated pull request; a successful collection
or typecheck alone is not a completed DKG or signing test. The outage cases
require their documented private server or network namespace.

## Unified wallet contract

Every creation uses `--curve unified` (no single-algorithm creation mode).
Both initiator directions compare the ed25519, Taproot secp256k1 and ECDSA
public keys against the native encrypted-file headers, without decrypting or
logging private shares. Existing signing cases select their chain explicitly;
FROST refresh does not refresh or retire the ECDSA key.

`keystore-persistence.pw.ts` creates one real 2-of-3 unified wallet, closes the
browser and both native peers, rejects a wrong unlock password, then signs
Solana, Sui, Bitcoin and Ethereum account 1 with fresh native processes and
the restored extension. The third device stays offline. It then exports exactly
three encrypted native-format files and restores them in a fresh browser
profile, comparing every public group key, then really co-signs Ethereum account 1
again with the restored device identity. Test prime fixtures are intentionally
insecure; these profiles and wallets must never hold funds.
