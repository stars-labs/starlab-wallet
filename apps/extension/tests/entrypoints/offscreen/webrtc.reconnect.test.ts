/**
 * Weak-network recovery of the peer mesh — the same rules as the CLI/TUI:
 * - `disconnected` gets a grace period (ICE often recovers on its own);
 *   `failed`, or a grace that expires, rebuilds the connection;
 * - on rebuild the smaller device id re-offers, the other side waits;
 * - an offer for a peer we already negotiated with replaces that connection
 *   (it rebuilt or restarted), except in glare (we're the offerer mid-offer);
 * - ceremony frames are re-sent when a channel (re)opens, and forgotten once
 *   the ceremony ends so a stale frame can never reach the next one.
 */
import { describe, it, expect } from "bun:test";
import { WebRTCManager, SigningState } from "../../../src/entrypoints/offscreen/webrtc";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakePc(state = "connected", extra: Record<string, any> = {}) {
    return { connectionState: state, signalingState: "stable", remoteDescription: { sdp: "x" }, closed: false, close() { this.closed = true; }, ...extra } as any;
}

function manager(localId: string, peers: string[]) {
    const mgr = new WebRTCManager(localId, () => {});
    mgr.updateSessionInfo({ session_id: "s1", proposer_id: localId, participants: [localId, ...peers], accepted_devices: [], threshold: 2, total: peers.length + 1 } as any);
    (mgr as any).disconnectGraceMs = 30;
    (mgr as any).rebuildBaseDelayMs = 40;
    (mgr as any).offerWatchdogMs = 60_000;
    const offered: string[] = [];
    (mgr as any).initiatePeerConnection = async (p: string) => { offered.push(p); };
    return { mgr, offered };
}

describe("WebRTCManager connection recovery", () => {
    it("waits out a transient disconnect", async () => {
        const { mgr, offered } = manager("a-ext", ["z-cli"]);
        const pc = fakePc("disconnected");
        (mgr as any).peerConnections.set("z-cli", pc);
        (mgr as any)._onPeerConnectionState("z-cli", pc);
        pc.connectionState = "connected";
        (mgr as any)._onPeerConnectionState("z-cli", pc);
        await sleep(60);
        expect(pc.closed).toBe(false);
        expect(offered).toEqual([]);
    });

    it("rebuilds after the grace expires — the smaller id re-offers", async () => {
        const { mgr, offered } = manager("a-ext", ["z-cli"]);
        const pc = fakePc("disconnected");
        (mgr as any).peerConnections.set("z-cli", pc);
        (mgr as any)._onPeerConnectionState("z-cli", pc);
        await sleep(60);
        expect(pc.closed).toBe(true);
        expect((mgr as any).peerConnections.has("z-cli")).toBe(false);
        expect(offered).toEqual(["z-cli"]);
    });

    it("on failure the larger id drops the connection and waits for an offer", () => {
        const { mgr, offered } = manager("z-ext", ["a-cli"]);
        const pc = fakePc("failed");
        (mgr as any).peerConnections.set("a-cli", pc);
        (mgr as any)._onPeerConnectionState("a-cli", pc);
        expect(pc.closed).toBe(true);
        expect(offered).toEqual([]);
    });

    it("ignores state changes from a connection that was already replaced", () => {
        const { mgr, offered } = manager("a-ext", ["z-cli"]);
        const old = fakePc("failed");
        (mgr as any).peerConnections.set("z-cli", fakePc("connected"));
        (mgr as any)._onPeerConnectionState("z-cli", old);
        expect((mgr as any).peerConnections.get("z-cli").closed).toBe(false);
        expect(offered).toEqual([]);
    });

    it("rate-limits rebuilds of a flapping connection", async () => {
        const { mgr, offered } = manager("a-ext", ["z-cli"]);
        for (let i = 0; i < 3; i++) {
            const pc = fakePc("failed");
            (mgr as any).peerConnections.set("z-cli", pc);
            (mgr as any)._onPeerConnectionState("z-cli", pc);
        }
        expect(offered).toEqual(["z-cli"]);
        await sleep(60);
        expect(offered).toEqual(["z-cli", "z-cli"]);
    });

    it("re-offers again when a re-offered connection never comes up", async () => {
        const { mgr, offered } = manager("a-ext", ["z-cli"]);
        (mgr as any).offerWatchdogMs = 50;
        const pc = fakePc("failed");
        (mgr as any).peerConnections.set("z-cli", pc);
        (mgr as any)._onPeerConnectionState("z-cli", pc);
        (mgr as any).peerConnections.set("z-cli", fakePc("connecting"));
        await sleep(80);
        expect(offered).toEqual(["z-cli", "z-cli"]);
    });

    it("the offer watchdog stands down once the connection is up", async () => {
        const { mgr, offered } = manager("a-ext", ["z-cli"]);
        (mgr as any).offerWatchdogMs = 50;
        const pc = fakePc("failed");
        (mgr as any).peerConnections.set("z-cli", pc);
        (mgr as any)._onPeerConnectionState("z-cli", pc);
        const fresh = fakePc("connected");
        (mgr as any).peerConnections.set("z-cli", fresh);
        (mgr as any)._onPeerConnectionState("z-cli", fresh);
        await sleep(80);
        expect(offered).toEqual(["z-cli"]);
    });

    it("recovers mesh peers that aren't in the current session (signing lists only its proposer)", () => {
        const { mgr, offered } = manager("a-ext", ["z-cli"]);
        mgr.updateSessionInfo({ session_id: "sign1", proposer_id: "a-ext", participants: ["a-ext"], accepted_devices: [], threshold: 2, total: 3 } as any);
        const pc = fakePc("failed");
        (mgr as any).peerConnections.set("z-cli", pc);
        (mgr as any)._onPeerConnectionState("z-cli", pc);
        expect(offered).toEqual(["z-cli"]);
    });

    it("a peer that left the signal server is not re-offered", async () => {
        const { mgr, offered } = manager("a-ext", ["z-cli"]);
        const pc = fakePc("disconnected");
        (mgr as any).peerConnections.set("z-cli", pc);
        (mgr as any)._onPeerConnectionState("z-cli", pc);
        mgr.dropPeers(["z-cli"]);
        await sleep(60);
        expect(offered).toEqual([]);
    });

    it("an offer replaces a connection we already negotiated", () => {
        const { mgr } = manager("z-ext", ["a-cli"]);
        const old = fakePc("failed");
        (mgr as any).peerConnections.set("a-cli", old);
        expect((mgr as any)._acceptsOffer("a-cli")).toBe(true);
        expect(old.closed).toBe(true);
        expect((mgr as any).peerConnections.has("a-cli")).toBe(false);
    });

    it("keeps a fresh answer-side connection for the offer", () => {
        const { mgr } = manager("z-ext", ["a-cli"]);
        const fresh = fakePc("new", { remoteDescription: null });
        (mgr as any).peerConnections.set("a-cli", fresh);
        expect((mgr as any)._acceptsOffer("a-cli")).toBe(true);
        expect((mgr as any).peerConnections.get("a-cli")).toBe(fresh);
    });

    it("ignores the peer's offer in glare when we are the offerer", () => {
        const { mgr } = manager("a-ext", ["z-cli"]);
        const ours = fakePc("connecting", { signalingState: "have-local-offer", remoteDescription: null });
        (mgr as any).peerConnections.set("z-cli", ours);
        expect((mgr as any)._acceptsOffer("z-cli")).toBe(false);
        expect(ours.closed).toBe(false);
    });
});

