<script lang="ts">
    // First-run onboarding (#26): a guided path from "empty wallet" to a
    // usable account source. MPC remains available, but first-run setup must
    // also support hardware and simulation/watch-only accounts.
    //
    // Step 1  choose account source
    // Step 2  the shared room (all devices must use the same one) + connection
    // Step 3  hand off: creators open the create form; joiners get told exactly
    //         what the invite will look like and where it appears.
    import { createEventDispatcher } from "svelte";
    import {
        getRoom,
        setRoom,
        newRoom,
        isValidRoom,
    } from "../../../config/signal-server";
    import { onMount } from "svelte";
    import FeatureHeader from "../../../lib/ui/FeatureHeader.svelte";
    import CopyButton from "../../../lib/ui/CopyButton.svelte";
    import {
        CHAIN_METADATA,
        EVM_CHAINS,
        LIMITED_CHAINS,
        type SupportedChain,
    } from "@stars-labs/types/appstate";

    /** Live signal-server connection state, from App. */
    export let wsConnected: boolean = false;

    const dispatch = createEventDispatcher();

    let step = 1;
    let mode: "mpc" | "join" | "ledger" | "yubikey" | "simulation" = "mpc";
    let room = "";
    let roomSaved = false;
    let roomError = "";
    let simulationAddress = "";
    let simulationChain: SupportedChain = "ethereum";
    let simulationError = "";
    const evmSimulationOptions = EVM_CHAINS.map((id) => CHAIN_METADATA[id]);
    const limitedSimulationOptions = LIMITED_CHAINS.map((id) => CHAIN_METADATA[id]);

    onMount(async () => {
        room = (await getRoom()) ?? "";
        roomSaved = !!room;
    });

    function genRoom() {
        room = newRoom();
        roomError = "";
    }

    async function saveRoomAndContinue() {
        roomError = "";
        if (!isValidRoom(room)) {
            roomError = "Room is too weak — use Generate, or 16+ mixed characters.";
            return;
        }
        const ok = await setRoom(room.trim());
        if (!ok) {
            roomError = "Couldn't save the room.";
            return;
        }
        roomSaved = true;
        dispatch("reconnect"); // App reconnects the signal socket with the new room
        step = 3;
    }

    function finish() {
        if (mode === "mpc") dispatch("create"); // App opens CreateWalletForm
        if (mode === "ledger") dispatch("ledger");
        if (mode === "yubikey") dispatch("yubikey");
        if (mode === "simulation") {
            simulationError = "";
            const address = simulationAddress.trim();
            if (!address) {
                simulationError = "Enter an address.";
                return;
            }
            dispatch("simulation", { address, blockchain: simulationChain });
        }
        dispatch("done");
    }

    $: requiresRoom = mode === "mpc" || mode === "join";
</script>

