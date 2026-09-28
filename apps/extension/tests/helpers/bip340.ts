/**
 * Minimal BIP-340 verifier + bech32m (BIP-350) decoder for tests. Pure
 * BigInt secp256k1 — slow but dependency-free; test-only.
 */
import { createHash } from "node:crypto";

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Point = [
    0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];
type Point = [bigint, bigint] | null;

const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function pow(b: bigint, e: bigint, m = P): bigint {
    let r = 1n;
    b = mod(b, m);
    for (; e > 0n; e >>= 1n, b = mod(b * b, m)) if (e & 1n) r = mod(r * b, m);
    return r;
}
function add(a: Point, b: Point): Point {
    if (!a) return b;
    if (!b) return a;
    if (a[0] === b[0] && a[1] !== b[1]) return null;
    const l =
        a[0] === b[0]
            ? mod(3n * a[0] * a[0] * pow(2n * a[1], P - 2n))
            : mod((b[1] - a[1]) * pow(b[0] - a[0], P - 2n));
    const x = mod(l * l - a[0] - b[0]);
    return [x, mod(l * (a[0] - x) - a[1])];
}
function mul(p: Point, k: bigint): Point {
    let r: Point = null;
    for (; k > 0n; k >>= 1n, p = add(p, p)) if (k & 1n) r = add(r, p);
    return r;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const int = (b: Uint8Array) => BigInt("0x" + hex(b));
function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
    const t = createHash("sha256").update(tag).digest();
    const h = createHash("sha256").update(t).update(t);
    for (const p of parts) h.update(p);
    return h.digest();
}

/** BIP-340 verify: 32-byte x-only key, message bytes, 64-byte signature. */
export function schnorrVerify(pubkey: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
    if (pubkey.length !== 32 || sig.length !== 64) return false;
    const x = int(pubkey);
    if (x >= P) return false;
    const c = mod(x ** 3n + 7n);
    const y = pow(c, (P + 1n) / 4n);
    if (mod(y * y) !== c) return false;
    const Pt: Point = [x, y % 2n === 0n ? y : P - y];
    const r = int(sig.slice(0, 32));
    const s = int(sig.slice(32));
    if (r >= P || s >= N) return false;
    const e = mod(int(taggedHash("BIP0340/challenge", sig.slice(0, 32), pubkey, msg)), N);
    const R = add(mul(G, s), mul(Pt, N - e));
    return !!R && R[1] % 2n === 0n && R[0] === r;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
    }
    return chk >>> 0;
}

/** Witness program of a bech32m (segwit v1+) address, e.g. a bc1p key. */
export function segwitV1Program(address: string): Uint8Array {
    const addr = address.toLowerCase();
    const sep = addr.lastIndexOf("1");
    const hrp = addr.slice(0, sep);
    const data = [...addr.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
    const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
    if (polymod([...expanded, ...data]) !== 0x2bc830a3) throw new Error(`bad bech32m checksum: ${address}`);
    const words = data.slice(1, -6); // drop witness version + checksum
    let acc = 0;
    let bits = 0;
    const out: number[] = [];
    for (const w of words) {
        acc = (acc << 5) | w;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return Uint8Array.from(out);
}
