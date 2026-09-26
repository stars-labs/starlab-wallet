// L3c interop, the other direction: a CLI initiates, the extension joins.
import { test, expect } from "./fixtures";
import { startPeers, runCli } from "./cli-peers";
import { acceptInvitation, approveSigningRequest, dkgResult, extSignature, saveWallet } from "./extension-actions";
import { setupExtension, CURVE, PASSWORD, type Env } from "./scenario";

test.describe.configure({ mode: "serial", timeout: 180_000 });

/** `Group key:  <hex>` from `starlab-cli wallet create`'s summary. */
const groupKeyOf = (out: string) => /Group key:\s+([0-9a-f]+)/.exec(out)?.[1];
const walletIdOf = (out: string) => /Wallet ID:\s+(\S+)/.exec(out)?.[1];

test("CLI-initiated DKG: the extension and a CLI peer join", async ({ page, context, extensionId }) => {
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    env.peers = startPeers({ count: 1, signal: env.signal, room: env.room, curve: CURVE, password: PASSWORD });
    const creator = runCli({
      args: ["wallet", "create", "--threshold", "2", "--total", "3", "--curve", CURVE, "--timeout", "120"],
      deviceId: "interop-creator",
      signal: env.signal,
      room: env.room,
      password: PASSWORD,
    });

    await acceptInvitation(page);

    const creatorKey = groupKeyOf(await creator.done);
    expect(creatorKey).toMatch(/^[0-9a-f]+$/);
    expect((await env.peers[0].dkg).groupKey).toBe(creatorKey);
    expect((await dkgResult(page)).groupPublicKey, "extension must derive the CLI's group key").toBe(creatorKey);
    await saveWallet(page, PASSWORD);
  } finally {
    env?.cleanup();
  }
});

test("CLI-initiated signing: the extension co-signs", async ({ page, context, extensionId }) => {
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    env.peers = startPeers({ count: 1, signal: env.signal, room: env.room, curve: CURVE, password: PASSWORD });
    const creator = runCli({
      args: ["wallet", "create", "--threshold", "2", "--total", "3", "--curve", CURVE, "--timeout", "120"],
      deviceId: "interop-creator",
      signal: env.signal,
      room: env.room,
      password: PASSWORD,
    });
    await acceptInvitation(page);
    const created = await creator.done;
    await dkgResult(page);
    await saveWallet(page, PASSWORD);

    // With the CLI peer offline the only signer set is {creator, extension}.
    env.peers[0].kill();
    const signer = runCli({
      args: ["sign", "--wallet-id", walletIdOf(created)!, "--message", "interop-cli-sign", "--curve", CURVE, "--timeout", "120", "--json"],
      deviceId: "interop-creator",
      keystore: creator.keystore,
      signal: env.signal,
      room: env.room,
      password: PASSWORD,
    });
    await approveSigningRequest(page);

    const out = await signer.done;
    const cliSig = /"signature"\s*:\s*"(?:0x)?([0-9a-f]+)"/.exec(out)?.[1];
    expect(cliSig, `no signature in CLI output: ${out}`).toBeTruthy();
    expect(await extSignature(page)).toBe(cliSig);
  } finally {
    env?.cleanup();
  }
});
