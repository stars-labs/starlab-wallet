import {
    arbitrum,
    arbitrumSepolia,
    base,
    baseSepolia,
    mainnet,
    optimism,
    optimismSepolia,
    polygon,
    polygonAmoy,
    sepolia,
} from "viem/chains";
import type { Chain } from "@stars-labs/types/network";
import type {
    ProtocolBlockchain,
    SupportedChain,
} from "@stars-labs/types/appstate";
import {
    SUPPORTED_CHAINS,
    getProtocolBlockchainForChain,
    isEvmChain,
    isSupportedChain,
} from "@stars-labs/types/appstate";
import { createPublicClient, http } from "viem";

type LegacyBlockchain = ProtocolBlockchain;
type NetworkStore = Record<SupportedChain, Chain[]>;
type CurrentNetworkStore = Partial<Record<SupportedChain, Chain | undefined>>;
type NetworkChangeCallback = (network: Chain | undefined) => void;

const NETWORK_KEYS = [...SUPPORTED_CHAINS] as SupportedChain[];

const SOLANA_MAINNET: Chain = {
    id: 101,
    name: "Solana Mainnet",
    network: "solana-mainnet",
    nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 },
    rpcUrls: {
        default: { http: ["https://api.mainnet-beta.solana.com"] },
        public: { http: ["https://api.mainnet-beta.solana.com"] },
    },
    blockExplorers: {
        default: { name: "Solscan", url: "https://solscan.io" },
    },
};

const SOLANA_DEVNET: Chain = {
    id: 102,
    name: "Solana Devnet",
    network: "solana-devnet",
    nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 },
    rpcUrls: {
        default: { http: ["https://api.devnet.solana.com"] },
        public: { http: ["https://api.devnet.solana.com"] },
    },
    blockExplorers: {
        default: { name: "Solscan", url: "https://solscan.io/?cluster=devnet" },
    },
    testnet: true,
};

class NetworkService {
    private static instance: NetworkService;
    private networks: NetworkStore = NetworkService.emptyNetworkStore();
    private currentBlockchain: LegacyBlockchain = "ethereum";
    private currentChain: SupportedChain = "ethereum";
    private currentNetworks: CurrentNetworkStore = {};
    private readonly STORAGE_KEY = "wallet_networks";
    private readonly CURRENT_NETWORK_KEY = "wallet_current_networks";
    private readonly CURRENT_BLOCKCHAIN_KEY = "wallet_current_blockchain";
    private readonly CURRENT_CHAIN_KEY = "wallet_current_chain";
    private changeCallbacks: NetworkChangeCallback[] = [];
    private initialized = false;

    private static readonly PROTECTED_NETWORK_IDS: Record<SupportedChain, number[]> = {
        ethereum: [mainnet.id, sepolia.id],
        polygon: [polygon.id, polygonAmoy.id],
        arbitrum: [arbitrum.id, arbitrumSepolia.id],
        optimism: [optimism.id, optimismSepolia.id],
        base: [base.id, baseSepolia.id],
        solana: [SOLANA_MAINNET.id, SOLANA_DEVNET.id],
        bitcoin: [],
        sui: [],
    };

    private constructor() {
        this.initializeAsync();
    }

    public static getInstance(): NetworkService {
        if (!NetworkService.instance) {
            NetworkService.instance = new NetworkService();
        }
        return NetworkService.instance;
    }

    public static resetInstance(): void {
        NetworkService.instance = undefined as any;
    }

    private static emptyNetworkStore(): NetworkStore {
        return NETWORK_KEYS.reduce((acc, chain) => {
            acc[chain] = [];
            return acc;
        }, {} as NetworkStore);
    }

    private static defaultCurrentStore(): CurrentNetworkStore {
        return {};
    }

    private async initializeAsync(): Promise<void> {
        if (!this.initialized) {
            await this.loadNetworks();
            this.initialized = true;
        }
    }

