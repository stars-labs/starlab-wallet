/**
 * P0 data loss (round 3b): on a service-worker start the saved wallet
 * vanished — `mpc_keystore_index` was overwritten with `wallets: []`
 * while the share itself was still in storage.
 *
 * KeystoreService's constructor started loading the index without
 * awaiting it; the background's startup `initialize()` ran before that
 * read resolved, saw "no index", created an empty one and SAVED it over
 * the real one — then the pending read returned that empty index
 * ("Loaded keystore index with 0 wallets"). chrome.storage is async, so
 * whether the read won was pure timing.
 *
 * Loading must never write, and initialize() may only create an index
 * when storage really has none.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { storage } from "#imports";
import { KeystoreService } from "../../src/services/keystoreService";

const INDEX_KEY = "local:mpc_keystore_index";

/** An index + share as the previous build (e82724d) wrote them. */
const PREVIOUS_INDEX = {
    version: "1.0.0",
    wallets: [
        {
            id: "0b873257e864",
            name: "Team wallet",
            blockchain: "ethereum",
            address: "0x1111111111111111111111111111111111111111",
            session_id: "0b873257-e864-4aaa-bbbb-cccccccccccc",
            isActive: true,
            hasBackup: false,
            createdAt: 1790000000000,
        },
    ],
    device_id: "ext-56ce7ada",
    isEncrypted: true,
    encryptionMethod: "password",
    lastModified: 1790000000000,
};

let data: Record<string, any>;
const realGet = (storage.getItem as any).getMockImplementation();
const realSet = (storage.setItem as any).getMockImplementation();

beforeEach(() => {
    data = {
        [INDEX_KEY]: structuredClone(PREVIOUS_INDEX),
        "local:mpc_keystore_share_0b873257e864": { walletId: "0b873257e864", ciphertext: "…" },
    };
    // chrome.storage answers asynchronously: a read issued first can
    // still resolve after a later write was applied.
    (storage.getItem as any).mockImplementation(async (key: string) => {
        await new Promise((r) => setTimeout(r, 5));
        return data[key] ?? null;
    });
    (storage.setItem as any).mockImplementation(async (key: string, value: any) => {
        data[key] = structuredClone(value);
    });
    (storage.setItem as any).mockClear();
    KeystoreService.resetInstance();
    (KeystoreService as any).testMode = false; // load from storage like production
});

afterEach(() => {
    (storage.getItem as any).mockImplementation(realGet);
    (storage.setItem as any).mockImplementation(realSet);
    KeystoreService.resetInstance();
});

const indexWrites = () => (storage.setItem as any).mock.calls.filter((c: any[]) => c[0] === INDEX_KEY);

describe("KeystoreService startup load", () => {
    it("startup initialize() keeps the saved wallet (previous build's index)", async () => {
        const ks = KeystoreService.getInstance();
        await ks.initialize("ext-56ce7ada");

        expect(ks.getWallets().map((w) => w.id)).toEqual(["0b873257e864"]);
        expect(data[INDEX_KEY].wallets).toHaveLength(1);
    });

    it("loading never writes the index", async () => {
        const ks = KeystoreService.getInstance();
        await ks.initialize("ext-56ce7ada");
        await ks.ready();

        expect(indexWrites()).toHaveLength(0);
    });

    it("creates an index only when storage has none", async () => {
        delete data[INDEX_KEY];
        const ks = KeystoreService.getInstance();
        await ks.initialize("ext-0000");

        expect(indexWrites()).toHaveLength(1);
        expect(data[INDEX_KEY].wallets).toEqual([]);
    });

    it("an unreadable index fails loudly and is left untouched", async () => {
        data[INDEX_KEY] = { version: "9", wallets: "not-a-list" };
        const ks = KeystoreService.getInstance();

        await expect(ks.initialize("ext-56ce7ada")).rejects.toThrow("mpc_keystore_index");
        expect(indexWrites()).toHaveLength(0);
        expect(data[INDEX_KEY]).toEqual({ version: "9", wallets: "not-a-list" });
    });

    it("a storage read error fails loudly instead of starting empty", async () => {
        (storage.getItem as any).mockImplementation(async () => {
            throw new Error("storage unavailable");
        });
        const ks = KeystoreService.getInstance();

        await expect(ks.initialize("ext-56ce7ada")).rejects.toThrow("storage unavailable");
        expect(indexWrites()).toHaveLength(0);
    });
});
