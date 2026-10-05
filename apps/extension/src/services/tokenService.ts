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
 * Signing a token transfer still goes through the normal threshold-ECDSA path: build
 * an `eth_sendTransaction` to the token contract with `data = encodeErc20Transfer(...)`.
 */
import {
  toHex,
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
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
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

/** ABI-encode `approve(spender, amount)`. amount 0n = revoke. */
export function encodeErc20Approve(
  spender: string,
  amount: bigint,
): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender as `0x${string}`, amount],
  });
}

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer topic. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Token auto-discovery (#21): find ERC-20s the account has RECEIVED by
 * scanning Transfer logs with `to = account`, then resolving metadata.
 *
 * - `fromBlock` bounds the scan (callers pass latest − N; public RPCs cap
 *   ranges, so a bounded window is the portable choice).
 * - Contracts whose metadata can't be read (not actually ERC-20, weird
 *   bytes32 symbols, …) are skipped, not fatal.
 * - `exclude` (already-registered addresses) are filtered before any RPC
 *   metadata call so discovery stays cheap.
 */
export async function discoverTokens(
  client: Pick<PublicClient, "request" | "readContract">,
  account: string,
  opts: { fromBlock: bigint; toBlock?: bigint | "latest"; exclude?: string[] },
): Promise<TokenInfo[]> {
  const paddedAccount = `0x${account.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [{
      fromBlock: toHex(opts.fromBlock),
      toBlock: typeof opts.toBlock === "bigint" ? toHex(opts.toBlock) : "latest",
      // Use raw RPC so the indexed recipient topic is preserved by viem:
      // topic0 = Transfer, topic2 = recipient (our account).
      topics: [TRANSFER_TOPIC, null, paddedAccount],
    }],
  })) as { address: string }[];

  const excluded = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));
  const candidates = [...new Set(logs.map((l) => l.address.toLowerCase()))].filter(
    (a) => !excluded.has(a),
  );

  const out: TokenInfo[] = [];
  for (const address of candidates) {
    try {
      const meta = await fetchTokenMetadata(client as PublicClient, address);
      if (!meta.symbol || !Number.isFinite(meta.decimals)) continue;
      out.push({ address, symbol: meta.symbol, decimals: meta.decimals, name: meta.name });
    } catch {
      // Not a readable ERC-20 (NFT, malformed, proxy quirks) — skip.
    }
  }
  return out;
}

/** Current on-chain allowance owner→spender for a token. */
export async function fetchAllowance(
  client: PublicClient,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  return (await client.readContract({
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner as `0x${string}`, spender as `0x${string}`],
  })) as bigint;
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
