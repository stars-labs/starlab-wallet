/**
 * Allowance manager (#17): track every ERC-20 approval THIS wallet signs, so
 * the user can review and revoke them later. Without an indexer the chain
 * can't be asked "what did I ever approve?" — but the wallet sees every
 * approve() it signs (txDecoder classifies them in the send path), so a local
 * registry is complete for wallet-originated approvals.
 *
 * Review = recorded entries refreshed against fetchAllowance (the on-chain
 * truth — a revoked or spent-down allowance shows as 0). Revoke = a normal
 * send to the token with approve(spender, 0) calldata, through the same
 * MPC sign + broadcast path as everything else.
 */
import type { PublicClient } from "viem";
import { encodeErc20Approve, fetchAllowance } from "./tokenService";
import type { EthSendParams } from "./sendService";

export interface AllowanceRecord {
  chainId: number;
  /** Token contract. */
  token: string;
  /** Approved spender. */
  spender: string;
  /** Owner account (this wallet's address). */
  owner: string;
  /** Last approved amount we saw (base units, decimal string; "max" callers format). */
  lastApproved: string;
  /** Epoch ms of the most recent approval we recorded. */
  updatedAt: number;
}

const STORAGE_KEY = "wallet_allowances";

function keyOf(r: Pick<AllowanceRecord, "chainId" | "token" | "spender" | "owner">): string {
  return `${r.chainId}:${r.token.toLowerCase()}:${r.spender.toLowerCase()}:${r.owner.toLowerCase()}`;
}

export class AllowanceService {
  private static instance: AllowanceService;
  private records: Record<string, AllowanceRecord> = {};
  private loaded = false;

  static getInstance(): AllowanceService {
    if (!AllowanceService.instance) AllowanceService.instance = new AllowanceService();
    return AllowanceService.instance;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (typeof chrome !== "undefined" && chrome.storage) {
      const res = await chrome.storage.local.get([STORAGE_KEY]);
      this.records = (res[STORAGE_KEY] as Record<string, AllowanceRecord>) ?? {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (typeof chrome !== "undefined" && chrome.storage) {
      await chrome.storage.local.set({ [STORAGE_KEY]: this.records });
    }
  }

  /** Record (upsert) an approval this wallet signed. */
  async record(r: Omit<AllowanceRecord, "updatedAt">): Promise<void> {
    await this.ensureLoaded();
    this.records[keyOf(r)] = { ...r, updatedAt: globalThis.Date.now() };
    await this.persist();
  }

  /** All recorded approvals for an owner (optionally one chain), newest first. */
  async list(owner: string, chainId?: number): Promise<AllowanceRecord[]> {
    await this.ensureLoaded();
    return Object.values(this.records)
      .filter(
        (r) =>
          r.owner.toLowerCase() === owner.toLowerCase() &&
          (chainId === undefined || r.chainId === chainId),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Drop a record (after a confirmed revoke, or manual dismissal). */
  async remove(r: Pick<AllowanceRecord, "chainId" | "token" | "spender" | "owner">): Promise<void> {
    await this.ensureLoaded();
    delete this.records[keyOf(r)];
    await this.persist();
  }

  /**
   * Refresh recorded entries against the chain. Returns the records joined
   * with their CURRENT allowance; entries the chain reports as 0 are pruned
   * from storage (already revoked / fully spent) and excluded.
   */
  async listLive(
    owner: string,
    chainId: number,
    client: Pick<PublicClient, "readContract">,
  ): Promise<(AllowanceRecord & { current: bigint })[]> {
    const recs = await this.list(owner, chainId);
    const out: (AllowanceRecord & { current: bigint })[] = [];
    for (const r of recs) {
      let current: bigint;
      try {
        current = await fetchAllowance(client as PublicClient, r.token, r.owner, r.spender);
      } catch {
        // Unreadable token (RPC hiccup / weird contract): keep the record,
        // surface unknown as -1n so the UI can say "unknown" rather than 0.
        out.push({ ...r, current: -1n });
        continue;
      }
      if (current === 0n) {
        await this.remove(r);
        continue;
      }
      out.push({ ...r, current });
    }
    return out;
  }
}

/** Build the revoke tx: approve(spender, 0) on the token, from `owner`. */
export function buildRevokeTx(
  owner: string,
  token: string,
  spender: string,
): EthSendParams {
  return {
    from: owner,
    to: token,
    value: "0x0",
    data: encodeErc20Approve(spender, 0n),
  };
}
