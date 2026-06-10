/**
 * sandboxService tests — the enable/disable round-trip against the real
 * NetworkService singleton (chrome.storage stubbed by setup-bun): enabling
 * must remember + switch, disabling must restore + clean up, and the probe
 * must map node reachability without throwing.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import NetworkService from "../../src/services/networkService";
import {
  enableSandbox,
  disableSandbox,
  isSandboxActive,
  probeSandbox,
  SANDBOX_EVM_ID,
  SANDBOX_SOLANA_ID,
} from "../../src/services/sandboxService";

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

beforeEach(async () => {
  // Reset the singleton's in-memory state; storage is reset by setup-bun.
  const net = NetworkService.getInstance() as any;
  net.networks = { ethereum: [], solana: [] };
  net.currentNetworks = { ethereum: undefined, solana: undefined };
  net.initialized = false;
  await net.ensureInitialized(); // reseeds mainnet/sepolia defaults
});

describe("enableSandbox / disableSandbox", () => {
  it("switches onto the sandbox and back, restoring the previous network", async () => {
    const net = NetworkService.getInstance();
    const before = net.getCurrentNetwork("ethereum")?.id;
    expect(before).toBeDefined();
    expect(isSandboxActive()).toBe(false);

    await enableSandbox();
    expect(isSandboxActive()).toBe(true);
    expect(net.getCurrentNetwork("ethereum")?.id).toBe(SANDBOX_EVM_ID);
    expect(net.getCurrentNetwork("solana")?.id).toBe(SANDBOX_SOLANA_ID);
    // RPC points at the local anvil
    expect(
      (net.getCurrentNetwork("ethereum") as any).rpcUrls.default.http[0],
    ).toContain("127.0.0.1:8545");

    await disableSandbox();
    expect(isSandboxActive()).toBe(false);
    expect(net.getCurrentNetwork("ethereum")?.id).toBe(before);
    // sandbox entries removed from the network list
    expect(net.getNetworks("ethereum").some((n) => n.id === SANDBOX_EVM_ID)).toBe(false);
  });

  it("enable is idempotent (double enable keeps one sandbox entry)", async () => {
    const net = NetworkService.getInstance();
    await enableSandbox();
    await enableSandbox();
    const count = net.getNetworks("ethereum").filter((n) => n.id === SANDBOX_EVM_ID).length;
    expect(count).toBe(1);
    expect(isSandboxActive()).toBe(true);
  });
});

describe("probeSandbox", () => {
  it("maps per-node reachability", async () => {
    (globalThis as any).fetch = jest.fn(async (url: string) => ({
      ok: String(url).includes("8545"), // EVM up, Solana down
    }));
    const r = await probeSandbox();
    expect(r.evm).toBe(true);
    expect(r.solana).toBe(false);
  });

  it("treats network errors as down (no throw)", async () => {
    (globalThis as any).fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await probeSandbox();
    expect(r).toEqual({ evm: false, solana: false });
  });
});
