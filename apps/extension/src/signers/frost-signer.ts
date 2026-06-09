import type { Curve, Secp256k1Signature, Signer, SignerContext } from "./signer";

/**
 * Backend hooks the FROST flow already implements (offscreen WebRTC + the
 * `@starlab/core-wasm` engine, driven through the background RpcHandler /
 * SessionManager — see the signing pipeline in the extension docs). `FrostSigner`
 * is a thin facade over these; it does NOT reimplement the threshold ceremony.
 */
export interface FrostBackend {
  address(curve: Curve, chain?: string): string;
  signEd25519(message: Uint8Array): Promise<Uint8Array>;
  signSecp256k1(prehash32: Uint8Array): Promise<Secp256k1Signature>;
}

/**
 * A FROST/MPC account presented as a generic {@link Signer}. Lets the EIP-1193
 * provider and tx-building code treat a threshold wallet exactly like any other
 * account; the multi-device ceremony stays where it is, behind `backend`.
 */
export class FrostSigner implements Signer {
  readonly kind = "frost" as const;

  constructor(
    readonly id: string,
    readonly curve: Curve,
    private readonly backend: FrostBackend,
  ) {}

  address(ctx?: SignerContext): string {
    return this.backend.address(this.curve, ctx?.chain);
  }

  signEd25519(message: Uint8Array): Promise<Uint8Array> {
    return this.backend.signEd25519(message);
  }

  signSecp256k1(prehash32: Uint8Array): Promise<Secp256k1Signature> {
    return this.backend.signSecp256k1(prehash32);
  }
}
