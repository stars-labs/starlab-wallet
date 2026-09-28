// ===================================================================
// SESSION MANAGEMENT MODULE
// ===================================================================
//
// This module handles MPC session lifecycle management including:
// - Session persistence across extension restarts
// - Session proposal handling
// - Session response processing
// - Session state validation
// ===================================================================

import {
    AppState,
    getDefaultChainForCurve,
    getProtocolBlockchainForChain,
    isSupportedChain,
    type SupportedChain,
} from "@stars-labs/types/appstate";
import { SessionInfo, SessionProposal, SessionResponse } from "@stars-labs/types/session";
import { MeshStatus } from "@stars-labs/types/mesh";
import { DkgState } from "@stars-labs/types/dkg";
import { WebSocketClient } from "./websocket";
import { validateSessionProposal, validateSessionAcceptance } from "@stars-labs/types/messages";
import type { BackgroundToPopupMessage, OffscreenMessage } from "@stars-labs/types/messages";
import { buildWireSessionInfo } from "../../utils/session-parse";
import { accountWalletId } from "../../utils/wallet-id";
import type { StateManager } from "./stateManager";
import type { KeyShareData } from "@stars-labs/types/keystore";

// Session persistence removed - sessions are ephemeral for security

/**
 * Handles MPC session lifecycle and coordination
 */
export class SessionManager {
    private wsClient: WebSocketClient | null;
    private broadcastToPopup: (message: BackgroundToPopupMessage) => void;
    private sendToOffscreen: (message: OffscreenMessage, description: string) => Promise<{ success: boolean; error?: string }>;
    private stateManager: Pick<StateManager, "getState" | "updateState" | "updateStateProperty">;

    constructor(
        stateManager: Pick<StateManager, "getState" | "updateState" | "updateStateProperty">,
        wsClient: WebSocketClient | null,
        broadcastToPopup: (message: BackgroundToPopupMessage) => void,
        sendToOffscreen: (message: OffscreenMessage, description: string) => Promise<{ success: boolean; error?: string }>,
    ) {
        this.stateManager = stateManager;
        this.wsClient = wsClient;
        this.broadcastToPopup = broadcastToPopup;
        this.sendToOffscreen = sendToOffscreen;
    }

    /**
     * The StateManager's current state. Never cache the result: the
     * StateManager replaces its state object on every update, so a kept
     * reference goes stale (e.g. misses invites after a reset).
     */
    private get appState(): Readonly<AppState> {
        return this.stateManager.getState();
    }

    /**
     * Update the WebSocket client reference (used when WebSocket reconnects)
     */
    updateWebSocketClient(wsClient: WebSocketClient | null): void {
        this.wsClient = wsClient;
        console.log("[SessionManager] WebSocket client reference updated");
    }

    /**
     * Validate WebSocket session proposal data
     */
    private validateWebSocketSessionProposal(proposalData: any): boolean {
        return proposalData &&
            typeof proposalData.session_id === 'string' &&
            typeof proposalData.total === 'number' &&
            typeof proposalData.threshold === 'number' &&
            Array.isArray(proposalData.participants) &&
            proposalData.websocket_msg_type === 'SessionProposal';
    }

