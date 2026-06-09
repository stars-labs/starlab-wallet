import type { Curve, Secp256k1Signature, Signer, SignerContext, SignerKind } from "../signer";
import { HostClient } from "./host-client";
import type { Account } from "./types";

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * A YubiKey on-card account presented as a generic {@link Signer}. Signing is
 * delegated to the `yubiwallet` native host over `chrome.runtime.connectNative`
 * (the card does the actual ECDSA/EdDSA; the PIN is collected by the host, never
 * passed through here). Lives in the background service worker.
 */
export class YubiKeySigner implements Signer {
  readonly id: string;
  readonly kind: SignerKind;
  readonly curve: Curve;

  constructor(
    private readonly account: Account,
    private readonly host: HostClient,
  ) {
    this.id = account.id; // e.g. "piv:9a:ed25519"
    this.curve = account.curve;
    this.kind = account.applet === "openpgp" ? "yubikey-openpgp" : "yubikey-piv";
  }

  address(_ctx?: SignerContext): string {
    return this.account.address;
  }

  async signEd25519(message: Uint8Array): Promise<Uint8Array> {
    if (this.curve !== "ed25519") {
      throw new Error(`account ${this.id} is not an ed25519 key`);
    }
    const { signature } = await this.host.signEd25519(this.id, bytesToHex(message));
    return hexToBytes(signature);
  }

  async signSecp256k1(prehash32: Uint8Array): Promise<Secp256k1Signature> {
    if (this.curve !== "secp256k1") {
      throw new Error(`account ${this.id} is not a secp256k1 key`);
    }
    if (prehash32.length !== 32) {
      throw new Error(`expected a 32-byte prehash, got ${prehash32.length}`);
    }
    const { r, s, recovery_id } = await this.host.signSecp256k1(this.id, bytesToHex(prehash32));
    return { r, s, recovery: recovery_id };
  }
}

/**
 * Open the native host and build a {@link YubiKeySigner} for every account the
 * card exposes. Returns an empty list (not an error) if the host isn't
 * installed/reachable — YubiKey accounts simply won't appear, FROST still works.
 */
export async function discoverYubiKeyAccounts(): Promise<YubiKeySigner[]> {
  try {
    const host = new HostClient();
    const { accounts } = await host.listAccounts();
    return accounts.map((a) => new YubiKeySigner(a, host));
  } catch {
    return [];
  }
}
