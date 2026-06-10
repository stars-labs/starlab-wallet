/**
 * ERC-20 token support for the EVM side of the wallet.
 *
 * Three concerns, deliberately separated so the pure bits are unit-testable
 * without a chain or a browser:
 *
 *   1. **Pure codec** — encode a `transfer()` calldata, parse/format token
 *      amounts by decimals. No I/O.
 *   2. **Reads** — `balanceOf` / `decimals` / `symbol` / `name` over a viem
 *      `PublicClient` the caller supplies (background already builds one per
 *      network in NetworkService).
 *   3. **Registry** — the per-network list of tokens the user tracks
 *      (curated defaults + custom additions), persisted in chrome.storage.
 *
 * Signing a token transfer still goes through the normal FROST/EVM path: build
 * an `eth_sendTransaction` to the token contract with `data = encodeErc20Transfer(...)`.
 */
import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type PublicClient,
} from "viem";

export interface TokenInfo {
  /** Contract address (0x…, checksummed or lower). */
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
  /** Optional logo URL for the UI. */
  logo?: string;
}

/** Minimal ERC-20 ABI — the calls the wallet actually makes. */
export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ── 1. Pure codec ──────────────────────────────────────────────────────────

/** ABI-encode an ERC-20 `transfer(to, amount)` call → calldata for the tx `data`. */
export function encodeErc20Transfer(to: string, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to as `0x${string}`, amount],
  });
}

/** Human amount ("1.5") → base units (bigint), given token decimals. */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}

/** Base units (bigint) → human string, given token decimals. */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

// ── 2. Reads (require a viem PublicClient) ──────────────────────────────────

export async function fetchTokenBalance(
  client: PublicClient,
  token: string,
  owner: string,
): Promise<bigint> {
  return (await client.readContract({
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner as `0x${string}`],
  })) as bigint;
}

export async function fetchTokenMetadata(
  client: PublicClient,
  token: string,
): Promise<{ symbol: string; decimals: number; name: string }> {
  const [symbol, decimals, name] = await Promise.all([
    client.readContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "symbol",
    }) as Promise<string>,
    client.readContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "decimals",
    }) as Promise<number>,
    client
      .readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "name",
      })
      .catch(() => "") as Promise<string>,
  ]);
  return { symbol, decimals: Number(decimals), name };
}

// ── 3. Registry (persisted per chainId) ─────────────────────────────────────

/** Curated defaults so common tokens show up without manual adds. */
export const DEFAULT_TOKENS: Record<number, TokenInfo[]> = {
  // Ethereum mainnet
  1: [
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, name: "USD Coin" },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6, name: "Tether USD" },
    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18, name: "Dai Stablecoin" },
  ],
  // Polygon
  137: [
    { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6, name: "USD Coin" },
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6, name: "Tether USD" },
  ],
  // Base
  8453: [
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, name: "USD Coin" },
  ],
};

function normalizeAddr(a: string): string {
  return a.toLowerCase();
}

/**
 * Tracks which ERC-20 tokens to show per network. Curated {@link DEFAULT_TOKENS}
 * plus the user's custom additions, persisted under one storage key keyed by
 * chainId. Falls back to an in-memory map when chrome.storage is absent (tests).
 */
export class TokenRegistry {
  private static instance: TokenRegistry;
  private readonly STORAGE_KEY = "wallet_custom_tokens";
  /** chainId → custom tokens (defaults are merged in on read). */
  private custom: Record<number, TokenInfo[]> = {};
  private loaded = false;

  static getInstance(): TokenRegistry {
    if (!TokenRegistry.instance) TokenRegistry.instance = new TokenRegistry();
    return TokenRegistry.instance;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (typeof chrome !== "undefined" && chrome.storage) {
      const res = await chrome.storage.local.get([this.STORAGE_KEY]);
      this.custom = (res[this.STORAGE_KEY] as Record<number, TokenInfo[]>) ?? {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (typeof chrome !== "undefined" && chrome.storage) {
      await chrome.storage.local.set({ [this.STORAGE_KEY]: this.custom });
    }
  }

  /** All tokens to show for a chain: curated defaults + custom, de-duped. */
  async list(chainId: number): Promise<TokenInfo[]> {
    await this.ensureLoaded();
    const merged = new Map<string, TokenInfo>();
    for (const t of DEFAULT_TOKENS[chainId] ?? []) {
      merged.set(normalizeAddr(t.address), t);
    }
    for (const t of this.custom[chainId] ?? []) {
      merged.set(normalizeAddr(t.address), t); // custom overrides default metadata
    }
    return [...merged.values()];
  }

  /** Add (or update) a custom token for a chain. Idempotent by address. */
  async add(chainId: number, token: TokenInfo): Promise<void> {
    await this.ensureLoaded();
    const list = (this.custom[chainId] ??= []);
    const key = normalizeAddr(token.address);
    const idx = list.findIndex((t) => normalizeAddr(t.address) === key);
    if (idx >= 0) list[idx] = token;
    else list.push(token);
    await this.persist();
  }

  /** Remove a custom token. No-op for curated defaults (they aren't stored). */
  async remove(chainId: number, address: string): Promise<void> {
    await this.ensureLoaded();
    const list = this.custom[chainId];
    if (!list) return;
    this.custom[chainId] = list.filter(
      (t) => normalizeAddr(t.address) !== normalizeAddr(address),
    );
    await this.persist();
  }
}
