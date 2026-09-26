/**
 * M3 reshare (#23): PopupMessageHandler reshare-related handlers and
 * StateManager's reshareComplete save path.
 *
 * KeystoreManager is a singleton with a chrome.storage-touching
 * constructor; tests stub it by planting a fake on the private
 * static `instance` slot before the handlers' dynamic import runs.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import { PopupMessageHandler } from "../../../src/entrypoints/background/messageHandlers";
import { StateManager } from "../../../src/entrypoints/background/stateManager";
import { KeystoreManager } from "../../../src/services/keystoreManager";

function plantKeystoreStub(overrides: Partial<Record<string, any>> = {}) {
    const stub: any = {
        isLocked: jest.fn(() => false),
        getKeyShare: jest.fn(async (_id: string) => ({
            key_package: "kp-old",
            group_public_key: "02cafe",
            session_id: "wallet-xyz",
            device_id: "ext-alice",
            participant_index: 1,
            threshold: 2,
            total_participants: 3,
            participants: ["ext-carol", "ext-alice", "ext-bob"],
            curve: "secp256k1",
        })),
        getWallets: jest.fn(() => [
            { id: "wallet-xyz", name: "Treasury", blockchain: "ethereum", address: "0xabc" },
        ]),
        updateWalletKeyShare: jest.fn(async () => true),
        ...overrides,
    };
    (KeystoreManager as any).instance = stub;
    return stub;
}

function makeHandler() {
    const stateManager: any = {
        getState: () => ({ deviceId: "ext-alice", invites: [] }),
        updateState: jest.fn(),
        updateStateProperty: jest.fn(),
        getInvites: () => [],
        getSessionInfo: () => null,
    };
    const created: any[] = [];
    const sessionManager: any = {
        createReshareSession: jest.fn(async (cfg: any) => {
            created.push(cfg);
            return { success: true, sessionId: "reshare_abc" };
        }),
    };
    const handler = new PopupMessageHandler(
        stateManager,
        {} as any, // offscreenManager
        {} as any, // webSocketManager
        sessionManager,
        {} as any, // rpcHandler
        {} as any, // uiRequestHandler
    );
    return { handler, sessionManager, created };
}

function call(handler: PopupMessageHandler, message: any): Promise<any> {
    return new Promise((resolve) => {
        void handler.handlePopupMessage(message, resolve);
    });
}

afterEach(() => {
    (KeystoreManager as any).instance = undefined;
});

describe("PopupMessageHandler: createReshareSession", () => {
    let env: ReturnType<typeof makeHandler>;
    beforeEach(() => {
        env = makeHandler();
    });

    it("derives cohort params from the stored key share (rotation)", async () => {
        plantKeystoreStub();
        const res = await call(env.handler, {
            type: "createReshareSession",
            walletId: "wallet-xyz",
        });
        expect(res.success).toBe(true);
        expect(env.created.length).toBe(1);
        const cfg = env.created[0];
        expect(cfg.walletId).toBe("wallet-xyz");
        expect(cfg.groupPublicKey).toBe("02cafe");
        expect(cfg.blockchain).toBe("ethereum");
        // sorted old cohort, full rotation keeps everyone
        expect(cfg.oldParticipants).toEqual(["ext-alice", "ext-bob", "ext-carol"]);
        expect(cfg.newParticipants).toEqual(["ext-alice", "ext-bob", "ext-carol"]);
        expect(cfg.newThreshold).toBe(2);
    });

    it("replace-device: removes the named device and clamps threshold", async () => {
        plantKeystoreStub();
        const res = await call(env.handler, {
            type: "createReshareSession",
            walletId: "wallet-xyz",
            removeDeviceIds: ["ext-bob"],
        });
        expect(res.success).toBe(true);
        const cfg = env.created[0];
        expect(cfg.newParticipants).toEqual(["ext-alice", "ext-carol"]);
        expect(cfg.newThreshold).toBe(2); // min(old t=2, 2 remaining)
    });

    it("rejects removing this device", async () => {
        plantKeystoreStub();
        const res = await call(env.handler, {
            type: "createReshareSession",
            walletId: "wallet-xyz",
            removeDeviceIds: ["ext-alice"],
        });
        expect(res.success).toBe(false);
        expect(env.created.length).toBe(0);
    });

    it("rejects when the keystore is locked", async () => {
        plantKeystoreStub({ isLocked: jest.fn(() => true) });
        const res = await call(env.handler, {
            type: "createReshareSession",
            walletId: "wallet-xyz",
        });
        expect(res.success).toBe(false);
        expect(res.error).toContain("locked");
    });

    it("rejects wallets that don't carry the full cohort (CLI imports)", async () => {
        plantKeystoreStub({
            getKeyShare: jest.fn(async () => ({
                key_package: "kp",
                group_public_key: "02cafe",
                participants: ["ext-alice"], // import only knows itself
                threshold: 2,
                total_participants: 3,
                curve: "secp256k1",
            })),
        });
        const res = await call(env.handler, {
            type: "createReshareSession",
            walletId: "wallet-xyz",
        });
        expect(res.success).toBe(false);
        expect(res.error).toContain("cohort");
    });
});

describe("PopupMessageHandler: getWalletCohort / getWalletKeystore", () => {
    let env: ReturnType<typeof makeHandler>;
    beforeEach(() => {
        env = makeHandler();
    });

    it("returns the sorted cohort view", async () => {
        plantKeystoreStub();
        const res = await call(env.handler, {
            type: "getWalletCohort",
            walletId: "wallet-xyz",
        });
        expect(res.success).toBe(true);
        expect(res.cohort.threshold).toBe(2);
        expect(res.cohort.total).toBe(3);
        expect(res.cohort.participants).toEqual(["ext-alice", "ext-bob", "ext-carol"]);
        expect(res.cohort.deviceId).toBe("ext-alice");
    });

    it("getWalletKeystore returns the decrypted share when unlocked", async () => {
        plantKeystoreStub();
        const res = await call(env.handler, {
            type: "getWalletKeystore",
            walletId: "wallet-xyz",
        });
        expect(res.success).toBe(true);
        expect(res.keyShare.key_package).toBe("kp-old");
    });

    it("getWalletKeystore refuses when locked", async () => {
        plantKeystoreStub({ isLocked: jest.fn(() => true) });
        const res = await call(env.handler, {
            type: "getWalletKeystore",
            walletId: "wallet-xyz",
        });
        expect(res.success).toBe(false);
    });
});

describe("StateManager: reshareComplete persists the new share", () => {
    function makeStateManager() {
        return new StateManager({ deviceId: "ext-alice" } as any);
    }

    const completePayload = {
        type: "reshareComplete",
        sessionId: "reshare_abc",
        walletId: "wallet-xyz",
        newKeystoreJson: JSON.stringify({
            key_package: "kp-NEW",
            public_key_package: "pkp-NEW",
            min_signers: 2,
            max_signers: 2,
            participant_index: 1,
            participant_indices: [1, 3],
            curve: "secp256k1",
        }),
        groupPublicKey: "02cafe",
        threshold: 2,
        total: 2,
        participants: ["ext-alice", "ext-carol"],
        participantIdentifiers: { "ext-alice": 1, "ext-carol": 3 },
        blockchain: "ethereum" as const,
    };

    it("replaces the wallet's key share and broadcasts reshareCompleted", async () => {
        const stub = plantKeystoreStub();
        const mgr = makeStateManager();
        const broadcasts: any[] = [];
        (mgr as any).broadcastToPopupPorts = (m: any) => broadcasts.push(m);

        mgr.handleOffscreenStateUpdate(completePayload as any);
        // handleReshareComplete is async fire-and-forget; drain.
        await new Promise((r) => setTimeout(r, 10));

        expect(stub.updateWalletKeyShare).toHaveBeenCalledTimes(1);
        const [walletId, newShare] = stub.updateWalletKeyShare.mock.calls[0];
        expect(walletId).toBe("wallet-xyz");
        expect(newShare.key_package).toBe("kp-NEW");
        expect(newShare.threshold).toBe(2);
        expect(newShare.total_participants).toBe(2);
        expect(newShare.participants).toEqual(["ext-alice", "ext-carol"]);
        // Canonical shape: hex group key, engine public_key_package in
        // its own field, gapped FROST ids kept explicitly.
        expect(newShare.group_public_key).toBe("02cafe");
        expect(newShare.public_key_package).toBe("pkp-NEW");
        expect(newShare.participant_identifiers).toEqual({ "ext-alice": 1, "ext-carol": 3 });

        const done = broadcasts.find((b) => b.type === "reshareCompleted");
        expect(done).toBeDefined();
        expect(done.saved).toBe(true);

        const status = (mgr.getState() as any).reshareStatus;
        expect(status.state).toBe("Complete");
        expect(status.saved).toBe(true);
    });

    it("refuses to save when the identifier map disagrees with the engine keystore", async () => {
        const stub = plantKeystoreStub();
        const mgr = makeStateManager();
        const broadcasts: any[] = [];
        (mgr as any).broadcastToPopupPorts = (m: any) => broadcasts.push(m);

        mgr.handleOffscreenStateUpdate({
            ...completePayload,
            // Position-derived ids — wrong for the {1,3} cohort.
            participantIdentifiers: { "ext-alice": 1, "ext-carol": 2 },
        } as any);
        await new Promise((r) => setTimeout(r, 10));

        expect(stub.updateWalletKeyShare).not.toHaveBeenCalled();
        const done = broadcasts.find((b) => b.type === "reshareCompleted");
        expect(done.saved).toBe(false);
        expect(String(done.error)).toContain("participant_indices");
    });

    it("reports saved:false when the keystore locked mid-ceremony", async () => {
        plantKeystoreStub({ isLocked: jest.fn(() => true) });
        const mgr = makeStateManager();
        const broadcasts: any[] = [];
        (mgr as any).broadcastToPopupPorts = (m: any) => broadcasts.push(m);

        mgr.handleOffscreenStateUpdate(completePayload as any);
        await new Promise((r) => setTimeout(r, 10));

        const done = broadcasts.find((b) => b.type === "reshareCompleted");
        expect(done.saved).toBe(false);
        expect(String(done.error)).toContain("locked");
        const status = (mgr.getState() as any).reshareStatus;
        expect(status.state).toBe("Failed");
    });

    it("stashes reshareStateUpdate progress for popup polling", () => {
        plantKeystoreStub();
        const mgr = makeStateManager();
        (mgr as any).broadcastToPopupPorts = () => {};
        mgr.handleOffscreenStateUpdate({
            type: "reshareStateUpdate",
            sessionId: "reshare_abc",
            walletId: "wallet-xyz",
            state: "Round1InProgress",
            round1Received: ["ext-alice"],
            round2Received: [],
            participants: ["ext-alice", "ext-bob", "ext-carol"],
        } as any);
        const status = (mgr.getState() as any).reshareStatus;
        expect(status.state).toBe("Round1InProgress");
        expect(status.round1Received).toEqual(["ext-alice"]);
    });
});
