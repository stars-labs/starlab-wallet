/**
 * Live path (round 3b): a wallet restored with "Import keystore" from an
 * engine-format backup, then "Sign message" in the popup, must announce the
 * wallet's whole cohort — TUI / desktop only offer a signing that lists
 * them. Real KeystoreManager / KeystoreService / SessionManager; only the
 * signal-server socket and the offscreen document are stand-ins.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, jest, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);
mock.module("../../../src/entrypoints/background/index", () => ({ checkAndRestoreKeystores: async () => {} }));

import wasmInit, { derive_account_addresses, ecdsa_share_info } from "@stars-labs/core-wasm";
import { frostShare } from "../../helpers/frostShare";
import { encryptShareBackup, encryptEcdsaShareBackup } from "../../../src/utils/shareBackup";
import { ECDSA_WALLET } from "../../helpers/ecdsaFixture";
import { REAL_WEBCRYPTO } from "../../setup-bun";
import { KeystoreService } from "../../../src/services/keystoreService";
import { SessionManager } from "../../../src/entrypoints/background/sessionManager";
import { deriveAccountGroupKey } from "../../../src/utils/accountKey";

// Other test files mock.module() keystoreManager / messageHandlers'
// dependencies process-wide; load real, separate instances.
const realKeystoreManager = "../../../src/services/keystoreManager.ts?real";
const { KeystoreManager } = (await import(realKeystoreManager)) as typeof import("../../../src/services/keystoreManager");
mock.module("../../../src/services/keystoreManager", () => ({ KeystoreManager }));
const realHandlers = "../../../src/entrypoints/background/messageHandlers.ts?real";
const { PopupMessageHandler } = (await import(realHandlers)) as typeof import("../../../src/entrypoints/background/messageHandlers");

const FIXTURES = join(import.meta.dir, "../../fixtures/engine-share");
const FILE = readFileSync(join(FIXTURES, "engine-share-secp256k1.json"), "utf8");
const PASSWORD = JSON.parse(readFileSync(join(FIXTURES, "engine-share-secp256k1.expected.json"), "utf8")).password;

const savedCrypto = (globalThis as any).crypto;
beforeAll(async () => {
    await wasmInit();
});
beforeEach(async () => {
    (globalThis as any).crypto = REAL_WEBCRYPTO;
    await chrome.storage.local.clear();
    let session: Record<string, unknown> = {};
    (chrome.storage as any).session = {
        get: async () => session,
        set: async (items: Record<string, unknown>) => { session = { ...session, ...items }; },
        remove: async () => { session = {}; },
    };
    (KeystoreManager as any).instance = null;
    KeystoreService.resetInstance();
});
afterEach(() => {
    (KeystoreService as any).testMode = true;
    (globalThis as any).crypto = savedCrypto;
});

function background() {
    const announces: any[] = [];
    let state: any = { deviceId: "device-a", invites: [], sessionInfo: null, blockchain: "ethereum" };
    const stateManager: any = {
        getState: () => state,
        getChain: () => "ethereum",
        updateState: (patch: any) => { state = { ...state, ...patch }; },
        updateStateProperty: (k: string, v: any) => { state = { ...state, [k]: v }; },
        broadcastCurrentState: () => {},
        broadcastToPopupPorts: () => {},
    };
    const offscreen = {
        createOffscreenDocument: async () => ({ success: true }),
        sendToOffscreen: jest.fn(async (msg: any) => {
            if (msg.type === "deriveAccounts") {
                return { success: true, accounts: [{ account: 0, addresses: JSON.parse(derive_account_addresses(msg.curve, msg.groupPublicKey, 0)) }] };
            }
            if (msg.type === "ecdsaShareInfo") {
                return { success: true, info: JSON.parse(ecdsa_share_info(msg.shareJson)) };
            }
            if (msg.type === "deriveAccountGroupKey") {
                return { success: true, groupPublicKey: await deriveAccountGroupKey(msg.keyShare, msg) };
            }
            return { success: true };
        }),
    };
    const ws: any = {
        getReadyState: () => (WebSocket as any)?.OPEN,
        announceSession: (s: any) => announces.push(s),
    };
    const sessionManager = new SessionManager(stateManager, ws, () => {}, offscreen.sendToOffscreen as any);
    const handler = new PopupMessageHandler(stateManager, offscreen as any, {} as any, sessionManager, {} as any, {} as any);
    const send = (message: any) =>
        new Promise<any>((resolve) => (handler as any).handlePopupMessage(message, resolve));
    return { announces, send, handler };
}

describe("import an engine backup, then sign from the popup", () => {
    it("announces the wallet's whole cohort, sorted, with its threshold", async () => {
        const bg = background();
        const edFile = await encryptShareBackup(frostShare("ed25519", ["device-a","device-b","device-c"]), {id:"w-transfer",name:"Team"} as any, PASSWORD);
        const ecdsaFile = await encryptEcdsaShareBackup(
            ECDSA_WALLET.shares[0],
            JSON.parse(ecdsa_share_info(ECDSA_WALLET.shares[0])),
            { id: "w-transfer", deviceId: "device-a" },
            PASSWORD,
        );
        const imported = await new Promise<any>((resolve) =>
            (bg.handler as any).handleImportKeystoreMessage(
                { type: "importKeystore", keystoreFiles: [ecdsaFile, edFile, FILE], password: PASSWORD, chain: "ethereum" },
                resolve,
            ),
        );
        expect(imported).toMatchObject({ success: true, walletId: "w-transfer" });
        const restored = KeystoreManager.getInstance().getWallets().find((wallet) => wallet.id === "w-transfer")!;
        expect(restored.blockchain).toBe("ethereum");
        const account0 = JSON.parse(derive_account_addresses("secp256k1-ecdsa", ECDSA_WALLET.group_public_key, 0));
        expect(restored.address).toBe(account0.find((entry: any) => entry.chain === "Ethereum").address);
        expect(imported.address).toBe(restored.address);

        const signed = await new Promise<any>((resolve) =>
            (bg.handler as any).handleCreateSigningSessionRequest({ walletId: "w-transfer", message: "hello" }, resolve),
        );
        expect(signed.success).toBe(true);

        expect(bg.announces).toHaveLength(1);
        const info = bg.announces[0];
        expect(info.participants).toEqual(["device-a", "device-b", "device-c"]);
        expect([info.threshold, info.total]).toEqual([2, 3]);
        expect(info.wallet_name).toBe("w-transfer-ethereum-0");
        // Ethereum signs with the imported ECDSA key.
        expect(info.curve_type).toBe("secp256k1-ecdsa");
        expect(info.group_public_key).toBe(ECDSA_WALLET.group_public_key);

        await KeystoreManager.getInstance().lock();
        (KeystoreManager as any).instance = null;
        KeystoreService.resetInstance();
        // Exercise the real persisted-index read; resetInstance skips it by default.
        (KeystoreService as any).testMode = false;
        const reloaded = KeystoreManager.getInstance();
        await reloaded.initialize("device-a");
        expect(await reloaded.unlock(PASSWORD)).toBe(true);
        expect((await reloaded.getKeyShare("w-transfer", "ed25519"))?.curve).toBe("ed25519");
        expect((await reloaded.getKeyShare("w-transfer", "secp256k1"))?.curve).toBe("secp256k1");
        expect(await reloaded.getCurveShare("w-transfer", "secp256k1-ecdsa")).toBe(ECDSA_WALLET.shares[0]);
        expect(reloaded.getWallets().find((wallet) => wallet.id === "w-transfer")).toMatchObject({
            blockchain: "ethereum", address: restored.address,
        });
    }, 30000);

    it("restores all algorithms into a passwordless vault and unlocks them after cold restart", async () => {
        const assertion = {
            credentialId: Buffer.from('fixture-credential').toString('base64url'),
            prfSalt: Buffer.alloc(32, 1).toString('base64url'),
            prfOutput: Buffer.alloc(32, 2).toString('base64url'),
        };
        const manager = KeystoreManager.getInstance();
        await manager.initialize('device-a');
        await manager.createHardwareKeystore(assertion, 'device-a');
        const edShare = frostShare('ed25519',['device-a','device-b','device-c']);
        const edFile = await encryptShareBackup(edShare,{id:'w-transfer',name:'Team'} as any,PASSWORD);
        const ecdsaFile = await encryptEcdsaShareBackup(ECDSA_WALLET.shares[0],JSON.parse(ecdsa_share_info(ECDSA_WALLET.shares[0])),{id:'w-transfer',deviceId:'device-a'},PASSWORD);
        const bg = background();
        const restored = await new Promise<any>(resolve => (bg.handler as any).handleImportKeystoreMessage({type:'importKeystore',keystoreFiles:[FILE,edFile,ecdsaFile],password:PASSWORD},resolve));
        expect(restored.success).toBe(true);
        await manager.lock();
        (KeystoreManager as any).instance = null;
        KeystoreService.resetInstance();
        (KeystoreService as any).testMode = false;
        const cold = KeystoreManager.getInstance();
        await cold.initialize('device-a');
        expect(cold.isLocked()).toBe(true);
        await cold.unlockHardwareKeystore(assertion);
        expect(cold.isLocked()).toBe(false);
        expect((await cold.getKeyShare('w-transfer','ed25519'))?.key_package).toBe(edShare.key_package);
        expect((await cold.getKeyShare('w-transfer','secp256k1'))?.curve).toBe('secp256k1');
        expect(await cold.getCurveShare('w-transfer','secp256k1-ecdsa')).toBe(ECDSA_WALLET.shares[0]);
        expect(await cold.unlock(PASSWORD)).toBe(false);
    });

    it("rejects incomplete backup inventories without publishing any wallet", async () => {
        const bg = background();
        const imported = await new Promise<any>(resolve => (bg.handler as any).handleImportKeystoreMessage(
            {type:"importKeystore",keystoreFiles:[FILE],password:PASSWORD},resolve));
        expect(imported.success).toBe(false);
        expect(imported.error).toContain("three backup files");
        expect(KeystoreManager.getInstance().getWallets()).toHaveLength(0);
        expect(bg.announces).toHaveLength(0);
    });
});
