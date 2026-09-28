import { SessionInfo, DkgState, MeshStatus, MeshStatusType } from "@stars-labs/types/appstate";
import { WebRTCAppMessage } from "@stars-labs/types/webrtc";
import { ICE_SERVERS } from "../../config/ice";

const CEREMONY_PREFIXES = ["DKG_ROUND1:", "DKG_ROUND2:", "SIGN_COMMIT:", "SIGN_SET:", "SIGN_SHARE:", "RESHARE_ROUND1:", "RESHARE_ROUND2:"];

/** A DKG / signing / reshare round frame (the CLI/TUI native SimpleMessage). */
function isCeremonyFrame(message: WebRTCAppMessage): boolean {
  const text = (message as { text?: unknown }).text;
  return typeof text === "string" && CEREMONY_PREFIXES.some((p) => text.startsWith(p));
}

/**
 * `SIGN_SET:` + base64(JSON array of device ids): the signer set the
 * proposer fixed for this signing ceremony (same wire format as the CLI).
 */
export function encodeSignerSet(deviceIds: string[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(deviceIds));
  return `SIGN_SET:${btoa(String.fromCharCode(...bytes))}`;
}

export function decodeSignerSet(text: string): string[] | null {
  try {
    const bin = atob(text.slice("SIGN_SET:".length));
    const ids = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : null;
  } catch {
    return null;
  }
}
import { to_frost_wire } from "@stars-labs/core-wasm";
import { WebSocketMessagePayload, WebRTCSignal } from "@stars-labs/types/websocket";
import type { KeyShareData } from "@stars-labs/types/keystore";
import {
  dkgParticipantIdentifiers,
  toEngineKeystoreJson,
} from "../../utils/engineKeystore";
import { curveForChain } from "../../utils/wallet-id";

export { DkgState, MeshStatusType }; // Export DkgState and MeshStatusType

// Signing state enumeration to track signing process
export enum SigningState {
  Idle = "Idle",
  CommitmentPhase = "CommitmentPhase", // FROST Round 1 - collecting commitments
  SharePhase = "SharePhase", // FROST Round 2 - collecting signature shares
  Complete = "Complete", // Signing completed successfully
  Failed = "Failed" // Signing failed
}

// M3 reshare: state enumeration for the share-rotation ceremony.
// Parallel of DkgState but kept separate — a reshare operates on an
// EXISTING wallet's share and must never be conflated with key
// generation (mixing them up would regenerate a fresh group key and
// orphan the wallet's funds).
export enum ReshareState {
  Idle = "Idle",
  WaitingForMesh = "WaitingForMesh", // session triggered, waiting for data channels
  Round1InProgress = "Round1InProgress",
  Round2InProgress = "Round2InProgress",
  Complete = "Complete",
  Failed = "Failed",
}

// M3 reshare: ceremony bookkeeping. `oldParticipants` is the wallet's
// CURRENT cohort (sorted). FROST identifiers come from the wallet's
// stored participant_identifiers (NOT list positions — after a removal
// reshare the cohort keeps gapped ids like {1,3}); the engine requires
// every new participant to already hold a share under its old id.
// `newParticipants` is the (sorted) cohort that will hold shares
// after the ceremony — always a subset of oldParticipants.
export interface ReshareInfo {
  session_id: string;
  wallet_id: string;
  old_participants: string[]; // sorted
  new_participants: string[]; // sorted, subset of old_participants
  new_threshold: number;
  old_group_public_key: string; // hex
  identifiers: Record<string, number>; // device id → FROST id (old cohort)
}

// Signing process information
export interface SigningInfo {
  signing_id: string;
  transaction_data: string;
  threshold: number;
  participants: string[];
  acceptances: Map<string, boolean>; // Map peer ID to acceptance status
  accepted_participants: string[];
  selected_signers: string[];
  /** device id → FROST identifier for every selected signer, taken
   *  from the wallet's stored participant_identifiers. Never derived
   *  from list positions (ids are gapped after a removal reshare). */
  signer_identifiers: Record<string, number>;
  step: "commitment_phase" | "share_phase" | "complete";
  initiator: string;
  final_signature?: string; // Final aggregated signature as string
}

// --- WebRTCManager Class ---

export class WebRTCManager {
  private localPeerId: string;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  /** Messages for peers whose data channel isn't open yet, sent on open. */
  private pendingSends: Map<string, WebRTCAppMessage[]> = new Map();
  /**
   * Ceremony frames (DKG/signing/reshare rounds) sent to each peer during the
   * current ceremony — re-sent when that peer's channel (re)opens, since a
   * rebuilt connection loses anything in flight. Receivers dedupe per sender.
   */
  private ceremonyOutbox: Map<string, WebRTCAppMessage[]> = new Map();
  /** `disconnected` often heals by itself; wait this long before rebuilding. */
  private disconnectGraceMs = 8000;
  private graceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Rebuild rate limit per peer: first retry after this, doubling to 30s. */
  private rebuildBaseDelayMs = 5000;
  private rebuildBackoff: Map<string, { nextAt: number; delay: number; timer?: ReturnType<typeof setTimeout> }> = new Map();
  /**
   * A re-offer made while the network is still down may never reach
   * `failed` (Chrome can sit in `connecting` for minutes): rebuild again if
   * it isn't connected within this window.
   */
  private offerWatchdogMs = 20_000;
  private offerWatchdogs: Map<string, ReturnType<typeof setTimeout>> = new Map();

  public sessionInfo: SessionInfo | null = null;
  public invites: SessionInfo[] = []; // Store incoming session proposals/invites
  public dkgState: DkgState = DkgState.Idle;
  public meshStatus: MeshStatus = { type: MeshStatusType.Incomplete };
  private pendingIceCandidates: Map<string, RTCIceCandidateInit[]> = new Map();

  // Mesh ready tracking to prevent duplicate signals
  private ownMeshReadySent: boolean = false;

  // FROST DKG integration
  private frostDkg: any | null = null;
  private participantIndex: number | null = null;
  // device id → FROST id of the wallet loaded by loadKeystoreForSigning.
  private walletIdentifiers: Record<string, number> | null = null;
  private receivedRound1Packages: Set<string> = new Set();
  private receivedRound2Packages: Set<string> = new Set();
  private groupPublicKey: string | null = null;
  private solanaAddress: string | null = null;
  private ethereumAddress: string | null = null; // Ethereum address property
  private walletAddress: string | null = null; // Generic address property for current blockchain
  private currentBlockchain: "ethereum" | "solana" = "solana"; // Store current blockchain selection
  private pendingDkgTriggerBlockchain: "ethereum" | "solana" | null = null;

  // Package buffering for handling packages that arrive before DKG initialization
  private bufferedRound1Packages: Array<{ fromPeerId: string; packageData: any }> = [];
  private bufferedRound2Packages: Array<{ fromPeerId: string; packageData: any }> = [];

  // M3 FROST Reshare integration (rotate shares, same group key).
  // `frostReshare` holds a FrostReshareSecp256k1/Ed25519 WASM
  // instance for the duration of one ceremony. Kept separate from
  // `frostDkg` so an in-flight reshare can't clobber a loaded
  // signing keystore by accident.
  public reshareState: ReshareState = ReshareState.Idle;
  public reshareInfo: ReshareInfo | null = null;
  private frostReshare: any | null = null;
  private reshareKeyShare: KeyShareData | null = null; // pending keystore data until mesh is ready
  private receivedReshareRound1: Set<string> = new Set();
  private receivedReshareRound2: Set<string> = new Set();
  private bufferedReshareRound1: Array<{ fromPeerId: string; packageHex: string }> = [];
  private bufferedReshareRound2: Array<{ fromPeerId: string; packageHex: string }> = [];

  // FROST Signing integration
  public signingState: SigningState = SigningState.Idle;
  public signingInfo: SigningInfo | null = null;
  private signingCommitments: Map<string, any> = new Map(); // Map peer to commitment data
  private signingShares: Map<string, any> = new Map(); // Map peer to signature share data
  /** Signing frames that arrived before our ceremony / signer set existed. */
  private earlySigningFrames: Array<{ fromPeerId: string; kind: "commitment" | "share" | "set"; hex: string }> = [];
  /** Commitments / shares of the most recently finished ceremony — peers
   *  keep resending unacked frames (#117) after it ended. */
  private finishedCeremonyFrames = new Set<string>();
  /** Signer set announced by the proposer (SIGN_SET), applied once every
   *  member's commitment is here. Non-proposers never pick a set. */
  private announcedSignerSet: string[] | null = null;
  /** True once `signingInfo.selected_signers` is the ceremony's final set. */
  private signerSetFixed = false;
  /**
   * A signing that hasn't completed by then fails (a picked signer went
   * offline, or too few shareholders committed). It is not re-picked in
   * place: a signer that already shared must never sign another package
   * with the same nonces. The next request starts a fresh ceremony.
   */
  private signingTimeoutMs = 120_000;
  private signingTimer: ReturnType<typeof setTimeout> | null = null;

  // Callbacks
  public onLog: (message: string) => void = console.log;
  public onSessionUpdate: (sessionInfo: SessionInfo | null, invites: SessionInfo[]) => void = () => { };
  public onMeshStatusUpdate: (status: MeshStatus) => void = () => { };
  public onWebRTCAppMessage: (fromPeerId: string, message: WebRTCAppMessage) => void = () => { };
  public onDkgStateUpdate: (state: DkgState) => void = () => { };
  /**
   * Fires exactly once per ceremony after the FROST DKG finalize
   * succeeds. Payload carries everything the save-keyshare flow
   * needs: group public key, derived address for the selected
   * chain, session context. Kept separate from `onDkgStateUpdate`
   * so late subscribers don't have to race on "was Complete already
   * emitted?" — if this fires, the ceremony is terminally done.
   */
  public onDkgComplete: (payload: {
    groupPublicKey: string;
    address: string | null;
    blockchain: "ethereum" | "solana";
    sessionId: string | null;
    threshold: number;
    total: number;
    participants: string[];
    participantIndex: number | null;
    /** device id → FROST id assigned by this DKG (sorted position). */
    participantIdentifiers: Record<string, number>;
    /** WASM-exported keystore JSON — carries the key package bytes,
     *  FROST identifiers, and public key commitments for each
     *  participant. The background's KeystoreManager consumes this
     *  (via addWallet) to encrypt + persist the keyshare once the
     *  user picks a password. */
    keystoreJson: string;
  }) => void = () => { };
  public onSigningStateUpdate: (state: SigningState, info: SigningInfo | null) => void = () => { };
  /**
   * Ext-2d-progress: fires on every signing-ceremony progression
   * milestone (commitment sent/received, share sent/received) with
   * the current per-participant roster. TUI parity with the
   * `signing_commitments_received` / `signing_shares_received`
   * HashSets (051cdbc) that overlay ✓ / ✓✓ on the participant list
   * while the ceremony runs — lets the creator see Bob committing
   * and Carol sharing in real time instead of staring at a blank
   * "waiting" screen between kickoff and SignatureComplete.
   *
   * The payload is JSON-plain (arrays, not Maps) so it crosses the
   * runtime.sendMessage boundary without serialization gymnastics.
   */
  public onSigningFailed: (payload: { signingId: string; sessionId: string; error: string }) => void = () => {};
  public onSigningProgress: (payload: {
    signingId: string;
    state: SigningState;
    selectedSigners: string[];
    commitmentsReceived: string[];
    sharesReceived: string[];
  }) => void = () => { };
  /**
   * Ext-2d-offscreen-rounds: fires once per ceremony when the final
   * aggregated signature is available. All signers receive this
   * (the aggregator after calling `aggregate_signature`, co-signers
   * when they receive the AggregatedSignature broadcast). Payload
   * carries enough context for the popup to render a
   * SignatureComplete screen and for the dApp bridge (future
   * Ext-4) to resolve its pending personal_sign RPC.
   */
  public onSigningComplete: (payload: {
    signingId: string;
    signature: string;
    messageHex: string;
    blockchain: "ethereum" | "solana";
    /** The session_id the signing_id was derived from (strips the
     *  `sign_` prefix). Used by the popup to cross-reference the
     *  session banner with the final signature. */
    sessionId: string;
  }) => void = () => { };
  public onWebRTCConnectionUpdate: (peerId: string, connected: boolean) => void = () => { };

  /**
   * M3 reshare: fires on every reshare-state transition so the
   * background (and popup, via polling) can render "waiting for
   * peers / round N / done". JSON-plain payload for the
   * runtime.sendMessage boundary.
   */
  public onReshareStateUpdate: (payload: {
    sessionId: string;
    walletId: string;
    state: string;
    round1Received: string[];
    round2Received: string[];
    participants: string[];
    error?: string;
  }) => void = () => { };

  /**
   * M3 reshare: fires exactly once per ceremony after
   * finalize_reshare succeeds AND the group public key has been
   * verified unchanged. Payload carries the NEW keystore JSON —
   * the background replaces the wallet's stored encrypted share
   * with it (same wallet id, same addresses).
   */
  public onReshareComplete: (payload: {
    sessionId: string;
    walletId: string;
    newKeystoreJson: string;
    groupPublicKey: string;
    threshold: number;
    total: number;
    participants: string[];
    /** device id → FROST id for the NEW cohort (old ids retained). */
    participantIdentifiers: Record<string, number>;
    blockchain: "ethereum" | "solana";
  }) => void = () => { };

  // Add the missing callback property and constructor parameter
  private sendPayloadToBackgroundForRelay: ((toPeerId: string, payload: WebSocketMessagePayload) => void) | null = null;

  constructor(localPeerId: string, sendPayloadCallback?: (toPeerId: string, payload: WebSocketMessagePayload) => void) {

    if (typeof localPeerId !== 'string') {
      // Use console.warn for this initial setup phase, as _log depends on localPeerId which is being initialized.
      // JSON.stringify might fail for complex objects or circular refs, but good for simple ones.
      let localPeerIdStringRepresentation = '';
      try {
        localPeerIdStringRepresentation = JSON.stringify(localPeerId);
      } catch (e) {
        localPeerIdStringRepresentation = '[Unserializable Object]';
      }
      console.warn(`[WebRTCManager] Constructor: localPeerId expected a string but received type ${typeof localPeerId}. Value: ${localPeerIdStringRepresentation}`);

      if (localPeerId && typeof (localPeerId as any).id === 'string') {
        this.localPeerId = (localPeerId as any).id;
        console.warn(`[WebRTCManager] Constructor: Using 'id' property from localPeerId object: ${this.localPeerId}`);
      } else {
        this.localPeerId = String(localPeerId); // Fallback, may result in "[object Object]"
        console.warn(`[WebRTCManager] Constructor: Fallback: Converted localPeerId to string: ${this.localPeerId}. This may not be the intended ID. Please check instantiation site.`);
      }
    } else {
      this.localPeerId = localPeerId;
    }

    this.sendPayloadToBackgroundForRelay = sendPayloadCallback || null;
  }

  private _log(message: string) {
    const curve = this.currentBlockchain === "ethereum" ? "secp256k1" : "ed25519";
    this.onLog(`[WebRTCManager-${this.localPeerId}][${curve}] ${message}`);
  }

  private _isTestEnvironment(): boolean {
    return typeof global !== 'undefined' &&
      (global as any).IS_TESTING === true ||
      typeof process !== 'undefined' && process.env.NODE_ENV === 'test' ||
      typeof (globalThis as any).Bun !== 'undefined';
  }

  private _logVerbose(message: string) {
    // Only log verbose messages in non-test environments
    if (!this._isTestEnvironment()) {
      this._log(message);
    }
  }

