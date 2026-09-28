/**
 * The engine's (TUI / desktop / CLI) key-share blob ⇄ the core-wasm
 * keystore JSON the extension stores.
 *
 * Engine blob (starlab-client `encode_keystore_blob`):
 *   [kp_len: u32 LE][KeyPackage][pkp_len: u32 LE][PublicKeyPackage]
 * where each package is frost-core 3.0 `serialize()` — postcard:
 *   header      = version u8 (0) · ciphersuite short id (CRC-32 of the
 *                 suite name, 4 bytes big-endian)
 *   scalar/elem = raw fixed-size bytes (serdect "bin": scalars 32,
 *                 elements 33 for secp256k1 / 32 for ed25519)
 *   u16         = varint (LEB128)
 *   KeyPackage       = header · identifier · signing_share ·
 *                      verifying_share · verifying_key · min_signers
 *   PublicKeyPackage = header · varint n · n×(identifier · verifying_share)
 *                      · verifying_key · [Option<u16> min_signers: 01 varint]
 *
 * core-wasm keystore JSON carries the same packages as base64 of their
 * serde_json form (hex strings, suite name in the header).
 */
import { parseEngineKeystore, type EngineKeystore } from "./engineKeystore";

const SUITES: Record<"secp256k1" | "ed25519", string> = {
    secp256k1: "FROST-secp256k1-SHA256-TR-v1",
    ed25519: "FROST-ED25519-SHA512-v1",
};

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function shortId(suite: string): string {
    return crc32(new TextEncoder().encode(suite)).toString(16).padStart(8, "0");
}

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (h) => parseInt(h, 16));
const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64ToText = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const textToB64 = (text: string) => {
    let bin = "";
    for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
    return btoa(bin);
};

class Writer {
    private out: number[] = [];
    byte(b: number) { this.out.push(b); }
    raw(bytes: Uint8Array) { for (const b of bytes) this.out.push(b); }
    varint(n: number) {
        do {
            let b = n & 0x7f;
            n = Math.floor(n / 128);
            if (n > 0) b |= 0x80;
            this.out.push(b);
        } while (n > 0);
    }
    bytes(hex: string) { this.raw(hexToBytes(hex)); }
    header(suite: string) { this.byte(0); this.raw(hexToBytes(shortId(suite))); }
    done() { return Uint8Array.from(this.out); }
}

class Reader {
    private pos = 0;
    constructor(private buf: Uint8Array) {}
    private take(n: number): Uint8Array {
        if (this.pos + n > this.buf.length) throw new Error("Key share blob is truncated");
        const s = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return s;
    }
    byte() { return this.take(1)[0]; }
    varint(): number {
        let n = 0;
        for (let shift = 0; shift < 35; shift += 7) {
            const b = this.byte();
            n += (b & 0x7f) * 2 ** shift;
            if (!(b & 0x80)) return n;
        }
        throw new Error("Key share blob has a malformed varint");
    }
    bytes(n: number) { return bytesToHex(this.take(n)); }
    header(): string {
        if (this.byte() !== 0) throw new Error("Unsupported FROST package version");
        const id = bytesToHex(this.take(4));
        const suite = Object.values(SUITES).find((s) => shortId(s) === id);
        if (!suite) {
            throw new Error(
                "Not a supported FROST share (secp256k1 must be the BIP-340/Taproot suite; pre-Taproot shares are not supported)",
            );
        }
        return suite;
    }
    u32le() { const b = this.take(4); return (b[0] | (b[1] << 8) | (b[2] << 16)) + b[3] * 2 ** 24; }
    sub(n: number) { return new Reader(this.take(n)); }
    atEnd() { return this.pos === this.buf.length; }
}

function curveOfSuite(suite: string): "secp256k1" | "ed25519" {
    return suite === SUITES.secp256k1 ? "secp256k1" : "ed25519";
}

/** FROST identifier scalar → its small integer (secp256k1 big-endian, ed25519 little-endian). */
function identifierIndex(hex: string, curve: "secp256k1" | "ed25519"): number {
    const bytes = hexToBytes(hex);
    const ordered = curve === "secp256k1" ? bytes : bytes.slice().reverse();
    let n = 0;
    for (const b of ordered) n = n * 256 + b;
    if (!Number.isSafeInteger(n) || n <= 0 || n > 0xffff) throw new Error(`Unsupported FROST identifier ${hex}`);
    return n;
}

