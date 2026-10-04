import { describe, it, expect } from "bun:test";
import { addressForChain, publicWalletState } from "../../src/utils/walletAccount";
import { restoreActiveWallet } from "../../src/entrypoints/background/walletRestore";
import { StateManager } from "../../src/entrypoints/background/stateManager";

const frost = "02abcdef", ecdsa = "03abcdef";
describe("popup account identity", () => {
    it("keeps both public derivation parents through live DKG and reload snapshots", async () => {
        const mgr = new StateManager({deviceId: "device"});
        await new Promise((r) => setTimeout(r, 0));
        mgr.handleOffscreenStateUpdate({type: "dkgComplete", groupPublicKey: frost, address: "0x111", blockchain: "ethereum", ecdsa: {groupPublicKey: ecdsa, shareJson: "SECRET"}} as any);
        const live = publicWalletState(mgr.getState());
        expect(live.ecdsaGroupPublicKey).toBe(ecdsa);
        expect(live.dkgGroupPublicKey).toBe(frost);
        expect(JSON.stringify(live)).not.toContain("SECRET");
        await restoreActiveWallet(mgr, {
            initialize: async () => {}, isInitialized: async () => true, isLocked: () => false,
            getActiveWallet: () => ({id: "compactwallet", blockchain: "ethereum", address: "0x111"}),
            getKeyShare: async () => ({group_public_key: frost, ecdsa_group_public_key: ecdsa}),
        } as any);
        expect(publicWalletState(mgr.getState())).toEqual(live);
    });
    it("never substitutes Bitcoin for an unavailable Ethereum account", () => {
        expect(addressForChain([{chain: "bitcoin", address: "bc1p123"}], "ethereum")).toBeUndefined();
        expect(addressForChain([{chain: "ethereum", address: "0x123"}], "bitcoin")).toBeUndefined();
        expect(addressForChain([{chain: "bitcoin", address: "bc1p123"}, {chain: "ethereum", address: "0x123"}], "ethereum")).toBe("0x123");
        expect(addressForChain([{chain: "ethereum", address: "0x123"}], "polygon")).toBe("0x123");
    });
    it("clears previous public keys when a new wallet snapshot omits them", () => {
        expect(publicWalletState({})).toEqual({dkgAddress: "", dkgGroupPublicKey: "", ecdsaGroupPublicKey: ""});
    });
});
