/**
 * The signer seam for Starlab Wallet.
 *
 * Every account in the wallet — FROST/MPC, YubiKey hardware, … — is reachable
 * through this one interface, so the EIP-1193 provider, transaction building and
 * dApp wiring don't care which backend actually produces the signature.
 */

export type SignerKind =
  | "frost"
  | "yubikey-piv"
  | "yubikey-openpgp"
  | "ledger";

export type Curve = "ed25519" | "secp256k1";

/** secp256k1 result: EIP-155 r/s (hex, 32B each) + recovery (0/1) → assemble v. */
export interface Secp256k1Signature {
  r: string;
  s: string;
  /** recovery id (0 or 1); caller computes v = recovery + 27 / EIP-155. */
  recovery: number;
}

export interface SignerContext {
  /** Chain hint for address encoding (e.g. "solana", "ethereum"). */
  chain?: string;
}

export interface Signer {
  /** Stable account id (e.g. a FROST wallet id, or `piv:9a:ed25519`). */
  readonly id: string;
  readonly kind: SignerKind;
  readonly curve: Curve;

  /** Address for this account (base58 for Solana, 0x… for EVM). */
  address(ctx?: SignerContext): string;

  /** ed25519 detached signature (64 bytes) — Solana / Sui. */
  signEd25519(message: Uint8Array): Promise<Uint8Array>;

  /** secp256k1 signature over a 32-byte prehash — EVM / Bitcoin. */
  signSecp256k1(prehash32: Uint8Array): Promise<Secp256k1Signature>;
}

/**
 * Structured-payload EVM signing, for hardware signers that refuse a raw
 * prehash and insist on the full transaction / message so the device can
 * display and hash it itself (Ledger, Trezor, …).
 *
 * FROST and YubiKey sign an arbitrary 32-byte prehash and so satisfy
 * {@link Signer.signSecp256k1} directly; a Ledger cannot, so it throws from
 * `signSecp256k1` and implements these instead. The EVM provider should
 * prefer these when the resolved signer advertises them
 * (see {@link isEvmStructuredSigner}).
 */
export interface EvmStructuredSigner {
  /** Sign an RLP-encoded EVM transaction (hex, no 0x). */
  signEvmTransaction(rawTxHex: string): Promise<Secp256k1Signature>;
  /** Sign an `eth_sign` / `personal_sign` message (hex, no 0x). */
  signEvmPersonalMessage(messageHex: string): Promise<Secp256k1Signature>;
}

export function isEvmStructuredSigner(
  s: Signer,
): s is Signer & EvmStructuredSigner {
  return (
    typeof (s as Partial<EvmStructuredSigner>).signEvmTransaction ===
      "function" &&
    typeof (s as Partial<EvmStructuredSigner>).signEvmPersonalMessage ===
      "function"
  );
}
