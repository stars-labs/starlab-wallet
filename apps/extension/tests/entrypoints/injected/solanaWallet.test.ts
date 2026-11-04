/**
 * Solana wallet-standard factory tests. The page registration + postMessage
 * bridge can't run headless, but the wallet object — feature shape, connect
 * lifecycle, and that signMessage / signTransaction route to the bridge with
 * the right bytes — is pure given a fake bridge, so that's what's asserted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import {
  Keypair,
  type Blockhash,
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
import { REAL_WEBCRYPTO } from "../../setup-bun";
const previousCrypto = globalThis.crypto;
let KP: Keypair;
let ADDRESS: string;
beforeAll(async () => {
  (globalThis as any).crypto = REAL_WEBCRYPTO;
  KP = await Keypair.generate();
  ADDRESS = KP.publicKey.toBase58();
});
beforeEach(() => { (globalThis as any).crypto = REAL_WEBCRYPTO; });
afterEach(() => { (globalThis as any).crypto = previousCrypto; });

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

  it("background v3 transaction serialization preserves a real Ed25519 signature", async () => {
    const { RpcHandler } = await import("../../../src/entrypoints/background/rpcHandler");
    const message = new TransactionMessage({
      payerKey: KP.publicKey,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)) as Blockhash,
      instructions: [SystemProgram.transfer({
        fromPubkey: KP.publicKey,
        toPubkey: new PublicKey("11111111111111111111111111111111"),
        lamports: 1,
      })],
    }).compileToV0Message();
    const unsigned = new VersionedTransaction(message).serialize();
    const handler = Object.create(RpcHandler.prototype);
    handler.handleSolanaSignBytes = async ([address, hex]: string[]) => {
      expect(address).toBe(ADDRESS);
      const bytes = Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
      expect([...bytes]).toEqual([...message.serialize()]);
      const signature = await REAL_WEBCRYPTO.subtle.sign("Ed25519", KP.keyPair.privateKey, bytes);
      return Buffer.from(signature).toString("hex");
    };
    const signedHex = await handler.handleSolanaSignTransaction([
      ADDRESS, Buffer.from(unsigned).toString("hex"),
    ]);
    const signed = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(signedHex.replace(/^0x/, ""), "hex")));
    expect(signed.message.serialize()).toEqual(message.serialize());
    expect(await REAL_WEBCRYPTO.subtle.verify("Ed25519", KP.keyPair.publicKey,
      signed.signatures[0], signed.message.serialize())).toBe(true);
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
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)) as Blockhash,
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
