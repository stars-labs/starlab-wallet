/**
 * Share-usage policy engine (#35): limits enforced in front of the signing
 * path, so a compromised dApp session (or a fat finger) can't move more than
 * the user pre-authorized.
 *
 *   - **Per-tx value limit** — any single send above it is denied.
 *   - **Daily aggregate limit** — rolling 24h window over recorded spends.
 *   - **Origin allowlist** — when non-empty, only listed origins may initiate
 *     dApp sends (wallet-initiated sends, which have no origin, always may).
 *   - **Auto-lock minutes** — consumed by the background idle-lock timer.
 *
 * A denied request throws upstream with the policy reason; loosening the
 * policy in Settings is the explicit user action required (the wallet never
 * silently raises its own limits). Evaluation is pure given (config, spends,
 * now) so every rule is unit-tested.
 */

export interface PolicyConfig {
  /** Lock the keystore after this many idle minutes. 0/undefined = never. */
  autoLockMinutes?: number;
  /** Max wei a single tx may move. undefined = unlimited. */
  maxTxValueWei?: string;
  /** Max wei in any rolling 24h. undefined = unlimited. */
  dailyLimitWei?: string;
  /** When non-empty, dApp sends are limited to these origins. */
  originAllowlist?: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  /** Human reason when denied. */
  reason?: string;
}

interface SpendEntry {
  ts: number;
  valueWei: string;
}

const CONFIG_KEY = "wallet_policy";
const SPENDS_KEY = "wallet_policy_spends";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure rule evaluation — exported for tests and for the service below. */
export function evaluatePolicy(
  config: PolicyConfig,
  spends: SpendEntry[],
  req: { valueWei: bigint; origin?: string; now: number },
): PolicyDecision {
  if (config.maxTxValueWei !== undefined) {
    const max = BigInt(config.maxTxValueWei);
    if (req.valueWei > max) {
      return {
        allowed: false,
        reason: `Exceeds the per-transaction limit (${max} wei). Raise the limit in Settings to proceed.`,
      };
    }
  }

  if (config.dailyLimitWei !== undefined) {
    const limit = BigInt(config.dailyLimitWei);
    const windowStart = req.now - DAY_MS;
    const spent = spends
      .filter((s) => s.ts > windowStart)
      .reduce((acc, s) => acc + BigInt(s.valueWei), 0n);
    if (spent + req.valueWei > limit) {
      return {
        allowed: false,
        reason: `Exceeds the rolling 24h limit (${limit} wei; ${spent} already spent).`,
      };
    }
  }

  if (
    req.origin && // wallet-initiated sends carry no origin and always pass this rule
    config.originAllowlist &&
    config.originAllowlist.length > 0
  ) {
    const host = req.origin.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
    const ok = config.originAllowlist.some((o) => {
      const allowed = o.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
      return host === allowed || host.endsWith(`.${allowed}`);
    });
    if (!ok) {
      return {
        allowed: false,
        reason: `Origin ${req.origin} is not on the policy allowlist.`,
      };
    }
  }

  return { allowed: true };
}

export class PolicyService {
  private static instance: PolicyService;
  private config: PolicyConfig = {};
  private spends: SpendEntry[] = [];
  private loaded = false;

  static getInstance(): PolicyService {
    if (!PolicyService.instance) PolicyService.instance = new PolicyService();
    return PolicyService.instance;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (typeof chrome !== "undefined" && chrome.storage) {
      const res = await chrome.storage.local.get([CONFIG_KEY, SPENDS_KEY]);
      this.config = (res[CONFIG_KEY] as PolicyConfig) ?? {};
      this.spends = (res[SPENDS_KEY] as SpendEntry[]) ?? [];
    }
    this.loaded = true;
  }

  async getConfig(): Promise<PolicyConfig> {
    await this.ensureLoaded();
    return { ...this.config };
  }

  async setConfig(config: PolicyConfig): Promise<void> {
    await this.ensureLoaded();
    this.config = config;
    if (typeof chrome !== "undefined" && chrome.storage) {
      await chrome.storage.local.set({ [CONFIG_KEY]: config });
    }
  }

  /** Evaluate a prospective send against the active policy. */
  async check(req: { valueWei: bigint; origin?: string }): Promise<PolicyDecision> {
    await this.ensureLoaded();
    return evaluatePolicy(this.config, this.spends, {
      ...req,
      now: globalThis.Date.now(),
    });
  }

  /** Record a successful (broadcast) spend toward the daily window. */
  async recordSpend(valueWei: bigint): Promise<void> {
    await this.ensureLoaded();
    const now = globalThis.Date.now();
    // prune anything older than the window while we're here
    this.spends = this.spends.filter((s) => s.ts > now - DAY_MS);
    this.spends.push({ ts: now, valueWei: valueWei.toString() });
    if (typeof chrome !== "undefined" && chrome.storage) {
      await chrome.storage.local.set({ [SPENDS_KEY]: this.spends });
    }
  }
}
