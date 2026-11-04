// Shared setup for the extension <-> CLI specs: a private (or configured)
// signal server, the extension onboarded into a fresh room, and N CLI peers.
import { execFileSync } from "node:child_process";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, mirrorOffscreenConsole } from "./fixtures";
import { openPopup, onboard, useSignalServer, setRoom, createWallet, waitForDkg, saveWallet, DKG_MS } from "./extension-actions";
import { startPeers, killPeers, freshRoom, ensurePrereqs, startSignalServer, insecureTestPrimes, nativeGroupKeys, CLI_BIN, type Peer } from "./cli-peers";

// "local" = a private starlab-signal-server per test (see startSignalServer).
export const SIGNAL = process.env.INTEROP_SIGNAL ?? "wss://panda.qzz.io";
export const PASSWORD = process.env.INTEROP_PW ?? "interop-test-password";

export type Env = {
  room: string;
  signal: string;
  /** The private signal server (INTEROP_SIGNAL=local), for outage tests. */
  server: Awaited<ReturnType<typeof startSignalServer>> | null;
  peers: Peer[];
  cleanup(): void;
};

/** Signal server + extension onboarded into a fresh room. No peers yet. */
export async function setupExtension(page: Page, context: BrowserContext, extensionId: string): Promise<Env> {
  ensurePrereqs();
  const room = freshRoom();
  const server = SIGNAL === "local" ? await startSignalServer() : null;
  const signal = server?.url ?? SIGNAL;
  const env: Env = {
    room,
    signal,
    server,
    peers: [],
    cleanup() {
      killPeers(env.peers);
      server?.kill();
    },
  };
  if (process.env.INTEROP_BROWSER_LOG) await mirrorOffscreenConsole(context);
  await useSignalServer(context.serviceWorkers()[0], signal);
  await openPopup(page, extensionId);
  await onboard(page, PASSWORD);
  await setRoom(page, room);
  await useInsecureTestPrimes(context);
  return env;
}

/**
 * Hand the extension fixture ECDSA primes (INSECURE, tests only) instead of
 * minutes of generation. The hook only exists in a test build
 * (`WXT_INSECURE_TEST_PRIMES=1 bun run build`); a production build has none.
 */
export async function useInsecureTestPrimes(context: BrowserContext): Promise<void> {
  const sw = context.serviceWorkers()[0];
  const hooked = await sw.evaluate(async (primes) => {
    const hook = (globalThis as any).__starlabInsecureTestPrimes;
    if (typeof hook !== "function") return false;
    await hook(primes);
    return true;
  }, insecureTestPrimes(0));
  expect(hooked, "build the extension with WXT_INSECURE_TEST_PRIMES=1 for the interop specs").toBe(true);
}

/**
 * The extension initiates a threshold-of-(1 + cliPeers) DKG that `cliPeers`
 * auto-joining CLI peers complete; asserts all three group keys and eight
 * account addresses, then saves the extension's shares. Returns the summary key.
 */
export async function extensionInitiatedDkg(
  page: Page,
  env: Env,
  opts: { threshold: number; cliPeers: number },
): Promise<string> {
  env.peers = startPeers({ count: opts.cliPeers, signal: env.signal, room: env.room, password: PASSWORD });
  await createWallet(page, { threshold: opts.threshold, total: opts.cliPeers + 1 });

  const results = await Promise.all(env.peers.map((p) => p.dkg));
  const groupKey = results[0].groupKey;
  const extKeys = await extensionGroupKeys(page);
  for (const [i, peer] of env.peers.entries()) {
    expect(nativeGroupKeys(peer.keystore, peer.deviceId, results[i].wallet),
      "all three public group keys must agree across native and WASM").toEqual(extKeys);
  }
  await assertUnifiedAccounts(page, env.peers[0].keystore, env.peers[0].deviceId, results[0].wallet, extKeys);
  await saveWallet(page, PASSWORD);
  return groupKey;
}

/** The extension's Ethereum account-0 address (from its ECDSA key). */
export async function extensionEthereumAddress(page: Page): Promise<string> {
  const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: "getState" }));
  expect(state.ecdsaGroupPublicKey).toMatch(/^[0-9a-f]+$/i);
  const derived = await page.evaluate(groupPublicKey => chrome.runtime.sendMessage({
    type: "deriveAccounts", curve: "secp256k1-ecdsa", groupPublicKey, count: 1,
  }), state.ecdsaGroupPublicKey);
  expect(derived.success).toBe(true);
  return String(derived.accounts[0].addresses.find((entry: { chain: string }) =>
    entry.chain.toLowerCase() === "ethereum")?.address ?? "").toLowerCase();
}

/** Test timeout for a spec running `dkgs` DKGs plus some signing. */
export const specTimeout = (dkgs = 1) => 180_000 + dkgs * DKG_MS;

/** `--timeout` (s) for the complete three-algorithm ceremony. */
export const CLI_TIMEOUT_S = String(Math.round(DKG_MS / 1000));

/** Wait for all three independently-created public keys, not a legacy display key. */
export async function extensionGroupKeys(page: Page) {
  await waitForDkg(page);
  const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: "getState" }));
  const keys = { ed25519: state.frostGroupPublicKeys?.ed25519,
    secp256k1: state.frostGroupPublicKeys?.secp256k1, ecdsa: state.ecdsaGroupPublicKey };
  for (const key of Object.values(keys)) expect(key).toMatch(/^[0-9a-f]+$/i);
  return keys as { ed25519: string; secp256k1: string; ecdsa: string };
}

/** Compare account 0 and 1 for every chain using both public derivation surfaces. */
export async function assertUnifiedAccounts(page: Page, keystore: string, deviceId: string,
  walletId: string, keys: { ed25519: string; secp256k1: string; ecdsa: string }) {
  const native = JSON.parse(execFileSync(CLI_BIN, ["wallet", "accounts", "--wallet-id", walletId,
    "--count", "2", "--json", "--device-id", deviceId, "--keystore", keystore]).toString());
  const expected = new Map<string, { address: string; path: string }>();
  for (const account of native.accounts) for (const address of account.addresses) {
    expected.set(`${account.account}:${address.chain.toLowerCase()}`, { address: address.address, path: address.path });
  }
  const seen = new Set<string>();
  for (const [curve, groupPublicKey] of [["ed25519", keys.ed25519], ["secp256k1", keys.secp256k1], ["secp256k1-ecdsa", keys.ecdsa]]) {
    const result = await page.evaluate(payload => chrome.runtime.sendMessage({ type: "deriveAccounts", ...payload }),
      { curve, groupPublicKey, count: 2 });
    expect(result.success).toBe(true);
    for (const account of result.accounts) for (const address of account.addresses) {
      const id = `${account.account}:${address.chain.toLowerCase()}`;
      expect({ address: address.address, path: address.path }, id).toEqual(expected.get(id));
      seen.add(id);
    }
  }
  expect([...seen].sort()).toEqual(["0:bitcoin", "0:ethereum", "0:solana", "0:sui", "1:bitcoin", "1:ethereum", "1:solana", "1:sui"]);
}
