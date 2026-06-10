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
 *   - gas used
 *
 * Flow per simulation: snapshot → impersonate sender → execute → read
 * receipt + balances → revert snapshot. The fork is left exactly as found, so
 * simulations are repeatable and never pollute sandbox state.
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

export interface SimulationResult {
  /** Whether the node answered at all — false means "no sandbox, no verdict". */
  available: boolean;
  success?: boolean;
  revertReason?: string;
  gasUsed?: bigint;
  /** Sender's native balance delta in wei (negative = spent, incl. gas). */
  nativeDiff?: bigint;
  tokenDiffs?: TokenDiff[];
}

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
    for (const t of tokens) {
      const after = await erc20BalanceOf(rpcUrl, t.address, tx.from).catch(() => 0n);
      const before = tokenBefore.get(t.address.toLowerCase()) ?? 0n;
      if (after !== before) tokenDiffs.push({ token: t, diff: after - before });
    }

    return {
      available: true,
      success,
      gasUsed,
      nativeDiff: balAfter - balBefore,
      tokenDiffs,
    };
  } finally {
    // Whatever happened, put the fork back exactly as we found it.
    await rpc(rpcUrl, "evm_revert", [snapshot]).catch(() => {});
    await rpc(rpcUrl, "anvil_stopImpersonatingAccount", [tx.from]).catch(() => {});
  }
}
