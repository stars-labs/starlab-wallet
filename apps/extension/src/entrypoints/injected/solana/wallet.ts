/**
 * Starlab as a Solana **wallet-standard** wallet, so Solana dApps (Jupiter,
 * Magic Eden, Tensor, …) discover and use it the same way they use Phantom.
 *
 * The wallet object is built by {@link createStarlabSolanaWallet}, which takes a
 * {@link SolanaBridge} — the only side that touches the extension. Injecting the
 * bridge keeps all the wallet-standard wiring (account shape, feature methods,
 * tx (de)serialization) unit-testable with a fake bridge; the real bridge posts
 * through the same page→content→background channel the EVM provider uses, and
 * signing lands on the FROST ed25519 ceremony.
 */
import bs58 from "bs58";

export const SOLANA_CHAINS = [
  "solana:mainnet",
  "solana:devnet",
  "solana:testnet",
] as const;

const ACCOUNT_FEATURES = [
  "solana:signMessage",
  "solana:signTransaction",
  "solana:signAndSendTransaction",
] as const;

/**
 * The extension-facing side of the wallet. All I/O — and crucially all
 * @solana/web3.js transaction (de)serialization — lives behind this in the
 * background, so the page-injected bundle stays tiny (no web3.js on every page).
 */
export interface SolanaBridge {
  /** Prompt/return the connected account's base58 address. */
  connect(): Promise<string>;
  /** Sign raw message bytes with the account's ed25519 key → 64-byte signature. */
  signMessage(address: string, bytes: Uint8Array): Promise<Uint8Array>;
  /** Sign a serialized tx (background deserializes/signs/reserializes) → signed tx bytes. */
  signTransaction(address: string, tx: Uint8Array): Promise<Uint8Array>;
  /** Sign + broadcast a serialized tx → tx signature (base58). */
  signAndSendTransaction(address: string, tx: Uint8Array): Promise<string>;
}

interface WalletAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
  label?: string;
  icon?: string;
}

type ChangeListener = (props: { accounts: readonly WalletAccount[] }) => void;

const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4IiByeD0iNjQiIGZpbGw9IiM2MzY2RjEiLz4=" as const;

function toAccount(address: string): WalletAccount {
  return {
    address,
    publicKey: bs58.decode(address),
    chains: SOLANA_CHAINS,
    features: ACCOUNT_FEATURES,
  };
}

/**
 * Build the wallet-standard wallet object. Pure given a bridge — no globals
 * touched here; registration is separate (see register.ts).
 */
export function createStarlabSolanaWallet(bridge: SolanaBridge) {
  let accounts: WalletAccount[] = [];
  const listeners = new Set<ChangeListener>();

  const emitChange = () => {
    for (const l of listeners) l({ accounts });
  };

  async function connect() {
    if (accounts.length === 0) {
      const address = await bridge.connect();
      accounts = [toAccount(address)];
      emitChange();
    }
    return { accounts };
  }

  async function disconnect() {
    accounts = [];
    emitChange();
  }

  function on(event: string, listener: ChangeListener) {
    if (event !== "change") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function signMessage(
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ) {
    const out = [];
    for (const { account, message } of inputs) {
      const signature = await bridge.signMessage(account.address, message);
      out.push({ signedMessage: message, signature });
    }
    return out;
  }

  async function signTransaction(
    ...inputs: { account: WalletAccount; transaction: Uint8Array }[]
  ) {
    const out = [];
    for (const { account, transaction } of inputs) {
      // Background owns the @solana/web3.js (de)serialization + ed25519 sign.
      const signedTransaction = await bridge.signTransaction(
        account.address,
        transaction,
      );
      out.push({ signedTransaction });
    }
    return out;
  }

  async function signAndSendTransaction(
    ...inputs: { account: WalletAccount; transaction: Uint8Array }[]
  ) {
    const out = [];
    for (const { account, transaction } of inputs) {
      const sig = await bridge.signAndSendTransaction(
        account.address,
        transaction,
      );
      out.push({ signature: bs58.decode(sig) });
    }
    return out;
  }

  const wallet = {
    version: "1.0.0" as const,
    name: "Starlab Wallet",
    icon: ICON,
    chains: SOLANA_CHAINS,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": { version: "1.0.0" as const, connect },
      "standard:disconnect": { version: "1.0.0" as const, disconnect },
      "standard:events": { version: "1.0.0" as const, on },
      "solana:signMessage": { version: "1.0.0" as const, signMessage },
      "solana:signTransaction": {
        version: "1.0.0" as const,
        supportedTransactionVersions: new Set(["legacy", 0]),
        signTransaction,
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0" as const,
        supportedTransactionVersions: new Set(["legacy", 0]),
        signAndSendTransaction,
      },
    },
  };

  return wallet;
}

export type StarlabSolanaWallet = ReturnType<typeof createStarlabSolanaWallet>;
