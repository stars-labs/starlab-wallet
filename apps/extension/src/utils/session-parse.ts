/** Canonical native engine session wire format. DKG is always unified;
 * signing and refresh name the concrete algorithm they operate on.
 * Extension-local accepted_devices is synthesized independently of wire data.
 */
import type { SessionInfo } from "@stars-labs/types/session";

export function parseSessionInfoFromWire(raw: unknown): SessionInfo | null {
    if (typeof raw !== "object" || raw === null) {
        return null;
    }
    const r = raw as Record<string, unknown>;

    const session_id = typeof r.session_id === "string" ? r.session_id : null;
    if (!session_id) return null;

    const total = typeof r.total === "number" ? r.total : null;
    if (total === null || !Number.isFinite(total) || total < 0) return null;

    const threshold = typeof r.threshold === "number" ? r.threshold : null;
    if (threshold === null || !Number.isFinite(threshold) || threshold < 0) {
        return null;
    }

    const proposer_id =
        typeof r.proposer_id === "string" ? r.proposer_id : "unknown";

    const participants = Array.isArray(r.participants)
        ? r.participants.filter((v): v is string => typeof v === "string")
        : [];

    const curve_type = r.curve_type;
    if (typeof curve_type !== "string" || !["unified", "secp256k1", "ed25519", "secp256k1-ecdsa"].includes(curve_type)) return null;

    const coordination_type =
        typeof r.coordination_type === "string" ? r.coordination_type : "Network";

    const session_type = r.session_type;
    if (session_type !== "dkg" && session_type !== "signing" && session_type !== "reshare") return null;
    if (session_type === "dkg" && curve_type !== "unified") return null;
    if (session_type !== "dkg" && curve_type === "unified") return null;
    if (session_type === "reshare" && curve_type === "secp256k1-ecdsa") return null;

    const wallet_name =
        typeof r.wallet_name === "string" ? r.wallet_name : undefined;
    const group_public_key =
        typeof r.group_public_key === "string" ? r.group_public_key : undefined;
    const blockchain =
        typeof r.blockchain === "string" ? r.blockchain : undefined;

    const signing_message_hex = typeof r.signing_message_hex === "string" ? r.signing_message_hex : undefined;

    // Reshare-only: the wallet's CURRENT cohort. Required for every
    // joiner to derive consistent FROST identifiers (old indices).
    const reshare_old_participants = Array.isArray(r.reshare_old_participants)
        ? r.reshare_old_participants.filter(
              (v): v is string => typeof v === "string",
          )
        : undefined;

    // accepted_devices: extension-local bookkeeping. If the sender
    // included one (another extension peer, or a re-sent
    // session_status_update), honour it; otherwise synthesise [].
    const accepted_devices = Array.isArray(r.accepted_devices)
        ? r.accepted_devices.filter((v): v is string => typeof v === "string")
        : [];

    const status = typeof r.status === "string" ? r.status : undefined;

    return {
        session_id,
        proposer_id,
        total,
        threshold,
        participants,
        session_type,
        curve_type,
        coordination_type,
        wallet_name,
        group_public_key,
        blockchain,
        signing_message_hex,
        reshare_old_participants,
        accepted_devices,
        status,
    };
}

/**
 * Build a TUI-compatible `session_info` JSON payload for the
 * `announce_session` outbound message. Shape follows TUI's announcer
 * in `command.rs` near line 555: all DKG-common fields top-level;
 * signing-specific fields appended top-level if `session_type ===
 * "signing"`. Does NOT include extension-local fields like
 * `accepted_devices` or `status` — keep the wire lean.
 */
export function buildWireSessionInfo(s: SessionInfo): Record<string, unknown> {
    if (!s.session_type || !s.curve_type ||
        !["unified","ed25519","secp256k1","secp256k1-ecdsa"].includes(s.curve_type) ||
        (s.session_type === "dkg" && s.curve_type !== "unified") ||
        (s.session_type !== "dkg" && s.curve_type === "unified") ||
        (s.session_type === "reshare" && s.curve_type === "secp256k1-ecdsa")) {
        throw new Error("Session requires an explicit supported algorithm; DKG must be unified");
    }
    const base: Record<string, unknown> = {
        session_id: s.session_id,
        proposer_id: s.proposer_id,
        total: s.total,
        threshold: s.threshold,
        participants: s.participants,
        session_type: s.session_type,
        curve_type: s.curve_type,
        coordination_type: s.coordination_type ?? "Network",
    };
    if (s.session_type === "signing" || s.session_type === "reshare") {
        if (s.wallet_name !== undefined) base.wallet_name = s.wallet_name;
        if (s.group_public_key !== undefined) {
            base.group_public_key = s.group_public_key;
        }
        if (s.blockchain !== undefined) base.blockchain = s.blockchain;
    }
    if (s.session_type === "signing") {
        if (s.signing_message_hex !== undefined) {
            base.signing_message_hex = s.signing_message_hex;
        }
    }
    if (s.session_type === "reshare") {
        if (s.reshare_old_participants !== undefined) {
            base.reshare_old_participants = s.reshare_old_participants;
        }
    }
    return base;
}
