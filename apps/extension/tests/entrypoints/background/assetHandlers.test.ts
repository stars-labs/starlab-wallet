/**
 * buildPortfolio tests — joins native + token balances with fiat and totals
 * them, and (importantly) a single failing token contract must not blank the
 * whole portfolio.
 */
import { describe, it, expect } from "bun:test";
import { buildPortfolio } from "../../../src/entrypoints/background/assetHandlers";

const ACC = "0x1111111111111111111111111111111111111111";
const USDC = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 };
const DAI = { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 };

function fakePrices(native: Record<string, number>, tokens: Record<string, number>) {
  return {
    getPricesByIds: async () => native,
    getTokenPrices: async () => tokens,
  };
}

describe("buildPortfolio", () => {
  it("joins balances with fiat and totals them", async () => {
    const client = {
      getBalance: async () => 1_000_000_000_000_000_000n, // 1 ETH
      readContract: async (a: any) => {
        if (a.address === USDC.address) return 2_500_000n; // 2.5 USDC
        if (a.address === DAI.address) return 4_000_000_000_000_000_000n; // 4 DAI
        return 0n;
      },
    };
    const portfolio = await buildPortfolio({
      client,
      chainId: 1,
      account: ACC,
      nativeSymbol: "ETH",
      tokens: [USDC, DAI],
      prices: fakePrices(
        { ethereum: 3000 },
        { [USDC.address.toLowerCase()]: 1, [DAI.address.toLowerCase()]: 1 },
      ),
    });

    expect(portfolio.native.balance).toBe("1");
    expect(portfolio.native.fiat).toBe(3000);
    const usdc = portfolio.tokens.find((t) => t.symbol === "USDC")!;
    expect(usdc.balance).toBe("2.5");
    expect(usdc.fiat).toBe(2.5);
    // 3000 (ETH) + 2.5 (USDC) + 4 (DAI)
    expect(portfolio.totalFiat).toBe(3006.5);
  });

  it("omits fiat when no price is available (no crash)", async () => {
    const client = {
      getBalance: async () => 0n,
      readContract: async () => 1_000_000n,
    };
    const p = await buildPortfolio({
      client,
      chainId: 1,
      account: ACC,
      nativeSymbol: "ETH",
      tokens: [USDC],
      prices: fakePrices({}, {}),
    });
    expect(p.native.fiat).toBeUndefined();
    expect(p.tokens[0].fiat).toBeUndefined();
    expect(p.totalFiat).toBe(0);
  });

  it("survives a token whose balanceOf throws (skips, keeps the rest)", async () => {
    const client = {
      getBalance: async () => 0n,
      readContract: async (a: any) => {
        if (a.address === USDC.address) throw new Error("bad contract");
        return 1_000_000_000_000_000_000n;
      },
    };
    const p = await buildPortfolio({
      client,
      chainId: 1,
      account: ACC,
      nativeSymbol: "ETH",
      tokens: [USDC, DAI],
      prices: fakePrices({}, {}),
    });
    // USDC fell back to 0 balance, DAI read fine — both present, no throw.
    expect(p.tokens.length).toBe(2);
    expect(p.tokens.find((t) => t.symbol === "USDC")!.balance).toBe("0");
    expect(p.tokens.find((t) => t.symbol === "DAI")!.balance).toBe("1");
  });
});
