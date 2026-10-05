// ===================================================================
// ECDSA SAFE-PRIME CACHE (background side)
// ===================================================================
//
// The next wallet's threshold-ECDSA key needs this device's Paillier
// safe primes — minutes of wasm work, done by the offscreen PrimePool in
// Web Workers well before a DKG. A finished set is kept here ENCRYPTED
// with the keystore password (same PBKDF2 + AES-GCM as key shares) in
// chrome.storage.local, so it survives the offscreen document / service
// worker going away; it is decrypted back into the pool on unlock and
// deleted the moment a DKG takes it (one set per key). While the keystore
// is locked a fresh set waits in memory until unlock.
// ===================================================================

import type { EncryptedKeyShare } from "@stars-labs/types/keystore";
import type { AppState } from "@stars-labs/types/appstate";

export const PRIMES_STORAGE_KEY = "ecdsa_primes_v1";

export interface PrimeCacheDeps {
    keystore: {
        isLocked(): boolean;
        encryptSecret(id: string, plaintext: string): Promise<EncryptedKeyShare>;
        decryptSecret(encrypted: EncryptedKeyShare): Promise<string>;
    };
    storage: {
        get(key: string): Promise<Record<string, unknown>>;
        set(items: Record<string, unknown>): Promise<void>;
        remove(key: string): Promise<void>;
    };
    sendToOffscreen(message: { type: string; [k: string]: unknown }): Promise<unknown>;
    updateState(patch: Partial<AppState>): void;
}

export class EcdsaPrimeCache {
    /** The background's instance (set at startup). */
    static instance: EcdsaPrimeCache | null = null;

    /** A generated set not yet persisted (keystore was locked). */
    private unsaved: string | null = null;
    /** INSECURE, TESTS ONLY — see `setInsecureTestPrimes`. */
    private testPrimes: string | null = null;

    constructor(private readonly deps: PrimeCacheDeps) {}

    /**
     * Bring the offscreen pool in line with what we have: fixed test primes,
     * or (when unlocked) the persisted set, else start generating. Call
     * after unlock / keystore creation / wallet save and whenever the
     * offscreen document (re)initialises.
     */
    async sync(): Promise<void> {
        if (this.testPrimes) {
            await this.deps.sendToOffscreen({ type: "ecdsaPrimesInsecureTest", primesJson: this.testPrimes });
            return;
        }
        if (this.deps.keystore.isLocked()) return;
        if (this.unsaved) {
            await this.persist(this.unsaved);
            this.unsaved = null;
        }
        const stored = (await this.deps.storage.get(PRIMES_STORAGE_KEY))[PRIMES_STORAGE_KEY] as
            | EncryptedKeyShare
            | undefined;
        if (stored) {
            try {
                const primesJson = await this.deps.keystore.decryptSecret(stored);
                await this.deps.sendToOffscreen({ type: "ecdsaPrimesLoad", primesJson });
                return;
            } catch (e) {
                // Encrypted under another password (keystore recreated): useless.
                console.warn("[EcdsaPrimeCache] cached primes don't decrypt; discarding", e);
                await this.deps.storage.remove(PRIMES_STORAGE_KEY);
            }
        }
        await this.deps.sendToOffscreen({ type: "ecdsaPrimesEnsure" });
    }

    /** The pool finished a fresh set. */
    async onReady(primesJson: string): Promise<void> {
        if (this.testPrimes) return;
        if (this.deps.keystore.isLocked()) {
            this.unsaved = primesJson;
            return;
        }
        await this.persist(primesJson);
    }

    /** A DKG took the pool's set: never hand it out again. */
    async onConsumed(): Promise<void> {
        this.unsaved = null;
        await this.deps.storage.remove(PRIMES_STORAGE_KEY);
    }

    onProgress(progress: NonNullable<AppState["ecdsaPrimes"]>): void {
        this.deps.updateState({ ecdsaPrimes: progress });
    }

    /**
     * INSECURE, TESTS ONLY: every DKG uses these published primes (the
     * interop specs' stand-in for minutes of generation). Only reachable
     * from a build made with WXT_INSECURE_TEST_PRIMES=1 — see
     * `installInsecureTestPrimesHook`.
     */
    async setInsecureTestPrimes(primesJson: string): Promise<void> {
        this.testPrimes = primesJson;
        await this.sync();
    }

    private async persist(primesJson: string): Promise<void> {
        const encrypted = await this.deps.keystore.encryptSecret("ecdsa-primes", primesJson);
        await this.deps.storage.set({ [PRIMES_STORAGE_KEY]: encrypted });
    }
}

/** Fire-and-forget `sync` of the background instance (after the keystore
 *  password became available: unlock, keystore creation, save, import). */
export function syncEcdsaPrimes(): void {
    EcdsaPrimeCache.instance?.sync().catch((e) => console.warn("[EcdsaPrimeCache] sync failed:", e));
}

/** Whether this build carries the test-only fixed-primes hook. */
export const INSECURE_TEST_PRIMES_BUILD = import.meta.env.WXT_INSECURE_TEST_PRIMES === "1";

/**
 * Test builds only (`WXT_INSECURE_TEST_PRIMES=1 bun run build`): expose
 * `globalThis.__starlabInsecureTestPrimes(primesJson)` on the service
 * worker so an interop spec can inject fixture primes. A production build
 * compiles this out — the flag is a build-time constant.
 */
export function installInsecureTestPrimesHook(cache: EcdsaPrimeCache): void {
    if (!INSECURE_TEST_PRIMES_BUILD) return;
    console.warn("⚠️ [EcdsaPrimeCache] INSECURE test build: fixed ECDSA primes can be injected");
    (globalThis as Record<string, unknown>).__starlabInsecureTestPrimes = (primesJson: string) =>
        cache.setInsecureTestPrimes(primesJson);
}
