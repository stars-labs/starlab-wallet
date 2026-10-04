<script lang="ts">
    import TokenIcon from "./TokenIcon.svelte";
    import base from "../../assets/tokens/base.png";
    import arbitrum from "../../assets/tokens/arbitrum.png";
    import optimism from "../../assets/tokens/optimism.png";
    import { nativeSymbol } from "./tokenIdentity";
    export let chain = "ethereum";
    export let size = 24;
    const networks: Record<string,string> = { base, arbitrum, optimism };
</script>
{#if networks[chain]}<img src={networks[chain]} alt={`${chain} network`} width={size} height={size} />{:else}<TokenIcon {chain} {size} symbol={nativeSymbol(chain)} />{/if}
<style>img { border-radius:50%; object-fit:contain; flex:none; }</style>
