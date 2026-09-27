import { describe, it, expect } from "bun:test";
import { ICE_SERVERS, STUN_SERVERS } from "../../src/config/ice";

describe("ICE servers", () => {
    it("match the CLI/TUI's STUN list (starlab-mpc STUN_SERVERS)", () => {
        expect(STUN_SERVERS).toEqual([
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun2.l.google.com:19302",
        ]);
        expect(ICE_SERVERS).toEqual([{ urls: STUN_SERVERS }]);
    });
});