    /**
     * Handle incoming session proposals
     */
    async handleSessionProposal(fromPeerId: string, proposalData: any) {
        console.log("[SessionManager] Processing session proposal from:", fromPeerId);
        console.log("[SessionManager] Proposal data:", {
            session_id: proposalData?.session_id,
            total: proposalData?.total,
            threshold: proposalData?.threshold,
            participants: proposalData?.participants,
            websocket_msg_type: proposalData?.websocket_msg_type
        });

        if (!this.validateWebSocketSessionProposal(proposalData)) {
            console.error("[SessionManager] Invalid session proposal data:", proposalData);
            console.error("[SessionManager] Expected: session_id (string), total (number), threshold (number), participants (array), websocket_msg_type='SessionProposal'");
            return;
        }

        // Sort participants to ensure consistent indexing across all peers
        const sortedParticipants = [...(proposalData.participants || [])].sort();
        
        const sessionInfo: SessionInfo = {
            session_id: proposalData.session_id,
            proposer_id: fromPeerId,
            participants: sortedParticipants,
            threshold: proposalData.threshold,
            total: proposalData.total,
            accepted_devices: [fromPeerId], // Proposer automatically accepts
            status: "proposed"
        };

        console.log("[SessionManager] Session proposal validated:", sessionInfo);

        // Get current device ID from StateManager if available
        const currentDeviceId = this.appState.deviceId;
        
        console.log("[SessionManager] Checking inclusion - currentDeviceId:", currentDeviceId, "participants:", sessionInfo.participants);
        
        // Check if this peer is included in the session
        if (sessionInfo.participants.includes(currentDeviceId)) {
            console.log("[SessionManager] This peer is included in session proposal");

            // Get current invites from StateManager
            const currentState = this.appState;
            const invites = [...currentState.invites];
            
            // Check for existing invite
            const existingInviteIndex = invites.findIndex(inv =>
                inv.session_id === sessionInfo.session_id
            );

            if (existingInviteIndex !== -1) {
                console.log("[SessionManager] Updating existing session invite");
                invites[existingInviteIndex] = sessionInfo;
            } else {
                console.log("[SessionManager] Adding new session invite");
                invites.push(sessionInfo);
            }
            
            this.stateManager.updateStateProperty('invites', invites);

            // If this peer is the proposer, automatically accept and set up WebRTC
            if (fromPeerId === currentDeviceId) {
                console.log("[SessionManager] This peer is the proposer, auto-accepting and setting up WebRTC");

                const acceptedSessionInfo = { ...sessionInfo, status: "accepted" as const };
                const updatedInvites = invites.filter(inv => inv.session_id !== sessionInfo.session_id);
                
                this.stateManager.updateState({
                    sessionInfo: acceptedSessionInfo,
                    invites: updatedInvites
                });

                // No persistence - sessions are ephemeral

                // Forward to offscreen for WebRTC setup.
                this.sendToOffscreen({
                    type: "sessionAccepted",
                    sessionInfo: acceptedSessionInfo,
                    currentdeviceId: this.appState.deviceId,
                    blockchain: this.appState.blockchain || "solana"
                }, "proposerWebRTCSetup");
            }

            // Broadcast session update to popup
            this.broadcastToPopup({
                type: "sessionUpdate",
                sessionInfo: this.appState.sessionInfo,
                invites: this.appState.invites
            } as any);

            console.log("[SessionManager] Session proposal processed and broadcasted to popup");
        } else {
            console.log("[SessionManager] This peer is not included in session proposal, ignoring");
        }
    }

