import { defineUnlistedScript } from '#imports';
import { MESSAGE_PREFIX, MessageType, WALLET_INFO } from '../../constants';
import { v4 as uuidv4 } from 'uuid';
import { registerStarlabSolanaWallet } from './solana/register';

// EIP6963 types
interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  description?: string;
}

interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: any; // Provider following EIP-1193 standard
}

// Convert icon to data URI
const iconUrl = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4IiByeD0iNjQiIGZpbGw9IiM2MzY2RjEiLz4KPHBhdGggZD0iTTY3LjQyIDE4LjAyNUM2OC4xNzk0IDE4LjAyNSA2OC43OTUgMTguNjQwOCA2OC43OTUgMTkuNFY0MS42QzY4Ljc5NSA0Mi4zNTkyIDY4LjE3OTQgNDIuOTc1IDY3LjQyIDQyLjk3NUg2MC41OEM2MC4yMDQgNDIuOTc1IDU5Ljg0MzggNDIuODIyIDU5LjU3NzQgNDIuNTU1NkM1OS4zMTEgNDIuMjg5NCA1OS4xNTggNDEuOTI5MiA1OS4xNTggNDEuNTUzVjE5LjQwMkM1OS4xNTggMTkuMDI1OCA1OS4zMTEgMTguNjY1NiA1OS41Nzc0IDE4LjM5OTJDNTkuODQzOCAxOC4xMzI4IDYwLjIwNCAxNy45OCA2MC41OCAxNy45OEw2Ny40MiAxOC4wMjVaTTQyLjk3NSAxOS40MDNDNDIuOTc1IDE4LjY0MzggNDMuNTkwOCAxOC4wMjgxIDQ0LjM1IDE4LjAyODFINTEuMTYzNEM1MS45MjI2IDE4LjAyODEgNTIuNTM4NCAxOC42NDM4IDUyLjUzODQgMTkuNDAzVjQ4LjQ0QzUyLjUzODQgNDguODE2MSA1Mi4zODUzIDQ5LjE3NjIgNTIuMTE4OSA0OS40NDI1QzUxLjg1MjUgNDkuNzA4OSA1MS40OTI0IDQ5Ljg2MiA1MS4xMTYzIDQ5Ljg2MkM1MC43NDAyIDQ5Ljg2MiA1MC4zODAxIDQ5LjcwODkgNTAuMTEzOCA0OS40NDI1QzQ5Ljg0NzQgNDkuMTc2MiA0OS42OTQzIDQ4LjgxNjEgNDkuNjk0MyA0OC40NFYyMC44NzJINDUuOTE5VjQ4LjQ0QzQ1LjkxOSA0OS4xOTkyIDQ1LjMwMzIgNDkuODE1IDQ0LjU0NCA0OS44MTVDNDMuNzg0OCA0OS44MTUgNDMuMTY5IDQ5LjE5OTIgNDMuMTY5IDQ4LjQ0VjE5LjQwM0g0Mi45NzVaTTg0Ljk0IDE5LjM0NzhDODQuOTQgMTguNTg4NiA4NS41NTU4IDE3Ljk3MjggODYuMzE1IDE3Ljk3MjhIOTMuMDlDOTMuODQ5MiAxNy45NzI4IDk0LjQ2NSAxOC41ODg2IDk0LjQ2NSAxOS4zNDc4VjI3Ljk3SDEwMy4wOUMxMDMuODQ5IDI3Ljk3IDEwNC40NjUgMjguNTg1OCAxMDQuNDY1IDI5LjM0NVYzNS45N0MxMDQuNDY1IDM2LjcyOTIgMTAzLjg0OSAzNy4zNDUgMTAzLjA5IDM3LjM0NUg5NC40NjVWNDEuNTUzQzk0LjQ2NSA0Mi4zMTIyIDkzLjg0OTIgNDIuOTI4IDkzLjA5IDQyLjkyOEg4Ni4zMTVDODUuNTU1OCA0Mi45MjggODQuOTQgNDIuMzEyMiA4NC45NCA0MS41NTNWMzcuMzQ1SDc1Ljk2QzQyLjk3NSAzNy4zNDUgNDMuMDM0MyAxMDQuMzYgNzUuOTYgMTA0LjM2SDg0LjY2NVY5OS4wOUg3NS45NkM0OS45OTU4IDk5LjA5IDQ4LjI0NSA0Mi42MTUgNzUuOTYgNDIuNjE1SDg0Ljk0VjQxLjU1M1YxOS4zNDc4WiIgZmlsbD0id2hpdGUiLz4KPC9zdmc+Cg==';
// Network information for Ethereum mainnet
const ETHEREUM_MAINNET = {
    chainId: '0x1',
    chainIdDecimal: 1,
    networkVersion: '1',
    name: 'Ethereum Mainnet',
    rpcUrl: 'https://mainnet.infura.io/v3/',
    blockExplorerUrl: 'https://etherscan.io',
    ticker: 'ETH',
    tickerName: 'Ethereum'
};