<div class="card card-pad space-y-3" data-testid="onboarding">
    <div class="flex items-center justify-between">
        <FeatureHeader title="Your wallet, shared securely" subtitle="Choose the account that works for you" icon="shield" />
        <span class="text-xs text-muted">Step {step} of 3</span>
    </div>

    {#if step === 1}
        <p class="text-xs text-muted">
            Choose how this profile should start. You can create a shared MPC
            wallet, connect hardware, or add a simulation address for testing.
        </p>
        <div class="grid grid-cols-1 gap-2">
            <button
                class="rounded-xl border p-3 text-left text-sm transition hover:border-primary {mode === 'mpc' ? 'border-primary' : 'border-line'}"
                on:click={() => (mode = "mpc")}
            >
                <strong>MPC shared wallet</strong>
                <span class="block text-xs text-muted">You start the ceremony; other devices join it.</span>
            </button>
            <button
                class="rounded-xl border p-3 text-left text-sm transition hover:border-primary {mode === 'join' ? 'border-primary' : 'border-line'}"
                on:click={() => (mode = "join")}
            >
                <strong>Join an existing ceremony</strong>
                <span class="block text-xs text-muted">Someone else created a wallet and invited this device.</span>
            </button>
            <button
                class="rounded-xl border p-3 text-left text-sm transition hover:border-primary {mode === 'ledger' ? 'border-primary' : 'border-line'}"
                on:click={() => (mode = "ledger")}
            >
                <strong>Ledger</strong>
                <span class="block text-xs text-muted">Connect a Ledger over WebHID and use its default accounts.</span>
            </button>
            <button
                class="rounded-xl border p-3 text-left text-sm transition hover:border-primary {mode === 'yubikey' ? 'border-primary' : 'border-line'}"
                on:click={() => (mode = "yubikey")}
            >
                <strong>YubiKey</strong>
                <span class="block text-xs text-muted">Use accounts discovered from the YubiWallet native host.</span>
            </button>
            <button
                class="rounded-xl border p-3 text-left text-sm transition hover:border-primary {mode === 'simulation' ? 'border-primary' : 'border-line'}"
                on:click={() => (mode = "simulation")}
            >
                <strong>Simulation address</strong>
                <span class="block text-xs text-muted">Add any address as watch-only for sandbox testing.</span>
            </button>
        </div>
        <div class="flex justify-end">
            <button class="btn btn-primary btn-sm" on:click={() => (requiresRoom ? step = 2 : step = 3)}>Continue</button>
        </div>
    {:else if step === 2}
        <p class="text-xs text-muted">
            Devices find each other through a <strong>room</strong> on the signal
            server. Every device of this wallet must use the <strong>same room</strong> —
            share it over a channel you trust (in person, not a public chat).
        </p>
        <div class="flex items-center gap-2">
            <input
                type="text"
                class="input flex-1 text-xs"
                placeholder="room id (16+ chars)"
                bind:value={room}
            />
            {#if room}
                <CopyButton value={room} variant="icon" title="Copy room" />
            {/if}
            <button class="btn btn-ghost btn-sm" on:click={genRoom}>Generate</button>
        </div>
        {#if roomError}<p class="text-xs" style="color:#c0392b">{roomError}</p>{/if}
        <div class="flex items-center justify-between">
            <button class="btn btn-ghost btn-sm" on:click={() => (step = 1)}>Back</button>
            <button class="btn btn-primary btn-sm" on:click={saveRoomAndContinue}>
                Save room &amp; continue
            </button>
        </div>
    {:else}
        <p class="text-xs">
            <span class="badge {wsConnected ? 'badge-success' : 'badge-danger'}">
                {wsConnected ? "Connected" : "Connecting…"}
            </span>
        </p>
        {#if mode === "mpc"}
            <p class="text-xs text-muted">
                You'll pick a name, how many devices in total, and how many must
                approve each transaction (the threshold). The other devices must
                be online, in the <strong>same room</strong>, before you start.
            </p>
            <div class="flex items-center justify-between">
                <button class="btn btn-ghost btn-sm" on:click={() => (step = 2)}>Back</button>
                <button class="btn btn-primary btn-sm" on:click={finish}>Create wallet</button>
            </div>
        {:else if mode === "join"}
            <p class="text-xs text-muted">
                Keep this popup open. When the creator starts the ceremony, an
                <strong>invite appears under "Session invites"</strong> — accept it
                and the key generation runs automatically. Nothing else to do here.
            </p>
            <div class="flex items-center justify-between">
                <button class="btn btn-ghost btn-sm" on:click={() => (step = 2)}>Back</button>
                <button class="btn btn-primary btn-sm" on:click={finish}>Got it</button>
            </div>
        {:else if mode === "ledger"}
            <p class="text-xs text-muted">
                Connect and unlock your Ledger, open the Ethereum or Solana app,
                then approve the browser device prompt.
            </p>
            <div class="flex items-center justify-between">
                <button class="btn btn-ghost btn-sm" on:click={() => (step = 1)}>Back</button>
                <button class="btn btn-primary btn-sm" on:click={finish}>Connect Ledger</button>
            </div>
        {:else if mode === "yubikey"}
            <p class="text-xs text-muted">
                Plug in your YubiKey and make sure the YubiWallet native host is
                installed. The wallet will refresh discovered card accounts.
            </p>
            <div class="flex items-center justify-between">
                <button class="btn btn-ghost btn-sm" on:click={() => (step = 1)}>Back</button>
                <button class="btn btn-primary btn-sm" on:click={finish}>Refresh YubiKey</button>
            </div>
        {:else}
            <p class="text-xs text-muted">
                Add an address for sandbox and portfolio inspection.
                This account cannot sign transactions.
            </p>
            <select class="select text-xs" bind:value={simulationChain}>
                <optgroup label="EVM">
                    {#each evmSimulationOptions as option}
                        <option value={option.id}>{option.label}</option>
                    {/each}
                </optgroup>
                <optgroup label="ed25519">
                    <option value="solana">Solana</option>
                    <option value="sui">Sui</option>
                </optgroup>
                <optgroup label="Bitcoin">
                    {#each limitedSimulationOptions.filter((option) => option.id === "bitcoin") as option}
                        <option value={option.id}>{option.label}</option>
                    {/each}
                </optgroup>
            </select>
            <input
                type="text"
                class="input text-xs"
                placeholder={simulationChain === "solana" ? "Solana address" : simulationChain === "bitcoin" ? "bc1..." : simulationChain === "sui" ? "0x..." : "0x..."}
                bind:value={simulationAddress}
            />
            {#if simulationError}<p class="text-xs" style="color:#c0392b">{simulationError}</p>{/if}
            <div class="flex items-center justify-between">
                <button class="btn btn-ghost btn-sm" on:click={() => (step = 1)}>Back</button>
                <button class="btn btn-primary btn-sm" on:click={finish}>Add address</button>
            </div>
        {/if}
    {/if}
</div>
