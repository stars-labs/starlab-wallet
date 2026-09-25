// ===================================================================
// dApp CONNECT REQUEST — shared types + EIP-1193 errors
// ===================================================================
//
// A dApp calling `eth_requestAccounts` (EVM) or wallet-standard
// `standard:connect` (Solana) from an origin that has no stored
// permission is parked as a ConnectRequest until the user approves or
// rejects it in the popup. This module holds the view the popup renders
// and the error type the RPC bridge serializes back to the page.
// ===================================================================

/** EIP-1193: the user rejected the request. */
export const USER_REJECTED = 4001;
/** EIP-1193: the origin is not authorized (e.g. known phishing site). */
export const UNAUTHORIZED = 4100;
/** MetaMask convention: an identical request is already awaiting the user. */
export const REQUEST_ALREADY_PENDING = -32002;

/** Error carrying an EIP-1193 / JSON-RPC `code` through to the page. */
export class ProviderRpcError extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.name = "ProviderRpcError";
        this.code = code;
    }
}

export type ConnectChain = "ethereum" | "solana";

/** What the popup renders for a pending connect request. */
export interface ConnectRequestView {
    requestId: string;
    origin: string;
    blockchain: ConnectChain;
    /** Accounts the user may choose to expose to the origin. */
    accounts: { address: string; name: string }[];
    /** Addresses pre-checked in the selector (the current account). */
    selected: string[];
    /** Phishing-lookalike warning for the origin, if any. */
    warning?: string;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(address: string): boolean {
    return EVM_ADDRESS.test(address);
}
