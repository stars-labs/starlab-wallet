/**
 * Typed, user-legible error handling for the signing path (#28).
 *
 * Raw failures bubble up from a dozen layers (FROST mesh, RPC nodes, policy,
 * phishing gate, hardware, keystore) with messages written for developers.
 * `classifyError` maps them — by the exact strings this codebase and its
 * dependencies actually produce — onto a stable {@link WalletErrorCode} with
 * a message a human can act on, plus whether retrying can help.
 *
 * Unknown errors stay visible: the original message is preserved in
 * `detail` and the user text says something went wrong rather than lying
 * with a guessed cause.
 */

export type WalletErrorCode =
  | "USER_REJECTED"
  | "TIMEOUT"
  | "PEER_OFFLINE"
  | "POLICY_BLOCKED"
  | "PHISHING_BLOCKED"
  | "KEYSTORE_LOCKED"
  | "NO_ACCOUNT"
  | "NO_NETWORK"
  | "RPC_UNREACHABLE"
  | "INSUFFICIENT_FUNDS"
  | "NONCE_ERROR"
  | "WOULD_REVERT"
  | "ENS_UNRESOLVED"
  | "HARDWARE_ERROR"
  | "UNKNOWN";

export interface ClassifiedError {
  code: WalletErrorCode;
  /** Short, actionable text for the UI. */
  userMessage: string;
  /** Whether simply trying again can plausibly succeed. */
  retriable: boolean;
  /** The original message, for logs / "details" disclosure. */
  detail: string;
}

interface Rule {
  test: RegExp;
  code: WalletErrorCode;
  userMessage: string;
  retriable: boolean;
}

/** Ordered — first match wins; more specific patterns go first. */
const RULES: Rule[] = [
  { test: /user rejected/i, code: "USER_REJECTED", userMessage: "You declined the request.", retriable: true },
  { test: /blocked by wallet policy/i, code: "POLICY_BLOCKED", userMessage: "Blocked by your spending policy — adjust it in Settings if you really mean it.", retriable: false },
  { test: /known phishing/i, code: "PHISHING_BLOCKED", userMessage: "Connection refused: this site is on the phishing blocklist.", retriable: false },
  { test: /timed out/i, code: "TIMEOUT", userMessage: "The request timed out — co-signer devices may be offline or the approval was never confirmed.", retriable: true },
  { test: /sessionmanager not initialized|not enough participants|threshold/i, code: "PEER_OFFLINE", userMessage: "Not enough co-signer devices are connected to reach the threshold.", retriable: true },
  { test: /keystore is locked/i, code: "KEYSTORE_LOCKED", userMessage: "The wallet is locked — unlock it with your password first.", retriable: true },
  { test: /no account selected|no wallet found for/i, code: "NO_ACCOUNT", userMessage: "No matching account — select or unlock the wallet that owns this address.", retriable: false },
  { test: /no (current network|evm rpc|solana rpc|rpc url)/i, code: "NO_NETWORK", userMessage: "No network/RPC configured — pick a network in Settings.", retriable: false },
  { test: /insufficient funds/i, code: "INSUFFICIENT_FUNDS", userMessage: "Insufficient funds to cover the amount plus gas.", retriable: false },
  { test: /nonce too low|replacement transaction underpriced|already known/i, code: "NONCE_ERROR", userMessage: "Transaction ordering conflict (nonce) — wait for the pending transaction or retry in a moment.", retriable: true },
  { test: /execution reverted|would revert/i, code: "WOULD_REVERT", userMessage: "The contract would reject this transaction (reverted).", retriable: false },
  { test: /does not resolve|enter a 0x address or an ens name/i, code: "ENS_UNRESOLVED", userMessage: "That name/address didn't resolve — check the recipient.", retriable: false },
  { test: /yubikey|ledger|webhid|hid|native host|connectnative/i, code: "HARDWARE_ERROR", userMessage: "Hardware signer unavailable — reconnect the device and try again.", retriable: true },
  { test: /failed to fetch|econnrefused|network ?error|http \d{3}|fetch failed/i, code: "RPC_UNREACHABLE", userMessage: "Couldn't reach the network RPC — check connectivity or switch RPC in Settings.", retriable: true },
];

/** Classify any thrown value into a typed, user-legible error. */
export function classifyError(err: unknown): ClassifiedError {
  const detail =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  for (const rule of RULES) {
    if (rule.test.test(detail)) {
      return { code: rule.code, userMessage: rule.userMessage, retriable: rule.retriable, detail };
    }
  }
  return {
    code: "UNKNOWN",
    userMessage: "Something went wrong — see details.",
    retriable: true,
    detail,
  };
}

/** One-liner for status strings: "user text (detail)" with detail trimmed. */
export function formatUserError(err: unknown): string {
  const c = classifyError(err);
  if (c.code === "UNKNOWN") {
    return `Something went wrong: ${c.detail.slice(0, 140)}`;
  }
  return c.userMessage;
}
