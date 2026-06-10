/**
 * ERC-20 tokenService tests.
 *
 * The codec is the part that must be exactly right — a wrong transfer()
 * selector or a decimals mistake sends the wrong amount to the wrong place —
 * so it's asserted against viem's own decoder and known fixtures. Reads use a
 * fake PublicClient; the registry uses the setup-bun chrome.storage stub.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { decodeFunctionData } from "viem";
import {
  ERC20_ABI,
  encodeErc20Transfer,
  parseTokenAmount,
  formatTokenAmount,
  fetchTokenBalance,
  fetchTokenMetadata,
  TokenRegistry,
  DEFAULT_TOKENS,
} from "../../src/services/tokenService";

const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("tokenService codec", () => {
  it("encodes transfer() with the canonical 0xa9059cbb selector", () => {
    const data = encodeErc20Transfer(TO, 1_000_000n);
    expect(data.startsWith("0xa9059cbb")).toBe(true);
    // round-trips through viem's decoder to the same args
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
    expect(decoded.functionName).toBe("transfer");
    expect((decoded.args[0] as string).toLowerCase()).toBe(TO.toLowerCase());
    expect(decoded.args[1]).toBe(1_000_000n);
  });

  it("parses/formats by decimals (USDC=6, DAI=18)", () => {
    expect(parseTokenAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseTokenAmount("1", 18)).toBe(1_000_000_000_000_000_000n);
    expect(formatTokenAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatTokenAmount(1_000_000_000_000_000_000n, 18)).toBe("1");
  });
});

describe("tokenService reads", () => {
  it("fetchTokenBalance calls balanceOf and returns the bigint", async () => {
    const calls: any[] = [];
    const client = {
      readContract: async (args: any) => {
        calls.push(args);
        return 42_000_000n;
      },
    } as any;
    const bal = await fetchTokenBalance(client, "0xToken", TO);
    expect(bal).toBe(42_000_000n);
    expect(calls[0].functionName).toBe("balanceOf");
    expect(calls[0].args[0]).toBe(TO);
  });

  it("fetchTokenMetadata gathers symbol/decimals/name", async () => {
    const client = {
      readContract: async (args: any) => {
        if (args.functionName === "symbol") return "USDC";
        if (args.functionName === "decimals") return 6;
        if (args.functionName === "name") return "USD Coin";
        throw new Error("unexpected call");
      },
    } as any;
    const meta = await fetchTokenMetadata(client, "0xToken");
    expect(meta).toEqual({ symbol: "USDC", decimals: 6, name: "USD Coin" });
  });
});

describe("TokenRegistry", () => {
  let reg: TokenRegistry;
  beforeEach(() => {
    reg = TokenRegistry.getInstance();
    // setup-bun resets chrome.storage each test; reset the singleton cache too.
    (reg as any).custom = {};
    (reg as any).loaded = false;
  });

  it("lists curated defaults for a known chain", async () => {
    const list = await reg.list(1);
    const symbols = list.map((t) => t.symbol).sort();
    expect(symbols).toEqual(["DAI", "USDC", "USDT"]);
    expect(list.length).toBe(DEFAULT_TOKENS[1].length);
  });

  it("returns [] for an unknown chain with no customs", async () => {
    expect(await reg.list(999999)).toEqual([]);
  });

  it("adds, persists, and removes a custom token", async () => {
    await reg.add(42161, {
      address: "0xAf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin (Arb)",
    });
    let list = await reg.list(42161);
    expect(list.map((t) => t.symbol)).toContain("USDC");

    // fresh instance reads it back from storage (persistence works)
    (reg as any).loaded = false;
    (reg as any).custom = {};
    list = await reg.list(42161);
    expect(list.length).toBe(1);

    await reg.remove(42161, "0xAf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(await reg.list(42161)).toEqual([]);
  });

  it("add is idempotent by address (updates, no dupes)", async () => {
    const addr = "0x1111111111111111111111111111111111111111";
    await reg.add(1, { address: addr, symbol: "AAA", decimals: 18 });
    await reg.add(1, { address: addr.toUpperCase(), symbol: "BBB", decimals: 8 });
    const list = await reg.list(1);
    const match = list.filter((t) => t.address.toLowerCase() === addr);
    expect(match.length).toBe(1);
    expect(match[0].symbol).toBe("BBB"); // custom overrides, last write wins
  });
});
