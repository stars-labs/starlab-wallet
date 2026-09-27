/**
 * Ext-2a/b regression tests for sessionManager.createSigningSession.
 *
 * The wire shape this emits must match TUI's
 * `parse_session_info` expectations for signing sessions
 * (command.rs:231 + the signing-specific top-level fields). If the
 * shape drifts, TUI can't decode the announcement and the signing
 * ceremony never starts cross-client. Engine proposers (TUI
 * command.rs StartSigning) announce the wallet's whole cohort as
 * `participants` — TUI/desktop co-signers only offer a signing whose
 * participants include them — and the ACCOUNT child's group key.
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
        sendSessionStatusUpdate: jest.fn(),
    };
    const broadcast = jest.fn();
    const sendToOffscreen = jest.fn(async (msg: any) =>
        msg.type === "deriveAccountGroupKey"
            ? { success: true, groupPublicKey: `child-of-${msg.keyShare.group_public_key}-${msg.chain}-${msg.account}` }
            : { success: true },
    );
    const stateManager = {
        getState: () => appState,
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
    return { mgr, appState, announces, broadcast, wsClient, sendToOffscreen };
}

const keyShare = () =>
    ({
        group_public_key: "02cafe",
        threshold: 2,
        total_participants: 3,
        // Stored order is not the wire order: the announce sorts.
        participants: ["tui", "ext-alice", "desktop"],
        participant_identifiers: { desktop: 1, "ext-alice": 2, tui: 3 },
        curve: "secp256k1",
    }) as any;

const validConfig = () => ({
    walletId: "wallet-xyz",
    walletName: "Treasury",
    blockchain: "ethereum" as const,
    keyShare: keyShare(),
    signingMessageHex: "deadbeef",
});

describe("SessionManager.createSigningSession", () => {
    let env: ReturnType<typeof makeSessionManager>;
    beforeEach(() => {
        env = makeSessionManager();
    });

    it("rejects non-hex signingMessageHex", async () => {
        const res = await env.mgr.createSigningSession({
            ...validConfig(),
            signingMessageHex: "not-hex!",
        });
        expect(res.success).toBe(false);
        expect(res.error).toContain("hex");
    });

    it("rejects a missing walletId", async () => {
        const r1 = await env.mgr.createSigningSession({
            ...validConfig(),
            walletId: "",
        });
        expect(r1.success).toBe(false);
    });

    it("refuses a wallet whose cohort doesn't include this device", async () => {
        const res = await env.mgr.createSigningSession({
            ...validConfig(),
            keyShare: { ...keyShare(), participants: ["tui", "desktop"], participant_identifiers: { desktop: 1, tui: 2 } },
        });
        expect(res.success).toBe(false);
        expect(env.announces).toHaveLength(0);
    });

    it("does not announce when the account key can't be derived", async () => {
        env.sendToOffscreen.mockImplementation(async () => ({ success: false, error: "locked" }) as any);
        const res = await env.mgr.createSigningSession(validConfig());
        expect(res.success).toBe(false);
        expect(env.announces).toHaveLength(0);
    });

    it("emits TUI-compatible signing announce_session payload", async () => {
        const res = await env.mgr.createSigningSession(validConfig());
        expect(res.success).toBe(true);
        expect(res.sessionId).toMatch(/^sign_/);
        expect(env.announces.length).toBe(1);

        const wire = env.announces[0];
        expect(wire.session_id).toBe(res.sessionId);
        expect(wire.session_type).toBe("signing");
        expect(wire.total).toBe(3);
        expect(wire.threshold).toBe(2);
        expect(wire.proposer_id).toBe("ext-alice");
        // The wallet's whole cohort, sorted (engine StartSigning).
        expect(wire.participants).toEqual(["desktop", "ext-alice", "tui"]);
        expect(wire.curve_type).toBe("secp256k1");
        expect(wire.coordination_type).toBe("Network");
        // Signing-specific sibling fields TUI reads at top level
        // (not nested under a content object).
        // CLI/TUI co-signers load (materializing if needed) the account-0
        // child wallet named here — the key the extension signs with too.
        expect(wire.wallet_name).toBe("wallet-xyz-ethereum-0");
        // The ACCOUNT child's key (what everyone signs under), not the root.
        expect(wire.group_public_key).toBe("child-of-02cafe-ethereum-0");
        expect(wire.blockchain).toBe("ethereum");
        expect(wire.signing_message_hex).toBe("deadbeef");
        // accepted_devices is extension-local — must NOT be on the wire.
        expect("accepted_devices" in wire).toBe(false);
    });

    it("starts our own signing ceremony right after announcing", async () => {
        // CLI/TUI co-signers start on the announce and never join the
        // session, so the proposer can't wait for joins; the server
        // doesn't echo our own announce back either.
        const res = await env.mgr.createSigningSession(validConfig());
        const msg = env.sendToOffscreen.mock.calls.map((c: any[]) => c[0]).find((m: any) => m.type !== "deriveAccountGroupKey");
        expect(msg.type).toBe("sessionReadyForSigning");
        expect(msg.sessionInfo.session_id).toBe(res.sessionId);
        expect(msg.sessionInfo.signing_message_hex).toBe("deadbeef");
        expect(msg.blockchain).toBe("ethereum");
    });

    it("maps ed25519 curve correctly on the wire", async () => {
        await env.mgr.createSigningSession({
            ...validConfig(),
            blockchain: "solana",
            keyShare: { ...keyShare(), curve: "ed25519" },
        });
        expect(env.announces[0].curve_type).toBe("ed25519");
        expect(env.announces[0].blockchain).toBe("solana");
    });

    it("stashes as active sessionInfo", async () => {
        await env.mgr.createSigningSession(validConfig());
        expect(env.appState.sessionInfo).not.toBeNull();
        expect(env.appState.sessionInfo!.session_type).toBe("signing");
    });

    it("leaves the wallet's dkgState alone", async () => {
        env.appState.dkgState = DkgState.Complete;
        await env.mgr.createSigningSession(validConfig());
        expect(env.appState.dkgState).toBe(DkgState.Complete);
    });

    it("notifies popup with signingSessionCreated event", async () => {
        await env.mgr.createSigningSession(validConfig());
        const calls = (env.broadcast as any).mock.calls as any[];
        const saw = calls.some(
            (c) => c[0]?.type === "signingSessionCreated",
        );
        expect(saw).toBe(true);
    });

    it("generates unique session ids across rapid calls", async () => {
        const ids = new Set<string>();
        for (let i = 0; i < 5; i++) {
            const r = await env.mgr.createSigningSession(validConfig());
            if (r.sessionId) ids.add(r.sessionId);
        }
        expect(ids.size).toBe(5);
    });

    it("rolls back state on wire-announce failure", async () => {
        env.wsClient.announceSession = jest.fn(() => {
            throw new Error("ws blew up");
        });
        const res = await env.mgr.createSigningSession(validConfig());
        expect(res.success).toBe(false);
        expect(env.appState.sessionInfo).toBeNull();
        expect(env.appState.dkgState).toBe(DkgState.Idle);
    });
});

describe("announce matches the engine's (TUI StartSigning) key set", () => {
    it("has exactly the engine's fields", async () => {
        const env = makeSessionManager();
        await env.mgr.createSigningSession(validConfig());
        // apps/tui/src/elm/command.rs StartSigning session_info json!.
        expect(Object.keys(env.announces[0]).sort()).toEqual(
            [
                "session_id", "total", "threshold", "session_type", "proposer_id", "participants",
                "curve_type", "coordination_type", "wallet_name", "group_public_key", "blockchain",
                "signing_message_hex",
            ].sort(),
        );
    });
});
