# Performance: bundle size, SW cold-start, mesh degree (M4, #27)

Measured 2026-06-11 on `chore/perf-m4` (base: main @ 2068274).
Toolchain: bun + wxt 0.20.26 (Vite 8 / rolldown), `bun run build` (chrome-mv3,
production). Attribution from rolldown sourcemaps (`ANALYZE=1 bun run build`
now emits maps; per-module byte counts decoded from the VLQ mappings).

## 1. Bundle sizes per entrypoint

| Entrypoint                    | Before    | After     | Δ        |
|-------------------------------|-----------|-----------|----------|
| `background.js` (SW)          | 830.26 kB | 830.26 kB | 0        |
| `chunks/popup-*.js`           | 686.84 kB | 496.26 kB | −190.6 kB (−28%) |
| `chunks/offscreen-*.js`       | 115.51 kB | 115.51 kB | 0        |
| `content-scripts/content.js`  | 8.59 kB   | 8.59 kB   | 0        |
| `injected.js`                 | 17.82 kB  | 17.82 kB  | 0        |
| lazy `chunks/index.browser.esm-*.js` (@solana/web3.js) | — | 184 kB (on demand) | new |
| stray `index.js`/`index.d.ts`/`package.json` in output root | 39.9 kB | removed | −39.9 kB |
| WASM `assets/starlab_core_wasm_bg-*.wasm` | 1.17 MB | 1.17 MB | 0 (single copy) |
| **Σ total**                   | **2.96 MB** | **2.92 MB** | −40 kB on disk; popup −190 kB at load |

### What was done

