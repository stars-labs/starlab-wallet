/**
 * Signing semantics shared with the Rust CLI/TUI (protocal/signing.rs):
 * - the proposer starts its ceremony as soon as it announces (CLI peers
 *   never "join" a signing session, so waiting for joins stalls forever);
 * - the proposer fixes the signer set — itself plus the first threshold-1
 *   commitments — and announces it (SIGN_SET) before its share; everyone
 *   else waits for that set and never picks one (independent picks with
 *   more than threshold signers online disagree and aggregation fails);
 * - frames that arrive before our ceremony starts are buffered, not dropped;
 * - every shareholder aggregates once it holds the set's shares, whether or
 *   not it signed (the CLI never broadcasts an aggregate).
 */
import { describe, it, expect, jest } from "bun:test";
import {
    WebRTCManager,
    SigningState,
    encodeSignerSet,
    decodeSignerSet,
} from "../../../src/entrypoints/offscreen/webrtc";

function setup() {
    const mgr = new WebRTCManager("ext-a", () => {});
    mgr.setBlockchain("ethereum");
    const dkg = {
        signing_commit: jest.fn(() => "c0"),
        add_signing_commitment: jest.fn(),
        clear_signing_state: jest.fn(),
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
    const failed: any[] = [];
    mgr.onSigningFailed = (p: any) => failed.push(p);
    return { mgr, dkg, sent, completed, failed };
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
const proposedBy = (proposer_id: string) => ({ ...session, proposer_id });

const frame = (tag: string, hex: string) =>
    ({ webrtc_msg_type: "SimpleMessage", text: `${tag}:${btoa(String.fromCharCode(...hex.match(/.{2}/g)!.map((h) => parseInt(h, 16))))}` }) as any;
const setFrame = (ids: string[]) => ({ webrtc_msg_type: "SimpleMessage", text: encodeSignerSet(ids) }) as any;

describe("SIGN_SET wire format", () => {
    it("is base64 of the JSON array, as the CLI encodes it", () => {
        expect(encodeSignerSet(["a", "b"])).toBe("SIGN_SET:WyJhIiwiYiJd");
    });

    it("round-trips and rejects garbage", () => {
        expect(decodeSignerSet(encodeSignerSet(["ext-a", "cli-b"]))).toEqual(["ext-a", "cli-b"]);
        expect(decodeSignerSet("SIGN_SET:not-base64!")).toBeNull();
    });
});

describe("WebRTCManager signing — proposer", () => {
    it("commits to every cohort peer without waiting for joins", async () => {
        const { mgr, sent } = setup();
        expect(await mgr.initiateSigningCeremony(session, "aa")).toBe(true);
        expect(sent.map((s) => s.to).sort()).toEqual(["cli-b", "cli-c"]);
        expect(sent.every((s) => s.text.startsWith("SIGN_COMMIT:"))).toBe(true);
    });

    it("fixes the set with the first commitment and announces it before its share", async () => {
        const { mgr, dkg, sent } = setup();
        await mgr.initiateSigningCeremony(session, "aa");
        mgr.handleWebRTCAppMessage("cli-c", frame("SIGN_COMMIT", "cc"));
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        expect(dkg.add_signing_commitment.mock.calls).toEqual([[3, "cc"]]);
        expect(dkg.sign).toHaveBeenCalledTimes(1);
        const toB = sent.filter((s) => s.to === "cli-b").map((s) => s.text.split(":")[0]);
        expect(toB).toEqual(["SIGN_COMMIT", "SIGN_SET", "SIGN_SHARE"]);
        const announced = sent.find((s) => s.text.startsWith("SIGN_SET:"))!.text;
        expect(decodeSignerSet(announced)).toEqual(["ext-a", "cli-c"]);
    });

    it("replays a commitment that arrived before the ceremony started", async () => {
        const { mgr, dkg } = setup();
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        await mgr.initiateSigningCeremony(session, "aa");
        expect(dkg.add_signing_commitment.mock.calls).toEqual([[2, "bb"]]);
        expect(dkg.sign).toHaveBeenCalledTimes(1);
    });
});

describe("WebRTCManager signing — co-signer", () => {
    it("does not sign on threshold commitments alone — it waits for the proposer's set", async () => {
        const { mgr, dkg } = setup();
        await mgr.initiateSigningCeremony(proposedBy("cli-b"), "aa");
        mgr.handleWebRTCAppMessage("cli-c", frame("SIGN_COMMIT", "cc"));
        expect(dkg.sign).not.toHaveBeenCalled();
        expect(dkg.add_signing_commitment).not.toHaveBeenCalled();
    });

    it("signs with exactly the announced set's commitments", async () => {
        const { mgr, dkg } = setup();
        await mgr.initiateSigningCeremony(proposedBy("cli-b"), "aa");
        mgr.handleWebRTCAppMessage("cli-c", frame("SIGN_COMMIT", "cc"));
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        mgr.handleWebRTCAppMessage("cli-b", setFrame(["cli-b", "ext-a"]));
        expect(dkg.add_signing_commitment.mock.calls).toEqual([[2, "bb"]]);
        expect(dkg.sign).toHaveBeenCalledTimes(1);
    });

    it("waits for a set member's commitment that arrives after the set", async () => {
        const { mgr, dkg } = setup();
        await mgr.initiateSigningCeremony(proposedBy("cli-b"), "aa");
        mgr.handleWebRTCAppMessage("cli-b", setFrame(["cli-b", "ext-a"]));
        expect(dkg.sign).not.toHaveBeenCalled();
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        expect(dkg.sign).toHaveBeenCalledTimes(1);
    });

    it("outside the set: does not sign, rebuilds the package from the set, and aggregates", async () => {
        const { mgr, dkg, completed } = setup();
        await mgr.initiateSigningCeremony(proposedBy("cli-b"), "aa");
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        mgr.handleWebRTCAppMessage("cli-c", frame("SIGN_COMMIT", "cc"));
        mgr.handleWebRTCAppMessage("cli-b", setFrame(["cli-b", "cli-c"]));
        expect(dkg.sign).not.toHaveBeenCalled();
        expect(dkg.clear_signing_state).toHaveBeenCalledTimes(1);
        expect(dkg.add_signing_commitment.mock.calls).toEqual([[2, "bb"], [3, "cc"]]);
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_SHARE", "5b"));
        mgr.handleWebRTCAppMessage("cli-c", frame("SIGN_SHARE", "5c"));
        expect(dkg.aggregate_signature).toHaveBeenCalledTimes(1);
        expect(completed.map((c) => c.signature)).toEqual(["sig"]);
        expect((mgr as any).signingState).toBe(SigningState.Complete);
    });

    it("ignores a SIGN_SET that doesn't come from the proposer", async () => {
        const { mgr, dkg } = setup();
        await mgr.initiateSigningCeremony(proposedBy("cli-b"), "aa");
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        mgr.handleWebRTCAppMessage("cli-c", setFrame(["cli-b", "ext-a"]));
        expect(dkg.sign).not.toHaveBeenCalled();
    });

    it("fails the ceremony on a set of the wrong size", async () => {
        const { mgr } = setup();
        await mgr.initiateSigningCeremony(proposedBy("cli-b"), "aa");
        mgr.handleWebRTCAppMessage("cli-b", setFrame(["cli-b", "ext-a", "cli-c"]));
        expect((mgr as any).signingState).toBe(SigningState.Failed);
    });

    it("buffers a set that arrives before the ceremony starts", async () => {
        const { mgr, dkg } = setup();
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        mgr.handleWebRTCAppMessage("cli-b", setFrame(["cli-b", "ext-a"]));
        await mgr.initiateSigningCeremony(proposedBy("cli-b"), "aa");
        expect(dkg.sign).toHaveBeenCalledTimes(1);
    });
});

describe("WebRTCManager signing — consecutive ceremonies", () => {
    it("a finished ceremony doesn't block the next, nor leak its frames into it", async () => {
        const { mgr, dkg, completed } = setup();
        await mgr.initiateSigningCeremony(session, "aa");
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_SHARE", "5b"));
        expect(completed).toHaveLength(1);

        // The next request's commitment arrives before we approve it.
        mgr.handleWebRTCAppMessage("cli-c", frame("SIGN_COMMIT", "cc"));
        expect(await mgr.initiateSigningCeremony({ ...session, session_id: "s2" }, "bb")).toBe(true);
        const calls = dkg.add_signing_commitment.mock.calls;
        expect(calls[calls.length - 1]).toEqual([3, "cc"]);
        expect(dkg.sign).toHaveBeenCalledTimes(2);
    });
});

describe("WebRTCManager signing — timeout", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("fails a signing that never gets enough signers, and a retry starts clean", async () => {
        const { mgr, dkg, failed } = setup();
        (mgr as any).signingTimeoutMs = 20;
        await mgr.initiateSigningCeremony(session, "aa");
        await sleep(40);
        expect((mgr as any).signingState).toBe(SigningState.Failed);
        expect(failed.map((f) => f.error)).toEqual(["Signing timed out after 0s: only 1 of 2 signers responded"]);
        expect(failed[0].sessionId).toBe("s1");
        expect(dkg.clear_signing_state).toHaveBeenCalled();
        expect(await mgr.initiateSigningCeremony({ ...session, session_id: "s2" }, "bb")).toBe(true);
    });

    it("names the picked signer whose share never came", async () => {
        const { mgr, failed } = setup();
        (mgr as any).signingTimeoutMs = 20;
        await mgr.initiateSigningCeremony(session, "aa");
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        await sleep(40);
        expect(failed.map((f) => f.error)).toEqual(["Signing timed out after 0s: no signature share from cli-b"]);
    });

    it("a completed signing's timer does nothing", async () => {
        const { mgr, failed } = setup();
        (mgr as any).signingTimeoutMs = 20;
        await mgr.initiateSigningCeremony(session, "aa");
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_COMMIT", "bb"));
        mgr.handleWebRTCAppMessage("cli-b", frame("SIGN_SHARE", "5b"));
        await sleep(40);
        expect(failed).toEqual([]);
        expect((mgr as any).signingState).toBe(SigningState.Complete);
    });

    it("an invalid signer set is reported as a failure", async () => {
        const { mgr, failed } = setup();
        await mgr.initiateSigningCeremony(proposedBy("cli-b"), "aa");
        mgr.handleWebRTCAppMessage("cli-b", setFrame(["cli-b", "ext-a", "cli-c"]));
        expect(failed.map((f) => f.error)).toEqual(["Invalid signer set from cli-b: 3 signers, threshold is 2"]);
    });
});
