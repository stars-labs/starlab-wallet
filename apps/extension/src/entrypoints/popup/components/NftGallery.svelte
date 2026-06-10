<script lang="ts">
    // NFT gallery (#20): lazy-loaded ERC-721 grid. Scanning logs + metadata is
    // network-heavy, so nothing runs until the user asks.
    import NetworkService from "../../../services/networkService";
    import {
        discoverNfts,
        fetchNftMetadata,
        type NftItem,
    } from "../../../services/nftService";

    export let address: string;

    let items: NftItem[] = [];
    let loading = false;
    let loaded = false;
    let error = "";

    async function load() {
        loading = true;
        error = "";
        try {
            const net = NetworkService.getInstance();
            const network = net.getCurrentNetwork("ethereum");
            if (!network) throw new Error("No EVM network selected");
            const client = net.getPublicClient(network) as any;
            const latest: bigint = await client.getBlockNumber();
            const fromBlock = latest > 100_000n ? latest - 100_000n : 0n;
            const refs = await discoverNfts(client, address, { fromBlock });
            items = await Promise.all(refs.map((r) => fetchNftMetadata(client, r)));
            loaded = true;
        } catch (e) {
            error = (e as Error).message;
        } finally {
            loading = false;
        }
    }
</script>

<div class="nft-gallery">
    <div class="ng-head">
        <span>NFTs</span>
        <button class="ng-btn" on:click={load} disabled={loading}>
            {loading ? "Scanning…" : loaded ? "⟳" : "Load NFTs"}
        </button>
    </div>

    {#if error}
        <div class="ng-error">{error}</div>
    {:else if loaded && items.length === 0}
        <div class="ng-muted">No NFTs found in the recent window.</div>
    {:else if items.length > 0}
        <div class="ng-grid">
            {#each items as nft (nft.contract + nft.tokenId)}
                <figure class="ng-card" title={nft.collection ?? nft.contract}>
                    {#if nft.image}
                        <img src={nft.image} alt={nft.name ?? `#${nft.tokenId}`} loading="lazy" />
                    {:else}
                        <div class="ng-placeholder">#{nft.tokenId}</div>
                    {/if}
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
    .ng-card img, .ng-placeholder { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; background: rgba(127,127,127,0.15); }
    .ng-placeholder { display: flex; align-items: center; justify-content: center; font-size: 12px; opacity: 0.7; }
    .ng-card figcaption { font-size: 11px; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ng-muted { opacity: 0.6; font-size: 13px; }
    .ng-error { color: #c0392b; font-size: 13px; }
</style>
