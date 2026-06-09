import Eth from "@ledgerhq/hw-app-eth";
import Solana from "@ledgerhq/hw-app-solana";
import type Transport from "@ledgerhq/hw-transport";
import bs58 from "bs58";
import type {
  Curve,
  EvmStructuredSigner,
  Secp256k1Signature,
  Signer,
  SignerContext,
  SignerKind,
} from "../signer";
import { openLedgerTransport } from "./transport";

/** BIP-44 default paths (account 0) for the two curves Ledger exposes. */
export const LEDGER_DEFAULT_EVM_PATH = "44'/60'/0'/0/0";
export const LEDGER_DEFAULT_SOLANA_PATH = "44'/501'/0'";

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/** Ledger returns v either as a hex string (signTransaction) or number
 * (signPersonalMessage); recovery id is its low bit. The EVM provider does the
 * final v assembly (EIP-155 / EIP-1559 yParity) exactly as it does for FROST. */
function recoveryFrom(v: string | number): number {
  const n = typeof v === "number" ? v : parseInt(v, 16);
  return n & 1;
}

/**
 * A Ledger on-device account presented as a {@link Signer}.
 *
 * Unlike FROST and YubiKey, a Ledger refuses to sign an arbitrary 32-byte
 * prehash — its apps hash the payload on-device after displaying it. So:
 *
 * - **Solana (ed25519)**: {@link signEd25519} maps cleanly — the "message" we
 *   pass *is* the transaction message Ledger signs.
 * - **EVM (secp256k1)**: {@link signSecp256k1} throws; callers must use the
 *   {@link EvmStructuredSigner} methods with the full tx / message instead.
 *
 * The transport (WebHID) must live in a user-facing context — see
 * `transport.ts`. This class is constructed there and the background routes
 * sign requests to it via messaging.
 */
export class LedgerSigner implements Signer, EvmStructuredSigner {
  readonly id: string;
  readonly kind: SignerKind = "ledger";

  constructor(
    readonly curve: Curve,
    private readonly addr: string,
    private readonly path: string,
    private readonly transport: Transport,
  ) {
    this.id = `ledger:${path}:${curve}`;
  }

  address(_ctx?: SignerContext): string {
    return this.addr;
  }

  async signEd25519(message: Uint8Array): Promise<Uint8Array> {
    if (this.curve !== "ed25519") {
      throw new Error(`Ledger account ${this.id} is not an ed25519 key`);
    }
    const solana = new Solana(this.transport);
    const { signature } = await solana.signTransaction(
      this.path,
      Buffer.from(message),
    );
    return new Uint8Array(signature);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async signSecp256k1(_prehash32: Uint8Array): Promise<Secp256k1Signature> {
    throw new Error(
      "Ledger cannot sign a raw prehash — use signEvmTransaction / signEvmPersonalMessage with the full payload",
    );
  }

  async signEvmTransaction(rawTxHex: string): Promise<Secp256k1Signature> {
    if (this.curve !== "secp256k1") {
      throw new Error(`Ledger account ${this.id} is not a secp256k1 key`);
    }
    const eth = new Eth(this.transport);
    const { r, s, v } = await eth.signTransaction(
      this.path,
      strip0x(rawTxHex),
      null,
    );
    return { r, s, recovery: recoveryFrom(v) };
  }

  async signEvmPersonalMessage(
    messageHex: string,
  ): Promise<Secp256k1Signature> {
    if (this.curve !== "secp256k1") {
      throw new Error(`Ledger account ${this.id} is not a secp256k1 key`);
    }
    const eth = new Eth(this.transport);
    const { r, s, v } = await eth.signPersonalMessage(
      this.path,
      strip0x(messageHex),
    );
    return { r, s, recovery: recoveryFrom(v) };
  }
}

/**
 * Build {@link LedgerSigner}s for the default EVM + Solana accounts on a
 * connected Ledger. `transport` should come from `requestLedgerTransport()`
 * (popup, user gesture); if omitted, we try an already-granted device and
 * return [] when none is present — so callers degrade gracefully like the
 * YubiKey discovery does.
 */
export async function discoverLedgerAccounts(
  transport?: Transport,
): Promise<LedgerSigner[]> {
  const t = transport ?? (await openLedgerTransport());
  if (!t) return [];

  const signers: LedgerSigner[] = [];

  // EVM (secp256k1). getAddress returns a checksummed 0x… string.
  try {
    const eth = new Eth(t);
    const { address } = await eth.getAddress(LEDGER_DEFAULT_EVM_PATH);
    signers.push(
      new LedgerSigner("secp256k1", address, LEDGER_DEFAULT_EVM_PATH, t),
    );
  } catch (e) {
    console.warn("[ledger] EVM account discovery skipped:", e);
  }

  // Solana (ed25519). getAddress returns the 32-byte pubkey; base58 it.
  try {
    const solana = new Solana(t);
    const { address } = await solana.getAddress(LEDGER_DEFAULT_SOLANA_PATH);
    signers.push(
      new LedgerSigner(
        "ed25519",
        bs58.encode(new Uint8Array(address)),
        LEDGER_DEFAULT_SOLANA_PATH,
        t,
      ),
    );
  } catch (e) {
    console.warn("[ledger] Solana account discovery skipped:", e);
  }

  return signers;
}
