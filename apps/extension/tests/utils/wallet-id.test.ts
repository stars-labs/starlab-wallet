/**
 * Must match starlab-mpc's `wallet_id_from_session` (apps/tui/src/protocal/
 * dkg.rs): CLI/TUI peers look a wallet up by this id when a signing or
 * reshare announce names it, so every implementation derives the same id
 * from the shared DKG session id.
 */
import { describe, it, expect } from "bun:test";
import { walletIdFromSession } from "../../src/utils/wallet-id";

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
