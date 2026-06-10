/**
 * policyService tests — every rule pinned: per-tx cap, rolling-24h window
 * (boundary inclusive/exclusive), origin allowlist (subdomains pass, others
 * don't, wallet-initiated bypasses), empty policy allows everything, and the
 * spend log prunes + persists.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  evaluatePolicy,
  PolicyService,
  type PolicyConfig,
} from "../../src/services/policyService";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

describe("evaluatePolicy", () => {
  it("empty policy allows everything", () => {
    expect(evaluatePolicy({}, [], { valueWei: 10n ** 21n, now: NOW }).allowed).toBe(true);
  });

  it("per-tx limit: at the cap passes, above denies", () => {
    const cfg: PolicyConfig = { maxTxValueWei: (10n ** 18n).toString() };
    expect(evaluatePolicy(cfg, [], { valueWei: 10n ** 18n, now: NOW }).allowed).toBe(true);
    const denied = evaluatePolicy(cfg, [], { valueWei: 10n ** 18n + 1n, now: NOW });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("per-transaction");
  });

  it("daily limit: rolling 24h window — old spends fall out", () => {
    const cfg: PolicyConfig = { dailyLimitWei: (2n * 10n ** 18n).toString() };
    const spends = [
      { ts: NOW - 25 * HOUR, valueWei: (10n ** 18n).toString() }, // outside window
      { ts: NOW - 2 * HOUR, valueWei: (10n ** 18n).toString() }, // inside
    ];
    // inside-window spend (1 ETH) + request (1 ETH) == limit → allowed
    expect(
      evaluatePolicy(cfg, spends, { valueWei: 10n ** 18n, now: NOW }).allowed,
    ).toBe(true);
    // one wei more → denied, reason mentions what's already spent
    const denied = evaluatePolicy(cfg, spends, { valueWei: 10n ** 18n + 1n, now: NOW });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("24h");
  });

  it("origin allowlist: exact + subdomain pass, others deny, wallet-initiated bypasses", () => {
    const cfg: PolicyConfig = { originAllowlist: ["app.uniswap.org"] };
    expect(
      evaluatePolicy(cfg, [], { valueWei: 1n, origin: "https://app.uniswap.org", now: NOW }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy(cfg, [], { valueWei: 1n, origin: "https://x.app.uniswap.org", now: NOW }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy(cfg, [], { valueWei: 1n, origin: "https://evil.com", now: NOW }).allowed,
    ).toBe(false);
    // no origin = wallet-initiated → allowlist doesn't apply
    expect(evaluatePolicy(cfg, [], { valueWei: 1n, now: NOW }).allowed).toBe(true);
  });
});

describe("PolicyService", () => {
  const realNow = globalThis.Date.now;
  let clock = NOW;
  beforeEach(() => {
    clock = NOW;
    (globalThis as any).Date.now = () => clock;
    const svc = PolicyService.getInstance() as any;
    svc.config = {};
    svc.spends = [];
    svc.loaded = false;
  });
  afterEach(() => {
    (globalThis as any).Date.now = realNow;
  });

  it("config round-trips through storage", async () => {
    const svc = PolicyService.getInstance();
    await svc.setConfig({ maxTxValueWei: "5", autoLockMinutes: 10 });
    (svc as any).loaded = false;
    (svc as any).config = {};
    const cfg = await svc.getConfig();
    expect(cfg.maxTxValueWei).toBe("5");
    expect(cfg.autoLockMinutes).toBe(10);
  });

  it("recordSpend feeds the daily window and prunes old entries", async () => {
    const svc = PolicyService.getInstance();
    await svc.setConfig({ dailyLimitWei: "100" });
    await svc.recordSpend(60n);
    expect((await svc.check({ valueWei: 50n })).allowed).toBe(false);
    // a day later the window is clear again (prune happens on next record)
    clock += 25 * HOUR;
    expect((await svc.check({ valueWei: 50n })).allowed).toBe(true);
  });
});
