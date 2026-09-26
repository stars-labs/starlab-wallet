// L3c interop: extension (DKG initiator) + 2 CLI co-signers run a real DKG and
// threshold signing over a signal server + shared room. See README.md.
import { test, expect } from "./fixtures";
import { signMessage, extSignature } from "./extension-actions";
import { setupExtension, extensionInitiatedDkg, type Env } from "./scenario";

test.describe.configure({ mode: "serial", timeout: 180_000 });

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