    /**
     * Handle session response from participants
     */
    handleSessionResponse(fromPeerId: string, responseData: any) {
        console.log("[SessionManager] Processing session response from:", fromPeerId);

        // Validate WebSocket session response data
        if (!responseData || 
            typeof responseData.session_id !== 'string' || 
            typeof responseData.accepted !== 'boolean' ||
            responseData.websocket_msg_type !== 'SessionResponse') {
            console.error("[SessionManager] Invalid session response data:", responseData);
            console.error("[SessionManager] Expected: session_id (string), accepted (boolean), websocket_msg_type='SessionResponse'");
            return;
        }

        const { session_id, accepted } = responseData;

        // Find the session
        const session = this.appState.sessionInfo?.session_id === session_id
            ? this.appState.sessionInfo
            : this.appState.invites.find(inv => inv.session_id === session_id);

        if (session) {
            console.log(`[SessionManager] Found session ${session_id}, updating acceptance status`);

            if (accepted) {
                // Add to accepted devices if not already present
                if (!session.accepted_devices.includes(fromPeerId)) {
                    session.accepted_devices.push(fromPeerId);
                    console.log(`[SessionManager] Added ${fromPeerId} to accepted devices`);
                }

                // Check if all participants have accepted
                const allAccepted = session.participants.every(participantId =>
                    session.accepted_devices.includes(participantId)
                );

                // Update the sessionInfo in appState if this is the active session
                if (this.appState.sessionInfo?.session_id === session_id) {
                    this.stateManager.updateStateProperty('sessionInfo', { ...session });
                }
                
                if (allAccepted) {
                    console.log("[SessionManager] All participants have accepted the session! Notifying offscreen for mesh readiness.");

                    // Send updated session info to offscreen to trigger mesh readiness check
                    // Use the updated session object, not the potentially stale appState.sessionInfo
                    const sessionAllAcceptedMessage: OffscreenMessage = {
                        type: "sessionAllAccepted",
                        sessionInfo: session,
                        currentdeviceId: this.appState.deviceId,
                        blockchain: this.appState.blockchain || "solana" // Use stored blockchain or default to solana
                    };

                    this.sendToOffscreen(sessionAllAcceptedMessage, "sessionAllAccepted");
                } else {
                    console.log(`[SessionManager] Not all participants accepted yet.`);

                    // Still send update to offscreen for tracking
                    const sessionResponseUpdateMessage: OffscreenMessage = {
                        type: "sessionResponseUpdate",
                        sessionInfo: session,
                        currentdeviceId: this.appState.deviceId
                    };

                    this.sendToOffscreen(sessionResponseUpdateMessage, "sessionResponseUpdate");
                }
            }

            // Broadcast session update to popup
            this.broadcastToPopup({
                type: "sessionUpdate",
                sessionInfo: this.appState.sessionInfo,
                invites: this.appState.invites
            } as any);

            console.log("[SessionManager] Session response processed and broadcasted");
        } else {
            console.warn("[SessionManager] Received session response for unknown session:", session_id);
        }
    }

    /**
     * Accept a session invitation
     */
    async acceptSession(sessionId: string, blockchain: "ethereum" | "solana" = "solana"): Promise<{ success: boolean; error?: string }> {
        console.log(`[SessionManager] Accepting session: ${sessionId} with blockchain: ${blockchain}`);

        // Get current state from StateManager
        const currentState = this.appState;
        const invites = [...currentState.invites];
        
        const sessionIndex = invites.findIndex(inv => inv.session_id === sessionId);

        if (sessionIndex === -1) {
            console.error(`[SessionManager] Session ${sessionId} not found in invites:`, invites);
            return { success: false, error: "Session not found in invites" };
        }

        const session = invites[sessionIndex];
        console.log(`[SessionManager] Found session to accept:`, session);

        const sessionCurve =
            session.curve_type === "ed25519" ? "ed25519" : "secp256k1";
        const chain =
            isSupportedChain(session.blockchain)
                ? session.blockchain
                : getDefaultChainForCurve(sessionCurve);
        blockchain = getProtocolBlockchainForChain(chain);

        // Get current device ID
        const currentDeviceId = this.appState.deviceId;
        
        // Move session to active and update status, adding current device to accepted_devices
        const newSessionInfo = { 
            ...session, 
            status: "accepted" as const,
            accepted_devices: [...new Set([...session.accepted_devices, currentDeviceId])] // Add current device and dedupe
        };
        invites.splice(sessionIndex, 1);
        
        this.stateManager.updateState({
            sessionInfo: newSessionInfo,
            invites: invites,
            blockchain,
            chain,
        });

        // No persistence - sessions are ephemeral

        // Send acceptance message to other participants
        const acceptanceData = {
            websocket_msg_type: "SessionResponse",
            session_id: sessionId,
            accepted: true
        };

        if (this.wsClient?.getReadyState() === WebSocket.OPEN) {
            // Send to all other participants
            const currentDeviceId = this.appState.deviceId;
            const otherParticipants = newSessionInfo.participants.filter((p: string) => p !== currentDeviceId);

            try {
                await Promise.all(otherParticipants.map(async (peerId: string) => {
                    try {
                        await this.wsClient!.relayMessage(peerId, acceptanceData);
                        console.log(`[SessionManager] Session acceptance sent to ${peerId}`);
                    } catch (error) {
                        console.error(`[SessionManager] Failed to send acceptance to ${peerId}:`, error);
                    }
                }));

                console.log("[SessionManager] All session acceptances sent");

                // Forward session info to offscreen for WebRTC setup
                console.log("[SessionManager] Forwarding session info to offscreen for WebRTC setup with blockchain:", blockchain);

                await this.sendToOffscreen({
                    type: "sessionAccepted",
                    sessionInfo: newSessionInfo,
                    currentdeviceId: this.appState.deviceId,
                    blockchain: blockchain
                }, "sessionAccepted");
                
                // Broadcast session update to popup to ensure UI updates
                this.broadcastToPopup({
                    type: "sessionUpdate",
                    sessionInfo: newSessionInfo,
                    invites: invites
                } as any);

                return { success: true };
            } catch (error) {
                return { success: false, error: (error as Error).message };
            }
        } else {
            return { success: false, error: "WebSocket not connected" };
        }
    }

