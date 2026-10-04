<script lang="ts">
    import { tokenImage } from "./tokenIdentity";
    export let symbol = "ETH";
    export let chain = "ethereum";
    export let address: string | undefined = undefined;
    export let size = 36;
    export let networkId: number | undefined = undefined;
    $: image = tokenImage(symbol, chain, address, networkId);
</script>
<span class="token-icon" style:width={`${size}px`} style:height={`${size}px`} aria-label={`${symbol} token`}>
    {#if image}<img src={image} alt="" />{:else}<span>{symbol.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?"}</span>{/if}
</span>
<style>
.token-icon { display:inline-flex; flex:none; align-items:center; justify-content:center; border-radius:50%; overflow:hidden; background:var(--c-surface-3); color:var(--c-muted); font-size:12px; font-weight:700; vertical-align:middle; }
img { width:100%; height:100%; object-fit:contain; }
</style>
