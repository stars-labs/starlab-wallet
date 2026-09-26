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
