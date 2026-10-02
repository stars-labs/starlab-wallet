/**
 * Data-channel framing of the threshold-ECDSA engine — byte-identical to
 * starlab-mpc's `apps/tui/src/protocal/ecdsa/wire.rs` (IMPLEMENTATION_PLAN
 * Stage 2 "Wire format"). Pure, no I/O.
 *
 * Every frame is a `SimpleMessage` text on the WebRTC data channel; the
 * sender is the channel's peer:
 *
 *   ECDSA:<id>:<index>:<count>:<base64 chunk>      protocol message chunk
 *   ECDSA_SIGN_READY:<base64 JSON {"session_id"}>  would-be signer → proposer
 *   ECDSA_SIGN_SET:<base64 JSON {"session_id","signers":[device ids]}>
 *   ECDSA_SIGN_DONE:<base64 JSON {"session_id","signature":"<hex r‖s‖v>"}>
 *
 * A protocol message is one core-wasm ceremony payload (35-byte header +
 * CBOR), split into ≤ 16 KiB chunks: `<id>` = lowercase hex of the first
 * 8 bytes of SHA-256(payload), `<index>` 0-based, `<count>` 1..=64, base64
 * standard with padding. Receivers reassemble per (sender, id) and check
 * the digest.
 */
import { Buffer } from "buffer";
import { sha256 } from "viem";

export const FRAME_PREFIX = "ECDSA:";
export const SIGN_READY_PREFIX = "ECDSA_SIGN_READY:";
export const SIGN_SET_PREFIX = "ECDSA_SIGN_SET:";
export const SIGN_DONE_PREFIX = "ECDSA_SIGN_DONE:";
export type ControlPrefix = typeof SIGN_READY_PREFIX | typeof SIGN_SET_PREFIX | typeof SIGN_DONE_PREFIX;

/** Every frame kind the ECDSA engine owns. */
export const PREFIXES = [FRAME_PREFIX, SIGN_READY_PREFIX, SIGN_SET_PREFIX, SIGN_DONE_PREFIX] as const;

export const CHUNK_SIZE = 16 * 1024;
const MAX_CHUNKS = 64;
const MAX_PARTIAL = 256;

export function isEcdsaFrame(text: string): boolean {
    return PREFIXES.some((p) => text.startsWith(p));
}

export function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function fromBase64(text: string): Uint8Array {
    if (!BASE64_RE.test(text)) throw new Error("invalid base64");
    return new Uint8Array(Buffer.from(text, "base64"));
}

function messageId(payload: Uint8Array): string {
    return sha256(payload).slice(2, 18);
}

/** Split one ceremony payload into its `ECDSA:` frames. */
export function encodeFrames(payload: Uint8Array): string[] {
    const id = messageId(payload);
    const chunks: Uint8Array[] = [];
    if (payload.length === 0) chunks.push(payload);
    for (let i = 0; i < payload.length; i += CHUNK_SIZE) chunks.push(payload.subarray(i, i + CHUNK_SIZE));
    return chunks.map((c, i) => `${FRAME_PREFIX}${id}:${i}:${chunks.length}:${toBase64(c)}`);
}

export interface Chunk {
    id: string;
    index: number;
    count: number;
    data: Uint8Array;
}

const DECIMAL_RE = /^\d{1,5}$/;

/** Parse the text after `ECDSA:`. Throws on anything malformed. */
export function parseChunk(rest: string): Chunk {
    const parts = rest.split(":");
    if (parts.length !== 4) throw new Error("malformed ECDSA frame");
    const [id, index, count, b64] = parts;
    if (!/^[0-9a-fA-F]{16}$/.test(id)) throw new Error(`bad ECDSA message id ${JSON.stringify(id)}`);
    if (!DECIMAL_RE.test(index) || !DECIMAL_RE.test(count)) throw new Error("bad ECDSA chunk index/count");
    const i = Number(index);
    const n = Number(count);
    if (n === 0 || n > MAX_CHUNKS || i >= n) throw new Error(`bad ECDSA chunk ${i}/${n}`);
    return { id: id.toLowerCase(), index: i, count: n, data: fromBase64(b64) };
}

interface Partial {
    count: number;
    chunks: Map<number, Uint8Array>;
    seq: number;
}

/** Reassembles chunked messages per (sender, message id). */
export class Reassembler {
    private partial = new Map<string, Partial>();
    private seq = 0;

    /** Returns the whole payload once its last chunk arrived and the digest
     * matches; null while incomplete. Repeated chunks are harmless. */
    push(from: string, chunk: Chunk): Uint8Array | null {
        const key = `${from}\u0000${chunk.id}`;
        if (!this.partial.has(key) && this.partial.size >= MAX_PARTIAL) {
            let oldest: string | null = null;
            let min = Infinity;
            for (const [k, p] of this.partial) {
                if (p.seq < min) {
                    min = p.seq;
                    oldest = k;
                }
            }
            if (oldest !== null) this.partial.delete(oldest);
        }
        this.seq += 1;
        let entry = this.partial.get(key);
        if (!entry) {
            entry = { count: chunk.count, chunks: new Map(), seq: this.seq };
            this.partial.set(key, entry);
        }
        if (entry.count !== chunk.count) {
            this.partial.delete(key);
            throw new Error(`ECDSA message ${chunk.id} from ${from}: inconsistent chunk count`);
        }
        entry.chunks.set(chunk.index, chunk.data);
        if (entry.chunks.size < entry.count) return null;
        this.partial.delete(key);
        let len = 0;
        for (const c of entry.chunks.values()) len += c.length;
        const payload = new Uint8Array(len);
        let off = 0;
        for (let i = 0; i < entry.count; i++) {
            const c = entry.chunks.get(i)!;
            payload.set(c, off);
            off += c.length;
        }
        if (messageId(payload) !== chunk.id) {
            throw new Error(`ECDSA message ${chunk.id} from ${from}: digest mismatch`);
        }
        return payload;
    }
}

/** Body of the three signing control frames (JSON, then base64). Field
 * order and omission of empty fields match the engine's serde output. */
export interface Control {
    session_id: string;
    /** ECDSA_SIGN_SET only: the fixed signer set (device ids). */
    signers?: string[];
    /** ECDSA_SIGN_DONE only: hex of the 65-byte r ‖ s ‖ v. */
    signature?: string;
}

export function encodeControl(prefix: ControlPrefix, c: Control): string {
    const body: Record<string, unknown> = { session_id: c.session_id };
    if (c.signers && c.signers.length > 0) body.signers = c.signers;
    if (c.signature) body.signature = c.signature;
    return prefix + toBase64(new TextEncoder().encode(JSON.stringify(body)));
}

export function decodeControl(b64: string): Control {
    const raw = JSON.parse(new TextDecoder().decode(fromBase64(b64))) as Record<string, unknown>;
    if (typeof raw.session_id !== "string") throw new Error("ECDSA control frame without session_id");
    const signers = Array.isArray(raw.signers) ? raw.signers.filter((s): s is string => typeof s === "string") : [];
    const signature = typeof raw.signature === "string" ? raw.signature : "";
    return { session_id: raw.session_id, signers, signature };
}
