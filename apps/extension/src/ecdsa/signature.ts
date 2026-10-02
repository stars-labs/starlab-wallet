import type { Secp256k1Signature } from "../signers/signer";

/**
 * Split a threshold-ECDSA signature — hex `r ‖ s ‖ v` (65 bytes, low-s,
 * v = 27 + recovery id, the engine's / personal_sign's form) — into the
 * parts a typed transaction takes (`yParity = v - 27`).
 */
export function signatureParts(sigHex: string): Secp256k1Signature {
    const hex = sigHex.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error(`an ECDSA signature is 65 bytes, got ${hex.length / 2}`);
    const v = parseInt(hex.slice(128, 130), 16);
    if (v !== 27 && v !== 28) throw new Error(`bad recovery byte v = ${v}`);
    return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, recovery: v - 27 };
}
