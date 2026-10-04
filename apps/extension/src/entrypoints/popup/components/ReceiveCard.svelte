<script lang="ts">
    import TokenIcon from "../../../lib/ui/TokenIcon.svelte";
    import ChainIcon from "../../../lib/ui/ChainIcon.svelte";
    import Icon from "../../../lib/ui/Icon.svelte";
    // Receive screen: address + scannable QR. Pure client-side (qrcode lib).
    import { onMount } from "svelte";

    export let address: string;
    export let chain: string = "ethereum";

    let dataUrl = "";
    let copied = false;
    let error = "";

    async function render() {
        try {
            const QRCode = (await import("qrcode")).default;
            dataUrl = await QRCode.toDataURL(address, { width: 200, margin: 1 });
        } catch (e) {
            error = (e as Error).message;
        }
    }

    async function copy() {
        try {
            await navigator.clipboard.writeText(address);
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch {
            /* clipboard blocked */
        }
    }

    onMount(render);
</script>

<div class="receive">
    <ChainIcon {chain} size={48} /><div class="rc-label">Receive crypto</div><span class="badge badge-primary">{chain}</span><p class="text-xs text-muted">Only send assets on this network.</p>
    {#if error}
        <div class="rc-error">{error}</div>
    {:else if dataUrl}
        <img class="rc-qr" src={dataUrl} alt="QR code for {address}" />
    {/if}
    <code class="rc-addr">{address}</code>
    <button class="btn btn-primary rc-copy" on:click={copy}><Icon name={copied ? "check" : "copy"} size={16} />{copied ? "Copied" : "Copy address"}</button>
</div>

<style>
    .receive { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px; }
    .rc-label { font-weight: 600; }
    .rc-qr { width: 200px; height: 200px; border-radius: 8px; background: #fff; padding: 8px; }
    .rc-addr { font-family: monospace; font-size: 12px; word-break: break-all; text-align: center; opacity: 0.85; }
    .rc-copy { padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.3); cursor: pointer; background: transparent; }
</style>
