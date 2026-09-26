/**
 * The engine's generate_round2() returns a map of recipient → hex(JSON
 * package). CLI/TUI peers parse `DkgRound2Package.package` as a JSON object
 * (as they do for round 1), so each package must be decoded before sending,
 * not forwarded as the hex string.
 */
import { describe, it, expect } from "bun:test";
import { WebRTCManager } from "../../../src/entrypoints/offscreen/webrtc";

const toHex = (s: string) =>
    Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

describe("WebRTCManager round 2 wire format", () => {
    it("sends each recipient's package as a JSON object", async () => {
        const mgr = new WebRTCManager("ext-a", () => {});
        mgr.updateSessionInfo({
            session_id: "dkg_r2",
            proposer_id: "ext-a",
            participants: ["ext-a", "cli-b"],
            accepted_devices: ["ext-a", "cli-b"],
            threshold: 2,
            total: 2,
            session_type: "dkg",
        } as any);
        const pkgForB = { header: { version: 0 }, signing_share: "ab" };
        (mgr as any).frostDkg = {
            generate_round2: () => toHex(JSON.stringify({ "1": toHex(JSON.stringify(pkgForB)) })), // cli-b sorts first → id 1,
        };
        const sent: Array<{ to: string; msg: any }> = [];
        (mgr as any).sendWebRTCAppMessage = (to: string, msg: any) => sent.push({ to, msg });

        await (mgr as any)._generateAndBroadcastRound2();

        expect(sent).toEqual([
            { to: "cli-b", msg: { webrtc_msg_type: "DkgRound2Package", package: pkgForB } },
        ]);
    });
});
