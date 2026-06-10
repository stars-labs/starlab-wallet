/**
 * Builds the `eth_sendTransaction` parameter object for a user-initiated send,
 * for both native coin and ERC-20 transfers. Pure (no I/O) so it's unit-tested
 * exactly; the popup hands the result straight to the existing
 * eth_sendTransaction → FROST sign → broadcast path.
 *
 * A native send is `{ to, value }`; an ERC-20 send is a call to the token
 * contract — `{ to: token, value: 0, data: transfer(recipient, amount) }`.
 */
import { numberToHex } from "viem";
import {
  encodeErc20Transfer,
  parseTokenAmount,
  formatTokenAmount,
  type TokenInfo,
} from "./tokenService";

export interface EthSendParams {
  from?: string;
  to: string;
  /** hex wei */
  value: string;
  /** hex calldata */
  data: string;
}

const ZERO = "0x0";

/** Native coin send. `amount` is a human string (e.g. "0.25"); 18 decimals. */
export function buildNativeSend(
  from: string,
  to: string,
  amount: string,
): EthSendParams {
  const wei = parseTokenAmount(amount, 18);
  return { from, to, value: numberToHex(wei), data: "0x" };
}

/** ERC-20 transfer. `amount` is a human string in the token's own decimals. */
export function buildTokenSend(
  from: string,
  recipient: string,
  amount: string,
  token: Pick<TokenInfo, "address" | "decimals">,
): EthSendParams {
  const raw = parseTokenAmount(amount, token.decimals);
  return {
    from,
    to: token.address,
    value: ZERO,
    data: encodeErc20Transfer(recipient, raw),
  };
}

/**
 * Unified entry: build a send for either asset kind. `token` undefined ⇒ native.
 * `to` is always the human recipient (for tokens it's encoded into calldata and
 * the tx `to` becomes the contract).
 */
export function buildSendTransaction(opts: {
  from: string;
  to: string;
  amount: string;
  token?: Pick<TokenInfo, "address" | "decimals">;
}): EthSendParams {
  return opts.token
    ? buildTokenSend(opts.from, opts.to, opts.amount, opts.token)
    : buildNativeSend(opts.from, opts.to, opts.amount);
}

export interface FeeEstimate {
  /** Estimated gas units (with a 20% headroom over eth_estimateGas). */
  gas: bigint;
  /** Fee-per-gas the tx will carry (EIP-1559 maxFeePerGas, or legacy gasPrice). */
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
  /** Worst-case total fee in wei (gas × maxFeePerGas). */
  totalWei: bigint;
  /** Human ETH string of totalWei, for display. */
  totalEth: string;
  /** Whether the network gave EIP-1559 fees or legacy gasPrice. */
  kind: "eip1559" | "legacy";
}

/**
 * Estimate the fee for a built send. The client only needs three viem read
 * methods, so tests inject a fake. Gas gets a 20% headroom — a stingy
 * eth_estimateGas reverting a transfer is worse than a few unused units
 * (unused gas is refunded anyway).
 */
export async function estimateSendFee(
  client: {
    estimateGas: (a: any) => Promise<bigint>;
    estimateFeesPerGas?: () => Promise<{
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
    }>;
    getGasPrice: () => Promise<bigint>;
  },
  tx: EthSendParams,
): Promise<FeeEstimate> {
  const raw = await client.estimateGas({
    account: tx.from as `0x${string}`,
    to: tx.to as `0x${string}`,
    value: BigInt(tx.value),
    data: tx.data as `0x${string}`,
  });
  const gas = (raw * 120n) / 100n;

  // Prefer EIP-1559 fees; fall back to legacy gasPrice on chains/nodes
  // (or fakes) that don't provide them.
  try {
    const fees = await client.estimateFeesPerGas?.();
    if (fees?.maxFeePerGas) {
      const totalWei = gas * fees.maxFeePerGas;
      return {
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        totalWei,
        totalEth: formatTokenAmount(totalWei, 18),
        kind: "eip1559",
      };
    }
  } catch {
    /* fall through to legacy */
  }
  const gasPrice = await client.getGasPrice();
  const totalWei = gas * gasPrice;
  return {
    gas,
    maxFeePerGas: gasPrice,
    totalWei,
    totalEth: formatTokenAmount(totalWei, 18),
    kind: "legacy",
  };
}

/** Attach an estimate's fee fields to the eth_sendTransaction params (hex). */
export function withFee(
  tx: EthSendParams,
  fee: FeeEstimate,
): EthSendParams & {
  gas: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
} {
  const base = { ...tx, gas: numberToHex(fee.gas) };
  if (fee.kind === "eip1559") {
    return {
      ...base,
      maxFeePerGas: numberToHex(fee.maxFeePerGas),
      maxPriorityFeePerGas: numberToHex(fee.maxPriorityFeePerGas ?? 0n),
    };
  }
  return { ...base, gasPrice: numberToHex(fee.maxFeePerGas) };
}
