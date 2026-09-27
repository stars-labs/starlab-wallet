/**
 * Signing semantics shared with the Rust CLI/TUI (protocal/signing.rs):
 * - the proposer starts its ceremony as soon as it announces (CLI peers
 *   never "join" a signing session, so waiting for joins stalls forever);
 * - the signer set is the first threshold-many commitments (own included);
 *   later commitments are not part of this signing package;
 * - frames that arrive before our ceremony starts are buffered, not dropped;
 * - every signer aggregates once it holds the set's shares (the CLI never
 *   broadcasts an aggregate).
 */
import { describe, it, expect, jest } from "bun:test";
import { WebRTCManager, SigningState } from "../../../src/entrypoints/offscreen/webrtc";

function setup() {
    const mgr = new WebRTCManager("ext-a", () => {});
    mgr.setBlockchain("ethereum");
    const dkg = {
        signing_commit: jest.fn(() => "c0"),
        add_signing_commitment: jest.fn(),
        sign: jest.fn(() => "s0"),
        add_signature_share: jest.fn(),
        aggregate_signature: jest.fn(() => "sig"),
    };
    (mgr as any).frostDkg = dkg;
    (mgr as any).walletIdentifiers = { "ext-a": 1, "cli-b": 2, "cli-c": 3 };
    (mgr as any)._frostWire = (_k: string, hex: string) => hex;
    const sent: Array<{ to: string; text: string }> = [];
    (mgr as any).sendWebRTCAppMessage = (to: string, m: any) => sent.push({ to, text: m.text });
    const completed: any[] = [];
    mgr.onSigningComplete = (p: any) => completed.push(p);
    return { mgr, dkg, sent, completed };
}

// Only the proposer is listed: CLI peers don't join signing sessions.
const session = {
    session_id: "s1",
    proposer_id: "ext-a",
    participants: ["ext-a"],
    threshold: 2,
    total: 3,
    session_type: "signing",
} as any;

const frame = (tag: string, hex: string) =>
    ({ webrtc_msg_type: "SimpleMessage", text: `${tag}:${btoa(String.fromCharCode(...hex.match(/.{2}/g)!.map((h) => parseInt(h, 16))))}` }) as any;

describe("WebRTCManager signing (CLI-compatible)", () => {
    it("the proposer commits to every cohort peer without waiting for joins", async () => {
        const { mgr, sent } = setup();
        expect(await mgr.initiateSigningCeremony(session, "aa")).toBe(true);
        expect(sent.map((s) => s.to).sort()).toEqual(["cli-b", "cli-c"]);
        expect(sent.every((s) => s.text.startsWith("SIGN_COMMIT:"))).toBe(true);
    });

    it("signs with the first threshold-many commitments and ignores later ones", async () => {
        const { mgr, dkg } = setup();
        await mgr.initiateSigningCeremony(session, "aa");
        mgr.handleWebRTCAppMessage("cli-c", frame("SIGN_COMMIT", "cc"));
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        expect(dkg.add_signing_commitment.mock.calls).toEqual([[3, "cc"]]);
        expect(dkg.sign).toHaveBeenCalledTimes(1);
    });

    it("replays a commitment that arrived before the ceremony started", async () => {
        const { mgr, dkg } = setup();
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        await mgr.initiateSigningCeremony(session, "aa");
        expect(dkg.add_signing_commitment.mock.calls).toEqual([[2, "bb"]]);
        expect(dkg.sign).toHaveBeenCalledTimes(1);
    });

    it("aggregates once the signer set's shares are in, even as a non-proposer", async () => {
        const { mgr, dkg, completed } = setup();
        await mgr.initiateSigningCeremony({ ...session, proposer_id: "cli-b" }, "aa");
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_SHARE", "5b"));
        expect(dkg.add_signature_share.mock.calls).toEqual([[2, "5b"]]);
        expect(dkg.aggregate_signature).toHaveBeenCalledTimes(1);
        expect(completed.map((c) => c.signature)).toEqual(["sig"]);
        expect((mgr as any).signingState).toBe(SigningState.Complete);
    });
});
