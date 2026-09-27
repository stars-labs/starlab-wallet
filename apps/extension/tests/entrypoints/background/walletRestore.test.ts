/**
 * Restoring a saved wallet on service-worker start (or unlock / wallet
 * switch) must bring the wallet back, not an active session. It used to
 * synthesize a "1 of 1" sessionInfo; the popup treats any sessionInfo as
 * a ceremony in progress, so Sign and incoming signing invites were
 * blocked until that phantom session went away.
 */
import { describe, it, expect, jest } from "bun:test";
import { restoreActiveWallet } from "../../../src/entrypoints/background/walletRestore";
import { StateManager } from "../../../src/entrypoints/background/stateManager";
import { DkgState } from "@stars-labs/types/dkg";

const WALLET = {
    id: "wallet-1",
    name: "Team wallet",
    blockchain: "ethereum",
    address: "0x1111111111111111111111111111111111111111",
    session_id: "dkg_abc",
    isActive: true,
    hasBackup: false,
};

const KEY_SHARE = {
    key_package: "SECRET",
    public_key_package: "pkp",
    group_public_key: "02abcdef",
    session_id: "dkg_abc",
    device_id: "ext-bob",
    participant_index: 2,
    threshold: 2,
    total_participants: 3,
    participants: ["cli-alice", "ext-bob", "tui-carol"],
    participant_identifiers: { "cli-alice": 1, "ext-bob": 2, "tui-carol": 3 },
    curve: "secp256k1",
    blockchains: [],
    created_at: 0,
};

function keystore(opts: { locked?: boolean } = {}) {
    return {
        initialize: jest.fn(async () => {}),
        isInitialized: jest.fn(async () => true),
        isLocked: jest.fn(() => opts.locked ?? false),
        getActiveWallet: jest.fn(() => WALLET),
        getKeyShare: jest.fn(async () => KEY_SHARE),
    } as any;
}

async function restored(ks = keystore()) {
    const stateManager = new StateManager({ deviceId: "ext-bob", dkgState: DkgState.Idle });
    await new Promise((r) => setTimeout(r, 0));
    await restoreActiveWallet(stateManager, ks);
    return stateManager.getState();
}

describe("restoreActiveWallet", () => {
    it("does not synthesize an active session", async () => {
        const state = await restored();
        expect(state.sessionInfo).toBeNull();
    });

    it("marks the wallet ready", async () => {
        const state = await restored();
        expect(state.dkgState).toBe(DkgState.Complete);
    });

    it("restores the address and group key", async () => {
        const state = await restored();
        expect(state.dkgAddress).toBe(WALLET.address);
        expect(state.dkgGroupPublicKey).toBe("02abcdef");
    });

    it("carries the wallet's real threshold and total from the key share", async () => {
        const state = await restored();
        expect(state.dkgLastResult?.threshold).toBe(2);
        expect(state.dkgLastResult?.total).toBe(3);
        expect(state.dkgLastResult?.participants).toEqual(KEY_SHARE.participants);
    });

    it("leaves state untouched while the keystore is locked", async () => {
        const state = await restored(keystore({ locked: true }));
        expect(state.dkgState).toBe(DkgState.Idle);
    });
});
