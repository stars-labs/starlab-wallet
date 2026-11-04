// L3c interop, the other direction: a CLI initiates, the extension joins.
import { test, expect } from "./fixtures";
import { startPeers, runCli, nativeGroupKeys } from "./cli-peers";
import { acceptInvitation, approveSigningRequest, waitForDkg, extSignature, saveWallet } from "./extension-actions";
import { setupExtension, PASSWORD, CLI_TIMEOUT_S, specTimeout, extensionGroupKeys, assertUnifiedAccounts, type Env } from "./scenario";

// Independent tests (each gets its own signal server + room).
test.describe.configure({ timeout: specTimeout(1) });

const walletIdOf = (out: string) => /Wallet ID:\s+(\S+)/.exec(out)?.[1];

test("CLI-initiated DKG: the extension and a CLI peer join", async ({ page, context, extensionId }) => {
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    env.peers = startPeers({ count: 1, signal: env.signal, room: env.room, password: PASSWORD });
    const creator = runCli({
      args: ["wallet", "create", "--threshold", "2", "--total", "3", "--curve", "unified", "--timeout", CLI_TIMEOUT_S],
      deviceId: "interop-creator",
      signal: env.signal,
      room: env.room,
      password: PASSWORD,
    });

    await acceptInvitation(page);

    const created = await creator.done;
    const walletId = walletIdOf(created)!;
    const joined = await env.peers[0].dkg;
    expect(joined.wallet).toBe(walletId);
    const keys = await extensionGroupKeys(page);
    expect(nativeGroupKeys(creator.keystore, "interop-creator", walletId)).toEqual(keys);
    expect(nativeGroupKeys(env.peers[0].keystore, env.peers[0].deviceId, walletId)).toEqual(keys);
    await assertUnifiedAccounts(page, creator.keystore, "interop-creator", walletId, keys);
    await saveWallet(page, PASSWORD);
  } finally {
    env?.cleanup();
  }
});

test("CLI-initiated signing: the extension co-signs", async ({ page, context, extensionId }) => {
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    env.peers = startPeers({ count: 1, signal: env.signal, room: env.room, password: PASSWORD });
    const creator = runCli({
      args: ["wallet", "create", "--threshold", "2", "--total", "3", "--curve", "unified", "--timeout", CLI_TIMEOUT_S],
      deviceId: "interop-creator",
      signal: env.signal,
      room: env.room,
      password: PASSWORD,
    });
    await acceptInvitation(page);
    const created = await creator.done;
    await waitForDkg(page);
    await saveWallet(page, PASSWORD);

    // With the CLI peer offline the only signer set is {creator, extension}.
    env.peers[0].kill();
    const signer = runCli({
      args: ["sign", "--wallet-id", walletIdOf(created)!, "--chain", "ethereum", "--message", "interop-cli-sign", "--curve", "secp256k1", "--timeout", "120", "--json"],
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

test("CLI-initiated reshare: the extension refreshes its share, then co-signs", async ({ page, context, extensionId }) => {
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    env.peers = startPeers({ count: 1, signal: env.signal, room: env.room, password: PASSWORD });
    const cli = { deviceId: "interop-creator", signal: env.signal, room: env.room, password: PASSWORD };
    const creator = runCli({
      ...cli,
      args: ["wallet", "create", "--threshold", "2", "--total", "3", "--curve", "unified", "--timeout", CLI_TIMEOUT_S],
    });
    await acceptInvitation(page);
    const created = await creator.done;
    const walletId = walletIdOf(created)!;
    await waitForDkg(page);
    await saveWallet(page, PASSWORD);

    // Refresh every share; the CLI peer (serve) auto-joins, the extension accepts.
    const reshare = runCli({
      ...cli,
      keystore: creator.keystore,
      args: ["reshare", "--wallet-id", walletId, "--curve", "secp256k1", "--timeout", CLI_TIMEOUT_S],
    });
    await acceptInvitation(page);
    await reshare.done;

    // The refreshed extension share must sign with the refreshed CLI share.
    env.peers[0].kill();
    const signer = runCli({
      ...cli,
      keystore: creator.keystore,
      args: ["sign", "--wallet-id", walletId, "--chain", "bitcoin", "--message", "after-reshare", "--curve", "secp256k1", "--timeout", "120", "--json"],
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

test("signal-server outage: everyone reconnects, then the extension co-signs", async ({ page, context, extensionId }) => {
  test.skip(process.env.INTEROP_SIGNAL !== "local", "needs a private signal server to restart");
  let env: Env | undefined;
  try {
    env = await setupExtension(page, context, extensionId);
    env.peers = startPeers({ count: 1, signal: env.signal, room: env.room, password: PASSWORD });
    const cli = { deviceId: "interop-creator", signal: env.signal, room: env.room, password: PASSWORD };
    const creator = runCli({
      ...cli,
      args: ["wallet", "create", "--threshold", "2", "--total", "3", "--curve", "unified", "--timeout", CLI_TIMEOUT_S],
    });
    await acceptInvitation(page);
    const walletId = walletIdOf(await creator.done)!;
    await waitForDkg(page);
    await saveWallet(page, PASSWORD);

    // Outage: the socket drops; the extension must come back on its own.
    await env.server!.restart();
    await expect
      .poll(() => page.evaluate(() => chrome.runtime.sendMessage({ type: "getState" }).then((s) => s.wsConnected)), {
        timeout: 60_000,
      })
      .toBe(true);

    env.peers[0].kill();
    const signer = runCli({
      ...cli,
      keystore: creator.keystore,
      args: ["sign", "--wallet-id", walletId, "--chain", "ethereum", "--message", "after-outage", "--curve", "secp256k1", "--timeout", "120", "--json"],
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
