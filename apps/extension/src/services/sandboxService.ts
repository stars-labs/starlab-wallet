/**
 * Built-in Sandbox network (#31): one-click switch onto the local fork nodes
 * that `scripts/sandbox.sh` runs (anvil EVM on :8545 / chainId 31337, surfpool
 * Solana on :8899) — real signing + broadcast against simulated chains, no real
 * funds, no hand-entered RPCs.
 *
 * Enable = remember the current networks, register the sandbox entries, switch
 * both chains over. Disable = switch back to what was active and drop the
 * sandbox entries. `probeSandbox()` lets the UI show whether the nodes are
 * actually up (and hint at running sandbox.sh when they aren't).
 */
import NetworkService from "./networkService";
import type { Chain } from "@stars-labs/types/network";

export const SANDBOX_EVM_ID = 31337; // anvil's default chainId
export const SANDBOX_SOLANA_ID = 31338; // internal id (Solana has no numeric chainId)

export const SANDBOX_EVM: Chain = {
  id: SANDBOX_EVM_ID,
  name: "Sandbox (anvil)",
  network: "sandbox-evm",
  nativeCurrency: { name: "Sandbox Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
} as Chain;

export const SANDBOX_SOLANA: Chain = {
  id: SANDBOX_SOLANA_ID,
  name: "Sandbox (surfpool)",
  network: "sandbox-solana",
  nativeCurrency: { name: "Sandbox SOL", symbol: "SOL", decimals: 9 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8899"] } },
} as Chain;

const PREV_KEY = "sandbox_prev_networks";

async function loadPrev(): Promise<Record<string, number | undefined>> {
  if (typeof chrome !== "undefined" && chrome.storage) {
    const res = await chrome.storage.local.get([PREV_KEY]);
    return (res[PREV_KEY] as Record<string, number | undefined>) ?? {};
  }
  return {};
}

async function savePrev(prev: Record<string, number | undefined>): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage) {
    await chrome.storage.local.set({ [PREV_KEY]: prev });
  }
}

/** Whether the wallet is currently pointed at the sandbox (EVM side decides). */
export function isSandboxActive(): boolean {
  return NetworkService.getInstance().getCurrentNetwork("ethereum")?.id === SANDBOX_EVM_ID;
}

/**
 * Probe whether the local nodes answer. Returns per-node booleans so the UI
 * can say "EVM up, Solana down". 1.5s timeout per probe; any error = down.
 */
export async function probeSandbox(): Promise<{ evm: boolean; solana: boolean }> {
  async function probe(url: string, body: object): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }
  const [evm, solana] = await Promise.all([
    probe("http://127.0.0.1:8545", { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    probe("http://127.0.0.1:8899", { jsonrpc: "2.0", id: 1, method: "getHealth" }),
  ]);
  return { evm, solana };
}

/** Switch both chains onto the sandbox nodes, remembering what was active. */
export async function enableSandbox(): Promise<void> {
  const net = NetworkService.getInstance();
  await net.ensureInitialized();

  await savePrev({
    ethereum: net.getCurrentNetwork("ethereum")?.id,
    solana: net.getCurrentNetwork("solana")?.id,
  });

  // addNetwork is effectively upsert-by-id in both lists; ignore "exists".
  await net.addNetwork("ethereum", SANDBOX_EVM).catch(() => {});
  await net.addNetwork("solana", SANDBOX_SOLANA).catch(() => {});
  await net.setCurrentNetwork("ethereum", SANDBOX_EVM_ID);
  await net.setCurrentNetwork("solana", SANDBOX_SOLANA_ID);
}

/** Switch back to the networks that were active before the sandbox. */
export async function disableSandbox(): Promise<void> {
  const net = NetworkService.getInstance();
  await net.ensureInitialized();
  const prev = await loadPrev();

  if (prev.ethereum && prev.ethereum !== SANDBOX_EVM_ID) {
    await net.setCurrentNetwork("ethereum", prev.ethereum).catch(() => {});
  } else {
    // Fall back to the first non-sandbox EVM network (mainnet by default).
    const fallback = net
      .getNetworks("ethereum")
      .find((n) => n.id !== SANDBOX_EVM_ID);
    if (fallback) await net.setCurrentNetwork("ethereum", fallback.id).catch(() => {});
  }
  if (prev.solana && prev.solana !== SANDBOX_SOLANA_ID) {
    await net.setCurrentNetwork("solana", prev.solana).catch(() => {});
  }

  await net.removeNetwork("ethereum", SANDBOX_EVM_ID).catch(() => {});
  await net.removeNetwork("solana", SANDBOX_SOLANA_ID).catch(() => {});
  await savePrev({});
}