    /**
     * Propose a new session
     */
    async proposeSession(
        sessionId: string,
        totalParticipants: number,
        threshold: number,
        participants: string[],
        blockchain: "ethereum" | "solana" = "solana"
    ): Promise<{ success: boolean; error?: string }> {
        console.log(`[SessionManager] Proposing session: ${sessionId} with blockchain: ${blockchain}`);

        if (!this.wsClient || this.wsClient.getReadyState() !== WebSocket.OPEN) {
            return { success: false, error: "WebSocket not connected" };
        }

        const currentDeviceId = this.appState.deviceId;
        
        // Store blockchain selection
        this.stateManager.updateState({ blockchain });
        
        // Sort participants to ensure consistent indexing across all peers
        const sortedParticipants = [...participants].sort();
        
        const proposalData = {
            websocket_msg_type: "SessionProposal",
            session_id: sessionId,
            proposer_id: currentDeviceId,
            participants: sortedParticipants,
            threshold: threshold,
            total: totalParticipants
        };

        try {
            // Send proposal to all other participants
            const otherParticipants = participants.filter(p => p !== currentDeviceId);

            await Promise.all(otherParticipants.map(async (peerId) => {
                try {
                    await this.wsClient!.relayMessage(peerId, proposalData);
                    console.log(`[SessionManager] Session proposal sent to ${peerId}`);
                } catch (error) {
                    console.error(`[SessionManager] Failed to send proposal to ${peerId}:`, error);
                }
            }));

            // Handle our own proposal (auto-accept for proposer)
            await this.handleSessionProposal(currentDeviceId, proposalData);

            return { success: true };
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }
    }

