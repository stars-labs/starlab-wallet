import { describe, expect, test } from "bun:test";
import { tokenImage } from "../../../src/lib/ui/tokenIdentity";

describe("token artwork identity", () => {
    test("a missing contract never turns an arbitrary ticker into the native asset", () => {
        expect(tokenImage("USDC", "ethereum")).toBeUndefined();
        expect(tokenImage("BTC", "ethereum")).toBeUndefined();
        expect(tokenImage("ETH", "ethereum")).toBeDefined();
    });
    test("an unknown network has no assumed Ethereum identity", () => {
        expect(tokenImage("ETH", "unknown-network")).toBeUndefined();
    });
    test("a forged ticker never receives curated token artwork", () => {
        expect(tokenImage("USDC", "ethereum", "0x1111111111111111111111111111111111111111", 1)).toBeUndefined();
    });
    test("a mainnet contract is untrusted on a different selected network", () => {
        const address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
        expect(tokenImage("USDC", "ethereum", address, 1)).toBeDefined();
        expect(tokenImage("USDC", "ethereum", address, 11155111)).toBeUndefined();
    });
    test("canonical contract identity survives renamed metadata", () => {
        expect(tokenImage("Custom label", "base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 8453)).toBeDefined();
    });
});
