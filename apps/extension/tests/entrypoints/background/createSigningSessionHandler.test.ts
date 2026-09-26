/**
 * The popup's "Sign message" builds the signing announce from the wallet's
 * stored key share (group key, threshold, cohort size). Wallet metadata from
 * the DKG save path carries none of these.
 */
import { describe, it, expect, jest, mock } from "bun:test";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);
import { PopupMessageHandler } from "../../../src/entrypoints/background/messageHandlers";
import { KeystoreManager } from "../../../src/services/keystoreManager";

describe("PopupMessageHandler createSigningSession", () => {
    it("announces with the key share's group key and threshold", async () => {
        (KeystoreManager as any).instance = {
            getWallets: () => [{ id: "w1", name: "Treasury", blockchain: "ethereum" }],
            getKeyShare: async () => ({ group_public_key: "02ab", threshold: 3, total_participants: 5 }),
        };
        const createSigningSession = jest.fn(async () => ({ success: true, sessionId: "sign_1" }));
        const handler = new PopupMessageHandler(
            { getState: () => ({}) } as any,
            {} as any,
            {} as any,
            { createSigningSession } as any,
            {} as any,
            {} as any,
        );

        const response = await new Promise<any>((resolve) =>
            (handler as any).handleCreateSigningSessionRequest({ walletId: "w1", message: "hi" }, resolve),
        );

        expect(response).toEqual({ success: true, sessionId: "sign_1" });
        expect(createSigningSession).toHaveBeenCalledWith(
            expect.objectContaining({ groupPublicKey: "02ab", threshold: 3, total: 5 }),
        );
        (KeystoreManager as any).instance = null;
    });
});
