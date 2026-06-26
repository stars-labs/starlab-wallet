/**
 * Transaction preflight simulation (#32) — the sandbox as a security feature.
 *
 * Before the FROST ceremony signs anything, replay the exact transaction on an
 * anvil-compatible node (the sandbox at :8545, ideally `anvil --fork-url` of
 * the live chain) and report what it actually DOES:
 *
 *   - success or revert (with the revert reason when the node gives one)
 *   - native balance diff for the sender
 *   - ERC-20 balance diffs for every tracked token
 *   - token movements for UNTRACKED tokens, auto-discovered from the receipt's
 *     Transfer logs (so an arbitrary dApp swap shows what it really moves)
 *   - approvals the tx grants (spender + amount), flagging unlimited spend —
 *     the #1 wallet-drainer vector — as a warning
 *   - gas used
 *
 * Flow per simulation: snapshot → impersonate sender → execute → read
 * receipt + balances + logs → revert snapshot. The fork is left exactly as
 * found, so simulations are repeatable and never pollute sandbox state.
 *
 * Everything is raw JSON-RPC over fetch — no provider object — so tests drive
 * it with a scripted fake fetch, and it works against any anvil/hardhat node.
 */
import { encodeFunctionData, decodeFunctionResult } from "viem";
import { ERC20_ABI, type TokenInfo } from "./tokenService";

export interface TokenDiff {
  token: TokenInfo;
  /** after - before, in base units (negative = spent). */
  diff: bigint;
}

export interface ApprovalChange {
  /** The token whose spend allowance is being granted. */
  token: TokenInfo;
  /** Who the sender is authorizing to move their tokens. */
  spender: string;
  /** Allowance granted, in base units. `null` for ERC-721 setApprovalForAll. */
  amount: bigint | null;
  /** True when the allowance is effectively infinite (drainer red flag). */
  unlimited: boolean;
}

export interface SimulationResult {
  /** Whether the node answered at all — false means "no sandbox, no verdict". */
  available: boolean;
  success?: boolean;
  revertReason?: string;
  gasUsed?: bigint;
  /** Sender's native balance delta in wei (negative = spent, incl. gas). */
  nativeDiff?: bigint;
  tokenDiffs?: TokenDiff[];
  /** Allowances the tx grants from the sender (empty when none). */
  approvals?: ApprovalChange[];
  /** Human-readable risk flags for the UI to highlight (empty when none). */
  warnings?: string[];
}

// Event topic0 hashes (keccak of the canonical signature). Both ERC-20 and
// ERC-721 share Transfer/Approval shapes; ERC-721/1155 add ApprovalForAll.
const TOPIC_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOPIC_APPROVAL =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const TOPIC_APPROVAL_FOR_ALL =
  "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";

/** Anything above this is "effectively unlimited" — dwarfs any real supply. */
const UNLIMITED_THRESHOLD = 1n << 200n;

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? `rpc ${method} failed`);
  return json.result;
}

async function erc20BalanceOf(url: string, token: string, owner: string): Promise<bigint> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner as `0x${string}`],
  });
  const out = await rpc(url, "eth_call", [{ to: token, data }, "latest"]);
  return decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: out,
  }) as bigint;
}

/** A 32-byte indexed-address topic → checksum-less 0x address. */
function topicToAddress(topic: string): string {
  return "0x" + topic.slice(-40).toLowerCase();
}

/**
 * Resolve a token's symbol/decimals for display, falling back to a shortened
 * address + 18 decimals when the contract doesn't answer (non-standard token,
 * or a plain ERC-721). Results are memoised in `cache` for the simulation.
 */
