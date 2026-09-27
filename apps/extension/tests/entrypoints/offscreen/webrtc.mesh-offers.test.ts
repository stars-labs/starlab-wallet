/**
 * Mesh bootstrap: the peer with the smaller device id sends the offer (same
 * rule as the Rust CLI/TUI). A DKG/signing initiator whose id sorts first
 * used to never offer — nobody connected to it and the mesh stalled.
 */
import { describe, it, expect } from "bun:test";
import { WebRTCManager } from "../../../src/entrypoints/offscreen/webrtc";

function managerFor(localId: string, participants: string[]) {
    const mgr = new WebRTCManager(localId, () => {});
    mgr.updateSessionInfo({
        session_id: "dkg_mesh",
        proposer_id: localId,
        participants,
        accepted_devices: participants,
        threshold: 2,
        total: participants.length,
        session_type: "dkg",
    } as any);
    const offered: string[] = [];
    (mgr as any).initiatePeerConnection = async (peerId: string) => {
        offered.push(peerId);
        (mgr as any).peerConnections.set(peerId, {} as RTCPeerConnection);
    };
    return { mgr, offered };
}

describe("WebRTCManager.initiateMeshOffers", () => {
    it("offers to every peer whose id sorts after ours", () => {
        const { mgr, offered } = managerFor("ext-a", ["ext-a", "interop-cli-2", "interop-cli-1"]);
        mgr.initiateMeshOffers();
        expect(offered.sort()).toEqual(["interop-cli-1", "interop-cli-2"]);
    });

    it("leaves peers whose id sorts before ours to offer to us", () => {
        const { mgr, offered } = managerFor("m-device", ["a-device", "m-device", "z-device"]);
        mgr.initiateMeshOffers();
        expect(offered).toEqual(["z-device"]);
    });

    it("does not re-offer to a peer that already has a connection", () => {
        const { mgr, offered } = managerFor("ext-a", ["ext-a", "peer-b"]);
        mgr.initiateMeshOffers();
        mgr.initiateMeshOffers();
        expect(offered).toEqual(["peer-b"]);
    });
});

describe("WebRTCManager.dropPeers", () => {
    it("closes and forgets the connections of peers that left", () => {
        const { mgr } = managerFor("ext-a", ["ext-a", "peer-b"]);
        let closed = false;
        (mgr as any).peerConnections.set("peer-b", { close: () => (closed = true) });
        (mgr as any).dataChannels.set("peer-b", {});
        mgr.dropPeers(["peer-b"]);
        expect(closed).toBe(true);
        expect((mgr as any).peerConnections.has("peer-b")).toBe(false);
        expect((mgr as any).dataChannels.has("peer-b")).toBe(false);
    });
});

describe("WebRTCManager send queue", () => {
    // A ceremony can start while the data channel to a (re)connecting peer
    // is still opening — e.g. a one-shot CLI signer that just started.
    function channel() {
        const sent: string[] = [];
        return { readyState: "connecting", send: (d: string) => sent.push(d), sent, onopen: null as any } as any;
    }

    it("delivers messages sent before the channel opened, once it opens", () => {
        const mgr = new WebRTCManager("ext-a", () => {});
        const dc = channel();
        (mgr as any)._setupDataChannel(dc, "cli-b");
        mgr.sendWebRTCAppMessage("cli-b", { webrtc_msg_type: "SimpleMessage", text: "SIGN_COMMIT:x" });
        expect(dc.sent).toEqual([]);
        dc.readyState = "open";
        dc.onopen();
        expect(dc.sent.map((d: string) => JSON.parse(d).text)).toEqual(["SIGN_COMMIT:x"]);
    });

    it("forgets queued messages for a peer that left", () => {
        const mgr = new WebRTCManager("ext-a", () => {});
        mgr.sendWebRTCAppMessage("cli-b", { webrtc_msg_type: "SimpleMessage", text: "stale" });
        mgr.dropPeers(["cli-b"]);
        const dc = channel();
        (mgr as any)._setupDataChannel(dc, "cli-b");
        dc.readyState = "open";
        dc.onopen();
        expect(dc.sent).toEqual([]);
    });
});

describe("WebRTCManager send queue across sessions", () => {
    it("drops messages queued for a previous session", () => {
        const { mgr } = managerFor("ext-a", ["ext-a", "cli-b"]);
        mgr.sendWebRTCAppMessage("cli-b", { webrtc_msg_type: "SimpleMessage", text: "DKG_ROUND1:old" });
        mgr.updateSessionInfo({ session_id: "sign_next", proposer_id: "ext-a", participants: ["ext-a", "cli-b"], accepted_devices: [], threshold: 2, total: 2 } as any);
        expect((mgr as any).pendingSends.size).toBe(0);
    });
});