/** core-wasm keystore JSON → engine blob. */
export function engineBlobFromKeystore(keystoreJson: string): Uint8Array<ArrayBuffer> {
    const ks = parseEngineKeystore(keystoreJson);
    const kp = JSON.parse(b64ToText(ks.key_package));
    const pkp = JSON.parse(b64ToText(ks.public_key_package));

    const k = new Writer();
    k.header(kp.header.ciphersuite);
    k.bytes(kp.identifier);
    k.bytes(kp.signing_share);
    k.bytes(kp.verifying_share);
    k.bytes(kp.verifying_key);
    k.varint(kp.min_signers);

    const p = new Writer();
    p.header(pkp.header.ciphersuite);
    const shares = Object.entries(pkp.verifying_shares as Record<string, string>);
    p.varint(shares.length);
    for (const [id, share] of shares) {
        p.bytes(id);
        p.bytes(share);
    }
    p.bytes(pkp.verifying_key);
    if (pkp.min_signers != null) {
        p.byte(1);
        p.varint(pkp.min_signers);
    }

    const kb = k.done();
    const pb = p.done();
    const out = new Uint8Array(8 + kb.length + pb.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, kb.length, true);
    out.set(kb, 4);
    view.setUint32(4 + kb.length, pb.length, true);
    out.set(pb, 8 + kb.length);
    return out;
}

/**
 * Engine blob → core-wasm keystore JSON plus the group key it carries.
 * `total` is the wallet's n (the blob only knows the current holders).
 */
export function keystoreFromEngineBlob(
    blob: Uint8Array,
    total: number,
): { keystoreJson: string; groupPublicKey: string } {
    const r = new Reader(blob);
    const kr = r.sub(r.u32le());
    const pr = r.sub(r.u32le());
    if (!r.atEnd()) throw new Error("Key share blob has trailing bytes");

    const suite = kr.header();
    const curve = curveOfSuite(suite);
    const SCALAR = 32;
    const ELEMENT = curve === "secp256k1" ? 33 : 32;
    const kp = {
        header: { version: 0, ciphersuite: suite },
        identifier: kr.bytes(SCALAR),
        signing_share: kr.bytes(SCALAR),
        verifying_share: kr.bytes(ELEMENT),
        verifying_key: kr.bytes(ELEMENT),
        min_signers: kr.varint(),
    };
    if (!kr.atEnd()) throw new Error("KeyPackage has trailing bytes");

    if (pr.header() !== suite) throw new Error("KeyPackage and PublicKeyPackage use different ciphersuites");
    const verifying_shares: Record<string, string> = {};
    const n = pr.varint();
    for (let i = 0; i < n; i++) verifying_shares[pr.bytes(SCALAR)] = pr.bytes(ELEMENT);
    const verifying_key = pr.bytes(ELEMENT);
    const min_signers = !pr.atEnd() && pr.byte() === 1 ? pr.varint() : null;
    if (!pr.atEnd()) throw new Error("PublicKeyPackage has trailing bytes");
    if (verifying_key !== kp.verifying_key) {
        throw new Error("Key share is inconsistent: KeyPackage and PublicKeyPackage disagree on the group key");
    }
    const pkp = {
        header: { version: 0, ciphersuite: suite },
        verifying_shares,
        verifying_key,
        ...(min_signers != null ? { min_signers } : {}),
    };

    const engine: EngineKeystore = {
        key_package: textToB64(JSON.stringify(kp)),
        public_key_package: textToB64(JSON.stringify(pkp)),
        min_signers: kp.min_signers,
        max_signers: total,
        participant_index: identifierIndex(kp.identifier, curve),
        participant_indices: Object.keys(verifying_shares).map((id) => identifierIndex(id, curve)).sort((a, b) => a - b),
        curve,
    };
    return { keystoreJson: JSON.stringify(engine), groupPublicKey: verifying_key };
}
