import type { SessionInfo } from "@stars-labs/types/session";

/**
 * What to do with an incoming signing invite:
 * - "show": pop the review modal now;
 * - "defer": we're in another ceremony (e.g. a reshare still saving its new
 *   share) — keep it and pop it once that session clears, or it is lost;
 * - "ignore": not for us, already dismissed, or a modal is already open.
 */
export type SigningInviteDecision = "show" | "defer" | "ignore";

export function signingInviteDecision(
    session: SessionInfo,
    ctx: { deviceId: string; dismissed: Set<string>; modalOpen: boolean; busy: boolean },
): SigningInviteDecision {
    if (session.session_type !== "signing") return "ignore";
    if (session.proposer_id === ctx.deviceId) return "ignore";
    if (!session.participants.includes(ctx.deviceId)) return "ignore";
    if (ctx.dismissed.has(session.session_id)) return "ignore";
    if (ctx.modalOpen) return "ignore";
    return ctx.busy ? "defer" : "show";
}