    /**
     * Ext-1b: create a new MPC wallet via DKG using the TUI-compatible
     * announcement channel. Unlike `proposeSession` (which relays a
     * `SessionProposal` to pre-selected peers), this broadcasts via
     * `announce_session` — any client on the signal server can discover
     * it and join up to the threshold.
     *
     * Steps:
     *   1. Build a TUI-shaped SessionInfo with `participants: [self]`
     *      (joiners append themselves when they accept).
     *   2. Store locally as `appState.sessionInfo` + set
     *      `dkgState = DkgState.Initializing` so the UI reflects the
     *      creator-state.
     *   3. Broadcast via `wsClient.announceSession(buildWireSessionInfo(...))`.
     *
     * Returns the generated `session_id` so the popup can show "waiting
     * for joiners on session dkg_XXX…".
     */
    async createDkgWallet(config: {
        name?: string;
        total: number;
        threshold: number;
        curve: "secp256k1" | "ed25519";
        chain?: SupportedChain;
    }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
        if (!this.wsClient || this.wsClient.getReadyState() !== WebSocket.OPEN) {
            return { success: false, error: "WebSocket not connected" };
        }
        if (!Number.isInteger(config.total) || config.total < 2) {
            return { success: false, error: "total must be ≥2" };
        }
        if (
            !Number.isInteger(config.threshold) ||
            config.threshold < 1 ||
            config.threshold > config.total
        ) {
            return { success: false, error: "threshold must be 1..total" };
        }

        const currentDeviceId = this.appState.deviceId;

        // Session id mirrors TUI's convention — loosely: `dkg_<12-hex>`
        // (TUI uses a 4-hex suffix, which collides too easily; widen
        // here. TUI still parses the id as an opaque string so length
        // doesn't matter to it.)
        const sessionId = `dkg_${cryptoHex(12)}`;
        const chain =
            config.chain && isSupportedChain(config.chain)
                ? config.chain
                : getDefaultChainForCurve(config.curve);
        const blockchain = getProtocolBlockchainForChain(chain);

        const sessionInfo: SessionInfo = {
            session_id: sessionId,
            proposer_id: currentDeviceId,
            total: config.total,
            threshold: config.threshold,
            participants: [currentDeviceId],
            session_type: "dkg",
            curve_type: config.curve,
            blockchain: chain,
            coordination_type: "Network",
            accepted_devices: [currentDeviceId],
        };

        // Mirror TUI's `creating_wallet` state: the popup needs to
        // know we're the creator so it shows "Waiting for joiners"
        // rather than "Session received".
        const invites = [
            ...(this.appState.invites ?? []).filter(
                (s) => s.session_id !== sessionId,
            ),
            sessionInfo,
        ];
        this.stateManager.updateState({
            sessionInfo,
            invites,
            dkgState: DkgState.Initializing,
            blockchain,
            chain,
        });

        try {
            const wire = buildWireSessionInfo(sessionInfo);
            this.wsClient.announceSession(wire);
            console.log(
                `[SessionManager] Created DKG wallet: ${sessionId} ` +
                    `(${config.threshold}/${config.total} ${config.curve})`,
            );
            this.broadcastToPopup({
                type: "dkgWalletCreated",
                sessionInfo,
            } as any);
            return { success: true, sessionId };
        } catch (error) {
            console.error("[SessionManager] createDkgWallet failed:", error);
            // Roll back state on failure so the user can retry cleanly.
            this.stateManager.updateState({
                sessionInfo: null,
                dkgState: DkgState.Idle,
            });
            return { success: false, error: (error as Error).message };
        }
    }

