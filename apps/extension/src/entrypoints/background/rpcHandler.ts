// ===================================================================
// RPC HANDLER MODULE
// ===================================================================
//
// This module handles JSON-RPC requests from web applications and
// UI requests from the popup interface. It provides standardized
// wallet functionality including account management, network queries,
// and transaction handling.
// ===================================================================

import AccountService from '../../services/accountService';
import NetworkService from '../../services/networkService';
import WalletClientService from '../../services/walletClient';
import WalletController from "../../services/walletController";
import { getPermissionService } from '../../services/permissionService';
import { toHex } from 'viem';
import type { JsonRpcRequest } from "@stars-labs/types/messages";
import { checkOrigin } from '../../services/phishingService';
import type { SessionManager } from './sessionManager';
import type { YubiKeyManager } from './yubikeyManager';
import type { YubiKeySigner } from '../../signers';
import {
    ProviderRpcError,
    USER_REJECTED,
    UNAUTHORIZED,
    REQUEST_ALREADY_PENDING,
    isEvmAddress,
    type ConnectChain,
    type ConnectRequestView,
} from './connectRequest';

/** How long a connect request waits for the user before failing (5 min). */
const CONNECT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Handles JSON-RPC requests from web applications
 */
export class RpcHandler {
    private accountService: AccountService;
    private networkService: NetworkService;
    private walletClientService: WalletClientService;
    private permissionService = getPermissionService();
    private origin: string = '';
    /**
     * Pending signature promises keyed by signing/session id. Two
     * producers:
     *   - Legacy path (`handleSignMessageRequest` pre-Ext-4 flow):
     *     key is `msg_<timestamp>_<nonce>`; resolved by
     *     `messageSignatureComplete` via stateManager.
     *   - Ext-4 path (FROST threshold signing): key is the session
     *     id returned from SessionManager.createSigningSession
     *     (`sign_<hex>`); resolved by `signingComplete` via
     *     stateManager. Both map through the same
     *     handleSignatureComplete entrypoint, so a single Map
     *     suffices.
     */
    private pendingSignatures: Map<string, { resolve: (value: string) => void; reject: (reason?: any) => void }> = new Map();
    /**
     * Ext-4-confirm: dApp sign requests awaiting user approval in
     * the popup. Keyed by the placeholder id we assigned when the
     * RPC arrived (before any session exists). On approval, we
     * create the real session and re-key the pending promise
     * above to the actual session id; on rejection, we just reject
     * the pending promise and clean up.
     *
     * Kept distinct from pendingSignatures because a request can
     * live here indefinitely (while the popup is closed) without
     * a FROST ceremony running — aborting via reject() on timeout
     * is the only cleanup trigger.
     */
    private pendingDappRequests: Map<string, {
        walletId: string;
        walletName: string;
        groupPublicKey: string;
        blockchain: "ethereum" | "solana";
        threshold: number;
        total: number;
        messageHex: string;
        originalMessage: string;
        address: string;
        origin: string;
        /** Text shown on the popup's approve card (phishing banner included). */
        display: string;
    }> = new Map();
    /**
     * Ext-4: injected so RPC calls (e.g. personal_sign from a dApp)
     * can create the same TUI-compatible signing session the popup
     * does. Kept optional so stateless RPC calls that don't need
     * signing (chainId, getBalance, etc.) work before it's wired.
     */
    private sessionManager?: SessionManager;
    /**
     * YubiKey: holds the SignerRegistry for hardware accounts. When a
     * sign request targets a YubiKey address, we route to the card
     * (single-party, instant) instead of the FROST ceremony. Optional so
     * the FROST-only path works before it's wired / when no host exists.
     */
    private yubiKeyManager?: YubiKeyManager;
    /**
     * dApp connect requests (eth_requestAccounts / solana_connect from an
     * origin with no stored permission) awaiting the user's decision in the
     * popup. Nothing is exposed to the origin until resolveConnectRequest
     * approves it.
     */
    private pendingConnectRequests: Map<string, {
        view: ConnectRequestView;
        resolve: (accounts: string[]) => void;
        reject: (reason: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = new Map();

    constructor() {
        this.accountService = AccountService.getInstance();
        this.networkService = NetworkService.getInstance();
        this.walletClientService = WalletClientService.getInstance();
    }

    setSessionManager(sm: SessionManager): void {
        this.sessionManager = sm;
    }

    setYubiKeyManager(ym: YubiKeyManager): void {
        this.yubiKeyManager = ym;
    }

    /**
     * Set the origin of the request for permission checking
     */
    setOrigin(origin: string): void {
        this.origin = origin;
    }

    /**
     * Process a JSON-RPC request and return the response
     */
    async handleRpcRequest(request: JsonRpcRequest): Promise<unknown> {
        // Snapshot the origin: `this.origin` is shared across concurrent
        // requests and a connect prompt can stay open for minutes.
        const origin = this.origin;
        try {
            console.log(`[RpcHandler] Processing RPC request: ${request.method}`);

            switch (request.method) {
                case 'eth_accounts':
                    return await this.handleEthAccounts(origin);

                case 'eth_requestAccounts':
                    return await this.handleEthRequestAccounts(origin);

                case 'eth_chainId':
                    return await this.handleChainIdRequest();

                case 'net_version':
                    return await this.handleNetVersionRequest();

                case 'eth_getBalance':
                    return await this.handleGetBalanceRequest(request.params as unknown[]);

                case 'eth_sendTransaction':
                    return await this.handleSendTransactionRequest(request.params as unknown[]);

                case 'eth_signMessage':
                case 'personal_sign':
                    return await this.handleSignMessageRequest(request.params as unknown[]);

                case 'eth_signTypedData':
                case 'eth_signTypedData_v3':
                case 'eth_signTypedData_v4':
                    return await this.handleSignTypedDataRequest(request.params as unknown[]);

                case 'solana_connect':
                    return await this.handleSolanaConnect(origin);
                case 'solana_signBytes':
                    return await this.handleSolanaSignBytes(request.params as unknown[]);
                case 'solana_signTransaction':
                    return await this.handleSolanaSignTransaction(request.params as unknown[]);
                case 'solana_signAndSendTransaction':
                    return await this.handleSolanaSignAndSendTransaction(request.params as unknown[]);

                case 'eth_getTransactionCount':
                    return await this.handleGetTransactionCountRequest(request.params as unknown[]);

                case 'eth_gasPrice':
                    return await this.handleGasPriceRequest();

                case 'eth_estimateGas':
                    return await this.handleEstimateGasRequest(request.params as unknown[]);

                default:
                    // Forward read-only methods to RPC provider
                    if (this.isReadOnlyMethod(request.method)) {
                        return await this.forwardToRpcProvider(request);
                    }
                    throw new Error(`Unsupported method: ${request.method}`);
            }
        } catch (error) {
            console.error(`[RpcHandler] RPC request failed: ${request.method}`, error);
            throw error;
        }
    }

    /**
     * eth_accounts: the EVM accounts this origin is already connected to.
     * Never prompts. Internal callers (no origin, e.g. the popup) get the
     * current account.
     */
    private async handleEthAccounts(origin: string): Promise<string[]> {
        if (!origin) {
            const currentAccount = this.accountService.getCurrentAccount();
            return currentAccount ? [currentAccount.address] : [];
        }
        await this.permissionService.ensureInitialized();
        return this.permissionService.getConnectedAccounts(origin).filter(isEvmAddress);
    }

    /**
     * eth_requestAccounts: an already-connected origin gets its existing
     * accounts back without a prompt. Otherwise the user must approve the
     * connection (and pick which accounts to expose) in the popup; a reject
     * surfaces to the dApp as EIP-1193 4001.
     */
    private async handleEthRequestAccounts(origin: string): Promise<string[]> {
        if (!origin) {
            return this.handleEthAccounts(origin);
        }
        const warning = this.phishingGate(origin);

        await this.permissionService.ensureInitialized();
        const connected = this.permissionService.getConnectedAccounts(origin).filter(isEvmAddress);
        if (connected.length > 0) {
            console.log(`[RpcHandler] Returning existing connections for ${origin}`);
            return connected;
        }

        await this.accountService.ensureInitialized();
        let accounts = this.accountService.getAccountsByBlockchain('ethereum');
        if (accounts.length === 0) {
            console.log('[RpcHandler] No accounts exist, creating default account');
            const defaultAccount = await this.accountService.ensureDefaultAccount();
            if (!defaultAccount) {
                throw new Error('Failed to create default account');
            }
            accounts = [defaultAccount];
        }

        const current = this.accountService.getCurrentAccount();
        const currentOffered = accounts.find(
            (a) => current !== null && a.address.toLowerCase() === current.address.toLowerCase(),
        );

        return this.requestConnectApproval({
            origin,
            blockchain: 'ethereum',
            accounts: accounts.map((a) => ({ address: a.address, name: a.name })),
            selected: [(currentOffered ?? accounts[0]).address],
            warning,
        });
    }

    /**
     * Phishing gate (#36): a known-phishing origin never gets a connect
     * prompt at all. Returns the lookalike warning to show on the prompt,
     * if any.
     */
    private phishingGate(origin: string): string | undefined {
        const check = checkOrigin(origin);
        if (check.verdict === 'block') {
            throw new ProviderRpcError(
                UNAUTHORIZED,
                `Connection refused: ${origin} is a known phishing site.`,
            );
        }
        if (check.verdict === 'warn') {
            return `${check.reason}${check.imitates ? ` (imitates ${check.imitates})` : ''}`;
        }
        return undefined;
    }

    /**
     * Park a connect request until the user decides in the popup. Resolves
     * with the approved addresses; rejects with 4001 on reject/timeout and
     * -32002 if the same origin already has a request pending for this chain.
     */
    private requestConnectApproval(req: Omit<ConnectRequestView, 'requestId'>): Promise<string[]> {
        for (const { view } of this.pendingConnectRequests.values()) {
            if (view.origin === req.origin && view.blockchain === req.blockchain) {
                return Promise.reject(new ProviderRpcError(
                    REQUEST_ALREADY_PENDING,
                    `A connection request from ${req.origin} is already pending. Open the wallet to respond.`,
                ));
            }
        }

        const requestId = `dapp_connect_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const view: ConnectRequestView = { requestId, ...req };

        const approval = new Promise<string[]>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.finishConnectRequest(requestId)) {
                    reject(new ProviderRpcError(USER_REJECTED, 'Connection request timed out.'));
                }
            }, CONNECT_REQUEST_TIMEOUT_MS);
            this.pendingConnectRequests.set(requestId, { view, resolve, reject, timer });
        });

        this.sendToExtensionPages({ type: 'connectRequest', request: view });

        if (typeof chrome !== 'undefined' && chrome.notifications) {
            try {
                chrome.notifications.create(`mpc-dapp-connect:${requestId}`, {
                    type: 'basic',
                    iconUrl: 'icon/128.png',
                    title: 'Connection request',
                    message: `${req.origin} wants to connect to your wallet`,
                    priority: 2,
                    requireInteraction: true,
                });
            } catch (e) {
                console.warn('[RpcHandler] Failed to create connect notification:', e);
            }
        }
        // Best effort: open the popup straight away. Chrome may refuse
        // without a user gesture; the notification click is the fallback.
        try {
            const opened = (chrome.action as any)?.openPopup?.();
            if (opened && typeof opened.catch === 'function') opened.catch(() => {});
        } catch {
            /* notification click remains the path to the popup */
        }

        return approval;
    }

    /** Connect requests still awaiting the user (the popup loads these on open). */
    /**
     * dApp signing requests still awaiting approval, in the shape of the
     * `signatureRequest` broadcast. The popup is usually closed when a
     * request arrives, so it loads these on open.
     */
    getPendingSignatureRequests(): Array<{
        signingId: string;
        message: string;
        origin: string;
        fromAddress: string;
    }> {
        return Array.from(this.pendingDappRequests, ([signingId, r]) => ({
            signingId,
            message: r.display,
            origin: r.origin,
            fromAddress: r.address,
        }));
    }

    getPendingConnectRequests(): ConnectRequestView[] {
        return Array.from(this.pendingConnectRequests.values(), (p) => p.view);
    }

    /**
     * Called from the popup's Connect request card. On approve, stores the
     * permission for exactly the selected accounts and resolves the dApp's
     * pending request with them; on reject, fails it with 4001.
     */
    async resolveConnectRequest(
        requestId: string,
        approved: boolean,
        selectedAddresses: string[] = [],
    ): Promise<{ success: boolean; error?: string }> {
        const pending = this.pendingConnectRequests.get(requestId);
        if (!pending) {
            return { success: false, error: `No pending connect request ${requestId}` };
        }

        if (!approved) {
            this.finishConnectRequest(requestId);
            pending.reject(new ProviderRpcError(USER_REJECTED, 'User rejected the request.'));
            return { success: true };
        }

        const offered = new Map(pending.view.accounts.map((a) => [a.address.toLowerCase(), a.address]));
        const chosen: string[] = [];
        for (const address of selectedAddresses) {
            const match = offered.get(address.toLowerCase());
            if (!match) {
                return { success: false, error: `Account ${address} was not offered to ${pending.view.origin}` };
            }
            if (!chosen.includes(match)) chosen.push(match);
        }
        if (chosen.length === 0) {
            return { success: false, error: 'Select at least one account to connect' };
        }

        this.finishConnectRequest(requestId);
        try {
            await this.storeConnection(pending.view.origin, pending.view.blockchain, chosen);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            pending.reject(new Error(`Failed to store connection: ${message}`));
            return { success: false, error: message };
        }
        pending.resolve(chosen);
        return { success: true };
    }

    /**
     * Remove a request from the queue and tell every open popup it is gone.
     * Returns false if it was already finished.
     */
    private finishConnectRequest(requestId: string): boolean {
        const pending = this.pendingConnectRequests.get(requestId);
        if (!pending) return false;
        clearTimeout(pending.timer);
        this.pendingConnectRequests.delete(requestId);
        if (typeof chrome !== 'undefined' && chrome.notifications) {
            try {
                chrome.notifications.clear(`mpc-dapp-connect:${requestId}`);
            } catch {
                /* non-fatal */
            }
        }
        this.sendToExtensionPages({ type: 'connectRequestResolved', requestId });
        return true;
    }

    /**
     * Persist the approved accounts for this chain, keeping the origin's
     * connections on the other chain (one permission record per origin).
     */
    private async storeConnection(origin: string, blockchain: ConnectChain, accounts: string[]): Promise<void> {
        const otherChain = this.permissionService
            .getConnectedAccounts(origin)
            .filter((a) => isEvmAddress(a) !== (blockchain === 'ethereum'));
        const currentNetwork = this.networkService.getCurrentNetwork();
        const chainId = currentNetwork ? toHex(currentNetwork.id) : '0x1';
        await this.permissionService.connectAccounts(origin, [...accounts, ...otherChain], chainId);
        console.log(`[RpcHandler] Connected ${accounts.length} ${blockchain} account(s) to ${origin}`);
    }

    /** runtime.sendMessage that tolerates "no receiver" when the popup is closed. */
    private sendToExtensionPages(message: Record<string, unknown>): void {
        try {
            const sent = chrome.runtime.sendMessage(message) as unknown;
            if (sent && typeof (sent as Promise<unknown>).catch === 'function') {
                (sent as Promise<unknown>).catch(() => {});
            }
        } catch {
            /* no extension page listening */
        }
    }

    /**
     * Handle eth_chainId request
     */
    private async handleChainIdRequest(): Promise<string> {
        const currentNetwork = this.networkService.getCurrentNetwork();
        if (!currentNetwork) {
            throw new Error('No current network found');
        }
        return toHex(currentNetwork.id);
    }

    /**
     * Handle net_version request
     */
    private async handleNetVersionRequest(): Promise<string> {
        const network = this.networkService.getCurrentNetwork();
        if (!network) {
            throw new Error('No current network found');
        }
        return network.id.toString();
    }

    /**
     * Handle eth_getBalance request
     */
    private async handleGetBalanceRequest(params: unknown[]): Promise<string> {
        if (!params || params.length < 1) {
            throw new Error('Missing address parameter');
        }

        const address = params[0] as string;
        // WalletClientService.getBalance() only takes address as optional parameter
        return await this.walletClientService.getBalance(address);
    }

    /**
     * Handle eth_sendTransaction request
     */
    private async handleSendTransactionRequest(params: unknown[]): Promise<string> {
        if (!params || params.length < 1) {
            throw new Error('Missing transaction parameters');
        }

        const transaction = params[0] as any;

        // Validate transaction parameters
        if (!transaction.to) {
            throw new Error('Invalid transaction parameters: missing "to" address');
        }

        // Policy gate (#35): enforce per-tx / daily / origin limits BEFORE any
        // signing path runs. A denial is the policy working — the error tells
        // the user to loosen it in Settings if they really mean it.
        {
            const { PolicyService } = await import('../../services/policyService');
            const decision = await PolicyService.getInstance().check({
                valueWei: transaction.value ? BigInt(transaction.value) : 0n,
                origin: this.origin || undefined,
            });
            if (!decision.allowed) {
                throw new Error(`Blocked by wallet policy: ${decision.reason}`);
            }
        }

        // YubiKey: if the sender is a hardware account, sign the tx on the
        // card and return the raw signed transaction (single-party, no
        // FROST ceremony). dApps expect eth_sendTransaction to broadcast,
        // but this extension's FROST path also only signs — broadcasting is
        // out of scope here, so we return the signed serialized tx to match
        // existing behaviour (resolve of the signing promise).
        const fromAddr: string | undefined =
            transaction.from || this.accountService.getCurrentAccount()?.address;
        const txYubiSigner = fromAddr
            ? this.yubiKeyManager?.getSignerByAddress(fromAddr)
            : undefined;
        if (txYubiSigner) {
            const signed = await this.signTransactionWithYubiKey(txYubiSigner, transaction);
            // eth_sendTransaction must BROADCAST and return the tx hash —
            // returning the raw signed tx (old behaviour) left the tx
            // off-chain and broke the dApp contract. Record it as pending
            // activity; the background reconciler flips it on receipt.
            return await this.broadcastAndRecord(signed as `0x${string}`, transaction, fromAddr!);
        }

        // Generate a unique transaction signing ID
        const signingId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Serialize transaction for MPC signing
        const transactionData = JSON.stringify({
            to: transaction.to,
            value: transaction.value || '0x0',
            data: transaction.data || '0x',
            nonce: transaction.nonce,
            gasLimit: transaction.gas || transaction.gasLimit,
            gasPrice: transaction.gasPrice,
            maxFeePerGas: transaction.maxFeePerGas,
            maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
            chainId: await this.handleChainIdRequest()
        });

        // Create a promise that will resolve when we get the signed transaction
        const signaturePromise = new Promise<string>((resolve, reject) => {
            if (!this.pendingSignatures) {
                this.pendingSignatures = new Map();
            }
            this.pendingSignatures.set(signingId, { resolve, reject });

            // Set a timeout
            setTimeout(() => {
                if (this.pendingSignatures?.has(signingId)) {
                    this.pendingSignatures.delete(signingId);
                    reject(new Error('Transaction signing timed out'));
                }
            }, 300000); // 5 minute timeout
        });

        // Send transaction signing request to offscreen document
        chrome.runtime.sendMessage({
            type: 'fromBackground',
            payload: {
                type: 'requestTransactionSignature',
                signingId,
                transactionData,
                fromAddress: transaction.from || (this.accountService.getCurrentAccount()?.address)
            }
        });

        // Also notify popup if open for user approval. Attach the decoded
        // plain-language summary + warnings (#33) so the popup never has to
        // ask for a blind signature on raw calldata.
        const { decodeEvmTransaction } = await import('../../services/txDecoder');
        const decodedTx = decodeEvmTransaction(transaction);
        chrome.runtime.sendMessage({
            type: 'transactionRequest',
            signingId,
            transaction,
            decoded: decodedTx,
            origin: this.origin || 'Unknown',
            fromAddress: transaction.from || (this.accountService.getCurrentAccount()?.address)
        });

        return signaturePromise;
    }

    /**
     * Ext-4: handle personal_sign / eth_sign by routing the request
     * through the TUI-compatible FROST threshold signing flow.
     *
     * This replaces the legacy `requestMessageSignature` path that
     * asked the offscreen DkgManager to sign single-party over the
     * loaded keystore. That path produced a lone share, never a
     * threshold signature — fine for internal use but useless for
     * dApp `ecrecover` verification since no real aggregation
     * happened.
     *
     * New flow:
     *   1. Parse params (personal_sign: [msg, addr] / eth_sign
     *      reversed — detect by which param looks like an address).
     *   2. Look up the wallet by address via KeystoreManager. Reject
     *      if the user has no wallet for that address (dApp sent a
     *      stale/wrong account).
     *   3. EIP-191 wrap via viem's `hashMessage` so the FROST output
     *      pairs with standard ecrecover (matches the popup's
     *      Sign Message flow exactly).
     *   4. Call sessionManager.createSigningSession — same entrypoint
     *      the popup's manual-sign button uses. Announces on the
     *      signal server; co-signers get notified; ceremony starts
     *      at threshold; stateManager.signingComplete eventually
     *      calls rpcHandler.handleSignatureComplete(sessionId, sig)
     *      to resolve the promise returned here.
     *   5. Popup receives a `signatureRequest` broadcast to surface
     *      the dApp origin to the user (existing UI hook reused for
     *      origin display).
     */
    private async handleSignMessageRequest(params: unknown[]): Promise<string> {
        if (!params || params.length < 1) {
            throw new Error('Missing message parameter');
        }

        if (!this.sessionManager) {
            throw new Error(
                'SessionManager not initialized — cannot route signing request',
            );
        }

        let message: string;
        let address: string;

        // Handle different parameter formats for eth_sign vs personal_sign
        // personal_sign: [message, address]
        // eth_sign: [address, message]
        if (params.length >= 2) {
            const param0 = params[0] as string;
            const param1 = params[1] as string;

            if (param0.startsWith('0x') && param0.length === 42) {
                // eth_sign format: [address, message]
                address = param0;
                message = param1;
            } else {
                // personal_sign format: [message, address]
                message = param0;
                address = param1;
            }
        } else {
            // Single param: message only, use current account.
            message = params[0] as string;
            const currentAccount = this.accountService.getCurrentAccount();
            if (!currentAccount) {
                throw new Error('No account selected');
            }
            address = currentAccount.address;
        }

        // YubiKey: if this address is backed by a hardware account, sign
        // on the card directly. This is single-party + instant, so it
        // bypasses the whole FROST announce/approve/ceremony flow below.
        const yubiSigner = this.yubiKeyManager?.getSignerByAddress(address);
        if (yubiSigner) {
            return await this.signWithYubiKey(yubiSigner, message);
        }

        // Look up the wallet backing this address. KeystoreManager's
        // wallets carry `address` from the save-wallet flow (Ext-1d).
        // Case-insensitive compare — dApps frequently lowercase
        // addresses but our storage uses checksummed-or-mixed case.
        const { KeystoreManager } = await import('../../services/keystoreManager');
        const km = KeystoreManager.getInstance();
        const wallets = km.getWallets();
        const normalized = address.toLowerCase();
        const wallet = wallets.find(
            (w: any) => typeof w.address === 'string' && w.address.toLowerCase() === normalized,
        );
        if (!wallet) {
            throw new Error(
                `No wallet found for address ${address}. Unlock a wallet in the extension that owns this address before signing.`,
            );
        }

        const blockchain: 'ethereum' | 'solana' =
            (wallet as any).blockchain === 'solana' ? 'solana' : 'ethereum';

        // Pull threshold/total/groupPublicKey from the KeyShareData.
        const keyShare = (km as any).getKeyShareData?.((wallet as any).id);
        const groupPublicKey =
            keyShare?.group_public_key ?? (wallet as any).group_public_key ?? '';
        const threshold = keyShare?.threshold ?? 2;
        const total = keyShare?.total_participants ?? 3;

        // EIP-191 wrap for secp256k1, raw UTF-8 bytes for ed25519.
        // Mirrors handleCreateSigningSessionRequest in messageHandlers.
        let messageHex: string;
        if (blockchain === 'ethereum') {
            const { hashMessage } = await import('viem');
            // `message` may already be 0x-hex bytes (dApp convention)
            // or raw UTF-8 text. hashMessage accepts string and treats
            // 0x-prefixed hex as raw bytes only if wrapped in `{raw}`.
            // For personal_sign, the standard treats the param as raw
            // bytes if 0x-prefixed. Match that:
            const isHex = /^0x[0-9a-fA-F]*$/.test(message);
            const hash = isHex
                ? hashMessage({ raw: message as `0x${string}` })
                : hashMessage(message);
            messageHex = hash.startsWith('0x') ? hash.slice(2) : hash;
        } else {
            const encoder = new TextEncoder();
            const bytes = encoder.encode(message);
            messageHex = Array.from(bytes, (b) =>
                b.toString(16).padStart(2, '0'),
            ).join('');
        }

        return this.enqueueDappSignature({
            walletId: (wallet as any).id,
            walletName: (wallet as any).name ?? (wallet as any).id,
            groupPublicKey,
            blockchain,
            threshold,
            total,
            messageHex,
            originalMessage: message,
            address,
            displayMessage: message,
        });
    }

    /**
     * Solana wallet-standard `standard:connect`. Same gate as
     * eth_requestAccounts: an origin already connected to one of our Solana
     * accounts gets it back; otherwise the user must approve in the popup.
     */
    private async handleSolanaConnect(origin: string): Promise<string> {
        const wallets = await this.listSolanaWallets();
        if (wallets.length === 0) {
            throw new Error(
                'No Solana account available. Create or unlock a wallet with a Solana (ed25519) address.',
            );
        }
        if (!origin) {
            return wallets[0].address;
        }
        const warning = this.phishingGate(origin);

        await this.permissionService.ensureInitialized();
        const connected = new Set(this.permissionService.getConnectedAccounts(origin));
        const existing = wallets.find((w) => connected.has(w.address.toLowerCase()));
        if (existing) {
            return existing.address;
        }

        const approved = await this.requestConnectApproval({
            origin,
            blockchain: 'solana',
            accounts: wallets.map((w) => ({ address: w.address, name: w.name })),
            selected: [wallets[0].address],
            warning,
        });
        return approved[0];
    }

    /**
     * Solana wallet-standard: sign raw bytes (an off-chain message, or a
     * transaction's serialized message) with the account's ed25519 key via the
     * gated FROST ceremony. Params: [address, hexBytes]. Returns the 64-byte
     * signature as hex (the page bridge decodes it).
     */
    private async handleSolanaSignBytes(params: unknown[]): Promise<string> {
        if (!this.sessionManager) {
            throw new Error('SessionManager not initialized — cannot route signing request');
        }
        const address = params[0] as string;
        const hexBytes = params[1] as string;
        if (!address || typeof hexBytes !== 'string') {
            throw new Error('solana_signBytes: expected [address, hexBytes]');
        }

        // Hardware (YubiKey/Ledger) ed25519 accounts sign the bytes directly.
        const hwSigner = this.yubiKeyManager?.getSignerByAddress(address);
        if (hwSigner && hwSigner.curve === 'ed25519') {
            const sig = await hwSigner.signEd25519(this.hexToBytes(this.stripHex(hexBytes)));
            return this.bytesToHex(sig);
        }

        const wallet = await this.findSolanaWallet(address);
        if (!wallet) {
            throw new Error(`No Solana wallet found for ${address}.`);
        }
        const { KeystoreManager } = await import('../../services/keystoreManager');
        const km = KeystoreManager.getInstance();
        const keyShare = (km as any).getKeyShareData?.((wallet as any).id);
        const groupPublicKey =
            keyShare?.group_public_key ?? (wallet as any).group_public_key ?? '';
        const threshold = keyShare?.threshold ?? 2;
        const total = keyShare?.total_participants ?? 3;

        return this.enqueueDappSignature({
            walletId: (wallet as any).id,
            walletName: (wallet as any).name ?? (wallet as any).id,
            groupPublicKey,
            blockchain: 'solana',
            threshold,
            total,
            messageHex: this.stripHex(hexBytes),
            originalMessage: hexBytes,
            address,
            displayMessage: 'Solana: sign request',
        });
    }

    /**
     * Solana wallet-standard: sign a serialized transaction. The background
     * owns @solana/web3.js (kept off every page): deserialize → sign the
     * compiled message via the gated FROST ed25519 ceremony → reattach the
     * signature → re-serialize. Params: [address, hexTx]; returns hex(signed tx).
     */
    private async handleSolanaSignTransaction(params: unknown[]): Promise<string> {
        const address = params[0] as string;
        const hexTx = params[1] as string;
        const { PublicKey, VersionedTransaction } = await import('@solana/web3.js');
        const tx = VersionedTransaction.deserialize(this.hexToBytes(this.stripHex(hexTx)));
        const sigHex = await this.handleSolanaSignBytes([
            address,
            this.bytesToHex(tx.message.serialize()),
        ]);
        tx.addSignature(new PublicKey(address), this.hexToBytes(this.stripHex(sigHex)));
        return this.bytesToHex(tx.serialize());
    }

    /**
     * Solana wallet-standard: sign (as above) then broadcast to the current
     * Solana network RPC. Params: [address, hexTx]; returns the tx signature
     * (base58). Used by `solana:signAndSendTransaction`.
     */
    private async handleSolanaSignAndSendTransaction(params: unknown[]): Promise<string> {
        const signedHex = await this.handleSolanaSignTransaction(params);
        const raw = this.hexToBytes(this.stripHex(signedHex));
        const b64 = btoa(String.fromCharCode(...raw));

        const net = this.networkService?.getCurrentNetwork?.('solana');
        const rpcUrl = (net as any)?.rpcUrls?.default?.http?.[0];
        if (!rpcUrl) throw new Error('No Solana RPC configured');

        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sendTransaction',
                params: [b64, { encoding: 'base64' }],
            }),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error.message ?? 'sendTransaction failed');
        return json.result as string;
    }

    /** All Solana (ed25519) wallets in the keystore that carry an address. */
    private async listSolanaWallets(): Promise<{ id: string; name: string; address: string }[]> {
        const { KeystoreManager } = await import('../../services/keystoreManager');
        return KeystoreManager.getInstance()
            .getWallets()
            .filter((w: any) => (w.blockchain === 'solana' || w.curve === 'ed25519') && typeof w.address === 'string')
            .map((w: any) => ({ id: w.id, name: w.name ?? w.id, address: w.address }));
    }

    /** Find the Solana (ed25519) keystore wallet with this address. */
    private async findSolanaWallet(address: string): Promise<unknown | undefined> {
        const { KeystoreManager } = await import('../../services/keystoreManager');
        const norm = address.toLowerCase();
        return KeystoreManager.getInstance().getWallets().find(
            (w: any) =>
                (w.blockchain === 'solana' || w.curve === 'ed25519') &&
                typeof w.address === 'string' &&
                w.address.toLowerCase() === norm,
        );
    }

    /**
     * Shared tail for every gated dApp signing request (personal_sign,
     * eth_signTypedData, …). Stashes the request context, surfaces it in the
     * popup for explicit user approval, fires a desktop notification, and
     * returns a Promise that resolves when the approved FROST ceremony
     * completes (or rejects on user-reject / timeout).
     *
     * Ext-4-confirm: we DO NOT announce the signing session here. A dApp RPC
     * MUST gate on explicit user approval before anything hits the signal
     * server — otherwise a malicious dApp could wake every co-signer device
     * just by calling a sign method. The session is only created when the user
     * clicks Approve (see approveDappSignature).
     */
    private enqueueDappSignature(ctx: {
        walletId: string;
        walletName: string;
        groupPublicKey: string;
        blockchain: 'ethereum' | 'solana';
        threshold: number;
        total: number;
        messageHex: string;
        originalMessage: string;
        address: string;
        /** Human-readable text shown in the popup (defaults to originalMessage). */
        displayMessage?: string;
    }): Promise<string> {
        // Phishing gate (#36): every signing request re-checks the origin —
        // a lookalike that slipped past connect still gets flagged where it
        // matters, on the approve screen.
        let display = ctx.displayMessage ?? ctx.originalMessage;
        if (this.origin) {
            try {
                const check = checkOrigin(this.origin);
                if (check.verdict !== 'ok') {
                    display = `🚨 ${check.reason}${check.imitates ? ` (imitates ${check.imitates})` : ''}\n${display}`;
                }
            } catch {
                /* never let the gate break signing */
            }
        }

        const requestId = `dapp_req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        this.pendingDappRequests.set(requestId, {
            walletId: ctx.walletId,
            walletName: ctx.walletName,
            groupPublicKey: ctx.groupPublicKey,
            blockchain: ctx.blockchain,
            threshold: ctx.threshold,
            total: ctx.total,
            messageHex: ctx.messageHex,
            originalMessage: ctx.originalMessage,
            address: ctx.address,
            origin: this.origin || 'Unknown',
            display,
        });

        chrome.runtime.sendMessage({
            type: 'signatureRequest',
            signingId: requestId,
            message: display,
            origin: this.origin || 'Unknown',
            fromAddress: ctx.address,
        });

        if (typeof chrome !== 'undefined' && chrome.notifications) {
            try {
                chrome.notifications.create(`mpc-dapp-sig:${requestId}`, {
                    type: 'basic',
                    iconUrl: 'icon/128.png',
                    title: 'Signature requested',
                    message: `${this.origin || 'A dApp'} wants you to sign with ${ctx.address.slice(0, 6)}…${ctx.address.slice(-4)}`,
                    priority: 2,
                    requireInteraction: true,
                });
            } catch (e) {
                console.warn('[RpcHandler] Failed to create notification:', e);
            }
        }

        return new Promise<string>((resolve, reject) => {
            this.pendingSignatures.set(requestId, { resolve, reject });
            setTimeout(() => {
                if (this.pendingSignatures.has(requestId)) {
                    this.pendingSignatures.delete(requestId);
                    this.pendingDappRequests.delete(requestId);
                    reject(new Error('Signature request timed out'));
                }
            }, 300_000);
        });
    }

    /**
     * Ext-4: handle eth_signTypedData_v3 / _v4 (EIP-712). Params are
     * `[address, typedData]` where typedData is the EIP-712 payload (a JSON
     * string per the MetaMask convention, or an already-parsed object).
     *
     * EIP-712 differs from personal_sign only in the digest: we compute the
     * 32-byte typed-data hash via viem's `hashTypedData` (domainSeparator +
     * hashStruct) instead of the EIP-191 message hash. The FROST ceremony then
     * signs that digest exactly as it signs the personal_sign digest, so this
     * funnels into the same gated approval pipeline. EVM-only (secp256k1) —
     * Solana has no EIP-712 analogue.
     */
    private async handleSignTypedDataRequest(params: unknown[]): Promise<string> {
        if (!this.sessionManager) {
            throw new Error(
                'SessionManager not initialized — cannot route signing request',
            );
        }

        // eth_signTypedData_v4: [address, typedDataJSON]. Some callers
        // (legacy v1) pass [typedData, address]; detect by the 0x-address shape.
        let address: string;
        let typedDataRaw: unknown;
        const p0 = params[0] as string;
        if (typeof p0 === 'string' && p0.startsWith('0x') && p0.length === 42) {
            address = p0;
            typedDataRaw = params[1];
        } else {
            typedDataRaw = params[0];
            address = params[1] as string;
        }
        if (!address) {
            const currentAccount = this.accountService.getCurrentAccount();
            if (!currentAccount) throw new Error('No account selected');
            address = currentAccount.address;
        }

        const typedData =
            typeof typedDataRaw === 'string'
                ? JSON.parse(typedDataRaw)
                : typedDataRaw;
        if (!typedData || typeof typedData !== 'object') {
            throw new Error('eth_signTypedData: malformed typed-data payload');
        }

        // EIP-712 digest. viem derives the EIP712Domain type from `domain`, so
        // a stray `types.EIP712Domain` from the dApp is harmless.
        const { hashTypedData } = await import('viem');
        const digest = hashTypedData({
            domain: (typedData as any).domain ?? {},
            types: (typedData as any).types ?? {},
            primaryType: (typedData as any).primaryType,
            message: (typedData as any).message ?? {},
        });
        const messageHex = digest.startsWith('0x') ? digest.slice(2) : digest;

        // YubiKey hardware account: sign the precomputed digest on the card.
        const yubiSigner = this.yubiKeyManager?.getSignerByAddress(address);
        if (yubiSigner) {
            return await this.signDigestWithYubiKey(yubiSigner, messageHex);
        }

        // Look up the FROST wallet backing this address (EVM/secp256k1).
        const { KeystoreManager } = await import('../../services/keystoreManager');
        const km = KeystoreManager.getInstance();
        const normalized = address.toLowerCase();
        const wallet = km
            .getWallets()
            .find(
                (w: any) =>
                    typeof w.address === 'string' &&
                    w.address.toLowerCase() === normalized,
            );
        if (!wallet) {
            throw new Error(
                `No wallet found for address ${address}. Unlock a wallet in the extension that owns this address before signing.`,
            );
        }

        const keyShare = (km as any).getKeyShareData?.((wallet as any).id);
        const groupPublicKey =
            keyShare?.group_public_key ?? (wallet as any).group_public_key ?? '';
        const threshold = keyShare?.threshold ?? 2;
        const total = keyShare?.total_participants ?? 3;

        // Human-readable summary + danger warnings (#33) — a Permit is an
        // approval in disguise; the popup must say so, not show raw JSON.
        const { decodeTypedData } = await import('../../services/txDecoder');
        const decoded = decodeTypedData(typedData as any);
        const display =
            decoded.warnings.length > 0
                ? `${decoded.danger === 'critical' ? '⚠️ ' : ''}${decoded.summary}\n${decoded.warnings.join('\n')}`
                : decoded.summary;

        return this.enqueueDappSignature({
            walletId: (wallet as any).id,
            walletName: (wallet as any).name ?? (wallet as any).id,
            groupPublicKey,
            blockchain: 'ethereum',
            threshold,
            total,
            messageHex,
            originalMessage: typeof typedDataRaw === 'string'
                ? typedDataRaw
                : JSON.stringify(typedDataRaw),
            address,
            displayMessage: display,
        });
    }

    /**
     * YubiKey: produce a `personal_sign` signature on the card.
     *
     *   - secp256k1 (EVM): EIP-191 prehash the message (viem `hashMessage`),
     *     hand the 32-byte digest to the card, then assemble the 65-byte
     *     `(r,s,v)` signature with `v = recovery + 27` — the format dApps
     *     feed to ecrecover / `verifyMessage`.
     *   - ed25519 (Solana): the card signs the raw message bytes; we return
     *     the 64-byte detached signature as hex.
     *
     * Returns a 0x-prefixed hex string, matching the FROST path's contract.
     */
    private async signWithYubiKey(
        signer: YubiKeySigner,
        message: string,
    ): Promise<string> {
        const isHex = /^0x[0-9a-fA-F]*$/.test(message);

        if (signer.curve === 'secp256k1') {
            const { hashMessage } = await import('viem');
            const hash = isHex
                ? hashMessage({ raw: message as `0x${string}` })
                : hashMessage(message);
            const prehash = this.hexToBytes(hash);
            const { r, s, recovery } = await signer.signSecp256k1(prehash);
            const rHex = this.stripHex(r).padStart(64, '0');
            const sHex = this.stripHex(s).padStart(64, '0');
            // Legacy EIP-191 `v` is recovery + 27.
            const v = (recovery + 27).toString(16).padStart(2, '0');
            return `0x${rHex}${sHex}${v}`;
        }

        // ed25519 / Solana: sign the raw message bytes.
        const bytes = isHex
            ? this.hexToBytes(message)
            : new TextEncoder().encode(message);
        const sig = await signer.signEd25519(bytes);
        return `0x${this.bytesToHex(sig)}`;
    }

    /**
     * YubiKey: sign an already-computed 32-byte digest on the card (EIP-712
     * typed data, where the EIP-712 hashing happened upstream). Unlike
     * {@link signWithYubiKey} this does NOT re-wrap with EIP-191 — the digest
     * is signed verbatim — then assembles the 65-byte `(r,s,v)` with
     * `v = recovery + 27`, the format dApps expect from eth_signTypedData.
     */
    private async signDigestWithYubiKey(
        signer: YubiKeySigner,
        digestHex: string,
    ): Promise<string> {
        if (signer.curve !== 'secp256k1') {
            throw new Error('eth_signTypedData requires a secp256k1 account');
        }
        const prehash = this.hexToBytes(this.stripHex(digestHex));
        const { r, s, recovery } = await signer.signSecp256k1(prehash);
        const rHex = this.stripHex(r).padStart(64, '0');
        const sHex = this.stripHex(s).padStart(64, '0');
        const v = (recovery + 27).toString(16).padStart(2, '0');
        return `0x${rHex}${sHex}${v}`;
    }

    /**
     * YubiKey: sign an EVM transaction on the card. Builds an EIP-1559
     * (or legacy, if gasPrice given) transaction with viem, takes its
     * signing hash, signs the 32-byte digest on the card, and returns
     * the serialized signed transaction (0x-hex, ready to broadcast).
     *
     * NOTE: this assembles `yParity` from the card's recovery id. For
     * legacy (pre-EIP-1559) txs viem derives `v` from chainId + yParity
     * internally when you pass `{ r, s, v: yParity }` via the typed
     * signature object below.
     */
    private async signTransactionWithYubiKey(
        signer: YubiKeySigner,
        transaction: any,
    ): Promise<string> {
        if (signer.curve !== 'secp256k1') {
            throw new Error('YubiKey account is not an EVM (secp256k1) key');
        }
        const { serializeTransaction, keccak256 } = await import('viem');

        const network = this.networkService.getCurrentNetwork();
        const chainId = network?.id ?? 1;

        // Build a viem-serializable tx. Prefer EIP-1559 when fee fields are
        // present, else fall back to legacy gasPrice.
        const base: any = {
            chainId,
            to: transaction.to,
            value: transaction.value ? BigInt(transaction.value) : 0n,
            data: transaction.data ?? '0x',
            nonce:
                transaction.nonce !== undefined
                    ? Number(transaction.nonce)
                    : undefined,
            gas:
                transaction.gas || transaction.gasLimit
                    ? BigInt(transaction.gas || transaction.gasLimit)
                    : undefined,
        };
        if (transaction.maxFeePerGas || transaction.maxPriorityFeePerGas) {
            base.type = 'eip1559';
            base.maxFeePerGas = BigInt(transaction.maxFeePerGas ?? 0);
            base.maxPriorityFeePerGas = BigInt(
                transaction.maxPriorityFeePerGas ?? 0,
            );
        } else if (transaction.gasPrice) {
            base.type = 'legacy';
            base.gasPrice = BigInt(transaction.gasPrice);
        }

        // Unsigned serialization → keccak256 → 32-byte signing digest.
        const unsigned = serializeTransaction(base);
        const digest = keccak256(unsigned);
        const sig = await signer.signSecp256k1(this.hexToBytes(digest));

        // assembleSignedEvmTx handles the per-type signature form (legacy
        // needs v via EIP-155, typed txs take yParity) and is byte-for-byte
        // verified against viem's own signer in its tests.
        const { assembleSignedEvmTx } = await import('../../services/txBroadcast');
        return assembleSignedEvmTx(base, sig);
    }

    /**
     * Broadcast a signed raw tx on the current EVM network, record it as a
     * pending activity for `from`, and return the tx hash (the value
     * eth_sendTransaction owes the caller). Recording is best-effort — a
     * storage hiccup must not turn a successful broadcast into an RPC error.
     */
    private async broadcastAndRecord(
        signedTxHex: `0x${string}`,
        transaction: any,
        from: string,
    ): Promise<string> {
        const network = this.networkService.getCurrentNetwork();
        const rpcUrl = (network as any)?.rpcUrls?.default?.http?.[0];
        if (!rpcUrl) throw new Error('No EVM RPC configured for broadcast');

        const { broadcastRawTx } = await import('../../services/txBroadcast');
        const hash = await broadcastRawTx(rpcUrl, signedTxHex);

        try {
            const { ActivityService } = await import('../../services/activityService');
            const isContract =
                typeof transaction.data === 'string' && transaction.data !== '0x' && transaction.data !== '';
            await ActivityService.getInstance().record(from, {
                hash,
                chainId: network?.id ?? 1,
                from,
                to: transaction.to ?? '',
                value: transaction.value ? BigInt(transaction.value).toString() : '0',
                kind: isContract ? 'contract' : 'send',
            });
        } catch (e) {
            console.warn('[RpcHandler] failed to record activity for', hash, e);
        }

        // Policy daily window (#35): count the broadcast value toward the
        // rolling 24h limit. Best-effort like the other recorders.
        try {
            const { PolicyService } = await import('../../services/policyService');
            await PolicyService.getInstance().recordSpend(
                transaction.value ? BigInt(transaction.value) : 0n,
            );
        } catch (e) {
            console.warn('[RpcHandler] failed to record policy spend:', e);
        }

        // Allowance registry (#17): if this tx was an ERC-20 approve, remember
        // (token, spender) so the user can review/revoke it later. Best-effort.
        try {
            if (typeof transaction.data === 'string' && transaction.data.startsWith('0x095ea7b3')) {
                const { decodeFunctionData } = await import('viem');
                const { ERC20_ABI } = await import('../../services/tokenService');
                const dec = decodeFunctionData({ abi: ERC20_ABI, data: transaction.data as `0x${string}` });
                if (dec.functionName === 'approve') {
                    const [spender, amount] = dec.args as [string, bigint];
                    if (amount > 0n) {
                        const { AllowanceService } = await import('../../services/allowanceService');
                        await AllowanceService.getInstance().record({
                            chainId: network?.id ?? 1,
                            token: transaction.to,
                            spender,
                            owner: from,
                            lastApproved: amount.toString(),
                        });
                    }
                }
            }
        } catch (e) {
            console.warn('[RpcHandler] failed to record allowance:', e);
        }
        return hash;
    }

    private stripHex(hex: string): string {
        return hex.startsWith('0x') ? hex.slice(2) : hex;
    }

    private hexToBytes(hex: string): Uint8Array {
        const h = this.stripHex(hex);
        const out = new Uint8Array(h.length / 2);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private bytesToHex(bytes: Uint8Array): string {
        let s = '';
        for (const b of bytes) s += b.toString(16).padStart(2, '0');
        return s;
    }

    /**
     * Ext-4-confirm: called from messageHandlers.handleApproveMessageSignature
     * after the user clicks Sign/Reject in the popup's SignatureRequest
     * component. This is where the actual createSigningSession call
     * happens — deferred from handleSignMessageRequest so users get
     * to review origin + message first.
     *
     * On approve:
     *   - Pull stashed context from pendingDappRequests.
     *   - Call sessionManager.createSigningSession (real announce).
     *   - Re-key the pending promise from the placeholder requestId
     *     to the actual session_id, so when stateManager.signingComplete
     *     later fires with that session_id, handleSignatureComplete
     *     finds the right pending entry.
     *
     * On reject:
     *   - Reject the pending promise with "User rejected".
     *   - Clean up pendingDappRequests.
     */
    async approveDappSignature(
        requestId: string,
        approved: boolean,
    ): Promise<{ success: boolean; error?: string; sessionId?: string }> {
        const context = this.pendingDappRequests.get(requestId);
        if (!context) {
            return {
                success: false,
                error: `No pending dApp signature request ${requestId}`,
            };
        }
        this.pendingDappRequests.delete(requestId);
        // Cancel any pending notification — user engaged with the
        // popup, no need to keep the OS banner up.
        if (typeof chrome !== 'undefined' && chrome.notifications) {
            try {
                chrome.notifications.clear(`mpc-dapp-sig:${requestId}`);
            } catch {
                /* non-fatal */
            }
        }

        if (!approved) {
            this.handleSignatureError(requestId, 'User rejected signature request');
            return { success: true };
        }

        if (!this.sessionManager) {
            this.handleSignatureError(
                requestId,
                'SessionManager not initialized',
            );
            return { success: false, error: 'SessionManager not initialized' };
        }

        const result = await this.sessionManager.createSigningSession({
            walletId: context.walletId,
            walletName: context.walletName,
            groupPublicKey: context.groupPublicKey,
            blockchain: context.blockchain,
            threshold: context.threshold,
            total: context.total,
            signingMessageHex: context.messageHex,
        });
        if (!result.success || !result.sessionId) {
            this.handleSignatureError(
                requestId,
                result.error ?? 'Failed to create signing session',
            );
            return {
                success: false,
                error: result.error ?? 'Failed to create signing session',
            };
        }

        // Re-key the pending promise from the placeholder requestId
        // to the actual session id. signingComplete from stateManager
        // will arrive with the session id, not the requestId.
        const pending = this.pendingSignatures.get(requestId);
        if (pending) {
            this.pendingSignatures.delete(requestId);
            this.pendingSignatures.set(result.sessionId, pending);
        }
        return { success: true, sessionId: result.sessionId };
    }

    /**
     * Handle eth_getTransactionCount request
     */
    private async handleGetTransactionCountRequest(params: unknown[]): Promise<string> {
        if (!params || params.length < 1) {
            throw new Error('Missing address parameter');
        }

        const address = params[0] as string;
        // WalletClientService.getTransactionCount() returns number, convert to string
        const count = await this.walletClientService.getTransactionCount(address);
        return count.toString();
    }

    /**
     * Handle eth_gasPrice request
     */
    private async handleGasPriceRequest(): Promise<string> {
        return await this.walletClientService.getGasPrice();
    }

    /**
     * Handle eth_estimateGas request
     */
    private async handleEstimateGasRequest(params: unknown[]): Promise<string> {
        if (!params || params.length < 1) {
            throw new Error('Missing transaction parameters');
        }

        const transaction = params[0] as any;
        return await this.walletClientService.estimateGas(transaction);
    }

    /**
     * Generic RPC request method that can be used by other modules
     */
    async makeRpcRequest(request: JsonRpcRequest): Promise<unknown> {
        // For now, just delegate to handleRpcRequest
        return this.handleRpcRequest(request);
    }

    /**
     * Check if a method is read-only and should be forwarded to RPC provider
     */
    private isReadOnlyMethod(method: string): boolean {
        const readOnlyMethods = [
            'eth_blockNumber',
            'eth_getBlockByHash',
            'eth_getBlockByNumber',
            'eth_getTransactionByHash',
            'eth_getTransactionReceipt',
            'eth_getBlockTransactionCountByHash',
            'eth_getBlockTransactionCountByNumber',
            'eth_getUncleCountByBlockHash',
            'eth_getUncleCountByBlockNumber',
            'eth_getCode',
            'eth_call',
            'eth_getLogs',
            'eth_getFilterChanges',
            'eth_getFilterLogs',
            'eth_newFilter',
            'eth_newBlockFilter',
            'eth_newPendingTransactionFilter',
            'eth_uninstallFilter',
            'eth_getStorageAt',
            'eth_getProof',
            'eth_feeHistory',
            'eth_maxPriorityFeePerGas'
        ];
        
        return readOnlyMethods.includes(method);
    }

    /**
     * Forward RPC request to the network's RPC provider
     */
    private async forwardToRpcProvider(request: JsonRpcRequest): Promise<any> {
        try {
            const network = this.networkService.getCurrentNetwork();
            if (!network || !network.rpcUrls?.default?.http?.[0]) {
                throw new Error('No RPC URL available for current network');
            }

            const rpcUrl = network.rpcUrls.default.http[0];
            console.log(`[RpcHandler] Forwarding ${request.method} to RPC provider: ${rpcUrl}`);

            const response = await fetch(rpcUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: request.id || 1,
                    method: request.method,
                    params: request.params || []
                })
            });

            if (!response.ok) {
                throw new Error(`RPC request failed with status ${response.status}`);
            }

            const result = await response.json();
            
            if (result.error) {
                throw new Error(result.error.message || 'RPC request failed');
            }

            return result.result;
        } catch (error) {
            console.error(`[RpcHandler] Failed to forward to RPC provider:`, error);
            throw error;
        }
    }

