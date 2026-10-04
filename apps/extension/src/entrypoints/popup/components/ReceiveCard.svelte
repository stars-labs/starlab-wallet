<script lang="ts">
    import TokenIcon from "../../../lib/ui/TokenIcon.svelte";
    import ChainIcon from "../../../lib/ui/ChainIcon.svelte";
    import Icon from "../../../lib/ui/Icon.svelte";
    // Receive screen: address + scannable QR. Pure client-side (qrcode lib).

    export let address: string;
    export let network = "";
    export let chain: string = "ethereum";

    let dataUrl = "";
    let copied = false;
    let error = "";
    let copyError = "";
    let renderEpoch = 0;

    async function render(targetAddress: string) {
        const epoch = ++renderEpoch;
        error = "";
        dataUrl = "";
        try {
            const QRCode = (await import("qrcode")).default;
            const nextUrl = await QRCode.toDataURL(targetAddress, { width: 200, margin: 1 });
            if (epoch === renderEpoch) dataUrl = nextUrl;
        } catch (e) {
            if (epoch === renderEpoch) error = (e as Error).message;
        }
    }

    async function copy() {
        copyError = "";
        try {
            await navigator.clipboard.writeText(address);
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch {
            copyError = "Could not copy. Select the address and copy it manually.";
        }
    }

    $: if (address) void render(address);
</script>

<div class="receive">
    <ChainIcon {chain} size={48} /><div class="rc-label">Receive crypto</div><span class="badge badge-primary">{network || chain.charAt(0).toUpperCase() + chain.slice(1)}</span><p class="text-xs text-muted">Only send assets on this network.</p>
    {#if error}
        <div class="rc-error">{error}</div>
    {:else if dataUrl}
        <img class="rc-qr" src={dataUrl} alt="QR code for {address}" />
    {:else}
        <div class="state-panel" aria-busy="true"><div class="skeleton-row"></div>Creating QR code…</div>
    {/if}
    <code class="rc-addr">{address}</code>
    <button class="btn btn-primary rc-copy" on:click={copy}><Icon name={copied ? "check" : "copy"} size={16} />{copied ? "Copied" : "Copy address"}</button>
    {#if copyError}<p class="text-xs text-danger-fg">{copyError}</p>{/if}
</div>

<style>
    .receive { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 8px; }
    .rc-label { font-weight: 600; }
    .rc-qr { width: 200px; height: 200px; border-radius: 8px; background: #fff; padding: 8px; }
    .rc-addr { font-family: monospace; font-size: 12px; word-break: break-all; text-align: center; opacity: 0.85; }
    .rc-copy { padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.3); cursor: pointer; background: transparent; }
</style>
