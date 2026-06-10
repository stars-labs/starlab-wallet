/**
 * walletErrors tests — every classification pinned against the EXACT strings
 * this codebase produces (grep'd from the signing path), plus rule ordering
 * and the honest UNKNOWN fallback (original message preserved, no guessed
 * cause).
 */
import { describe, it, expect } from "bun:test";
import { classifyError, formatUserError } from "../../src/services/walletErrors";

// (real string, expected code, retriable)
const CASES: [string, string, boolean][] = [
  ["User rejected signature request", "USER_REJECTED", true],
  ["Blocked by wallet policy: Exceeds the per-transaction limit (1 wei).", "POLICY_BLOCKED", false],
  ["Connection refused: https://evil.com is a known phishing site.", "PHISHING_BLOCKED", false],
  ["Signature request timed out", "TIMEOUT", true],
  ["Transaction signing timed out", "TIMEOUT", true],
  ["SessionManager not initialized — cannot route signing request", "PEER_OFFLINE", true],
  ["Keystore is locked", "KEYSTORE_LOCKED", true],
  ["No account selected", "NO_ACCOUNT", false],
  ["No wallet found for address 0xabc. Unlock a wallet…", "NO_ACCOUNT", false],
  ["No EVM RPC configured for broadcast", "NO_NETWORK", false],
  ["insufficient funds for gas * price + value", "INSUFFICIENT_FUNDS", false],
  ["nonce too low", "NONCE_ERROR", true],
  ["execution reverted: ERC20: transfer amount exceeds balance", "WOULD_REVERT", false],
  ["ENS name nobody.eth does not resolve", "ENS_UNRESOLVED", false],
  ["YubiKey account is not an EVM (secp256k1) key", "HARDWARE_ERROR", true],
  ["Failed to fetch", "RPC_UNREACHABLE", true],
  ["rpc eth_sendRawTransaction: HTTP 502", "RPC_UNREACHABLE", true],
];

describe("classifyError", () => {
  for (const [msg, code, retriable] of CASES) {
    it(`"${msg.slice(0, 50)}" → ${code}`, () => {
      const c = classifyError(new Error(msg));
      expect(c.code).toBe(code as any);
      expect(c.retriable).toBe(retriable);
      expect(c.detail).toBe(msg); // original always preserved
      expect(c.userMessage.length).toBeGreaterThan(0);
    });
  }

  it("unknown errors fall back honestly with the original detail", () => {
    const c = classifyError(new Error("flux capacitor desync 0x77"));
    expect(c.code).toBe("UNKNOWN");
    expect(c.detail).toContain("flux capacitor");
  });

  it("handles non-Error throwables", () => {
    expect(classifyError("nonce too low").code).toBe("NONCE_ERROR");
    expect(classifyError({ weird: true }).code).toBe("UNKNOWN");
  });

  it("rule order: a policy block mentioning a timeout is still POLICY_BLOCKED", () => {
    const c = classifyError(new Error("Blocked by wallet policy: request timed out budget"));
    expect(c.code).toBe("POLICY_BLOCKED");
  });
});

describe("formatUserError", () => {
  it("known: returns the user message only", () => {
    expect(formatUserError(new Error("nonce too low"))).toContain("ordering conflict");
  });
  it("unknown: includes the (truncated) original", () => {
    expect(formatUserError(new Error("flux capacitor"))).toContain("flux capacitor");
  });
});