describe("WebRTCManager ceremony resend", () => {
    function channel(state = "open") {
        const sent: string[] = [];
        return { readyState: state, send: (d: string) => sent.push(d), sent, onopen: null as any, onclose: null as any } as any;
    }
    const texts = (dc: any) => dc.sent.map((d: string) => JSON.parse(d).text);

    it("re-sends this ceremony's frames when the channel reopens", () => {
        const { mgr } = manager("a-ext", ["z-cli"]);
        const first = channel();
        (mgr as any)._setupDataChannel(first, "z-cli");
        mgr.sendWebRTCAppMessage("z-cli", { webrtc_msg_type: "SimpleMessage", text: "SIGN_COMMIT:c" });
        expect(texts(first)).toEqual(["SIGN_COMMIT:c"]);

        const second = channel("connecting");
        (mgr as any)._setupDataChannel(second, "z-cli");
        second.readyState = "open";
        second.onopen();
        expect(texts(second)).toEqual(["SIGN_COMMIT:c"]);
    });

    it("a replaced channel closing late doesn't drop the new one", () => {
        const { mgr } = manager("a-ext", ["z-cli"]);
        const old = channel();
        (mgr as any)._setupDataChannel(old, "z-cli");
        const fresh = channel();
        (mgr as any)._setupDataChannel(fresh, "z-cli");
        old.onclose();
        mgr.sendWebRTCAppMessage("z-cli", { webrtc_msg_type: "SimpleMessage", text: "SIGN_SHARE:s" });
        expect(texts(fresh)).toEqual(["SIGN_SHARE:s"]);
    });

    it("forgets the frames once the ceremony ends", () => {
        const { mgr } = manager("a-ext", ["z-cli"]);
        (mgr as any)._setupDataChannel(channel(), "z-cli");
        mgr.sendWebRTCAppMessage("z-cli", { webrtc_msg_type: "SimpleMessage", text: "SIGN_COMMIT:c" });
        (mgr as any)._updateSigningState(SigningState.Complete, null);

        const again = channel("connecting");
        (mgr as any)._setupDataChannel(again, "z-cli");
        again.readyState = "open";
        again.onopen();
        expect(texts(again)).toEqual([]);
    });

    it("does not record non-ceremony messages", () => {
        const { mgr } = manager("a-ext", ["z-cli"]);
        (mgr as any)._setupDataChannel(channel(), "z-cli");
        mgr.sendWebRTCAppMessage("z-cli", { webrtc_msg_type: "MeshReady", session_id: "s1", device_id: "a-ext" } as any);
        const again = channel("connecting");
        (mgr as any)._setupDataChannel(again, "z-cli");
        again.readyState = "open";
        again.onopen();
        expect(again.sent).toEqual([]);
    });
});