    /**
     * Ext-1e: accept a DKG session that arrived via
     * `session_available` discovery. Mirrors TUI's `JoinDKG` command:
     *   1. Look up the invite (authoritative copy carries the
     *      creator's threshold/total/curve — we inherit them rather
     *      than trust the UI's config).
     *   2. Sanity check: we're not the proposer (creators join
     *      implicitly via createDkgWallet), we're not already in
     *      `participants` (idempotent), there's room for one more
     *      participant.
     *   3. Stash as our own `sessionInfo` and push dkgState to
     *      Initializing so the popup's wallet-status-banner shows
     *      the ceremony in progress.
     *   4. Emit `session_status_update` — server appends us to the
     *      participants list and broadcasts a refreshed
     *      `session_available` to everyone.
     *
     * Does NOT start FROST rounds. Ceremony kickoff is the next
     * wire-up (Ext-1e full) — once total participants === total,
     * everyone has enough info to init DkgManager and start WebRTC
     * mesh setup.
     */
    async joinDkgSession(sessionId: string): Promise<{
        success: boolean;
        sessionInfo?: SessionInfo;
        error?: string;
    }> {
        if (!this.wsClient || this.wsClient.getReadyState() !== WebSocket.OPEN) {
            return { success: false, error: "WebSocket not connected" };
        }
        const invite = (this.appState.invites ?? []).find(
            (s) => s.session_id === sessionId,
        );
        if (!invite) {
            return {
                success: false,
                error: `No known invite for session ${sessionId}`,
            };
        }
        const currentDeviceId = this.appState.deviceId;
        if (!currentDeviceId) {
            return { success: false, error: "Device id not set yet" };
        }
        if (invite.proposer_id === currentDeviceId) {
            return {
                success: false,
                error: "You're the proposer of this session — no need to join",
            };
        }
        // Already listed? (CLI/TUI signing announces pre-list the whole
        // cohort.) Still join and tell the server — see below.
        const alreadyJoined = invite.participants.includes(currentDeviceId);
        if (
            !alreadyJoined &&
            invite.participants.length >= invite.total
        ) {
            return {
                success: false,
                error: "Session is full",
            };
        }

        // Inherit authoritative session_info from the creator's
        // announcement. We optimistically append ourselves locally
        // so the popup reflects the joined state before the
        // server echoes the update; the echo will overwrite this
        // entry with the canonical `participants` list from server.
        const newParticipants = alreadyJoined
            ? [...invite.participants]
            : [...invite.participants, currentDeviceId];
        const local: SessionInfo = {
            ...invite,
            participants: newParticipants,
            accepted_devices: Array.from(
                new Set([...(invite.accepted_devices ?? []), currentDeviceId]),
            ),
        };
        const curve =
            local.curve_type === "ed25519" ? "ed25519" : "secp256k1";
        const chain =
            isSupportedChain(local.blockchain)
                ? local.blockchain
                : getDefaultChainForCurve(curve);
        // dkgState tracks key generation / the wallet's readiness. A
        // signing join (TUI warm signing even reuses the finished DKG's
        // session id) must leave the wallet Complete.
        const dkgStateBefore = this.appState.dkgState;
        this.stateManager.updateState({
            sessionInfo: local,
            ...(local.session_type === "signing"
                ? {}
                : { dkgState: DkgState.Initializing }),
            blockchain: getProtocolBlockchainForChain(chain),
            chain,
        });

        try {
            // Sent even when pre-listed: the server dedupes membership but
            // re-broadcasts participant_update, which is what starts our
            // ceremony now that this is our active session.
            this.wsClient.sendSessionStatusUpdate(sessionId, currentDeviceId);
            console.log(
                `[SessionManager] Joined session ${sessionId} as ${currentDeviceId}`,
            );
            this.broadcastToPopup({
                type: "dkgSessionJoined",
                sessionInfo: local,
            } as any);
            return { success: true, sessionInfo: local };
        } catch (err) {
            // Roll back local state on wire failure so the UI doesn't
            // show a false "joined" state.
            this.stateManager.updateState({
                sessionInfo: null,
                dkgState: dkgStateBefore,
            });
            return { success: false, error: (err as Error).message };
        }
    }