async function tokenMeta(
  rpcUrl: string,
  address: string,
  known: Map<string, TokenInfo>,
  cache: Map<string, TokenInfo>,
): Promise<TokenInfo> {
  const key = address.toLowerCase();
  const fromKnown = known.get(key);
  if (fromKnown) return fromKnown;
  const cached = cache.get(key);
  if (cached) return cached;

  const fallback: TokenInfo = {
    address,
    symbol: `${address.slice(0, 6)}…${address.slice(-4)}`,
    decimals: 18,
  };
  const call = async (fn: "symbol" | "decimals") =>
    rpc(rpcUrl, "eth_call", [
      { to: address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: fn }) },
      "latest",
    ]);
  try {
    const [symData, decData] = await Promise.all([call("symbol"), call("decimals")]);
    const symbol = decodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", data: symData }) as string;
    const decimals = Number(
      decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: decData }) as
        | number
        | bigint,
    );
    const meta: TokenInfo = {
      address,
      symbol: symbol || fallback.symbol,
      decimals: Number.isFinite(decimals) ? decimals : 18,
    };
    cache.set(key, meta);
    return meta;
  } catch {
    cache.set(key, fallback);
    return fallback;
  }
}

interface ParsedLogs {
  /** Net token movements for the sender, keyed by lowercased token address. */
  moves: Map<string, bigint>;
  approvals: ApprovalChange[];
}

/**
 * Walk the receipt logs for Transfer / Approval / ApprovalForAll events that
 * involve `sender`, netting transfers per token and collecting allowances the
 * tx grants. Metadata is fetched lazily so unknown tokens still render.
 */
async function parseLogs(
  rpcUrl: string,
  logs: any[],
  sender: string,
  known: Map<string, TokenInfo>,
  metaCache: Map<string, TokenInfo>,
): Promise<ParsedLogs> {
  const me = sender.toLowerCase();
  const moves = new Map<string, bigint>();
  const approvals: ApprovalChange[] = [];

  for (const log of logs) {
    const topics: string[] = log?.topics ?? [];
    const token = (log?.address ?? "").toLowerCase();
    if (!token || topics.length === 0) continue;
    const topic0 = topics[0].toLowerCase();

    if (topic0 === TOPIC_TRANSFER && topics.length >= 3) {
      const fromA = topicToAddress(topics[1]);
      const toA = topicToAddress(topics[2]);
      // ERC-721 puts the tokenId in topics[3] (no data); skip those for value
      // diffing — counting NFT ids as "amounts" would be misleading.
      if (topics.length >= 4) continue;
      const value = log.data && log.data !== "0x" ? BigInt(log.data) : 0n;
      if (fromA === me) moves.set(token, (moves.get(token) ?? 0n) - value);
      if (toA === me) moves.set(token, (moves.get(token) ?? 0n) + value);
    } else if (topic0 === TOPIC_APPROVAL && topics.length >= 3) {
      const owner = topicToAddress(topics[1]);
      if (owner !== me) continue;
      // ERC-721 Approval indexes the tokenId in topics[3]; ERC-20 carries the
      // amount in data.
      const isNft = topics.length >= 4;
      const amount = isNft ? null : log.data && log.data !== "0x" ? BigInt(log.data) : 0n;
      approvals.push({
        token: await tokenMeta(rpcUrl, log.address, known, metaCache),
        spender: topicToAddress(topics[2]),
        amount,
        unlimited: amount !== null && amount >= UNLIMITED_THRESHOLD,
      });
    } else if (topic0 === TOPIC_APPROVAL_FOR_ALL && topics.length >= 3) {
      const owner = topicToAddress(topics[1]);
      if (owner !== me) continue;
      const approved = log.data && BigInt(log.data) !== 0n;
      if (!approved) continue; // a revocation is not a risk to flag
      approvals.push({
        token: await tokenMeta(rpcUrl, log.address, known, metaCache),
        spender: topicToAddress(topics[2]),
        amount: null,
        unlimited: true, // approval-for-all is blanket access to every token
      });
    }
  }
  return { moves, approvals };
}

