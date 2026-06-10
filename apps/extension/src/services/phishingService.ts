/**
 * Phishing protection (#36): classify a dApp origin before connect / sign.
 *
 * Three layers, all pure and unit-tested:
 *   1. **Blocklist** — exact-or-subdomain match against known-phishing hosts
 *      (seeded here; refreshable from the MetaMask eth-phishing-detect list).
 *   2. **Lookalike detection** — the registrable domain is compared against a
 *      brand list of popular dApps: punycode (xn--), digit-for-letter swaps
 *      (un1swap), brand-with-affix (uniswap-claim.org), and edit-distance ≤ 1
 *      near-misses (uniswaps.org) all warn. The real brand domain never warns.
 *   3. **Allowlist** — exact registrable-domain match of the brand list short-
 *      circuits to ok.
 *
 * Verdicts: 'ok' | 'warn' (show prominently, let the user proceed) | 'block'
 * (known phishing — require an explicit override far away from the approve
 * button). Fail-open by design: an unparseable origin warns rather than
 * blocks, because breaking dev setups (localhost, file://) teaches users to
 * ignore warnings.
 */

export type PhishingVerdict = "ok" | "warn" | "block";

export interface OriginCheck {
  verdict: PhishingVerdict;
  reason: string;
  /** The brand domain this origin imitates, when lookalike-flagged. */
  imitates?: string;
}

/** Popular wallet-draining-target brands (registrable domains). */
export const BRAND_DOMAINS = [
  "uniswap.org",
  "opensea.io",
  "metamask.io",
  "pancakeswap.finance",
  "curve.fi",
  "aave.com",
  "lido.fi",
  "ens.domains",
  "etherscan.io",
  "jup.ag",
  "magiceden.io",
  "tensor.trade",
  "phantom.app",
  "blur.io",
  "1inch.io",
] as const;

/** Seed blocklist (exact hosts or registrable domains). Refreshable at runtime. */
const SEED_BLOCKLIST = new Set<string>([
  "uniswap-airdrop.org",
  "opensea-claim.io",
  "metamask-wallet-verify.com",
]);

let blocklist = new Set(SEED_BLOCKLIST);

/** Replace the blocklist (e.g. after fetching eth-phishing-detect data). */
export function setBlocklist(hosts: Iterable<string>): void {
  blocklist = new Set([...SEED_BLOCKLIST, ...hosts]);
}

/** "https://app.uniswap.org/swap" → "app.uniswap.org"; null if unparseable. */
function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin.includes("://") ? origin : `https://${origin}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Best-effort registrable domain (eTLD+1). Handles the common two-level
 * public suffixes that appear in our brand list (e.g. co.uk-style isn't —
 * brands here are all simple suffixes, so last-two-labels is correct).
 */
function registrable(host: string): string {
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/** Undo the classic digit/letter confusables before comparing. */
function deconfuse(s: string): string {
  return s
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t");
}

/** Check one origin. Pure; the blocklist is module state set via setBlocklist. */
export function checkOrigin(origin: string): OriginCheck {
  const host = hostnameOf(origin);
  if (!host) {
    return { verdict: "warn", reason: "Unrecognizable origin" };
  }
  // Local development is fine.
  if (host === "localhost" || host === "127.0.0.1") {
    return { verdict: "ok", reason: "local" };
  }

  const reg = registrable(host);

  // 1. Blocklist: exact host or registrable domain.
  if (blocklist.has(host) || blocklist.has(reg)) {
    return { verdict: "block", reason: "Known phishing site" };
  }

  // 3 (checked early). Exact brand domain (or its subdomain) is ok.
  for (const brand of BRAND_DOMAINS) {
    if (reg === brand) return { verdict: "ok", reason: "known dApp" };
  }

  // Punycode anywhere in the hostname is a strong homoglyph signal.
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return {
      verdict: "warn",
      reason: "Internationalized (punycode) domain — characters may imitate a familiar name",
    };
  }

  // 2. Lookalike vs each brand's name part.
  const [regName] = reg.split(".");
  const deconfused = deconfuse(regName);
  for (const brand of BRAND_DOMAINS) {
    const [brandName] = brand.split(".");
    // brand embedded with affixes: uniswap-claim.org, app-uniswap.com
    if (regName !== brandName && regName.includes(brandName)) {
      return {
        verdict: "warn",
        reason: `Domain contains "${brandName}" but is not ${brand}`,
        imitates: brand,
      };
    }
    // confusable swap or 1-edit near-miss: un1swap.org, uniswaps.org
    if (
      regName !== brandName &&
      (deconfused === brandName || editDistance(regName, brandName) === 1)
    ) {
      return {
        verdict: "warn",
        reason: `Domain looks like ${brand} but isn't`,
        imitates: brand,
      };
    }
  }

  return { verdict: "ok", reason: "no signals" };
}
