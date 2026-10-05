<script lang="ts">
    import Icon from "../../../lib/ui/Icon.svelte";
    // NFT gallery (#20): lazy-loaded grid across ERC-721, ERC-1155 and
    // Solana/Metaplex. Scanning logs + metadata is network-heavy, so nothing
    // runs until the user asks.
    import NetworkService from "../../../services/networkService";
    import {
        discoverNfts,
        discoverErc1155,
        fetchNftMetadata,
        fetchErc1155Metadata,
        type NftItem,
    } from "../../../services/nftService";
    import { makeSolanaRpc, loadSolanaNfts } from "../../../services/solanaNftService";
    import { isEvmChain, type SupportedChain } from "@stars-labs/types/appstate";

    let failedImages = new Set<string>();
    export let address: string;
    /** EVM chains scan ERC-721/1155; Solana scans Metaplex. */
    export let chain: SupportedChain = "ethereum";

    let items: NftItem[] = [];
    let loading = false;
    let loaded = false;
    let error = "";

    const BADGE: Record<string, string> = {
        erc721: "NFT",
        erc1155: "Edition",
        metaplex: "Solana",
    };

    async function loadEvm(): Promise<NftItem[]> {
        const net = NetworkService.getInstance();
        const network = isEvmChain(chain) ? net.getCurrentNetworkForChain(chain) : undefined;
        if (!network) throw new Error("No EVM network selected");
        const client = net.getPublicClient(network) as any;
        const latest: bigint = await client.getBlockNumber();
        const fromBlock = latest > 100_000n ? latest - 100_000n : 0n;
        // 721 and 1155 scans are independent — run them in parallel; one
        // standard failing must not blank the other.
        const [erc721, erc1155] = await Promise.all([
            discoverNfts(client, address, { fromBlock })
                .then((refs) => Promise.all(refs.map((r) => fetchNftMetadata(client, r))))
                .catch(() => [] as NftItem[]),
            discoverErc1155(client, address, { fromBlock })
                .then((held) => Promise.all(held.map((h) => fetchErc1155Metadata(client, h))))
                .catch(() => [] as NftItem[]),
        ]);
        return [...erc721, ...erc1155];
    }

    async function loadSolana(): Promise<NftItem[]> {
        const net = NetworkService.getInstance();
        const url =
            net.getCurrentNetworkForChain("solana")?.rpcUrls?.default?.http?.[0] ??
            "https://api.mainnet-beta.solana.com";
        return loadSolanaNfts(makeSolanaRpc(url), address);
    }

    async function load() {
        loading = true;
        error = "";
        try {
            items = chain === "solana" ? await loadSolana() : await loadEvm();
            loaded = true;
        } catch (e) {
            console.error("Collectibles could not be loaded", e);
            error = "Collectibles are unavailable. Try again shortly.";
        } finally {
            loading = false;
        }
    }
</script>

<div class="nft-gallery">
    <div class="ng-head">
        <span>Collectibles</span>
        <button class="ng-btn" on:click={load} disabled={loading}>
            {#if loading}Scanning…{:else if loaded}<Icon name="refresh" size={16} />{:else}Load collectibles{/if}
        </button>
    </div>

    {#if error}
        <div class="state-panel state-error"><Icon name="alert" /><span>{error}</span><button class="btn btn-secondary btn-sm" on:click={load}>Try again</button></div>
    {:else if loaded && items.length === 0}
        <div class="state-panel"><Icon name="image" size={32} /><strong>No collectibles found</strong><span>Collectibles on this account appear here.</span></div>
    {:else if items.length > 0}
        <div class="ng-grid">
            {#each items as nft (nft.contract + nft.tokenId)}
                <figure class="ng-card" title={nft.collection ?? nft.contract}>
                    <div class="ng-media">
                        {#if nft.image && !failedImages.has(nft.image)}
                            <img src={nft.image} alt={nft.name ?? `#${nft.tokenId}`} loading="lazy" on:error={() => { failedImages = new Set([...failedImages, nft.image!]); }} />
                        {:else}
                            <div class="ng-placeholder"><Icon name="image" size={32} /><span>#{nft.tokenId}</span></div>
                        {/if}
                        {#if nft.standard}
                            <span class="ng-badge">{BADGE[nft.standard] ?? nft.standard}</span>
                        {/if}
                        {#if nft.balance && nft.balance > 1n}
                            <span class="ng-count">×{nft.balance}</span>
                        {/if}
                    </div>
                    <figcaption>{nft.name ?? `#${nft.tokenId}`}</figcaption>
                </figure>
            {/each}
        </div>
    {/if}
</div>

<style>
    .nft-gallery { display: flex; flex-direction: column; gap: 8px; }
    .ng-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
    .ng-btn { background: none; border: 1px solid rgba(127,127,127,0.3); border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
    .ng-btn:disabled { opacity: 0.5; }
    .ng-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .ng-card { margin: 0; display: flex; flex-direction: column; gap: 4px; }
    .ng-media { position: relative; }
    .ng-badge, .ng-count { position: absolute; bottom: 4px; font-size: 9px; line-height: 1; padding: 2px 4px; border-radius: 6px; background: rgba(0,0,0,0.6); color: #fff; }
    .ng-badge { left: 4px; }
    .ng-count { right: 4px; }
    .ng-card img, .ng-placeholder { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; background: rgba(127,127,127,0.15); display: block; }
    .ng-placeholder { display: flex; flex-direction:column; gap:8px; align-items: center; justify-content: center; font-size: 12px; opacity: 0.7; }
    .ng-card figcaption { font-size: 11px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
