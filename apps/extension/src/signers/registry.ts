import type { Signer } from "./signer";

/**
 * Maps an account id → its {@link Signer} backend. The provider looks a signer
 * up here and calls it, blind to whether it's FROST, YubiKey, etc.
 *
 * Today only `FrostSigner`s are registered. Next backends:
 * - TODO(yubikey): `YubiKeySigner` driving `chrome.runtime.connectNative(
 *     "com.yubiwallet.host")` → the stars-labs/yubiwallet host
 *     (list_accounts / sign_ed25519 / sign_secp256k1). Needs the host installed
 *     + a GUI pinentry in the host.
 * - TODO(sandbox): a Network registry whose "sandbox" entries point RPC at a
 *     local fork node (anvil / surfpool) with funding + reset helpers — real
 *     signing + broadcast against a simulated chain, no real funds.
 */
export class SignerRegistry {
  private readonly signers = new Map<string, Signer>();

  register(signer: Signer): void {
    this.signers.set(signer.id, signer);
  }

  get(id: string): Signer | undefined {
    return this.signers.get(id);
  }

  all(): Signer[] {
    return [...this.signers.values()];
  }
}
