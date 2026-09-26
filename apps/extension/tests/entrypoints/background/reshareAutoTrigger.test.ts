/**
 * M3 reshare (#23): auto-trigger gating for reshare sessions.
 *
 * A reshare needs the FULL new cohort (joined === total) — every
 * remaining shareholder must both contribute round packages and
 * receive a fresh share; threshold-joined (the signing gate) is NOT
 * enough. The trigger must dispatch `sessionReadyForReshare` with
 * the wallet id — never `sessionAllAccepted` (the DKG path; firing
 * that would start a fresh DKG and orphan the wallet's group key).
 */
import { describe, it, expect, beforeEach, jest } from "bun:test";
import { WebSocketManager } from "../../../src/entrypoints/background/webSocketManager";
import { DkgState } from "@stars-labs/types/dkg";
import { MeshStatusType } from "@stars-labs/types/mesh";
import type { AppState } from "@stars-labs/types/appstate";
import type { SessionInfo } from "@stars-labs/types/session";

function makeManager(opts?: { deviceId?: string; sessionInfo?: SessionInfo | null }) {
    const appState: AppState = {
        deviceId: opts?.deviceId ?? "ext-bob",
        connecteddevices: [],
        wsConnected: true,
        sessionInfo: opts?.sessionInfo ?? null,
        invites: [],
        meshStatus: { type: MeshStatusType.Incomplete },
        dkgState: DkgState.Idle,
        webrtcConnections: {},
        blockchain: "ethereum",
        totalParticipants: 3,
        threshold: 2,
    };
    const broadcast = jest.fn();
    const sentToOffscreen: Array<{ msg: any; desc: string }> = [];
    const sendToOffscreen = jest.fn(async (msg: any, desc: string) => {
        sentToOffscreen.push({ msg, desc });
        return { success: true };
    });
    const stateManager = {
        getState: () => appState,
        updateInvites: jest.fn((inv: any[]) => {
            appState.invites = inv;
        }),
    };
    const mgr = new WebSocketManager(
        appState,
        {} as any,
        broadcast as any,
        sendToOffscreen as any,
        stateManager as any,
    );
    return { mgr, appState, sentToOffscreen };
}

function reshareSession(
    sessionId: string,
    participants: string[],
    threshold = 2,
    total = 3,
): SessionInfo {
    return {
        session_id: sessionId,
        proposer_id: "ext-bob",
        total,
        threshold,
        participants,
        session_type: "reshare",
        curve_type: "secp256k1",
        coordination_type: "Network",
        accepted_devices: [],
        wallet_name: "wallet-xyz",
        group_public_key: "02cafe",
        blockchain: "ethereum",
        reshare_old_participants: ["ext-bob", "peer-1", "peer-2"],
    };
}

function frame(session: SessionInfo) {
    const { accepted_devices: _a, status: _s, ...wire } = session as any;
    return { type: "session_available" as const, session_info: wire };
}

describe("WebSocketManager: reshare auto-trigger", () => {
    let env: ReturnType<typeof makeManager>;

    beforeEach(() => {
        env = makeManager();
    });

    it("does NOT fire at threshold — reshare needs the full cohort", () => {
        const seed = reshareSession("reshare_x", ["ext-bob"]);
        env.appState.sessionInfo = seed;
        (env.mgr as any).handleWebSocketMessage(
            frame(reshareSession("reshare_x", ["ext-bob", "peer-1"])),
        );
        expect(env.sentToOffscreen.length).toBe(0);
    });

    it("fires sessionReadyForReshare once when all N joined", () => {
        const seed = reshareSession("reshare_x", ["ext-bob"]);
        env.appState.sessionInfo = seed;
        const full = reshareSession("reshare_x", ["ext-bob", "peer-1", "peer-2"]);
        (env.mgr as any).handleWebSocketMessage(frame(full));

        expect(env.sentToOffscreen.length).toBe(1);
        const { msg } = env.sentToOffscreen[0];
        expect(msg.type).toBe("sessionReadyForReshare");
        expect(msg.walletId).toBe("wallet-xyz");
        expect(msg.blockchain).toBe("ethereum");
        expect(msg.sessionInfo.session_id).toBe("reshare_x");
        // accepted_devices synthesized from participants for the
        // offscreen mesh-readiness checks.
        expect(msg.sessionInfo.accepted_devices).toEqual([
            "ext-bob",
            "peer-1",
            "peer-2",
        ]);
        // reshare_old_participants survives the wire round-trip.
        expect(msg.sessionInfo.reshare_old_participants).toEqual([
            "ext-bob",
            "peer-1",
            "peer-2",
        ]);

        // Re-broadcast must not double-fire.
        (env.mgr as any).handleWebSocketMessage(frame(full));
        expect(env.sentToOffscreen.length).toBe(1);
    });

    it("never fires the DKG trigger for a reshare session", () => {
        const seed = reshareSession("reshare_x", ["ext-bob"]);
        env.appState.sessionInfo = seed;
        (env.mgr as any).handleWebSocketMessage(
            frame(reshareSession("reshare_x", ["ext-bob", "peer-1", "peer-2"])),
        );
        const types = env.sentToOffscreen.map((s) => s.msg.type);
        expect(types).not.toContain("sessionAllAccepted");
        expect(types).not.toContain("sessionReadyForSigning");
    });

    it("ignores reshare sessions that are not ours", () => {
        env.appState.sessionInfo = null;
        (env.mgr as any).handleWebSocketMessage(
            frame(reshareSession("reshare_other", ["ext-bob", "peer-1", "peer-2"])),
        );
        expect(env.sentToOffscreen.length).toBe(0);
    });
});
