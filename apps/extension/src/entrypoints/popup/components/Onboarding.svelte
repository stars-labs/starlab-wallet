<script lang="ts">
    // First-run onboarding (#26): a guided path from "empty wallet" to a
    // completed DKG, written for someone who has never heard of MPC.
    //
    // Step 1  what a shared wallet is + create-vs-join choice
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

    /** Live signal-server connection state, from App. */
    export let wsConnected: boolean = false;

    const dispatch = createEventDispatcher();

    let step = 1;
    let mode: "create" | "join" = "create";
    let room = "";
    let roomSaved = false;
    let roomError = "";

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
        if (mode === "create") dispatch("create"); // App opens CreateWalletForm
        dispatch("done");
    }
</script>

<div class="card card-pad space-y-3" data-testid="onboarding">
    <div class="flex items-center justify-between">
        <span class="text-sm font-semibold">Set up your shared wallet</span>
        <span class="text-xs text-muted">step {step} / 3</span>
    </div>

    {#if step === 1}
        <p class="text-xs text-muted">
            A Starlab wallet is <strong>one key split across several devices</strong>.
            No single device can sign alone — a threshold of them (e.g. 2 of 3)
            approves every transaction together. There is no seed phrase to steal.
        </p>
        <div class="grid grid-cols-1 gap-2">
            <button
                class="rounded-xl border p-3 text-left text-sm transition hover:border-primary {mode === 'create' ? 'border-primary' : 'border-line'}"
                on:click={() => (mode = "create")}
            >
                <strong>Create a new shared wallet</strong>
                <span class="block text-xs text-muted">You start the ceremony; other devices join it.</span>
            </button>
            <button
                class="rounded-xl border p-3 text-left text-sm transition hover:border-primary {mode === 'join' ? 'border-primary' : 'border-line'}"
                on:click={() => (mode = "join")}
            >
                <strong>Join an existing ceremony</strong>
                <span class="block text-xs text-muted">Someone else created a wallet and invited this device.</span>
            </button>
        </div>
        <div class="flex justify-end">
            <button class="btn btn-primary btn-sm" on:click={() => (step = 2)}>Continue</button>
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
        {#if mode === "create"}
            <p class="text-xs text-muted">
                You'll pick a name, how many devices in total, and how many must
                approve each transaction (the threshold). The other devices must
                be online, in the <strong>same room</strong>, before you start.
            </p>
            <div class="flex items-center justify-between">
                <button class="btn btn-ghost btn-sm" on:click={() => (step = 2)}>Back</button>
                <button class="btn btn-primary btn-sm" on:click={finish}>Open the create form</button>
            </div>
        {:else}
            <p class="text-xs text-muted">
                Keep this popup open. When the creator starts the ceremony, an
                <strong>invite appears under "Session invites"</strong> — accept it
                and the key generation runs automatically. Nothing else to do here.
            </p>
            <div class="flex items-center justify-between">
                <button class="btn btn-ghost btn-sm" on:click={() => (step = 2)}>Back</button>
                <button class="btn btn-primary btn-sm" on:click={finish}>Got it</button>
            </div>
        {/if}
    {/if}
</div>
