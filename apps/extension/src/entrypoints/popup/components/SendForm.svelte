<script lang="ts">
    // Send form: pick asset (native or ERC-20), recipient, amount → build the
    // eth_sendTransaction params with the pure sendService and emit `submit`.
    // The parent routes the tx through the existing MPC sign+broadcast flow, so
    // this component stays self-contained and unaware of the signing plumbing.
    import { onMount, createEventDispatcher } from "svelte";
    import {
        buildSendTransaction,
        estimateSendFee,
        withFee,
        type EthSendParams,
        type FeeEstimate,
    } from "../../../services/sendService";
    import NetworkService from "../../../services/networkService";
    import {
        AddressBookService,
        resolveRecipient,
        type Contact,
    } from "../../../services/addressBookService";
    import { formatUserError } from "../../../services/walletErrors";
    import {
        simulateTransaction,
        type SimulationResult,
    } from "../../../services/simulationService";
    import { TokenRegistry, formatTokenAmount } from "../../../services/tokenService";

    export let from: string;

    const dispatch = createEventDispatcher();

    type Asset = { symbol: string; address?: string; decimals: number; balance: string };
    let assets: Asset[] = [];
    let selected = 0; // index into assets; 0 = native
    let recipient = "";
    let amount = "";
    let error = "";
    let loadingAssets = true;
    // Review step (#12): built tx + fee estimate shown before signing.
    let review: { tx: EthSendParams; fee: FeeEstimate; resolvedTo: string; ens?: string } | null = null;
    let estimating = false;
    // Address book + ENS (#25).
    let contacts: Contact[] = [];
    async function loadContacts() {
        contacts = await AddressBookService.getInstance().list("ethereum");
    }

    async function loadAssets() {
        loadingAssets = true;
        try {
            const res = await chrome.runtime.sendMessage({ type: "getPortfolio", address: from });
            if (res?.success && res.portfolio) {
                assets = [
                    { symbol: res.portfolio.native.symbol, decimals: 18, balance: res.portfolio.native.balance },
                    ...res.portfolio.tokens,
                ];
            } else {
                assets = [{ symbol: "ETH", decimals: 18, balance: "0" }];
            }
        } catch {
            assets = [{ symbol: "ETH", decimals: 18, balance: "0" }];
        } finally {
            loadingAssets = false;
        }
    }

    function validate(): boolean {
        error = "";
        const r = recipient.trim();
        // 0x address or an ENS-style name — exact resolution happens in toReview.
        if (!/^0x[0-9a-fA-F]{40}$/.test(r) && !(r.includes(".") && !r.startsWith("0x"))) {
            error = "Enter a valid 0x address or an ENS name";
            return false;
        }
        if (!(Number(amount) > 0)) {
            error = "Enter an amount greater than 0";
            return false;
        }
        return true;
    }

    /** Step 1 → 2: resolve the recipient (ENS), build the tx, estimate fee. */
    async function toReview() {
        if (!validate()) return;
        const asset = assets[selected];
        estimating = true;
        error = "";
        try {
            const net = NetworkService.getInstance();
            const client = net.getPublicClient(net.getCurrentNetwork("ethereum")) as any;
            // ENS lives on mainnet — resolve against mainnet when available,
            // falling back to the current network's client.
            const mainnet = net.getNetworkByChainId(1);
            const ensClient = mainnet ? (net.getPublicClient(mainnet) as any) : client;
            const resolved = await resolveRecipient(ensClient, recipient);

            const tx = buildSendTransaction({
                from,
                to: resolved.address,
                amount,
                token: asset.address ? { address: asset.address, decimals: asset.decimals } : undefined,
            });
            const fee = await estimateSendFee(client, tx);
            review = { tx, fee, resolvedTo: resolved.address, ens: resolved.ens };
            runPreflight(tx); // fire-and-forget; panel fills in when done (#32)
        } catch (e) {
            // ENS not resolving / estimateGas reverting both mean the send
            // would fail — surface it pre-sign.
            error = formatUserError(e);
        } finally {
            estimating = false;
        }
    }

    // Preflight simulation (#32): replay the tx on the local anvil fork and
    // show what it actually does. Absent node ⇒ "unavailable", never blocking.
    let preflight: SimulationResult | null = null;
    let preflightRunning = false;
    async function runPreflight(tx: EthSendParams) {
        preflight = null;
        preflightRunning = true;
        try {
            const net = NetworkService.getInstance();
            const chainId = net.getCurrentNetwork("ethereum")?.id ?? 1;
            const tokens = await TokenRegistry.getInstance().list(chainId);
            preflight = await simulateTransaction("http://127.0.0.1:8545", tx, tokens);
        } catch {
            preflight = { available: false };
        } finally {
            preflightRunning = false;
        }
    }

    /** Step 2 confirm: hand the fee-laden tx to the parent for MPC signing. */
    function confirm() {
        if (!review) return;
        const asset = assets[selected];
        dispatch("submit", {
            tx: withFee(review.tx, review.fee),
            asset: asset.symbol,
            amount,
            to: review.resolvedTo,
        });
    }

    onMount(() => {
        loadAssets();
        loadContacts();
    });
</script>

