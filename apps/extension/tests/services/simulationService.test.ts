/**
 * simulationService tests — drive the full snapshot → impersonate → execute →
 * diff → revert protocol with a scripted fake node, and pin the safety
 * properties: snapshot ALWAYS reverted (success, revert, or crash), node
 * absence reports available:false instead of throwing, and diffs are
 * after-minus-before.
 */
import { describe, it, expect, afterEach, jest } from "bun:test";
import { encodeFunctionData } from "viem";
import { simulateTransaction } from "../../src/services/simulationService";
import { ERC20_ABI } from "../../src/services/tokenService";

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const USDC = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 };

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

/** Scripted anvil: maps method (+call ordinal) → result. Records every call. */
function fakeNode(script: Record<string, any[] | ((params: any[]) => any)>) {
  const counts: Record<string, number> = {};
  const calls: { method: string; params: any[] }[] = [];
  (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const entry = script[method];
    if (entry === undefined) throw new Error(`unscripted method ${method}`);
    const result =
      typeof entry === "function"
        ? entry(params)
        : entry[Math.min(counts[method] ?? 0, entry.length - 1)];
    counts[method] = (counts[method] ?? 0) + 1;
    if (result instanceof Error) {
      return { ok: true, json: async () => ({ error: { message: result.message } }) };
    }
    return { ok: true, json: async () => ({ result }) };
  });
  return calls;
}

const balanceResult = (n: bigint) => `0x${n.toString(16)}`;
/** ABI-encoded uint256 return for balanceOf eth_call. */
const erc20Result = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

describe("simulateTransaction", () => {
  it("success path: native + token diffs, snapshot reverted", async () => {
    const calls = fakeNode({
      evm_snapshot: ["0x1"],
      anvil_impersonateAccount: [null],
      anvil_setBalance: [null],
      // before: 1000 ETH, after: 999 ETH
      eth_getBalance: [balanceResult(10n ** 21n), balanceResult(999n * 10n ** 18n)],
      // before: 50 USDC, after: 20 USDC
      eth_call: [erc20Result(50_000_000n), erc20Result(20_000_000n)],
      eth_sendTransaction: ["0xhash"],
      eth_getTransactionReceipt: [{ status: "0x1", gasUsed: "0x5208" }],
      evm_revert: [true],
      anvil_stopImpersonatingAccount: [null],
    });

    const r = await simulateTransaction(
      "http://127.0.0.1:8545",
      { from: FROM, to: TO, value: "0xde0b6b3a7640000" },
      [USDC],
    );

    expect(r.available).toBe(true);
    expect(r.success).toBe(true);
    expect(r.gasUsed).toBe(21000n);
    expect(r.nativeDiff).toBe(-(10n ** 18n)); // spent 1 ETH
    expect(r.tokenDiffs!.length).toBe(1);
    expect(r.tokenDiffs![0].diff).toBe(-30_000_000n); // -30 USDC
    // snapshot reverted + impersonation stopped
    expect(calls.some((c) => c.method === "evm_revert" && c.params[0] === "0x1")).toBe(true);
    expect(calls.some((c) => c.method === "anvil_stopImpersonatingAccount")).toBe(true);
  });

  it("revert path: reports the reason, still reverts the snapshot", async () => {
    const calls = fakeNode({
      evm_snapshot: ["0x2"],
      anvil_impersonateAccount: [null],
      anvil_setBalance: [null],
      eth_getBalance: [balanceResult(10n ** 18n)],
      eth_sendTransaction: [new Error("execution reverted: insufficient allowance")],
      evm_revert: [true],
      anvil_stopImpersonatingAccount: [null],
    });

    const r = await simulateTransaction("http://x", { from: FROM, to: TO });
    expect(r.available).toBe(true);
    expect(r.success).toBe(false);
    expect(r.revertReason).toContain("insufficient allowance");
    expect(calls.some((c) => c.method === "evm_revert")).toBe(true);
  });

  it("no node: available=false, no throw", async () => {
    (globalThis as any).fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await simulateTransaction("http://127.0.0.1:8545", { from: FROM, to: TO });
    expect(r).toEqual({ available: false });
  });

  it("failed receipt (status 0x0) reports success=false", async () => {
    fakeNode({
      evm_snapshot: ["0x3"],
      anvil_impersonateAccount: [null],
      anvil_setBalance: [null],
      eth_getBalance: [balanceResult(10n ** 18n), balanceResult(10n ** 18n)],
      eth_sendTransaction: ["0xhash"],
      eth_getTransactionReceipt: [{ status: "0x0", gasUsed: "0x5208" }],
      evm_revert: [true],
      anvil_stopImpersonatingAccount: [null],
    });
    const r = await simulateTransaction("http://x", { from: FROM, to: TO });
    expect(r.success).toBe(false);
  });
});
