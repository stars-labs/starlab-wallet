/**
 * Transaction activity history.
 *
 * The wallet had no record of what it sent — once a FROST ceremony broadcast a
 * tx it vanished. This persists a per-account activity log (newest first),
 * records a `pending` entry at submit time, and flips it to `confirmed` /
 * `failed` once a receipt lands. Storage is chrome.storage.local; the popup
 * reads it to render an activity feed.
 */
import type { PublicClient } from "viem";

export type ActivityStatus = "pending" | "confirmed" | "failed";
export type ActivityKind = "send" | "receive" | "contract" | "token-transfer";

export interface Activity {
  /** Tx hash (0x…). Also the dedupe key within a chain. */
  hash: string;
  chainId: number;
  from: string;
  to: string;
  /** Native value in wei as a decimal string (bigint-safe across storage). */
  value: string;
  kind: ActivityKind;
  status: ActivityStatus;
  /** Epoch ms when first recorded. */
  timestamp: number;
  /** ERC-20 contract address for token transfers. */
  tokenAddress?: string;
  /** Optional human note / dApp origin. */
  note?: string;
}

const STORAGE_KEY = "wallet_activity";
/** Cap per account so the log can't grow unbounded in storage. */
const MAX_PER_ACCOUNT = 200;

function keyFor(address: string): string {
  return address.toLowerCase();
}

export class ActivityService {
  private static instance: ActivityService;
  /** address(lower) → activities (newest first). */
  private byAccount: Record<string, Activity[]> = {};
  private loaded = false;

  static getInstance(): ActivityService {
    if (!ActivityService.instance) ActivityService.instance = new ActivityService();
    return ActivityService.instance;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (typeof chrome !== "undefined" && chrome.storage) {
      const res = await chrome.storage.local.get([STORAGE_KEY]);
      this.byAccount = (res[STORAGE_KEY] as Record<string, Activity[]>) ?? {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (typeof chrome !== "undefined" && chrome.storage) {
      await chrome.storage.local.set({ [STORAGE_KEY]: this.byAccount });
    }
  }

  /**
   * Record a freshly-submitted transaction as `pending`. Idempotent by
   * (chainId, hash): re-recording updates the existing entry rather than
   * duplicating, so a retry / re-broadcast doesn't create a second row.
   */
  async record(
    account: string,
    tx: Omit<Activity, "status" | "timestamp"> &
      Partial<Pick<Activity, "status" | "timestamp">>,
  ): Promise<Activity> {
    await this.ensureLoaded();
    const k = keyFor(account);
    const list = (this.byAccount[k] ??= []);
    const entry: Activity = {
      status: "pending",
      timestamp: globalThis.Date.now(),
      ...tx,
    };
    const idx = list.findIndex(
      (a) => a.chainId === entry.chainId && a.hash.toLowerCase() === entry.hash.toLowerCase(),
    );
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...entry, timestamp: list[idx].timestamp };
    } else {
      list.unshift(entry); // newest first
      if (list.length > MAX_PER_ACCOUNT) list.length = MAX_PER_ACCOUNT;
    }
    await this.persist();
    return entry;
  }

  /** Transition a recorded tx to confirmed/failed by hash. No-op if unknown. */
  async setStatus(
    account: string,
    hash: string,
    status: ActivityStatus,
  ): Promise<void> {
    await this.ensureLoaded();
    const list = this.byAccount[keyFor(account)];
    if (!list) return;
    const entry = list.find((a) => a.hash.toLowerCase() === hash.toLowerCase());
    if (entry && entry.status !== status) {
      entry.status = status;
      await this.persist();
    }
  }

  /** Activities for an account, newest first. Optional chain filter. */
  async list(account: string, chainId?: number): Promise<Activity[]> {
    await this.ensureLoaded();
    const list = this.byAccount[keyFor(account)] ?? [];
    const filtered = chainId === undefined ? list : list.filter((a) => a.chainId === chainId);
    return [...filtered].sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Hashes still pending for an account (to drive receipt polling). */
  async pending(account: string): Promise<Activity[]> {
    await this.ensureLoaded();
    return (this.byAccount[keyFor(account)] ?? []).filter((a) => a.status === "pending");
  }

  /**
   * Poll a receipt for one pending tx and update its status. Returns the new
   * status, or "pending" if the receipt isn't available yet. Callers loop this
   * over `pending()` on a timer; kept here so the transition logic is tested.
   */
  async reconcile(
    account: string,
    client: Pick<PublicClient, "getTransactionReceipt">,
    hash: string,
  ): Promise<ActivityStatus> {
    let receipt: { status?: string | number | bigint } | null = null;
    try {
      receipt = (await client.getTransactionReceipt({ hash: hash as `0x${string}` })) as any;
    } catch {
      return "pending"; // not mined yet (receipt not found throws in viem)
    }
    if (!receipt) return "pending";
    // viem normalizes receipt.status to "success" | "reverted".
    const ok = receipt.status === "success" || receipt.status === 1 || receipt.status === 1n;
    const next: ActivityStatus = ok ? "confirmed" : "failed";
    await this.setStatus(account, hash, next);
    return next;
  }
}
