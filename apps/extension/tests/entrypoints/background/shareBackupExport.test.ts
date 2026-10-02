/**
 * Settings → "Export share backup" for a SAVED wallet. It used to export
 * from the offscreen's in-memory FROST instance, gated on dkgState ===
 * Complete, so after a browser restart (or once a signing ceremony moved
 * dkgState) it always failed. It now reads the stored key share from the
 * unlocked keystore and writes a password-encrypted, CLI-format backup
 * that "Import keystore" restores.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, jest, mock } from "bun:test";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);

const keystore = {
    locked: false,
    wallet: null as any,
    keyShare: null as any,
    initialize: async () => {},
    isInitialized: async () => true,
    isLocked() { return this.locked; },
    getActiveWallet() { return this.wallet; },
    async getKeyShare(id: string) { return id === this.wallet?.id ? this.keyShare : null; },
};
mock.module("../../../src/services/keystoreManager", () => ({
    KeystoreManager: { getInstance: () => keystore },
}));

import wasmInit, { FrostDkgSecp256k1 } from "@stars-labs/core-wasm";
import { REAL_WEBCRYPTO } from "../../setup-bun";
import { PopupMessageHandler } from "../../../src/entrypoints/background/messageHandlers";
import { StateManager } from "../../../src/entrypoints/background/stateManager";
import { restoreActiveWallet } from "../../../src/entrypoints/background/walletRestore";
import { keyShareCoreFromEngine } from "../../../src/utils/engineKeystore";
import { openShareBackup } from "../../../src/utils/shareBackup";
import { toEngineKeystoreJson } from "../../../src/utils/engineKeystore";
import { DkgState } from "@stars-labs/types/dkg";

const PASSWORD = "correct horse battery";
const COHORT = { "cli-alice": 1, "ext-bob": 2, "tui-carol": 3 };
let groupKey = "";
let ethAddress = "";

/** Real 2-of-3 secp256k1 DKG; keeps ext-bob's (index 2) share. */
function runDkg() {
    const parts = [1, 2, 3].map((i) => {
        const p = new FrostDkgSecp256k1();
        p.init_dkg(i, 3, 2);
        return p;
    });
    try {
        const r1 = parts.map((p) => p.generate_round1());
        parts.forEach((p, i) => r1.forEach((pkg, j) => i !== j && p.add_round1_package(j + 1, pkg)));
        const r2 = parts.map((p) => JSON.parse(Buffer.from(p.generate_round2(), "hex").toString()));
        r2.forEach((map, s) =>
            parts.forEach((p, r) => s !== r && p.add_round2_package(s + 1, map[String(r + 1)])),
        );
        parts.forEach((p) => p.finalize_dkg());
        const bob = parts[1];
        groupKey = bob.get_group_public_key();
        ethAddress = bob.get_address();
        return {
            ...keyShareCoreFromEngine(bob.export_keystore(), groupKey, COHORT),
            session_id: "dkg_abc",
            device_id: "ext-bob",
            blockchains: [],
            created_at: 1_700_000_000_000,
        };
    } finally {
        parts.forEach((p) => p.free());
    }
}

function handler(stateManager: StateManager) {
    return new PopupMessageHandler(stateManager, {} as any, {} as any, {} as any, {} as any, {} as any);
}

function exportBackup(stateManager: StateManager, password = PASSWORD) {
    return new Promise<any>((resolve) =>
        (handler(stateManager) as any).handleExportKeystoreMessage({ type: "exportKeystore", password }, resolve),
    );
}

async function restoredState() {
    const stateManager = new StateManager({ deviceId: "ext-bob", dkgState: DkgState.Idle });
    await new Promise((r) => setTimeout(r, 0));
    await restoreActiveWallet(stateManager, keystore as any);
    return stateManager;
}

const savedCrypto = (globalThis as any).crypto;

beforeAll(async () => {
    await wasmInit();
    keystore.keyShare = runDkg();
    keystore.wallet = {
        id: "wallet-1",
        name: "Team",
        blockchain: "ethereum",
        address: ethAddress,
        session_id: "dkg_abc",
        isActive: true,
        hasBackup: false,
    };
});

beforeEach(() => {
    (globalThis as any).crypto = REAL_WEBCRYPTO;
    keystore.locked = false;
});

afterEach(() => {
    (globalThis as any).crypto = savedCrypto;
});

describe("exportKeystore after a restore", () => {
    it("refuses while the keystore is locked", async () => {
        keystore.locked = true;
        const res = await exportBackup(await restoredState());
        expect(res.success).toBe(false);
    });

    it("refuses a short password", async () => {
        const res = await exportBackup(await restoredState(), "short");
        expect(res.success).toBe(false);
    });

    it("exports the stored share with no session or DKG in memory", async () => {
        const stateManager = await restoredState();
        expect(stateManager.getState().sessionInfo).toBeNull();

        const res = await exportBackup(stateManager);

        expect(res.success).toBe(true);
    });

    it("writes an encrypted file, never the plaintext share", async () => {
        const res = await exportBackup(await restoredState());
        const backup = JSON.parse(res.keystoreData);
        expect(backup.encrypted).toBe(true);
        expect(backup.algorithm).toBe("AES-256-GCM-PBKDF2");
        expect(res.keystoreData).not.toContain(keystore.keyShare.key_package);
    });

    it("writes the engine's WalletMetadata: wallet id as session_id, sorted participants, no wallet_id", async () => {
        const res = await exportBackup(await restoredState());
        const { version, metadata } = JSON.parse(res.keystoreData);
        expect(version).toBe("2.0");
        expect(Object.keys(metadata)).toEqual([
            "session_id", "device_id", "curve_type", "threshold", "total_participants",
            "participant_index", "group_public_key", "participants", "created_at", "last_modified", "label",
        ]);
        expect(metadata.session_id).toBe("wallet-1");
        expect(metadata.participants).toEqual(["cli-alice", "ext-bob", "tui-carol"]);
        expect(metadata.label).toBe("Team");
    });

    it("imports back to the same share, group key and address", async () => {
        const res = await exportBackup(await restoredState());
        const { metadata, keyShare } = await openShareBackup(res.keystoreData, PASSWORD);

        expect(metadata.group_public_key).toBe(groupKey);
        expect(keyShare.participant_identifiers).toEqual(COHORT);
        expect(keyShare.participant_index).toBe(2);
        expect(JSON.parse(toEngineKeystoreJson(keyShare))).toEqual(JSON.parse(toEngineKeystoreJson(keystore.keyShare)));
        const fresh = new FrostDkgSecp256k1();
        try {
            fresh.import_keystore(toEngineKeystoreJson(keyShare));
            expect(fresh.get_group_public_key()).toBe(groupKey);
            expect(fresh.get_address()).toBe(ethAddress);
        } finally {
            fresh.free();
        }
    });

    it("cannot be opened with the wrong password", async () => {
        const res = await exportBackup(await restoredState());
        await expect(openShareBackup(res.keystoreData, "wrong password!")).rejects.toThrow("Wrong password");
    });
});
