/**
 * StateManager's "signingComplete" handler records the signature for the
 * popup, clears the finished session and resolves the waiting dApp RPC.
 * The offscreen router must hand the event to it rather than swallow it.
 */
import { describe, it, expect, jest, mock } from "bun:test";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);
import { OffscreenMessageHandler } from "../../../src/entrypoints/background/messageHandlers";

describe("OffscreenMessageHandler signingComplete", () => {
    it("forwards the event to the StateManager", async () => {
        const handleOffscreenStateUpdate = jest.fn();
        const handler = new OffscreenMessageHandler({ handleOffscreenStateUpdate } as any, {} as any);
        const payload = { type: "signingComplete", signingId: "sign_s1", signature: "ab", sessionId: "s1" };
        await handler.handleOffscreenMessage(payload as any);
        expect(handleOffscreenStateUpdate).toHaveBeenCalledWith(payload);
    });
});
