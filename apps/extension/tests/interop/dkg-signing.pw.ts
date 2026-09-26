// L3c interop: extension (DKG initiator) + 2 CLI co-signers run a real DKG and
// threshold signing over a live signal server + shared room, then we assert the
// cross-implementation invariant: the Rust CLI peers and the TS/WASM extension
// AGREE on the group public key (#33).
//
// This is the ONLY layer that crosses the Rust-core ↔ independent-TS/WASM
// boundary, so it's where wire-protocol / round-accounting mismatches surface.
//
// Prereqs (see tests/interop/README.md):
//   - `cargo build --release -p starlab-cli`
//   - `bun run build`               (produces .output/chrome-mv3)
//   - `bunx playwright install chromium`
//   - INTEROP_SIGNAL set to a reachable signal server (default: deployed worker)
import { test, expect, mirrorOffscreenConsole } from "./fixtures";
import { openPopup, onboard, useSignalServer, setRoom, createWallet, dkgResult, saveWallet, signMessage } from "./extension-actions";
import { startPeers, killPeers, freshRoom, ensurePrereqs, startSignalServer, type Peer } from "./cli-peers";

// "local" = a private starlab-signal-server per test (see startSignalServer).
const SIGNAL = process.env.INTEROP_SIGNAL ?? "wss://panda.qzz.io";
const CURVE = process.env.INTEROP_CURVE ?? "secp256k1";
const PASSWORD = process.env.INTEROP_PW ?? "interop-test-password";
const THRESHOLD = 2;
const TOTAL = 3; // 1 extension + 2 CLI

test.describe.configure({ mode: "serial", timeout: 180_000 });

test("ext + 2 CLI: DKG group keys agree, then a signature verifies", async ({ page, context, extensionId }) => {
  ensurePrereqs();
  const room = freshRoom();
  let peers: Peer[] = [];
  const server = SIGNAL === "local" ? await startSignalServer() : null;
  const signal = server?.url ?? SIGNAL;
  try {
    if (process.env.INTEROP_BROWSER_LOG) await mirrorOffscreenConsole(context);

    // 1. Extension: first-run password, same signal server + room as the CLI.
    await useSignalServer(context.serviceWorkers()[0], signal);
    await openPopup(page, extensionId);
    await onboard(page, PASSWORD);
    await setRoom(page, room);

    // 2. Start the 2 CLI co-signers (they auto-join the DKG we create).
    peers = startPeers({ count: TOTAL - 1, signal, room, curve: CURVE, password: PASSWORD });

    // 3. Extension creates the wallet → becomes DKG initiator.
    await createWallet(page, { threshold: THRESHOLD, total: TOTAL, curve: CURVE });

    // 4. Both CLI peers must finish DKG and agree on the group key.
    const results = await Promise.all(peers.map((p) => p.dkg));
    const groupKeys = new Set(results.map((r) => r.groupKey));
    expect(groupKeys.size, "all CLI peers must agree on one group key").toBe(1);
    const cliGroupKey = results[0].groupKey;
    expect(cliGroupKey).toMatch(/^[0-9a-f]+$/);

    // 5. Cross-impl check: the TS/WASM extension derived the same group key
    //    as the Rust peers (the L4 differential-oracle invariant).
    const ext = await dkgResult(page);
    expect(ext.groupPublicKey, "extension and CLI peers must agree on the group key").toBe(cliGroupKey);
    await saveWallet(page, PASSWORD);

    // 6. Sign from the extension; the CLI peers auto-approve. A completed
    //    signature on the peer side means the cross-impl ceremony closed.
    await signMessage(page, "interop-hello");
    const sigs = await Promise.all(peers.map((p) => p.signature));
    for (const s of sigs) expect(s.sig).toMatch(/^0x[0-9a-f]+$/);
    expect(new Set(sigs.map((s) => s.sig)).size, "all peers must hold the same aggregate signature").toBe(1);
  } finally {
    killPeers(peers);
    server?.kill();
  }
});