/**
 * EIP-1193 ProviderRpcError from a JSON-RPC error payload, keeping `code`
 * (e.g. 4001 user rejected) so dApps can tell a reject from a failure.
 */
function toProviderError(error: unknown): Error & { code: number; data?: unknown } {
    const obj = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
    const message =
        typeof error === 'string' ? error :
        typeof obj?.message === 'string' ? obj.message :
        'Unknown error';
    const err = new Error(message) as Error & { code: number; data?: unknown };
    err.code = typeof obj?.code === 'number' ? obj.code : -32603;
    if (obj && 'data' in obj) err.data = obj.data;
    return err;
}

class PageProvider {
    private requestIdCounter = 0;
    private pendingRequests = new Map<number | string, (response: any) => void>();
    private eventHandlers: { [event: string]: Set<(params: any) => void> } = {};
    
    // Network properties
    public chainId: string = ETHEREUM_MAINNET.chainId;
    public networkVersion: string = ETHEREUM_MAINNET.networkVersion;
    public _chainId: string = ETHEREUM_MAINNET.chainId; // For legacy compatibility
    public _networkVersion: string = ETHEREUM_MAINNET.networkVersion; // For legacy compatibility
    public networkName: string = ETHEREUM_MAINNET.name;
    public ticker: string = ETHEREUM_MAINNET.ticker;
    public tickerName: string = ETHEREUM_MAINNET.tickerName;
    
    // Network info accessible as a property
    public readonly networkInfo = ETHEREUM_MAINNET;
    
    constructor() {
        // Add message listener to receive responses from content script
        window.addEventListener('message', this.handleContentScriptMessage);
        
        // Initialize event handlers storage
        this.eventHandlers = {
            'accountsChanged': new Set(),
            'chainChanged': new Set(),
            'connect': new Set(),
            'disconnect': new Set(),
            'message': new Set()
        };
    }

    // Handle messages from content script
    private handleContentScriptMessage = (event: MessageEvent) => {
        // Safety check: ensure message is from current window
        if (event.source !== window) return;

        const data = event.data;

        // Validate message format
        if (
            data &&
            typeof data === 'object' &&
            data.type === `${MESSAGE_PREFIX}${MessageType.RESPONSE}` &&
            data.payload
        ) {
            const response = data.payload;
            const callback = this.pendingRequests.get(response.id);

            if (callback) {
                callback(response);
                this.pendingRequests.delete(response.id);
            }
        }
    };

