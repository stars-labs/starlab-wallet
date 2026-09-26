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
