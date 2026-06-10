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
    signMessage: async (_addr, bytes) => {
      // deterministic 64-byte "signature" derived from input length
      const sig = new Uint8Array(64);
      sig[0] = bytes.length & 0xff;
      return sig;
    },
    signTransaction: async (_addr, tx) => {
      // background returns the "signed" serialized tx; echo a marker
      const out = new Uint8Array(tx.length + 1);
      out.set(tx);
      out[tx.length] = 0xff;
      return out;
    },
    signAndSendTransaction: async () => bs58.encode(new Uint8Array(64)),
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
        signMessage: async (_a, bytes) => {
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
    expect(seen!).toEqual(msg);
    expect(out.signedMessage).toEqual(msg);
    expect(out.signature.length).toBe(64);
  });

  it("signTransaction forwards the serialized tx to the bridge (background owns web3.js)", async () => {
    // A real serialized v0 tx, just to have realistic bytes to forward.
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
    const serialized = new VersionedTransaction(msg).serialize();

    let forwarded: Uint8Array | null = null;
    const w = createStarlabSolanaWallet(
      fakeBridge({
        signTransaction: async (_a, tx) => {
          forwarded = tx;
          return new Uint8Array([1, 2, 3]); // background's "signed tx"
        },
      }),
    );
    const { accounts } = await w.features["standard:connect"].connect();
    const [out] = await w.features["solana:signTransaction"].signTransaction({
      account: accounts[0],
      transaction: serialized,
    });

    // The wallet forwards the exact serialized tx and returns what the bridge gives.
    expect(forwarded!).toEqual(serialized);
    expect(Array.from(out.signedTransaction)).toEqual([1, 2, 3]);
  });
});
