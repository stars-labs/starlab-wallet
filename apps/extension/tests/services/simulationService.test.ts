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

const TOPIC_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOPIC_APPROVAL =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const TOPIC_APPROVAL_FOR_ALL =
  "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const MAX_UINT256 = (1n << 256n) - 1n;
const addrTopic = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const DEX = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";
/** ABI-encoded string ("symbol()") and uint8 ("decimals()") returns. */
const symbolResult = (s: string) => {
  const hex = Buffer.from(s, "utf8").toString("hex");
  const len = s.length.toString(16).padStart(64, "0");
  const body = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${len}${body}`;
};
const decimalsResult = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

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

  it("auto-discovers an untracked token received via Transfer logs", async () => {
    // DAI is not in the tracked list; the sim must surface it from the receipt
    // and fetch its symbol/decimals for display.
    const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
    fakeNode({
      evm_snapshot: ["0x1"],
      anvil_impersonateAccount: [null],
      anvil_setBalance: [null],
      eth_getBalance: [balanceResult(10n ** 21n), balanceResult(10n ** 21n)],
      eth_sendTransaction: ["0xhash"],
      eth_getTransactionReceipt: [
        {
          status: "0x1",
          gasUsed: "0x5208",
          logs: [
            {
              address: DAI,
              topics: [TOPIC_TRANSFER, addrTopic(DEX), addrTopic(FROM)],
              data: erc20Result(5n * 10n ** 18n), // +5 DAI to sender
            },
          ],
        },
      ],
      eth_call: (params: any[]) => {
        const data: string = params[0].data;
        if (data.startsWith("0x95d89b41")) return symbolResult("DAI");
        if (data.startsWith("0x313ce567")) return decimalsResult(18);
        return erc20Result(0n);
      },
      evm_revert: [true],
      anvil_stopImpersonatingAccount: [null],
    });

    const r = await simulateTransaction("http://x", { from: FROM, to: DEX });
    expect(r.success).toBe(true);
    expect(r.tokenDiffs!.length).toBe(1);
    expect(r.tokenDiffs![0].token.symbol).toBe("DAI");
    expect(r.tokenDiffs![0].token.decimals).toBe(18);
    expect(r.tokenDiffs![0].diff).toBe(5n * 10n ** 18n);
  });

  it("flags an unlimited ERC-20 approval as a warning", async () => {
    fakeNode({
      evm_snapshot: ["0x1"],
      anvil_impersonateAccount: [null],
      anvil_setBalance: [null],
      eth_getBalance: [balanceResult(10n ** 18n), balanceResult(10n ** 18n)],
      eth_sendTransaction: ["0xhash"],
      eth_getTransactionReceipt: [
        {
          status: "0x1",
          gasUsed: "0x5208",
          logs: [
            {
              address: USDC.address,
              topics: [TOPIC_APPROVAL, addrTopic(FROM), addrTopic(DEX)],
              data: erc20Result(MAX_UINT256),
            },
          ],
        },
      ],
      eth_call: (params: any[]) => {
        const data: string = params[0].data;
        if (data.startsWith("0x95d89b41")) return symbolResult("USDC");
        if (data.startsWith("0x313ce567")) return decimalsResult(6);
        return erc20Result(0n);
      },
      evm_revert: [true],
      anvil_stopImpersonatingAccount: [null],
    });

    const r = await simulateTransaction("http://x", { from: FROM, to: USDC.address }, [USDC]);
    expect(r.approvals!.length).toBe(1);
    expect(r.approvals![0].spender.toLowerCase()).toBe(DEX.toLowerCase());
    expect(r.approvals![0].unlimited).toBe(true);
    expect(r.approvals![0].amount).toBe(MAX_UINT256);
    expect(r.warnings!.some((w) => /UNLIMITED/.test(w))).toBe(true);
  });

  it("a bounded approval is reported but not warned", async () => {
    fakeNode({
      evm_snapshot: ["0x1"],
      anvil_impersonateAccount: [null],
      anvil_setBalance: [null],
      eth_getBalance: [balanceResult(10n ** 18n), balanceResult(10n ** 18n)],
      eth_sendTransaction: ["0xhash"],
      eth_getTransactionReceipt: [
        {
          status: "0x1",
          gasUsed: "0x5208",
          logs: [
            {
              address: USDC.address,
              topics: [TOPIC_APPROVAL, addrTopic(FROM), addrTopic(DEX)],
              data: erc20Result(100_000_000n), // 100 USDC
            },
          ],
        },
      ],
      eth_call: (params: any[]) => {
        const data: string = params[0].data;
        if (data.startsWith("0x95d89b41")) return symbolResult("USDC");
        if (data.startsWith("0x313ce567")) return decimalsResult(6);
        return erc20Result(0n);
      },
      evm_revert: [true],
      anvil_stopImpersonatingAccount: [null],
    });

    const r = await simulateTransaction("http://x", { from: FROM, to: USDC.address }, [USDC]);
    expect(r.approvals!.length).toBe(1);
    expect(r.approvals![0].unlimited).toBe(false);
    expect(r.approvals![0].amount).toBe(100_000_000n);
    expect(r.warnings!.length).toBe(0);
  });

  it("treats ERC-721 setApprovalForAll as blanket (unlimited) access", async () => {
    const NFT = "0x60E4d786628Fea6478F785A6d7e704777c86a7c6"; // MAYC
    fakeNode({
      evm_snapshot: ["0x1"],
      anvil_impersonateAccount: [null],
      anvil_setBalance: [null],
      eth_getBalance: [balanceResult(10n ** 18n), balanceResult(10n ** 18n)],
      eth_sendTransaction: ["0xhash"],
      eth_getTransactionReceipt: [
        {
          status: "0x1",
          gasUsed: "0x5208",
          logs: [
            {
              address: NFT,
              topics: [TOPIC_APPROVAL_FOR_ALL, addrTopic(FROM), addrTopic(DEX)],
              data: erc20Result(1n), // approved = true
            },
          ],
        },
      ],
      eth_call: (params: any[]) => {
        const data: string = params[0].data;
        if (data.startsWith("0x95d89b41")) return symbolResult("MAYC");
        if (data.startsWith("0x313ce567")) return decimalsResult(0);
        return erc20Result(0n);
      },
      evm_revert: [true],
      anvil_stopImpersonatingAccount: [null],
    });

    const r = await simulateTransaction("http://x", { from: FROM, to: NFT });
    expect(r.approvals!.length).toBe(1);
    expect(r.approvals![0].amount).toBeNull();
    expect(r.approvals![0].unlimited).toBe(true);
    expect(r.warnings!.some((w) => /approval-for-ALL/.test(w))).toBe(true);
  });

  it("ignores Transfer logs that do not involve the sender", async () => {
    const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
    fakeNode({
      evm_snapshot: ["0x1"],
      anvil_impersonateAccount: [null],
      anvil_setBalance: [null],
      eth_getBalance: [balanceResult(10n ** 21n), balanceResult(10n ** 21n)],
      eth_sendTransaction: ["0xhash"],
      eth_getTransactionReceipt: [
        {
          status: "0x1",
          gasUsed: "0x5208",
          logs: [
            {
              address: DAI,
              topics: [TOPIC_TRANSFER, addrTopic(DEX), addrTopic(TO)], // third parties
              data: erc20Result(5n * 10n ** 18n),
            },
          ],
        },
      ],
      eth_call: () => erc20Result(0n),
      evm_revert: [true],
      anvil_stopImpersonatingAccount: [null],
    });

    const r = await simulateTransaction("http://x", { from: FROM, to: DEX });
    expect(r.tokenDiffs!.length).toBe(0);
    expect(r.approvals!.length).toBe(0);
  });
});
