/**
 * priceService tests — the value is the caching + request-batching behaviour
 * (CoinGecko's public tier is rate-limited, so refetching on every popup
 * render would 429). fetch + Date.now are stubbed off globalThis.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import {
  PriceService,
  fiatValue,
  CHAIN_COINGECKO_PLATFORM,
} from "../../src/services/priceService";

const realFetch = globalThis.fetch;
const realNow = globalThis.Date.now;

function stubFetch(handler: (url: string) => any) {
  const fn = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => handler(url),
  }));
  (globalThis as any).fetch = fn;
  return fn;
}

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  (globalThis as any).Date.now = () => now;
});
afterEach(() => {
  (globalThis as any).fetch = realFetch;
  (globalThis as any).Date.now = realNow;
});

describe("PriceService.getPricesByIds", () => {
  it("fetches once and serves the cache within TTL", async () => {
    const fetchFn = stubFetch(() => ({
      ethereum: { usd: 3000 },
      solana: { usd: 150 },
    }));
    const svc = new PriceService(60_000);

    const a = await svc.getPricesByIds(["ethereum", "solana"]);
    expect(a).toEqual({ ethereum: 3000, solana: 150 });

    // within TTL → no second network call
    const b = await svc.getPricesByIds(["ethereum", "solana"]);
    expect(b).toEqual({ ethereum: 3000, solana: 150 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches only the missing ids (partial cache)", async () => {
    const fetchFn = stubFetch((url) => {
      // second call should ask only for 'solana'
      if (url.includes("solana") && !url.includes("ethereum")) {
        return { solana: { usd: 150 } };
      }
      return { ethereum: { usd: 3000 } };
    });
    const svc = new PriceService(60_000);

    await svc.getPricesByIds(["ethereum"]);
    const merged = await svc.getPricesByIds(["ethereum", "solana"]);
    expect(merged).toEqual({ ethereum: 3000, solana: 150 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const secondUrl = fetchFn.mock.calls[1][0] as string;
    expect(secondUrl).toContain("solana");
    expect(secondUrl).not.toContain("ethereum");
  });

  it("refetches after the TTL expires", async () => {
    const fetchFn = stubFetch(() => ({ ethereum: { usd: 3000 } }));
    const svc = new PriceService(60_000);
    await svc.getPricesByIds(["ethereum"]);
    now += 61_000; // advance past TTL
    await svc.getPricesByIds(["ethereum"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("PriceService.getTokenPrices", () => {
  it("queries the right CoinGecko platform and lowercases addresses", async () => {
    const fetchFn = stubFetch(() => ({
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { usd: 1.0 },
    }));
    const svc = new PriceService(60_000);
    const prices = await svc.getTokenPrices(1, [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    ]);
    expect(prices["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]).toBe(1.0);
    const url = fetchFn.mock.calls[0][0] as string;
    expect(url).toContain(`/simple/token_price/${CHAIN_COINGECKO_PLATFORM[1]}`);
  });

  it("returns {} for a chain with no CoinGecko platform", async () => {
    const fetchFn = stubFetch(() => ({}));
    const svc = new PriceService();
    expect(await svc.getTokenPrices(999999, ["0xabc"])).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("PriceService misc", () => {
  it("throws on a non-ok response", async () => {
    (globalThis as any).fetch = jest.fn(async () => ({ ok: false, status: 429 }));
    const svc = new PriceService();
    await expect(svc.getNativePrice("ethereum")).rejects.toThrow("429");
  });

  it("fiatValue multiplies amount × price", () => {
    expect(fiatValue(0.5, 3000)).toBe(1500);
  });
});
