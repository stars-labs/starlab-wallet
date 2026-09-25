import type { Signer } from "./signer";

/**
 * Maps an account id → its {@link Signer} backend. The provider looks a signer
 * up here and calls it, blind to whether it's FROST, YubiKey, etc.
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
