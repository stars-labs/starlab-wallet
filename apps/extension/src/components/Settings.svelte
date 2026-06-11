<script lang="ts">
    import { onMount } from "svelte";
    import NetworkService from "../services/networkService";
    import { mainnet } from "viem/chains";
    import type { Chain } from "@stars-labs/types/network";
    import type { SupportedChain } from "@stars-labs/types/appstate";
    import {
        CURVE_COMPATIBLE_CHAINS,
        getCompatibleChains,
        getRequiredCurve,
    } from "@stars-labs/types/appstate";
    import { createPublicClient, http } from "viem";
    import { createEventDispatcher } from "svelte";
    import { themeMode, setTheme, type ThemeMode } from "../lib/theme";
    import Button from "../lib/ui/Button.svelte";
    import Icon from "../lib/ui/Icon.svelte";
    import ReshareCard from "./ReshareCard.svelte";
    import {
        getRoom,
        setRoom,
        newRoom,
        isValidRoom,
    } from "../config/signal-server";

    import {
        enableSandbox,
        disableSandbox,
        isSandboxActive,
        probeSandbox,
    } from "../services/sandboxService";
    import {
        getPermissionService,
        type DAppPermission,
    } from "../services/permissionService";
    import {
        AllowanceService,
        buildRevokeTx,
        type AllowanceRecord,
    } from "../services/allowanceService";
    import {
        TokenRegistry,
        fetchTokenMetadata,
        discoverTokens,
        type TokenInfo,
    } from "../services/tokenService";

    /** Active wallet address (for the token-approvals review). */
    export let currentAddress: string = "";

    // Tenant room (multi-tenant signal server, #31). The hosted server routes
    // each ?room=<id> to an isolated instance and REQUIRES a strong room.
    let signalRoom = "";
    let roomStatus = "";

    // Sandbox mode (#31): one-click local-fork networks.
    let sandboxActive = false;
    let sandboxStatus = "";
    async function toggleSandbox() {
        sandboxStatus = "";
        try {
            if (sandboxActive) {
                await disableSandbox();
                sandboxActive = false;
                sandboxStatus = "Back on the previous networks.";
            } else {
                const up = await probeSandbox();
                if (!up.evm && !up.solana) {
                    sandboxStatus =
                        "No local nodes found — run scripts/sandbox.sh first.";
                    return;
                }
                await enableSandbox();
                sandboxActive = true;
                sandboxStatus = `Sandbox active (EVM ${up.evm ? "up" : "down"}, Solana ${up.solana ? "up" : "down"}).`;
            }
        } catch (e) {
            sandboxStatus = `Failed: ${(e as Error).message}`;
        }
    }

    // Connected dApps (#15): list per-origin permissions + revoke.
    let dappPermissions: DAppPermission[] = [];
    async function loadDappPermissions() {
        const ps = getPermissionService();
        await ps.ensureInitialized();
        dappPermissions = ps.getAllPermissions();
    }
    async function revokeDapp(origin: string) {
        const ps = getPermissionService();
        await ps.disconnectAccounts(origin); // no accounts arg = revoke all
        await loadDappPermissions();
    }
    function shortAcct(a: string): string {
        return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
    }

    // Token approvals (#17): recorded approvals refreshed against the chain.
    let allowances: (AllowanceRecord & { current: bigint })[] = [];
    let allowanceStatus = "";
    async function loadAllowances() {
        if (!currentAddress) return;
        try {
            const net = NetworkService.getInstance();
            const network = net.getCurrentNetwork("ethereum");
            if (!network) return;
            const client = net.getPublicClient(network) as any;
            allowances = await AllowanceService.getInstance().listLive(
                currentAddress,
                network.id,
                client,
            );
        } catch (e) {
            allowanceStatus = `Failed to load: ${(e as Error).message}`;
        }
    }
    async function revokeAllowance(r: AllowanceRecord) {
        allowanceStatus = "Submitting revoke…";
        try {
            const res = await chrome.runtime.sendMessage({
                type: "rpcRequest",
                payload: {
                    jsonrpc: "2.0",
                    id: Date.now(),
                    method: "eth_sendTransaction",
                    params: [buildRevokeTx(r.owner, r.token, r.spender)],
                },
            });
            if (res?.error) {
                allowanceStatus = `Revoke failed: ${res.error.message ?? res.error}`;
            } else {
                allowanceStatus = "Revoke submitted — allowance clears once it confirms.";
                await loadAllowances();
            }
        } catch (e) {
            allowanceStatus = `Revoke failed: ${(e as Error).message}`;
        }
    }
    function shortHexId(a: string): string {
        return `${a.slice(0, 6)}…${a.slice(-4)}`;
    }

    // Token management (#21): custom add + auto-discovery.
    let tokenAddrInput = "";
    let tokenStatus = "";
    let trackedTokens: TokenInfo[] = [];
    function evmChainId(): number | undefined {
        return NetworkService.getInstance().getCurrentNetwork("ethereum")?.id;
    }
    async function loadTrackedTokens() {
        const chainId = evmChainId();
        if (chainId) trackedTokens = await TokenRegistry.getInstance().list(chainId);
    }
    async function addCustomToken() {
        tokenStatus = "";
        const addr = tokenAddrInput.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
            tokenStatus = "Enter a valid 0x token address";
            return;
        }
        try {
            const net = NetworkService.getInstance();
            const network = net.getCurrentNetwork("ethereum");
            if (!network) throw new Error("No EVM network selected");
            const client = net.getPublicClient(network) as any;
            const meta = await fetchTokenMetadata(client, addr);
            await TokenRegistry.getInstance().add(network.id, {
                address: addr,
                symbol: meta.symbol,
                decimals: meta.decimals,
                name: meta.name,
            });
            tokenStatus = `Added ${meta.symbol} (${meta.decimals} decimals)`;
            tokenAddrInput = "";
            await loadTrackedTokens();
        } catch (e) {
            tokenStatus = `Not a readable ERC-20: ${(e as Error).message}`;
        }
    }
    async function removeToken(address: string) {
        const chainId = evmChainId();
        if (!chainId) return;
        await TokenRegistry.getInstance().remove(chainId, address);
        await loadTrackedTokens();
    }
    let discovering = false;
    async function runDiscovery() {
        if (!currentAddress) {
            tokenStatus = "No active wallet address";
            return;
        }
        discovering = true;
        tokenStatus = "Scanning recent Transfer logs…";
        try {
            const net = NetworkService.getInstance();
            const network = net.getCurrentNetwork("ethereum");
            if (!network) throw new Error("No EVM network selected");
            const client = net.getPublicClient(network) as any;
            const latest: bigint = await client.getBlockNumber();
            // Bounded window — public RPCs cap getLogs ranges.
            const fromBlock = latest > 50_000n ? latest - 50_000n : 0n;
            const known = (await TokenRegistry.getInstance().list(network.id)).map((t) => t.address);
            const found = await discoverTokens(client, currentAddress, { fromBlock, exclude: known });
            for (const t of found) await TokenRegistry.getInstance().add(network.id, t);
            tokenStatus = found.length
                ? `Discovered ${found.length} token(s): ${found.map((t) => t.symbol).join(", ")}`
                : "No new tokens found in the recent window.";
            await loadTrackedTokens();
        } catch (e) {
            tokenStatus = `Discovery failed: ${(e as Error).message}`;
        } finally {
            discovering = false;
        }
    }

    // Address book (#25).
    import {
        AddressBookService,
        type Contact,
    } from "../services/addressBookService";
    let contacts: Contact[] = [];
    let contactName = "";
    let contactAddr = "";
    let contactStatus = "";
    async function loadContacts() {
        contacts = await AddressBookService.getInstance().list();
    }
    async function addContact() {
        contactStatus = "";
        if (!contactName.trim()) {
            contactStatus = "Enter a name";
            return;
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(contactAddr.trim())) {
            contactStatus = "Enter a valid 0x address";
            return;
        }
        await AddressBookService.getInstance().add({
            name: contactName.trim(),
            address: contactAddr.trim(),
        });
        contactName = "";
        contactAddr = "";
        await loadContacts();
    }
    async function removeContact(c: Contact) {
        await AddressBookService.getInstance().remove(c.address, c.chain);
        await loadContacts();
    }

    // Policy engine (#35): spending limits + auto-lock.
    import { PolicyService } from "../services/policyService";
    import { parseUnits, formatUnits } from "viem";
    let policyMaxTxEth = "";
    let policyDailyEth = "";
    let policyAutoLockMin = "";
    let policyStatus = "";
    async function loadPolicy() {
        const cfg = await PolicyService.getInstance().getConfig();
        policyMaxTxEth = cfg.maxTxValueWei ? formatUnits(BigInt(cfg.maxTxValueWei), 18) : "";
        policyDailyEth = cfg.dailyLimitWei ? formatUnits(BigInt(cfg.dailyLimitWei), 18) : "";
        policyAutoLockMin = cfg.autoLockMinutes ? String(cfg.autoLockMinutes) : "";
    }
    async function savePolicy() {
        policyStatus = "";
        try {
            await PolicyService.getInstance().setConfig({
                maxTxValueWei: policyMaxTxEth ? parseUnits(policyMaxTxEth, 18).toString() : undefined,
                dailyLimitWei: policyDailyEth ? parseUnits(policyDailyEth, 18).toString() : undefined,
                autoLockMinutes: policyAutoLockMin ? Number(policyAutoLockMin) : undefined,
            });
            policyStatus = "Policy saved.";
        } catch (e) {
            policyStatus = `Invalid value: ${(e as Error).message}`;
        }
    }

    // Keystore backup (#22): export this device's key share as a file.
    let backupAcknowledged = false;
    let backupStatus = "";
    function exportKeystoreBackup() {
        backupStatus = "";
        chrome.runtime.sendMessage(
            { type: "exportKeystore", chain },
            (response) => {
                if (chrome.runtime.lastError) {
                    backupStatus = `Export failed: ${chrome.runtime.lastError.message}`;
                    return;
                }
                if (response?.success && response.keystoreData) {
                    const blob = new Blob([response.keystoreData], {
                        type: "application/json",
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `starlab-share-backup-${chain}-${Date.now()}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    backupStatus = "Backup saved. Store it offline, away from this device.";
                } else {
                    backupStatus = `Export failed: ${response?.error ?? "unknown error"}`;
                }
            },
        );
    }

    onMount(async () => {
        signalRoom = (await getRoom()) ?? "";
        sandboxActive = isSandboxActive();
        await loadDappPermissions();
        await loadAllowances();
        await loadTrackedTokens();
        await loadPolicy();
        await loadContacts();
    });
    function genRoom() {
        signalRoom = newRoom();
        roomStatus = "Generated — Save, then share this exact id with co-signers.";
    }
    async function saveRoom() {
        const r = signalRoom.trim();
        if (!isValidRoom(r)) {
            roomStatus = "✗ Need ≥16 chars of [A-Za-z0-9_-] (use Generate).";
            return;
        }
        if (!(await setRoom(r))) {
            roomStatus = "✗ Save failed — couldn't write to extension storage. Reload the extension and try again.";
            return;
        }
        // Apply immediately: the startup WS connect is roomless (it ran before a
        // room existed) and the multi-tenant server rejects it, so without a
        // reconnect the saved room never takes effect. Ask the background to
        // re-resolve the URL and reconnect.
        roomStatus = "✓ Saved — reconnecting…";
        try {
            await chrome.runtime.sendMessage({ type: "reconnectSignal" });
            roomStatus = "✓ Saved & reconnecting.";
        } catch (e) {
            roomStatus = "✓ Saved. Reload the extension to apply.";
        }
    }
    const dispatch = createEventDispatcher<{
        backToWallet: { chain: string; curve: string };
    }>();

    // Theme is managed by the shared store (system | light | dark) so it
    // stays in sync with the header toggle and survives reloads.
    let currentTheme: ThemeMode = "system";
    themeMode.subscribe((v) => (currentTheme = v));
    const THEME_OPTIONS: { value: ThemeMode; label: string; icon: string }[] = [
        { value: "system", label: "System", icon: "monitor" },
        { value: "light", label: "Light", icon: "sun" },
        { value: "dark", label: "Dark", icon: "moon" },
    ];

    // Wallet configuration
    let curve: "secp256k1" | "ed25519" = "secp256k1";
    let chain: SupportedChain = "ethereum";
    let networks: Chain[] = [];
    let currentNetwork: Chain | undefined;
    let networkService: NetworkService;

    // Custom network form
    let showCustomNetworkForm = false;
    let customNetworkName = "";
    let customNetworkRpcUrl = "";
    let customNetworkChainId = "";
    let customNetworkSymbol = "";
    let customNetworkExplorer = "";
    let customNetworkError = "";

    // Initialize network service and load data
    onMount(async () => {
        networkService = NetworkService.getInstance();

        try {
            // Sync chain with current settings
            const message = await chrome.runtime.sendMessage({
                type: "getState",
            });
            if (message && message.blockchain) {
                chain = message.blockchain;
                // Get curve from state if available, otherwise use sensible default
                if (message.curve) {
                    curve = message.curve;
                } else {
                    // Legacy support: default curve for existing chain selection
                    curve = chain === "ethereum" ? "secp256k1" : "ed25519";
                }
            }

            // Get networks for current chain - use new method that supports Layer 2 chains
            const chainNetworks = networkService.getNetworksForChain(chain);
            if (Array.isArray(chainNetworks)) {
                networks = chainNetworks;
                currentNetwork =
                    networkService.getCurrentNetworkForChain(chain);
            } else {
                console.error(
                    "[Settings] Networks is not an array:",
                    chainNetworks,
                );
                networks = [];
            }
        } catch (error) {
            console.error("[Settings] Error initializing:", error);
        }
    });

    // Handle curve change - validate compatibility and set sensible defaults
    function handleCurveChange() {
        console.log("[Settings] Curve changed to:", curve);

        // Check if current chain is compatible with new curve
        const compatibleChains = getCompatibleChains(curve);
        if (!compatibleChains.includes(chain)) {
            // Current chain is not compatible, switch to the first compatible chain
            chain = compatibleChains[0];
            console.log("[Settings] Switched to compatible chain:", chain);
        }

        updateBlockchainSelection();
    }

    // Handle chain change - validate compatibility and set sensible defaults
    function handleChainChange() {
        console.log("[Settings] Chain changed to:", chain);

        // Ensure curve is compatible with the selected chain
        const requiredCurve = getRequiredCurve(chain);
        if (curve !== requiredCurve) {
            curve = requiredCurve;
            console.log("[Settings] Updated curve to compatible:", curve);
        }

        updateBlockchainSelection();

        try {
            // Update networks list when chain changes - use new method that supports Layer 2 chains
            const chainNetworks = networkService.getNetworksForChain(chain);
            if (Array.isArray(chainNetworks)) {
                networks = chainNetworks;
                currentNetwork =
                    networkService.getCurrentNetworkForChain(chain);
            } else {
                console.error(
                    "[Settings] Networks is not an array:",
                    chainNetworks,
                );
                networks = [];
            }
        } catch (error) {
            console.error("[Settings] Error updating networks:", error);
            networks = [];
        }
    }

    // Update blockchain selection in background
    // Event dispatcher for parent components

    function updateBlockchainSelection() {
        chrome.runtime.sendMessage(
            {
                type: "setBlockchain",
                blockchain: chain,
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error(
                        "[Settings] Error setting blockchain:",
                        chrome.runtime.lastError.message,
                    );
                } else {
                    console.log(
                        "[Settings] Blockchain selection saved:",
                        chain,
                    );
                    // Only update locally without closing settings
                    // We don't want to automatically return to wallet page anymore
                    console.log(
                        "[Settings] Blockchain selection saved locally:",
                        chain,
                    );
                }
            },
        );
    }

    // Handle network change
    async function handleNetworkChange(event: Event) {
        const select = event.target as HTMLSelectElement;
        const networkId = parseInt(select.value, 10);
        try {
            await networkService.setCurrentNetworkForChain(chain, networkId);
            currentNetwork = networkService.getCurrentNetworkForChain(chain);
        } catch (error) {
            console.error("[Settings] Failed to change network:", error);
        }
    }

    // Toggle custom network form
    function toggleCustomNetworkForm() {
        showCustomNetworkForm = !showCustomNetworkForm;
        resetCustomNetworkForm();
    }

    // Reset custom network form
    function resetCustomNetworkForm() {
        customNetworkName = "";
        customNetworkRpcUrl = "";
        customNetworkChainId = "";
        customNetworkSymbol = "";
        customNetworkExplorer = "";
        customNetworkError = "";
    }

    // Add custom network
    async function addCustomNetwork() {
        if (
            !customNetworkName ||
            !customNetworkRpcUrl ||
            !customNetworkChainId ||
            !customNetworkSymbol
        ) {
            customNetworkError = "Please fill out all required fields";
            return;
        }

        const chainId = parseInt(customNetworkChainId, 10);
        if (isNaN(chainId)) {
            customNetworkError = "Chain ID must be a valid number";
            return;
        }

        try {
            // Create a custom chain configuration
            const customChain: Chain = {
                id: chainId,
                name: customNetworkName,
                network: customNetworkName.toLowerCase().replace(/\s+/g, "-"),
                nativeCurrency: {
                    name: customNetworkName,
                    symbol: customNetworkSymbol,
                    decimals: 18,
                },
                rpcUrls: {
                    default: {
                        http: [customNetworkRpcUrl],
                    },
                    public: {
                        http: [customNetworkRpcUrl],
                    },
                },
                blockExplorers: customNetworkExplorer
                    ? {
                          default: {
                              name: "Explorer",
                              url: customNetworkExplorer,
                          },
                      }
                    : undefined,
            };

            // Add the custom network - use new method that supports Layer 2 chains
            await networkService.addNetworkForChain(chain, customChain);

            // Refresh the networks list - use new method that supports Layer 2 chains
            networks = networkService.getNetworksForChain(chain);

            // Switch to the new network - use new method that supports Layer 2 chains
            await networkService.setCurrentNetworkForChain(chain, chainId);
            currentNetwork = networkService.getCurrentNetworkForChain(chain);

            // Hide the form
            showCustomNetworkForm = false;
            resetCustomNetworkForm();
        } catch (error) {
            console.error("[Settings] Failed to add custom network:", error);
            customNetworkError = `Failed to add network: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
</script>

<div class="space-y-4">
    <div class="flex items-center justify-between">
        <h2 class="text-base font-bold">Settings</h2>
        <Button
            variant="secondary"
            size="sm"
            on:click={() => dispatch("backToWallet", { chain, curve })}
        >
            Done
        </Button>
    </div>

    <!-- Appearance -->
    <div class="card card-pad">
        <h3 class="section-title mb-2.5">Appearance</h3>
        <div class="grid grid-cols-3 gap-1.5 rounded-xl bg-surface-2 p-1">
            {#each THEME_OPTIONS as opt}
                <button
                    class="flex flex-col items-center gap-1 rounded-lg py-2 text-xs font-semibold transition {currentTheme ===
                    opt.value
                        ? 'bg-surface text-content shadow-sm'
                        : 'text-muted hover:text-content'}"
                    on:click={() => setTheme(opt.value)}
                >
                    <Icon name={opt.icon} size={16} />
                    {opt.label}
                </button>
            {/each}
        </div>
    </div>

    <!-- Signal server / tenant room -->
    <div class="card card-pad space-y-2">
        <h3 class="section-title">Signal server room</h3>
        <p class="text-xs text-muted">
            The hosted server requires a strong room. All co-signers of a wallet
            must use the <strong>same</strong> room. Reconnect after changing it.
        </p>
        <div class="flex items-center gap-2">
            <input
                type="text"
                class="input flex-1 text-xs"
                placeholder="strong room id (shared)"
                bind:value={signalRoom}
                data-testid="room-input"
            />
            <Button variant="ghost" size="sm" on:click={genRoom}>Generate</Button>
            <Button size="sm" on:click={saveRoom}>Save</Button>
        </div>
        {#if roomStatus}
            <span class="text-xs text-muted" data-testid="room-status">{roomStatus}</span>
        {/if}
    </div>

    <!-- Connected dApps (#15): review + revoke per-origin permissions -->
    <div class="card card-pad space-y-2">
        <h3 class="section-title">Connected dApps</h3>
        {#if dappPermissions.length === 0}
            <p class="text-xs text-muted">No dApps connected.</p>
        {:else}
            <ul class="space-y-2">
                {#each dappPermissions as p (p.origin)}
                    <li class="flex items-center justify-between gap-2">
                        <div class="min-w-0">
                            <div class="truncate text-xs font-semibold">{p.origin}</div>
                            <div class="truncate text-xs text-muted">
                                {p.connectedAccounts.map(shortAcct).join(", ")}
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            on:click={() => revokeDapp(p.origin)}
                        >
                            Revoke
                        </Button>
                    </li>
                {/each}
            </ul>
            <p class="text-xs text-muted">
                Revoking removes the site's access; it takes effect on the
                site's next request.
            </p>
        {/if}
    </div>

    <!-- Address book (#25) -->
    <div class="card card-pad space-y-2">
        <h3 class="section-title">Address book</h3>
        {#if contacts.length > 0}
            <ul class="space-y-1">
                {#each contacts as c (c.chain + ":" + c.address)}
                    <li class="flex items-center justify-between gap-2 text-xs">
                        <span class="truncate"><strong>{c.name}</strong> · {c.address.slice(0, 8)}…{c.address.slice(-4)}</span>
                        <Button size="sm" variant="ghost" on:click={() => removeContact(c)}>Remove</Button>
                    </li>
                {/each}
            </ul>
        {/if}
        <div class="flex items-center gap-2">
            <input type="text" class="input w-24 text-xs" placeholder="Name" bind:value={contactName} />
            <input type="text" class="input flex-1 text-xs" placeholder="0x…" bind:value={contactAddr} />
            <Button size="sm" on:click={addContact}>Add</Button>
        </div>
        {#if contactStatus}
            <p class="text-xs text-muted">{contactStatus}</p>
        {/if}
    </div>

    <!-- Policy (#35): spending limits + auto-lock -->
    <div class="card card-pad space-y-2">
        <h3 class="section-title">Spending policy</h3>
        <p class="text-xs text-muted">
            Limits are enforced before any signing starts. A blocked send fails
            with the policy reason; loosen the limits here if you really mean it.
        </p>
        <div class="grid grid-cols-3 gap-2">
            <label class="text-xs">
                Max per tx (ETH)
                <input type="text" class="input mt-1 text-xs" placeholder="∞" bind:value={policyMaxTxEth} />
            </label>
            <label class="text-xs">
                Daily limit (ETH)
                <input type="text" class="input mt-1 text-xs" placeholder="∞" bind:value={policyDailyEth} />
            </label>
            <label class="text-xs">
                Auto-lock (min)
                <input type="text" class="input mt-1 text-xs" placeholder="never" bind:value={policyAutoLockMin} />
            </label>
        </div>
        <div class="flex items-center gap-2">
            <Button size="sm" on:click={savePolicy}>Save policy</Button>
            {#if policyStatus}<span class="text-xs text-muted">{policyStatus}</span>{/if}
        </div>
    </div>

    <!-- Backup (#22): export this device's key share -->
    <div class="card card-pad space-y-2">
        <h3 class="section-title">Backup</h3>
        <p class="text-xs text-muted">
            Exports <strong>this device's key share</strong> as a file (CLI-compatible).
            One share alone can never sign — the threshold protects you — but treat
            the file like a secret: store it offline, never paste it anywhere.
            Restore via "Import keystore" or the CLI.
        </p>
        <label class="flex items-center gap-2 text-xs">
            <input type="checkbox" bind:checked={backupAcknowledged} />
            I understand this file contains key material
        </label>
        <div class="flex items-center gap-2">
            <Button size="sm" on:click={exportKeystoreBackup} disabled={!backupAcknowledged}>
                Export share backup
            </Button>
        </div>
        {#if backupStatus}
            <p class="text-xs text-muted">{backupStatus}</p>
        {/if}
    </div>

    <!-- Devices / Reshare (M3 #23): rotate shares or retire a device -->
    <ReshareCard />

    <!-- Tokens (#21): tracked list + custom add + auto-discovery -->
    <div class="card card-pad space-y-2">
        <h3 class="section-title">Tokens</h3>
        {#if trackedTokens.length > 0}
            <ul class="space-y-1">
                {#each trackedTokens as t (t.address)}
                    <li class="flex items-center justify-between gap-2 text-xs">
                        <span class="truncate"><strong>{t.symbol}</strong> · {t.address.slice(0, 8)}…{t.address.slice(-4)}</span>
                        <Button size="sm" variant="ghost" on:click={() => removeToken(t.address)}>Remove</Button>
                    </li>
                {/each}
            </ul>
        {/if}
        <div class="flex items-center gap-2">
            <input
                type="text"
                class="input flex-1 text-xs"
                placeholder="0x… token contract"
                bind:value={tokenAddrInput}
            />
            <Button size="sm" on:click={addCustomToken}>Add</Button>
            <Button size="sm" variant="ghost" on:click={runDiscovery} disabled={discovering}>
                {discovering ? "Scanning…" : "Discover"}
            </Button>
        </div>
        {#if tokenStatus}
            <p class="text-xs text-muted">{tokenStatus}</p>
        {/if}
    </div>

    <!-- Token approvals (#17): review + revoke ERC-20 allowances -->
    <div class="card card-pad space-y-2">
        <h3 class="section-title">Token approvals</h3>
        {#if allowances.length === 0}
            <p class="text-xs text-muted">
                No active approvals recorded. Approvals signed in this wallet
                appear here for review and revocation.
            </p>
        {:else}
            <ul class="space-y-2">
                {#each allowances as r (r.chainId + r.token + r.spender)}
                    <li class="flex items-center justify-between gap-2">
                        <div class="min-w-0 text-xs">
                            <div class="truncate font-semibold">
                                token {shortHexId(r.token)} → spender {shortHexId(r.spender)}
                            </div>
                            <div class="truncate text-muted">
                                {r.current === -1n ? "current allowance unknown" : `allowance: ${r.current}`}
                            </div>
                        </div>
                        <Button size="sm" variant="ghost" on:click={() => revokeAllowance(r)}>
                            Revoke
                        </Button>
                    </li>
                {/each}
            </ul>
        {/if}
        {#if allowanceStatus}
            <p class="text-xs text-muted">{allowanceStatus}</p>
        {/if}
    </div>

    <!-- Sandbox mode (#31): one-click switch onto local fork nodes -->
    <div class="card card-pad space-y-2">
        <h3 class="section-title">Sandbox mode</h3>
        <p class="text-xs text-muted">
            Point the wallet at local fork chains (anvil :8545 / surfpool :8899)
            — real signing &amp; broadcast, no real funds. Start the nodes with
            <code>scripts/sandbox.sh</code>.
        </p>
        <div class="flex items-center gap-2">
            <Button
                size="sm"
                variant={sandboxActive ? "ghost" : undefined}
                on:click={toggleSandbox}
                data-testid="sandbox-toggle"
            >
                {sandboxActive ? "Exit sandbox" : "Enter sandbox"}
            </Button>
            {#if sandboxStatus}
                <span class="text-xs text-muted">{sandboxStatus}</span>
            {/if}
        </div>
    </div>

    <!-- Network -->
    <div class="card card-pad space-y-3">
        <h3 class="section-title">Network</h3>

        <div>
            <label class="label" for="chain-select">Blockchain</label>
            <select
                id="chain-select"
                bind:value={chain}
                on:change={handleChainChange}
                class="select"
            >
                <optgroup label="Ethereum / EVM (secp256k1)">
                    <option value="ethereum">Ethereum</option>
                    <option value="polygon">Polygon</option>
                    <option value="arbitrum">Arbitrum</option>
                    <option value="optimism">Optimism</option>
                    <option value="base">Base</option>
                </optgroup>
                <optgroup label="ed25519">
                    <option value="solana">Solana</option>
                    <option value="sui">Sui</option>
                </optgroup>
            </select>
        </div>

        {#if ["ethereum", "polygon", "arbitrum", "optimism", "base"].includes(chain) && networks.length > 0}
            <div>
                <label class="label" for="network-select">Network</label>
                <select
                    id="network-select"
                    on:change={handleNetworkChange}
                    class="select"
                    value={currentNetwork?.id}
                >
                    {#each networks as network}
                        <option value={network.id}>{network.name}</option>
                    {/each}
                </select>
            </div>

            <button
                class="btn btn-secondary btn-sm btn-block"
                on:click={toggleCustomNetworkForm}
            >
                {showCustomNetworkForm ? "Hide custom network" : "Add custom network"}
            </button>

            {#if currentNetwork}
                <div class="rounded-lg bg-surface-2 p-2.5 text-xs text-muted">
                    <p><span class="font-semibold">Chain ID:</span> {currentNetwork.id}</p>
                    <p>
                        <span class="font-semibold">Name:</span>
                        {currentNetwork.name}
                    </p>
                    {#if currentNetwork.rpcUrls?.default?.http}
                        <p class="break-all">
                            <span class="font-semibold">RPC:</span>
                            {currentNetwork.rpcUrls.default.http[0]}
                        </p>
                    {/if}
                </div>
            {/if}
        {/if}

        <!-- Advanced: curve (technical) -->
        <details class="text-sm">
            <summary class="cursor-pointer text-xs font-semibold text-muted"
                >Advanced</summary
            >
            <div class="mt-2">
                <label class="label" for="curve-select">Signature curve</label>
                <select
                    id="curve-select"
                    bind:value={curve}
                    on:change={handleCurveChange}
                    class="select"
                >
                    <option value="secp256k1">secp256k1</option>
                    <option value="ed25519">ed25519</option>
                </select>
            </div>
        </details>
    </div>

    <!-- Add Custom Network -->
    {#if showCustomNetworkForm}
        <div class="card card-pad space-y-3">
            <h3 class="section-title">Add custom network</h3>

            {#if customNetworkError}
                <div class="alert alert-danger text-xs">{customNetworkError}</div>
            {/if}

            <div>
                <label class="label" for="network-name">Network name</label>
                <input
                    id="network-name"
                    type="text"
                    class="input"
                    placeholder="My Custom Network"
                    bind:value={customNetworkName}
                />
            </div>
            <div>
                <label class="label" for="network-rpc">RPC URL</label>
                <input
                    id="network-rpc"
                    type="text"
                    class="input"
                    placeholder="https://rpc.example.com"
                    bind:value={customNetworkRpcUrl}
                />
            </div>
            <div class="grid grid-cols-2 gap-3">
                <div>
                    <label class="label" for="network-chainid">Chain ID</label>
                    <input
                        id="network-chainid"
                        type="text"
                        class="input"
                        placeholder="1"
                        bind:value={customNetworkChainId}
                    />
                </div>
                <div>
                    <label class="label" for="network-symbol">Symbol</label>
                    <input
                        id="network-symbol"
                        type="text"
                        class="input"
                        placeholder="ETH"
                        bind:value={customNetworkSymbol}
                    />
                </div>
            </div>
            <div>
                <label class="label" for="network-explorer"
                    >Block explorer (optional)</label
                >
                <input
                    id="network-explorer"
                    type="text"
                    class="input"
                    placeholder="https://etherscan.io"
                    bind:value={customNetworkExplorer}
                />
            </div>

            <div class="flex gap-2">
                <Button variant="secondary" block on:click={toggleCustomNetworkForm}>
                    Cancel
                </Button>
                <Button block variant="success" on:click={addCustomNetwork}>
                    Save network
                </Button>
            </div>
        </div>
    {/if}
</div>
