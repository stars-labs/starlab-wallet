/**
 * M3 reshare (#23): sessionManager.createReshareSession wire-shape
 * and validation tests. Mirror of createSigningSession.test.ts —
 * the announce payload carries session_type="reshare", the NEW
 * cohort's threshold/total, the wallet id under wallet_name, and
 * the OLD cohort under reshare_old_participants (so every joiner
 * derives identical FROST identifiers).
 */
import { describe, it, expect, beforeEach, jest } from "bun:test";
import { SessionManager } from "../../../src/entrypoints/background/sessionManager";
import { DkgState } from "@stars-labs/types/dkg";
import { MeshStatusType } from "@stars-labs/types/mesh";
import type { AppState } from "@stars-labs/types/appstate";

function makeSessionManager() {
    const appState: AppState = {
        deviceId: "ext-alice",
        connecteddevices: [],
        wsConnected: true,
        sessionInfo: null,
        invites: [],
        meshStatus: { type: MeshStatusType.Incomplete },
        dkgState: DkgState.Idle,
        webrtcConnections: {},
        blockchain: "ethereum",
        totalParticipants: 3,
        threshold: 2,
    };
    const announces: Array<Record<string, unknown>> = [];
    const openSentinel = (WebSocket as any)?.OPEN;
    const wsClient: any = {
        getReadyState: jest.fn(() => openSentinel),
        announceSession: jest.fn((si: Record<string, unknown>) => {
            announces.push(si);
        }),
    };
    const broadcast = jest.fn();
    const sendToOffscreen = jest.fn(async () => ({ success: true }));
    const stateManager = {
        getState: () => appState,
        getChain: () => appState.chain ?? "ethereum",
        updateState: jest.fn((patch: Partial<AppState>) => {
            Object.assign(appState, patch);
        }),
    };
    const mgr = new SessionManager(
        stateManager as any,
        wsClient,
        broadcast as any,
        sendToOffscreen as any,
    );
    return { mgr, appState, announces, broadcast };
}

const validConfig = () => ({
    walletId: "wallet-xyz",
    walletName: "Treasury",
    groupPublicKey: "02cafe",
    blockchain: "ethereum" as const,
    newThreshold: 2,
    oldParticipants: ["ext-alice", "ext-bob", "ext-carol"],
    newParticipants: ["ext-alice", "ext-bob", "ext-carol"],
});

describe("SessionManager.createReshareSession", () => {
    let env: ReturnType<typeof makeSessionManager>;
    beforeEach(() => {
        env = makeSessionManager();
    });

    it("emits a reshare announce with old cohort + new params", async () => {
        const res = await env.mgr.createReshareSession(validConfig());
        expect(res.success).toBe(true);
        expect(res.sessionId).toMatch(/^reshare_/);
        expect(env.announces.length).toBe(1);

        const wire = env.announces[0];
        expect(wire.session_type).toBe("reshare");
        expect(wire.total).toBe(3);
        expect(wire.threshold).toBe(2);
        expect(wire.proposer_id).toBe("ext-alice");
        expect(wire.participants).toEqual(["ext-alice"]);
        expect(wire.curve_type).toBe("secp256k1");
        expect(wire.wallet_name).toBe("wallet-xyz");
        expect(wire.group_public_key).toBe("02cafe");
        expect(wire.blockchain).toBe("ethereum");
        expect(wire.reshare_old_participants).toEqual([
            "ext-alice",
            "ext-bob",
            "ext-carol",
        ]);
        // Extension-local fields must NOT leak onto the wire.
        expect("accepted_devices" in wire).toBe(false);
        // Signing-only field must NOT be present.
        expect("signing_message_hex" in wire).toBe(false);
    });

    it("replace-device: new cohort excludes the removed device", async () => {
        const res = await env.mgr.createReshareSession({
            ...validConfig(),
            newParticipants: ["ext-alice", "ext-carol"],
        });
        expect(res.success).toBe(true);
        const wire = env.announces[0];
        expect(wire.total).toBe(2);
        expect(wire.reshare_old_participants).toEqual([
            "ext-alice",
            "ext-bob",
            "ext-carol",
        ]);
    });

    it("rejects a new cohort member that holds no old share", async () => {
        const res = await env.mgr.createReshareSession({
            ...validConfig(),
            newParticipants: ["ext-alice", "ext-bob", "ext-mallory"],
        });
        expect(res.success).toBe(false);
        expect(res.error).toContain("ext-mallory");
        expect(env.announces.length).toBe(0);
    });

    it("rejects when this device is not in the new cohort", async () => {
        const res = await env.mgr.createReshareSession({
            ...validConfig(),
            newParticipants: ["ext-bob", "ext-carol"],
        });
        expect(res.success).toBe(false);
        expect(env.announces.length).toBe(0);
    });

    it("rejects an out-of-range threshold", async () => {
        const r1 = await env.mgr.createReshareSession({
            ...validConfig(),
            newThreshold: 0,
        });
        expect(r1.success).toBe(false);
        const r2 = await env.mgr.createReshareSession({
            ...validConfig(),
            newThreshold: 4,
        });
        expect(r2.success).toBe(false);
    });

    it("rejects when the wallet record lacks the full cohort", async () => {
        const res = await env.mgr.createReshareSession({
            ...validConfig(),
            oldParticipants: ["ext-alice"],
            newParticipants: ["ext-alice"],
        });
        expect(res.success).toBe(false);
        expect(res.error).toContain("cohort");
    });

    it("maps ed25519/solana to the right curve", async () => {
        const res = await env.mgr.createReshareSession({
            ...validConfig(),
            blockchain: "solana",
        });
        expect(res.success).toBe(true);
        expect(env.announces[0].curve_type).toBe("ed25519");
    });

    it("stashes the session as active state so the trigger gate matches", async () => {
        const res = await env.mgr.createReshareSession(validConfig());
        expect(env.appState.sessionInfo?.session_id).toBe(res.sessionId);
        expect(env.appState.sessionInfo?.session_type).toBe("reshare");
    });
});
