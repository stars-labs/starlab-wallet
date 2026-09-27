import { describe, it, expect } from "bun:test";
import { signingInviteDecision } from "../../../src/entrypoints/popup/signingInvite";

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
        expect(signingInviteDecision(invite, { ...ctx, dismissed: new Set(["sign-1"]) })).toBe("ignore");
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
