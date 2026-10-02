/**
 * ECDSA key material around the ceremonies: the per-curve backup file, the
 * encrypted safe-prime cache, the prime pool, signature parts and the tx
 * the wallet signs. Real WebCrypto + real WASM; no network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { REAL_WEBCRYPTO } from "../setup-bun";
import wasmInit, { ecdsa_share_info, ecdsa_primes_from_parts } from "@stars-labs/core-wasm";
import {
    ECDSA_BACKUP_CURVE,
    encryptEcdsaShareBackup,
    openEcdsaShareBackup,
    shareBackupCurve,
} from "../../src/utils/shareBackup";
import { EcdsaPrimeCache, PRIMES_STORAGE_KEY, type PrimeCacheDeps } from "../../src/entrypoints/background/ecdsaPrimes";
import { PrimePool, PRIME_COUNT } from "../../src/ecdsa/primePool";
import type { FromWorker, ToWorker, WorkerLike } from "../../src/ecdsa/protocol";
import { signatureParts } from "../../src/ecdsa/signature";
import { completeEvmTransaction, type EvmTxClient } from "../../src/services/txBroadcast";
import { ECDSA_WALLET } from "../helpers/ecdsaFixture";
import { readFileSync } from "node:fs";
import { join } from "node:path";

beforeAll(async () => {
    await wasmInit();
});
beforeEach(() => {
    (globalThis as any).crypto = REAL_WEBCRYPTO;
});
const savedCrypto = (globalThis as any).crypto;
afterEach(() => {
    (globalThis as any).crypto = savedCrypto;
});
afterAll(async () => {
    const { KeystoreService } = await import("../../src/services/keystoreService");
    KeystoreService.resetInstance();
});

describe("ECDSA share backup (engine per-curve v2 file)", () => {
    const share = ECDSA_WALLET.shares[1];

    it("round-trips and carries the engine's metadata for curve secp256k1-ecdsa", async () => {
        const info = JSON.parse(ecdsa_share_info(share));
        const file = await encryptEcdsaShareBackup(share, info, { id: "w1", name: "Savings", deviceId: "device-b" }, "pw-12345678");
        const parsed = JSON.parse(file);
        expect(parsed.version).toBe("2.0");
        expect(parsed.algorithm).toBe("AES-256-GCM-PBKDF2");
        expect(parsed.metadata).toMatchObject({
            session_id: "w1",
            device_id: "device-b",
            curve_type: ECDSA_BACKUP_CURVE,
            threshold: 2,
            total_participants: 3,
            participant_index: 2,
            group_public_key: ECDSA_WALLET.group_public_key,
            participants: ECDSA_WALLET.participants,
            label: "Savings",
        });
        expect(shareBackupCurve(file)).toBe("secp256k1-ecdsa");
        const opened = await openEcdsaShareBackup(file, "pw-12345678");
        expect(opened.shareJson).toBe(share);
        expect(opened.metadata.session_id).toBe("w1");
        await expect(openEcdsaShareBackup(file, "wrong-password")).rejects.toThrow("Wrong password");
    });
});

function memoryStorage() {
    const data: Record<string, unknown> = {};
    return {
        data,
        get: async (k: string) => (k in data ? { [k]: data[k] } : {}),
        set: async (items: Record<string, unknown>) => void Object.assign(data, items),
        remove: async (k: string) => void delete data[k],
    };
}

describe("keystore: the ECDSA share is its own encrypted curve entry", () => {
    it("stores it encrypted under the keystore password and reads it back after unlock", async () => {
        const { KeystoreService } = await import("../../src/services/keystoreService");
        const { storage } = await import("#imports");
        KeystoreService.resetInstance();
        const ks = KeystoreService.getInstance();
        await ks.initialize("device-b");
        await ks.unlock("keystore-password");
        await ks.setCurveShare("w1", "secp256k1-ecdsa", ECDSA_WALLET.shares[1]);
        const raw = JSON.stringify(await storage.getItem("local:mpc_keystore_share_w1__secp256k1-ecdsa"));
        expect(raw).not.toContain("key_share");
        ks.lock();
        await expect(ks.getCurveShare("w1", "secp256k1-ecdsa")).rejects.toThrow("locked");
        await ks.unlock("keystore-password");
        expect(await ks.getCurveShare("w1", "secp256k1-ecdsa")).toBe(ECDSA_WALLET.shares[1]);
        expect(await ks.getCurveShare("w2", "secp256k1-ecdsa")).toBeNull();
    });
});

describe("encrypted safe-prime cache", () => {
    async function deps(locked = false) {
        const { KeystoreService } = await import("../../src/services/keystoreService");
        KeystoreService.resetInstance?.();
        const ks = KeystoreService.getInstance();
        await ks.initialize("dev");
        await ks.unlock("keystore-password");
        const sent: { type: string; [k: string]: unknown }[] = [];
        const storage = memoryStorage();
        const d: PrimeCacheDeps = {
            keystore: {
                isLocked: () => locked,
                encryptSecret: (id, p) => ks.encryptSecret(id, p),
                decryptSecret: (e) => ks.decryptSecret(e),
            },
            storage,
            sendToOffscreen: async (m) => void sent.push(m),
            updateState: () => {},
        };
        return { d, sent, storage };
    }

    it("persists a fresh set encrypted, loads it back on sync, forgets it once consumed", async () => {
        const { d, sent, storage } = await deps();
        const cache = new EcdsaPrimeCache(d);
        await cache.sync();
        expect(sent.at(-1)).toEqual({ type: "ecdsaPrimesEnsure" });
        await cache.onReady('{"primes":"SECRET"}');
        const stored = JSON.stringify(storage.data[PRIMES_STORAGE_KEY]);
        expect(stored).not.toContain("SECRET");
        await cache.sync();
        expect(sent.at(-1)).toEqual({ type: "ecdsaPrimesLoad", primesJson: '{"primes":"SECRET"}' });
        await cache.onConsumed();
        expect(storage.data[PRIMES_STORAGE_KEY]).toBeUndefined();
    });

    it("keeps a set made while locked in memory only, and persists it on the next sync", async () => {
        let locked = true;
        const { d, storage } = await deps();
        d.keystore.isLocked = () => locked;
        const cache = new EcdsaPrimeCache(d);
        await cache.onReady('{"primes":"X"}');
        expect(storage.data[PRIMES_STORAGE_KEY]).toBeUndefined();
        locked = false;
        await cache.sync();
        expect(storage.data[PRIMES_STORAGE_KEY]).toBeDefined();
    });
});

/** Fake prime workers answering with fixture primes, in order. */
function fakePrimeWorkers(parts: string[]) {
    let next = 0;
    const spawned: WorkerLike[] = [];
    const spawn = (): WorkerLike => {
        const w: WorkerLike = {
            onmessage: null,
            postMessage: (m: ToWorker) => {
                if (m.type !== "prime") return;
                const prime = parts[next++ % parts.length];
                setTimeout(() => w.onmessage?.({ data: { type: "prime", prime } as FromWorker }), 1);
            },
            terminate: () => {},
        };
        spawned.push(w);
        return w;
    };
    return { spawn, spawned };
}

