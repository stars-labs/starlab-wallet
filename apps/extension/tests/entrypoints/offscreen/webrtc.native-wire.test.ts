/**
 * Wire format towards peers: the CLI/TUI's native frames — a SimpleMessage
 * `PREFIX:<base64 of FROST binary serialize()>` — for DKG rounds and
 * signing. The CLI's live data-channel path accepts nothing else, and
 * extension peers decode it too (the engine accepts JSON or FROST binary).
 */
import { describe, it, expect } from "bun:test";
import { WebRTCManager } from "../../../src/entrypoints/offscreen/webrtc";

const toHex = (s: string) =>
    Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/.{2}/g)!.map((h) => parseInt(h, 16))));

function manager(participants: string[]) {
    const mgr = new WebRTCManager("ext-a", () => {});
    mgr.updateSessionInfo({
        session_id: "dkg_wire",
        proposer_id: "ext-a",
        participants,
        accepted_devices: participants,
        threshold: 2,
        total: participants.length,
        session_type: "dkg",
    } as any);
    mgr.setBlockchain("ethereum");
    // Stand-in for the engine's to_frost_wire: tags the JSON so tests can
    // see which kind/curve was encoded.
    const encoded: Array<[string, string]> = [];
    (mgr as any)._frostWire = (kind: string, jsonHex: string) => {
        encoded.push([kind, jsonHex]);
        return toHex(`bin:${kind}`);
    };
    const sent: Array<{ to: string; msg: any }> = [];
    (mgr as any).sendWebRTCAppMessage = (to: string, msg: any) => sent.push({ to, msg });
    return { mgr, sent, encoded };
}

describe("WebRTCManager native wire frames", () => {
    it("routes a CLI SIGN_COMMIT frame into the active signing ceremony", () => {
        const { mgr } = manager(["cli-b", "ext-a"]);
        const seen: any[] = [];
        (mgr as any).signingInfo = { signing_id: "sign_1" };
        (mgr as any)._handleSigningCommitment = (from: string, m: any) => seen.push([from, m]);
        mgr.handleWebRTCAppMessage("cli-b", { webrtc_msg_type: "SimpleMessage", text: "SIGN_COMMIT:q80=" } as any);
        expect(seen).toEqual([["cli-b", { signing_id: "sign_1", commitment: "abcd" }]]);
    });

    it("routes a CLI SIGN_SHARE frame into the active signing ceremony", () => {
        const { mgr } = manager(["cli-b", "ext-a"]);
        const seen: any[] = [];
        (mgr as any).signingInfo = { signing_id: "sign_1" };
        (mgr as any)._handleSignatureShare = (from: string, m: any) => seen.push([from, m]);
        mgr.handleWebRTCAppMessage("cli-b", { webrtc_msg_type: "SimpleMessage", text: "SIGN_SHARE:q80=" } as any);
        expect(seen).toEqual([["cli-b", { signing_id: "sign_1", share: "abcd" }]]);
    });
});