/**
 * Simulate `tx` from `tx.from` on the anvil node at `rpcUrl`, diffing native
 * balance and the given tracked tokens. Never throws for "node not there" —
 * that returns `{available:false}` so the UI says "simulation unavailable"
 * instead of blocking the send.
 */
export async function simulateTransaction(
  rpcUrl: string,
  tx: { from: string; to: string; value?: string; data?: string },
  tokens: TokenInfo[] = [],
): Promise<SimulationResult> {
  // Reachability probe doubles as the snapshot — one round-trip saved.
  let snapshot: string;
  try {
    snapshot = await rpc(rpcUrl, "evm_snapshot", []);
  } catch {
    return { available: false };
  }

  try {
    await rpc(rpcUrl, "anvil_impersonateAccount", [tx.from]);
    // Ensure the impersonated sender can pay gas on the fork (fork-local
    // funny-money; reverted with the snapshot anyway).
    await rpc(rpcUrl, "anvil_setBalance", [tx.from, "0x3635c9adc5dea00000"]); // 1000 ETH

    const balBefore = BigInt(await rpc(rpcUrl, "eth_getBalance", [tx.from, "latest"]));
    const tokenBefore = new Map<string, bigint>();
    for (const t of tokens) {
      tokenBefore.set(
        t.address.toLowerCase(),
        await erc20BalanceOf(rpcUrl, t.address, tx.from).catch(() => 0n),
      );
    }

    let hash: string;
    try {
      hash = await rpc(rpcUrl, "eth_sendTransaction", [
        {
          from: tx.from,
          to: tx.to,
          value: tx.value ?? "0x0",
          data: tx.data ?? "0x",
        },
      ]);
    } catch (e) {
      // Immediate rejection = revert at estimation on the fork.
      return {
        available: true,
        success: false,
        revertReason: (e as Error).message,
      };
    }

    const receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [hash]);
    const success = receipt?.status === "0x1" || receipt?.status === 1;
    const gasUsed = receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined;

    const balAfter = BigInt(await rpc(rpcUrl, "eth_getBalance", [tx.from, "latest"]));
    const tokenDiffs: TokenDiff[] = [];
    const known = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
    for (const t of tokens) {
      const after = await erc20BalanceOf(rpcUrl, t.address, tx.from).catch(() => 0n);
      const before = tokenBefore.get(t.address.toLowerCase()) ?? 0n;
      if (after !== before) tokenDiffs.push({ token: t, diff: after - before });
    }

    // Auto-discover movements/approvals from the receipt logs. Tracked tokens
    // already have an authoritative balanceOf diff above (robust to fee-on-
    // transfer), so only fold in log-derived diffs for the UNtracked ones.
    const metaCache = new Map<string, TokenInfo>();
    const logs: any[] = Array.isArray(receipt?.logs) ? receipt.logs : [];
    const { moves, approvals } = await parseLogs(rpcUrl, logs, tx.from, known, metaCache);
    for (const [addr, diff] of moves) {
      if (diff === 0n || known.has(addr)) continue;
      tokenDiffs.push({ token: await tokenMeta(rpcUrl, addr, known, metaCache), diff });
    }

    const warnings: string[] = [];
    for (const a of approvals) {
      if (!a.unlimited) continue;
      const where = `${a.spender.slice(0, 6)}…${a.spender.slice(-4)}`;
      warnings.push(
        a.amount === null
          ? `Grants ${a.token.symbol} approval-for-ALL to ${where}`
          : `Grants UNLIMITED ${a.token.symbol} approval to ${where}`,
      );
    }

    return {
      available: true,
      success,
      gasUsed,
      nativeDiff: balAfter - balBefore,
      tokenDiffs,
      approvals,
      warnings,
    };
  } finally {
    // Whatever happened, put the fork back exactly as we found it.
    await rpc(rpcUrl, "evm_revert", [snapshot]).catch(() => {});
    await rpc(rpcUrl, "anvil_stopImpersonatingAccount", [tx.from]).catch(() => {});
  }
}
