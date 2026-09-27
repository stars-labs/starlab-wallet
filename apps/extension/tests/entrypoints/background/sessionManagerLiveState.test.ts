/**
 * SessionManager must read the StateManager's CURRENT state.
 *
 * StateManager.updateState() replaces its appState object on every
 * patch. SessionManager used to keep the object it was constructed
 * with, so once the background reset state (a stale invite removed, a
 * session cancelled) every later "Accept & join" looked up the invite
 * in an outdated copy and failed with "No known invite" until the
 * service worker restarted.
 */
import { describe, it, expect, jest } from "bun:test";
import { SessionManager } from "../../../src/entrypoints/background/sessionManager";
import { StateManager } from "../../../src/entrypoints/background/stateManager";
import { DkgState } from "@stars-labs/types/dkg";
import type { SessionInfo } from "@stars-labs/types/session";

function invite(id: string): SessionInfo {
    return {
        session_id: id,
        proposer_id: "tui-alice",
        total: 3,
        threshold: 2,
        participants: ["tui-alice"],
        session_type: "dkg",
        curve_type: "secp256k1",
        coordination_type: "Network",
        accepted_devices: [],
    };
}

async function setup() {
    const stateManager = new StateManager({ deviceId: "ext-bob", dkgState: DkgState.Idle });
    // Let the async persisted-state load finish before patching.
    await new Promise((r) => setTimeout(r, 0));
    const wsClient: any = {
        getReadyState: jest.fn(() => (WebSocket as any)?.OPEN),
        sendSessionStatusUpdate: jest.fn(),
        relayMessage: jest.fn(async () => {}),
    };
    const mgr = new SessionManager(
        stateManager,
        wsClient,
        jest.fn() as any,
        jest.fn(async () => ({ success: true })) as any,
    );
    return { mgr, stateManager, wsClient };
}

describe("SessionManager reads live StateManager state", () => {
    it("joins an invite that arrived after the background reset its state", async () => {
        const { mgr, stateManager, wsClient } = await setup();
        stateManager.updateInvites([invite("dkg_stale")]);
        // Background drops the stale invite (replaces its appState object).
        stateManager.updateState({ invites: [], sessionInfo: null });
        stateManager.updateInvites([invite("dkg_fresh")]);

        const res = await mgr.joinDkgSession("dkg_fresh");

        expect(res.success).toBe(true);
        expect(wsClient.sendSessionStatusUpdate).toHaveBeenCalledWith("dkg_fresh", "ext-bob");
    });

    it("writes the joined session into the StateManager", async () => {
        const { mgr, stateManager } = await setup();
        stateManager.updateState({ invites: [] });
        stateManager.updateInvites([invite("dkg_fresh")]);

        await mgr.joinDkgSession("dkg_fresh");

        expect(stateManager.getState().sessionInfo?.session_id).toBe("dkg_fresh");
    });

    it("accepts a proposal invite added after a reset", async () => {
        const { mgr, stateManager } = await setup();
        stateManager.updateState({ invites: [], sessionInfo: null });
        stateManager.updateInvites([invite("prop_fresh")]);

        const res = await mgr.acceptSession("prop_fresh");

        expect(res.success).toBe(true);
    });
});
