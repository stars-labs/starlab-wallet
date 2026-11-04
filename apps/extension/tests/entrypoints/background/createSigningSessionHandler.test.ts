/**
 * The popup's "Sign message" builds the signing announce from the wallet's
 * stored key share (group key, threshold, cohort size). Wallet metadata from
 * the DKG save path carries none of these.
 */
import { describe, it, expect, jest, mock } from "bun:test";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);
// Other test files mock this module too (mock.module is process-wide), so
// install our own fake rather than poking the real singleton.
const keystore = {
    getWallets: () => [{ id: "w1", name: "Treasury", blockchain: "ethereum" }],
    getKeyShare: async () => ({ group_public_key: "02ab", frost_group_public_keys: {ed25519: "ed-root", secp256k1: "02ab"}, ecdsa_group_public_key: "ecdsa-root", threshold: 3, total_participants: 5 }),
};
mock.module("../../../src/services/keystoreManager", () => ({
    KeystoreManager: { getInstance: () => keystore },
}));
import { PopupMessageHandler } from "../../../src/entrypoints/background/messageHandlers";

describe("PopupMessageHandler createSigningSession", () => {
    it("announces from the wallet's stored key share", async () => {
        const createSigningSession = jest.fn(async () => ({ success: true, sessionId: "sign_1" }));
        const handler = new PopupMessageHandler(
            { getState: () => ({}), getChain: () => "ethereum" } as any,
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
            expect.objectContaining({
                keyShare: expect.objectContaining({ group_public_key: "02ab", threshold: 3, total_participants: 5 }),
            }),
        );
    });
});
