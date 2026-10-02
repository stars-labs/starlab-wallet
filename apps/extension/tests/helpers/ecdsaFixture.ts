/**
 * A real 2-of-3 threshold-ECDSA wallet (INSECURE fixture primes, test-only
 * key material; `scripts/gen-ecdsa-fixtures.ts`), for tests that need a
 * valid ECDSA share without running aux info themselves.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WebRTCManager } from "../../src/entrypoints/offscreen/webrtc";

export const ECDSA_WALLET: {
    participants: string[];
    threshold: number;
    group_public_key: string;
    shares: string[];
} = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/ecdsa/wallet-2of3.json"), "utf8"));

/** Make a manager's post-FROST ECDSA key generation return fixture share
 * `index` at once (FROST-focused tests). */
export function stubEcdsaDkg(mgr: WebRTCManager, index = 0): void {
    mgr.getEcdsaPrimes = async () => "fixture";
    (mgr.ecdsa as { runDkg: unknown }).runDkg = async () => ECDSA_WALLET.shares[index];
}

/** Resolve once `cond()` holds (polls the event loop). */
export async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > end) throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 1));
    }
}
