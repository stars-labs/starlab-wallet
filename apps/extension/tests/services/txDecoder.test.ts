/**
 * txDecoder tests — the classifications that protect users must be exact:
 * unlimited approve / setApprovalForAll(true) / unlimited Permit are CRITICAL,
 * unknown calldata is honestly "unrecognized", and amounts use token decimals.
 */
import { describe, it, expect } from "bun:test";
import { encodeFunctionData } from "viem";
import {
  decodeEvmTransaction,
  decodeTypedData,
} from "../../src/services/txDecoder";
import { ERC20_ABI } from "../../src/services/tokenService";

const SPENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MAX = (1n << 256n) - 1n;

const APPROVE_ABI = [
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }] },
  { type: "function", name: "setApprovalForAll", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }] },
] as const;

describe("decodeEvmTransaction", () => {
  it("native transfer", () => {
    const d = decodeEvmTransaction({ to: SPENDER, value: 10n ** 18n, data: "0x" });
    expect(d.kind).toBe("native-transfer");
    expect(d.summary).toContain("Send 1 ETH");
    expect(d.danger).toBe("none");
  });

  it("ERC-20 transfer with token metadata", () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [SPENDER, 2_500_000n],
    });
    const d = decodeEvmTransaction(
      { to: TOKEN, value: 0n, data },
      { symbol: "USDC", decimals: 6 },
    );
    expect(d.kind).toBe("erc20-transfer");
    expect(d.summary).toContain("2.5 USDC");
  });

  it("UNLIMITED approve is critical", () => {
    const data = encodeFunctionData({
      abi: APPROVE_ABI,
      functionName: "approve",
      args: [SPENDER, MAX],
    });
    const d = decodeEvmTransaction({ to: TOKEN, data });
    expect(d.kind).toBe("erc20-approve");
    expect(d.danger).toBe("critical");
    expect(d.summary).toContain("UNLIMITED");
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  it("bounded approve is warn, not critical", () => {
    const data = encodeFunctionData({
      abi: APPROVE_ABI,
      functionName: "approve",
      args: [SPENDER, 1_000_000n],
    });
    const d = decodeEvmTransaction({ to: TOKEN, data }, { symbol: "USDC", decimals: 6 });
    expect(d.danger).toBe("warn");
    expect(d.summary).toContain("1 USDC");
  });

  it("setApprovalForAll(true) is critical; (false) is a revoke", () => {
    const grant = encodeFunctionData({
      abi: APPROVE_ABI,
      functionName: "setApprovalForAll",
      args: [SPENDER, true],
    });
    expect(decodeEvmTransaction({ to: TOKEN, data: grant }).danger).toBe("critical");

    const revoke = encodeFunctionData({
      abi: APPROVE_ABI,
      functionName: "setApprovalForAll",
      args: [SPENDER, false],
    });
    const d = decodeEvmTransaction({ to: TOKEN, data: revoke });
    expect(d.danger).toBe("none");
    expect(d.summary).toContain("Revoke");
  });

  it("unknown calldata is honestly unrecognized; ETH-attached gets a warning", () => {
    const d = decodeEvmTransaction({ to: TOKEN, value: 5n * 10n ** 17n, data: "0xdeadbeef00" });
    expect(d.kind).toBe("contract-call");
    expect(d.summary).toContain("unrecognized");
    expect(d.warnings[0]).toContain("0.5 ETH");
    expect(d.danger).toBe("warn");
  });
});

describe("decodeTypedData", () => {
  it("unlimited Permit is critical", () => {
    const d = decodeTypedData({
      domain: { name: "USD Coin" },
      primaryType: "Permit",
      message: { spender: SPENDER, value: MAX.toString() },
    });
    expect(d.kind).toBe("permit");
    expect(d.danger).toBe("critical");
    expect(d.summary).toContain("UNLIMITED");
  });

  it("bounded Permit still warns (it IS an approval)", () => {
    const d = decodeTypedData({
      domain: { name: "USD Coin" },
      primaryType: "Permit",
      message: { spender: SPENDER, value: "1000000" },
    });
    expect(d.danger).toBe("warn");
  });

  it("other typed data falls back to primaryType + domain", () => {
    const d = decodeTypedData({
      domain: { name: "Ether Mail" },
      primaryType: "Mail",
      message: {},
    });
    expect(d.kind).toBe("typed-data");
    expect(d.summary).toBe("Sign Mail for Ether Mail");
    expect(d.danger).toBe("none");
  });
});