<div class="send-form">
    <div class="sf-head">Send</div>

    <label class="sf-field">
        <span>Asset</span>
        {#if loadingAssets}
            <span class="sf-muted">loading…</span>
        {:else}
            <select bind:value={selected}>
                {#each assets as a, i}
                    <option value={i}>{a.symbol} — {Number(a.balance).toLocaleString(undefined, { maximumFractionDigits: 6 })}</option>
                {/each}
            </select>
        {/if}
    </label>

    <label class="sf-field">
        <span>To</span>
        <input
            placeholder="0x… or name.eth"
            bind:value={recipient}
            spellcheck="false"
            list="sf-contacts"
        />
        <datalist id="sf-contacts">
            {#each contacts as c (c.address)}
                <option value={c.address}>{c.name}</option>
            {/each}
        </datalist>
    </label>

    <label class="sf-field">
        <span>Amount</span>
        <input placeholder="0.0" inputmode="decimal" bind:value={amount} />
    </label>

    {#if error}<div class="sf-error">{error}</div>{/if}

    {#if review}
        <!-- Review step (#12): everything the user is about to authorize. -->
        <div class="sf-review">
            <div class="sf-row"><span>Send</span><strong>{amount} {assets[selected]?.symbol}</strong></div>
            <div class="sf-row">
                <span>To</span>
                <code>
                    {#if review.ens}{review.ens} → {/if}{review.resolvedTo.slice(0, 10)}…{review.resolvedTo.slice(-6)}
                </code>
            </div>
            <div class="sf-row">
                <span>Network fee (max)</span>
                <strong>{Number(review.fee.totalEth).toLocaleString(undefined, { maximumFractionDigits: 8 })} ETH</strong>
            </div>
            <div class="sf-row sf-muted">
                <span>Gas</span>
                <span>{review.fee.gas.toString()} × {review.fee.kind === "eip1559" ? "max fee" : "gas price"}</span>
            </div>

            <!-- Preflight simulation (#32) -->
            <div class="sf-preflight">
                {#if preflightRunning}
                    <span class="sf-muted">Simulating on local fork…</span>
                {:else if preflight && !preflight.available}
                    <span class="sf-muted">Preflight unavailable — start a fork node with scripts/sandbox.sh for a dry-run.</span>
                {:else if preflight && preflight.success === false}
                    <span class="sf-pf-bad">⛔ Would REVERT{preflight.revertReason ? `: ${preflight.revertReason}` : ""}</span>
                {:else if preflight && preflight.success}
                    <span class="sf-pf-ok">✓ Simulated OK (gas {preflight.gasUsed})</span>
                    {#if preflight.nativeDiff !== undefined}
                        <span>ETH: {formatTokenAmount(preflight.nativeDiff < 0n ? -preflight.nativeDiff : preflight.nativeDiff, 18)} {preflight.nativeDiff < 0n ? "out" : "in"}</span>
                    {/if}
                    {#each preflight.tokenDiffs ?? [] as d}
                        <span>{d.token.symbol}: {formatTokenAmount(d.diff < 0n ? -d.diff : d.diff, d.token.decimals)} {d.diff < 0n ? "out" : "in"}</span>
                    {/each}
                {/if}
            </div>
        </div>
        <div class="sf-actions">
            <button class="sf-cancel" on:click={() => (review = null)}>Back</button>
            <button class="sf-submit" on:click={confirm}>Confirm &amp; sign</button>
        </div>
    {:else}
        <div class="sf-actions">
            <button class="sf-cancel" on:click={() => dispatch("cancel")}>Cancel</button>
            <button class="sf-submit" on:click={toReview} disabled={loadingAssets || estimating}>
                {estimating ? "Estimating…" : "Review & sign"}
            </button>
        </div>
    {/if}
    <p class="sf-note">Signing runs the FROST threshold ceremony across your devices.</p>
</div>

<style>
    .send-form { display: flex; flex-direction: column; gap: 12px; }
    .sf-head { font-weight: 600; font-size: 16px; }
    .sf-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .sf-field input, .sf-field select { padding: 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.3); background: transparent; }
    .sf-actions { display: flex; gap: 8px; justify-content: flex-end; }
    .sf-actions button { padding: 8px 16px; border-radius: 8px; cursor: pointer; border: 1px solid rgba(127,127,127,0.3); background: transparent; }
    .sf-submit { background: #6366f1; color: #fff; border-color: #6366f1; }
    .sf-submit:disabled { opacity: 0.5; cursor: default; }
    .sf-error { color: #c0392b; font-size: 13px; }
    .sf-muted { opacity: 0.6; }
    .sf-note { font-size: 11px; opacity: 0.55; margin: 0; }
    .sf-review { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; font-size: 13px; }
    .sf-preflight { display: flex; flex-direction: column; gap: 2px; border-top: 1px dashed rgba(127,127,127,0.25); padding-top: 6px; font-size: 12px; }
    .sf-pf-ok { color: #27ae60; font-weight: 600; }
    .sf-pf-bad { color: #c0392b; font-weight: 600; }
    .sf-row { display: flex; justify-content: space-between; gap: 8px; }
    .sf-row code { font-size: 12px; }
</style>
