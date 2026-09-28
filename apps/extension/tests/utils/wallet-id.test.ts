/**
 * Must match starlab-mpc's `wallet_id_from_session` (apps/tui/src/protocal/
 * dkg.rs): CLI/TUI peers look a wallet up by this id when a signing or
 * reshare announce names it, so every implementation derives the same id
 * from the shared DKG session id.
 */
import { describe, it, expect } from "bun:test";
import { walletIdFromSession, accountWalletId, openInvites } from "../../src/utils/wallet-id";

describe("walletIdFromSession", () => {
    it("takes the first 12 hex digits of a uuid session id", () => {
        expect(walletIdFromSession("d9f249e9-66b3-4ee8-8a1c-000000000000")).toBe("d9f249e966b3");
    });

    it("keeps hex digits of the prefix too (dkg_ → d)", () => {
        expect(walletIdFromSession("dkg_b97fd906905aa1122")).toBe("db97fd906905");
    });

    it("falls back to alphanumerics when there are fewer than 8 hex digits", () => {
        expect(walletIdFromSession("my-session")).toBe("mysession");
    });

    it("never returns an empty id", () => {
        expect(walletIdFromSession("---")).toBe("wallet");
    });
});

describe("accountWalletId", () => {
    it("names the BIP-44 account child like starlab-mpc's ensure_account_wallet", () => {
        expect(accountWalletId("d9f249e966b3", "ethereum", 0)).toBe("d9f249e966b3-ethereum-0");
    });
});

describe("openInvites", () => {
    const invite = (session_id: string, session_type?: string) => ({ session_id, session_type }) as any;

    it("hides DKG sessions whose wallet this device already holds", () => {
        const invites = [invite("dkg_b97fd906905aa11"), invite("d9f249e9-66b3-4ee8-8a1c-000000000000")];
        expect(openInvites(invites, ["db97fd906905"]).map((i) => i.session_id)).toEqual([
            "d9f249e9-66b3-4ee8-8a1c-000000000000",
        ]);
    });

    it("keeps reshare sessions for held wallets", () => {
        const invites = [invite("dkg_b97fd906905aa11", "reshare")];
        expect(openInvites(invites, ["db97fd906905"])).toHaveLength(1);
    });

    it("never offers a signing session as a wallet invitation", () => {
        expect(openInvites([invite("sign_83777", "signing")], [])).toEqual([]);
    });
});
