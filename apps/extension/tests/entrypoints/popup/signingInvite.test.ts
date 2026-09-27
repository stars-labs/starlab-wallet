import { describe, it, expect } from "bun:test";
import { signingInviteChain, signingInviteDecision, signingInviteKey } from "../../../src/entrypoints/popup/signingInvite";

const invite = {
    session_id: "sign-1",
    session_type: "signing",
    proposer_id: "cli",
    participants: ["cli", "ext"],
} as any;
const ctx = { deviceId: "ext", dismissed: new Set<string>(), modalOpen: false, busy: false };

describe("signingInviteDecision", () => {
    it("shows an invite for us when idle", () => {
        expect(signingInviteDecision(invite, ctx)).toBe("show");
    });

    it("defers an invite that arrives during another ceremony", () => {
        expect(signingInviteDecision(invite, { ...ctx, busy: true })).toBe("defer");
    });

    it("ignores an invite we already dismissed", () => {
        expect(signingInviteDecision(invite, { ...ctx, dismissed: new Set([signingInviteKey(invite)]) })).toBe("ignore");
    });

    it("ignores our own proposal", () => {
        expect(signingInviteDecision({ ...invite, proposer_id: "ext" }, ctx)).toBe("ignore");
    });

    it("ignores sessions we're not part of", () => {
        expect(signingInviteDecision({ ...invite, participants: ["cli", "other"] }, ctx)).toBe("ignore");
    });

    it("ignores non-signing sessions", () => {
        expect(signingInviteDecision({ ...invite, session_type: "dkg" }, ctx)).toBe("ignore");
    });
});

describe("signing request identity", () => {
    it("shows a re-announce of a dismissed session id with a new message", () => {
        const dismissed = new Set([signingInviteKey({ ...invite, signing_message_hex: "aa" })]);
        expect(signingInviteDecision({ ...invite, signing_message_hex: "bb" }, { ...ctx, dismissed })).toBe("show");
    });
});

describe("signingInviteChain", () => {
    it("takes the chain from wallet_name, not the announce's blockchain", () => {
        expect(signingInviteChain({ wallet_name: "4919c5d281e2-bitcoin-0", blockchain: "ethereum" })).toBe("bitcoin");
    });

    it("falls back to blockchain for a root wallet name", () => {
        expect(signingInviteChain({ wallet_name: "4919c5d281e2", blockchain: "solana" })).toBe("solana");
    });
});
