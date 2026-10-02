// L3c interop: extension (DKG initiator) + 2 CLI co-signers run a real DKG and
// threshold signing over a signal server + shared room. See README.md.
import { test, expect } from "./fixtures";
import { signMessage, extSignature } from "./extension-actions";
import { setupExtension, extensionInitiatedDkg, extensionEthereumAddress, specTimeout, CURVE, type Env } from "./scenario";
import { inNetns, blockUdp, unblockUdp } from "./netns";
import { parseTransaction, recoverMessageAddress, recoverTransactionAddress } from "viem";

// Independent tests (each gets its own signal server + room).
test.describe.configure({ timeout: specTimeout(1) });

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
    if (CURVE !== "ed25519") {
      // Threshold ECDSA: an EIP-191 signature ecrecovers to the wallet's
      // Ethereum address (what an EOA / dApp checks).
      const recovered = await recoverMessageAddress({ message: "interop-hello", signature: sigs[0].sig as `0x${string}` });
      expect(recovered.toLowerCase()).toBe(await extensionEthereumAddress(page));
    }
  } finally {
    env?.cleanup();
  }
});

test("extension Send: an EIP-1559 transaction signed by the ECDSA key recovers to the wallet's address", async ({ page, context, extensionId }) => {
  test.skip(CURVE === "ed25519", "Ethereum accounts are secp256k1 wallets");
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    await extensionInitiatedDkg(page, env, { threshold: 2, cliPeers: 2 });
    const from = await extensionEthereumAddress(page);

    // Capture the broadcast instead of hitting a real node (the account
    // holds no funds): the background's eth_sendRawTransaction goes here.
    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      const g = globalThis as any;
      g.__rawTxs = [];
      const realFetch = g.fetch;
      g.fetch = async (url: unknown, init?: { body?: unknown }) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (body?.method === "eth_sendRawTransaction") {
          g.__rawTxs.push(body.params[0]);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: `0x${"ab".repeat(32)}` }));
        }
        return realFetch(url, init);
      };
    });
    // The popup's Send hands eth_sendTransaction a complete EIP-1559 tx.
    const tx = {
      from,
      to: "0x000000000000000000000000000000000000dEaD",
      value: "0x1",
      data: "0x",
      nonce: "0x0",
      gas: "0x5208",
      maxFeePerGas: "0x6fc23ac00",
      maxPriorityFeePerGas: "0x3b9aca00",
    };
    const res = await page.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "rpcRequest", payload: { jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [t] } }),
      tx,
    );
    expect(res, JSON.stringify(res)).toMatchObject({ success: true, result: `0x${"ab".repeat(32)}` });
    const [raw] = await sw.evaluate(() => (globalThis as any).__rawTxs as string[]);
    expect(raw).toMatch(/^0x02/);
    const parsed = parseTransaction(raw as `0x02${string}`);
    expect(parsed.to?.toLowerCase()).toBe(tx.to.toLowerCase());
    const sender = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
    expect(sender.toLowerCase(), "the signed tx's sender is the MPC wallet's Ethereum address").toBe(from);
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
    // Ethereum signs with the threshold-ECDSA key (engine parity).
    expect(info.curve_type).toBe(CURVE === "ed25519" ? "ed25519" : "secp256k1-ecdsa");
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
