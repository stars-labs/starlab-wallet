/**
 * Cross-client restore, engine → extension: the fixtures under
 * tests/fixtures/engine-share were written by the engine's own
 * `Keystore::export_share` (starlab-mpc apps/tui/src/keystore/storage.rs,
 * branch feat/wallet-import-export) for a 2-of-3 wallet held by
 * device-a/b/c; `*.expected.json` is the engine's account-0 addresses.
 * "Import keystore" must restore the same wallet: id, label, group key,
 * cohort → FROST ids, and a share that derives the same account.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, jest, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);

const keystore = {
    wallets: [] as any[],
    added: [] as any[],
    isInitialized: async () => true,
    isLocked: () => false,
    getWallets() { return this.wallets; },
    async addWallet(id: string, keyShare: any, meta: any) { this.added.push({ id, keyShare, meta }); return true; },
    async setActiveWallet() { return true; },
};
mock.module("../../../src/services/keystoreManager", () => ({
    KeystoreManager: { getInstance: () => keystore },
}));
mock.module("../../../src/entrypoints/background/index", () => ({ checkAndRestoreKeystores: async () => {} }));

import wasmInit, {
    FrostDkgEd25519,
    FrostDkgSecp256k1,
    derive_account_addresses,
    derive_child_keystore_ed25519,
    derive_child_keystore_secp256k1,
    standard_account_path,
} from "@stars-labs/core-wasm";
import { REAL_WEBCRYPTO } from "../../setup-bun";
import { PopupMessageHandler } from "../../../src/entrypoints/background/messageHandlers";
import { openShareBackup } from "../../../src/utils/shareBackup";
import { toEngineKeystoreJson } from "../../../src/utils/engineKeystore";
import { engineBlobFromKeystore, keystoreFromEngineBlob } from "../../../src/utils/frostShareBlob";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";

/** The engine's plaintext share blob, decrypted independently of our code. */
function engineBlob(file: string, password: string): Uint8Array {
    const raw = Buffer.from(JSON.parse(file).data, "base64");
    const key = pbkdf2Sync(password, raw.subarray(0, 16), 100_000, 32, "sha256");
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(16, 28));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return new Uint8Array(Buffer.concat([d.update(raw.subarray(28, raw.length - 16)), d.final()]));
}

const FIXTURES = join(import.meta.dir, "../../fixtures/engine-share");
const fixture = (curve: string) => ({
    file: readFileSync(join(FIXTURES, `engine-share-${curve}.json`), "utf8"),
    expected: JSON.parse(readFileSync(join(FIXTURES, `engine-share-${curve}.expected.json`), "utf8")),
});

const savedCrypto = (globalThis as any).crypto;
beforeAll(async () => {
    await wasmInit();
});
beforeEach(() => {
    (globalThis as any).crypto = REAL_WEBCRYPTO;
    keystore.wallets = [];
    keystore.added = [];
});
afterEach(() => {
    (globalThis as any).crypto = savedCrypto;
});

describe("engine share file → extension (openShareBackup)", () => {
    for (const curve of ["secp256k1", "ed25519"] as const) {
        it(`${curve}: restores the wallet id, cohort and group key`, async () => {
            const { file, expected } = fixture(curve);
            const { metadata, keyShare } = await openShareBackup(file, expected.password);
            expect(metadata.session_id).toBe("w-transfer");
            expect(metadata.label).toBe("Savings");
            expect(keyShare.group_public_key).toBe(expected.group_public_key);
            expect(keyShare.participant_identifiers).toEqual({ "device-a": 1, "device-b": 2, "device-c": 3 });
            expect(keyShare.participant_index).toBe(1);
            expect([keyShare.threshold, keyShare.total_participants]).toEqual([2, 3]);
        });

        it(`${curve}: the share loads into the engine and derives the engine's account 0`, async () => {
            const { file, expected } = fixture(curve);
            const { keyShare } = await openShareBackup(file, expected.password);
            const chain = curve === "secp256k1" ? "bitcoin" : "solana";
            const derive = curve === "secp256k1" ? derive_child_keystore_secp256k1 : derive_child_keystore_ed25519;
            const inst = curve === "secp256k1" ? new FrostDkgSecp256k1() : new FrostDkgEd25519();
            try {
                inst.import_keystore(derive(toEngineKeystoreJson(keyShare), standard_account_path(chain, 0)!));
                const address = inst.get_address();
                const engineAccount0 = expected.account0.find((a: string[]) => a[1] === standard_account_path(chain, 0));
                expect(address.toLowerCase()).toBe(engineAccount0[2].toLowerCase());
            } finally {
                inst.free();
            }
        });
    }

    for (const curve of ["secp256k1", "ed25519"] as const) {
        it(`${curve}: the share blob codec round-trips the engine's bytes exactly`, () => {
            const { file, expected } = fixture(curve);
            const blob = engineBlob(file, expected.password);
            const { keystoreJson, groupPublicKey } = keystoreFromEngineBlob(blob, 3);
            expect(groupPublicKey).toBe(expected.group_public_key);
            expect(Buffer.from(engineBlobFromKeystore(keystoreJson)).toString("hex")).toBe(Buffer.from(blob).toString("hex"));
        });
    }

    it("rejects the wrong password", async () => {
        const { file } = fixture("secp256k1");
        await expect(openShareBackup(file, "not-the-password")).rejects.toThrow("Wrong password");
    });
});

describe("importKeystore handler with an engine file", () => {
    function handler() {
        const offscreenManager = {
            sendToOffscreen: jest.fn(async (msg: any) => ({
                success: true,
                accounts: [{ account: 0, addresses: JSON.parse(derive_account_addresses(msg.curve, msg.groupPublicKey, 0)) }],
            })),
        };
        return new PopupMessageHandler(
            { getState: () => ({ deviceId: "ext-new" }) } as any,
            offscreenManager as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
    }

    it("adds the wallet under the engine's id with its account-0 address", async () => {
        const { file, expected } = fixture("secp256k1");
        const res = await new Promise<any>((resolve) =>
            (handler() as any).handleImportKeystoreMessage(
                { type: "importKeystore", keystoreData: file, password: expected.password, chain: "ethereum" },
                resolve,
            ),
        );
        expect(res.success).toBe(true);
        const [{ id, keyShare, meta }] = keystore.added;
        expect(id).toBe("w-transfer");
        expect(meta.name).toBe("Savings");
        expect(meta.address.toLowerCase()).toBe(expected.account0[0][2].toLowerCase());
        expect(keyShare.group_public_key).toBe(expected.group_public_key);
        expect(keyShare.participants).toEqual(["device-a", "device-b", "device-c"]);
    });

    it("refuses a wallet that's already in the keystore", async () => {
        keystore.wallets = [{ id: "w-transfer" }];
        const { file, expected } = fixture("secp256k1");
        const res = await new Promise<any>((resolve) =>
            (handler() as any).handleImportKeystoreMessage(
                { type: "importKeystore", keystoreData: file, password: expected.password, chain: "ethereum" },
                resolve,
            ),
        );
        expect(res.success).toBe(false);
        expect(keystore.added).toHaveLength(0);
    });
});