- **@solana/web3.js out of the popup's static graph.** The one static edge
  was `import { PublicKey }` in `solanaNftService.ts` (used only for the
  Metaplex metadata PDA). That edge pulled the whole web3.js stack —
  web3.js 120 kB + bn.js 43 kB + buffer 24 kB + @solana/buffer-layout 17 kB
  + borsh 7 kB ≈ **~210 kB minified** — into the popup via NftGallery, and
  it also defeated `rpcHandler`'s existing `await import('@solana/web3.js')`
  (a statically-reachable module can't be split into a lazy chunk).
  `metadataPda()` is now async and dynamic-imports web3.js; the popup loads
  the 184 kB chunk only when a Solana NFT/sign path actually runs.
- **Dead wasm-bindgen pkg copy removed from `public/`** (`index.js`,
  `index.d.ts`, `package.json` — leftovers from the frost-mpc extraction,
  shipped verbatim into the output root, referenced by nothing).
- **`ANALYZE=1` sourcemap switch** added to `wxt.config.ts` for future
  attribution work (off by default).

### Where the remaining bytes are (post-trim attribution)

`background.js` (830 kB): viem 250 kB, app code 171 kB, @solana/web3.js
120 kB + bn.js 43 kB + buffer 24 kB + buffer-layout 17 kB, ox 40 kB,
@noble/curves 38 kB, svelte runtime 16 kB, @noble/hashes 16 kB.

`popup` (496 kB): viem 161 kB, app code 117 kB, svelte 43 kB, ox 34 kB,
@noble/curves 21 kB, abitype 14 kB. No solana, no wasm.

`offscreen` (115 kB): all app code — webrtc.ts 64 kB, wasm-bindgen glue
25 kB, index.ts 23 kB. The 1.17 MB WASM binary is referenced **only** from
the offscreen chunk; neither popup nor background bundles or fetches it.

### Why background.js did not shrink (and what would)

MV3 **service workers cannot use dynamic `import()`** (Chrome rejects it at
runtime), so rolldown correctly inlines every `await import(...)` in the SW
graph — including rpcHandler's web3.js import and the policy/keystore lazy
imports. The ~210 kB Solana stack therefore stays in `background.js` as long
as the SW deserializes/signs Solana transactions itself.

Options, in increasing order of churn (all deliberately **not** done here):
1. Move Solana tx deserialization to the offscreen document (it already owns
   the heavy FROST/WASM work and *can* dynamic-import). SW keeps a thin
   message round-trip. Saves ~210 kB of SW parse.
2. Replace web3.js usage (PDA derive + VersionedTransaction deserialize)
   with @solana/kit or a hand-rolled ~2 kB decoder; web3.js v1 is famously
   monolithic.
3. viem (250 kB in SW, 161 kB in popup): already tree-shaken (only
   mainnet/sepolia chains are imported); the bulk is `createPublicClient`
   action surface (ens/abi/multicall). Trimming means importing per-action
   from `viem/actions` — broad refactor across networkService/walletClient.

## 2. SW cold-start

Findings from `entrypoints/background/index.ts` review:

- **Already well-shaped for MV3.** `defineBackground()` runs synchronous
  work only: component construction, `chrome.runtime.onConnect` /
  `onMessage` listeners, notification click handler, and
  `setupActivityReconciler()` (chrome.alarms) — all registered on every SW
  start, as MV3 requires. The async startup (keystore restore, WebSocket
  connect, YubiKey discovery) is a fire-and-forget task at the end.
- Service singletons (`AccountService`/`NetworkService`/`WalletClientService`
  `getInstance()` at module top) have lightweight constructors that defer
  storage I/O to async `initializeAsync()` — no blocking work at import time.
- **No WASM in the SW** — wasm init happens in offscreen only.
- The dominant cold-start cost is therefore **parsing 830 kB of JS**, ~460 kB
  of which is viem + the Solana stack (see options above). Chrome's bytecode
  cache softens repeat starts, but first-start and post-update starts pay it
  in full. Cutting the Solana stack out of the SW (option 1/2) is the single
  biggest cold-start lever left.
- Known wart (not perf): the auto-lock `setInterval(60s)` dies with the SW;
  it only ticks while something else keeps the worker alive. If strict
  auto-lock matters, it should move to `chrome.alarms` like the reconciler.

## 3. WebRTC full-mesh cost by cohort size

Today every session builds a full mesh: each device holds a P2P
DataChannel to every other device. Costs per cohort size `n`:

- connections per device: `n − 1`; total connections: `n(n−1)/2`
- signaling (via the WebSocket relay) per joining pair: 1 offer + 1 answer
  + ~2×k ICE candidates (k ≈ 2–6 per side typical; take 4/side ⇒ ~10 msgs/pair)
- DKG: Round 1 is a broadcast (each device sends its commitment package to
  the other `n − 1`); Round 2 is pairwise (each device sends a distinct
  encrypted share to each of the other `n − 1`). Total R1 ≈ R2 ≈ `n(n−1)`
  directed packages on the wire. Reshare follows the same two-round shape.

| n  | conns/device | total conns | signaling msgs (~10/pair) | DKG R1 pkgs | DKG R2 pkgs | total DKG pkgs |
|----|--------------|-------------|---------------------------|-------------|-------------|----------------|
| 3  | 2            | 3           | ~30                       | 6           | 6           | 12             |
| 5  | 4            | 10          | ~100                      | 20          | 20          | 40             |
| 7  | 6            | 21          | ~210                      | 42          | 42          | 84             |
| 10 | 9            | 45          | ~450                      | 90          | 90          | 180            |

Practical limits, not just message counts:

- **ICE storms at join:** all `n − 1` connections for a newcomer negotiate
  simultaneously; at n=10 a joiner produces/consumes ~90 signaling messages
  in a burst through one WebSocket. The signal server is the bottleneck
  before the browser is.
- **Browser per-connection cost:** each RTCPeerConnection carries its own
  DTLS handshake, ICE keepalives (~1 STUN ping/connection/2.5 s) and SCTP
  state. 9 connections per device is fine on desktop; the offscreen
  document's single thread also runs FROST/WASM, so ceremonies at n=10
  contend with 9 channels' worth of event traffic.
- **Failure amplification:** mesh health requires all `n(n−1)/2` links up
  before a ceremony starts (`MeshStatus: Ready`). P(all up) decays roughly
  with link count — at n=10 there are 45 links that can each flap.

**Recommendations:**

- n ≤ 5: full mesh is the right call (≤10 links, trivial signaling). This is
  the investor-demo regime; no change needed.
- n = 6–7: full mesh still works but joins get bursty; stagger ICE
  negotiation (connect to peers sequentially or in small batches) rather
  than all-at-once to flatten the signaling spike.
- n > ~7: stop growing the mesh. Two viable shapes:
  - **Hub-relay:** elect (or designate) 1–2 relay devices; others connect
    only to relays ⇒ O(n) connections total. DKG R2 pairwise packages are
    end-to-end encrypted already, so relaying ciphertext through a hub does
    not change the trust model.
  - **Gossip/partial mesh:** each device keeps ~3–4 links (k-regular graph);
    broadcasts flood, pairwise messages route. More resilient than a hub but
    needs routing/dedup logic.
  Either way the FROST math is unchanged — only transport topology moves.
- Signaling server: batch ICE candidates per (from,to) pair instead of one
  WS frame per candidate; this alone cuts join-burst message count ~4×.
