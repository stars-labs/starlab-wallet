/**
 * Fiat (USD) pricing for native coins and ERC-20 tokens, so balances can show
 * a fiat value instead of raw "0.5 ETH".
 *
 * Backed by CoinGecko's public API with a short in-memory TTL cache (price
 * endpoints are rate-limited; the popup re-renders often). `fetch` is read off
 * globalThis so tests can stub it. No key required for the public tier.
 */

const COINGECKO = "https://api.coingecko.com/api/v3";
const DEFAULT_TTL_MS = 60_000;

/** chainId → CoinGecko native-coin id (for /simple/price). */
export const CHAIN_NATIVE_COINGECKO_ID: Record<number, string> = {
  1: "ethereum",
  137: "matic-network",
  10: "ethereum", // Optimism gas token is ETH
  42161: "ethereum", // Arbitrum gas token is ETH
  8453: "ethereum", // Base gas token is ETH
  56: "binancecoin",
};

/** chainId → CoinGecko asset platform (for /simple/token_price/{platform}). */
export const CHAIN_COINGECKO_PLATFORM: Record<number, string> = {
  1: "ethereum",
  137: "polygon-pos",
  10: "optimistic-ethereum",
  42161: "arbitrum-one",
  8453: "base",
  56: "binance-smart-chain",
};

/** Non-EVM native ids. */
export const NATIVE_COINGECKO_ID = {
  solana: "solana",
  sui: "sui",
  bitcoin: "bitcoin",
} as const;

interface CacheEntry {
  value: number;
  at: number;
}

export class PriceService {
  private static instance: PriceService;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  static getInstance(): PriceService {
    if (!PriceService.instance) PriceService.instance = new PriceService();
    return PriceService.instance;
  }

  private fresh(key: string): number | undefined {
    const hit = this.cache.get(key);
    // Date.now via globalThis so the value is testable/monotonic.
    if (hit && globalThis.Date.now() - hit.at < this.ttlMs) return hit.value;
    return undefined;
  }

  private store(key: string, value: number): void {
    this.cache.set(key, { value, at: globalThis.Date.now() });
  }

  private async getJson(url: string): Promise<any> {
    const res = await (globalThis.fetch as typeof fetch)(url);
    if (!res.ok) throw new Error(`price fetch failed: ${res.status}`);
    return res.json();
  }

  /**
   * USD prices for CoinGecko coin ids (e.g. ["ethereum","solana"]).
   * Returns a map id→usd; ids that miss cache are fetched in one request and
   * the misses are merged with cached hits.
   */
  async getPricesByIds(
    ids: string[],
    vs = "usd",
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const missing: string[] = [];
    for (const id of ids) {
      const c = this.fresh(`id:${id}:${vs}`);
      if (c !== undefined) out[id] = c;
      else missing.push(id);
    }
    if (missing.length === 0) return out;

    const url = `${COINGECKO}/simple/price?ids=${encodeURIComponent(
      missing.join(","),
    )}&vs_currencies=${vs}`;
    const json = await this.getJson(url);
    for (const id of missing) {
      const v = json?.[id]?.[vs];
      if (typeof v === "number") {
        out[id] = v;
        this.store(`id:${id}:${vs}`, v);
      }
    }
    return out;
  }

  /** USD price for a single native coin id. undefined if unavailable. */
  async getNativePrice(id: string, vs = "usd"): Promise<number | undefined> {
    return (await this.getPricesByIds([id], vs))[id];
  }

  /**
   * USD prices for ERC-20 tokens by contract address on a given chain.
   * Returns a map of lowercased address → usd.
   */
  async getTokenPrices(
    chainId: number,
    addresses: string[],
    vs = "usd",
  ): Promise<Record<string, number>> {
    const platform = CHAIN_COINGECKO_PLATFORM[chainId];
    const out: Record<string, number> = {};
    if (!platform || addresses.length === 0) return out;

    const missing: string[] = [];
    for (const a of addresses) {
      const key = `tok:${platform}:${a.toLowerCase()}:${vs}`;
      const c = this.fresh(key);
      if (c !== undefined) out[a.toLowerCase()] = c;
      else missing.push(a.toLowerCase());
    }
    if (missing.length === 0) return out;

    const url = `${COINGECKO}/simple/token_price/${platform}?contract_addresses=${encodeURIComponent(
      missing.join(","),
    )}&vs_currencies=${vs}`;
    const json = await this.getJson(url);
    for (const a of missing) {
      const v = json?.[a]?.[vs];
      if (typeof v === "number") {
        out[a] = v;
        this.store(`tok:${platform}:${a}:${vs}`, v);
      }
    }
    return out;
  }
}

/** Convenience: fiat value of a human-denominated amount at a unit price. */
export function fiatValue(amount: number, unitPrice: number): number {
  return amount * unitPrice;
}
