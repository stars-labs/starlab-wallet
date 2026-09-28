/**
 * A signing that failed or timed out in the offscreen: the router hands the
 * event to the StateManager, which frees the signing session (so "+ Sign"
 * and deferred invites work again), rejects a waiting dApp request and
 * shows the error.
 */
import { describe, it, expect, jest, mock } from "bun:test";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);
import { OffscreenMessageHandler } from "../../../src/entrypoints/background/messageHandlers";
import { StateManager } from "../../../src/entrypoints/background/stateManager";

const failure = { type: "signingError", signingId: "sign_s1", sessionId: "s1", error: "Signing timed out after 120s: no signature share from cli-b" };

describe("signingError from the offscreen", () => {
    it("is forwarded to the StateManager", async () => {
        const handleOffscreenStateUpdate = jest.fn();
        const handler = new OffscreenMessageHandler({ handleOffscreenStateUpdate } as any, {} as any);
        await handler.handleOffscreenMessage(failure as any);
        expect(handleOffscreenStateUpdate).toHaveBeenCalledWith(failure);
    });

    it("frees the signing session, rejects the dApp request and tells the popup", () => {
        const mgr = new StateManager({ deviceId: "ext-a" } as any);
        const broadcasts: any[] = [];
        (mgr as any).broadcastToPopupPorts = (m: any) => broadcasts.push(m);
        const handleSignatureError = jest.fn();
        (mgr as any).rpcHandler = { handleSignatureError };
        (mgr as any).appState.sessionInfo = { session_id: "s1", session_type: "signing" };

        mgr.handleOffscreenStateUpdate(failure as any);

        expect((mgr as any).appState.sessionInfo).toBeNull();
        expect(handleSignatureError).toHaveBeenCalledWith("s1", failure.error);
        expect(broadcasts).toContainEqual({ type: "signatureError", signingId: "sign_s1", error: failure.error });
    });

    it("leaves a different active session alone", () => {
        const mgr = new StateManager({ deviceId: "ext-a" } as any);
        (mgr as any).broadcastToPopupPorts = () => {};
        (mgr as any).appState.sessionInfo = { session_id: "other", session_type: "reshare" };
        mgr.handleOffscreenStateUpdate(failure as any);
        expect((mgr as any).appState.sessionInfo.session_id).toBe("other");
    });
});
