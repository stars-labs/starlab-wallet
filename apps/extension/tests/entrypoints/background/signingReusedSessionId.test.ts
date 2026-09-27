/**
 * TUI warm signing REUSES the DKG's session id for the signing session.
 * Seen live (TUI proposer + extension + desktop, 2-of-3): after the DKG
 * with session X completed, the TUI announced signing session X and sent
 * SIGN_COMMIT (the offscreen buffers it). The extension joined, but never
 * started its signing ceremony: the ceremony trigger was deduped by
 * session id alone, and X had already fired the DKG trigger.
 *
 * Also: a finished DKG must not linger as an "Accept & join" invite.
 */
import { describe, it, expect, jest } from "bun:test";
import { WebSocketManager } from "../../../src/entrypoints/background/webSocketManager";
import { SessionManager } from "../../../src/entrypoints/background/sessionManager";
import { StateManager } from "../../../src/entrypoints/background/stateManager";
import { DkgState } from "@stars-labs/types/dkg";

const ME = "ext-a";
const X = "eb213d0a-211b-45c0-8f0e-208d03f2a27e";
const COHORT = ["desktop", ME, "tui"];

function wire(extra: Record<string, unknown>) {
    return {
        type: "session_available",
        session_info: {
            session_id: X,
            proposer_id: "tui",
            total: 3,
            threshold: 2,
            coordination_type: "Network",
            curve_type: "secp256k1",
            ...extra,
        },
    };
}

const dkgAnnounce = (participants: string[]) =>
    wire({ session_type: "dkg", participants });

const signingAnnounce = () =>
    wire({
        session_type: "signing",
        participants: COHORT,
        wallet_name: "w-account-0",
        group_public_key: "0372363713",
        blockchain: "ethereum",
        signing_message_hex: "68656c6c6f",
    });

async function setup() {
    const stateManager = new StateManager({ deviceId: ME, dkgState: DkgState.Idle });
    await new Promise((r) => setTimeout(r, 0));
    const sent: any[] = [];
    const sendToOffscreen = jest.fn(async (msg: any) => {
        sent.push(msg);
        return { success: true };
    });
    const wsClient: any = {
        getReadyState: jest.fn(() => (WebSocket as any)?.OPEN),
        sendSessionStatusUpdate: jest.fn(),
    };
    const sessionManager = new SessionManager(
        stateManager,
        wsClient,
        jest.fn() as any,
        sendToOffscreen as any,
    );
    const wsm = new WebSocketManager(
        stateManager.getState(),
        sessionManager,
        jest.fn() as any,
        sendToOffscreen as any,
        stateManager,
    );
    const receive = (frame: any) => (wsm as any).handleWebSocketMessage(frame);
    return { stateManager, sessionManager, receive, sent };
}

/** Joins DKG session X and runs it to completion. */
async function completeDkg(env: Awaited<ReturnType<typeof setup>>) {
    env.receive(dkgAnnounce(["tui"]));
    expect((await env.sessionManager.joinDkgSession(X)).success).toBe(true);
    env.receive(dkgAnnounce(COHORT));
    env.stateManager.handleOffscreenStateUpdate({
        type: "dkgStateUpdate",
        state: DkgState.Complete,
    } as any);
    env.stateManager.handleOffscreenStateUpdate({
        type: "dkgComplete",
        sessionId: X,
        groupPublicKey: "0372363713",
        threshold: 2,
        total: 3,
        participants: COHORT,
    } as any);
}

const types = (sent: any[]) => sent.map((m) => m.type);

describe("co-signing a TUI session that reuses the DKG session id", () => {
    it("does not start signing before the user joins", async () => {
        const env = await setup();
        await completeDkg(env);

        env.receive(signingAnnounce());

        expect(types(env.sent)).toEqual(["sessionAllAccepted"]);
    });

    it("starts the signing ceremony once the user joins", async () => {
        const env = await setup();
        await completeDkg(env);
        env.receive(signingAnnounce());

        expect((await env.sessionManager.joinDkgSession(X)).success).toBe(true);
        env.receive(signingAnnounce()); // server re-broadcast after our join

        expect(types(env.sent)).toEqual(["sessionAllAccepted", "sessionReadyForSigning"]);
        expect(env.sent[1].sessionInfo.session_id).toBe(X);
    });

    it("starts the signing ceremony only once", async () => {
        const env = await setup();
        await completeDkg(env);
        env.receive(signingAnnounce());
        await env.sessionManager.joinDkgSession(X);

        env.receive(signingAnnounce());
        env.receive(signingAnnounce());

        expect(types(env.sent).filter((t) => t === "sessionReadyForSigning")).toHaveLength(1);
    });
});