    /**
     * Handle signature completion from either the legacy
     * `messageSignatureComplete` path (offscreen DkgManager output,
     * keyed by `msg_<ts>_<nonce>`) or the Ext-4 `signingComplete`
     * path (FROST aggregated signature, keyed by `sign_<hex>`
     * session id). Normalizes the hex to `0x...` before resolving
     * so dApp callers can feed it straight into ecrecover /
     * verifyMessage without additional formatting.
     */
    handleSignatureComplete(signingId: string, signature: string): void {
        const pending = this.pendingSignatures.get(signingId);
        if (pending) {
            const normalized = signature.startsWith('0x')
                ? signature
                : `0x${signature}`;
            pending.resolve(normalized);
            this.pendingSignatures.delete(signingId);
        }
    }

    /**
     * Handle signature error from offscreen document
     */
    handleSignatureError(signingId: string, error: string): void {
        const pending = this.pendingSignatures.get(signingId);
        if (pending) {
            pending.reject(new Error(error));
            this.pendingSignatures.delete(signingId);
        }
    }
}

/**
 * Handles UI requests from the popup interface
 */
export class UIRequestHandler {
    private walletController: WalletController;

    constructor() {
        this.walletController = WalletController.getInstance();
    }

    /**
     * Handle UI requests from popup
     */
    async handleUIRequest(request: { method: string; params: unknown[] }): Promise<{ success: boolean; data?: unknown; error?: string }> {
        const { method, params } = request;

        console.log(`[UIRequestHandler] Processing UI request: ${method}`);

        if (typeof this.walletController[method as keyof WalletController] === 'function') {
            try {
                const result = await (this.walletController[method as keyof WalletController] as (...args: unknown[]) => unknown)(...params);
                return { success: true, data: result };
            } catch (error) {
                console.error(`[UIRequestHandler] UI request failed: ${method}`, error);
                return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
            }
        }

        return { success: false, error: `Method ${method} not found on WalletController` };
    }
}
