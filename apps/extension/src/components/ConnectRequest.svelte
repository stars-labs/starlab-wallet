<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import Button from "../lib/ui/Button.svelte";
    import ChainIcon from "../lib/ui/ChainIcon.svelte";
    import Icon from "../lib/ui/Icon.svelte";
    import type { ConnectRequestView } from "../entrypoints/background/connectRequest";

    export let request: ConnectRequestView;

    const dispatch = createEventDispatcher<{ complete: string }>();

    let selected = new Set(request.selected.map((a) => a.toLowerCase()));
    let busy: "approve" | "reject" | null = null;
    let error = "";

    function formatAddress(addr: string): string {
        return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
    }

    function toggle(address: string, checked: boolean) {
        const key = address.toLowerCase();
        if (checked) selected.add(key);
        else selected.delete(key);
        selected = selected;
    }

    function resolve(approved: boolean) {
        busy = approved ? "approve" : "reject";
        error = "";
        const selectedAddresses = request.accounts
            .filter((a) => selected.has(a.address.toLowerCase()))
            .map((a) => a.address);
        chrome.runtime.sendMessage(
            {
                type: "resolveConnectRequest",
                requestId: request.requestId,
                approved,
                selectedAddresses,
            },
            (response) => {
                busy = null;
                if (chrome.runtime.lastError) {
                    error = chrome.runtime.lastError.message ?? "Could not reach the wallet";
                    return;
                }
                if (!response?.success) {
                    error = response?.error ?? "Request failed";
                    return;
                }
                dispatch("complete", request.requestId);
            },
        );
    }
</script>

<div class="card card-pad">
    <div class="mb-3 flex items-center justify-between">
        <h3 class="flex items-center gap-1.5 text-sm font-bold">
            <ChainIcon chain={request.blockchain} size={28} /> Connect to app
        </h3>
        <span class="badge badge-warning">Pending</span>
    </div>

    <dl class="space-y-2 text-xs">
        <div>
            <dt class="label mb-1">Site</dt>
            <dd class="mono break-all rounded-lg bg-surface-2 px-2 py-1">{request.origin}</dd>
        </div>
    </dl>

    {#if request.warning}
        <div class="mt-3 alert alert-warning flex items-start gap-1.5 text-xs">
            <Icon name="alert" size={14} />
            <span>Possible phishing site: {request.warning}. Only connect if you trust it.</span>
        </div>
    {/if}

    <p class="mt-3 text-xs text-muted">
        <span class="font-semibold text-content">{request.origin}</span> wants to see the
        {request.blockchain === "solana" ? "Solana" : "Ethereum"} address of the accounts you
        select and request signatures from them.
    </p>

    <p class="label mb-1 mt-3">Accounts</p>
    <ul class="space-y-1.5">
        {#each request.accounts as account (account.address)}
            <li>
                <label class="list-row flex cursor-pointer items-center gap-2 py-1.5 text-xs">
                    <input
                        type="checkbox"
                        checked={selected.has(account.address.toLowerCase())}
                        on:change={(e) => toggle(account.address, e.currentTarget.checked)}
                        disabled={busy !== null}
                        class="h-4 w-4 accent-[var(--c-primary)]"
                    />
                    <span class="min-w-0 flex-1 truncate font-semibold">{account.name}</span>
                    <code class="mono text-muted" title={account.address}>
                        {formatAddress(account.address)}
                    </code>
                </label>
            </li>
        {/each}
    </ul>

    {#if error}
        <div class="mt-3 alert alert-danger text-xs">{error}</div>
    {/if}

    <div class="mt-3 flex gap-2">
        <Button variant="secondary" block on:click={() => resolve(false)} disabled={busy !== null}>
            {busy === "reject" ? "Rejecting…" : "Reject"}
        </Button>
        <Button block on:click={() => resolve(true)} disabled={busy !== null || selected.size === 0}>
            {busy === "approve" ? "Connecting…" : "Approve"}
        </Button>
    </div>
</div>
