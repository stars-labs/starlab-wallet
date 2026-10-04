<script lang="ts">
    import TokenIcon from "./TokenIcon.svelte";
    import { nativeSymbol } from "./tokenIdentity";
    export let chain = "ethereum";
    export let size = 24;
</script>
<TokenIcon {chain} {size} symbol={nativeSymbol(chain)} />
