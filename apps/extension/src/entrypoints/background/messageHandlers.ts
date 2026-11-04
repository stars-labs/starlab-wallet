// ===================================================================
// MESSAGE HANDLERS MODULE
// ===================================================================
//
// This module contains specialized message handlers for different
// types of background script communications including:
// - Popup message handling
// - Offscreen message routing
// - WebSocket relay operations
// - Address and blockchain requests
// ===================================================================

import type {
    PopupToBackgroundMessage,
    OffscreenToBackgroundMessage
} from "@stars-labs/types/messages";
import { MESSAGE_TYPES, isRpcMessage, isAccountManagement, isNetworkManagement, isUIRequest } from "@stars-labs/types/messages";
import { StateManager, withoutSecrets } from "./stateManager";
import { redactForLog } from "../../utils/redact";
import { walletIdFromSession, ECDSA_CURVE, isEcdsaChain } from "../../utils/wallet-id";
import { OffscreenManager } from "./offscreenManager";
import { WebSocketManager } from "./webSocketManager";
import { SessionManager } from "./sessionManager";
import { checkAndRestoreKeystores } from "./index";
import { RpcHandler, UIRequestHandler } from "./rpcHandler";
import AccountService from "../../services/accountService";
import NetworkService from "../../services/networkService";
import { KeystoreManager } from "../../services/keystoreManager";
import { handleGetPortfolio, handleGetActivity, handleRecordActivity } from "./assetHandlers";
import { DkgState } from "@stars-labs/types/dkg";
import type { KeyShareData } from "@stars-labs/types/keystore";
import { keyShareCoreFromEngine, type KeyShareCore } from "../../utils/engineKeystore";
import {
    getDefaultChainForCurve,
    getProtocolBlockchainForChain,
    getChainLabel,
    getRequiredCurve,
    isSupportedChain,
    isEvmChain,
    normalizeDerivedAddressChain,
    type SupportedChain,
} from "@stars-labs/types/appstate";
import {
    encryptShareBackup,
    openShareBackup,
    encryptEcdsaShareBackup,
    openEcdsaShareBackup,
    shareBackupCurve,
    type EcdsaShareInfo,
} from "../../utils/shareBackup";
import { EcdsaPrimeCache, syncEcdsaPrimes } from "./ecdsaPrimes";

/**
 * Handles messages from popup interface
 */
export class PopupMessageHandler {
    private stateManager: StateManager;
    private offscreenManager: OffscreenManager;
    private webSocketManager: WebSocketManager;
    private sessionManager: SessionManager;
    private rpcHandler: RpcHandler;
    private uiRequestHandler: UIRequestHandler;

    constructor(
        stateManager: StateManager,
        offscreenManager: OffscreenManager,
        webSocketManager: WebSocketManager,
        sessionManager: SessionManager,
        rpcHandler: RpcHandler,
        uiRequestHandler: UIRequestHandler
    ) {
        this.stateManager = stateManager;
        this.offscreenManager = offscreenManager;
        this.webSocketManager = webSocketManager;
        this.sessionManager = sessionManager;
        this.rpcHandler = rpcHandler;
        this.uiRequestHandler = uiRequestHandler;
    }

