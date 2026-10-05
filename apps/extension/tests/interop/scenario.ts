// Shared setup for the extension <-> CLI specs: a private (or configured)
// signal server, the extension onboarded into a fresh room, and N CLI peers.
import type { BrowserContext, Page } from "@playwright/test";
import { expect, mirrorOffscreenConsole } from "./fixtures";
import { openPopup, onboard, useSignalServer, setRoom, createWallet, dkgResult, saveWallet, DKG_MS } from "./extension-actions";
import { startPeers, killPeers, freshRoom, ensurePrereqs, startSignalServer, insecureTestPrimes, type Peer } from "./cli-peers";

// "local" = a private starlab-signal-server per test (see startSignalServer).
export const SIGNAL = process.env.INTEROP_SIGNAL ?? "wss://panda.qzz.io";
export const CURVE = process.env.INTEROP_CURVE ?? "secp256k1";
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
  if (CURVE !== "ed25519") await useInsecureTestPrimes(context);
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
 * auto-joining CLI peers complete; asserts every party derived the same group
 * key and saves the extension's share. Returns that group key.
 */
export async function extensionInitiatedDkg(
  page: Page,
  env: Env,
  opts: { threshold: number; cliPeers: number },
): Promise<string> {
  env.peers = startPeers({ count: opts.cliPeers, signal: env.signal, room: env.room, curve: CURVE, password: PASSWORD });
  await createWallet(page, { threshold: opts.threshold, total: opts.cliPeers + 1, curve: CURVE });

  const results = await Promise.all(env.peers.map((p) => p.dkg));
  expect(new Set(results.map((r) => r.groupKey)).size, "all CLI peers must agree on one group key").toBe(1);
  const groupKey = results[0].groupKey;
  expect(groupKey).toMatch(/^[0-9a-f]+$/);
  // The TS/WASM extension derived the same key as the Rust peers.
  const ext = await dkgResult(page);
  expect(ext.groupPublicKey, "extension and CLI peers must agree on the group key").toBe(groupKey);
  if (CURVE !== "ed25519") {
    // …and the same threshold-ECDSA key: the CLI reports its Ethereum address.
    expect(new Set(results.map((r) => r.address.toLowerCase())).size).toBe(1);
    expect(ext.address?.toLowerCase(), "extension and CLI peers must agree on the Ethereum (ECDSA) address").toBe(
      results[0].address.toLowerCase(),
    );
  }
  await saveWallet(page, PASSWORD);
  return groupKey;
}

/** The extension's Ethereum account-0 address (from its ECDSA key). */
export async function extensionEthereumAddress(page: Page): Promise<string> {
  const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: "getState" }));
  return String(state.dkgLastResult?.address ?? state.ethereumAddress ?? "").toLowerCase();
}

/** Test timeout for a spec running `dkgs` DKGs plus some signing. */
export const specTimeout = (dkgs = 1) => 180_000 + dkgs * DKG_MS;

/** `--timeout` (s) for one-shot CLI ceremonies (a secp256k1 DKG makes the ECDSA key too). */
export const CLI_TIMEOUT_S = String(Math.round(DKG_MS / 1000));
