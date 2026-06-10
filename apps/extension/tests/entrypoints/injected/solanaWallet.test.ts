/**
 * Solana wallet-standard factory tests. The page registration + postMessage
 * bridge can't run headless, but the wallet object — feature shape, connect
 * lifecycle, and that signMessage / signTransaction route to the bridge with
 * the right bytes — is pure given a fake bridge, so that's what's asserted.
 */
import { describe, it, expect } from "bun:test";
import {
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  createStarlabSolanaWallet,
  SOLANA_CHAINS,
  type SolanaBridge,
} from "../../../src/entrypoints/injected/solana/wallet";

// A deterministic account to act as "the wallet".
const KP = Keypair.generate();
const ADDRESS = KP.publicKey.toBase58();

function fakeBridge(overrides: Partial<SolanaBridge> = {}): SolanaBridge {
  return {
    connect: async () => ADDRESS,
    signBytes: async (_addr, bytes) => {
      // return a deterministic 64-byte "signature" derived from input length
      const sig = new Uint8Array(64);
      sig[0] = bytes.length & 0xff;
      return sig;
    },
    sendRawTransaction: async () => bs58.encode(new Uint8Array(64)),
    ...overrides,
  };
}

describe("createStarlabSolanaWallet", () => {
  it("exposes the wallet-standard feature set", () => {
    const w = createStarlabSolanaWallet(fakeBridge());
    expect(w.name).toBe("Starlab Wallet");
    expect(w.chains).toEqual(SOLANA_CHAINS);
    expect(Object.keys(w.features).sort()).toEqual(
      [
        "solana:signAndSendTransaction",
        "solana:signMessage",
        "solana:signTransaction",
        "standard:connect",
        "standard:disconnect",
        "standard:events",
      ].sort(),
    );
  });

  it("connect populates accounts; disconnect clears", async () => {
    const w = createStarlabSolanaWallet(fakeBridge());
    expect(w.accounts.length).toBe(0);
    const { accounts } = await w.features["standard:connect"].connect();
    expect(accounts.length).toBe(1);
    expect(accounts[0].address).toBe(ADDRESS);
    // publicKey bytes match the base58 address
    expect(bs58.encode(accounts[0].publicKey)).toBe(ADDRESS);
    expect(w.accounts.length).toBe(1);

    await w.features["standard:disconnect"].disconnect();
    expect(w.accounts.length).toBe(0);
  });

  it("emits a change event on connect", async () => {
    const w = createStarlabSolanaWallet(fakeBridge());
    let fired = 0;
    w.features["standard:events"].on("change", () => fired++);
    await w.features["standard:connect"].connect();
    expect(fired).toBe(1);
  });

  it("signMessage routes the exact bytes to the bridge", async () => {
    let seen: Uint8Array | null = null;
    const w = createStarlabSolanaWallet(
      fakeBridge({
        signBytes: async (_a, bytes) => {
          seen = bytes;
          return new Uint8Array(64);
        },
      }),
    );
    const { accounts } = await w.features["standard:connect"].connect();
    const msg = new TextEncoder().encode("hello solana");
    const [out] = await w.features["solana:signMessage"].signMessage({
      account: accounts[0],
      message: msg,
    });
    expect(seen).toEqual(msg);
    expect(out.signedMessage).toEqual(msg);
    expect(out.signature.length).toBe(64);
  });

  it("signTransaction signs the message bytes and reattaches the signature", async () => {
    // Build a real (unsigned) v0 transaction from this account.
    const ix = SystemProgram.transfer({
      fromPubkey: KP.publicKey,
      toPubkey: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
    });
    const msg = new TransactionMessage({
      payerKey: KP.publicKey,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)),
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const serialized = tx.serialize();

    let signedBytes: Uint8Array | null = null;
    const w = createStarlabSolanaWallet(
      fakeBridge({
        signBytes: async (_a, bytes) => {
          signedBytes = bytes; // the wallet must hand us the tx *message* bytes
          return new Uint8Array(64).fill(7);
        },
      }),
    );
    const { accounts } = await w.features["standard:connect"].connect();
    const [out] = await w.features["solana:signTransaction"].signTransaction({
      account: accounts[0],
      transaction: serialized,
    });

    // The bridge was asked to sign exactly the transaction's compiled message.
    expect(signedBytes).toEqual(msg.serialize());
    // Round-trips back to a VersionedTransaction with the signature reattached.
    const signed = VersionedTransaction.deserialize(out.signedTransaction);
    expect(signed.signatures.length).toBe(1);
    expect(signed.signatures[0].length).toBe(64);
    expect(signed.signatures[0][0]).toBe(7);
  });
});