    /**
     * Ext-2: announce a threshold-signing ceremony for an existing
     * wallet. Mirror of `createDkgWallet` but on the signing side of
     * the TUI protocol:
     *
     *   - session_type: "signing" (flat string, matches TUI wire)
     *   - wallet_name, group_public_key, blockchain, and
     *     signing_message_hex filled in top-level per TUI's parser
     *     (command.rs:286 line, signing-sibling fields).
     *
     * For secp256k1 wallets the caller passes the EIP-191 digest; FROST
     * signs it as BIP-340 Schnorr (NOT ecrecover-compatible). For
     * ed25519, raw bytes are signed.
     *
     * Does NOT actually run FROST rounds — that's the signing
     * auto-trigger (Ext-2d). This commit just announces.
     */
    async createSigningSession(config: {
        walletId: string;
        walletName: string;
        blockchain: "ethereum" | "solana";
        /** The wallet's stored share: cohort, threshold, and (in the
         *  offscreen) the account key the announce names. */
        keyShare: KeyShareData;
        /** Hex-encoded bytes that FROST will sign. Caller is
         *  responsible for EIP-191 wrapping if appropriate. */
        signingMessageHex: string;
    }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
        if (!this.wsClient || this.wsClient.getReadyState() !== WebSocket.OPEN) {
            return { success: false, error: "WebSocket not connected" };
        }
        if (!config.walletId || !config.keyShare) {
            return { success: false, error: "walletId and keyShare required" };
        }
        if (!/^[0-9a-fA-F]*$/.test(config.signingMessageHex)) {
            return { success: false, error: "signingMessageHex must be hex" };
        }

        const currentDeviceId = this.appState.deviceId;
        // Like the engine proposers: the wallet's whole cohort is listed —
        // TUI / desktop only offer a signing whose participants include them.
        const { keyShare } = config;
        const participants = [
            ...new Set(
                keyShare.participants?.length
                    ? keyShare.participants
                    : Object.keys(keyShare.participant_identifiers ?? {}),
            ),
        ].sort();
        if (!participants.includes(currentDeviceId)) {
            return { success: false, error: "This device is not in the wallet's cohort" };
        }
        if (participants.length !== keyShare.total_participants) {
            // A share that doesn't name every co-signer can't be announced:
            // co-signers not listed would never be asked (and never sign).
            return {
                success: false,
                error: `The wallet's share lists ${participants.length} of its ${keyShare.total_participants} devices (${participants.join(", ")}) — re-import it from a backup that carries the full cohort`,
            };
        }
        // Everyone signs with the account child, so the announce names its
        // key (as the engine does), not the root key.
        const account = { chain: config.blockchain, account: 0 };
        const derived = (await this.sendToOffscreen(
            { type: "deriveAccountGroupKey", keyShare, ...account } as any,
            "deriveAccountGroupKey",
        )) as { success: boolean; groupPublicKey?: string; error?: string };
        if (!derived?.success || !derived.groupPublicKey) {
            return { success: false, error: `Deriving the account key failed: ${derived?.error ?? "unknown"}` };
        }

        const sessionId = `sign_${cryptoHex(12)}`;
        const curveType =
            config.blockchain === "ethereum" ? "secp256k1" : "ed25519";

        const sessionInfo: SessionInfo = {
            session_id: sessionId,
            proposer_id: currentDeviceId,
            total: keyShare.total_participants,
            threshold: keyShare.threshold,
            participants,
            session_type: "signing",
            curve_type: curveType,
            coordination_type: "Network",
            // Signing-specific top-level siblings — TUI parser reads
            // these at the top level (not nested). `wallet_name` is the
            // account-0 child wallet id — the key everyone signs with.
            wallet_name: accountWalletId(config.walletId, account.chain, account.account),
            group_public_key: derived.groupPublicKey,
            blockchain: config.blockchain,
            signing_message_hex: config.signingMessageHex,
            accepted_devices: [currentDeviceId],
        };

        // Stash as active session so the popup shows the signing in
        // progress. dkgState is left alone: it tracks the wallet's key
        // generation, which signing doesn't change.
        const invites = [
            ...(this.appState.invites ?? []).filter(
                (s) => s.session_id !== sessionId,
            ),
            sessionInfo,
        ];
        this.stateManager.updateState({
            sessionInfo,
            invites,
            blockchain: config.blockchain,
        });

        try {
            const wire = buildWireSessionInfo(sessionInfo);
            this.wsClient.announceSession(wire);
            console.log(
                `[SessionManager] Created signing session ${sessionId} for wallet ${config.walletId} (${sessionInfo.threshold}/${sessionInfo.total} ${curveType}, participants ${participants.join(",")})`,
            );
            this.broadcastToPopup({
                type: "signingSessionCreated",
                sessionInfo,
            } as any);
            // Start our ceremony now: CLI/TUI co-signers start on the
            // announce and never join, and the server doesn't echo our own
            // announce, so no later event would trigger it.
            void this.sendToOffscreen(
                { type: "sessionReadyForSigning", sessionInfo, blockchain: config.blockchain } as any,
                `sessionReadyForSigning(${sessionId})`,
            );
            return { success: true, sessionId };
        } catch (error) {
            console.error(
                "[SessionManager] createSigningSession failed:",
                error,
            );
            this.stateManager.updateState({ sessionInfo: null });
            return { success: false, error: (error as Error).message };
        }
    }