  private _getErrorMessage(error: any): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object' && error.message) {
      return error.message;
    }
    return JSON.stringify(error);
  }

  private _bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Engine JSON (hex) → FROST binary (hex), the CLI/TUI wire encoding. */
  private _frostWire(kind: "round1" | "round2" | "commitment" | "share", jsonHex: string): string {
    const curve = this.currentBlockchain === "ethereum" ? "secp256k1" : "ed25519";
    return to_frost_wire(curve, kind, jsonHex);
  }

  private _hexToBase64(hex: string): string {
    return btoa(String.fromCharCode(...this._hexToBytes(hex)));
  }

  private _hexToBytes(hex: string): Uint8Array {
    return new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((byte) => parseInt(byte, 16)));
  }

  private _base64ToHex(base64: string): string {
    if (typeof atob === 'function') {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return this._bytesToHex(bytes);
    }

    const BufferCtor = (globalThis as any).Buffer;
    if (BufferCtor) {
      return this._bytesToHex(new Uint8Array(BufferCtor.from(base64, 'base64')));
    }

    throw new Error('No base64 decoder available in this environment');
  }

  /**
   * FROST participant identifiers are derived from the SORTED participant
   * device-id order — this MUST match the Rust core's `canonical_identifier`
   * (apps/tui-node/src/protocal/dkg.rs), which does `participants.sort()` then
   * `position + 1`. The signal server grows the participant list in *join*
   * order, which is generally NOT sorted; if we used it as-is, our `indexOf`
   * based identifiers would disagree with the Rust nodes and a mixed
   * extension↔CLI/TUI ceremony would fail. Normalizing here (a plain
   * lexicographic sort, matching Rust `Vec<String>::sort()`) makes every
   * identifier in this class canonical regardless of join order. (#29)
   */
  private _withSortedParticipants(info: SessionInfo | null): SessionInfo | null {
    if (!info || !Array.isArray(info.participants)) return info;
    return { ...info, participants: [...info.participants].sort() };
  }

  private _updateSession(newSessionInfo: SessionInfo | null) {
    this.sessionInfo = this._withSortedParticipants(newSessionInfo);
    this.onSessionUpdate(this.sessionInfo, this.invites);
  }

  private _updateMeshStatus(newStatus: MeshStatus) {
    this.meshStatus = newStatus;
    this.onMeshStatusUpdate(this.meshStatus);

    if (newStatus.type === MeshStatusType.Ready) {
      this._log("Mesh is Ready.");

      if (this.pendingDkgTriggerBlockchain && this.dkgState === DkgState.Idle) {
        const blockchain = this.pendingDkgTriggerBlockchain;
        this.pendingDkgTriggerBlockchain = null;
        this._log(`Retrying pending DKG trigger now that mesh is ready (${blockchain})`);
        void this.checkAndTriggerDkg(blockchain);
      }

      // M3 reshare: unlike DKG, the reshare trigger has already been
      // armed by startReshare (the background only fires it once the
      // full new cohort joined), so mesh-ready IS the go signal.
      this._maybeInitReshare();
    }
  }

  private _updateDkgState(newState: DkgState) {
    this.dkgState = newState;
    if (newState === DkgState.Complete || newState === DkgState.Failed) this.ceremonyOutbox.clear();
    this.onDkgStateUpdate(this.dkgState);
  }

  private _updateSigningState(newState: SigningState, info: SigningInfo | null = null) {
    this.signingState = newState;
    // A frame from a finished ceremony must never reach the next one (CLI
    // peers buffer pre-session SIGN_COMMITs).
    if (newState === SigningState.Complete) this._rememberFinishedFrames();
    if (newState === SigningState.Complete || newState === SigningState.Failed) {
      this.ceremonyOutbox.clear();
      if (this.signingTimer) clearTimeout(this.signingTimer);
      this.signingTimer = null;
    }
    this.signingInfo = info;
    this.onSigningStateUpdate(this.signingState, this.signingInfo);
  }

  public handleWebSocketMessagePayload(fromPeerId: string, msg: WebSocketMessagePayload): void {
    this._log(`Received WebSocketMessage from ${fromPeerId}: ${msg.websocket_msg_type}`);
    this._log(`Full message payload: ${JSON.stringify(msg)}`);

    switch (msg.websocket_msg_type) {
      case 'WebRTCSignal':
        this._log(`WebRTCSignal data: ${JSON.stringify(msg)}`);

        // Accept WebRTC signals from any peer - no session requirement
        this._log(`Processing WebRTC signal from ${fromPeerId} (no session check)`);

        // Handle different message structures
        let signalData = null;
        if ((msg as any).data) {
          // Standard structure: { data: { type: "Offer/Answer/Candidate", data: {...} } }
          signalData = (msg as any).data;
        } else if ((msg as any).Offer) {
          // Server structure: { Offer: {...}, websocket_msg_type: "WebRTCSignal" }
          signalData = { type: 'Offer', data: (msg as any).Offer };
        } else if ((msg as any).Answer) {
          // Server structure: { Answer: {...}, websocket_msg_type: "WebRTCSignal" }
          signalData = { type: 'Answer', data: (msg as any).Answer };
        } else if ((msg as any).Candidate) {
          // Server structure: { Candidate: {...}, websocket_msg_type: "WebRTCSignal" }
          signalData = { type: 'Candidate', data: (msg as any).Candidate };
        }

        if (signalData) {
          this._log(`Extracted WebRTC signal: ${JSON.stringify(signalData)}`);
          this.handleWebRTCSignal(fromPeerId, signalData as WebRTCSignal);
        } else {
          this._log(`WebRTCSignal from ${fromPeerId} missing data - full msg: ${JSON.stringify(msg)}`);
        }
        break;

      default:
        // Handle unknown message types with proper logging
        this._log(`Unknown WebSocketMessage type from ${fromPeerId}: ${(msg as any).websocket_msg_type}. Full payload: ${JSON.stringify(msg)}`);
        break;
    }
  }

  public async handleWebRTCSignal(fromPeerId: string, signal: any): Promise<void> {
    try {
      this._log(`handleWebRTCSignal called with: ${JSON.stringify(signal)}`);

      // Normalize signal structure
      let actualSignal = signal;
      if (signal && signal.type && signal.data) {
        actualSignal = signal;
      } else if (signal && (signal.sdp || signal.candidate)) {
        if (signal.sdp) {
          actualSignal = {
            type: signal.type || (signal.sdp.includes('a=sendrecv') ? 'Offer' : 'Answer'),
            data: { sdp: signal.sdp }
          };
        } else if (signal.candidate) {
          actualSignal = {
            type: 'Candidate',
            data: {
              candidate: signal.candidate,
              sdpMid: signal.sdpMid,
              sdpMLineIndex: signal.sdpMLineIndex
            }
          };
        }
      } else {
        this._log(`Invalid WebRTCSignal structure from ${fromPeerId}: ${JSON.stringify(signal)}`);
        return;
      }

      this._log(`Processing WebRTCSignal ${actualSignal.type} from ${fromPeerId}`);

      if (actualSignal.type === 'Offer' && !this._acceptsOffer(fromPeerId)) return;

      const pc = await this._getOrCreatePeerConnection(fromPeerId);
      if (!pc) {
        this._log(`No peer connection for ${fromPeerId} to handle signal.`);
        return;
      }

      // Comprehensive pattern matching for signal types
      switch (actualSignal.type) {
        case 'Offer':
          if (actualSignal.data && actualSignal.data.sdp) {
            // When receiving an offer, the offerer should have created the data channel
            // We'll receive it via ondatachannel event
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: actualSignal.data.sdp }));
            this._log(`Set remote offer from ${fromPeerId}. Creating answer.`);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // Create WebSocketMessage that matches Rust enum structure exactly
            const wsMsgPayload = {
              websocket_msg_type: 'WebRTCSignal',
              Answer: { sdp: answer.sdp! }  // Direct at root level, no nesting
            };

            if (this.sendPayloadToBackgroundForRelay) {
              this.sendPayloadToBackgroundForRelay(fromPeerId, wsMsgPayload as any);
              this._log(`Sent Answer to ${fromPeerId} via background`);
            } else {
              this._log(`Cannot send Answer to ${fromPeerId}: no relay callback available`);
            }
          } else {
            this._log(`Offer from ${fromPeerId} missing SDP data. Data: ${JSON.stringify(actualSignal.data)}`);
          }
          break;

        case 'Answer':
          if (actualSignal.data && actualSignal.data.sdp) {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: actualSignal.data.sdp }));
            this._log(`Set remote answer from ${fromPeerId}. Connection should be established soon.`);
          } else {
            this._log(`Answer from ${fromPeerId} missing SDP data. Data: ${JSON.stringify(actualSignal.data)}`);
          }
          break;

        case 'Candidate':
          if (actualSignal.data && actualSignal.data.candidate) {
            // Fix: Handle empty string sdpMid but valid sdpMLineIndex
            const sdpMid = actualSignal.data.sdpMid && actualSignal.data.sdpMid.trim() !== ""
              ? actualSignal.data.sdpMid
              : null;

            // Keep original sdpMLineIndex value (0 is valid!)
            const sdpMLineIndex = actualSignal.data.sdpMLineIndex;

            const candidate = new RTCIceCandidate({
              candidate: actualSignal.data.candidate,
              sdpMid: sdpMid,
              sdpMLineIndex: sdpMLineIndex,
            });

            if (pc.remoteDescription) {
              await pc.addIceCandidate(candidate);
              this._log(`Added ICE candidate from ${fromPeerId}`);
            } else {
              this._log(`Queued ICE candidate from ${fromPeerId} (remote description not set)`);
              const pending = this.pendingIceCandidates.get(fromPeerId) || [];
              pending.push(candidate);
              this.pendingIceCandidates.set(fromPeerId, pending);
            }
          } else {
            this._log(`Candidate from ${fromPeerId} missing candidate data. Data: ${JSON.stringify(actualSignal.data)}`);
          }
          break;

        // Handle potential additional signal types
        case 'offer':
        case 'answer':
          this._log(`Received lowercase signal type '${actualSignal.type}' from ${fromPeerId}, converting to title case`);
          // Recursively handle with proper casing
          const normalizedSignal = {
            ...actualSignal,
            type: actualSignal.type.charAt(0).toUpperCase() + actualSignal.type.slice(1)
          };
          await this.handleWebRTCSignal(fromPeerId, normalizedSignal);
          break;

        default:
          this._log(`Unknown signal type '${actualSignal.type}' from ${fromPeerId}. Full signal: ${JSON.stringify(actualSignal)}`);
          break;
      }
    } catch (error) {
      this._log(`Error handling WebRTCSignal from ${fromPeerId}: ${this._getErrorMessage(error)}. Signal: ${JSON.stringify(signal)}`);
    }
  }

  // --- Session Management ---
  public resetSession(): void {
    this._log("Resetting session state.");

    // Report all connections as disconnected
    this.peerConnections.forEach((pc, peerId) => {
      this.onWebRTCConnectionUpdate(peerId, false);
      pc.close();
    });

    this.peerConnections.clear();
    this.dataChannels.clear();
    this.pendingIceCandidates.clear();
    this._updateSession(null);
    this.invites = [];
    this.onSessionUpdate(this.sessionInfo, this.invites);
    this._updateMeshStatus({ type: MeshStatusType.Incomplete });
    this._updateDkgState(DkgState.Idle);

    // Reset mesh ready flag to allow mesh_ready signals for new sessions
    this.ownMeshReadySent = false;
    this._log("Reset ownMeshReadySent flag for session reset");

    // Reset FROST DKG state
    this._resetDkgState();

    // Reset FROST reshare state
    this._resetReshareState();
  }

  public sendWebRTCAppMessage(toPeerId: string, message: WebRTCAppMessage): void {
    if (isCeremonyFrame(message)) {
      const outbox = this.ceremonyOutbox.get(toPeerId) ?? [];
      outbox.push(message);
      this.ceremonyOutbox.set(toPeerId, outbox);
    }
    const dc = this.dataChannels.get(toPeerId);
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(message));
      this._log(`Sent WebRTCAppMessage to ${toPeerId}: ${JSON.stringify(message)}`);
    } else {
      // The channel may still be opening (a peer that just (re)connected);
      // deliver when it opens rather than dropping the message.
      const queue = this.pendingSends.get(toPeerId) ?? [];
      queue.push(message);
      this.pendingSends.set(toPeerId, queue);
      this._logVerbose(`Queued WebRTCAppMessage for ${toPeerId}: data channel not open yet.`);
    }
  }

  /**
   * Expose the derived address / group public key for the popup's
   * address-display flows. Offscreen/index.ts calls these by name
   * from the background-command switch; fields are private so they
   * need public accessors. Returns null when the ceremony hasn't
   * completed yet.
   */
  public getGroupPublicKey(): string | null {
    return this.groupPublicKey;
  }
  public getEthereumAddress(): string | null {
    return this.ethereumAddress;
  }
  public getSolanaAddress(): string | null {
    return this.solanaAddress;
  }

  /**
   * Send a plain text / debug message to a peer over the data
   * channel. Distinct from sendWebRTCAppMessage (which requires a
   * discriminated WebRTCAppMessage shape) — this just wraps the
   * string in a SimpleMessage envelope. Used by the popup's
   * developer-debug Send Direct Message feature. Returns whether
   * the send was attempted (false if data channel isn't open).
   */
  public sendDirectMessage(toPeerId: string, text: string): boolean {
    const dc = this.dataChannels.get(toPeerId);
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({
        webrtc_msg_type: 'SimpleMessage',
        text,
      }));
      this._log(`Sent direct SimpleMessage to ${toPeerId}: ${text}`);
      return true;
    }
    this._logVerbose(`Cannot send direct message to ${toPeerId}: data channel not open.`);
    return false;
  }

  // Missing private methods that tests are calling
  private _sendWebRTCMessage(toPeerId: string, message: WebRTCAppMessage): void {
    this._log(`Sending WebRTC message to ${toPeerId}: ${JSON.stringify(message)}`);
    this.sendWebRTCAppMessage(toPeerId, message);
  }

  // Method to send MeshReady signals to all peers
  private _sendMeshReadyToAllPeers(): void {
    if (!this.sessionInfo) {
      this._log("❌ Cannot send MeshReady: no session info");
      return;
    }

    this._log(`📡 SENDING MESH_READY SIGNALS to all peers`);
    this._log(`Session ID: ${this.sessionInfo.session_id || 'unknown'}`);
    this._log(`Local Peer ID: ${this.localPeerId}`);
    this._log(`Target peers: [${this.sessionInfo.participants.filter(p => p !== this.localPeerId).join(', ')}]`);

    const meshReadyMsg: WebRTCAppMessage = {
      webrtc_msg_type: 'MeshReady',
      session_id: this.sessionInfo.session_id,
      device_id: this.localPeerId
    };

    let sentCount = 0;
    this.sessionInfo.participants.forEach(peerId => {
      if (peerId !== this.localPeerId) {
        const dc = this.dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') {
          this.sendWebRTCAppMessage(peerId, meshReadyMsg);
          sentCount++;
          this._log(`✅ Sent MeshReady signal to ${peerId}`);
        } else {
          this._log(`❌ Cannot send MeshReady to ${peerId}: data channel not open`);
        }
      }
    });

    // Set the flag to prevent duplicate signals even if we couldn't send to all peers
    this.ownMeshReadySent = true;
    this._log(`✅ Set ownMeshReadySent flag to prevent duplicate mesh_ready signals`);
    this._log(`📡 MESH_READY SIGNALS SENT: ${sentCount} signals sent to peers`);
  }

  private async _replayBufferedDkgPackages(): Promise<void> {
    this._log(`🔄 Replaying buffered DKG packages`);

    try {
      // Process any buffered Round 1 packages directly (skip the handler to avoid loops)
      if (this.bufferedRound1Packages.length > 0) {
        this._log(`🔄 Replaying ${this.bufferedRound1Packages.length} buffered Round 1 packages`);
        this._log(`🔄 Current WASM packages before replay: ${this.frostDkg ? 'checking...' : 'no FROST DKG'}`);
        
        // Check WASM state before replay
        if (this.frostDkg) {
          try {
            const canStartBefore = this.frostDkg.can_start_round2();
            this._log(`🔄 WASM can_start_round2 before replay: ${canStartBefore}`);
          } catch (e) {
            this._log(`🔄 Error checking WASM state before replay: ${this._getErrorMessage(e)}`);
          }
        }

        // Create a copy of the buffer to avoid modification during iteration
        const round1Packages = [...this.bufferedRound1Packages];
        this.bufferedRound1Packages = [];

        // Debug session info
        this._log(`🔄 Session participants: ${JSON.stringify(this.sessionInfo?.participants || [])}`);
        this._log(`🔄 Local peer ID: ${this.localPeerId}`);

        // Process each buffered package directly without going through the handler
        for (const { fromPeerId, packageData } of round1Packages) {
          this._log(`🔄 Replaying Round 1 package from ${fromPeerId}`);
          this._log(`🔄 Package data type: ${typeof packageData}, preview: ${JSON.stringify(packageData).substring(0, 100)}...`);
          
          // Skip our own package. frost-core's dkg::part2 contract
          // (see frost-core keys/dkg.rs:505) expects exactly n-1
          // round-1 packages in round1_packages — the signer's own
          // is held as a secret_package on the WASM instance and
          // must NOT be re-added via add_round1_package.
          if (fromPeerId === this.localPeerId) {
            this._log(`🔄 Skipping own Round 1 package during replay (per frost-core n-1 contract)`);
            this.receivedRound1Packages.add(fromPeerId);
            continue;
          }

          // Process the package directly with FROST DKG
          try {
            const participantIndex = this.sessionInfo?.participants.indexOf(fromPeerId);
            const senderIndex = (participantIndex ?? -1) + 1;
            
            this._log(`🔄 Participant index for ${fromPeerId}: ${participantIndex}, sender index: ${senderIndex}`);
            
            if (participantIndex === -1 || participantIndex === undefined) {
              this._log(`🚨 ERROR: ${fromPeerId} not found in session participants list`);
              continue;
            }

            let packageHex: string;

            // Handle package format conversion (same logic as in handler)
            if (typeof packageData === 'string') {
              packageHex = packageData;
              this._log(`🔄 Using string package data`);
            } else if (packageData.data) {
              packageHex = packageData.data;
              this._log(`🔄 Using legacy format with data property`);
            } else {
              // CLI-compatible format: convert JSON to hex
              const packageString = JSON.stringify(packageData);
              const packageBytes = new TextEncoder().encode(packageString);
              packageHex = Array.from(packageBytes).map(b => b.toString(16).padStart(2, '0')).join('');
              this._log(`🔄 Converted CLI format to hex (${packageHex.length} chars)`);
            }

            this._log(`🔄 Package hex length: ${packageHex.length}, starts with: ${packageHex.substring(0, 20)}...`);

            if (senderIndex <= 0) {
              this._log(`🚨 ERROR: Invalid sender index ${senderIndex} for ${fromPeerId}`);
              continue;
            }
            
            if (!packageHex) {
              this._log(`🚨 ERROR: Empty package hex for ${fromPeerId}`);
              continue;
            }
            
            if (!this.frostDkg) {
              this._log(`🚨 ERROR: No FROST DKG instance available`);
              continue;
            }

            // Add the package to WASM with detailed error handling
            this._log(`🔄 About to call frostDkg.add_round1_package(${senderIndex}, packageHex)`);
            this.frostDkg.add_round1_package(senderIndex, packageHex);
            this.receivedRound1Packages.add(fromPeerId);
            this._log(`🔄 ✅ Successfully processed buffered Round 1 package from ${fromPeerId}`);
            
            // Check WASM state after each package
            try {
              const canStartAfter = this.frostDkg.can_start_round2();
              this._log(`🔄 WASM can_start_round2 after adding ${fromPeerId}: ${canStartAfter}`);
            } catch (e) {
              this._log(`🔄 Error checking WASM state after adding ${fromPeerId}: ${this._getErrorMessage(e)}`);
            }
            
          } catch (error) {
            this._log(`🚨 Error processing buffered Round 1 package from ${fromPeerId}: ${this._getErrorMessage(error)}`);
            this._log(`🔄 Error details: ${JSON.stringify(error)}`);
            // Continue processing other packages even if one fails
          }
        }
        
        // Final WASM state check
        if (this.frostDkg) {
          try {
            const finalCanStart = this.frostDkg.can_start_round2();
            this._log(`🔄 Final WASM can_start_round2 after replay: ${finalCanStart}`);
            this._log(`🔄 Final received packages count: ${this.receivedRound1Packages.size}`);
            this._log(`🔄 Expected participants: ${this.sessionInfo?.participants.length || 0}`);
          } catch (e) {
            this._log(`🔄 Error checking final WASM state: ${this._getErrorMessage(e)}`);
          }
        }
      }

      // Process any buffered Round 2 packages
      if (this.bufferedRound2Packages.length > 0 && this.dkgState === DkgState.Round2InProgress) {
        this._log(`🔄 Replaying ${this.bufferedRound2Packages.length} buffered Round 2 packages`);

        // Create a copy of the buffer to avoid modification during iteration
        const round2Packages = [...this.bufferedRound2Packages];
        this.bufferedRound2Packages = [];

        // Process each buffered package
        for (const { fromPeerId, packageData } of round2Packages) {
          this._log(`🔄 Replaying Round 2 package from ${fromPeerId}`);
          await this._handleDkgRound2Package(fromPeerId, packageData);
        }
      }
    } catch (error) {
      this._log(`🚨 ERROR in _replayBufferedDkgPackages: ${this._getErrorMessage(error)}`);
      this._log(`🔍 Error details: ${JSON.stringify(error)}`);
      throw error; // Re-throw to let caller handle
    }
  }

  public async initializeDkg(blockchain: "ethereum" | "solana" = "solana", threshold: number = 0, participants: string[] = [], participantIndex: number = 0): Promise<boolean> {
    // Set blockchain first to ensure correct curve is shown in logs
    this.currentBlockchain = blockchain;

    this._log(`Initializing DKG process for ${blockchain}`);

    if (!this.sessionInfo && participants.length === 0) {
      this._log(`Cannot initialize DKG: no session info or participants provided`);
      return false;
    }

    if (this.dkgState !== DkgState.Idle) {
      this._log(`Cannot initialize DKG: already in progress (state: ${DkgState[this.dkgState]})`);
      return false;
    }

    try {
      // Set to Initializing state immediately to prevent race conditions
      this._updateDkgState(DkgState.Initializing);

      // Reset DKG state
      this._resetDkgState();

      // Set participant index either from params or from session info.
      // Sort the list so the 1-based index matches the Rust core's
      // canonical_identifier (sorted order). If participants come from
      // sessionInfo they're already sorted (_withSortedParticipants), but a
      // direct `participants` arg may not be — sort defensively. (#29)
      const participants_list = (participants.length > 0 ?
        participants :
        this.sessionInfo?.participants || []).slice().sort();

      const threshold_count = threshold > 0 ?
        threshold :
        Math.ceil(participants_list.length / 2); // Default to n/2 + 1

      this.participantIndex = participantIndex > 0 ?
        participantIndex :
        (participants_list.indexOf(this.localPeerId) + 1) || 0; // 1-based, sorted

      if (this.participantIndex <= 0 || this.participantIndex > participants_list.length) {
        throw new Error(`Invalid participant index: ${this.participantIndex}`);
      }

      // Initialize FROST DKG using WebAssembly
      console.log('🔍 FROST DKG INIT: Starting WASM module resolution');
      console.log('🔍 FROST DKG INIT: typeof global:', typeof global);
      console.log('🔍 FROST DKG INIT: typeof window:', typeof window);
      console.log('🔍 FROST DKG INIT: typeof globalThis:', typeof globalThis);
      
      // Check all possible locations for FROST DKG modules
      const FrostDkgEd25519 = 
        (typeof global !== 'undefined' && (global as any).FrostDkgEd25519) ||
        (typeof window !== 'undefined' && (window as any).FrostDkgEd25519) ||
        (typeof globalThis !== 'undefined' && (globalThis as any).FrostDkgEd25519) ||
        null;

      const FrostDkgSecp256k1 = 
        (typeof global !== 'undefined' && (global as any).FrostDkgSecp256k1) ||
        (typeof window !== 'undefined' && (window as any).FrostDkgSecp256k1) ||
        (typeof globalThis !== 'undefined' && (globalThis as any).FrostDkgSecp256k1) ||
        null;

      console.log('🔍 FROST DKG INIT: FrostDkgEd25519 resolved to:', FrostDkgEd25519 ? 'FOUND' : 'NULL');
      console.log('🔍 FROST DKG INIT: FrostDkgSecp256k1 resolved to:', FrostDkgSecp256k1 ? 'FOUND' : 'NULL');
      console.log('🔍 FROST DKG INIT: global.FrostDkgEd25519:', typeof global !== 'undefined' ? typeof (global as any)?.FrostDkgEd25519 : 'global undefined');
      console.log('🔍 FROST DKG INIT: global.FrostDkgSecp256k1:', typeof global !== 'undefined' ? typeof (global as any)?.FrostDkgSecp256k1 : 'global undefined');
      console.log('🔍 FROST DKG INIT: (window as any).FrostDkgEd25519:', typeof (window as any)?.FrostDkgEd25519);
      console.log('🔍 FROST DKG INIT: (window as any).FrostDkgSecp256k1:', typeof (window as any)?.FrostDkgSecp256k1);
      console.log('🔍 FROST DKG INIT: (globalThis as any).FrostDkgEd25519:', typeof (globalThis as any)?.FrostDkgEd25519);
      console.log('🔍 FROST DKG INIT: (globalThis as any).FrostDkgSecp256k1:', typeof (globalThis as any)?.FrostDkgSecp256k1);

      if (!FrostDkgEd25519 || !FrostDkgSecp256k1) {
        console.log('🚨 FROST DKG INIT: WASM modules not found - this will cause failure');
        console.log('🚨 FROST DKG INIT: Available on global:', global ? Object.keys(global).filter(k => k.includes('Frost')) : 'global is null');
        console.log('🚨 FROST DKG INIT: Available on window:', typeof window !== 'undefined' ? Object.keys(window).filter(k => k.includes('Frost')) : 'window is undefined');
        console.log('🚨 FROST DKG INIT: Available on globalThis:', globalThis ? Object.keys(globalThis).filter(k => k.includes('Frost')) : 'globalThis is null');
        throw new Error('FROST DKG WebAssembly modules not found');
      }

      if (blockchain === "ethereum") {
        // Use secp256k1 for Ethereum
        this.frostDkg = new FrostDkgSecp256k1();
        this._log('Created secp256k1 FROST DKG instance for Ethereum');
      } else {
        // Use ed25519 for Solana
        this.frostDkg = new FrostDkgEd25519();
        this._log('Created ed25519 FROST DKG instance for Solana');
      }

      // Initialize the DKG with participant count and threshold
      this.frostDkg.init_dkg(
        this.participantIndex,
        participants_list.length,
        threshold_count
      );

      this._updateDkgState(DkgState.Round1InProgress);
      this._log(`DKG initialized successfully with ${participants_list.length} participants and threshold ${threshold_count}`);

      // Generate and broadcast our Round 1 package
      await this._generateAndBroadcastRound1();

      // Process any buffered packages now that we're initialized
      await this._replayBufferedDkgPackages();

      // Check if we can proceed to Round 2 after processing buffered packages
      this._log(`🔍 POST-REPLAY CHECK: receivedRound1Packages.size=${this.receivedRound1Packages.size}, expected=${this.sessionInfo?.participants.length || 0}`);
      this._log(`🔍 POST-REPLAY CHECK: receivedRound1Packages contents: [${Array.from(this.receivedRound1Packages).join(', ')}]`);
      this._log(`🔍 POST-REPLAY CHECK: sessionInfo.participants: [${this.sessionInfo?.participants.join(', ') || 'none'}]`);
      
      if (this.frostDkg) {
        try {
          const canStartRound2 = this.frostDkg.can_start_round2();
          this._log(`🔍 POST-REPLAY CHECK: WASM can_start_round2=${canStartRound2}`);
        } catch (e) {
          this._log(`🔍 POST-REPLAY CHECK: Error checking can_start_round2: ${this._getErrorMessage(e)}`);
        }
      }
      
      // Check if any participants are missing from received packages
      if (this.sessionInfo) {
        const missing = this.sessionInfo.participants.filter(p => !this.receivedRound1Packages.has(p));
        if (missing.length > 0) {
          this._log(`🚨 POST-REPLAY CHECK: Missing Round 1 packages from: [${missing.join(', ')}]`);

          // Request missing Round 1 packages from peers. Stub —
          // peers will re-broadcast on the next mesh-ready cycle
          // via the normal ordering; an explicit request protocol
          // hasn't been wired yet. Logging so the ask is visible
          // if the retry path ever becomes needed.
          this._log(`📡 Need missing Round 1 packages from: [${missing.join(', ')}] — awaiting peer re-broadcast`);
        }
      }
      
      if (this.sessionInfo && 
          this.receivedRound1Packages.size >= this.sessionInfo.participants.length &&
          this.frostDkg.can_start_round2()) {
        this._log(`✅ All Round 1 packages received after replay, proceeding to Round 2`);
        this._updateDkgState(DkgState.Round2InProgress);
        await this._generateAndBroadcastRound2();
        
        // Process any buffered Round 2 packages
        await this._replayBufferedDkgPackages();
      } else {
        this._log(`❌ Cannot proceed to Round 2 yet:`);
        this._log(`   - Session info: ${!!this.sessionInfo}`);
        this._log(`   - Received packages: ${this.receivedRound1Packages.size}`);
        this._log(`   - Expected packages: ${this.sessionInfo?.participants.length || 0}`);
        this._log(`   - WASM can_start_round2: ${this.frostDkg ? 'checking...' : 'no FROST DKG'}`);
        if (this.frostDkg) {
          try {
            const canStart = this.frostDkg.can_start_round2();
            this._log(`   - WASM can_start_round2: ${canStart}`);
          } catch (e) {
            this._log(`   - WASM can_start_round2: ERROR - ${this._getErrorMessage(e)}`);
          }
        }
      }

      return true;
    } catch (error) {
      this._log(`Error initializing DKG: ${this._getErrorMessage(error)}`);
      this._resetDkgState();
      this._updateDkgState(DkgState.Failed);
      return false;
    }
  }

  // Generate and broadcast Round 1 packages
  private async _generateAndBroadcastRound1(): Promise<void> {
    this._log(`Generating and broadcasting Round 1 packages`);

    if (!this.frostDkg) {
      this._log(`Cannot generate Round 1 packages: DKG not initialized`);
      return;
    }

    try {
      // Update state to Round1InProgress before generating packages
      this._updateDkgState(DkgState.Round1InProgress);

      // Generate Round 1 package using FROST DKG
      const round1Package = this.frostDkg.generate_round1();
      this._log(`Generated Round 1 package (hex): ${round1Package.substring(0, 20)}...`);

      // Broadcast in the CLI/TUI native frame (FROST binary, base64).
      const text = `DKG_ROUND1:${this._hexToBase64(this._frostWire("round1", round1Package))}`;
      for (const peerId of this.sessionInfo?.participants ?? []) {
        if (peerId !== this.localPeerId) {
          this.sendWebRTCAppMessage(peerId, { webrtc_msg_type: "SimpleMessage", text });
        }
      }

      // Process our own package locally - but only add to received set, don't add to FROST DKG
      // (FROST DKG already includes our own package when generate_round1() was called)
      this.receivedRound1Packages.add(this.localPeerId);
      this._log(`Added own Round 1 package to received set. Total: ${this.receivedRound1Packages.size}`);

    } catch (error) {
      this._log(`Error generating/broadcasting Round 1 package: ${this._getErrorMessage(error)}`);
      this._updateDkgState(DkgState.Failed);
    }
  }

  public handleWebRTCAppMessage(fromPeerId: string, message: WebRTCAppMessage): void {
    this._log(`Handling WebRTC app message from ${fromPeerId}: ${JSON.stringify(message)}`);

    // Call the existing onWebRTCAppMessage callback
    this.onWebRTCAppMessage(fromPeerId, message);

    // Process specific message types using webrtc_msg_type format
    if ((message as any).webrtc_msg_type) {
      switch ((message as any).webrtc_msg_type) {
        case 'SimpleMessage':
          {
            const text = (message as any).text;
            this._log(`Received SimpleMessage from ${fromPeerId}: ${text}`);
            if (typeof text === 'string') {
              if (text.startsWith('DKG_ROUND1:')) {
                try {
                  const packageHex = this._base64ToHex(text.slice('DKG_ROUND1:'.length));
                  void this._handleDkgRound1Package(fromPeerId, packageHex);
                } catch (error) {
                  this._log(`Failed to decode DKG_ROUND1 from ${fromPeerId}: ${this._getErrorMessage(error)}`);
                }
              } else if (text.startsWith('DKG_ROUND2:')) {
                try {
                  const packageHex = this._base64ToHex(text.slice('DKG_ROUND2:'.length));
                  void this._handleDkgRound2Package(fromPeerId, packageHex);
                } catch (error) {
                  this._log(`Failed to decode DKG_ROUND2 from ${fromPeerId}: ${this._getErrorMessage(error)}`);
                }
              } else if (text.startsWith('RESHARE_ROUND1:')) {
                this._handleReshareRound1Package(fromPeerId, {
                  package: this._base64ToHex(text.slice('RESHARE_ROUND1:'.length)),
                });
              } else if (text.startsWith('RESHARE_ROUND2:')) {
                this._handleReshareRound2Package(fromPeerId, {
                  package: this._base64ToHex(text.slice('RESHARE_ROUND2:'.length)),
                });
              } else if (text.startsWith('SIGN_SET:')) {
                this._handleSignerSet(fromPeerId, text);
              } else if (text.startsWith('SIGN_COMMIT:') || text.startsWith('SIGN_SHARE:')) {
                // Signing frames carry no ceremony id — one ceremony runs
                // at a time, so they belong to the active one.
                const signing_id = this.signingInfo?.signing_id;
                const isCommit = text.startsWith('SIGN_COMMIT:');
                const hex = this._base64ToHex(text.slice(isCommit ? 'SIGN_COMMIT:'.length : 'SIGN_SHARE:'.length));
                if (this.finishedCeremonyFrames.has(hex)) {
                  // A peer resending (#117) a frame of the ceremony that just
                  // ended. Nonce commitments / shares never repeat, so it
                  // must not be taken for the next ceremony's.
                  this._log(`Ignoring a late ${isCommit ? "SIGN_COMMIT" : "SIGN_SHARE"} resend from ${fromPeerId} (previous ceremony)`);
                } else if (isCommit) {
                  this._handleSigningCommitment(fromPeerId, { signing_id, commitment: hex });
                } else {
                  this._handleSignatureShare(fromPeerId, { signing_id, share: hex });
                }
              }
            }
          }
          break;
        case 'MeshReady':
          this._log(`Received MeshReady message from ${fromPeerId}`);
          this._processPeerMeshReady(fromPeerId);
          break;
        case 'DkgRound1Package':
          if ((message as any).package) {
            this._handleDkgRound1Package(fromPeerId, (message as any).package);
          }
          break;
        case 'DkgRound2Package':
          if ((message as any).package) {
            this._handleDkgRound2Package(fromPeerId, (message as any).package);
          }
          break;
        case 'ReshareRound1Package':
          this._handleReshareRound1Package(fromPeerId, message as any);
          break;
        case 'ReshareRound2Package':
          this._handleReshareRound2Package(fromPeerId, message as any);
          break;
        case 'SigningCommitment':
          this._handleSigningCommitment(fromPeerId, message as any);
          break;
        case 'SignatureShare':
          this._handleSignatureShare(fromPeerId, message as any);
          break;
        case 'AggregatedSignature':
          this._handleAggregatedSignature(fromPeerId, message as any);
          break;
        default:
          this._log(`Unhandled WebRTC app message type from ${fromPeerId}: ${JSON.stringify(message)}`);
          break;
      }
    } else {
      this._log(`Unhandled WebRTC app message type from ${fromPeerId}: ${JSON.stringify(message)}`);
    }
  }

  private _tryAggregateSignature(): void {
    this._log(`Attempting to aggregate signature`);

    if (!this.signingInfo) {
      this._log(`Cannot aggregate signature: no signing info`);
      return;
    }

    // Check if we have all required signature shares
    const allSharesReceived = this.signingInfo.selected_signers.every(signer =>
      this.signingShares.has(signer)
    );

    if (!allSharesReceived) {
      this._log(`Cannot aggregate signature: missing signature shares`);
      return;
    }

    // Every signer aggregates for itself (CLI/TUI peers never broadcast
    // the aggregate).
    if (this.signingState !== SigningState.Complete) {
      this._aggregateSignatureAndBroadcast();
    }
  }

  private _processPeerMeshReady(fromPeerId: string): void {
    this._log(`Processing mesh ready signal from ${fromPeerId}`);

    if (!this.sessionInfo) {
      this._log(`Cannot process MeshReady from ${fromPeerId}: no active session`);
      return;
    }

    // Update mesh status to include this peer as ready
    const currentStatus = this.meshStatus;
    let readyPeers = new Set<string>();

    if (currentStatus.type === MeshStatusType.PartiallyReady && (currentStatus as any).ready_devices) {
      // Copy existing ready_devices from PartiallyReady state
      readyPeers = new Set((currentStatus as any).ready_devices);
    } else if (currentStatus.type === MeshStatusType.Ready) {
      // If already Ready, all participants are ready
      readyPeers = new Set(this.sessionInfo.participants);
    } else {
      // Initialize with local peer for Incomplete state
      readyPeers = new Set([this.localPeerId]);
    }

    // Add the new ready peer
    readyPeers.add(fromPeerId);

    this._log(`Peer ${fromPeerId} is now mesh ready. Ready peers: [${Array.from(readyPeers).join(', ')}]`);

    // Check if all participants are now ready
    const allParticipantsReady = this.sessionInfo.participants.every(peerId =>
      readyPeers.has(peerId)
    );

    if (allParticipantsReady) {
      this._log("All participants are mesh ready! Transitioning to fully Ready state.");
      this._updateMeshStatus({
        type: MeshStatusType.Ready
      });
    } else {
      this._log(`Not all participants ready yet. Ready: ${readyPeers.size}/${this.sessionInfo.participants.length}`);
      this._updateMeshStatus({
        type: MeshStatusType.PartiallyReady,
        ready_devices: readyPeers,
        total_devices: this.sessionInfo.participants.length
      });
    }
  }

  private _checkMeshStatus(): void {
    if (!this.sessionInfo) return;

    const totalPeers = this.sessionInfo.participants.length;
    const connectedPeers = Array.from(this.dataChannels.keys()).filter(peerId => {
      const dc = this.dataChannels.get(peerId);
      return dc && dc.readyState === 'open';
    }).length + 1; // +1 for self

    // Check if all session participants have accepted
    const allParticipantsAccepted = this.sessionInfo.participants.every(peerId =>
      this.sessionInfo!.accepted_devices.includes(peerId)
    );

    // Enhanced logging to trace mesh status determination
    this._log(`=== MESH STATUS CHECK ===`);
    this._log(`Session ID: ${this.sessionInfo.session_id || 'unknown'}`);
    this._log(`Local Peer ID: ${this.localPeerId}`);
    this._log(`Expected peers: [${this.sessionInfo.participants.join(', ')}]`);
    this._log(`Accepted devices: [${this.sessionInfo.accepted_devices.join(', ')}]`);
    this._log(`All participants accepted: ${allParticipantsAccepted}`);
    this._log(`Open data channels: ${connectedPeers - 1}/${totalPeers - 1}`);
    this._log(`Own mesh ready sent: ${this.ownMeshReadySent}`);
    this._log(`Current mesh status: ${this.meshStatus.type}`);

    // Only send mesh ready if BOTH conditions are met:
    // 1. All data channels are open
    // 2. All session participants have accepted
    if (connectedPeers >= totalPeers && allParticipantsAccepted) {
      this._log("All data channels open AND all participants accepted - sending MeshReady signals if not sent yet");

      // Broadcast MeshReady to all peers if not done yet
      if (!this.ownMeshReadySent) {
        this._sendMeshReadyToAllPeers();
        // Flag is set in _sendMeshReadyToAllPeers
      }

      this._updateMeshStatus({ type: MeshStatusType.Ready });
    } else {
      const reason = [];
      if (connectedPeers < totalPeers) {
        reason.push(`data channels not ready (${connectedPeers}/${totalPeers})`);
      }
      if (!allParticipantsAccepted) {
        reason.push(`not all participants accepted (${this.sessionInfo.accepted_devices.length}/${this.sessionInfo.participants.length})`);
      }
      this._log(`Not ready for mesh ready signals: ${reason.join(', ')}`);

      this._updateMeshStatus({
        type: MeshStatusType.PartiallyReady,
        ready_devices: new Set([this.localPeerId, ...Array.from(this.dataChannels.keys()).filter(peerId => {
          const dc = this.dataChannels.get(peerId);
          return dc && dc.readyState === 'open';
        })]),
        total_devices: totalPeers
      });
    }
  }

  private async _handleDkgRound1Package(fromPeerId: string, packageData: any): Promise<void> {
    this._log(`Handling DKG Round 1 package from ${fromPeerId}`);

    // Skip processing our own Round 1 package. Our secret side is
    // held by the WASM instance from generate_round1(); frost-core's
    // dkg::part2 then expects exactly n-1 peer packages to ingest,
    // NOT our own — if we added self here, can_start_round2 (which
    // checks len == total - 1) would flip false and block progress.
    if (fromPeerId === this.localPeerId) {
      this._log(`Skipping own Round 1 package (dkg::part2 takes n-1 peer packages only)`);
      // Still record our own in the JS-side set so UI progress
      // indicators show the right count.
      if (this.dkgState !== DkgState.Idle) {
        this.receivedRound1Packages.add(fromPeerId);
        this._log(`Added own package to received set. Total: ${this.receivedRound1Packages.size}`);
      }
      return;
    }

    if (this.dkgState === DkgState.Idle) {
      // Buffer the package if DKG hasn't started yet
      this.bufferedRound1Packages.push({ fromPeerId, packageData });
      this._log(`Buffered Round 1 package from ${fromPeerId} (DKG not started)`);

      // Enhanced auto-trigger logic: Start DKG if we have session info and any of:
      // 1. Mesh is fully Ready, OR
      // 2. Mesh is PartiallyReady and all session participants have accepted, OR
      // 3. We have buffered packages from every expected remote peer (TUI or extension).
      const shouldAutoTrigger = this._shouldAutoTriggerDkg();

      this._log(`Auto-trigger evaluation: meshType=${MeshStatusType[this.meshStatus.type]}, sessionInfo=${!!this.sessionInfo}, shouldTrigger=${shouldAutoTrigger}`);

      if (shouldAutoTrigger) {
        this._log(`🚀 Auto-triggering DKG since conditions are met and Round 1 package received`);
        this._log(`🚀 Auto-trigger state: bufferedRound1Packages.length=${this.bufferedRound1Packages.length}`);
        this._log(`🚀 Auto-trigger state: buffered packages from: [${this.bufferedRound1Packages.map(p => p.fromPeerId).join(', ')}]`);
        const blockchain = this.currentBlockchain || "solana"; // Default to solana
        this._log(`Using blockchain: ${blockchain}`);
        await this.initializeDkg(blockchain);
      } else {
        this._log(`❌ Auto-trigger conditions not met - will wait for more conditions or manual trigger`);
      }
      return;
    }

    if (this.dkgState === DkgState.Initializing) {
      // Buffer the package if DKG is currently initializing
      this.bufferedRound1Packages.push({ fromPeerId, packageData });
      this._log(`Buffered Round 1 package from ${fromPeerId} (DKG initializing)`);
      return;
    }

    // Check if we have proper FROST DKG initialized
    if (!this.frostDkg) {
      this._log(`Cannot process Round 1 package: DKG not initialized`);
      return;
    }

    try {
      // Process the Round 1 package with FROST DKG
      const senderIndex = (this.sessionInfo?.participants.indexOf(fromPeerId) ?? -1) + 1;
      let packageHex: string;

      this._log(`🔍 PRE-PROCESS: fromPeerId=${fromPeerId}, senderIndex=${senderIndex}`);
      this._log(`🔍 PRE-PROCESS: participants=${JSON.stringify(this.sessionInfo?.participants)}`);
      this._log(`🔍 PRE-PROCESS: packageData type=${typeof packageData}`);

      // Handle both legacy format (with data property) and new CLI-compatible format (structured object)
      if (typeof packageData === 'string') {
        packageHex = packageData;
        this._log(`🔍 PRE-PROCESS: Using string packageData`);
      } else if (packageData.data) {
        // Legacy format: { sender_index: X, data: "hex_string" }
        packageHex = packageData.data;
        this._log(`🔍 PRE-PROCESS: Using legacy format with data property`);
      } else {
        // New CLI-compatible format: structured object
        // Convert JSON object to proper hex encoding for WASM
        const packageString = JSON.stringify(packageData);
        const packageBytes = new TextEncoder().encode(packageString);
        packageHex = Array.from(packageBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        this._log(`🔍 PRE-PROCESS: Using CLI-compatible format, converted JSON to hex (${packageHex.length} chars)`);
      }

      if (!senderIndex) {
        throw new Error(`Could not determine sender index for ${fromPeerId}`);
      }

      if (!packageHex) {
        throw new Error(`No package data from ${fromPeerId}`);
      }

      this._log(`🔍 PRE-PROCESS: About to call frostDkg.add_round1_package(${senderIndex}, packageHex.length=${packageHex.length})`);

      // Comprehensive validation before WASM call
      if (!this.frostDkg) {
        throw new Error(`FROST DKG instance is null/undefined - cannot add round1 package`);
      }

      if (typeof this.frostDkg.add_round1_package !== 'function') {
        throw new Error(`FROST DKG add_round1_package method is not available. Type: ${typeof this.frostDkg.add_round1_package}`);
      }

      this._log(`🔍 VALIDATION: FROST DKG instance exists and has add_round1_package method`);
      this._log(`🔍 VALIDATION: DKG state: ${this.dkgState}, senderIndex: ${senderIndex}, packageHex type: ${typeof packageHex}`);

      // Additional validation - check FROST DKG internal state
      try {
        // Check if FROST DKG has been properly initialized
        const canStartRound2 = this.frostDkg.can_start_round2 && this.frostDkg.can_start_round2();
        this._log(`🔍 VALIDATION: FROST DKG can_start_round2: ${canStartRound2}`);
      } catch (stateError) {
        this._log(`🚨 VALIDATION WARNING: Could not check FROST DKG state: ${this._getErrorMessage(stateError)}`);
      }

      // Add the Round 1 package to FROST DKG with specific error handling
      try {
        this.frostDkg.add_round1_package(senderIndex, packageHex);
        this._log(`🔍 POST-PROCESS: Successfully added Round 1 package to FROST DKG`);
      } catch (wasmError: any) {
        this._log(`🚨 WASM ERROR in add_round1_package: ${this._getErrorMessage(wasmError)}`);
        this._log(`🔍 WASM Error details: ${JSON.stringify(wasmError)}`);
        this._log(`🔍 WASM Error name: ${wasmError?.name || 'unknown'}`);
        this._log(`🔍 WASM Error message: ${wasmError?.message || 'unknown'}`);
        this._log(`🔍 WASM Error stack: ${wasmError?.stack || 'unknown'}`);
        this._log(`🔍 WASM senderIndex: ${senderIndex} (type: ${typeof senderIndex})`);
        this._log(`🔍 WASM packageHex length: ${packageHex.length} (type: ${typeof packageHex})`);
        this._log(`🔍 WASM packageHex preview: ${packageHex.substring(0, 100)}...`);
        this._log(`🔍 WASM FROST DKG type: ${this.frostDkg.constructor?.name || 'unknown'}`);
        
        // Try to get more info about the FROST DKG state
        try {
          this._log(`🔍 WASM FROST DKG toString: ${this.frostDkg.toString()}`);
        } catch (toStringError) {
          this._log(`🔍 WASM Could not get FROST DKG toString: ${this._getErrorMessage(toStringError)}`);
        }
        
        throw wasmError; // Re-throw to be caught by outer catch
      }

      // Add to received packages set
      this.receivedRound1Packages.add(fromPeerId);
      this._log(`Processed Round 1 package from ${fromPeerId}. Total: ${this.receivedRound1Packages.size}`);
      this._log(`🔍 ROUND1→ROUND2 CHECK: receivedRound1Packages.size=${this.receivedRound1Packages.size}, expected=${this.sessionInfo?.participants.length || 0}`);

      // Check if we have all packages needed and can proceed to Round 2
      if (this.sessionInfo) {
        const hasAllPackages = this.receivedRound1Packages.size >= this.sessionInfo.participants.length;
        let canStartRound2 = false;
        
        try {
          canStartRound2 = this.frostDkg.can_start_round2();
          this._log(`🔍 ROUND1→ROUND2 CHECK: WASM can_start_round2=${canStartRound2}`);
        } catch (e) {
          this._log(`🔍 ROUND1→ROUND2 CHECK: Error checking can_start_round2: ${this._getErrorMessage(e)}`);
        }
        
        this._log(`🔍 ROUND1→ROUND2 CHECK: hasAllPackages=${hasAllPackages}, canStartRound2=${canStartRound2}`);
        
        if (hasAllPackages && canStartRound2) {
          this._log(`✅ All Round 1 packages received and can proceed. Moving to Round 2.`);
          this._updateDkgState(DkgState.Round2InProgress);
          await this._generateAndBroadcastRound2();

          // Process any buffered Round 2 packages that arrived while we were in Round 1
          await this._replayBufferedDkgPackages();
        } else {
          this._log(`❌ Cannot proceed to Round 2: hasAllPackages=${hasAllPackages}, canStartRound2=${canStartRound2}`);
        }
      }
    } catch (error) {
        // Enhanced error logging for debugging DKG failures - with error protection
        try {
          const errorMessage = this._getErrorMessage(error);
          this._log(`🚨 ERROR processing Round 1 package from ${fromPeerId}: ${errorMessage}`);
          
          try {
            this._log(`🔍 Error details: ${JSON.stringify(error)}`);
          } catch (e) {
            this._log(`🔍 Error details: [Cannot stringify error]`);
          }
          
          this._log(`🔍 Package data type: ${typeof packageData}`);
          
          try {
            this._log(`🔍 Package data: ${JSON.stringify(packageData)}`);
          } catch (e) {
            this._log(`🔍 Package data: [Cannot stringify package data]`);
          }
          
          try {
            this._log(`🔍 Session info: ${JSON.stringify(this.sessionInfo)}`);
          } catch (e) {
            this._log(`🔍 Session info: [Cannot stringify session info]`);
          }
          
          this._log(`🔍 DKG state before error: ${DkgState[this.dkgState]}`);
          
          // Additional debugging info
          this._log(`🔍 fromPeerId: ${fromPeerId}`);
          this._log(`🔍 localPeerId: ${this.localPeerId}`);
          this._log(`🔍 receivedRound1Packages.size: ${this.receivedRound1Packages.size}`);
          this._log(`🔍 sessionInfo?.participants: ${this.sessionInfo?.participants || 'null'}`);
          this._log(`🔍 frostDkg exists: ${!!this.frostDkg}`);
          
        } catch (loggingError) {
          // Fallback if logging itself fails
          console.error('Failed to log DKG error:', loggingError);
          console.error('Original DKG error:', error);
        }

        // Use verbose logging for expected DKG failures in test environment
        this._logVerbose(`Error processing Round 1 package from ${fromPeerId}: ${this._getErrorMessage(error)}`);
        this._updateDkgState(DkgState.Failed);
      }
  }

  private async _handleDkgRound2Package(fromPeerId: string, packageData: any): Promise<void> {
    this._log(`Handling DKG Round 2 package from ${fromPeerId}`);

    if (this.dkgState === DkgState.Idle || this.dkgState === DkgState.Initializing || this.dkgState === DkgState.Round1InProgress) {
      // Buffer the package if DKG hasn't started Round 2 yet
      this.bufferedRound2Packages.push({ fromPeerId, packageData });
      this._log(`Buffered Round 2 package from ${fromPeerId} (DKG not in Round 2)`);
      return;
    }

    // Check if we have proper FROST DKG initialized
    if (!this.frostDkg) {
      this._log(`Cannot process Round 2 package: DKG not initialized`);
      return;
    }

    try {
      // Process the Round 2 package with FROST DKG
      const senderIndex = (this.sessionInfo?.participants.indexOf(fromPeerId) ?? -1) + 1;
      let packageHex: string;

      this._log(`🔍 R2 PRE-PROCESS: fromPeerId=${fromPeerId}, senderIndex=${senderIndex}`);
      this._log(`🔍 R2 PRE-PROCESS: participants=${JSON.stringify(this.sessionInfo?.participants)}`);
      this._log(`🔍 R2 PRE-PROCESS: packageData type=${typeof packageData}`);

      // Handle both legacy format (with data property) and new CLI-compatible format (structured object)
      if (typeof packageData === 'string') {
        packageHex = packageData;
        this._log(`🔍 R2 PRE-PROCESS: Using string packageData`);
      } else if (packageData.data) {
        // Legacy format: { sender_index: X, sender_id_hex: Y, data: "hex_string" }
        packageHex = packageData.data;
        this._log(`🔍 R2 PRE-PROCESS: Using legacy format with data property`);
      } else {
        // New CLI-compatible format: structured object
        // Convert JSON object to proper hex encoding for WASM
        const packageString = JSON.stringify(packageData);
        const packageBytes = new TextEncoder().encode(packageString);
        packageHex = Array.from(packageBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        this._log(`🔍 R2 PRE-PROCESS: Using CLI-compatible format, converted JSON to hex (${packageHex.length} chars)`);
      }

      if (!senderIndex) {
        throw new Error(`Could not determine sender index for ${fromPeerId}`);
      }

      if (!packageHex) {
        throw new Error(`No package data from ${fromPeerId}`);
      }

      // Convert to hex if it's not already
      let finalPackageHex: string;
      if (!packageHex.match(/^[0-9a-fA-F]+$/)) {
        // Convert JSON string to hex
        finalPackageHex = Array.from(new TextEncoder().encode(packageHex))
          .map((byte: number) => byte.toString(16).padStart(2, '0'))
          .join('');
      } else {
        finalPackageHex = packageHex;
      }

      // Add the Round 2 package to FROST DKG
      this._log(`🔍 R2 PRE-PROCESS: About to call frostDkg.add_round2_package(${senderIndex}, packageHex.length=${finalPackageHex.length})`);
      try {
        this.frostDkg.add_round2_package(senderIndex, finalPackageHex);
        this._log(`🔍 R2 POST-PROCESS: Successfully added Round 2 package to FROST DKG`);
      } catch (wasmError: any) {
        this._log(`🚨 WASM ERROR in add_round2_package: ${this._getErrorMessage(wasmError)}`);
        this._log(`🔍 R2 WASM Error details: ${JSON.stringify(wasmError)}`);
        this._log(`🔍 R2 WASM senderIndex: ${senderIndex}`);
        this._log(`🔍 R2 WASM packageHex length: ${finalPackageHex.length}`);
        this._log(`🔍 R2 WASM packageHex preview: ${finalPackageHex.substring(0, 100)}...`);
        throw wasmError; // Re-throw to be caught by outer catch
      }

      // Add to received packages set
      this.receivedRound2Packages.add(fromPeerId);
      this._log(`Processed Round 2 package from ${fromPeerId}. Total: ${this.receivedRound2Packages.size}`);

      // Debug: Check if FROST DKG can finalize after adding this package
      const canFinalize = this.frostDkg.can_finalize();
      this._log(`🔍 R2 DEBUG: After adding package from ${fromPeerId}, can_finalize()=${canFinalize}, receivedRound2Packages.size=${this.receivedRound2Packages.size}, expected=${this.sessionInfo?.participants.length}`);

      // Check if we have all packages needed
      if (this.sessionInfo &&
        this.receivedRound2Packages.size >= this.sessionInfo.participants.length &&
        this.frostDkg.can_finalize()) {
        this._log(`All Round 2 packages received and can finalize. Finalizing DKG.`);
        await this._finalizeDkg();
      }
    } catch (error) {
      // Use verbose logging for expected DKG failures in test environment
      this._logVerbose(`Error processing Round 2 package from ${fromPeerId}: ${this._getErrorMessage(error)}`);
      this._updateDkgState(DkgState.Failed);
    }
  }

  private async _generateAndBroadcastRound2(): Promise<void> {
    this._log(`Generating and broadcasting Round 2 packages`);
    // Ensure we have a FROST DKG instance
    if (!this.frostDkg) {
      this._log(`Cannot generate Round 2 packages: DKG not initialized`);
      return;
    }

    try {
      // Generate Round 2 package map using FROST DKG
      const round2PackageMapHex = this.frostDkg.generate_round2();
      this._log(`Generated Round 2 package map: ${round2PackageMapHex.substring(0, 50)}...`);

      // Decode and parse the package map
      const packageMapBytes = new Uint8Array(round2PackageMapHex.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)));
      const packageMapJson = new TextDecoder().decode(packageMapBytes);
      const packageMap = JSON.parse(packageMapJson);

      this._log(`Package map contains ${Object.keys(packageMap).length} packages`);

      // Send individual packages to each participant
      if (this.sessionInfo) {
        let sentCount = 0;
        this.sessionInfo.participants.forEach(peerId => {
          if (peerId !== this.localPeerId && this.sessionInfo) {
            const peerIndex = this.sessionInfo.participants.indexOf(peerId) + 1;
            const peerIndexStr = peerIndex.toString();

            // Extract the specific package for this peer from the map
            if (packageMap[peerIndexStr]) {
              const wire = this._frostWire("round2", packageMap[peerIndexStr]);
              this.sendWebRTCAppMessage(peerId, {
                webrtc_msg_type: "SimpleMessage",
                text: `DKG_ROUND2:${this._hexToBase64(wire)}`,
              });
              sentCount++;
              this._log(`Sent Round 2 package to ${peerId} (index ${peerIndex})`);
            } else {
              this._log(`Warning: No Round 2 package found for peer ${peerId} (index ${peerIndex})`);
            }
          }
        });

        this._log(`Successfully sent ${sentCount} Round 2 packages`);
      }

      // Add our own package to received packages (we don't send to ourselves)
      this.receivedRound2Packages.add(this.localPeerId);
    } catch (error) {
      this._log(`Error generating Round 2 packages: ${this._getErrorMessage(error)}`);
      this._updateDkgState(DkgState.Failed);
    }
  }

  private async _finalizeDkg(): Promise<void> {
    this._log(`Finalizing DKG process`);

    if (!this.frostDkg) {
      this._log(`Cannot finalize DKG: DKG not initialized`);
      this._updateDkgState(DkgState.Failed);
      return;
    }

    try {
      // Check if we have all Round 2 packages needed
      if (this.sessionInfo && this.receivedRound2Packages.size < this.sessionInfo.participants.length) {
        this._log(`Cannot finalize DKG: missing Round 2 packages`);
        this._updateDkgState(DkgState.Failed);
        return;
      }

      // Check if FROST DKG can finalize
      if (!this.frostDkg.can_finalize()) {
        this._log(`Cannot finalize DKG: FROST DKG not ready to finalize`);
        this._updateDkgState(DkgState.Failed);
        return;
      }

      // finalize_dkg() returns the full engine keystore JSON (SECRET
      // share included) — it's only handed to the save flow; the group
      // public key is the hex verifying key.
      const keystoreJson: string = this.frostDkg.finalize_dkg();
      this.groupPublicKey = this.frostDkg.get_group_public_key();

      // Generate blockchain addresses using proper WASM methods
      if (this.groupPublicKey) {
        if (this.currentBlockchain === 'ethereum') {
          // For Ethereum, use the secp256k1 WASM method
          this.ethereumAddress = (this.frostDkg as any).get_eth_address();
          this.walletAddress = this.ethereumAddress;
        } else {
          // For Solana, use the Ed25519 WASM method for proper Base58 encoding
          this.solanaAddress = (this.frostDkg as any).get_address();
          this.walletAddress = this.solanaAddress;
        }
      }

      this._updateDkgState(DkgState.Complete);
      this._log(`DKG completed successfully. Group public key: ${this.groupPublicKey}`);

      // Ext-1d event propagation: surface the derived key material to
      // the offscreen outer layer (and on up to background + popup)
      // so the post-ceremony flow (display address, prompt password,
      // encrypt + save keyshare) has something to hook into. Fired
      // exactly once per ceremony — the DkgState.Failed branch
      // below doesn't emit this, and we don't re-fire on repeat
      // enters of Complete (dkgState transition already dedups).
      try {
        const address =
          this.currentBlockchain === "ethereum"
            ? this.ethereumAddress
            : this.solanaAddress;
        this.onDkgComplete({
          groupPublicKey: this.groupPublicKey ?? "",
          address: address ?? null,
          blockchain: this.currentBlockchain,
          sessionId: this.sessionInfo?.session_id ?? null,
          threshold: this.sessionInfo?.threshold ?? 0,
          total: this.sessionInfo?.total ?? 0,
          participants: this.sessionInfo?.participants ?? [],
          participantIndex: this.participantIndex,
          participantIdentifiers: dkgParticipantIdentifiers(
            this.sessionInfo?.participants ?? [],
          ),
          keystoreJson,
        });
      } catch (cbErr) {
        // A broken onDkgComplete subscriber must not surface as a
        // FROST failure — we already have the group key, the
        // ceremony succeeded cryptographically. Log and move on.
        this._log(
          `onDkgComplete subscriber threw (non-fatal): ${this._getErrorMessage(cbErr)}`,
        );
      }
    } catch (error) {
      this._log(`Error finalizing DKG: ${this._getErrorMessage(error)}`);
      this._updateDkgState(DkgState.Failed);
    }
  }

  private _resetDkgState(): void {
    this._log(`Resetting DKG state`);
    // Note: Don't reset dkgState here - caller should manage state transitions
    this.frostDkg = null;
    this.participantIndex = null;
    this.walletIdentifiers = null;
    this.receivedRound1Packages.clear();
    this.receivedRound2Packages.clear();
    this.groupPublicKey = null;
    this.solanaAddress = null;
    this.ethereumAddress = null;
    this.pendingDkgTriggerBlockchain = null;
    this.bufferedRound1Packages = [];
    this.bufferedRound2Packages = [];
  }

  // Add public resetDkgState method for tests
  public resetDkgState(): void {
    this._resetDkgState();
    this.dkgState = DkgState.Idle;
  }

  public setBlockchain(blockchain: "ethereum" | "solana") {
    this._log(`Setting blockchain to ${blockchain}`);
    this.currentBlockchain = blockchain;
  }

  public async checkAndTriggerDkg(blockchain: string): Promise<boolean> {
    // Set blockchain first to ensure correct curve is shown in logs
    this.currentBlockchain = blockchain as "ethereum" | "solana";

    this._log(`Checking conditions to trigger DKG for ${blockchain}`);

    if (!this.sessionInfo) {
      this._log(`Cannot trigger DKG: no session info`);
      return false;
    }

    if (this.dkgState !== DkgState.Idle) {
      this._log(`Cannot trigger DKG: already in progress (state: ${DkgState[this.dkgState]})`);
      return false;
    }

    if (this.meshStatus.type !== MeshStatusType.Ready) {
      this._log(`Cannot trigger DKG: mesh not ready (status: ${this.meshStatus.type})`);
      this.pendingDkgTriggerBlockchain = blockchain as "ethereum" | "solana";
      return false;
    }

    this.pendingDkgTriggerBlockchain = null;
    return await this.initializeDkg(blockchain as "ethereum" | "solana");
  }

  // ===================================================================
  // M3 RESHARE — rotate / redistribute key shares, SAME group key.
  //
  // Mirrors the DKG round flow but over FrostReshareSecp256k1 /
  // FrostReshareEd25519 (vendored engine pkg):
  //   init_reshare(keystoreJson, newIdsCsv, newThreshold)
  //   reshare_round1() → broadcast hex to all peers
  //   add_reshare_round1(fromOldId, hex)         [n-1 peer packages]
  //   can_reshare_round2() → reshare_round2()    → per-recipient map
  //   add_reshare_round2(fromOldId, hex)
  //   can_finalize_reshare() → finalize_reshare() → NEW keystore JSON
  //   get_group_public_key()                     → must equal old key
  //
  // Identifier convention: a participant's FROST id is its 1-based
  // position in the SORTED old cohort (reshare_old_participants).
  // The engine requires every new participant to already hold a
  // share, so the new cohort is always a subset of the old one and
  // keeps its old identifiers.
  // ===================================================================

  private _emitReshareState(error?: string): void {
    this.onReshareStateUpdate({
      sessionId: this.reshareInfo?.session_id ?? "",
      walletId: this.reshareInfo?.wallet_id ?? "",
      state: this.reshareState,
      round1Received: Array.from(this.receivedReshareRound1),
      round2Received: Array.from(this.receivedReshareRound2),
      participants: this.reshareInfo?.new_participants ?? [],
      ...(error ? { error } : {}),
    });
  }

  private _updateReshareState(state: ReshareState, error?: string): void {
    this.reshareState = state;
    if (state === ReshareState.Complete || state === ReshareState.Failed) this.ceremonyOutbox.clear();
    this._emitReshareState(error);
  }

  private _resetReshareState(): void {
    if (this.frostReshare) {
      try { this.frostReshare.free(); } catch { /* already freed */ }
    }
    this.frostReshare = null;
    this.reshareInfo = null;
    this.reshareKeyShare = null;
    this.receivedReshareRound1.clear();
    this.receivedReshareRound2.clear();
    this.bufferedReshareRound1 = [];
    this.bufferedReshareRound2 = [];
    this.reshareState = ReshareState.Idle;
  }

  /**
   * Arm a reshare ceremony. Called by offscreen/index.ts when the
   * background fires `sessionReadyForReshare` (full new cohort
   * joined) and the wallet's decrypted key share has been fetched.
   * The actual FROST init waits for the mesh: _maybeInitReshare is
   * re-checked on every mesh-ready transition and on buffered
   * round-1 arrivals (covers the race where peers were faster).
   */
  public startReshare(
    sessionInfo: SessionInfo,
    walletId: string,
    keyShare: KeyShareData,
    blockchain: "ethereum" | "solana",
  ): boolean {
    // A finished (or failed) ceremony doesn't block the next one —
    // terminal states reset implicitly. Only an IN-FLIGHT ceremony
    // refuses re-entry.
    if (
      this.reshareState === ReshareState.Complete ||
      this.reshareState === ReshareState.Failed
    ) {
      this._resetReshareState();
    }
    if (this.reshareState !== ReshareState.Idle) {
      this._log(`Cannot start reshare: already in state ${this.reshareState}`);
      return false;
    }
    // Extension announces name the old cohort; CLI/TUI refresh announces
    // don't — there it is the wallet's original participant set.
    const oldParticipants = [
      ...((sessionInfo as any).reshare_old_participants ??
        Object.keys(keyShare?.participant_identifiers ?? {})),
    ].sort();
    if (oldParticipants.length === 0) {
      this._log(`Cannot start reshare: no old cohort (announce or wallet)`);
      return false;
    }
    const newParticipants = [...sessionInfo.participants].sort();
    const notShareholders = newParticipants.filter(
      (p) => !oldParticipants.includes(p),
    );
    if (notShareholders.length > 0) {
      this._log(
        `Cannot start reshare: [${notShareholders.join(", ")}] hold no share in the old cohort`,
      );
      return false;
    }
    if (!newParticipants.includes(this.localPeerId)) {
      this._log(`Cannot start reshare: we are not in the new cohort`);
      return false;
    }
    const identifiers = keyShare?.participant_identifiers ?? {};
    const unmapped = oldParticipants.filter((p) => !(identifiers[p] > 0));
    if (unmapped.length > 0) {
      this._log(
        `Cannot start reshare: wallet has no FROST identifier for [${unmapped.join(", ")}]`,
      );
      return false;
    }

    this.currentBlockchain = blockchain;
    this.reshareInfo = {
      session_id: sessionInfo.session_id,
      wallet_id: walletId,
      old_participants: oldParticipants,
      new_participants: newParticipants,
      new_threshold: sessionInfo.threshold,
      old_group_public_key: String(keyShare.group_public_key ?? ""),
      identifiers: { ...identifiers },
    };
    this.reshareKeyShare = keyShare;
    this._updateReshareState(ReshareState.WaitingForMesh);
    this._log(
      `Reshare armed for wallet ${walletId}: new cohort ${sessionInfo.threshold}/${newParticipants.length} [${newParticipants.join(", ")}] (old cohort ${oldParticipants.length})`,
    );
    this._maybeInitReshare();
    return true;
  }

  /** Old-cohort FROST identifier for a device id (from the wallet record). */
  private _reshareIdOf(deviceId: string): number {
    return this.reshareInfo?.identifiers[deviceId] ?? 0; // 0 = not a shareholder
  }

  private _maybeInitReshare(): void {
    if (!this.reshareInfo || !this.reshareKeyShare) return;
    if (this.reshareState !== ReshareState.WaitingForMesh) return;

    const remotePeers = this.reshareInfo.new_participants.filter(
      (p) => p !== this.localPeerId,
    );
    const meshReady = this.meshStatus.type === MeshStatusType.Ready;
    // Fallback go-signal: every remote peer's round-1 package already
    // buffered means their channels are demonstrably open even if our
    // mesh bookkeeping lags (same rationale as DKG auto-trigger #3).
    const bufferedFrom = new Set(
      this.bufferedReshareRound1.map((p) => p.fromPeerId),
    );
    const allPeersBuffered =
      remotePeers.length > 0 && remotePeers.every((p) => bufferedFrom.has(p));

    if (!meshReady && !allPeersBuffered) {
      this._log(
        `Reshare waiting: mesh=${MeshStatusType[this.meshStatus.type]}, buffered r1 from [${Array.from(bufferedFrom).join(", ")}]`,
      );
      return;
    }
    void this._initializeReshare();
  }

  private _resolveGlobal(name: string): any {
    return (
      (typeof globalThis !== "undefined" && (globalThis as any)[name]) ||
      (typeof global !== "undefined" && (global as any)[name]) ||
      (typeof window !== "undefined" && (window as any)[name]) ||
      null
    );
  }

  private async _initializeReshare(): Promise<void> {
    if (!this.reshareInfo || !this.reshareKeyShare) return;
    try {
      const ReshareClass =
        this.currentBlockchain === "ethereum"
          ? this._resolveGlobal("FrostReshareSecp256k1")
          : this._resolveGlobal("FrostReshareEd25519");
      if (!ReshareClass) {
        throw new Error("FROST reshare WASM modules not found");
      }

      const ks = this.reshareKeyShare;
      const keystoreJson = toEngineKeystoreJson(ks);

      const newIds = this.reshareInfo.new_participants.map((p) =>
        this._reshareIdOf(p),
      );
      if (newIds.some((id) => id <= 0)) {
        throw new Error(
          "A new-cohort device has no FROST identifier in the wallet record",
        );
      }
      if (this._reshareIdOf(this.localPeerId) !== ks.participant_index) {
        throw new Error(
          `Wallet record inconsistent: identifier map says ${this._reshareIdOf(this.localPeerId)} for this device, keystore says ${ks.participant_index}`,
        );
      }

      this.frostReshare = new ReshareClass();
      this.frostReshare.init_reshare(
        keystoreJson,
        newIds.join(","),
        this.reshareInfo.new_threshold,
      );
      this._updateReshareState(ReshareState.Round1InProgress);
      this._log(
        `Reshare initialized: new_ids=[${newIds.join(",")}], new_threshold=${this.reshareInfo.new_threshold}`,
      );

      // Round 1: broadcast our package to every other new participant.
      const round1Hex: string = this.frostReshare.reshare_round1();
      this.receivedReshareRound1.add(this.localPeerId);
      // The CLI/TUI native frame (FROST binary, base64).
      const msg: WebRTCAppMessage = {
        webrtc_msg_type: "SimpleMessage",
        text: `RESHARE_ROUND1:${this._hexToBase64(this._frostWire("round1", round1Hex))}`,
      };
      for (const peerId of this.reshareInfo.new_participants) {
        if (peerId !== this.localPeerId) {
          this.sendWebRTCAppMessage(peerId, msg);
        }
      }
      this._emitReshareState();

      // Replay any round-1 packages that arrived before init.
      const buffered = [...this.bufferedReshareRound1];
      this.bufferedReshareRound1 = [];
      for (const { fromPeerId, packageHex } of buffered) {
        this._processReshareRound1(fromPeerId, packageHex);
      }
      this._maybeAdvanceToReshareRound2();
    } catch (error) {
      this._log(`Error initializing reshare: ${this._getErrorMessage(error)}`);
      this._updateReshareState(
        ReshareState.Failed,
        this._getErrorMessage(error),
      );
    }
  }

  private _handleReshareRound1Package(fromPeerId: string, message: any): void {
    if (fromPeerId === this.localPeerId) return;
    const packageHex =
      typeof message?.package === "string" ? message.package : null;
    if (!packageHex) {
      this._log(`Invalid ReshareRound1Package from ${fromPeerId}: missing package`);
      return;
    }
    if (
      this.reshareInfo &&
      message.session_id &&
      message.session_id !== this.reshareInfo.session_id
    ) {
      this._log(
        `Ignoring ReshareRound1Package for unknown session ${message.session_id}`,
      );
      return;
    }
    if (!this.frostReshare) {
      this.bufferedReshareRound1.push({ fromPeerId, packageHex });
      this._log(`Buffered reshare round-1 package from ${fromPeerId} (not initialized yet)`);
      this._maybeInitReshare();
      return;
    }
    this._processReshareRound1(fromPeerId, packageHex);
    this._maybeAdvanceToReshareRound2();
  }

  private _processReshareRound1(fromPeerId: string, packageHex: string): void {
    if (this.receivedReshareRound1.has(fromPeerId)) {
      this._log(`Duplicate reshare round-1 package from ${fromPeerId} — ignoring`);
      return;
    }
    const fromId = this._reshareIdOf(fromPeerId);
    if (fromId <= 0) {
      this._log(`Reshare round-1 from ${fromPeerId}: not in old cohort — ignoring`);
      return;
    }
    try {
      this.frostReshare.add_reshare_round1(fromId, packageHex);
      this.receivedReshareRound1.add(fromPeerId);
      this._log(
        `Processed reshare round-1 from ${fromPeerId} (id ${fromId}). Total: ${this.receivedReshareRound1.size}/${this.reshareInfo?.new_participants.length ?? 0}`,
      );
      this._emitReshareState();
    } catch (error) {
      this._log(
        `add_reshare_round1(${fromId}) failed: ${this._getErrorMessage(error)}`,
      );
      this._updateReshareState(
        ReshareState.Failed,
        this._getErrorMessage(error),
      );
    }
  }

  private _maybeAdvanceToReshareRound2(): void {
    if (
      !this.frostReshare ||
      !this.reshareInfo ||
      this.reshareState !== ReshareState.Round1InProgress
    ) {
      return;
    }
    const haveAll =
      this.receivedReshareRound1.size >= this.reshareInfo.new_participants.length;
    let canRound2 = false;
    try {
      canRound2 = this.frostReshare.can_reshare_round2();
    } catch (e) {
      this._log(`can_reshare_round2 check failed: ${this._getErrorMessage(e)}`);
    }
    if (!haveAll || !canRound2) return;
    this._generateAndSendReshareRound2();
  }

  /**
   * reshare_round2() returns the per-recipient package map. Be
   * tolerant about the envelope: plain JSON object string OR
   * hex-encoded JSON (the DKG generate_round2 convention). Keys are
   * the recipients' FROST ids (numeric strings).
   */
  private _decodeResharePackageMap(raw: string): Record<string, string> {
    try {
      return JSON.parse(raw);
    } catch {
      const hexMatches = raw.match(/.{1,2}/g);
      if (!hexMatches) throw new Error("Unparseable reshare round-2 map");
      const bytes = new Uint8Array(hexMatches.map((b) => parseInt(b, 16)));
      return JSON.parse(new TextDecoder().decode(bytes));
    }
  }

  private _generateAndSendReshareRound2(): void {
    if (!this.frostReshare || !this.reshareInfo) return;
    try {
      this._updateReshareState(ReshareState.Round2InProgress);
      const mapRaw: string = this.frostReshare.reshare_round2();
      const packageMap = this._decodeResharePackageMap(mapRaw);

      let sent = 0;
      for (const peerId of this.reshareInfo.new_participants) {
        if (peerId === this.localPeerId) continue;
        const recipientId = this._reshareIdOf(peerId);
        const pkg = packageMap[String(recipientId)];
        if (!pkg) {
          this._log(
            `Warning: no reshare round-2 package for ${peerId} (id ${recipientId})`,
          );
          continue;
        }
        const msg: WebRTCAppMessage = {
          webrtc_msg_type: "SimpleMessage",
          text: `RESHARE_ROUND2:${this._hexToBase64(this._frostWire("round2", pkg))}`,
        };
        this.sendWebRTCAppMessage(peerId, msg);
        sent++;
      }
      this.receivedReshareRound2.add(this.localPeerId);
      this._log(`Sent ${sent} reshare round-2 packages`);
      this._emitReshareState();

      // Replay round-2 packages that arrived while we were in round 1.
      const buffered = [...this.bufferedReshareRound2];
      this.bufferedReshareRound2 = [];
      for (const { fromPeerId, packageHex } of buffered) {
        this._processReshareRound2(fromPeerId, packageHex);
      }
      this._maybeFinalizeReshare();
    } catch (error) {
      this._log(
        `Error generating reshare round-2: ${this._getErrorMessage(error)}`,
      );
      this._updateReshareState(
        ReshareState.Failed,
        this._getErrorMessage(error),
      );
    }
  }

  private _handleReshareRound2Package(fromPeerId: string, message: any): void {
    if (fromPeerId === this.localPeerId) return;
    const packageHex =
      typeof message?.package === "string" ? message.package : null;
    if (!packageHex) {
      this._log(`Invalid ReshareRound2Package from ${fromPeerId}: missing package`);
      return;
    }
    if (
      this.reshareInfo &&
      message.session_id &&
      message.session_id !== this.reshareInfo.session_id
    ) {
      return;
    }
    if (!this.frostReshare || this.reshareState === ReshareState.Round1InProgress || this.reshareState === ReshareState.WaitingForMesh || this.reshareState === ReshareState.Idle) {
      this.bufferedReshareRound2.push({ fromPeerId, packageHex });
      this._log(`Buffered reshare round-2 package from ${fromPeerId} (not in round 2 yet)`);
      return;
    }
    this._processReshareRound2(fromPeerId, packageHex);
    this._maybeFinalizeReshare();
  }

  private _processReshareRound2(fromPeerId: string, packageHex: string): void {
    if (this.receivedReshareRound2.has(fromPeerId)) {
      this._log(`Duplicate reshare round-2 package from ${fromPeerId} — ignoring`);
      return;
    }
    const fromId = this._reshareIdOf(fromPeerId);
    if (fromId <= 0) {
      this._log(`Reshare round-2 from ${fromPeerId}: not in old cohort — ignoring`);
      return;
    }
    try {
      this.frostReshare.add_reshare_round2(fromId, packageHex);
      this.receivedReshareRound2.add(fromPeerId);
      this._log(
        `Processed reshare round-2 from ${fromPeerId} (id ${fromId}). Total: ${this.receivedReshareRound2.size}/${this.reshareInfo?.new_participants.length ?? 0}`,
      );
      this._emitReshareState();
    } catch (error) {
      this._log(
        `add_reshare_round2(${fromId}) failed: ${this._getErrorMessage(error)}`,
      );
      this._updateReshareState(
        ReshareState.Failed,
        this._getErrorMessage(error),
      );
    }
  }

  private _maybeFinalizeReshare(): void {
    if (
      !this.frostReshare ||
      !this.reshareInfo ||
      this.reshareState !== ReshareState.Round2InProgress
    ) {
      return;
    }
    const haveAll =
      this.receivedReshareRound2.size >= this.reshareInfo.new_participants.length;
    let canFinalize = false;
    try {
      canFinalize = this.frostReshare.can_finalize_reshare();
    } catch (e) {
      this._log(`can_finalize_reshare check failed: ${this._getErrorMessage(e)}`);
    }
    if (!haveAll || !canFinalize) return;

    try {
      const newKeystoreJson: string = this.frostReshare.finalize_reshare();
      const newGroupKey: string = this.frostReshare.get_group_public_key();

      // CRITICAL invariant: the group public key (and therefore every
      // derived address) must NOT change. A mismatch means the
      // ceremony diverged — do not persist the new share.
      const oldKey = (this.reshareInfo.old_group_public_key || "").toLowerCase();
      const newKey = (newGroupKey || "").toLowerCase();
      if (!newKey || oldKey !== newKey) {
        throw new Error(
          `Group public key changed after reshare (old=${oldKey.slice(0, 16)}…, new=${newKey.slice(0, 16)}…) — refusing to save`,
        );
      }

      // New cohort keeps its OLD identifiers (gapped after a removal).
      const participantIdentifiers: Record<string, number> = {};
      for (const p of this.reshareInfo.new_participants) {
        participantIdentifiers[p] = this._reshareIdOf(p);
      }

      this._updateReshareState(ReshareState.Complete);
      this._log(
        `✅ Reshare complete for wallet ${this.reshareInfo.wallet_id} — group key unchanged`,
      );
      this.onReshareComplete({
        sessionId: this.reshareInfo.session_id,
        walletId: this.reshareInfo.wallet_id,
        newKeystoreJson,
        groupPublicKey: newGroupKey,
        threshold: this.reshareInfo.new_threshold,
        total: this.reshareInfo.new_participants.length,
        participants: this.reshareInfo.new_participants.slice(),
        participantIdentifiers,
        blockchain: this.currentBlockchain,
      });
    } catch (error) {
      this._log(`Error finalizing reshare: ${this._getErrorMessage(error)}`);
      this._updateReshareState(
        ReshareState.Failed,
        this._getErrorMessage(error),
      );
    }
  }

  /** Snapshot for the background's getReshareStatus passthrough. */
  public getReshareStatus(): {
    state: ReshareState;
    sessionId: string | null;
    walletId: string | null;
    participants: string[];
    round1Received: string[];
    round2Received: string[];
  } {
    return {
      state: this.reshareState,
      sessionId: this.reshareInfo?.session_id ?? null,
      walletId: this.reshareInfo?.wallet_id ?? null,
      participants: this.reshareInfo?.new_participants ?? [],
      round1Received: Array.from(this.receivedReshareRound1),
      round2Received: Array.from(this.receivedReshareRound2),
    };
  }

  /**
   * Ext-2d-progress: snapshot + emit the signing roster state.
   * Called after every mutation of signingCommitments or
   * signingShares so the popup's progress roster stays live.
   * No-op when no signingInfo is set (idle ceremonies have nothing
   * to report). Converts private Maps to plain arrays of peer-ids
   * for wire transport.
   */
  private _emitSigningProgress(): void {
    if (!this.signingInfo) return;
    this.onSigningProgress({
      signingId: this.signingInfo.signing_id,
      state: this.signingState,
      selectedSigners: this.signingInfo.selected_signers.slice(),
      commitmentsReceived: Array.from(this.signingCommitments.keys()),
      sharesReceived: Array.from(this.signingShares.keys()),
    });
  }

  /**
   * Ext-2d-offscreen: load an existing wallet's key share into a
   * fresh FROST instance so it can be used for signing. Populates
   * `this.frostDkg` the same way `initializeDkg` would after finishing
   * a DKG ceremony. Called when a signing session is about to start
   * and we haven't already loaded a keystore (or we need a different
   * one than what's currently loaded).
   *
   * The stored KeyShareData is converted to the engine's canonical
   * keystore JSON by `toEngineKeystoreJson` (the same boundary the
   * reshare path uses) — derive_child_keystore_* / import_keystore
   * accept nothing else. The wallet's participant_identifiers map is
   * kept so the ceremony can resolve co-signers' FROST ids.
   *
   * Returns true on successful load. Throws on keystore parse failure
   * or WASM init failure; callers should treat those as fatal for
   * the ceremony and bail.
   */
  public async loadKeystoreForSigning(
    keyShareData: KeyShareData,
    target: { chain: string; account: number },
  ): Promise<boolean> {
    const curve = curveForChain(target.chain);
    if (!curve) throw new Error(`Unsupported signing chain: ${target.chain}`);
    if (curve !== keyShareData.curve) {
      throw new Error(`Wallet is ${keyShareData.curve}; ${target.chain} signs with ${curve}`);
    }
    this.currentBlockchain = curve === "secp256k1" ? "ethereum" : "solana";
    this._log(
      `Loading keystore for signing: ${target.chain} account ${target.account} / participant ${keyShareData.participant_index} / session ${keyShareData.session_id}`,
    );
    const parentJson = toEngineKeystoreJson(keyShareData);

    const {
      FrostDkgSecp256k1,
      FrostDkgEd25519,
      derive_child_keystore_secp256k1,
      derive_child_keystore_ed25519,
      standard_account_path,
    } = await import("@stars-labs/core-wasm");
    const instance =
      curve === "secp256k1"
        ? new FrostDkgSecp256k1()
        : new FrostDkgEd25519();
    // BIP-44/86 all the way: the ROOT key never signs. Derive the child
    // keystore the session names (wallet_name `{root}-{chain}-{account}`)
    // at the chain's pinned path — deterministic, so every co-signer
    // derives the same child and the ceremony aggregates under that
    // account's key (bitcoin: the BIP-86-tweaked P2TR output key).
    const accountPath = standard_account_path(target.chain, target.account);
    if (!accountPath) throw new Error(`No standard path for ${target.chain}`);
    const childJson =
      curve === "secp256k1"
        ? derive_child_keystore_secp256k1(parentJson, accountPath)
        : derive_child_keystore_ed25519(parentJson, accountPath);
    this._log(`Signing with ${target.chain} account ${target.account} (${accountPath}) — root key never signs`);
    instance.import_keystore(childJson);

    this.frostDkg = instance;
    this.participantIndex = keyShareData.participant_index;
    this.walletIdentifiers = { ...keyShareData.participant_identifiers };
    this.groupPublicKey = keyShareData.group_public_key;
    if (target.chain === "ethereum") {
      try {
        this.ethereumAddress = (instance as any).get_eth_address?.() ?? null;
        this.walletAddress = this.ethereumAddress;
      } catch (e) {
        this._log(`Failed to derive ethereum address: ${e}`);
      }
    } else if (target.chain === "solana") {
      try {
        this.solanaAddress = (instance as any).get_address?.() ?? null;
        this.walletAddress = this.solanaAddress;
      } catch (e) {
        this._log(`Failed to derive solana address: ${e}`);
      }
    }

    this._log(
      `Keystore loaded into WASM: address=${this.walletAddress ?? "(unknown)"}`,
    );
    return true;
  }

  /**
   * Ext-2d-offscreen: kick off a signing ceremony announced via the
   * session-discovery protocol (sessionReadyForSigning).
   *
   * Flow:
   *   1. Ensure `this.frostDkg` is loaded (caller must run
   *      loadKeystoreForSigning first).
   *   2. Set up signingInfo with selected_signers = the first
   *      `threshold` shareholders (devices with a FROST id in the
   *      wallet's participant_identifiers) among the SORTED
   *      session participants, so every peer picks the same subset
   *      regardless of wire order — a disagreement here would
   *      corrupt the ceremony. Each signer's FROST id comes from
   *      that map, never from its list position.
   *   3. Call frostDkg.signing_commit() to generate our commitment
   *      for THIS round.
   *   4. Broadcast the commitment as a SigningCommitment WebRTC
   *      app message to every peer in selected_signers (excluding
   *      self).
   *   5. Record our own commitment locally so we can match on it
   *      when aggregating later.
   */
  public async initiateSigningCeremony(
    sessionInfo: SessionInfo,
    messageHex: string,
  ): Promise<boolean> {
    if (!this.frostDkg) {
      this._log(
        `Cannot start signing ceremony: no FROST instance. Call loadKeystoreForSigning first.`,
      );
      return false;
    }
    if (this.signingState === SigningState.CommitmentPhase || this.signingState === SigningState.SharePhase) {
      this._log(
        `Cannot start signing ceremony: one is already in progress (${this.signingState})`,
      );
      return false;
    }

    const identifiers = this.walletIdentifiers;
    if (!identifiers || !(identifiers[this.localPeerId] > 0)) {
      this._log(
        `Cannot start signing ceremony: loaded wallet has no FROST identifier for this device`,
      );
      return false;
    }

    // Signer set (same rule as the CLI/TUI): the proposer fixes it as
    // itself plus the first threshold-1 commitments to arrive and
    // announces it with SIGN_SET; everyone else waits for that and never
    // picks (with more than threshold signers online, independent picks
    // disagree and aggregation fails). CLI peers never join a signing
    // session, so its participant list can't be used to pick.
    const threshold = sessionInfo.threshold;
    const cohort = Object.keys(identifiers).filter((p) => p !== this.localPeerId);
    const signerIdentifiers: Record<string, number> = { ...identifiers };
    this.signingCommitments.clear();
    this.signingShares.clear();
    this.announcedSignerSet = null;
    this.signerSetFixed = false;

    const signingId = `sign_${sessionInfo.session_id}`;
    this.signingInfo = {
      signing_id: signingId,
      transaction_data: messageHex,
      threshold,
      participants: sessionInfo.participants.slice(),
      acceptances: new Map(),
      accepted_participants: [this.localPeerId],
      selected_signers: [],
      signer_identifiers: signerIdentifiers,
      step: "commitment_phase",
      initiator: sessionInfo.proposer_id,
    };

    const role = sessionInfo.proposer_id === this.localPeerId ? "proposer — fixes the signer set" : `co-signer — ${sessionInfo.proposer_id} fixes the signer set`;
    this._log(
      `Initiating signing ceremony ${signingId}: ${threshold} of ${cohort.length + 1} shareholders (${role})`,
    );

    // Generate our round-1 commitment. Returns hex string.
    let commitmentHex: string;
    try {
      commitmentHex = this.frostDkg.signing_commit();
    } catch (e) {
      this._failSigning(`signing_commit() failed: ${this._getErrorMessage(e)}`);
      return false;
    }

    // Record our own commitment so when it's time to aggregate,
    // we're counted alongside the peers'. Keyed by peer-id to match
    // how _handleSigningCommitment records incoming ones.
    this.signingCommitments.set(this.localPeerId, commitmentHex);

    // Broadcast to every other shareholder.
    const broadcast: WebRTCAppMessage = {
      webrtc_msg_type: "SimpleMessage",
      text: `SIGN_COMMIT:${this._hexToBase64(this._frostWire("commitment", commitmentHex))}`,
    };
    for (const peerId of cohort) {
      this.sendWebRTCAppMessage(peerId, broadcast);
    }

    this.signingState = SigningState.CommitmentPhase;
    this.onSigningStateUpdate(this.signingState, this.signingInfo);
    const ceremony = this.signingInfo;
    this.signingTimer = setTimeout(() => {
      if (this.signingInfo === ceremony && this._signingActive()) this._failSigning(this._timeoutReason());
    }, this.signingTimeoutMs);
    this._emitSigningProgress();
    this._log(`Round 1: broadcast our commitment to ${cohort.length} shareholders`);

    this._replayEarlySigningFrames();
    return true;
  }

  private async _getOrCreatePeerConnection(peerId: string): Promise<RTCPeerConnection | null> {
    let pc = this.peerConnections.get(peerId);
    if (!pc) {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.peerConnections.set(peerId, pc);
      this._setupPeerConnection(pc, peerId);
    }
    return pc;
  }

  private _setupPeerConnection(pc: RTCPeerConnection, peerId: string): void {
    pc.onicecandidate = (event) => {
      if (event.candidate && this.sendPayloadToBackgroundForRelay) {
        const payload = {
          websocket_msg_type: 'WebRTCSignal',
          Candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          }
        };
        this.sendPayloadToBackgroundForRelay(peerId, payload as any);
      }
    };

    pc.ondatachannel = (event) => {
      this._setupDataChannel(event.channel, peerId);
    };

    pc.onconnectionstatechange = () => this._onPeerConnectionState(peerId, pc);
  }

  private _setupDataChannel(channel: RTCDataChannel, peerId: string): void {
    this.dataChannels.set(peerId, channel);

    // A rebuild replaces the channel; the old one's late events must not
    // touch the new one (its onclose used to delete the fresh channel).
    const isCurrent = () => this.dataChannels.get(peerId) === channel;

    channel.onopen = () => {
      if (!isCurrent()) return;
      this._log(`Data channel opened with ${peerId}`);
      // Queued control messages, then every ceremony frame of the current
      // ceremony (a rebuilt connection lost whatever was in flight).
      const queued = (this.pendingSends.get(peerId) ?? []).filter((m) => !isCeremonyFrame(m));
      this.pendingSends.delete(peerId);
      for (const message of [...queued, ...(this.ceremonyOutbox.get(peerId) ?? [])]) {
        channel.send(JSON.stringify(message));
      }
      this._checkMeshStatus();
    };

    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleWebRTCAppMessage(peerId, message);
      } catch (error) {
        this._log(`Error parsing message from ${peerId}: ${this._getErrorMessage(error)}`);
      }
    };

    channel.onclose = () => {
      if (!isCurrent()) return;
      this._log(`Data channel closed with ${peerId}`);
      this.dataChannels.delete(peerId);
      this._checkMeshStatus();
    };
  }

  // Signing-related handler methods
  /**
   * Ext-2d-offscreen-rounds: real FROST round-1 commitment handler.
   * Replaces the pre-existing mock that just stored opaque blobs.
   *
   * Per FROST: signing_commit() auto-registers our OWN commitment
   * in the WASM instance's signing_commitments map (required by
   * frost-core's round2::sign — see round2.rs:135,
   * Error::MissingCommitment). Peers' commitments must be
   * explicitly registered via add_signing_commitment(i, hex)
   * before sign() can produce a share using them.
   *
   * Index convention: the sender's FROST identifier comes from
   * signingInfo.signer_identifiers (the wallet's stored map) — NOT
   * its list position, which is wrong for gapped cohorts like {1,3}.
   */
  private _handleSigningCommitment(fromPeerId: string, message: any): void {
    this._log(`Handling signing commitment from ${fromPeerId}`);

    if (!this.signingInfo || !this._signingActive()) {
      // A CLI proposer commits the moment it announces — often before we
      // approved. Keep it for when our ceremony starts.
      this._log(`Buffering early signing commitment from ${fromPeerId}`);
      this._bufferSigningFrame({ fromPeerId, kind: "commitment", hex: message.commitment });
      return;
    }
    if (this.signingInfo.signing_id !== message.signing_id) {
      this._log(`Ignoring signing commitment: no matching signing process`);
      return;
    }
    if (!this.frostDkg) {
      this._log(`Cannot process commitment: no FROST instance loaded`);
      return;
    }

    const senderIndex = this.signingInfo.signer_identifiers[fromPeerId] ?? 0;
    if (senderIndex <= 0) {
      this._log(`Ignoring ${fromPeerId}: holds no share of this wallet`);
      return;
    }

    const commitmentHex =
      typeof message.commitment === "string" ? message.commitment : null;
    if (!commitmentHex) {
      this._log(
        `Invalid commitment format from ${fromPeerId}: expected string, got ${typeof message.commitment}`,
      );
      return;
    }

    if (this.signingCommitments.has(fromPeerId)) {
      this._log(`Duplicate commitment from ${fromPeerId} — ignoring`);
      return;
    }
    if (this.signerSetFixed) {
      this._log(`Signer set already fixed — ${fromPeerId}'s commitment is not part of it`);
      return;
    }

    // Held here, not in the FROST instance: only the fixed set's
    // commitments may enter the signing package.
    this.signingCommitments.set(fromPeerId, commitmentHex);
    this._log(
      `Received commitment from ${fromPeerId} (idx ${senderIndex}). Commitments: ${this.signingCommitments.size}/${this.signingInfo.threshold}`,
    );
    this._emitSigningProgress();
    this._maybeFixSignerSet();
  }

  /**
   * SIGN_SET from the proposer: the ceremony's signer set. Buffered until
   * our own ceremony exists; applied once every member's commitment is in.
   */
  private _handleSignerSet(fromPeerId: string, text: string): void {
    const info = this.signingInfo;
    if (!info || !this._signingActive()) {
      this._log(`Buffering early signer set from ${fromPeerId}`);
      this._bufferSigningFrame({ fromPeerId, kind: "set", hex: text });
      return;
    }
    if (fromPeerId !== info.initiator) {
      this._log(`Ignoring SIGN_SET from ${fromPeerId}: only the proposer ${info.initiator} fixes the signer set`);
      return;
    }
    if (this.signerSetFixed || this.announcedSignerSet) return; // resend
    const ids = decodeSignerSet(text);
    const invalid =
      !ids ? "malformed" :
      new Set(ids).size !== info.threshold ? `${ids.length} signers, threshold is ${info.threshold}` :
      !ids.includes(info.initiator) ? "the proposer is not in it" :
      ids.find((id) => !(info.signer_identifiers[id] > 0)) ? "it names a device without a share" :
      null;
    if (invalid) {
      this._failSigning(`Invalid signer set from ${fromPeerId}: ${invalid}`);
      return;
    }
    this._log(`Signer set from ${fromPeerId}: [${ids!.join(", ")}]`);
    this.announcedSignerSet = ids;
    this._maybeFixSignerSet();
  }

  /**
   * Fix the signer set when we can: the proposer once it holds threshold
   * commitments (its own first, then arrival order) — announcing it before
   * its share; anyone else once the proposer's SIGN_SET is here and every
   * member's commitment has arrived.
   */
  private _maybeFixSignerSet(): void {
    const info = this.signingInfo;
    if (!info || this.signerSetFixed) return;
    let set: string[];
    if (info.initiator === this.localPeerId) {
      if (this.signingCommitments.size < info.threshold) return;
      set = Array.from(this.signingCommitments.keys()).slice(0, info.threshold);
      const announce: WebRTCAppMessage = { webrtc_msg_type: "SimpleMessage", text: encodeSignerSet(set) };
      for (const peerId of Object.keys(info.signer_identifiers)) {
        if (peerId !== this.localPeerId) this.sendWebRTCAppMessage(peerId, announce);
      }
    } else {
      if (!this.announcedSignerSet) return;
      if (!this.announcedSignerSet.every((id) => this.signingCommitments.has(id))) return;
      set = this.announcedSignerSet;
    }
    this._enterSharePhase(set);
  }

  private _enterSharePhase(set: string[]): void {
    const info = this.signingInfo!;
    const frost = this.frostDkg!;
    const signing = set.includes(this.localPeerId);
    try {
      // Not a signer: our own commitment (added by signing_commit) must
      // leave the package, so rebuild it from the set alone.
      if (!signing) frost.clear_signing_state();
      for (const id of set) {
        if (id !== this.localPeerId) frost.add_signing_commitment(info.signer_identifiers[id], this.signingCommitments.get(id));
      }
    } catch (e) {
      this._failSigning(`Building the signing package failed: ${this._getErrorMessage(e)}`);
      return;
    }
    this.signerSetFixed = true;
    info.selected_signers = set.slice();
    this._log(`Signer set fixed [${set.join(", ")}]${signing ? "" : " — not a signer; aggregating only"}. Transitioning to share phase.`);
    this._updateSigningState(SigningState.SharePhase, info);
    if (signing) this._generateAndSendSignatureShare();
    this._replayEarlySigningFrames();
  }

  /**
   * Keep a frame for the next ceremony. CLI frames carry no ceremony id and
   * peers resend unacked frames (#117), so a late resend from a finished
   * ceremony can land here before the peer's frame for the next one: keep
   * only each peer's LATEST frame of each kind.
   */
  private _rememberFinishedFrames(): void {
    this.finishedCeremonyFrames = new Set([...this.signingCommitments.values(), ...this.signingShares.values()]);
  }

  private _bufferSigningFrame(frame: { fromPeerId: string; kind: "commitment" | "share" | "set"; hex: string }): void {
    this.earlySigningFrames = this.earlySigningFrames.filter(
      (f) => !(f.fromPeerId === frame.fromPeerId && f.kind === frame.kind),
    );
    this.earlySigningFrames.push(frame);
  }

  /** Why a signing timed out: whose commitment or share never came. */
  private _timeoutReason(): string {
    const info = this.signingInfo!;
    const secs = Math.round(this.signingTimeoutMs / 1000);
    if (!this.signerSetFixed) {
      return `Signing timed out after ${secs}s: only ${this.signingCommitments.size} of ${info.threshold} signers responded`;
    }
    const missing = info.selected_signers.filter((id) => !this.signingShares.has(id));
    return `Signing timed out after ${secs}s: no signature share from ${missing.join(", ")}`;
  }

  /**
   * End the current signing as failed: the FROST instance and per-ceremony
   * state are reset (so a retry starts clean) and the failure is reported
   * so the popup and any waiting dApp request get the error.
   */
  private _failSigning(reason: string): void {
    const info = this.signingInfo;
    this._log(`Signing failed: ${reason}`);
    this._rememberFinishedFrames();
    try {
      this.frostDkg?.clear_signing_state();
    } catch (e) {
      this._log(`clear_signing_state() failed: ${this._getErrorMessage(e)}`);
    }
    this.signingCommitments.clear();
    this.signingShares.clear();
    this.announcedSignerSet = null;
    this.signerSetFixed = false;
    this._updateSigningState(SigningState.Failed, info);
    if (info) {
      this.onSigningFailed({
        signingId: info.signing_id,
        sessionId: info.signing_id.replace(/^sign_/, ""),
        error: reason,
      });
    }
  }

  /** A ceremony is running (frames for the next one are buffered until then). */
  private _signingActive(): boolean {
    return this.signingState === SigningState.CommitmentPhase || this.signingState === SigningState.SharePhase;
  }

  /** Feed frames buffered before the ceremony (or its signer set) was ready. */
  private _replayEarlySigningFrames(): void {
    const frames = this.earlySigningFrames;
    this.earlySigningFrames = [];
    const signing_id = this.signingInfo?.signing_id;
    for (const f of frames) {
      if (f.kind === "commitment") {
        this._handleSigningCommitment(f.fromPeerId, { signing_id, commitment: f.hex });
      } else if (f.kind === "set") {
        this._handleSignerSet(f.fromPeerId, f.hex);
      } else {
        this._handleSignatureShare(f.fromPeerId, { signing_id, share: f.hex });
      }
    }
  }

  /**
   * Ext-2d-offscreen-rounds: real FROST round-2 share handler.
   * Replaces the pre-existing mock that stored opaque blobs.
   *
   * Per FROST: sign() auto-registers our OWN share in the WASM
   * instance's signature_shares map (required by frost-core's
   * aggregate — the length-match check on signing_commitments vs
   * signature_shares in frost-core/src/lib.rs would fail otherwise).
   * Peers' shares must be added via add_signature_share(i, hex).
   */
  private _handleSignatureShare(fromPeerId: string, message: any): void {
    this._log(`Handling signature share from ${fromPeerId}`);

    const info = this.signingInfo;
    if (!info || !this._signingActive() || (!this.signerSetFixed && message.signing_id === info.signing_id)) {
      // Before our ceremony / signer set exists — replayed once it does.
      this._log(`Buffering early signature share from ${fromPeerId}`);
      this._bufferSigningFrame({ fromPeerId, kind: "share", hex: message.share });
      return;
    }
    if (info.signing_id !== message.signing_id) {
      this._log(`Ignoring signature share: no matching signing process`);
      return;
    }
    if (!this.frostDkg) {
      this._log(`Cannot process share: no FROST instance loaded`);
      return;
    }

    const senderIndex = info.signer_identifiers[fromPeerId] ?? 0;
    if (senderIndex <= 0 || !info.selected_signers.includes(fromPeerId)) {
      this._log(`Ignoring ${fromPeerId}'s share: not in this signer set`);
      return;
    }

    // Older mock protocol carried the payload under `signature_share`;
    // new real-FROST protocol under `share` (matches WASM naming).
    // Accept either so mid-flight upgrades don't break.
    const shareHex =
      (typeof message.share === "string" && message.share) ||
      (typeof message.signature_share === "string" &&
        message.signature_share) ||
      null;
    if (!shareHex) {
      this._log(
        `Invalid share format from ${fromPeerId}: expected string under 'share' or 'signature_share'`,
      );
      return;
    }

    if (this.signingShares.has(fromPeerId)) {
      this._log(`Duplicate share from ${fromPeerId} — ignoring`);
      return;
    }

    try {
      this.frostDkg.add_signature_share(senderIndex, shareHex);
    } catch (e) {
      this._log(
        `add_signature_share(${senderIndex}, ...) failed: ${this._getErrorMessage(e)}`,
      );
      return;
    }

    this.signingShares.set(fromPeerId, shareHex);
    this._log(
      `Registered share from ${fromPeerId} (idx ${senderIndex}). Total: ${this.signingShares.size}/${info.selected_signers.length}`,
    );
    this._emitSigningProgress();

    this._tryAggregateSignature();
  }

  private _handleAggregatedSignature(fromPeerId: string, message: any): void {
    this._log(`Handling aggregated signature from ${fromPeerId}`);

    if (!this.signingInfo || this.signingInfo.signing_id !== message.signing_id) {
      this._log(`Ignoring aggregated signature: no matching signing process`);
      return;
    }

    const signatureHex =
      typeof message.signature === "string" ? message.signature : null;
    if (!signatureHex) {
      this._log(
        `Invalid aggregated signature format: expected string, got ${typeof message.signature}`,
      );
      return;
    }

    this.signingInfo.final_signature = signatureHex;
    this.signingInfo.step = "complete";
    this._updateSigningState(SigningState.Complete, this.signingInfo);

    const sessionId = this.signingInfo.signing_id.replace(/^sign_/, "");
    this.onSigningComplete({
      signingId: this.signingInfo.signing_id,
      signature: signatureHex,
      messageHex: this.signingInfo.transaction_data,
      blockchain: this.currentBlockchain,
      sessionId,
    });

    this._log(
      `Signing process ${this.signingInfo.signing_id} completed (received aggregated sig from ${fromPeerId})`,
    );
  }

  /**
   * Ext-2d-offscreen-rounds: real FROST round-2 share generation.
   * Replaces the mock that emitted `share-${peerId}-${timestamp}`.
   *
   * `sign(messageHex)` uses our internally-stored nonce (from
   * signing_commit), our key package, and the already-registered
   * commitments from peers (add_signing_commitment calls) to produce
   * our FROST signature share. Returns hex. Nonces are one-time — a
   * second sign() call in the same ceremony would error or produce
   * an invalid share.
   */
  private _generateAndSendSignatureShare(): void {
    this._log(`Generating and sending signature share`);

    if (!this.signingInfo) return;
    if (!this.frostDkg) {
      this._failSigning(`Cannot generate share: no FROST instance loaded`);
      return;
    }

    const messageHex = this.signingInfo.transaction_data;
    let shareHex: string;
    try {
      shareHex = this.frostDkg.sign(messageHex);
    } catch (e) {
      this._failSigning(`sign() failed: ${this._getErrorMessage(e)}`);
      return;
    }

    const message: WebRTCAppMessage = {
      webrtc_msg_type: "SimpleMessage",
      text: `SIGN_SHARE:${this._hexToBase64(this._frostWire("share", shareHex))}`,
    };

    // Every shareholder aggregates — including those outside the set.
    const shareholders = Object.keys(this.signingInfo.signer_identifiers).filter((p) => p !== this.localPeerId);
    for (const peerId of shareholders) {
      this.sendWebRTCAppMessage(peerId, message);
    }

    // Record our own share so _tryAggregateSignature sees the full
    // set when it runs. Keyed by peer-id to match _handleSignatureShare.
    this.signingShares.set(this.localPeerId, shareHex);
    this._log(
      `Generated + broadcast signature share (hex length=${shareHex.length}) to ${shareholders.length} shareholders`,
    );
    this._emitSigningProgress();
  }

  /**
   * Ext-2d-offscreen-rounds: real FROST aggregation. Replaces the
   * mock `aggregated-sig-${timestamp}`.
   *
   * `aggregate_signature(messageHex)` uses all registered shares
   * (ours + peers' via add_signature_share) and the group public
   * key to produce the final threshold signature over messageHex.
   * Only the signer nominated as aggregator (initiator, which for
   * session-based flows maps to the first selected signer) calls
   * this — other signers receive the result via AggregatedSignature
   * broadcast.
   */
  private _aggregateSignatureAndBroadcast(): void {
    this._log(`Aggregating signature and broadcasting result`);

    if (!this.signingInfo) return;
    if (!this.frostDkg) {
      this._failSigning(`Cannot aggregate: no FROST instance loaded`);
      return;
    }

    const messageHex = this.signingInfo.transaction_data;
    let aggregatedHex: string;
    try {
      aggregatedHex = this.frostDkg.aggregate_signature(messageHex);
    } catch (e) {
      this._failSigning(`aggregate_signature() failed: ${this._getErrorMessage(e)}`);
      return;
    }

    const message: WebRTCAppMessage = {
      webrtc_msg_type: "AggregatedSignature" as const,
      signing_id: this.signingInfo.signing_id,
      signature: aggregatedHex,
    };

    // Broadcast to ALL participants (not just selected_signers) so
    // non-signing keyholders also learn the ceremony completed and
    // what the resulting signature was. Lets them e.g. clear any
    // pending "waiting for signature" UI state.
    for (const peerId of this.signingInfo.participants) {
      if (peerId !== this.localPeerId) {
        this.sendWebRTCAppMessage(peerId, message);
      }
    }

    this.signingInfo.final_signature = aggregatedHex;
    this.signingInfo.step = "complete";
    this._updateSigningState(SigningState.Complete, this.signingInfo);

    const sessionId = this.signingInfo.signing_id.replace(/^sign_/, "");
    this.onSigningComplete({
      signingId: this.signingInfo.signing_id,
      signature: aggregatedHex,
      messageHex,
      blockchain: this.currentBlockchain,
      sessionId,
    });

    this._log(
      `Aggregation complete: broadcast final signature (hex length=${aggregatedHex.length}) to ${this.signingInfo.participants.length - 1} peers`,
    );
  }

  // Add getDkgStatus method that tests are expecting
  public getDkgStatus(): {
    state: DkgState;
    stateName?: string;
    blockchain?: string | null;
    participants?: string[];
    threshold?: number;
    groupPublicKey?: string | null;
    address?: string | null;
    participantIndex?: number | null;
    sessionInfo?: SessionInfo | null;
    receivedRound1Packages?: string[];
    receivedRound2Packages?: string[];
    frostDkgInitialized?: boolean;
  } {
    const stateName = DkgState[this.dkgState];

    return {
      state: this.dkgState,
      stateName,
      blockchain: this.currentBlockchain || null,
      participants: this.sessionInfo?.participants || [],
      threshold: (this.sessionInfo as any)?.threshold || 0,
      groupPublicKey: this.groupPublicKey,
      address: this.currentBlockchain === 'ethereum' ? this.ethereumAddress : this.solanaAddress,
      participantIndex: this.participantIndex,
      sessionInfo: this.sessionInfo,
      receivedRound1Packages: Array.from(this.receivedRound1Packages),
      receivedRound2Packages: Array.from(this.receivedRound2Packages),
      frostDkgInitialized: this.frostDkg !== null
    };
  }

  /**
   * Weak-network recovery (same rules as the CLI/TUI): `disconnected` gets a
   * grace period; `failed` — or a grace that expires — rebuilds the
   * connection. Events from a connection we already replaced are ignored.
   */
  private _onPeerConnectionState(peerId: string, pc: RTCPeerConnection): void {
    if (this.peerConnections.get(peerId) !== pc) return;
    const state = pc.connectionState;
    this.onWebRTCConnectionUpdate(peerId, state === "connected");
    if (state === "connected") {
      this._cancelRecovery(peerId);
    } else if (state === "disconnected") {
      if (this.graceTimers.has(peerId)) return;
      this._log(`Connection to ${peerId} disconnected — waiting ${this.disconnectGraceMs}ms before rebuilding`);
      this.graceTimers.set(peerId, setTimeout(() => {
        this.graceTimers.delete(peerId);
        const current = this.peerConnections.get(peerId);
        if (current === pc && pc.connectionState !== "connected") this._rebuildPeer(peerId);
      }, this.disconnectGraceMs));
    } else if (state === "failed") {
      this._clearGrace(peerId);
      this._rebuildPeer(peerId);
    }
  }

  private _cancelRecovery(peerId: string): void {
    this._clearGrace(peerId);
    this._clearOfferWatchdog(peerId);
    const backoff = this.rebuildBackoff.get(peerId);
    if (backoff?.timer) clearTimeout(backoff.timer);
    this.rebuildBackoff.delete(peerId);
  }

  private _clearOfferWatchdog(peerId: string): void {
    const timer = this.offerWatchdogs.get(peerId);
    if (timer) clearTimeout(timer);
    this.offerWatchdogs.delete(peerId);
  }

  private _clearGrace(peerId: string): void {
    const timer = this.graceTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(peerId);
  }

  /**
   * Replace a dead connection: close it (keeping queued and ceremony frames
   * for the new channel) and, if we're the offerer for this pair (smaller
   * device id), offer again. Rate-limited per peer so a flapping link doesn't
   * spin.
   */
  private _rebuildPeer(peerId: string): void {
    const now = Date.now();
    const backoff = this.rebuildBackoff.get(peerId) ?? { nextAt: 0, delay: this.rebuildBaseDelayMs };
    if (now < backoff.nextAt) {
      if (!backoff.timer) {
        backoff.timer = setTimeout(() => {
          backoff.timer = undefined;
          this._rebuildPeer(peerId);
        }, backoff.nextAt - now);
        this.rebuildBackoff.set(peerId, backoff);
      }
      return;
    }
    this.rebuildBackoff.set(peerId, { nextAt: now + backoff.delay, delay: Math.min(backoff.delay * 2, 30_000) });

    this._log(`Rebuilding connection to ${peerId}`);
    this.peerConnections.get(peerId)?.close();
    this.peerConnections.delete(peerId);
    this.dataChannels.delete(peerId);
    this.pendingIceCandidates.delete(peerId);
    this.onWebRTCConnectionUpdate(peerId, false);
    this._removeFromMeshReady(peerId);
    // The mesh outlives a single ceremony (a signing session lists only its
    // proposer), so don't gate on the current session: a peer that really
    // left is removed by dropPeers, which also cancels these timers.
    this._clearOfferWatchdog(peerId);
    if (this.localPeerId < peerId) {
      void this.initiatePeerConnection(peerId);
      this.offerWatchdogs.set(peerId, setTimeout(() => {
        this.offerWatchdogs.delete(peerId);
        if (this.peerConnections.get(peerId)?.connectionState === "connected") return;
        this._log(`Re-offered connection to ${peerId} not up after ${this.offerWatchdogMs}ms`);
        this._rebuildPeer(peerId);
      }, this.offerWatchdogMs));
    }
  }

  /** A peer whose connection dropped is no longer mesh-ready. */
  private _removeFromMeshReady(peerId: string): void {
    const status = this.meshStatus as any;
    if (status.type !== MeshStatusType.Ready && !(status.type === MeshStatusType.PartiallyReady && status.ready_devices)) {
      return;
    }
    const readyPeers: Set<string> =
      status.type === MeshStatusType.PartiallyReady
        ? new Set(status.ready_devices)
        : new Set(this.sessionInfo?.participants || []);
    readyPeers.delete(peerId);
    const totalPeers = this.sessionInfo?.participants.length || 0;
    if (readyPeers.size >= totalPeers) {
      this._updateMeshStatus({ type: MeshStatusType.Ready });
    } else {
      this._updateMeshStatus({ type: MeshStatusType.PartiallyReady, ready_devices: readyPeers, total_devices: totalPeers });
    }
  }

  /**
   * Whether to answer an incoming offer. A connection we already negotiated
   * is replaced (the peer rebuilt or restarted); in glare — we're the offerer
   * and mid-offer — the peer's offer is ignored.
   */
  private _acceptsOffer(peerId: string): boolean {
    const existing = this.peerConnections.get(peerId);
    if (!existing) return true;
    if (this.localPeerId < peerId && existing.signalingState === "have-local-offer") {
      this._log(`Ignoring offer from ${peerId}: glare, our offer is pending`);
      return false;
    }
    if (existing.remoteDescription) {
      this._log(`Replacing connection to ${peerId} for its new offer`);
      existing.close();
      this.peerConnections.delete(peerId);
      this.dataChannels.delete(peerId);
      this.pendingIceCandidates.delete(peerId);
    }
    return true;
  }

  /** Close and forget the connections of peers that left the signal server. */
  public dropPeers(peerIds: string[]): void {
    for (const peerId of peerIds) {
      this.peerConnections.get(peerId)?.close();
      this.peerConnections.delete(peerId);
      this.dataChannels.delete(peerId);
      this.pendingSends.delete(peerId);
      this._cancelRecovery(peerId);
      this._log(`Dropped connection to ${peerId} (left the signal server)`);
    }
  }

  /**
   * Offer to every session participant whose device id sorts after ours —
   * the smaller id offers, the same rule as the Rust CLI/TUI. Skips peers
   * we already have a connection with, so it is safe to call whenever a
   * ceremony becomes ready.
   */
  public initiateMeshOffers(): void {
    for (const peerId of this.sessionInfo?.participants ?? []) {
      if (peerId > this.localPeerId && !this.peerConnections.has(peerId)) {
        void this.initiatePeerConnection(peerId);
      }
    }
  }

  // Add the missing initiatePeerConnection method that offscreen/index.ts calls
  public async initiatePeerConnection(peerId: string): Promise<void> {
    this._log(`Initiating peer connection to ${peerId}`);

    try {
      // Get or create peer connection
      const pc = await this._getOrCreatePeerConnection(peerId);
      if (!pc) {
        this._log(`Failed to create peer connection for ${peerId}`);
        return;
      }

      // Create data channel if we are the initiator (following politeness rule)
      if (this.localPeerId < peerId) {
        this._log(`Creating data channel for ${peerId} (we are initiator)`);
        const dataChannel = pc.createDataChannel('frost-dkg', {
          ordered: true
        });
        this._setupDataChannel(dataChannel, peerId);
      }

      // Create and send offer
      this._log(`Creating offer for ${peerId}`);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send offer via WebSocket relay
      const wsMsgPayload = {
        websocket_msg_type: 'WebRTCSignal',
        Offer: { sdp: offer.sdp! }  // Direct at root level, matching Rust enum structure
      };

      if (this.sendPayloadToBackgroundForRelay) {
        this.sendPayloadToBackgroundForRelay(peerId, wsMsgPayload as any);
        this._log(`Sent Offer to ${peerId} via background`);
      } else {
        this._log(`Cannot send Offer to ${peerId}: no relay callback available`);
      }

    } catch (error) {
      this._log(`Error initiating peer connection to ${peerId}: ${this._getErrorMessage(error)}`);
    }
  }

  // Add missing status methods that offscreen/index.ts calls
  public getDataChannelStatus(): Record<string, string> {
    const status: Record<string, string> = {};
    this.dataChannels.forEach((channel, peerId) => {
      status[peerId] = channel.readyState;
    });
    return status;
  }

  public getConnectedPeers(): string[] {
    return Array.from(this.dataChannels.keys()).filter(peerId => {
      const dc = this.dataChannels.get(peerId);
      return dc && dc.readyState === 'open';
    });
  }

  public getPeerConnectionStatus(): Record<string, string> {
    const status: Record<string, string> = {};
    this.peerConnections.forEach((pc, peerId) => {
      status[peerId] = pc.connectionState;
    });
    return status;
  }

  // Method to update session info and trigger mesh status check
  public updateSessionInfo(sessionInfo: SessionInfo): void {
    this._log(`Updating session info for session ${sessionInfo.session_id}`);
    if (this.sessionInfo && this.sessionInfo.session_id !== sessionInfo.session_id) {
      // Undelivered frames belong to the previous ceremony.
      this.pendingSends.clear();
      this.ceremonyOutbox.clear();
    }
    this._log(`Participants: [${sessionInfo.participants.join(', ')}]`);
    this._log(`Accepted devices: [${sessionInfo.accepted_devices.join(', ')}]`);

    // Canonicalize participant order (sorted) so FROST identifiers match the
    // Rust core regardless of join order — see _withSortedParticipants (#29).
    this.sessionInfo = this._withSortedParticipants(sessionInfo)!;

    // Trigger mesh status check when session acceptance status changes
    this._checkMeshStatus();
  }

  // Enhanced auto-trigger logic for DKG
  private _shouldAutoTriggerDkg(): boolean {
    if (!this.sessionInfo) {
      this._log(`Auto-trigger check: No session info`);
      return false;
    }

    // Condition 1: Mesh is fully Ready
    if (this.meshStatus.type === MeshStatusType.Ready) {
      this._log(`Auto-trigger check: Mesh is Ready ✅`);
      return true;
    }

    // Condition 2: Mesh is PartiallyReady and all session participants have accepted
    if (this.meshStatus.type === MeshStatusType.PartiallyReady) {
      const allParticipantsAccepted = this.sessionInfo.participants.every(peerId =>
        this.sessionInfo!.accepted_devices.includes(peerId)
      );

      this._log(`Auto-trigger check: Mesh PartiallyReady, all participants accepted: ${allParticipantsAccepted} (${this.sessionInfo.accepted_devices.length}/${this.sessionInfo.participants.length})`);

      if (allParticipantsAccepted) {
        return true;
      }
    }

    // Condition 3: We have buffered packages from every remote peer (TUI or extension — both valid co-signers).
    const expectedParticipants = this.sessionInfo.participants.filter(p => p !== this.localPeerId);
    const bufferedFromParticipants = new Set(this.bufferedRound1Packages.map(pkg => pkg.fromPeerId));
    const allPeersReady = expectedParticipants.every(p => bufferedFromParticipants.has(p));

    this._log(`Auto-trigger check: peers-ready check - expected: [${expectedParticipants.join(', ')}], buffered from: [${Array.from(bufferedFromParticipants).join(', ')}], all ready: ${allPeersReady}`);

    if (allPeersReady && expectedParticipants.length > 0) {
      this._log(`Auto-trigger check: All peers have sent Round 1 packages ✅`);
      return true;
    }

    this._log(`Auto-trigger check: No conditions met yet`);
    return false;
  }
}