describe("prime pool", () => {
    const sets = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/ecdsa/insecure-test-primes.json"), "utf8"));
    const parts: string[] = sets[0].primes.map((p: unknown) => JSON.stringify(p));

    it("runs the four primes in parallel workers and reports progress per prime", async () => {
        const { spawn, spawned } = fakePrimeWorkers(parts);
        const progress: number[] = [];
        let ready = "";
        const pool = new PrimePool({
            spawnWorker: spawn,
            join: (p) => ecdsa_primes_from_parts(`[${p.join(",")}]`),
            onProgress: (p) => progress.push(p.done),
            onReady: (j) => (ready = j),
            log: () => {},
        });
        const taken = pool.take();
        expect(spawned.length).toBe(PRIME_COUNT);
        const primes = await taken;
        expect(JSON.parse(primes).primes).toEqual(sets[0].primes);
        expect(ready).toBe(primes);
        expect(progress.slice(0, 4)).toEqual([0, 1, 2, 3]);
        // Taking a set starts the next one.
        expect(spawned.length).toBe(2 * PRIME_COUNT);
    });

    it("hands insecure test primes to every DKG without generating", async () => {
        const { spawn, spawned } = fakePrimeWorkers(parts);
        const pool = new PrimePool({ spawnWorker: spawn, join: () => "", onProgress: () => {}, onReady: () => {}, log: () => {} });
        pool.setInsecureTestPrimes("FIXED");
        expect(await pool.take()).toBe("FIXED");
        expect(await pool.take()).toBe("FIXED");
        expect(spawned.length).toBe(0);
    });
});

describe("transaction the wallet signs", () => {
    const client: EvmTxClient = {
        getTransactionCount: async () => 7,
        estimateGas: async () => 21000n,
        estimateFeesPerGas: async () => ({ maxFeePerGas: 30n, maxPriorityFeePerGas: 2n }),
    };
    const from = "0x1111111111111111111111111111111111111111";

    it("fills nonce, gas (+20%) and EIP-1559 fees from the network", async () => {
        const tx = await completeEvmTransaction(
            { to: "0x000000000000000000000000000000000000dEaD", value: "0x10" },
            { chainId: 11155111, from, client },
        );
        expect(tx).toEqual({
            type: "eip1559",
            chainId: 11155111,
            nonce: 7,
            to: "0x000000000000000000000000000000000000dEaD",
            value: 16n,
            data: "0x",
            gas: 25200n,
            maxFeePerGas: 30n,
            maxPriorityFeePerGas: 2n,
        });
    });

    it("keeps what the caller pinned, legacy when only gasPrice is given", async () => {
        const tx = await completeEvmTransaction(
            { to: "0x000000000000000000000000000000000000dEaD", nonce: "0x2", gas: "0x5208", gasPrice: "0x3" },
            { chainId: 1, from, client },
        );
        expect(tx).toMatchObject({ type: "legacy", nonce: 2, gas: 21000n, gasPrice: 3n });
    });

    it("splits r‖s‖v into typed-tx parts (y_parity = v - 27)", () => {
        const sig = "11".repeat(32) + "22".repeat(32) + "1c";
        expect(signatureParts(sig)).toEqual({ r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, recovery: 1 });
        expect(() => signatureParts("00")).toThrow();
    });
});
