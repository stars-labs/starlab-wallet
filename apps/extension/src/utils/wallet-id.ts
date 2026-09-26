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
