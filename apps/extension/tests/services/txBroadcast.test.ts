/**
 * txBroadcast tests. The assembly is checked against viem's own signer: sign a
 * tx with a known key (ground truth), feed the parsed (r,s,yParity) back through
 * assembleSignedEvmTx, and require byte-identical output. If yParity/encoding
 * were wrong the raw tx would recover to the wrong sender — so this is the test
 * that matters.
 */
import { describe, it, expect, jest, afterEach } from "bun:test";
import {
  parseTransaction,
  type TransactionSerializableEIP1559,
  type TransactionSerializableLegacy,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assembleSignedEvmTx, broadcastRawTx } from "../../src/services/txBroadcast";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(PK);

async function roundTrip(tx: any) {
  // ground truth: viem signs the whole tx
  const expected = await account.signTransaction(tx);
  // extract the signature viem produced and re-assemble via our helper
  const parsed = parseTransaction(expected);
  // recovery (0/1): yParity if present, else derive from v — EIP-155 legacy is
  // v = chainId*2 + 35 + recovery; pre-155 is v = 27 + recovery.
  const v = parsed.v !== undefined ? Number(parsed.v) : undefined;
  const recovery =
    parsed.yParity ?? (v! >= 35 ? (v! - 35) % 2 : v! - 27);
  const got = assembleSignedEvmTx(tx, {
    r: parsed.r as string,
    s: parsed.s as string,
    recovery,
  });
  return { expected, got };
}

describe("assembleSignedEvmTx", () => {
  it("matches viem for an EIP-1559 tx", async () => {
    const tx: TransactionSerializableEIP1559 = {
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: 1_000_000_000_000_000n,
      chainId: 1,
      nonce: 3,
      gas: 21000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      type: "eip1559",
    };
    const { expected, got } = await roundTrip(tx);
    expect(got).toBe(expected);
  });

  it("matches viem for a legacy tx", async () => {
    const tx: TransactionSerializableLegacy = {
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: 5_000_000_000_000_000n,
      chainId: 1,
      nonce: 7,
      gas: 21000n,
      gasPrice: 20_000_000_000n,
      type: "legacy",
    };
    const { expected, got } = await roundTrip(tx);
    expect(got).toBe(expected);
  });
});

describe("broadcastRawTx", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  it("returns the tx hash on success", async () => {
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xhash" }),
    }));
    const hash = await broadcastRawTx("http://rpc", "0xdeadbeef");
    expect(hash).toBe("0xhash");
  });

  it("throws the node error message", async () => {
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ error: { message: "nonce too low" } }),
    }));
    await expect(broadcastRawTx("http://rpc", "0xdeadbeef")).rejects.toThrow(
      "nonce too low",
    );
  });
});
