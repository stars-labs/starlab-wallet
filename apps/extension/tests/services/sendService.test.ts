/**
 * sendService tests — building the eth_sendTransaction params is exactly the
 * place a wrong value/decimals/calldata loses funds, so it's asserted against
 * viem's decoder and known hex.
 */
import { describe, it, expect } from "bun:test";
import { decodeFunctionData, hexToBigInt } from "viem";
import { ERC20_ABI } from "../../src/services/tokenService";
import {
  buildNativeSend,
  buildTokenSend,
  buildSendTransaction,
} from "../../src/services/sendService";

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const USDC = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 };

describe("buildNativeSend", () => {
  it("encodes value in wei, empty data", () => {
    const tx = buildNativeSend(FROM, TO, "0.25");
    expect(tx.to).toBe(TO);
    expect(tx.data).toBe("0x");
    expect(hexToBigInt(tx.value as `0x${string}`)).toBe(250_000_000_000_000_000n);
  });
});

describe("buildTokenSend", () => {
  it("targets the token contract with transfer() calldata, zero value", () => {
    const tx = buildTokenSend(FROM, TO, "12.5", USDC);
    expect(tx.to).toBe(USDC.address); // tx goes to the contract
    expect(tx.value).toBe("0x0");
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("transfer");
    expect((decoded.args[0] as string).toLowerCase()).toBe(TO.toLowerCase());
    expect(decoded.args[1]).toBe(12_500_000n); // 12.5 * 10^6
  });
});

describe("buildSendTransaction", () => {
  it("routes to native when no token given", () => {
    const tx = buildSendTransaction({ from: FROM, to: TO, amount: "1" });
    expect(tx.to).toBe(TO);
    expect(tx.data).toBe("0x");
  });

  it("routes to token transfer when a token is given", () => {
    const tx = buildSendTransaction({ from: FROM, to: TO, amount: "1", token: USDC });
    expect(tx.to).toBe(USDC.address);
    expect(tx.data.startsWith("0xa9059cbb")).toBe(true);
  });
});
