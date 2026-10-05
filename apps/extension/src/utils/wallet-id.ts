/**
 * Wallet id derived from the DKG session id — the same derivation as
 * starlab-mpc's `wallet_id_from_session`. The session id is identical on
 * every participant, so every device (extension, CLI, TUI) ends up with the
 * same id, which signing/reshare announces use to name the wallet.
 */
export function walletIdFromSession(sessionId: string): string {
    const hex = [...sessionId].filter((c) => /[0-9a-fA-F]/.test(c)).slice(0, 12).join("");
    if (hex.length >= 8) return hex;
    const alnum = [...sessionId].filter((c) => /[0-9a-zA-Z]/.test(c)).slice(0, 12).join("");
    return alnum || "wallet";
}

/**
 * Id of a wallet's BIP-44 account child — starlab-mpc's
 * `ensure_account_wallet` naming. Signing announces name this child: CLI/TUI
 * co-signers load (or derive on first use) its share, the same account key
 * the extension signs with; the root key never signs.
 */
export function accountWalletId(parentId: string, chain: string, account: number): string {
    return `${parentId}-${chain}-${account}`;
}

/**
 * Wallet invitations worth offering (DKG to create a wallet, reshare of a
 * held one). A finished DKG stays on the signal server (and is replayed on
 * reconnect), so drop DKG sessions whose wallet this device already holds.
 * Signing requests are not wallet invitations — they have their own
 * review modal.
 */
export function openInvites<T extends { session_id: string; session_type?: string }>(
    invites: T[],
    heldWalletIds: string[],
): T[] {
    const held = new Set(heldWalletIds);
    return invites.filter((inv) => {
        const type = inv.session_type ?? "dkg";
        if (type === "signing") return false;
        return type !== "dkg" || !held.has(walletIdFromSession(inv.session_id));
    });
}

const CHAIN_CURVES: Record<string, "secp256k1" | "ed25519"> = {
    ethereum: "secp256k1",
    eth: "secp256k1",
    bitcoin: "secp256k1",
    btc: "secp256k1",
    solana: "ed25519",
    sol: "ed25519",
    sui: "ed25519",
};

/** Curve tag of the wallet's threshold-ECDSA key (starlab-mpc `ECDSA_CURVE`). */
export const ECDSA_CURVE = "secp256k1-ecdsa";

/**
 * Whether `chain`'s accounts sign with the wallet's threshold-ECDSA key
 * (starlab-mpc `curve_for_chain(chain) == ECDSA_CURVE`): Ethereum — an EOA
 * only accepts ECDSA. Bitcoin (BIP-340) and ed25519 chains use FROST.
 */
export function isEcdsaChain(chain: string): boolean {
    const c = chain.toLowerCase();
    return c === "ethereum" || c === "eth";
}

/** Secp256k1 key family of `chain` (the FROST share, or for
 *  `isEcdsaChain` chains its ECDSA sibling). */
export function curveForChain(chain: string): "secp256k1" | "ed25519" | null {
    return CHAIN_CURVES[chain.toLowerCase()] ?? null;
}

/**
 * Inverse of `accountWalletId` — starlab-mpc `parse_child_wallet_id`:
 * `{root}-{chain}-{account}` with a known chain and an all-digit account.
 * Returns null for root ids and anything else.
 */
export function parseAccountWalletId(
    id: string,
): { root: string; chain: string; account: number } | null {
    const m = /^(.+)-([^-]+)-(\d+)$/.exec(id);
    if (!m || !curveForChain(m[2])) return null;
    const account = Number(m[3]);
    if (!Number.isSafeInteger(account) || account > 0xffffffff) return null;
    return { root: m[1], chain: m[2].toLowerCase(), account };
}