    /**
     * Handle messages from popup with enhanced pattern-based categorization
     */
    async handlePopupMessage(
        message: PopupToBackgroundMessage,
        sendResponse: (response: any) => void
    ): Promise<void> {
        const startTime = Date.now();
        const messageType = message.type;

        // Enhanced pattern-based categorization
        const { category, categoryInfo } = this.categorizeMessage(message);

//         console.log("┌─────────────────────────────────────────────────────────────────");
//         console.log(`│ ${categoryInfo.color}[PopupMessageHandler] ${categoryInfo.icon} Processing: ${messageType}\x1b[0m`);
        console.log(`│ Category: ${categoryInfo.icon} ${categoryInfo.name}`);

        // Keep messageCategory for backward compatibility
        let messageCategory = categoryInfo.name;

        // Enhanced logging for RPC messages
        if (isRpcMessage(message)) {
            messageCategory = 'RPC';
            const rpcMethod = (message as any).payload?.method || 'unknown';
            const rpcParams = (message as any).payload?.params;
            const rpcId = (message as any).payload?.id;

            console.log(`│ RPC Method: ${rpcMethod}`);
            console.log(`│ RPC ID: ${rpcId}`);
            console.log(`│ RPC Params:`, rpcParams);

            // Log specific RPC methods for better tracking
            if (rpcMethod.includes('eth_')) {
                console.log(`│ 🔗 Ethereum RPC: ${rpcMethod}`);
            } else if (rpcMethod.includes('sol_') || rpcMethod.includes('solana_')) {
                console.log(`│ 🟣 Solana RPC: ${rpcMethod}`);
            } else if (rpcMethod.includes('sign')) {
                console.log(`│ ✍️ Signing RPC: ${rpcMethod}`);
            } else if (rpcMethod.includes('account') || rpcMethod.includes('address')) {
                console.log(`│ 👤 Account RPC: ${rpcMethod}`);
            } else {
                console.log(`│ 🔧 Generic RPC: ${rpcMethod}`);
            }
        } else if (isAccountManagement(message)) {
            messageCategory = 'Account Management';
        } else if (isNetworkManagement(message)) {
            messageCategory = 'Network Management';
        } else if (isUIRequest(message)) {
            messageCategory = 'UI Request';
        }

        console.log(`│ Data:`, redactForLog(message));
//         console.log("└─────────────────────────────────────────────────────────────────");

        try {
            switch (message.type) {
                case MESSAGE_TYPES.GET_STATE:
//                     console.log("📊 [PopupMessageHandler] GET_STATE: Returning current application state");
                    sendResponse(withoutSecrets(this.stateManager.getState()));
                    break;

                case MESSAGE_TYPES.GET_WEBRTC_STATE:
//                     console.log("📡 [PopupMessageHandler] GET_WEBRTC_STATE: Returning WebRTC connections");
                    const webrtcConnections = this.stateManager.getWebRTCConnections();
//                     console.log("📡 [PopupMessageHandler] WebRTC connections:", webrtcConnections);
                    sendResponse({ webrtcConnections });
                    break;

                case MESSAGE_TYPES.LIST_DEVICES:
                    console.log("📋 [PopupMessageHandler] LIST_DEVICES: Requesting peer discovery");
                    await this.handleListDevicesRequest(sendResponse);
                    break;

                case "reconnectSignal":
                    console.log("🔌 [PopupMessageHandler] RECONNECT_SIGNAL: reconnecting to apply saved room/server");
                    await this.handleReconnectSignal(sendResponse);
                    break;

                case MESSAGE_TYPES.RELAY:
//                     console.log("🔄 [PopupMessageHandler] RELAY: Forwarding message via WebSocket");
                    await this.handleRelayRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.CREATE_OFFSCREEN:
                    console.log("📄 [PopupMessageHandler] CREATE_OFFSCREEN: Creating offscreen document");
                    await this.handleCreateOffscreenRequest(sendResponse);
                    break;

                case MESSAGE_TYPES.GET_OFFSCREEN_STATUS:
                    console.log("📄 [PopupMessageHandler] GET_OFFSCREEN_STATUS: Checking offscreen status");
                    await this.handleGetOffscreenStatusRequest(sendResponse);
                    break;

                case MESSAGE_TYPES.FROM_OFFSCREEN:
//                     console.log("📤 [PopupMessageHandler] FROM_OFFSCREEN: Processing offscreen message");
                    await this.handleFromOffscreenMessage(message, sendResponse);
                    break;

                case "requestInit":
//                     console.log("🔧 [PopupMessageHandler] REQUEST_INIT: Handling initialization request");
                    await this.handleRequestInitMessage(sendResponse);
                    break;
                    
                case "approveMessageSignature":
                    console.log("✍️ [PopupMessageHandler] APPROVE_MESSAGE_SIGNATURE: Handling signature approval");
                    await this.handleApproveMessageSignature(message, sendResponse);
                    break;

                case "getPendingSignatureRequests":
                    sendResponse({
                        success: true,
                        requests: this.rpcHandler.getPendingSignatureRequests(),
                    });
                    break;

                case "getPendingConnectRequests":
                    sendResponse({
                        success: true,
                        requests: this.rpcHandler.getPendingConnectRequests(),
                    });
                    break;

                case "resolveConnectRequest":
                    await this.handleResolveConnectRequest(message, sendResponse);
                    break;

                // Session restore removed - sessions are ephemeral for security
                // case "requestSessionRestore": removed

                case MESSAGE_TYPES.PROPOSE_SESSION:
                    console.log("🔐 [PopupMessageHandler] PROPOSE_SESSION: Creating new MPC session");
                    await this.handleProposeSessionRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.CREATE_DKG_WALLET:
                    console.log("🔐 [PopupMessageHandler] CREATE_DKG_WALLET: Creating new MPC wallet via DKG (TUI-compat announce)");
                    await this.handleCreateDkgWalletRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.JOIN_DKG_SESSION:
                    console.log("🔐 [PopupMessageHandler] JOIN_DKG_SESSION: Joining discovered DKG session");
                    await this.handleJoinDkgSessionRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.SAVE_DKG_WALLET:
                    console.log("🔐 [PopupMessageHandler] SAVE_DKG_WALLET: Persisting post-DKG keyshare");
                    await this.handleSaveDkgWalletRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.DECLINE_SIGNING_SESSION:
                    console.log(
                        "🚫 [PopupMessageHandler] DECLINE_SIGNING_SESSION: Relaying decline to proposer",
                    );
                    await this.handleDeclineSigningSessionRequest(
                        message,
                        sendResponse,
                    );
                    break;

                case MESSAGE_TYPES.CREATE_SIGNING_SESSION:
                    console.log("🖊️ [PopupMessageHandler] CREATE_SIGNING_SESSION: Initiating signing ceremony");
                    await this.handleCreateSigningSessionRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.CREATE_RESHARE_SESSION:
                    console.log("🔁 [PopupMessageHandler] CREATE_RESHARE_SESSION: Initiating share rotation");
                    await this.handleCreateReshareSessionRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.GET_WALLET_COHORT:
                    await this.handleGetWalletCohortRequest(message, sendResponse);
                    break;

                case "getWalletKeystore":
                    // Offscreen → background: decrypted key share for a
                    // SPECIFIC wallet (a reshare may target a non-active
                    // wallet). Sibling of getActiveKeystore.
                    await this.handleGetWalletKeystoreMessage(message, sendResponse);
                    break;

                case MESSAGE_TYPES.ACCEPT_SESSION:
                    console.log("🔐 [PopupMessageHandler] ACCEPT_SESSION: Accepting MPC session invite");
                    await this.handleAcceptSessionRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.SEND_DIRECT_MESSAGE:
                    console.log("💬 [PopupMessageHandler] SEND_DIRECT_MESSAGE: Sending direct peer message");
                    await this.handleSendDirectMessageRequest(message, sendResponse);
                    break;

                case MESSAGE_TYPES.GET_WEBRTC_STATUS:
//                     console.log("📡 [PopupMessageHandler] GET_WEBRTC_STATUS: Getting WebRTC status");
                    await this.handleGetWebRTCStatusRequest(sendResponse);
                    break;

                case "setBlockchain":
//                     console.log("🔗 [PopupMessageHandler] SET_BLOCKCHAIN: Setting blockchain preference");
                    await this.handleSetBlockchainRequest(message, sendResponse);
                    break;

                case "getEthereumAddress":
                    console.log("🏠 [PopupMessageHandler] GET_ETHEREUM_ADDRESS: Requesting Ethereum address");
                    await this.handleGetEthereumAddressRequest(sendResponse);
                    break;

                case "getSolanaAddress":
                    console.log("🏠 [PopupMessageHandler] GET_SOLANA_ADDRESS: Requesting Solana address");
                    await this.handleGetSolanaAddressRequest(sendResponse);
                    break;

                case MESSAGE_TYPES.REQUEST_SIGNING:
                    console.log("✍️ [PopupMessageHandler] REQUEST_SIGNING: Initiating MPC signing");
                    await this.handleRequestSigningMessage(message, sendResponse);
                    break;

                case "importKeystore":
                    console.log("📥 [PopupMessageHandler] IMPORT_KEYSTORE: Importing keystore file");
                    await this.handleImportKeystoreMessage(message, sendResponse);
                    break;

                case "exportKeystore":
                    console.log("📤 [PopupMessageHandler] EXPORT_KEYSTORE: Exporting keystore file");
                    await this.handleExportKeystoreMessage(message, sendResponse);
                    break;

                case MESSAGE_TYPES.UNLOCK_KEYSTORE:
                    console.log("🔓 [PopupMessageHandler] UNLOCK_KEYSTORE: Unlocking keystore");
                    await this.handleUnlockKeystoreMessage(message, sendResponse);
                    break;

                case MESSAGE_TYPES.LOCK_KEYSTORE:
                    console.log("🔒 [PopupMessageHandler] LOCK_KEYSTORE: Locking keystore");
                    await this.handleLockKeystoreMessage(sendResponse);
                    break;

                case MESSAGE_TYPES.CREATE_KEYSTORE:
                    console.log("🔑 [PopupMessageHandler] CREATE_KEYSTORE: Creating new keystore");
                    await this.handleCreateKeystoreMessage(message, sendResponse);
                    break;

                case MESSAGE_TYPES.GET_KEYSTORE_STATUS:
                    console.log("📊 [PopupMessageHandler] GET_KEYSTORE_STATUS: Getting keystore status");
                    await this.handleGetKeystoreStatusMessage(sendResponse);
                    break;

                case MESSAGE_TYPES.SWITCH_WALLET:
                    console.log("🔄 [PopupMessageHandler] SWITCH_WALLET: Switching active wallet");
                    await this.handleSwitchWalletMessage(message, sendResponse);
                    break;

                case MESSAGE_TYPES.MIGRATE_KEYSTORES:
                    console.log("📦 [PopupMessageHandler] MIGRATE_KEYSTORES: Migrating keystores");
                    await this.handleMigrateKeystoresMessage(message, sendResponse);
                    break;

                case "getActiveKeystore":
                    console.log("🔑 [PopupMessageHandler] GET_ACTIVE_KEYSTORE: Getting active keystore");
                    await this.handleGetActiveKeystoreMessage(sendResponse);
                    break;

                case "deriveAccounts": {
                    // Account model: pure pass-through to the offscreen wasm
                    // (public derivation — no password involved anywhere).
                    try {
                        await this.offscreenManager.createOffscreenDocument();
                        const resp = await this.offscreenManager.sendToOffscreen({
                            type: "deriveAccounts",
                            curve: (message as any).curve,
                            groupPublicKey: (message as any).groupPublicKey,
                            count: (message as any).count ?? 5,
                        } as any);
                        sendResponse(resp ?? { success: false, error: "no offscreen response" });
                    } catch (e) {
                        sendResponse({ success: false, error: (e as Error).message });
                    }
                    break;
                }

                case "getPortfolio":
                    await this.handleGetPortfolioMessage(message, sendResponse);
                    break;

                case "getActivity":
                    await this.handleGetActivityMessage(message, sendResponse);
                    break;

                case "recordActivity":
                    await this.handleRecordActivityMessage(message, sendResponse);
                    break;

                default:
                    if (isRpcMessage(message)) {
//                         console.log("🔗 [PopupMessageHandler] RPC_MESSAGE: Processing JSON-RPC request");
                        await this.handleRpcMessage(message, sendResponse);
                    } else if (isAccountManagement(message)) {
                        console.log("👤 [PopupMessageHandler] ACCOUNT_MANAGEMENT: Not implemented");
                        sendResponse({ success: false, error: "Account management not implemented" });
                    } else if (isNetworkManagement(message)) {
                        console.log("🌐 [PopupMessageHandler] NETWORK_MANAGEMENT: Not implemented");
                        sendResponse({ success: false, error: "Network management not implemented" });
                    } else if (isUIRequest(message)) {
                        console.log("🖼️ [PopupMessageHandler] UI_REQUEST: Processing UI request");
                        await this.handleUIRequestMessage(message, sendResponse);
                    } else {
                        console.warn("❓ [PopupMessageHandler] UNKNOWN_MESSAGE_TYPE:", message.type);
                        sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
                    }
                    break;
            }
        } catch (error) {
            const duration = Date.now() - startTime;
            const errorDetails = (error as Error).message;

            if (messageCategory === 'RPC') {
                const rpcMethod = (message as any).payload?.method || 'unknown';
                const rpcId = (message as any).payload?.id;
                console.error(`❌ [PopupMessageHandler] RPC ERROR: ${rpcMethod} (ID: ${rpcId}) failed after ${duration}ms`);
                console.error(`❌ RPC Error Details:`, errorDetails);
                sendResponse({
                    success: false,
                    error: errorDetails,
                    rpcMethod,
                    rpcId,
                    duration
                });
            } else {
                console.error(`❌ [PopupMessageHandler] Error in ${messageType} (${messageCategory}) after ${duration}ms:`, error);
                sendResponse({ success: false, error: errorDetails });
            }
        } finally {
            const duration = Date.now() - startTime;

            if (messageCategory === 'RPC') {
                const rpcMethod = (message as any).payload?.method || 'unknown';
                const rpcId = (message as any).payload?.id;
                console.log(`⏱️ [PopupMessageHandler] 🔗 RPC ${rpcMethod} (ID: ${rpcId}) completed in ${duration}ms`);
            } else {
                console.log(`⏱️ [PopupMessageHandler] ${messageType} (${messageCategory}) completed in ${duration}ms`);
            }
        }
    }

    /**
     * Pattern-based message categorization using simple matching
     */
    private categorizeMessage(message: PopupToBackgroundMessage): { category: string; categoryInfo: any } {
        const messageType = message.type;

        // Pattern matching for message categories
        if (messageType.includes('getState') || messageType.includes('setState') ||
            messageType === 'GET_STATE' || messageType === 'GET_WEBRTC_STATE') {
            return {
                category: 'state_management',
                categoryInfo: {
                    name: 'State Management',
                    icon: '📊',
                    color: '\x1b[36m' // cyan
                }
            };
        }

        if (messageType.includes('session') || messageType.includes('Session') ||
            messageType === 'CREATE_SESSION' || messageType === 'JOIN_SESSION' ||
            messageType === 'LEAVE_SESSION' || messageType === 'PROPOSE_SESSION' ||
            messageType === 'ACCEPT_SESSION') {
            return {
                category: 'session_management',
                categoryInfo: {
                    name: 'Session Management',
                    icon: '🔐',
                    color: '\x1b[35m' // magenta
                }
            };
        }

        if (messageType.includes('webrtc') || messageType.includes('WebRTC') ||
            messageType.includes('WEBRTC') || messageType === 'GET_WEBRTC_STATUS') {
            return {
                category: 'webrtc_control',
                categoryInfo: {
                    name: 'WebRTC Control',
                    icon: '📡',
                    color: '\x1b[34m' // blue
                }
            };
        }

        if (messageType.includes('offscreen') || messageType.includes('Offscreen') ||
            messageType.includes('OFFSCREEN') || messageType === 'CREATE_OFFSCREEN' ||
            messageType === 'GET_OFFSCREEN_STATUS' || messageType === 'FROM_OFFSCREEN' ||
            messageType === 'offscreenReady') {
            return {
                category: 'offscreen_control',
                categoryInfo: {
                    name: 'Offscreen Control',
                    icon: '📄',
                    color: '\x1b[33m' // yellow
                }
            };
        }

        if (messageType.includes('address') || messageType.includes('Address') ||
            messageType.includes('ADDRESS') || messageType === 'getEthereumAddress' ||
            messageType === 'getSolanaAddress') {
            return {
                category: 'address_management',
                categoryInfo: {
                    name: 'Address Management',
                    icon: '🏠',
                    color: '\x1b[32m' // green
                }
            };
        }

        if (messageType === 'setBlockchain' || messageType.includes('network') ||
            messageType.includes('Network')) {
            return {
                category: 'network_management',
                categoryInfo: {
                    name: 'Network Management',
                    icon: '🌐',
                    color: '\x1b[31m' // red
                }
            };
        }

        if (messageType.includes('rpc') || messageType.includes('RPC') ||
            messageType.startsWith('eth_')) {
            return {
                category: 'rpc_request',
                categoryInfo: {
                    name: 'RPC Request',
                    icon: '⚡',
                    color: '\x1b[93m' // bright yellow
                }
            };
        }

        if (messageType === 'RELAY') {
            return {
                category: 'relay',
                categoryInfo: {
                    name: 'Message Relay',
                    icon: '🔄',
                    color: '\x1b[94m' // bright blue
                }
            };
        }

        if (messageType === 'LIST_DEVICES' || messageType === 'requestInit') {
            return {
                category: 'ui_request',
                categoryInfo: {
                    name: 'UI Request',
                    icon: '🖼️',
                    color: '\x1b[96m' // bright cyan
                }
            };
        }

        if (messageType.includes('sign') || messageType.includes('Sign') ||
            messageType.includes('SIGN') || messageType === 'REQUEST_SIGNING' ||
            messageType === 'ACCEPT_SIGNING') {
            return {
                category: 'signing',
                categoryInfo: {
                    name: 'Signing Operations',
                    icon: '✍️',
                    color: '\x1b[95m' // bright magenta
                }
            };
        }

        // Default unknown category
        return {
            category: 'unknown',
            categoryInfo: {
                name: 'Unknown',
                icon: '❓',
                color: '\x1b[90m' // gray
            }
        };
    }

