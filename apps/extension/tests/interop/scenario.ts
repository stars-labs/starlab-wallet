// Shared setup for the extension <-> CLI specs: a private (or configured)
// signal server, the extension onboarded into a fresh room, and N CLI peers.
import type { BrowserContext, Page } from "@playwright/test";
import { expect, mirrorOffscreenConsole } from "./fixtures";
import { openPopup, onboard, useSignalServer, setRoom, createWallet, dkgResult, saveWallet } from "./extension-actions";
import { startPeers, killPeers, freshRoom, ensurePrereqs, startSignalServer, type Peer } from "./cli-peers";

// "local" = a private starlab-signal-server per test (see startSignalServer).
export const SIGNAL = process.env.INTEROP_SIGNAL ?? "wss://panda.qzz.io";
export const CURVE = process.env.INTEROP_CURVE ?? "secp256k1";
export const PASSWORD = process.env.INTEROP_PW ?? "interop-test-password";

export type Env = {
  room: string;
  signal: string;
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
  return env;
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
  expect((await dkgResult(page)).groupPublicKey, "extension and CLI peers must agree on the group key").toBe(groupKey);
  await saveWallet(page, PASSWORD);
  return groupKey;
}