    public async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.initializeAsync();
        }
    }

    private isLegacyBlockchain(value: unknown): value is LegacyBlockchain {
        return value === "ethereum" || value === "solana";
    }

    private normalizeChain(value: unknown, fallback: SupportedChain = "ethereum"): SupportedChain {
        return isSupportedChain(value) ? value : fallback;
    }

    private chainFromNetworkId(chainId: number): SupportedChain | undefined {
        for (const chain of NETWORK_KEYS) {
            if (NetworkService.PROTECTED_NETWORK_IDS[chain].includes(chainId)) {
                return chain;
            }
        }
        return undefined;
    }

    private addNetworkInMemory(chain: SupportedChain, network: Chain): void {
        if (!this.networks[chain].some((n) => n.id === network.id)) {
            this.networks[chain].push(network);
        }
    }

    private normalizeStoredNetworks(storedNetworks: unknown): NetworkStore {
        const next = NetworkService.emptyNetworkStore();
        if (!storedNetworks || typeof storedNetworks !== "object") return next;

        const stored = storedNetworks as Record<string, unknown>;
        for (const chain of NETWORK_KEYS) {
            const value = stored[chain];
            if (Array.isArray(value)) {
                for (const network of value) {
                    if (network && typeof network === "object" && typeof (network as Chain).id === "number") {
                        this.addNetworkTo(next, chain, network as Chain);
                    }
                }
            }
        }

        // Migration: older builds only stored ethereum/solana buckets. Known
        // L2 ids are copied into their product-chain buckets while unknown EVM
        // custom networks remain under Ethereum for legacy callers.
        const legacyEthereum = stored.ethereum;
        if (Array.isArray(legacyEthereum)) {
            for (const network of legacyEthereum) {
                if (!network || typeof network !== "object") continue;
                const typed = network as Chain;
                if (typeof typed.id !== "number") continue;
                const target = this.chainFromNetworkId(typed.id) ?? "ethereum";
                this.addNetworkTo(next, target, typed);
                this.addNetworkTo(next, "ethereum", typed);
            }
        }

        const legacySolana = stored.solana;
        if (Array.isArray(legacySolana)) {
            for (const network of legacySolana) {
                if (!network || typeof network !== "object") continue;
                const typed = network as Chain;
                if (typeof typed.id === "number") this.addNetworkTo(next, "solana", typed);
            }
        }

        return next;
    }

    private addNetworkTo(store: NetworkStore, chain: SupportedChain, network: Chain): void {
        if (!store[chain].some((n) => n.id === network.id)) {
            store[chain].push(network);
        }
    }

    private normalizeStoredCurrentNetworks(storedNetworks: unknown): CurrentNetworkStore {
        const next = NetworkService.defaultCurrentStore();
        if (!storedNetworks || typeof storedNetworks !== "object") return next;

        const stored = storedNetworks as Record<string, unknown>;
        for (const chain of NETWORK_KEYS) {
            const network = stored[chain] as Chain | undefined;
            if (network && typeof network.id === "number") {
                next[chain] = network;
            }
        }

        const legacyEthereum = stored.ethereum as Chain | undefined;
        if (legacyEthereum && typeof legacyEthereum.id === "number") {
            const target = this.chainFromNetworkId(legacyEthereum.id) ?? "ethereum";
            next[target] = legacyEthereum;
            next.ethereum ??= legacyEthereum;
        }

        const legacySolana = stored.solana as Chain | undefined;
        if (legacySolana && typeof legacySolana.id === "number") {
            next.solana = legacySolana;
        }

        return next;
    }

    private async loadNetworks(): Promise<void> {
        try {
            if (typeof chrome !== "undefined" && chrome.storage) {
                const result = await chrome.storage.local.get([
                    this.STORAGE_KEY,
                    this.CURRENT_BLOCKCHAIN_KEY,
                    this.CURRENT_CHAIN_KEY,
                    this.CURRENT_NETWORK_KEY,
                ]);

                this.networks = this.normalizeStoredNetworks(result[this.STORAGE_KEY]);
                this.currentNetworks = this.normalizeStoredCurrentNetworks(
                    result[this.CURRENT_NETWORK_KEY],
                );

                const storedBlockchain = result[this.CURRENT_BLOCKCHAIN_KEY];
                this.currentBlockchain = this.isLegacyBlockchain(storedBlockchain)
                    ? storedBlockchain
                    : "ethereum";

                const storedChain = result[this.CURRENT_CHAIN_KEY];
                this.currentChain = this.normalizeChain(
                    storedChain,
                    this.currentBlockchain === "solana" ? "solana" : "ethereum",
                );
            } else {
                this.networks = NetworkService.emptyNetworkStore();
                this.currentBlockchain = "ethereum";
                this.currentChain = "ethereum";
                this.currentNetworks = NetworkService.defaultCurrentStore();
            }
        } catch (error) {
            console.error("Failed to load networks:", error);
            this.networks = NetworkService.emptyNetworkStore();
            this.currentBlockchain = "ethereum";
            this.currentChain = "ethereum";
            this.currentNetworks = NetworkService.defaultCurrentStore();
        }

        let mutatedNetworks = false;
        let mutatedCurrent = false;
        for (const chain of NETWORK_KEYS) {
            for (const network of this.getDefaultNetworks(chain)) {
                const before = this.networks[chain].length;
                this.addNetworkInMemory(chain, network);
                mutatedNetworks ||= this.networks[chain].length !== before;
            }

            const current = this.currentNetworks[chain];
            if (current) {
                const canonical = this.networks[chain].find((n) => n.id === current.id);
                if (canonical) {
                    this.currentNetworks[chain] = canonical;
                    continue;
                }
            }

            if (this.networks[chain][0]) {
                this.currentNetworks[chain] = this.networks[chain][0];
                mutatedCurrent = true;
            }
        }

        if (!isSupportedChain(this.currentChain)) {
            this.currentChain = "ethereum";
        }
        this.currentBlockchain = getProtocolBlockchainForChain(this.currentChain);

        if (mutatedNetworks) {
            await this.saveNetworks().catch(() => {});
        }
        if (mutatedCurrent) {
            await this.saveCurrentNetworks().catch(() => {});
        }
    }

    private chainFromViem(source: any, fallbackNetwork: string): Chain {
        const defaultHttp = [...((source.rpcUrls?.default?.http ?? []) as readonly string[])];
        const publicHttp = [...((source.rpcUrls?.public?.http ?? defaultHttp) as readonly string[])];
        const explorer = source.blockExplorers?.default;
        return {
            id: source.id,
            name: source.name,
            network: source.network ?? fallbackNetwork,
            nativeCurrency: source.nativeCurrency
                ? {
                      name: source.nativeCurrency.name,
                      symbol: source.nativeCurrency.symbol,
                      decimals: source.nativeCurrency.decimals,
                  }
                : undefined,
            rpcUrls: {
                default: { http: defaultHttp },
                public: { http: publicHttp },
            },
            blockExplorers: explorer
                ? {
                      default: {
                          name: explorer.name,
                          url: explorer.url,
                      },
                  }
                : undefined,
            testnet: source.testnet,
        };
    }

    private getDefaultNetworks(chain: SupportedChain): Chain[] {
        switch (chain) {
            case "ethereum":
                return [
                    this.chainFromViem(mainnet, "mainnet"),
                    this.chainFromViem(sepolia, "sepolia"),
                ];
            case "polygon":
                return [
                    this.chainFromViem(polygon, "polygon"),
                    this.chainFromViem(polygonAmoy, "polygon-amoy"),
                ];
            case "arbitrum":
                return [
                    this.chainFromViem(arbitrum, "arbitrum-one"),
                    this.chainFromViem(arbitrumSepolia, "arbitrum-sepolia"),
                ];
            case "optimism":
                return [
                    this.chainFromViem(optimism, "optimism"),
                    this.chainFromViem(optimismSepolia, "optimism-sepolia"),
                ];
            case "base":
                return [
                    this.chainFromViem(base, "base"),
                    this.chainFromViem(baseSepolia, "base-sepolia"),
                ];
            case "solana":
                return [SOLANA_MAINNET, SOLANA_DEVNET];
            case "bitcoin":
            case "sui":
                return [];
        }
    }

    private async saveNetworks(): Promise<void> {
        if (typeof chrome !== "undefined" && chrome.storage) {
            await chrome.storage.local.set({ [this.STORAGE_KEY]: this.networks });
        }
    }

    private async saveCurrentNetworks(): Promise<void> {
        if (typeof chrome !== "undefined" && chrome.storage) {
            await chrome.storage.local.set({ [this.CURRENT_NETWORK_KEY]: this.currentNetworks });
        }
    }

    private async saveCurrentBlockchain(): Promise<void> {
        try {
            if (typeof chrome !== "undefined" && chrome.storage) {
                await chrome.storage.local.set({
                    [this.CURRENT_BLOCKCHAIN_KEY]: this.currentBlockchain,
                    [this.CURRENT_CHAIN_KEY]: this.currentChain,
                });
            }
        } catch (error) {
            console.error("Failed to save current blockchain:", error);
        }
    }

    public async addCustomNetwork(blockchain: LegacyBlockchain, network: Chain): Promise<void> {
        return this.addNetwork(blockchain, network);
    }

    public async removeCustomNetwork(blockchain: LegacyBlockchain, chainId: number): Promise<void> {
        return this.removeNetwork(blockchain, chainId);
    }

    public async addNetwork(blockchain: LegacyBlockchain, network: Chain): Promise<void> {
        return this.addNetworkForChain(blockchain, network);
    }

    public async removeNetwork(blockchain: LegacyBlockchain, chainId: number): Promise<void> {
        return this.removeNetworkForChain(blockchain, chainId);
    }

    public async updateNetwork(blockchain: LegacyBlockchain, network: Chain): Promise<void> {
        return this.updateNetworkForChain(blockchain, network);
    }

    public getNetworks(): NetworkStore;
    public getNetworks(blockchain: LegacyBlockchain): Chain[];
    public getNetworks(blockchain?: LegacyBlockchain): Chain[] | NetworkStore {
        if (blockchain) {
            return this.networks[blockchain];
        }
        return this.networks;
    }

    public getNetwork(blockchain: LegacyBlockchain, chainId: number): Chain | undefined {
        return this.networks[blockchain].find((n) => n.id === chainId);
    }

    public getAllNetworks(): Chain[] {
        return NETWORK_KEYS.flatMap((chain) => this.networks[chain]);
    }

    public getNetworkByChainId(chainId: number): Chain | undefined {
        for (const chain of NETWORK_KEYS) {
            const network = this.networks[chain].find((n) => n.id === chainId);
            if (network) return network;
        }
        return undefined;
    }

    public getNetworkRPCUrls(network: Chain): string[] {
        if (!network.rpcUrls) return [];
        const defaultHttp = network.rpcUrls.default?.http ?? [];
        const publicHttp = network.rpcUrls.public?.http ?? [];
        return [...defaultHttp, ...publicHttp];
    }

    public networkExists(chainId: number): boolean {
        return NETWORK_KEYS.some((chain) => this.networks[chain].some((n) => n.id === chainId));
    }

    public getCurrentNetwork(blockchain?: LegacyBlockchain): Chain | undefined {
        if (blockchain) {
            return this.currentNetworks[blockchain];
        }
        return this.currentNetworks[this.currentChain];
    }

    public getCurrentBlockchain(): LegacyBlockchain {
        return this.currentBlockchain;
    }

    public getCurrentChain(): SupportedChain {
        return this.currentChain;
    }

    public async setCurrentBlockchain(blockchain: LegacyBlockchain): Promise<void> {
        await this.setCurrentChain(blockchain);
    }

    public async setCurrentChain(chain: SupportedChain): Promise<void> {
        this.currentChain = chain;
        this.currentBlockchain = getProtocolBlockchainForChain(chain);
        await this.saveCurrentBlockchain();
        this.notifyNetworkChange(this.currentNetworks[chain]);
    }

    public async setCurrentNetwork(blockchain: LegacyBlockchain, chainId: number): Promise<void>;
    public async setCurrentNetwork(blockchain: LegacyBlockchain, network: Chain): Promise<void>;
    public async setCurrentNetwork(
        blockchain: LegacyBlockchain,
        chainIdOrNetwork: number | Chain,
    ): Promise<void> {
        const chainId =
            typeof chainIdOrNetwork === "number"
                ? chainIdOrNetwork
                : chainIdOrNetwork.id;
        const network = this.networks[blockchain].find((n) => n.id === chainId);
        if (!network) {
            throw new Error("Network not found");
        }

        this.currentNetworks[blockchain] = network;
        this.currentChain = blockchain;
        this.currentBlockchain = blockchain;
        await this.saveCurrentNetworks();
        await this.saveCurrentBlockchain();
        this.notifyNetworkChange(network);
    }

    public async clearNetworks(blockchain: LegacyBlockchain): Promise<void> {
        await this.clearNetworksForChain(blockchain);
    }

    public onNetworkChange(callback: NetworkChangeCallback): void {
        this.changeCallbacks.push(callback);
    }

    public offNetworkChange(callback: NetworkChangeCallback): void {
        this.removeNetworkChangeListener(callback);
    }

    public removeNetworkChangeListener(callback: NetworkChangeCallback): void {
        this.changeCallbacks = this.changeCallbacks.filter((cb) => cb !== callback);
    }

    private notifyNetworkChange(network: Chain | undefined): void {
        this.changeCallbacks.forEach((callback) => callback(network));
    }

    private publicClientCache: Map<number, ReturnType<typeof createPublicClient>> = new Map();

    public async testNetworkConnectivity(network: Chain): Promise<boolean> {
        try {
            const client = this.getPublicClient(network);
            await (client as any).getBlockNumber();
            return true;
        } catch {
            return false;
        }
    }

    public validateNetworkConfig(network: unknown): network is Chain {
        if (!network || typeof network !== "object") return false;
        const n = network as Partial<Chain>;
        if (typeof n.id !== "number") return false;
        if (typeof n.name !== "string" || n.name.length === 0) return false;
        if (!n.rpcUrls || !n.rpcUrls.default) return false;
        const http = n.rpcUrls.default.http;
        if (!Array.isArray(http) || http.length === 0) return false;
        return true;
    }

    public getPublicClient(network?: Chain): ReturnType<typeof createPublicClient> {
        const target = network ?? this.currentNetworks[this.currentChain];
        if (!target) {
            throw new Error("No current EVM network selected");
        }

        if (!network && !isEvmChain(this.currentChain)) {
            throw new Error("Public client is only available for EVM networks");
        }

        const cached = this.publicClientCache.get(target.id);
        if (cached) return cached;

        const viemChain: any = {
            id: target.id,
            name: target.name,
            network: target.network,
            nativeCurrency: target.nativeCurrency || {
                name: "Ether",
                symbol: "ETH",
                decimals: 18,
            },
            rpcUrls: target.rpcUrls || {
                default: { http: [] },
                public: { http: [] },
            },
            blockExplorers: target.blockExplorers,
        };

        const client = createPublicClient({
            chain: viemChain,
            transport: http(),
        }) as any;
        this.publicClientCache.set(target.id, client);
        return client;
    }

    public getNetworksForChain(chain: SupportedChain): Chain[] {
        return this.networks[chain];
    }

    public getCurrentNetworkForChain(chain: SupportedChain): Chain | undefined {
        return this.currentNetworks[chain];
    }

    public async setCurrentNetworkForChain(chain: SupportedChain, chainId: number): Promise<void> {
        const network = this.networks[chain].find((n) => n.id === chainId);
        if (!network) {
            throw new Error("Network not found");
        }

        this.currentNetworks[chain] = network;
        this.currentChain = chain;
        this.currentBlockchain = getProtocolBlockchainForChain(chain);
        await this.saveCurrentNetworks();
        await this.saveCurrentBlockchain();
        this.notifyNetworkChange(network);
    }

    public async addNetworkForChain(chain: SupportedChain, network: Chain): Promise<void> {
        if (!network || typeof network !== "object") {
            throw new Error("Invalid network: must be an object");
        }
        if (typeof network.id !== "number") {
            throw new Error("Invalid network: id is required and must be a number");
        }
        if (!network.name || typeof network.name !== "string") {
            throw new Error("Invalid network: name is required and must be a string");
        }
        if (this.networks[chain].some((n) => n.id === network.id)) {
            throw new Error("Network with this ID already exists");
        }

        this.networks[chain].push(network);
        await this.saveNetworks();
    }

    public async removeNetworkForChain(chain: SupportedChain, chainId: number): Promise<void> {
        const network = this.networks[chain].find((n) => n.id === chainId);
        if (!network) {
            throw new Error("Network not found");
        }

        if (NetworkService.PROTECTED_NETWORK_IDS[chain].includes(chainId)) {
            throw new Error("Cannot remove protected network");
        }

        this.networks[chain] = this.networks[chain].filter((n) => n.id !== chainId);

        if (this.currentNetworks[chain]?.id === chainId) {
            this.currentNetworks[chain] = this.networks[chain][0];
            await this.saveCurrentNetworks();
        }

        await this.saveNetworks();
    }

    public async updateNetworkForChain(chain: SupportedChain, network: Chain): Promise<void> {
        const index = this.networks[chain].findIndex((n) => n.id === network.id);
        if (index === -1) {
            throw new Error("Network not found");
        }

        if (NetworkService.PROTECTED_NETWORK_IDS[chain].includes(network.id)) {
            throw new Error("Cannot modify protected network");
        }

        this.networks[chain][index] = network;
        if (this.currentNetworks[chain]?.id === network.id) {
            this.currentNetworks[chain] = network;
            await this.saveCurrentNetworks();
        }
        await this.saveNetworks();
    }

    public async clearNetworksForChain(chain: SupportedChain): Promise<void> {
        this.networks[chain] = this.networks[chain].filter((n) =>
            NetworkService.PROTECTED_NETWORK_IDS[chain].includes(n.id),
        );
        if (
            this.currentNetworks[chain] &&
            !this.networks[chain].some((n) => n.id === this.currentNetworks[chain]?.id)
        ) {
            this.currentNetworks[chain] = this.networks[chain][0];
            await this.saveCurrentNetworks();
        }
        await this.saveNetworks();
    }

    public protocolBlockchainForChain(chain: SupportedChain): ProtocolBlockchain {
        return getProtocolBlockchainForChain(chain);
    }
}

export default NetworkService;
