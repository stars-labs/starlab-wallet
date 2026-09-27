import type { SessionInfo } from "@stars-labs/types/session";
import { parseAccountWalletId } from "../../utils/wallet-id";

/**
 * Identity of one signing REQUEST: a session id can be re-announced with a
 * new message (TUI reused ids), and that is a new request to review.
 */
export function signingInviteKey(session: Pick<SessionInfo, "session_id" | "signing_message_hex">): string {
    return `${session.session_id}:${session.signing_message_hex ?? ""}`;
}

/** The chain being signed for — from wallet_name's account id, not `blockchain`. */
export function signingInviteChain(session: Pick<SessionInfo, "wallet_name" | "blockchain">): string | undefined {
    return parseAccountWalletId(session.wallet_name ?? "")?.chain ?? session.blockchain;
}

/**
 * What to do with an incoming signing invite:
 * - "show": pop the review modal now;
 * - "defer": we're in another ceremony (e.g. a reshare still saving its new
 *   share) — keep it and pop it once that session clears, or it is lost;
 * - "ignore": not for us, already dismissed/joined (by signingInviteKey),
 *   or a modal is already open.
 */
export type SigningInviteDecision = "show" | "defer" | "ignore";

export function signingInviteDecision(
    session: SessionInfo,
    ctx: { deviceId: string; dismissed: Set<string>; modalOpen: boolean; busy: boolean },
): SigningInviteDecision {
    if (session.session_type !== "signing") return "ignore";
    if (session.proposer_id === ctx.deviceId) return "ignore";
    if (!session.participants.includes(ctx.deviceId)) return "ignore";
    if (ctx.dismissed.has(signingInviteKey(session))) return "ignore";
    if (ctx.modalOpen) return "ignore";
    return ctx.busy ? "defer" : "show";
}
