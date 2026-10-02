/**
 * The ECDSA data-channel framing must match starlab-mpc's
 * apps/tui/src/protocal/ecdsa/wire.rs byte for byte (its tests pin the same
 * vectors).
 */
import { describe, expect, it } from "bun:test";
import {
    CHUNK_SIZE,
    FRAME_PREFIX,
    Reassembler,
    SIGN_DONE_PREFIX,
    SIGN_READY_PREFIX,
    SIGN_SET_PREFIX,
    decodeControl,
    encodeControl,
    encodeFrames,
    isEcdsaFrame,
    parseChunk,
} from "../../src/ecdsa/wire";

const chunkOf = (frame: string) => parseChunk(frame.slice(FRAME_PREFIX.length));

describe("ECDSA wire format (engine parity)", () => {
    it("pins the frame text: id = sha256(payload)[..8] hex, index, count, base64", () => {
        expect(encodeFrames(new TextEncoder().encode("abc"))).toEqual(["ECDSA:ba7816bf8f01cfea:0:1:YWJj"]);
    });

    it("pins the control frames: JSON field order, empty fields omitted, base64", () => {
        expect(encodeControl(SIGN_READY_PREFIX, { session_id: "sign_1" })).toBe(
            SIGN_READY_PREFIX + Buffer.from('{"session_id":"sign_1"}').toString("base64"),
        );
        expect(encodeControl(SIGN_SET_PREFIX, { session_id: "sign_1", signers: ["a", "b"] })).toBe(
            SIGN_SET_PREFIX + Buffer.from('{"session_id":"sign_1","signers":["a","b"]}').toString("base64"),
        );
        expect(encodeControl(SIGN_DONE_PREFIX, { session_id: "s", signature: "ab" })).toBe(
            SIGN_DONE_PREFIX + Buffer.from('{"session_id":"s","signature":"ab"}').toString("base64"),
        );
        const back = decodeControl(Buffer.from('{"session_id":"s","signers":["x"]}').toString("base64"));
        expect(back).toEqual({ session_id: "s", signers: ["x"], signature: "" });
    });

    it("chunks at 16 KiB and reassembles in any order, ignoring duplicates", () => {
        const payload = Uint8Array.from({ length: CHUNK_SIZE * 3 + 5 }, (_, i) => i & 0xff);
        const frames = encodeFrames(payload).reverse();
        expect(frames.length).toBe(4);
        const r = new Reassembler();
        let out: Uint8Array | null = null;
        frames.forEach((f, i) => {
            if (i === 1) expect(r.push("peer", chunkOf(f))).toBeNull();
            out = r.push("peer", chunkOf(f));
        });
        expect(Buffer.from(out!).equals(Buffer.from(payload))).toBe(true);
    });

    it("keeps senders apart and detects tampering", () => {
        const frames = encodeFrames(new Uint8Array(CHUNK_SIZE + 1).fill(7));
        const r = new Reassembler();
        expect(r.push("a", chunkOf(frames[0]))).toBeNull();
        expect(r.push("b", chunkOf(frames[1]))).toBeNull();
        const bad = chunkOf(frames[1]);
        bad.data[0] ^= 1;
        expect(() => r.push("a", bad)).toThrow("digest mismatch");
    });

    it("rejects malformed frames like the engine", () => {
        for (const bad of [
            "",
            "zz:0:1:AA==",
            "ba7816bf8f01cfea:1:1:AA==",
            "ba7816bf8f01cfea:0:0:AA==",
            "ba7816bf8f01cfea:0:65:AA==",
            "ba7816bf8f01cfea:0:1:!!",
        ]) {
            expect(() => parseChunk(bad)).toThrow();
        }
    });

    it("recognizes every ECDSA frame kind and nothing else", () => {
        expect(isEcdsaFrame("ECDSA:x")).toBe(true);
        expect(isEcdsaFrame("ECDSA_SIGN_SET:x")).toBe(true);
        expect(isEcdsaFrame("SIGN_SET:x")).toBe(false);
        expect(isEcdsaFrame("DKG_ROUND1:x")).toBe(false);
    });
});
