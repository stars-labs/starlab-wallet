// ===================================================================
// TYPES INDEX - CENTRALIZED TYPE EXPORTS
// ===================================================================
//
// This file provides a centralized location to import the most commonly
// used types across the MPC wallet application. This makes it easier
// for developers to find and import types without needing to know
// which specific file contains each type.
//
// Usage Example:
// import { AppState, SessionInfo, DkgState } from '../types.js';
// 
// Key Concepts for Junior Developers:
// - Index File: A common pattern to re-export types from multiple files
// - Barrel Export: Collecting and re-exporting from a single entry point
// - Type Organization: Grouping related types for easier discovery
// ===================================================================

// Core Application State
export type {
    AppState,
    ChainMetadata,
    EvmChain,
    KnownChain,
    LimitedChain,
    ProtocolBlockchain,
    SupportedChain,
    WalletCurve,
} from './appstate.js';
export {
    CHAIN_METADATA,
    CURVE_COMPATIBLE_CHAINS,
    EVM_CHAINS,
    INITIAL_APP_STATE,
    LIMITED_CHAINS,
    SUPPORTED_CHAINS,
    getChainLabel,
    getChainShortLabel,
    getCompatibleChains,
    getDefaultChainForCurve,
    getProtocolBlockchainForChain,
    getRequiredCurve,
    isEvmChain,
    isKnownChain,
    isSupportedChain,
    normalizeDerivedAddressChain,
} from './appstate.js';
// Note: Constants are exported for components that need them

// Session Management
export type {
    SessionInfo,
    SessionProposal,
    SessionResponse,
    SessionValidation,
    SessionValidator
} from './session.js';

// DKG (Distributed Key Generation)
export { DkgState } from './dkg.js';
export type {
    DkgPackageInfo,
    DkgStatus,
    DkgEvent
} from './dkg.js';

// Mesh Network
export type {
    MeshStatus
} from './mesh.js';
export { MeshStatusType } from './mesh.js';

// WebRTC Communication
export type {
    WebRTCAppMessage,
    DataChannelInfo,
    WebRTCConnectionStatus,
    WebRTCEvent
} from './webrtc.js';

// WebSocket Signaling
export type {
    SDPInfo,
    CandidateInfo,
    WebRTCSignal,
    WebSocketMessagePayload,
    ServerMsg,
    ClientMsg,
    WebSocketEvent
} from './websocket.js';

// Account Management
export type {
    Account,
    AccountBalance,
    AccountStorage,
    AccountEvent
} from './account.js';

// Network Configuration
export type {
    NetworkConfig,
    NetworkEvent,
    Chain
} from './network.js';

// Keystore Types
export type {
    KeyShareData,
    ExtensionWalletMetadata,
    KeystoreIndex,
    EncryptedKeyShare,
    KeystoreBackup,
    CLIKeystoreBackup,
    WalletFile,
    BlockchainInfo,
    WalletMetadata
} from './keystore.js';

// Message Types (commonly used for inter-component communication)
export type {
    PopupToBackgroundMessage,
    BackgroundToPopupMessage,
    BackgroundToOffscreenMessage,
    OffscreenToBackgroundMessage,
    BackgroundToOffscreenWrapper,
    OffscreenToBackgroundWrapper,
    InitialStateMessage,
    JsonRpcRequest,
    JsonRpcResponse,
    ContentToBackgroundMsg,
    BackgroundToContentMsg,
    InjectedToContentMsg,
    ContentToInjectedMsg,
    WebSocketClientMsg,
    WebSocketServerMsg,
    OffscreenMessage,
    BackgroundMessage,
    PopupMessage
} from './messages.js';

// Message validation helpers
export {
    validateMessage,
    validateSessionAcceptance,
    isRpcMessage,
    isAccountManagement,
    isNetworkManagement,
    isUIRequest,
    MESSAGE_TYPES
} from './messages.js';
