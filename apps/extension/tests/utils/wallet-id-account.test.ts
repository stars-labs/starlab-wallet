import { describe, it, expect } from "bun:test";
import { parseAccountWalletId, accountWalletId } from "../../src/utils/wallet-id";

// Mirrors starlab-mpc accounts::parse_child_wallet_id's tests.
describe("parseAccountWalletId", () => {
    it("round-trips the canonical form", () => {
        expect(parseAccountWalletId(accountWalletId("19caa3cf46d3", "ethereum", 7))).toEqual({
            root: "19caa3cf46d3",
            chain: "ethereum",
            account: 7,
        });
        expect(parseAccountWalletId("abc-def-solana-0")).toEqual({ root: "abc-def", chain: "solana", account: 0 });
        expect(parseAccountWalletId("4919c5d281e2-bitcoin-0")?.chain).toBe("bitcoin");
    });

    it("rejects non-child ids", () => {
        for (const id of ["19caa3cf46d3", "wallet-dogecoin-1", "wallet-ethereum-x", "wallet-ethereum-+7", "-ethereum-1", "ethereum-1", ""]) {
            expect(parseAccountWalletId(id)).toBeNull();
        }
    });
});