describe("joining a signing session", () => {
    it("keeps the wallet ready (dkgState stays Complete)", async () => {
        const env = await setup();
        await completeDkg(env);
        env.receive(signingAnnounce());

        await env.sessionManager.joinDkgSession(X);

        expect(env.stateManager.getState().dkgState).toBe(DkgState.Complete);
    });

    it("keeps the wallet ready after the signature completes", async () => {
        const env = await setup();
        await completeDkg(env);
        env.receive(signingAnnounce());
        await env.sessionManager.joinDkgSession(X);

        env.stateManager.handleOffscreenStateUpdate({
            type: "signingComplete",
            sessionId: X,
            signingId: `sign_${X}`,
            signature: "aa",
        } as any);

        expect(env.stateManager.getState().dkgState).toBe(DkgState.Complete);
        expect(env.stateManager.getState().sessionInfo).toBeNull();
    });
});

describe("a finished DKG", () => {
    it("is no longer offered as an invite", async () => {
        const env = await setup();
        await completeDkg(env);

        expect(env.stateManager.getState().invites.map((s) => s.session_id)).not.toContain(X);
    });

    it("is not re-added when the server re-announces it", async () => {
        const env = await setup();
        await completeDkg(env);

        env.receive(dkgAnnounce(COHORT));

        expect(env.stateManager.getState().invites.map((s) => s.session_id)).not.toContain(X);
    });
});

describe("a signing session re-announced with a new message", () => {
    const reannounce = (hex: string) => {
        const f = signingAnnounce();
        (f.session_info as any).signing_message_hex = hex;
        return f;
    };

    it("does not start the new request before the user joins it", async () => {
        const env = await setup();
        await completeDkg(env);
        env.receive(signingAnnounce());
        await env.sessionManager.joinDkgSession(X);
        env.receive(signingAnnounce());

        env.receive(reannounce("aa".repeat(32)));

        expect(types(env.sent).filter((t) => t === "sessionReadyForSigning")).toHaveLength(1);
    });

    it("starts the new request once the user joins it", async () => {
        const env = await setup();
        await completeDkg(env);
        env.receive(signingAnnounce());
        await env.sessionManager.joinDkgSession(X);
        env.receive(signingAnnounce());
        env.stateManager.handleOffscreenStateUpdate({
            type: "signingError",
            signingId: `sign_${X}`,
            sessionId: X,
            error: "aggregate failed",
        } as any);

        env.receive(reannounce("aa".repeat(32)));
        await env.sessionManager.joinDkgSession(X);
        env.receive(reannounce("aa".repeat(32)));

        const starts = env.sent.filter((m) => m.type === "sessionReadyForSigning");
        expect(starts.map((m) => m.sessionInfo.signing_message_hex)).toEqual(["68656c6c6f", "aa".repeat(32)]);
    });
});

describe("a failed signing ceremony", () => {
    it("clears the active session but keeps the wallet ready", async () => {
        const env = await setup();
        await completeDkg(env);
        env.receive(signingAnnounce());
        await env.sessionManager.joinDkgSession(X);

        env.stateManager.handleOffscreenStateUpdate({
            type: "signingError",
            signingId: `sign_${X}`,
            sessionId: X,
            error: "aggregate failed",
        } as any);

        const state: any = env.stateManager.getState();
        expect(state.sessionInfo).toBeNull();
        expect(state.signingProgress).toBeNull();
        expect(state.dkgState).toBe(DkgState.Complete);
    });
});

describe("a finished signing request", () => {
    for (const outcome of ["signingComplete", "signingError"] as const) {
        it(`is dropped from invites after ${outcome}, and its re-announces are ignored`, async () => {
            const env = await setup();
            await completeDkg(env);
            env.receive(signingAnnounce());
            await env.sessionManager.joinDkgSession(X);

            env.stateManager.handleOffscreenStateUpdate({
                type: outcome,
                signingId: `sign_${X}`,
                sessionId: X,
                signature: "aa",
                error: "x",
            } as any);
            env.receive(signingAnnounce()); // the server keeps announcing it

            expect(env.stateManager.getState().invites.map((s) => s.session_id)).not.toContain(X);
        });
    }
});
