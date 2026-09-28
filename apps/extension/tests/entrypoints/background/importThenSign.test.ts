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

import wasmInit, { derive_account_addresses } from "@stars-labs/core-wasm";
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
    (globalThis as any).crypto = savedCrypto;
});

function background() {
    const announces: any[] = [];
    let state: any = { deviceId: "device-a", invites: [], sessionInfo: null, blockchain: "ethereum" };
    const stateManager: any = {
        getState: () => state,
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
        const imported = await new Promise<any>((resolve) =>
            (bg.handler as any).handleImportKeystoreMessage(
                { type: "importKeystore", keystoreData: FILE, password: PASSWORD, chain: "ethereum" },
                resolve,
            ),
        );
        expect(imported).toMatchObject({ success: true, walletId: "w-transfer" });

        const signed = await new Promise<any>((resolve) =>
            (bg.handler as any).handleCreateSigningSessionRequest({ walletId: "w-transfer", message: "hello" }, resolve),
        );
        expect(signed.success).toBe(true);

        expect(bg.announces).toHaveLength(1);
        const info = bg.announces[0];
        expect(info.participants).toEqual(["device-a", "device-b", "device-c"]);
        expect([info.threshold, info.total]).toEqual([2, 3]);
        expect(info.wallet_name).toBe("w-transfer-ethereum-0");
    }, 30000);
});