    private async handleListDevicesRequest(sendResponse: (response: any) => void): Promise<void> {
//         console.log("[PopupMessageHandler] LIST_DEVICES request received. WebSocket state:", this.webSocketManager.isReady());

        const result = await this.webSocketManager.listDevices();
        if (result.success) {
            console.log("[PopupMessageHandler] Peer list request sent successfully");
            sendResponse({ success: true });
        } else {
            console.warn("[PopupMessageHandler] WebSocket not connected, cannot list devices");
            sendResponse({ success: false, error: result.error });
        }
    }

    /**
     * Reconnect the signal-server WebSocket using the freshly saved room /
     * server override. Startup skips WebSocket dialing until a room exists;
     * this re-resolves the URL so the new room takes effect without reloading
     * the extension.
     */
    private async handleReconnectSignal(sendResponse: (response: any) => void): Promise<void> {
        try {
            await this.webSocketManager.reconnect();
            sendResponse({ success: true });
        } catch (error) {
            sendResponse({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async handleRelayRequest(message: any, sendResponse: (response: any) => void): Promise<void> {
        if ('to' in message && 'data' in message) {
            const result = await this.webSocketManager.relayMessage(message.to as string, message.data);
            sendResponse(result);
        } else {
            sendResponse({ success: false, error: "Invalid relay message format" });
        }
    }

    private async handleCreateOffscreenRequest(sendResponse: (response: any) => void): Promise<void> {
        const createResult = await this.offscreenManager.createOffscreenDocument();
        sendResponse(createResult);
    }

    private async handleGetOffscreenStatusRequest(sendResponse: (response: any) => void): Promise<void> {
        const status = await this.offscreenManager.getOffscreenStatus();
        sendResponse(status);
    }

    private async handleFromOffscreenMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        if ('payload' in message) {
            this.stateManager.handleOffscreenStateUpdate(message.payload as OffscreenToBackgroundMessage);
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: "FromOffscreen message missing payload" });
        }
    }

    private async handleRequestInitMessage(sendResponse: (response: any) => void): Promise<void> {
        const result = await this.offscreenManager.handleInitRequest();
        sendResponse(result);
    }
    
    private async handleApproveMessageSignature(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        if (!message.requestId || typeof message.approved !== "boolean") {
            sendResponse({ success: false, error: "Invalid approval message" });
            return;
        }

        console.log(
            `[PopupMessageHandler] Signature approval for ${message.requestId}: ${message.approved}`,
        );

        // Ext-4-confirm: if this requestId corresponds to a pending
        // dApp request in RpcHandler, route through
        // approveDappSignature — it creates the FROST session on
        // approval or rejects the pending promise on deny. Falls
        // back to the legacy "just reject on deny" path for
        // requestIds the RpcHandler doesn't recognize (in case
        // we still have stale callers of the old approve flow).
        if (
            typeof (this.rpcHandler as any).approveDappSignature === "function"
        ) {
            const result = await (this.rpcHandler as any).approveDappSignature(
                message.requestId,
                message.approved,
            );
            sendResponse(result);
            return;
        }

        // Legacy fallback:
        if (!message.approved) {
            if (this.rpcHandler.handleSignatureError) {
                this.rpcHandler.handleSignatureError(
                    message.requestId,
                    "User rejected signature request",
                );
            }
        }
        sendResponse({ success: true });
    }

    /** Popup Approve/Reject on a dApp Connect request card. */
    private async handleResolveConnectRequest(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        const selected = message.selectedAddresses;
        if (
            typeof message.requestId !== "string" ||
            typeof message.approved !== "boolean" ||
            (selected !== undefined &&
                (!Array.isArray(selected) || !selected.every((a: unknown) => typeof a === "string")))
        ) {
            sendResponse({ success: false, error: "Invalid connect resolution message" });
            return;
        }
        sendResponse(
            await this.rpcHandler.resolveConnectRequest(message.requestId, message.approved, selected),
        );
    }

    // Session restore removed - sessions are ephemeral for security

    private async handleProposeSessionRequest(message: any, sendResponse: (response: any) => void): Promise<void> {
        if ('session_id' in message && 'total' in message && 'threshold' in message && 'participants' in message) {
            console.log("[PopupMessageHandler] Proposing session:", message.session_id);

            const blockchain = message.blockchain || "solana";

            const result = await this.sessionManager.proposeSession(
                message.session_id,
                message.total,
                message.threshold,
                message.participants,
                blockchain
            );

            sendResponse(result);
        } else {
            sendResponse({ success: false, error: "Invalid session proposal" });
        }
    }

    /**
     * Ext-1b popup→background handler: user clicked "Create Wallet" in
     * the popup with (name, total, threshold, curve). We delegate to
     * sessionManager.createDkgWallet which builds the TUI-compatible
     * SessionInfo, stashes it locally, and broadcasts via
     * `announce_session`. The reply carries the generated session_id
     * so the popup can transition to "waiting for joiners".
     */
    private async handleCreateDkgWalletRequest(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        const total = Number(message.total);
        const threshold = Number(message.threshold);
        const curve = message.curve === "ed25519" ? "ed25519" : "secp256k1";
        const chain = isSupportedChain(message.chain)
            ? message.chain
            : getDefaultChainForCurve(curve);
        if (!Number.isFinite(total) || !Number.isFinite(threshold)) {
            sendResponse({
                success: false,
                error: "total and threshold must be numbers",
            });
            return;
        }
        const result = await this.sessionManager.createDkgWallet({
            name: typeof message.name === "string" ? message.name : undefined,
            total,
            threshold,
            curve,
            chain,
        });
        sendResponse(result);
    }

    /**
     * Ext-1e popup→background handler for "join this DKG session I
     * saw in the invites list". Payload is just `{ session_id }`;
     * the invite carries everything else (threshold, curve, etc.)
     * from the creator's announcement and sessionManager looks it
     * up in `appState.invites` authoritatively.
     */
    private async handleJoinDkgSessionRequest(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        const sessionId = message.session_id;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            sendResponse({
                success: false,
                error: "session_id (string) required",
            });
            return;
        }
        const result = await this.sessionManager.joinDkgSession(sessionId);
        sendResponse(result);
    }

