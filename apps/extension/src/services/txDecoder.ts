/**
 * Human-readable signing (#33): decode tx calldata and EIP-712 payloads into a
 * plain-language summary + danger warnings, so the approval UI never asks the
 * user to blind-sign. Pure (no I/O) and table-driven, so every classification
 * is unit-tested.
 *
 * Philosophy: recognize the handful of calls that move or delegate value
 * (transfers, approvals, operator grants) precisely; everything else is
 * honestly labelled an unknown contract call rather than guessed at.
 */
import { decodeFunctionData, formatUnits } from "viem";

export type Danger = "none" | "warn" | "critical";

export interface DecodedAction {
  /** One-line plain-language summary for the approval UI. */
  summary: string;
  /** Human warnings; non-empty implies danger ≥ warn. */
  warnings: string[];
  danger: Danger;
  /** Machine tag for styling/filtering. */
  kind:
    | "native-transfer"
    | "erc20-transfer"
    | "erc20-approve"
    | "erc20-transfer-from"
    | "set-approval-for-all"
    | "nft-transfer"
    | "contract-call"
    | "permit"
    | "typed-data";
}

const MAX_UINT256 = (1n << 256n) - 1n;
/** Anything above this is treated as effectively unlimited for warnings. */
const EFFECTIVELY_UNLIMITED = MAX_UINT256 / 2n;

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** ABI fragments for the value-moving calls we classify precisely. */
const KNOWN_ABI = [
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }] },
  { type: "function", name: "approve", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }] },
  { type: "function", name: "transferFrom", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }] },
  { type: "function", name: "setApprovalForAll", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }] },
  { type: "function", name: "safeTransferFrom", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }] },
] as const;

/**
 * Decode an EVM transaction (to + value + data) into a {@link DecodedAction}.
 * `tokenMeta` (symbol/decimals), when known from the registry, makes amounts
 * human; without it amounts fall back to raw base units.
 */
export function decodeEvmTransaction(
  tx: { to?: string; value?: string | bigint; data?: string },
  tokenMeta?: { symbol: string; decimals: number },
): DecodedAction {
  const data = tx.data && tx.data !== "0x" ? tx.data : undefined;
  const valueWei =
    typeof tx.value === "bigint" ? tx.value : tx.value ? BigInt(tx.value) : 0n;

  if (!data) {
    return {
      summary: `Send ${formatUnits(valueWei, 18)} ETH to ${short(tx.to ?? "?")}`,
      warnings: [],
      danger: "none",
      kind: "native-transfer",
    };
  }

  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: KNOWN_ABI as any, data: data as `0x${string}` }) as any;
  } catch {
    const selector = data.slice(0, 10);
    const warnings: string[] = [];
    let danger: Danger = "none";
    if (valueWei > 0n) {
      warnings.push(`Also sends ${formatUnits(valueWei, 18)} ETH with the call.`);
      danger = "warn";
    }
    return {
      summary: `Contract call ${selector} on ${short(tx.to ?? "?")} (unrecognized)`,
      warnings,
      danger,
      kind: "contract-call",
    };
  }

  const fmt = (raw: bigint) =>
    tokenMeta
      ? `${formatUnits(raw, tokenMeta.decimals)} ${tokenMeta.symbol}`
      : `${raw} (base units)`;

  switch (decoded.functionName) {
    case "transfer": {
      const [to, amount] = decoded.args as [string, bigint];
      return {
        summary: `Transfer ${fmt(amount)} to ${short(to)}`,
        warnings: [],
        danger: "none",
        kind: "erc20-transfer",
      };
    }
    case "approve": {
      const [spender, amount] = decoded.args as [string, bigint];
      const unlimited = amount >= EFFECTIVELY_UNLIMITED;
      return {
        summary: unlimited
          ? `Approve UNLIMITED spending to ${short(spender)}`
          : `Approve ${fmt(amount)} spending to ${short(spender)}`,
        warnings: unlimited
          ? [
              "Unlimited approval: this address can drain the ENTIRE token balance, now or later.",
            ]
          : [],
        danger: unlimited ? "critical" : "warn",
        kind: "erc20-approve",
      };
    }
    case "transferFrom": {
      const [from, to, amount] = decoded.args as [string, string, bigint];
      return {
        summary: `Move ${fmt(amount)} from ${short(from)} to ${short(to)}`,
        warnings: [],
        danger: "warn",
        kind: "erc20-transfer-from",
      };
    }
    case "setApprovalForAll": {
      const [operator, approved] = decoded.args as [string, boolean];
      return approved
        ? {
            summary: `Grant ${short(operator)} control over ALL your NFTs in this collection`,
            warnings: [
              "setApprovalForAll(true): the operator can transfer every NFT you own in this collection.",
            ],
            danger: "critical",
            kind: "set-approval-for-all",
          }
        : {
            summary: `Revoke ${short(operator)}'s control over this collection`,
            warnings: [],
            danger: "none",
            kind: "set-approval-for-all",
          };
    }
    case "safeTransferFrom": {
      const [, to, tokenId] = decoded.args as [string, string, bigint];
      return {
        summary: `Transfer NFT #${tokenId} to ${short(to)}`,
        warnings: [],
        danger: "none",
        kind: "nft-transfer",
      };
    }
  }
  // Unreachable given the ABI table, but keep the honest fallback.
  return {
    summary: `Contract call on ${short(tx.to ?? "?")}`,
    warnings: [],
    danger: "none",
    kind: "contract-call",
  };
}

/**
 * Summarize an EIP-712 payload. Recognizes ERC-2612 Permit (an approval in
 * disguise — flagged exactly like approve) and falls back to
 * domain + primaryType for everything else.
 */
export function decodeTypedData(typedData: {
  domain?: { name?: string; verifyingContract?: string };
  primaryType?: string;
  message?: Record<string, unknown>;
}): DecodedAction {
  const primary = typedData.primaryType ?? "TypedData";
  const dapp = typedData.domain?.name ?? "unknown domain";

  if (primary === "Permit" && typedData.message) {
    const m = typedData.message as { spender?: string; value?: string | bigint };
    const value =
      typeof m.value === "bigint" ? m.value : m.value !== undefined ? BigInt(m.value) : undefined;
    const unlimited = value !== undefined && value >= EFFECTIVELY_UNLIMITED;
    return {
      summary: unlimited
        ? `Permit (gasless approval): UNLIMITED spending for ${short(String(m.spender ?? "?"))} on ${dapp}`
        : `Permit (gasless approval) for ${short(String(m.spender ?? "?"))} on ${dapp}`,
      warnings: unlimited
        ? [
            "Unlimited Permit: a free-to-sign message that lets this address drain the entire token balance.",
          ]
        : ["Permit is an approval — signing moves spending power, not just data."],
      danger: unlimited ? "critical" : "warn",
      kind: "permit",
    };
  }

  return {
    summary: `Sign ${primary} for ${dapp}`,
    warnings: [],
    danger: "none",
    kind: "typed-data",
  };
}