    // EIP-1193 required methods
    request = (args: { method: string, params?: unknown[] | object }): Promise<unknown> => {
        console.log(`[Injected Provider] Request called with method: ${args.method}`, args);

        return new Promise((resolve, reject) => {
            const id = this.requestIdCounter++;
            const request = {
                id,
                jsonrpc: '2.0',
                method: args.method,
                params: args.params || []
            };

            this.pendingRequests.set(id, (response: any) => {
                console.log(`[Injected Provider] Received response for ${args.method}:`, response);

                if (response.error) {
                    reject(toProviderError(response.error));
                    return;
                }

                // Account methods go through the wallet's per-origin connect
                // approval; cache what it returned for the sync legacy `send`.
                if ((args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') &&
                    Array.isArray(response.result)) {
                    this.updateAccounts(response.result as string[]);
                    if (args.method === 'eth_requestAccounts') {
                        this.emit('connect', { chainId: this.chainId || '0x1' });
                    }
                }
                resolve(response.result);
            });

            window.postMessage(
                {
                    type: `${MESSAGE_PREFIX}${MessageType.REQUEST}`,
                    payload: request
                },
                '*'
            );
        });
    };

    /** Cache accounts and emit accountsChanged when they differ. */
    private updateAccounts(accounts: string[]): void {
        const previous = this.cachedAccounts ?? [];
        this.cachedAccounts = accounts;
        const changed =
            previous.length !== accounts.length || previous.some((a, i) => a !== accounts[i]);
        if (changed) {
            this.emit('accountsChanged', accounts);
        }
    }

    // EIP-1193 required event methods
    on(eventName: string, listener: (params: any) => void): void {
        if (!this.eventHandlers[eventName]) {
            this.eventHandlers[eventName] = new Set();
        }
        this.eventHandlers[eventName].add(listener);
    }

    removeListener(eventName: string, listener: (params: any) => void): void {
        if (this.eventHandlers[eventName]) {
            this.eventHandlers[eventName].delete(listener);
        }
    }

    // Helper to emit events to listeners
    emit(eventName: string, params: any): void {
        if (this.eventHandlers[eventName]) {
            this.eventHandlers[eventName].forEach(listener => {
                try {
                    listener(params);
                } catch (error) {
                    console.error(`Error in ${eventName} listener:`, error);
                }
            });
        }
    }

    // Clean up when PageProvider is destroyed

    // Last accounts the wallet returned for this origin (only ever what
    // the user approved). Read by the legacy synchronous `send` shim.
    cachedAccounts: string[] | null = null;
    cachedChainId: string | null = null;
    
    // Network-related methods
    getChainId = async (): Promise<string> => {
        if (this.cachedChainId) {
            return this.cachedChainId;
        }
        
        try {
            console.log('[Injected Provider] Requesting chain ID from background');
            const result = await this.request({ method: 'eth_chainId' });
            if (typeof result === 'string') {
                this.cachedChainId = result;
                this.chainId = result;
                this._chainId = result;
                console.log('[Injected Provider] Received chain ID:', result);
                return result;
            }
        } catch (error) {
            console.error('[Injected Provider] Error getting chain ID:', error);
        }
        
        return this.chainId; // Return default if we couldn't get it
    };
    
    // Legacy method for compatibility
    getNetworkVersion = async (): Promise<string> => {
        try {
            const result = await this.request({ method: 'net_version' });
            if (typeof result === 'string') {
                this.networkVersion = result;
                this._networkVersion = result;
                return result;
            }
        } catch (error) {
            console.error('[Injected Provider] Error getting network version:', error);
        }
        
        return this.networkVersion; // Return default
    };
    
    // Get accounts method - required by many dapps. Returns only accounts the
    // user has connected to this origin (empty until they approve a connect).
    getAccounts = async (): Promise<string[]> => {
        const result = await this.request({ method: 'eth_accounts' });
        return Array.isArray(result) ? (result as string[]) : [];
    };

    // For compatibility with legacy web3.js
    isConnected = (): boolean => {
        return true; // Always return true as per most wallet providers
    };
    
    disconnect(): void {
        window.removeEventListener('message', this.handleContentScriptMessage);
        // Clear all event handlers
        for (const key in this.eventHandlers) {
            this.eventHandlers[key].clear();
        }
    }
}

export default defineUnlistedScript(() => {
    // Define the provider object with additional standard properties
    interface Window {
        ethereum: any;
    }
    const info = {
        uuid: uuidv4(),
        name: WALLET_INFO.name,
        icon: iconUrl,
        rdns: 'org.starlab.wallet',
        description: WALLET_INFO.description
    };

    // Initialize provider with window.ethereum properties
    const provider = new PageProvider();
    
    console.log('[Injected Provider] Initializing Starlab Wallet provider');
    
    // Pick up accounts this origin is already connected to (never prompts;
    // empty until the user approves a connect request).
    provider.getAccounts().catch(error => {
        console.warn('[Injected Provider] Failed to read connected accounts:', error);
    });

    // Typed as `any` so we can attach EIP-1193-legacy properties
    // (sendAsync, send, networkVersion, isStarLabWallet, _chainId,
    // _metamask) that aren't on PageProvider's declared surface but
    // are expected by MetaMask-style dApp compatibility shims.
    const injectedProvider: any = new Proxy(provider, {
        deleteProperty: (target, prop) => {
            if (typeof prop === 'string' && ['on'].includes(prop)) {
                // @ts-ignore
                delete target[prop];
            }
            return true;
        },
        get: (target, prop, receiver) => {
            const method = target[prop as keyof PageProvider];
            if (typeof method === 'function') {
                return (...args: any[]) => {
                    // @ts-ignore
                    return method.apply(target, args);
                };
            }

            return Reflect.get(target, prop, receiver);
        },
    });

    const createAndDispatchEvent = (e?: Event) => {
        try {
            // Create EIP6963ProviderDetail object
            const providerDetail: EIP6963ProviderDetail = {
                info: info,
                provider: injectedProvider
            };
            
            // Create and dispatch the event with frozen detail object
            const event = new CustomEvent(
                'eip6963:announceProvider',
                { detail: Object.freeze(providerDetail) }
            );
            window.dispatchEvent(event);
            console.log('EIP6963 provider announced:', info.name, info.rdns);
        } catch (error) {
            console.error('Failed to dispatch EIP6963 event:', error);
        }
    };

    // Add standard properties to the provider
    // These are common properties expected by many dapps
    injectedProvider.isStarLabWallet = true;
    
    // Add additional properties for compatibility with MetaMask test dapp
    injectedProvider.networkVersion = provider.networkVersion;
    injectedProvider._chainId = provider.chainId; // Some dapps check for this property
    injectedProvider.chainId = provider.chainId;
    injectedProvider._metamask = { isUnlocked: async () => true }; // For compatibility
    
    // For MetaMask test dapp specifically
    injectedProvider.sendAsync = (request: any, callback: any) => {
        console.log('[Injected Provider] sendAsync called with:', request);
        provider.request(request)
            .then(result => callback(null, { id: request.id, jsonrpc: '2.0', result }))
            .catch(error => callback(error, null));
    };
    
    // Legacy send method
    injectedProvider.send = (methodOrPayload: any, paramsOrCallback: any) => {
        console.log('[Injected Provider] send called with:', methodOrPayload, paramsOrCallback);
        // Handle as a synchronous RPC call
        if (typeof methodOrPayload === 'string' && Array.isArray(paramsOrCallback)) {
            const method = methodOrPayload;
            const params = paramsOrCallback;
            return provider.request({ method, params });
        }
        // Handle as a legacy async call with callback
        else if (typeof paramsOrCallback === 'function') {
            return injectedProvider.sendAsync(methodOrPayload, paramsOrCallback);
        }
        // Handle as a synchronous call with payload
        else {
            const payload = methodOrPayload;
            // Explicit result type (any) so later assignments of
            // string / string[] / null all type-check — initializing
            // with `null` alone would infer \`result: null\` and
            // reject everything else.
            const response: { id: any; jsonrpc: string; result: any } = {
                id: payload.id,
                jsonrpc: '2.0',
                result: null,
            };
            
            // For simple synchronous methods
            if (payload.method === 'eth_accounts') {
                response.result = provider.cachedAccounts || [];
            } else if (payload.method === 'eth_coinbase') {
                response.result = (provider.cachedAccounts && provider.cachedAccounts[0]) || null;
            } else if (payload.method === 'eth_chainId') {
                response.result = provider.chainId;
            } else if (payload.method === 'net_version') {
                response.result = provider.networkVersion;
            } else {
                throw new Error(`Synchronous RPC method ${payload.method} not supported`);
            }
            
            return response;
        }
    };
    
    // ONLY make our provider accessible as window.starlabEthereum
    Object.defineProperty(window, 'starlabEthereum', {
        value: injectedProvider,
        writable: false,
        configurable: true
    });
    
    // Listen for EIP6963 provider request events
    window.addEventListener('eip6963:requestProvider', createAndDispatchEvent);

    // Announce the provider on page load
    setTimeout(createAndDispatchEvent, 0);

    // Also register on the Solana side (wallet-standard) so Solana dApps
    // discover Starlab alongside the EVM EIP-6963 provider. Routes through
    // the same page→content→background bridge; signing lands on FROST ed25519.
    try {
        registerStarlabSolanaWallet();
    } catch (e) {
        console.warn('[Injected] Solana wallet-standard registration failed:', e);
    }

    return injectedProvider;
});
