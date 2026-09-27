// L3c interop: extension (DKG initiator) + 2 CLI co-signers run a real DKG and
// threshold signing over a signal server + shared room. See README.md.
import { test, expect } from "./fixtures";
import { signMessage, extSignature } from "./extension-actions";
import { setupExtension, extensionInitiatedDkg, type Env } from "./scenario";
import { inNetns, blockUdp, unblockUdp } from "./netns";

// Independent tests (each gets its own signal server + room).
test.describe.configure({ timeout: 180_000 });

test("ext + 2 CLI: DKG group keys agree, then a signature verifies", async ({ page, context, extensionId }) => {
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    await extensionInitiatedDkg(page, env, { threshold: 2, cliPeers: 2 });

    // Sign from the extension; the CLI peers auto-approve.
    await signMessage(page, "interop-hello");
    const sigs = await Promise.all(env.peers.map((p) => p.signature));
    for (const s of sigs) expect(s.sig).toMatch(/^0x[0-9a-f]+$/);
    expect(new Set(sigs.map((s) => s.sig)).size, "all peers must hold the same aggregate signature").toBe(1);
    // …and the extension took part in (and holds) that same signature —
    // two CLI peers alone already meet a 2-of-3 threshold.
    expect(await extSignature(page)).toBe(sigs[0].sig.replace(/^0x/, "").toLowerCase());
  } finally {
    env?.cleanup();
  }
});

test("extension-proposed signing: the announce lists the wallet's cohort and account key, CLI co-signers sign", async ({ page, context, extensionId }) => {
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    const rootKey = await extensionInitiatedDkg(page, env, { threshold: 2, cliPeers: 2 });

    // Record what the background sends to the signal server.
    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      const g = globalThis as any;
      g.__sent = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: any) {
        g.__sent.push(String(data));
        return send.call(this, data);
      };
    });

    await signMessage(page, "interop-announce-shape");
    const sigs = await Promise.all(env.peers.map((p) => p.signature));
    expect(new Set(sigs.map((s) => s.sig)).size).toBe(1);

    const announces = (await sw.evaluate(() => (globalThis as any).__sent as string[]))
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "announce_session" && m.session_info?.session_type === "signing");
    expect(announces).toHaveLength(1);
    const info = announces[0].session_info;
    const extId = info.proposer_id as string;
    // TUI / desktop only offer a signing whose participants include them
    // (engine update.rs SessionDiscovered `am_participant`): the whole
    // cohort, sorted, like the engine's StartSigning announce.
    expect(info.participants).toEqual([extId, ...env.peers.map((p) => p.deviceId)].sort());
    expect(info.total).toBe(3);
    expect(info.threshold).toBe(2);
    // The account child's key (what the engine announces), not the root.
    expect(info.wallet_name).toMatch(/-(ethereum|solana)-0$/);
    expect(info.group_public_key).toMatch(/^[0-9a-f]+$/);
    expect(info.group_public_key).not.toBe(rootKey);
    expect(Object.keys(info).sort()).toEqual(
      [
        "session_id", "total", "threshold", "session_type", "proposer_id", "participants",
        "curve_type", "coordination_type", "wallet_name", "group_public_key", "blockchain",
        "signing_message_hex",
      ].sort(),
    );
  } finally {
    env?.cleanup();
  }
});

test("ext + 1 online CLI: the extension co-signs a 2-of-3 signature", async ({ page, context, extensionId }) => {
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    await extensionInitiatedDkg(page, env, { threshold: 2, cliPeers: 2 });

    // With one CLI offline the only possible signer set is {extension, CLI}.
    env.peers[1].kill();
    await signMessage(page, "interop-quorum");
    const cliSig = (await env.peers[0].signature).sig;
    expect(await extSignature(page)).toBe(cliSig.replace(/^0x/, "").toLowerCase());
  } finally {
    env?.cleanup();
  }
});

test("WebRTC outage: the mesh rebuilds and the extension co-signs", async ({ page, context, extensionId }) => {
  test.skip(!inNetns, "needs INTEROP_NETNS=1 (run inside a user network namespace, see netns.ts)");
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    await extensionInitiatedDkg(page, env, { threshold: 2, cliPeers: 2 });
    env.peers[1].kill();

    // Every P2P path dies; signaling (TCP) stays up. Long enough for ICE
    // to go `failed` on both sides.
    blockUdp();
    await page.waitForTimeout(20_000);
    unblockUdp();

    await signMessage(page, "after-webrtc-outage");
    const cliSig = (await env.peers[0].signature).sig;
    expect(await extSignature(page)).toBe(cliSig.replace(/^0x/, "").toLowerCase());
  } finally {
    unblockUdp();
    env?.cleanup();
  }
});
