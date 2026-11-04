import { expect, it, jest } from "bun:test";
import type { AppState } from "@stars-labs/types/appstate";
import type { SessionInfo } from "@stars-labs/types/session";
import { SessionManager } from "../../../src/entrypoints/background/sessionManager";

function setup(sessionType: "dkg" | "reshare", curve: string) {
    const invite: SessionInfo = {
        session_id: "refresh-test",
        session_type: sessionType,
        curve_type: curve,
        proposer_id: "native",
        participants: ["native"],
        accepted_devices: [],
        threshold: 2,
        total: 2,
        wallet_name: "wallet-root",
        blockchain: curve === "ed25519" ? "solana" : "bitcoin",
    };
    const state = {
        deviceId: "extension",
        invites: [invite],
        sessionInfo: null,
        chain: "solana",
    } as unknown as AppState;
    const update = jest.fn((patch: Partial<AppState>) => Object.assign(state, patch));
    const offscreen = jest.fn(async () => ({ success: true }));
    const socket = {
        getReadyState: () => WebSocket.OPEN,
        relayMessage: jest.fn(async () => {}),
        sendSessionStatusUpdate: jest.fn(),
    };
    const manager = new SessionManager(
        { getState: () => state, updateState: update, updateStateProperty: jest.fn() },
        socket as unknown as ConstructorParameters<typeof SessionManager>[1],
        jest.fn(),
        offscreen,
    );
    return { manager, state, update, offscreen, socket };
}

for (const method of ["acceptSession", "joinDkgSession"] as const) {
    for (const curve of ["secp256k1", "ed25519", "secp256k1-ecdsa", "unified"]) {
        it(`${method}: permits only concrete FROST refresh (${curve})`, async () => {
            const { manager, state, update, offscreen, socket } = setup("reshare", curve);
            const result = await manager[method]("refresh-test");
            const allowed = curve === "secp256k1" || curve === "ed25519";

            expect(result.success).toBe(allowed);
            if (allowed) {
                expect(state.sessionInfo?.curve_type).toBe(curve);
                expect(state.blockchain).toBe(curve === "ed25519" ? "solana" : "ethereum");
            } else {
                expect(update).not.toHaveBeenCalled();
                expect(offscreen).not.toHaveBeenCalled();
                expect(socket.sendSessionStatusUpdate).not.toHaveBeenCalled();
            }
        });
    }

    for (const curve of ["ed25519", "secp256k1", "secp256k1-ecdsa"]) {
        it(`${method}: rejects single-algorithm DKG (${curve}) without side effects`, async () => {
            const { manager, state, update, offscreen, socket } = setup("dkg", curve);
            const result = await manager[method]("refresh-test");

            expect(result.success).toBe(false);
            expect(state.sessionInfo).toBeNull();
            expect(state.invites).toHaveLength(1);
            expect(update).not.toHaveBeenCalled();
            expect(offscreen).not.toHaveBeenCalled();
            expect(socket.relayMessage).not.toHaveBeenCalled();
            expect(socket.sendSessionStatusUpdate).not.toHaveBeenCalled();
        });
    }
}