    /**
     * M3 reshare: announce a share-rotation ceremony for an existing
     * wallet. Sibling of `createSigningSession` on the announce side:
     *
     *   - session_type: "reshare"
     *   - threshold/total describe the NEW cohort
     *   - wallet_name carries the wallet id (the joiners use it to
     *     locate their own share for the same wallet)
     *   - reshare_old_participants carries the CURRENT cohort (FROST
     *     ids come from each device's stored participant_identifiers)
     *
     * The engine's reshare requires every NEW participant to already
     * hold a share, so newParticipants must be a subset of
     * oldParticipants and must include this device. The ceremony
     * itself starts when ALL newTotal devices have joined
     * (maybeTriggerCeremony fires sessionReadyForReshare).
     */
    async createReshareSession(config: {
        walletId: string;
        walletName?: string;
        groupPublicKey: string;
        blockchain: "ethereum" | "solana";
        newThreshold: number;
        oldParticipants: string[];
        newParticipants: string[];
    }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
        if (!this.wsClient || this.wsClient.getReadyState() !== WebSocket.OPEN) {
            return { success: false, error: "WebSocket not connected" };
        }
        if (!config.walletId || !config.groupPublicKey) {
            return { success: false, error: "walletId and groupPublicKey required" };
        }
        const oldParticipants = [...new Set(config.oldParticipants)].sort();
        const newParticipants = [...new Set(config.newParticipants)].sort();
        if (oldParticipants.length < 2) {
            return {
                success: false,
                error: "Wallet metadata doesn't carry the full cohort — cannot reshare",
            };
        }
        const outsiders = newParticipants.filter(
            (p) => !oldParticipants.includes(p),
        );
        if (outsiders.length > 0) {
            return {
                success: false,
                error: `New cohort members must already hold a share: ${outsiders.join(", ")}`,
            };
        }
        const currentDeviceId = this.appState.deviceId;
        if (!newParticipants.includes(currentDeviceId)) {
            return {
                success: false,
                error: "This device must be part of the new cohort",
            };
        }
        if (newParticipants.length < 2) {
            return { success: false, error: "New cohort must have ≥2 devices" };
        }
        if (
            !Number.isInteger(config.newThreshold) ||
            config.newThreshold < 1 ||
            config.newThreshold > newParticipants.length
        ) {
            return {
                success: false,
                error: "newThreshold must be 1..newTotal",
            };
        }

        const sessionId = `reshare_${cryptoHex(12)}`;
        const curveType =
            config.blockchain === "ethereum" ? "secp256k1" : "ed25519";

        const sessionInfo: SessionInfo = {
            session_id: sessionId,
            proposer_id: currentDeviceId,
            total: newParticipants.length,
            threshold: config.newThreshold,
            participants: [currentDeviceId],
            session_type: "reshare",
            curve_type: curveType,
            coordination_type: "Network",
            wallet_name: config.walletId,
            group_public_key: config.groupPublicKey,
            blockchain: config.blockchain,
            reshare_old_participants: oldParticipants,
            accepted_devices: [currentDeviceId],
        };

        const invites = [
            ...(this.appState.invites ?? []).filter(
                (s) => s.session_id !== sessionId,
            ),
            sessionInfo,
        ];
        this.stateManager.updateState({
            sessionInfo,
            invites,
            dkgState: DkgState.Initializing,
            blockchain: config.blockchain,
        });

        try {
            const wire = buildWireSessionInfo(sessionInfo);
            this.wsClient.announceSession(wire);
            console.log(
                `[SessionManager] Created reshare session ${sessionId} for wallet ${config.walletId} (${config.newThreshold}/${newParticipants.length} ${curveType}, old cohort ${oldParticipants.length})`,
            );
            this.broadcastToPopup({
                type: "reshareSessionCreated",
                sessionInfo,
            } as any);
            return { success: true, sessionId };
        } catch (error) {
            console.error("[SessionManager] createReshareSession failed:", error);
            this.stateManager.updateState({
                sessionInfo: null,
                dkgState: DkgState.Idle,
            });
            return { success: false, error: (error as Error).message };
        }
    }
}

/**
 * 12-char hex helper for session ids. Uses WebCrypto — available in
 * service workers and offscreen documents. Not cryptographically
 * strong (we don't need that for session ids), just collision-resistant
 * enough for "a few thousand sessions".
 */
function cryptoHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    let out = "";
    for (const b of buf) out += b.toString(16).padStart(2, "0");
    return out;
}