    /**
     * Ext-3c: popup → background "I'm declining this signing
     * invite". We relay a SigningDecline frame to the proposer
     * via the signal server (WebRTC mesh doesn't exist yet for a
     * co-signer who hasn't joined). Proposer's handleRelayMessage
     * routes it into a toast + optional roster overlay.
     *
     * Payload: `{session_id}`. The invite for this session_id
     * must exist in appState.invites (otherwise we don't know the
     * proposer_id). Removing from invites locally too so the
     * popup's list doesn't re-render it post-decline.
     */
    private async handleDeclineSigningSessionRequest(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const sessionId = message.session_id;
            if (typeof sessionId !== "string" || !sessionId) {
                sendResponse({ success: false, error: "session_id required" });
                return;
            }
            const appState = this.stateManager.getState();
            const invite = (appState.invites ?? []).find(
                (s: any) => s.session_id === sessionId,
            );
            if (!invite) {
                sendResponse({
                    success: false,
                    error: `No known invite for ${sessionId}`,
                });
                return;
            }
            const myDeviceId = appState.deviceId;
            if (!myDeviceId) {
                sendResponse({ success: false, error: "Device id not set" });
                return;
            }
            const proposerId = invite.proposer_id;
            if (!proposerId || proposerId === myDeviceId) {
                // Can't decline our own proposal, and can't send
                // anywhere if proposer is unknown.
                sendResponse({
                    success: false,
                    error: "Invalid proposer for decline",
                });
                return;
            }

            const ok = this.webSocketManager.relayToPeer(proposerId, {
                websocket_msg_type: "SigningDecline",
                signing_id: sessionId,
                decliner_id: myDeviceId,
            });

            // Remove from invites locally so the popup's list drops it.
            const remaining = (appState.invites ?? []).filter(
                (s: any) => s.session_id !== sessionId,
            );
            this.stateManager.updateInvites?.(remaining);

            if (!ok) {
                sendResponse({
                    success: false,
                    error: "Signal server not connected",
                });
                return;
            }
            console.log(
                `[PopupMessageHandler] Relayed SigningDecline to ${proposerId} for ${sessionId}`,
            );
            sendResponse({ success: true });
        } catch (err) {
            console.error(
                "[PopupMessageHandler] DECLINE_SIGNING_SESSION failed:",
                err,
            );
            sendResponse({
                success: false,
                error: (err as Error).message ?? String(err),
            });
        }
    }

    /**
     * Ext-2a/b: popup → background "I want to sign this message with
     * wallet X". Payload `{walletId, message}` where `message` is
     * the user's plain UTF-8 text (or pre-hex if starts with `0x`).
     * Handler:
     *   1. Look up the wallet in KeystoreManager to get curve +
     *      group_public_key — UI can't be trusted to send these.
     *   2. For secp256k1, wrap `message` with EIP-191
     *      (`\x19Ethereum Signed Message:\n<len><msg>` → keccak256)
     *      (the digest the TUI's personal_sign path signs too). FROST
     *      secp256k1 is BIP-340 Schnorr: NOT ecrecover-compatible. For ed25519,
     *      sign the raw UTF-8 bytes.
     *   3. Delegate to sessionManager.createSigningSession which
     *      announces on the wire.
     */
    private async handleCreateSigningSessionRequest(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const walletId = message.walletId;
            const userMessage = message.message;
            if (typeof walletId !== "string" || !walletId) {
                sendResponse({ success: false, error: "walletId required" });
                return;
            }
            if (typeof userMessage !== "string" || userMessage.length === 0) {
                sendResponse({ success: false, error: "message required" });
                return;
            }

            const { KeystoreManager } = await import(
                "../../services/keystoreManager"
            );
            const km = KeystoreManager.getInstance();
            const wallets = km.getWallets();
            const wallet = wallets.find((w: any) => w.id === walletId);
            if (!wallet) {
                sendResponse({
                    success: false,
                    error: `No wallet with id ${walletId}`,
                });
                return;
            }
            const walletChain: SupportedChain = isSupportedChain((wallet as any).blockchain)
                ? (wallet as any).blockchain
                : "ethereum";
            const blockchain = getProtocolBlockchainForChain(walletChain);

            // The signing announce needs the group key and cohort shape,
            // which live on the stored key share (not the wallet metadata).
            const keyShare = await km.getKeyShare(walletId);
            if (!keyShare) {
                sendResponse({
                    success: false,
                    error: `No key share for wallet ${walletId} — unlock the wallet first`,
                });
                return;
            }

            // EIP-191 digest for the Ethereum threshold-ECDSA key.
            // ed25519: raw UTF-8 bytes.
            let messageHex: string;
            if (blockchain === "ethereum") {
                const { hashMessage } = await import("viem");
                const hash = hashMessage(userMessage); // "0x..." hex
                messageHex = hash.startsWith("0x") ? hash.slice(2) : hash;
            } else {
                const encoder = new TextEncoder();
                const bytes = encoder.encode(userMessage);
                messageHex = Array.from(bytes, (b) =>
                    b.toString(16).padStart(2, "0"),
                ).join("");
            }

            const result = await this.sessionManager.createSigningSession({
                walletId,
                walletName: (wallet as any).name ?? walletId,
                blockchain,
                keyShare,
                signingMessageHex: messageHex,
            });
            sendResponse(result);
        } catch (err) {
            console.error(
                "[PopupMessageHandler] CREATE_SIGNING_SESSION failed:",
                err,
            );
            sendResponse({
                success: false,
                error: (err as Error).message ?? String(err),
            });
        }
    }

    /**
     * M3 reshare: popup → background "rotate the shares of wallet X"
     * or "replace a lost device". Payload:
     *   {walletId, newThreshold?, removeDeviceIds?: string[]}
     *
     * The wallet's decrypted key share is the source of truth for the
     * CURRENT cohort (participants/threshold/total/group key) — the
     * popup is never trusted to supply cryptographic parameters. The
     * new cohort is the old cohort minus `removeDeviceIds` (the
     * engine's reshare can only redistribute among devices that
     * already hold a share — onboarding a brand-new device needs
     * engine support, see issue follow-up).
     */
    private async handleCreateReshareSessionRequest(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const walletId = message.walletId;
            if (typeof walletId !== "string" || !walletId) {
                sendResponse({ success: false, error: "walletId required" });
                return;
            }
            const removeDeviceIds: string[] = Array.isArray(message.removeDeviceIds)
                ? message.removeDeviceIds.filter((v: unknown) => typeof v === "string")
                : [];

            const { KeystoreManager } = await import(
                "../../services/keystoreManager"
            );
            const km = KeystoreManager.getInstance();
            if (km.isLocked()) {
                sendResponse({
                    success: false,
                    error: "Keystore is locked — unlock before resharing",
                });
                return;
            }
            const keyShare: any = await km.getKeyShare(walletId);
            if (!keyShare) {
                sendResponse({
                    success: false,
                    error: `No key share stored for wallet ${walletId}`,
                });
                return;
            }

            const oldParticipants: string[] = Array.isArray(keyShare.participants)
                ? [...keyShare.participants].sort()
                : [];
            if (oldParticipants.length < 2) {
                sendResponse({
                    success: false,
                    error:
                        "This wallet's record doesn't list its full cohort (e.g. CLI import) — resharing needs the complete device list",
                });
                return;
            }
            const myDeviceId = this.stateManager.getState().deviceId;
            if (!oldParticipants.includes(myDeviceId)) {
                sendResponse({
                    success: false,
                    error: `This device (${myDeviceId}) is not in the wallet's cohort`,
                });
                return;
            }
            if (removeDeviceIds.includes(myDeviceId)) {
                sendResponse({
                    success: false,
                    error: "Cannot remove this device — run the reshare from a device that stays",
                });
                return;
            }
            const unknownRemovals = removeDeviceIds.filter(
                (d) => !oldParticipants.includes(d),
            );
            if (unknownRemovals.length > 0) {
                sendResponse({
                    success: false,
                    error: `Not in the cohort: ${unknownRemovals.join(", ")}`,
                });
                return;
            }

            const newParticipants = oldParticipants.filter(
                (d) => !removeDeviceIds.includes(d),
            );
            const newThreshold = Number.isInteger(message.newThreshold)
                ? Number(message.newThreshold)
                : Math.min(Number(keyShare.threshold) || 2, newParticipants.length);

            const blockchain: "ethereum" | "solana" =
                keyShare.curve === "ed25519" ? "solana" : "ethereum";
            const wallet = km
                .getWallets()
                .find((w: any) => w.id === walletId) as any;

            const result = await this.sessionManager.createReshareSession({
                walletId,
                walletName: wallet?.name ?? walletId,
                groupPublicKey: keyShare.group_public_key ?? "",
                blockchain,
                newThreshold,
                oldParticipants,
                newParticipants,
            });
            sendResponse(result);
        } catch (err) {
            console.error(
                "[PopupMessageHandler] CREATE_RESHARE_SESSION failed:",
                err,
            );
            sendResponse({
                success: false,
                error: (err as Error).message ?? String(err),
            });
        }
    }

    /**
     * M3 reshare: cohort metadata for the popup's Devices/Reshare
     * card. Read-only view over the decrypted key share — no key
     * material leaves the background.
     */
    private async handleGetWalletCohortRequest(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const walletId = message.walletId;
            if (typeof walletId !== "string" || !walletId) {
                sendResponse({ success: false, error: "walletId required" });
                return;
            }
            const { KeystoreManager } = await import(
                "../../services/keystoreManager"
            );
            const km = KeystoreManager.getInstance();
            if (km.isLocked()) {
                sendResponse({ success: false, error: "Keystore is locked" });
                return;
            }
            const keyShare: any = await km.getKeyShare(walletId);
            if (!keyShare) {
                sendResponse({
                    success: false,
                    error: `No key share stored for wallet ${walletId}`,
                });
                return;
            }
            sendResponse({
                success: true,
                cohort: {
                    walletId,
                    deviceId: this.stateManager.getState().deviceId,
                    threshold: keyShare.threshold,
                    total: keyShare.total_participants,
                    participants: Array.isArray(keyShare.participants)
                        ? [...keyShare.participants].sort()
                        : [],
                    curve: keyShare.curve,
                    groupPublicKey: keyShare.group_public_key ?? "",
                },
            });
        } catch (err) {
            sendResponse({
                success: false,
                error: (err as Error).message ?? String(err),
            });
        }
    }

    /**
     * M3 reshare: offscreen requests the decrypted key share of a
     * specific wallet to feed FrostReshare*.init_reshare. Same trust
     * boundary as getActiveKeystore (offscreen is extension-owned).
     */
    private async handleGetWalletKeystoreMessage(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const walletId = message.walletId;
            if (typeof walletId !== "string" || !walletId) {
                sendResponse({ success: false, error: "walletId required" });
                return;
            }
            const keystoreManager = KeystoreManager.getInstance();
            if (keystoreManager.isLocked()) {
                sendResponse({ success: false, error: "Keystore is locked" });
                return;
            }
            const keyShare = await keystoreManager.getKeyShare(walletId);
            if (!keyShare) {
                sendResponse({
                    success: false,
                    error: `No key share for wallet ${walletId}`,
                });
                return;
            }
            // `curve: "secp256k1-ecdsa"` also returns the wallet's
            // threshold-ECDSA share (Ethereum signing).
            if (message.curve === ECDSA_CURVE) {
                const ecdsaShare = await keystoreManager.getCurveShare(walletId, ECDSA_CURVE);
                if (!ecdsaShare) {
                    sendResponse({ success: false, error: `Wallet ${walletId} has no Ethereum (ECDSA) key share` });
                    return;
                }
                sendResponse({ success: true, keyShare, ecdsaShare });
                return;
            }
            sendResponse({ success: true, keyShare });
        } catch (error) {
            sendResponse({
                success: false,
                error: (error as Error).message ?? String(error),
            });
        }
    }

    /**
     * Ext-1d save flow: called from the popup after DKG finished
     * and the user entered a password. Walks through:
     *
     *   1. Validate: we actually have a pendingKeystoreJson in
     *      appState (i.e. DKG did complete recently in this SW
     *      lifetime — session data is intentionally ephemeral so a
     *      SW restart forces the user to redo DKG).
     *   2. Parse the WASM-exported keystore JSON to extract the
     *      key_package (base64), public_key_package, and FROST
     *      indices.
     *   3. If the keystore isn't initialized yet, bootstrap it with
     *      this password (first-ever wallet on this device). If
     *      locked, unlock. If already unlocked, skip.
     *   4. Build a KeyShareData + ExtensionWalletMetadata and call
     *      KeystoreManager.addWallet — that layer does the
     *      PBKDF2+AES-GCM persistence via keystoreService.
     *   5. Clear pendingKeystoreJson + broadcast walletSaved so the
     *      popup can pivot to the wallet-list view.
     */
    private async handleSaveDkgWalletRequest(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const keystoreManager = KeystoreManager.getInstance();
            const hardware = (await keystoreManager.getAuthStatus()).mode === 'hardware';
            const password = message.password;
            if (!hardware && (typeof password !== "string" || password.length < 1)) {
                sendResponse({ success: false, error: "Password required" });
                return;
            }
            if (hardware && keystoreManager.isLocked()) {
                sendResponse({ success: false, error: 'Unlock with your YubiKey before saving this wallet' });
                return;
            }
            const walletName =
                typeof message.walletName === "string" && message.walletName.length > 0
                    ? message.walletName
                    : undefined;

            const state = this.stateManager.getState() as any;
            const pendingJson: string | null = state.pendingKeystoreJson ?? null;
            const lastResult = state.dkgLastResult;
            if (!pendingJson || !lastResult) {
                sendResponse({
                    success: false,
                    error:
                        "No pending DKG keystore to save. Did the ceremony complete in this session?",
                });
                return;
            }

            let keyShareCore: KeyShareCore;
            try {
                keyShareCore = keyShareCoreFromEngine(
                    pendingJson,
                    lastResult.groupPublicKey ?? "",
                    lastResult.participantIdentifiers ?? {},
                );
            } catch (coreErr) {
                sendResponse({
                    success: false,
                    error: `DKG result can't be saved: ${(coreErr as Error).message}`,
                });
                return;
            }

            const curve: "secp256k1" | "ed25519" =
                lastResult.blockchain === "ethereum" ? "secp256k1" : "ed25519";
            const deviceId = state.deviceId;
            const primaryChain: SupportedChain = isSupportedChain(lastResult.chain)
                ? lastResult.chain
                : getDefaultChainForCurve(curve);
            const protocolBlockchain = getProtocolBlockchainForChain(primaryChain);
            // secp256k1: the DKG also made the threshold-ECDSA key (Ethereum).
            const ecdsaShareJson: string | null = state.pendingEcdsaShareJson ?? null;
            const ecdsaGroupPublicKey: string | undefined = state.ecdsaGroupPublicKey || undefined;
            if (curve === "secp256k1" && (!ecdsaShareJson || !ecdsaGroupPublicKey)) {
                sendResponse({
                    success: false,
                    error: "The wallet's Ethereum (ECDSA) key is missing — the DKG didn't finish. Run it again.",
                });
                return;
            }
            const { blockchains, addressFor, primaryAddress } = await this.deriveWalletAddresses(
                curve,
                lastResult.groupPublicKey ?? "",
                primaryChain,
                lastResult.address ?? undefined,
                curve === "secp256k1" ? ecdsaGroupPublicKey : undefined,
            );

            const keyShareData: KeyShareData = {
                ...(curve === "secp256k1" ? { ecdsa_group_public_key: ecdsaGroupPublicKey } : {}),
                // Canonical FROST material: engine keystore fields +
                // hex group key + explicit device→FROST-id map.
                ...keyShareCore,
                // Session context
                session_id: lastResult.sessionId ?? "",
                device_id: deviceId,
                blockchains,
                ethereum_address: addressFor("ethereum"),
                solana_address: addressFor("solana"),
                created_at: Date.now(),
            };

            // Same id every other participant (CLI/TUI too) derives from
            // the shared session id — announces name the wallet by it.
            const walletId = walletIdFromSession(keyShareData.session_id);
            const metadata: any = {
                id: walletId,
                name:
                    walletName ??
                    `${lastResult.threshold}-of-${lastResult.total} ${curve}`,
                blockchain: primaryChain,
                address: primaryAddress,
                session_id: keyShareData.session_id,
                isActive: true,
                hasBackup: false,
            };

            // Ensure the keystore is ready. Create on first wallet,
            // unlock on subsequent saves. The SAME password is used
            // for both the keystore master password AND per-wallet
            // encryption — matches the existing UX where there's
            // only one user-visible password in password mode. Hardware
            // mode already holds its random vault secret in the service.
            const km = keystoreManager;
            const isInit = await km.isInitialized();
            if (!isInit) {
                console.log(
                    "[PopupMessageHandler] First wallet on this device — bootstrapping keystore",
                );
                await km.createKeystore(password, deviceId);
            } else if (km.isLocked()) {
                console.log(
                    "[PopupMessageHandler] Keystore locked — unlocking with supplied password",
                );
                const unlocked = await km.unlock(password);
                if (!unlocked) {
                    sendResponse({
                        success: false,
                        error: "Wrong password for existing keystore",
                    });
                    return;
                }
            }

            const added = await km.addWallet(walletId, keyShareData, metadata);
            if (!added) {
                sendResponse({
                    success: false,
                    error: "addWallet returned false — keystore may be locked or write failed",
                });
                return;
            }
            if (curve === "secp256k1" && ecdsaShareJson) {
                // The ECDSA share: its own curve entry, same password.
                await km.setCurveShare(walletId, ECDSA_CURVE, ecdsaShareJson);
            }

            // Save succeeded. Drop the in-memory key material + flip
            // UI state so popup moves to a "wallet ready" view. The DKG
            // session is over too — clearing it re-enables "Sign message",
            // which is hidden while a session is active.
            this.stateManager.updateState({
                // @ts-ignore — off-type fields, same pattern as elsewhere
                pendingKeystoreJson: null,
                pendingKeystoreReady: false,
                pendingEcdsaShareJson: null,
                sessionInfo: null,
            } as any);
            syncEcdsaPrimes();
            // updateState doesn't notify the popup; without this the save
            // form stays up after a successful save.
            this.stateManager.broadcastCurrentState();

            console.log(
                `[PopupMessageHandler] ✅ Wallet saved: ${walletId} (${metadata.name})`,
            );
            sendResponse({
                success: true,
                walletId,
                walletName: metadata.name,
            });
        } catch (err) {
            console.error("[PopupMessageHandler] SAVE_DKG_WALLET failed:", err);
            sendResponse({
                success: false,
                error: (err as Error).message ?? String(err),
            });
        }
    }

    /**
     * Account-0 addresses of a wallet (public derivation in the offscreen
     * wasm) as the stored `blockchains` entries, plus the primary address.
     */
    private async deriveWalletAddresses(
        curve: "secp256k1" | "ed25519",
        groupPublicKey: string,
        primaryChain: SupportedChain,
        fallbackAddress?: string,
        /** secp256k1 wallets: the threshold-ECDSA root key (Ethereum accounts). */
        ecdsaGroupPublicKey?: string,
    ): Promise<{ blockchains: any[]; addressFor: (chain: SupportedChain) => string | undefined; primaryAddress: string }> {
        const chainIds: Partial<Record<SupportedChain, number>> = {
            ethereum: 1,
            polygon: 137,
            arbitrum: 42161,
            optimism: 10,
            base: 8453,
        };
        const addressFormats: Partial<Record<SupportedChain, string>> = {
            ethereum: "EIP-55",
            polygon: "EIP-55",
            arbitrum: "EIP-55",
            optimism: "EIP-55",
            base: "EIP-55",
            bitcoin: "bech32",
            solana: "base58",
            sui: "hex",
        };
        let derivedAddresses: Array<{ chain: SupportedChain; path: string; address: string; curve: string }> = [];
        try {
            // Ethereum comes from the ECDSA key; the FROST key covers the rest.
            const keys: Array<[string, string]> = [];
            if (ecdsaGroupPublicKey) keys.push([ECDSA_CURVE, ecdsaGroupPublicKey]);
            if (groupPublicKey) keys.push([curve, groupPublicKey]);
            for (const [keyCurve, key] of keys) {
                const derived = await this.offscreenManager.sendToOffscreen(
                    {
                        type: "deriveAccounts",
                        curve: keyCurve,
                        groupPublicKey: key,
                        count: 1,
                    } as any,
                    "Derive wallet account 0 addresses",
                );
                if (derived?.success && Array.isArray(derived.accounts?.[0]?.addresses)) {
                    derivedAddresses.push(
                        ...derived.accounts[0].addresses
                            .map((addr: any) => {
                                const chain = normalizeDerivedAddressChain(addr.chain);
                                return chain && typeof addr.address === "string"
                                    ? { chain, path: String(addr.path ?? ""), address: addr.address, curve: keyCurve }
                                    : null;
                            })
                            .filter(Boolean),
                    );
                }
            }
        } catch (deriveErr) {
            console.warn(
                "[PopupMessageHandler] Failed to derive multi-chain addresses while saving wallet:",
                deriveErr,
            );
        }
        const addressFor = (chain: SupportedChain): string | undefined => {
            const exact = derivedAddresses.find((addr) => addr.chain === chain)?.address;
            if (exact) return exact;
            const protocol = getProtocolBlockchainForChain(chain);
            return derivedAddresses.find((addr) => addr.chain === protocol)?.address;
        };
        const primaryAddress =
            addressFor(primaryChain) ??
            fallbackAddress ??
            // e.g. a secp256k1 share imported without its Ethereum (ECDSA)
            // file: show the Bitcoin address rather than none.
            derivedAddresses[0]?.address ??
            "";
        const blockchainEntries = new Map<string, any>();
        const addBlockchainEntry = (
            chain: SupportedChain,
            address: string | undefined,
            enabled = chain === primaryChain,
            path = "",
            keyCurve: string = curve,
        ) => {
            if (!address) return;
            blockchainEntries.set(chain, {
                blockchain: chain,
                network: "mainnet",
                ...(chainIds[chain] ? { chain_id: chainIds[chain] } : {}),
                address,
                address_format: addressFormats[chain] ?? "unknown",
                enabled,
                metadata: {
                    curve: keyCurve,
                    label: getChainLabel(chain),
                    derivation_path: path,
                },
            });
        };
        for (const addr of derivedAddresses) {
            addBlockchainEntry(addr.chain, addr.address, addr.chain === primaryChain, addr.path, addr.curve);
        }
        if (!blockchainEntries.has(primaryChain)) addBlockchainEntry(primaryChain, primaryAddress, true);
        return { blockchains: Array.from(blockchainEntries.values()), addressFor, primaryAddress };
    }

    private async handleAcceptSessionRequest(message: any, sendResponse: (response: any) => void): Promise<void> {
        if ('session_id' in message && 'accepted' in message) {
            console.log("[PopupMessageHandler] Session acceptance:", message.session_id, message.accepted);
            
            // Log current state for debugging
            const currentInvites = this.stateManager.getInvites();
            const currentSessionInfo = this.stateManager.getSessionInfo();
            console.log("[PopupMessageHandler] Current invites:", currentInvites);
            console.log("[PopupMessageHandler] Current sessionInfo:", currentSessionInfo);

            if (message.accepted) {
                const blockchain = message.blockchain || "solana";
                const result = await this.sessionManager.acceptSession(message.session_id, blockchain);
                sendResponse(result);
            } else {
                // Handle session decline
                const invites = this.stateManager.getInvites();
                const sessionIndex = invites.findIndex(inv => inv.session_id === message.session_id);

                if (sessionIndex !== -1) {
                    invites.splice(sessionIndex, 1);
                    this.stateManager.updateInvites(invites);
                    sendResponse({ success: true });
                } else {
                    sendResponse({ success: false, error: "Session not found in invites" });
                }
            }
        } else {
            sendResponse({ success: false, error: "Invalid session acceptance" });
        }
    }

    private async handleSendDirectMessageRequest(message: any, sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Received sendDirectMessage request:", redactForLog(message));

        if ('todeviceId' in message && 'message' in message &&
            typeof message.todeviceId === 'string' && typeof message.message === 'string') {

            const result = await this.offscreenManager.sendToOffscreen({
                type: "sendDirectMessage",
                todeviceId: message.todeviceId,
                message: message.message
            }, "sendDirectMessage");

            if (result.success) {
                sendResponse({ success: true, message: "Direct message sent to offscreen" });
            } else {
                sendResponse({ success: false, error: `Failed to send to offscreen: ${result.error}` });
            }
        } else {
            sendResponse({ success: false, error: "Missing or invalid todeviceId or message" });
        }
    }

    private async handleGetWebRTCStatusRequest(sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Received getWebRTCStatus request");

        const result = await this.offscreenManager.sendToOffscreen({
            type: "getWebRTCStatus"
        }, "getWebRTCStatus");

        if (result.success) {
            sendResponse({ success: true, message: "WebRTC status request sent to offscreen" });
        } else {
            sendResponse({ success: false, error: `Failed to get WebRTC status: ${result.error}` });
        }
    }

    private async handleSetBlockchainRequest(message: any, sendResponse: (response: any) => void): Promise<void> {
        if ('blockchain' in message) {
            if (!isSupportedChain(message.blockchain)) {
                sendResponse({
                    success: false,
                    error: `Unsupported chain: ${String(message.blockchain)}`,
                });
                return;
            }
            console.log("[PopupMessageHandler] Setting blockchain selection:", message.blockchain);
            this.stateManager.setBlockchain(message.blockchain);
            const net = NetworkService.getInstance();
            await net.ensureInitialized();
            await net.setCurrentChain(message.blockchain);
            sendResponse({
                success: true,
                blockchain: this.stateManager.getBlockchain(),
                chain: this.stateManager.getChain(),
            });
        } else {
            sendResponse({ success: false, error: "Missing blockchain parameter" });
        }
    }

    private async handleGetEthereumAddressRequest(sendResponse: (response: any) => void): Promise<void> {
        try {
            const ethResult = await this.offscreenManager.sendToOffscreen({
                type: "getEthereumAddress"
            }, "getEthereumAddress");
            
            // Store address in chrome.storage.local for content script access
            if (ethResult.success && ethResult.data?.ethereumAddress) {
                chrome.storage.local.set({ 
                    'mpc_ethereum_address': ethResult.data.ethereumAddress 
                }, () => {
                    console.log("[PopupMessageHandler] Stored Ethereum address in chrome.storage.local");
                });
                sendResponse(ethResult);
            } else {
                // If no address from offscreen, check if we have a stored address
                chrome.storage.local.get(['mpc_ethereum_address'], (result) => {
                    if (result && result.mpc_ethereum_address) {
                        console.log("[PopupMessageHandler] Using stored Ethereum address:", result.mpc_ethereum_address);
                        sendResponse({
                            success: true,
                            data: { ethereumAddress: result.mpc_ethereum_address }
                        });
                    } else {
                        console.log("[PopupMessageHandler] No Ethereum address available (DKG not complete)");
                        sendResponse({
                            success: false,
                            error: "No Ethereum address available. Please complete DKG setup first."
                        });
                    }
                });
            }
        } catch (error) {
            console.error("[PopupMessageHandler] Error getting Ethereum address:", error);
            sendResponse({ success: false, error: `Error getting Ethereum address: ${(error as Error).message}` });
        }
    }

    private async handleGetSolanaAddressRequest(sendResponse: (response: any) => void): Promise<void> {
        try {
            const solResult = await this.offscreenManager.sendToOffscreen({
                type: "getSolanaAddress"
            }, "getSolanaAddress");
            
            // Store address in chrome.storage.local for content script access
            if (solResult.success && solResult.data?.solanaAddress) {
                chrome.storage.local.set({ 
                    'mpc_solana_address': solResult.data.solanaAddress 
                }, () => {
                    console.log("[PopupMessageHandler] Stored Solana address in chrome.storage.local");
                });
            }
            
            sendResponse(solResult);
        } catch (error) {
            console.error("[PopupMessageHandler] Error getting Solana address:", error);
            sendResponse({ success: false, error: `Error getting Solana address: ${(error as Error).message}` });
        }
    }

    private async handleRpcMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        try {
            // Always reset: an origin-less (internal) request must never
            // inherit the previous dApp's origin, and vice versa.
            this.rpcHandler.setOrigin(typeof message.origin === "string" ? message.origin : "");

            const result = await this.rpcHandler.handleRpcRequest(message.payload);
            sendResponse({ success: true, result });
        } catch (error) {
            console.error("[PopupMessageHandler] RPC request failed:", error);
            const text = error instanceof Error ? error.message : String(error);
            const code = (error as { code?: unknown } | null)?.code;
            // Keep EIP-1193 codes (4001 user rejected, …) so the page sees them.
            sendResponse({
                success: false,
                error: typeof code === "number" ? { code, message: text } : text,
            });
        }
    }

    private async handleUIRequestMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        const result = await this.uiRequestHandler.handleUIRequest(message.payload);
        sendResponse(result);
    }

    private async handleRequestSigningMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Received requestSigning:", redactForLog(message));

        if ('signingId' in message && 'transactionData' in message && 'requiredSigners' in message) {
            // Forward signing request to offscreen document
            const result = await this.offscreenManager.sendToOffscreen({
                type: "requestSigning",
                signingId: message.signingId,
                transactionData: message.transactionData,
                requiredSigners: message.requiredSigners
            }, "requestSigning");

            if (result.success) {
                sendResponse({ success: true, message: "Signing request sent to offscreen" });
            } else {
                sendResponse({ success: false, error: `Failed to send signing request: ${result.error}` });
            }
        } else {
            sendResponse({ success: false, error: "Invalid signing request format" });
        }
    }

    /**
     * Import a key-share file — the engine's v2 share file, written by the
     * TUI / desktop / CLI or by our own export. The file's password decrypts
     * it and becomes the keystore password on a fresh profile (same UX as
     * saving a DKG wallet). The wallet is added and made active; no session
     * is created.
     */
    /** `ecdsa_share_info` of a share JSON (wasm lives in the offscreen document). */
    private async ecdsaShareInfo(shareJson: string): Promise<EcdsaShareInfo> {
        await this.offscreenManager.createOffscreenDocument();
        const res = await this.offscreenManager.sendToOffscreen({ type: "ecdsaShareInfo", shareJson } as any, "ecdsaShareInfo");
        if (!res?.success) throw new Error(`Not a valid ECDSA key share: ${res?.error ?? "no offscreen response"}`);
        return res.info as EcdsaShareInfo;
    }

    /**
     * Import a wallet backup: one engine share file, or a wallet's files
     * (`keystoreFiles`: one per curve — the FROST share plus, for a
     * secp256k1 wallet, its Ethereum `secp256k1-ecdsa` share). An ECDSA
     * file attaches to its wallet (imported first, or already here).
     */
    private async handleImportKeystoreMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        try {
            const files: string[] = Array.isArray(message.keystoreFiles)
                ? message.keystoreFiles.filter((f: unknown): f is string => typeof f === "string")
                : typeof message.keystoreData === "string"
                  ? [message.keystoreData]
                  : [];
            if (files.length === 0 || typeof message.password !== "string") {
                sendResponse({ success: false, error: "Missing key share file or password" });
                return;
            }
            const frost = files.filter((f) => shareBackupCurve(f) !== ECDSA_CURVE);
            const ecdsa = files.filter((f) => shareBackupCurve(f) === ECDSA_CURVE);
            if (frost.length > 1) {
                sendResponse({ success: false, error: "Import one wallet at a time" });
                return;
            }
            let result: any = { success: true };
            if (frost.length === 1) {
                result = await new Promise<any>((resolve) =>
                    this.importFrostShareFile(frost[0], message.password, message.chain, resolve),
                );
                if (!result.success) {
                    sendResponse(result);
                    return;
                }
            }
            for (const file of ecdsa) {
                const attached = await this.importEcdsaShareFile(file, message.password, message.chain);
                result = { ...result, walletId: attached.walletId, address: attached.address ?? result.address };
            }
            await checkAndRestoreKeystores();
            syncEcdsaPrimes();
            sendResponse(result);
        } catch (error) {
            console.error("[PopupMessageHandler] Error importing keystore:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /** Attach an ECDSA share file to its (FROST) wallet in this keystore. */
    private async importEcdsaShareFile(fileJson: string, password: string, requestedChain?: unknown): Promise<{ walletId: string; address?: string }> {
        const { metadata, shareJson } = await openEcdsaShareBackup(fileJson, password);
        const info = await this.ecdsaShareInfo(shareJson);
        if (info.group_public_key.toLowerCase() !== String(metadata.group_public_key).toLowerCase()) {
            throw new Error("ECDSA key share does not match the file's group public key");
        }
        const km = KeystoreManager.getInstance();
        if (km.isLocked() && !(await km.unlock(password))) {
            throw new Error("Unlock the wallet first (the file's password doesn't open this keystore)");
        }
        const walletId = metadata.session_id;
        const keyShare = await km.getKeyShare(walletId);
        const wallet = km.getWallets().find((w) => w.id === walletId);
        if (!keyShare || !wallet) {
            throw new Error(`Import wallet ${walletId}'s main share file first (or together with this one)`);
        }
        if (keyShare.curve !== "secp256k1") throw new Error(`Wallet ${walletId} is not a secp256k1 wallet`);
        if (keyShare.ecdsa_group_public_key && keyShare.ecdsa_group_public_key !== info.group_public_key) {
            throw new Error(`Wallet ${walletId} already has a different Ethereum key`);
        }
        await km.setCurveShare(walletId, ECDSA_CURVE, shareJson);
        const primaryChain: SupportedChain = isSupportedChain(requestedChain) &&
            (isEcdsaChain(requestedChain) || getRequiredCurve(requestedChain) === keyShare.curve)
            ? requestedChain
            : isSupportedChain(wallet.blockchain) ? wallet.blockchain : "ethereum";
        const { blockchains, addressFor, primaryAddress } = await this.deriveWalletAddresses(
            "secp256k1",
            keyShare.group_public_key,
            primaryChain,
            undefined,
            info.group_public_key,
        );
        await km.updateWalletKeyShare(walletId, {
            ...keyShare,
            ecdsa_group_public_key: info.group_public_key,
            blockchains,
            ethereum_address: addressFor("ethereum"),
        });
        await km.updateWalletAddress(walletId, primaryAddress, primaryChain);
        return { walletId, address: primaryAddress };
    }

    private async importFrostShareFile(
        keystoreData: string,
        password: string,
        chain: unknown,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        const message = { keystoreData, password, chain };
        try {
            const { metadata, keyShare } = await openShareBackup(message.keystoreData, message.password);

            const km = KeystoreManager.getInstance();
            if (!(await km.isInitialized())) {
                await km.createKeystore(message.password, this.stateManager.getState().deviceId);
            } else if (km.isLocked() && !(await km.unlock(message.password))) {
                sendResponse({ success: false, error: "Unlock the wallet first (the file's password doesn't open this keystore)" });
                return;
            }
            if (km.getWallets().some((w) => w.id === metadata.session_id)) {
                sendResponse({ success: false, error: `Wallet ${metadata.session_id} is already in this keystore` });
                return;
            }

            const curve = keyShare.curve;
            const primaryChain: SupportedChain =
                isSupportedChain(message.chain) && getRequiredCurve(message.chain) === curve
                    ? message.chain
                    : getDefaultChainForCurve(curve);
            const { blockchains, addressFor, primaryAddress } = await this.deriveWalletAddresses(
                curve,
                keyShare.group_public_key,
                primaryChain,
            );
            const keyShareData: KeyShareData = {
                ...keyShare,
                blockchains,
                ethereum_address: addressFor("ethereum"),
                solana_address: addressFor("solana"),
                created_at: Date.parse(metadata.created_at) || Date.now(),
            };
            const added = await km.addWallet(metadata.session_id, keyShareData, {
                id: metadata.session_id,
                name: metadata.label ?? metadata.session_id,
                blockchain: primaryChain,
                address: primaryAddress,
                session_id: metadata.session_id,
                isActive: true,
                hasBackup: true,
            });
            if (!added) {
                sendResponse({ success: false, error: "Saving the imported wallet failed" });
                return;
            }
            await km.setActiveWallet(metadata.session_id);
            await checkAndRestoreKeystores();
            sendResponse({ success: true, walletId: metadata.session_id, address: primaryAddress });
        } catch (error) {
            console.error("[PopupMessageHandler] Error importing keystore:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Export this device's key share of the active wallet as an encrypted
     * backup file. Reads the stored keystore — no session, DKG state or
     * loaded FROST instance needed; only an unlocked keystore with a wallet.
     */
    private async handleExportKeystoreMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        try {
            const keystoreManager = KeystoreManager.getInstance();
            if (keystoreManager.isLocked()) {
                sendResponse({ success: false, error: "Unlock the wallet to export a backup" });
                return;
            }
            const wallet = keystoreManager.getActiveWallet();
            if (!wallet) {
                sendResponse({ success: false, error: "No wallet to export" });
                return;
            }
            if (typeof message.password !== "string" || message.password.length < 8) {
                sendResponse({ success: false, error: "Backup password must be at least 8 characters" });
                return;
            }
            if ((await keystoreManager.getAuthStatus()).mode === 'hardware') {
                keystoreManager.assertHardwareExportAuthorized();
            }
            const keyShare = await keystoreManager.getKeyShare(wallet.id);
            if (!keyShare) {
                sendResponse({ success: false, error: `No key share stored for wallet ${wallet.id}` });
                return;
            }
            const keystoreData = await encryptShareBackup(keyShare, wallet, message.password);
            // One file per curve, like the engine's export: a secp256k1
            // wallet's Ethereum (ECDSA) share is its own file.
            const files: { curve: string; keystoreData: string }[] = [{ curve: keyShare.curve, keystoreData }];
            const ecdsaShare = await keystoreManager.getCurveShare(wallet.id, ECDSA_CURVE);
            if (ecdsaShare) {
                const info = await this.ecdsaShareInfo(ecdsaShare);
                files.push({
                    curve: ECDSA_CURVE,
                    keystoreData: await encryptEcdsaShareBackup(
                        ecdsaShare,
                        info,
                        { id: wallet.id, name: wallet.name, deviceId: keyShare.device_id, createdAt: keyShare.created_at },
                        message.password,
                    ),
                });
            }
            sendResponse({ success: true, keystoreData, files });
        } catch (error) {
            console.error("[PopupMessageHandler] Error exporting keystore:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Handle unlock keystore request
     */
    private async handleUnlockKeystoreMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Processing unlock keystore request");
        
        try {
            if (!message.password) {
                sendResponse({ success: false, error: "Password required" });
                return;
            }
            
            const keystoreManager = KeystoreManager.getInstance();
            const success = await keystoreManager.unlock(message.password, message.rememberDuration);
            
            if (success) {
                // Get active wallet info
                const activeWallet = keystoreManager.getActiveWallet();
                sendResponse({ 
                    success: true, 
                    activeWallet,
                    wallets: keystoreManager.getWallets()
                });
                
                // Restore wallet state if available
                await checkAndRestoreKeystores();
                // The password is here: prepare the next wallet's ECDSA primes.
                syncEcdsaPrimes();
            } else {
                sendResponse({ success: false, error: "Invalid password" });
            }
        } catch (error) {
            console.error("[PopupMessageHandler] Error unlocking keystore:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Handle lock keystore request
     */
    private async handleLockKeystoreMessage(sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Processing lock keystore request");
        
        try {
            const keystoreManager = KeystoreManager.getInstance();
            await keystoreManager.lock();
            
            // Clear sensitive state. ethereumAddress/solanaAddress
            // are typed `string | undefined`, not nullable — use
            // undefined to match (effect is the same at runtime).
            this.stateManager.updateStateProperty('dkgState', DkgState.Idle);
            this.stateManager.updateStateProperty('sessionInfo', null);
            this.stateManager.updateStateProperty('ethereumAddress', undefined);
            this.stateManager.updateStateProperty('solanaAddress', undefined);
            
            sendResponse({ success: true });
        } catch (error) {
            console.error("[PopupMessageHandler] Error locking keystore:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Handle create keystore request
     */
    private async handleCreateKeystoreMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Processing create keystore request");
        
        try {
            if (!message.password) {
                sendResponse({ success: false, error: "Password required" });
                return;
            }
            
            const keystoreManager = KeystoreManager.getInstance();
            const deviceId = this.stateManager.getState().deviceId;
            
            const created = await keystoreManager.createKeystore(message.password, deviceId);
            if (!created) throw new Error('Could not create the vault. Check the unlock method and try again.');
            // Onboarding done: start on the ECDSA primes a first wallet needs.
            syncEcdsaPrimes();

            sendResponse({ success: true });
        } catch (error) {
            console.error("[PopupMessageHandler] Error creating keystore:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Handle get keystore status request
     */
    private async handleGetKeystoreStatusMessage(sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Processing get keystore status request");
        
        try {
            const keystoreManager = KeystoreManager.getInstance();
            
            const status = {
                initialized: await keystoreManager.isInitialized(),
                authMode: (await keystoreManager.getAuthStatus()).mode,
                locked: keystoreManager.isLocked(),
                wallets: keystoreManager.getWallets(),
                activeWallet: keystoreManager.getActiveWallet()
            };
            
            sendResponse({ success: true, status });
        } catch (error) {
            console.error("[PopupMessageHandler] Error getting keystore status:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Handle switch wallet request
     */
    private async handleSwitchWalletMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Processing switch wallet request");
        
        try {
            if (!message.walletId) {
                sendResponse({ success: false, error: "Wallet ID required" });
                return;
            }
            
            const keystoreManager = KeystoreManager.getInstance();
            
            if (keystoreManager.isLocked()) {
                sendResponse({ success: false, error: "Keystore is locked" });
                return;
            }
            
            const success = await keystoreManager.setActiveWallet(message.walletId);
            
            if (success) {
                // Restore the new active wallet
                await checkAndRestoreKeystores();
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, error: "Failed to switch wallet" });
            }
        } catch (error) {
            console.error("[PopupMessageHandler] Error switching wallet:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Handle migrate keystores request
     */
    private async handleMigrateKeystoresMessage(message: any, sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Processing migrate keystores request");
        
        try {
            if (!message.password) {
                sendResponse({ success: false, error: "Password required" });
                return;
            }
            
            const keystoreManager = KeystoreManager.getInstance();
            const migratedCount = await keystoreManager.migrateFromChromeStorage(message.password);
            
            sendResponse({ 
                success: true, 
                migratedCount,
                wallets: keystoreManager.getWallets()
            });
            
            // Restore wallet state after migration
            if (migratedCount > 0) {
                await checkAndRestoreKeystores();
            }
        } catch (error) {
            console.error("[PopupMessageHandler] Error migrating keystores:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }
    
    /**
     * Handle get active keystore request
     */
    private async handleGetActiveKeystoreMessage(sendResponse: (response: any) => void): Promise<void> {
        console.log("[PopupMessageHandler] Processing get active keystore request");
        
        try {
            const keystoreManager = KeystoreManager.getInstance();
            
            if (keystoreManager.isLocked()) {
                sendResponse({ success: false, error: "Keystore is locked" });
                return;
            }
            
            const activeWallet = keystoreManager.getActiveWallet();
            if (!activeWallet) {
                sendResponse({ success: false, error: "No active wallet" });
                return;
            }
            
            const keyShare = await keystoreManager.getKeyShare(activeWallet.id);
            if (!keyShare) {
                sendResponse({ success: false, error: "Failed to get key share" });
                return;
            }
            
            sendResponse({ success: true, keyShare });
        } catch (error) {
            console.error("[PopupMessageHandler] Error getting active keystore:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Portfolio for the popup: native + ERC-20 balances joined with fiat for the
     * given (or current) EVM account/network. Best-effort — returns an error
     * shape the popup can render instead of throwing.
     */
    private async handleGetPortfolioMessage(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const net = NetworkService.getInstance();
            await net.ensureInitialized();
            const account: string =
                message?.address ||
                AccountService.getInstance().getCurrentAccount()?.address;
            if (!account) {
                sendResponse({ success: false, error: "No account selected" });
                return;
            }
            const requestedChain: SupportedChain = isSupportedChain(message?.chain)
                ? message.chain
                : this.stateManager.getChain();
            if (!isEvmChain(requestedChain)) {
                sendResponse({
                    success: false,
                    error: `${getChainLabel(requestedChain)} balances are not wired yet`,
                });
                return;
            }
            const network = net.getCurrentNetworkForChain(requestedChain);
            const chainId = network?.id;
            if (!chainId) {
                sendResponse({ success: false, error: "No EVM network selected" });
                return;
            }
            const client = net.getPublicClient(network);
            const symbol = (network as any)?.nativeCurrency?.symbol ?? "ETH";
            const portfolio = await handleGetPortfolio(account, chainId, client, symbol);
            sendResponse({ success: true, portfolio });
        } catch (error) {
            console.error("[PopupMessageHandler] getPortfolio failed:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /** Activity feed for the given (or current) account, optional chain filter. */
    private async handleGetActivityMessage(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const account: string =
                message?.address ||
                AccountService.getInstance().getCurrentAccount()?.address;
            if (!account) {
                sendResponse({ success: false, error: "No account selected" });
                return;
            }
            let chainId = message?.chainId;
            if (!chainId && isSupportedChain(message?.chain) && isEvmChain(message.chain)) {
                const net = NetworkService.getInstance();
                await net.ensureInitialized();
                chainId = net.getCurrentNetworkForChain(message.chain)?.id;
            }
            const activity = await handleGetActivity(account, chainId);
            sendResponse({ success: true, activity });
        } catch (error) {
            console.error("[PopupMessageHandler] getActivity failed:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }

    /**
     * Record a broadcast send as pending activity (#11) — the popup
     * SendForm path. The dApp path records inside RpcHandler at broadcast
     * time; this covers sends the popup initiated, keyed to the account it
     * actually signed with (BIP-44 account 0 / displayAddress).
     */
    private async handleRecordActivityMessage(
        message: any,
        sendResponse: (response: any) => void,
    ): Promise<void> {
        try {
            const account: string =
                message?.address ||
                AccountService.getInstance().getCurrentAccount()?.address;
            if (!account) {
                sendResponse({ success: false, error: "No account selected" });
                return;
            }
            const entry = await handleRecordActivity(account, message?.activity);
            sendResponse({ success: true, activity: entry });
        } catch (error) {
            console.error("[PopupMessageHandler] recordActivity failed:", error);
            sendResponse({ success: false, error: (error as Error).message });
        }
    }
}

/**
 * Handles messages from offscreen document
 */
export class OffscreenMessageHandler {
    private stateManager: StateManager;
    private webSocketManager: WebSocketManager;

    constructor(
        stateManager: StateManager,
        webSocketManager: WebSocketManager
    ) {
        this.stateManager = stateManager;
        this.webSocketManager = webSocketManager;
    }

    /**
     * Handle messages from offscreen document
     */
    async handleOffscreenMessage(payload: OffscreenToBackgroundMessage): Promise<void> {
        console.log("[OffscreenMessageHandler] Handling offscreen message:", redactForLog(payload));

        switch (payload.type) {
            case "relayViaWs":
                await this.handleRelayViaWebSocket(payload);
                break;

            case "log":
                this.handleLogMessage(payload);
                break;

            // NOTE: signingComplete, dkgComplete and dkgStateUpdate are
            // INTENTIONALLY not matched here. The corresponding stateManager
            // handler (StateManager.handleOffscreenStateUpdate, via
            // the default branch below) is the canonical path — it
            // stashes pendingKeystoreJson + broadcasts to popup for
            // the Ext-1d save-wallet flow. The local
            // handleDkgComplete / handleDkgStateUpdate methods in
            // this file are legacy dead code that reads a stale
            // payload shape (payload.payload.keyShareData) not
            // emitted by the current webrtc.ts. Kept as private
            // methods for reference but not dispatched to.

            // Threshold-ECDSA safe primes (offscreen PrimePool ↔ encrypted cache).
            case "ecdsaPrimesProgress" as any:
                EcdsaPrimeCache.instance?.onProgress((payload as any).progress);
                this.stateManager.broadcastCurrentState();
                break;
            case "ecdsaPrimesReady" as any:
                await EcdsaPrimeCache.instance?.onReady((payload as any).primesJson);
                break;
            case "ecdsaPrimesConsumed" as any:
                await EcdsaPrimeCache.instance?.onConsumed();
                break;
            case "ecdsaDkgStatus" as any:
                this.stateManager.updateState({ ecdsaDkgStatus: (payload as any).status });
                this.stateManager.broadcastCurrentState();
                break;

            default:
                // Forward to state manager for state updates
                this.stateManager.handleOffscreenStateUpdate(payload);
                break;
        }
    }

    private async handleRelayViaWebSocket(payload: any): Promise<void> {
        // Handle nested payload structure - the actual data is in payload.payload
        const relayData = payload.payload || payload;

        // Enhanced debugging for WebSocket relay issues
        const hasTo = 'to' in relayData;
        const hasData = 'data' in relayData;
        const wsReady = this.webSocketManager.isReady();
        const wsState = this.webSocketManager.getConnectionStatus();

        console.log("[OffscreenMessageHandler] WebSocket relay check:", {
            hasTo,
            hasData,
            wsReady,
            wsState,
            originalPayloadKeys: Object.keys(payload),
            relayDataKeys: Object.keys(relayData),
            relayData: relayData
        });

        if (hasTo && hasData && wsReady) {
            try {
                console.log("[OffscreenMessageHandler] Attempting to relay WebSocket message:", {
                    to: relayData.to,
                    dataType: relayData.data?.websocket_msg_type,
                    data: relayData.data
                });
                await this.webSocketManager.relayMessage(relayData.to as string, relayData.data);
                console.log("[OffscreenMessageHandler] WebSocket relay successful");
            } catch (error) {
                console.error("[OffscreenMessageHandler] Error relaying via WebSocket:", error);
            }
        } else {
            const issues = [];
            if (!hasTo) issues.push("missing 'to' property");
            if (!hasData) issues.push("missing 'data' property");
            if (!wsReady) issues.push(`WebSocket not ready (state: ${wsState.readyState})`);

            console.warn("[OffscreenMessageHandler] Cannot relay message:", issues.join(", "));
            console.warn("[OffscreenMessageHandler] Full payload structure:", JSON.stringify(payload, null, 2));
        }
    }

    private handleLogMessage(payload: any): void {
        if ('payload' in payload && payload.payload && payload.payload.message) {
            const source = payload.payload.source || 'offscreen';
            console.log(`📄 [OffscreenMessageHandler] LOG from ${source}: ${payload.payload.message}`);
        } else {
            console.log("[OffscreenMessageHandler] LOG:", redactForLog(payload));
        }
    }

    private async handleDkgComplete(payload: any): Promise<void> {
        console.log("[OffscreenMessageHandler] DKG complete:", redactForLog(payload));
        
        // Update DKG state to Complete
        this.stateManager.updateStateProperty('dkgState', DkgState.Complete);
        
        if (payload.payload && payload.payload.keyShareData) {
            const keyShareData = payload.payload.keyShareData;
            const sessionId = keyShareData.session_id;
            
            // Get the appropriate address based on blockchain
            const address = keyShareData.curve === 'secp256k1' 
                ? keyShareData.ethereum_address 
                : keyShareData.solana_address;
            
            // Store addresses in chrome.storage.local for immediate access
            if (keyShareData.ethereum_address) {
                chrome.storage.local.set({ 
                    'mpc_ethereum_address': keyShareData.ethereum_address 
                }, () => {
                    console.log("[OffscreenMessageHandler] Stored Ethereum address in chrome.storage.local:", keyShareData.ethereum_address);
                });
            }
            
            if (keyShareData.solana_address) {
                chrome.storage.local.set({ 
                    'mpc_solana_address': keyShareData.solana_address 
                }, () => {
                    console.log("[OffscreenMessageHandler] Stored Solana address in chrome.storage.local:", keyShareData.solana_address);
                });
            }
            
            if (address && sessionId) {
                try {
                    // Complete account creation
                    const accountService = AccountService.getInstance();
                    const newAccount = await accountService.completeAccountCreation(
                        sessionId,
                        address,
                        keyShareData
                    );
                    
                    if (newAccount) {
                        console.log("[OffscreenMessageHandler] Account created for session:", sessionId);
                        
                        // Notify popup to refresh accounts
                        this.stateManager.broadcastToPopupPorts({
                            type: 'accountsUpdated',
                            blockchain: getProtocolBlockchainForChain(newAccount.blockchain),
                            accounts: accountService.getAccountsByBlockchain(newAccount.blockchain)
                        });
                    } else {
                        console.warn("[OffscreenMessageHandler] Account creation returned null, but DKG is still complete");
                    }
                } catch (error) {
                    console.error("[OffscreenMessageHandler] Error during account creation:", error);
                    // Even if account creation fails, DKG is still complete
                    // The user can still use the wallet for signing
                }
            }
        }
        
        // Ensure DKG state remains Complete regardless of account creation outcome
        this.stateManager.updateStateProperty('dkgState', DkgState.Complete);
    }

    private handleDkgStateUpdate(payload: any): void {
        console.log("[OffscreenMessageHandler] DKG state update:", redactForLog(payload));
        
        if (payload.payload && typeof payload.payload.state === 'number') {
            const newState = payload.payload.state;
            // Only update state if it's not going backwards from Complete
            const currentState = this.stateManager.getState().dkgState;
            
            if (currentState === DkgState.Complete && newState === DkgState.Idle) {
                console.log("[OffscreenMessageHandler] Ignoring attempt to reset DKG state from Complete to Idle");
                return;
            }
            
            this.stateManager.updateStateProperty('dkgState', newState);
        }
    }
}
