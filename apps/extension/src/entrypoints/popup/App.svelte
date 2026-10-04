<script lang="ts">
    import FeatureHeader from "../../lib/ui/FeatureHeader.svelte";
    import ChainIcon from "../../lib/ui/ChainIcon.svelte";
    import { openInvites } from "../../utils/wallet-id";
    import { signingInviteChain, signingInviteDecision, signingInviteKey } from "./signingInvite";
    // Removed single-party WASM functions - this is now an MPC-only wallet
    import { onMount, onDestroy } from "svelte";
    import {
        themeMode,
        setTheme,
        initTheme,
        type ThemeMode,
    } from "../../lib/theme";
    import Icon from "../../lib/ui/Icon.svelte";
    import Button from "../../lib/ui/Button.svelte";
    import Modal from "../../lib/ui/Modal.svelte";
    import CopyButton from "../../lib/ui/CopyButton.svelte";
    import { guideError } from "../../utils/error-guidance";
    import Collapsible from "../../lib/ui/Collapsible.svelte";
    import { storage } from "#imports";
    import type {
        AppState,
        ProtocolBlockchain,
        SupportedChain,
        WalletCurve,
    } from "@stars-labs/types/appstate";
    import { MeshStatusType } from "@stars-labs/types/mesh";
    import { DkgState } from "@stars-labs/types/dkg";
    import {
        CHAIN_METADATA,
        INITIAL_APP_STATE,
        getChainLabel,
        getDefaultChainForCurve,
        getProtocolBlockchainForChain,
        getRequiredCurve,
        isEvmChain,
        isSupportedChain,
        normalizeDerivedAddressChain,
    } from "@stars-labs/types/appstate";
    import Settings from "../../components/Settings.svelte";
    import AccountManager from "../../components/AccountManager.svelte";
    import SignatureRequest from "../../components/SignatureRequest.svelte";
    import ConnectRequest from "../../components/ConnectRequest.svelte";
    import type { ConnectRequestView } from "../background/connectRequest";
    import PasswordPrompt from "./components/PasswordPrompt.svelte";
    import WalletSelector from "./components/WalletSelector.svelte";
    import CreateWalletForm from "../../components/CreateWalletForm.svelte";
    import { formatUserError } from "../../services/walletErrors";
    import TokenList from "./components/TokenList.svelte";
    import ActivityFeed from "./components/ActivityFeed.svelte";
    import NftGallery from "./components/NftGallery.svelte";
    import { observeKeystoreSession } from "../../utils/keystoreSession";
    import { verifyEthereumSignature } from "../../utils/signatureVerification";
    import { addressForChain, publicWalletState } from "../../utils/walletAccount";
    import AccountPicker from "./components/AccountPicker.svelte";
    import Onboarding from "./components/Onboarding.svelte";
    import SendForm from "./components/SendForm.svelte";
    import ReceiveCard from "./components/ReceiveCard.svelte";
    import { MESSAGE_TYPES } from "@stars-labs/types/messages";
    import { hashMessage } from "viem";
    import AccountService from "../../services/accountService";
    import type { Account } from "@stars-labs/types/account";
    import { discoverLedgerAccounts } from "../../signers/ledger/ledger-signer";
    import { requestLedgerTransport } from "../../signers/ledger/transport";
    import { getRoom, ROOM_STORAGE_KEY } from "../../config/signal-server";

    // Hardware/simulation accounts are mirrored into AccountService. Surface
    // them even when no FROST wallet exists yet, so non-MPC first-run paths
    // still show the account list.
    let hasExternalAccounts = false;
    let accountSetupStatus = "";
    let createdDkgSessionId = "";
    let hasSignalRoom = false;
    let signalRoom = "";
    let removeSignalRoomStorageListener: (() => void) | null = null;

    async function refreshSignalRoomState() {
        signalRoom = (await getRoom()) ?? "";
        hasSignalRoom = signalRoom.length > 0;
    }

    async function reconnectSignalAfterRoomSave() {
        await refreshSignalRoomState();
        await chrome.runtime.sendMessage({ type: "reconnectSignal" });
    }

    $: signalStatusBadge = appState.wsConnected
        ? "badge-success"
        : hasSignalRoom
          ? "badge-danger"
          : "badge-warning";
    $: signalStatusLabel = appState.wsConnected
        ? "Online"
        : hasSignalRoom
          ? "Offline"
          : "No room";
    $: signalStatusTitle = appState.wsConnected
        ? "Connected to the signal server"
        : hasSignalRoom
          ? "Not connected to the signal server"
          : "Generate or enter a signal room to connect";
    $: activeShareSessionId = appState.sessionInfo?.session_id ?? createdDkgSessionId;
    $: setupInviteText = activeShareSessionId
        ? [
              "Starlab Wallet setup",
              `Room: ${signalRoom || "(not set)"}`,
              `Session ID: ${activeShareSessionId}`,
              appState.sessionInfo
                  ? `Wallet: ${appState.sessionInfo.threshold}-of-${appState.sessionInfo.total}`
                  : "",
              `Network: ${chainLabel(appState.chain)}`,
          ]
              .filter(Boolean)
              .join("\n")
        : "";

    // Theme (system | light | dark). initTheme() applies the saved mode
    // and live-tracks the OS preference while in "system". The cycle
    // button in the header rotates system → light → dark → system.
    let themeModeValue: ThemeMode = "system";
    const unsubTheme = themeMode.subscribe((v) => (themeModeValue = v));
    function cycleTheme() {
        const next: ThemeMode =
            themeModeValue === "system"
                ? "light"
                : themeModeValue === "light"
                  ? "dark"
                  : "system";
        setTheme(next);
    }
    const themeIcon: Record<ThemeMode, string> = {
        system: "monitor",
        light: "sun",
        dark: "moon",
    };

    // Developer/advanced section toggle (Peer ID, device list, manual
    // session proposal, import/export, test actions). Collapsed by
    // default so the main surface stays product-focused.
    let showDeveloper = false;
    let showAccountSetup = false;

    onMount(() => initTheme());
    onDestroy(() => unsubTheme());

    // Address copy feedback; protocol details live under Advanced.
    let showSend = false;
    let showReceive = false;
    let sendStatus = "";
    // Switcher polish (#16): bumping this remounts the balance/activity panels
    // and refetches hero fiat — fired on wallet switch and network switch so
    // every data view tracks the active (account, network) pair.
    let dataEpoch = 0;
    function refreshWalletData() {
        dataEpoch += 1;
        heroFiatFor = ""; // force the hero fiat reactive block to refetch
    }

    // Header network switcher (#16): compact per-curve EVM network select.
    import NetworkServicePopup from "../../services/networkService";
    let evmNetworks: { id: number; name: string }[] = [];
    let currentEvmNetworkId: number | undefined = undefined;
    let networkChoicesFor: string = "";
    function activeEvmChain(): SupportedChain {
        return isEvmChain(appState.chain) ? appState.chain : "ethereum";
    }
    async function loadNetworkChoices(chain: SupportedChain = activeEvmChain()) {
        const net = NetworkServicePopup.getInstance();
        await net.ensureInitialized();
        if (!isEvmChain(chain)) {
            evmNetworks = [];
            currentEvmNetworkId = undefined;
            networkChoicesFor = chain;
            return;
        }
        await net.setCurrentChain(chain);
        evmNetworks = net.getNetworksForChain(chain).map((n) => ({ id: n.id, name: n.name }));
        currentEvmNetworkId = net.getCurrentNetworkForChain(chain)?.id;
        networkChoicesFor = chain;
    }
    async function switchEvmNetwork(e: Event) {
        const id = Number((e.target as HTMLSelectElement).value);
        try {
            const net = NetworkServicePopup.getInstance();
            const chain = activeEvmChain();
            await net.setCurrentNetworkForChain(chain, id);
            currentEvmNetworkId = id;
            networkChoicesFor = chain;
            refreshWalletData();
        } catch (err) {
            console.error("[UI] network switch failed:", err);
        }
    }
    onMount(loadNetworkChoices);

    // Account model (BIP-44 all the way): account 0 is the identity; the
    // root group key is derivation-parent only and never shown.
    let selectedAccount = 0;
    let accountAddresses: { chain: string; path: string; address: string }[] = [];
    function onAccountSelect(e: CustomEvent) {
        selectedAccount = e.detail.account;
        accountAddresses = e.detail.addresses;
        refreshWalletData(); // remount balance/activity panels for the new address
    }
    // Panels always use the selected account on the selected chain.
    $: displayAddress = addressForChain(accountAddresses, appState.chain) ?? "";

    // Onboarding wizard dismissal (#26) — session-scoped; the wizard also
    // disappears permanently once a wallet exists.
    let onboardingDismissed = false;

    // Hero-card portfolio fiat total (#13). null = not loaded / unavailable.
    let heroFiat: number | null = null;
    let heroFiatFor = ""; // chain:address the current value belongs to
    async function loadHeroFiat(address: string, chain: SupportedChain) {
        try {
            const res = await chrome.runtime.sendMessage({ type: "getPortfolio", address, chain });
            if (res?.success && typeof res.portfolio?.totalFiat === "number") {
                heroFiat = res.portfolio.totalFiat;
                heroFiatFor = `${chain}:${address}`;
            }
        } catch {
            /* price feed down — keep whatever we had */
        }
    }
    // Refresh whenever the displayed address changes (wallet switch / DKG done).
    $: if (isEvmChain(appState.chain) && displayAddress && `${appState.chain}:${displayAddress}` !== heroFiatFor) {
        loadHeroFiat(displayAddress, appState.chain);
    }
    async function handleSendSubmit(e: CustomEvent) {
        const { tx, asset, amount, to, tokenAddress } = e.detail;
        sendStatus = "Submitting…";
        try {
            const res = await chrome.runtime.sendMessage({
                type: "rpcRequest",
                payload: {
                    jsonrpc: "2.0",
                    id: Date.now(),
                    method: "eth_sendTransaction",
                    params: [tx],
                },
            });
            if (res?.error) {
                sendStatus = formatUserError(new Error(String(res.error.message ?? res.error)));
            } else {
                // Hardware path broadcasts and returns the tx hash — show it
                // so the user can match the pending entry in the activity feed.
                const hash = typeof res?.result === "string" ? res.result : "";
                const broadcast = hash.startsWith("0x") && hash.length === 66;
                if (broadcast) {
                    // Record the send as pending activity (#11) under the
                    // signing account, with the exact broadcast fields. Best
                    // effort: the background dedupes by (chainId, hash), and
                    // a record failure must not look like a failed send.
                    try {
                        await chrome.runtime.sendMessage({
                            type: "recordActivity",
                            address: displayAddress,
                            chain: appState.chain,
                            activity: {
                                hash,
                                chainId: currentEvmNetworkId ?? 1,
                                from: tx.from ?? displayAddress,
                                to: tx.to,
                                value: tx.value ? BigInt(tx.value).toString() : "0",
                                kind: tokenAddress ? "token-transfer" : "send",
                                tokenAddress,
                            },
                        });
                        refreshWalletData(); // remount the feed so the pending row shows now
                    } catch (recErr) {
                        console.warn("[UI] recordActivity failed:", recErr);
                    }
                }
                sendStatus = broadcast
                    ? `Submitted ${amount} ${asset} → ${to.slice(0, 8)}… (tx ${hash.slice(0, 10)}…)`
                    : `Sent ${amount} ${asset} → ${to.slice(0, 8)}…`;
                showSend = false;
            }
        } catch (err) {
            sendStatus = formatUserError(err);
        }
    }
    let addrCopied = false;
    async function copyAddress(addr: string | undefined) {
        if (!addr) return;
        try {
            await navigator.clipboard.writeText(addr);
            addrCopied = true;
            setTimeout(() => (addrCopied = false), 1600);
        } catch (e) {
            console.warn("[UI] Address copy failed:", e);
        }
    }

    // Productized labels for the active blockchain/curve.
    /** Safe-prime pre-generation for the next wallet's Ethereum key: real
     *  progress (primes finished of the set), never a guess. */
    function ecdsaPrimesLabel(p: AppState["ecdsaPrimes"]): string {
        if (!p || p.state === "idle") return "Preparing secure signing";
        if (p.state === "ready") return "Secure signing ready";
        return `Preparing secure signing (${Math.round((100 * p.done) / p.total)}%)`;
    }

    function chainLabel(chain: string | undefined): string {
        return getChainLabel(chain);
    }
    function curveFromSessionCurve(curve: string | undefined): WalletCurve {
        return curve === "ed25519" ? "ed25519" : "secp256k1";
    }
    function chainFromSession(invite: { blockchain?: string; curve_type?: string }): SupportedChain {
        if (isSupportedChain(invite.blockchain)) return invite.blockchain;
        return getDefaultChainForCurve(curveFromSessionCurve(invite.curve_type));
    }
    function protocolChainFor(chain: string | undefined): ProtocolBlockchain {
        return isSupportedChain(chain)
            ? getProtocolBlockchainForChain(chain)
            : chain === "solana"
              ? "solana"
              : "ethereum";
    }
    function shortAddr(addr: string | undefined): string {
        if (!addr) return "";
        return addr.length > 14
            ? `${addr.slice(0, 8)}…${addr.slice(-6)}`
            : addr;
    }

    // Ext-1b: toggled when the user clicks "+ Create Wallet". Shows
    // the CreateWalletForm overlay until they submit or cancel.
    let showCreateWallet = false;

    function refreshExternalAccountFlags(accountService = AccountService.getInstance()) {
        const accounts = accountService.getAccounts();
        hasExternalAccounts = accounts.some(
            (a) => a.type === "hardware" || a.type === "watch-only",
        );
    }

    async function connectLedgerAccounts() {
        accountSetupStatus = "Opening Ledger connection...";
        try {
            const transport = await requestLedgerTransport();
            const accountService = AccountService.getInstance();
            await accountService.ensureInitialized();
            const signers = await discoverLedgerAccounts(transport);
            if (signers.length === 0) {
                accountSetupStatus =
                    "No Ledger accounts found. Unlock the device and open the Ethereum or Solana app.";
                return;
            }

            for (const signer of signers) {
                const blockchain: Account["blockchain"] =
                    signer.curve === "ed25519" ? "solana" : "ethereum";
                const account: Account = {
                    id: signer.id,
                    address: signer.address(),
                    name:
                        signer.curve === "ed25519"
                            ? "Ledger Solana"
                            : "Ledger Ethereum",
                    balance: "0",
                    blockchain,
                    created: Date.now(),
                    type: "hardware",
                    metadata: {
                        source: "imported",
                        tags: ["ledger", signer.kind],
                    },
                };
                await accountService.addOrUpdateAccount(account);
            }
            await accountService.setCurrentAccount(signers[0].id);
            appState.chain = signers[0].curve === "ed25519" ? "solana" : "ethereum";
            appState.blockchain = protocolChainFor(appState.chain);
            appState = { ...appState };
            // Persist the chain selection to the background StateManager so the
            // next initialState broadcast does not overwrite it back.
            await chrome.runtime.sendMessage({
                type: "setBlockchain",
                blockchain: appState.chain,
            });
            refreshExternalAccountFlags(accountService);
            accountSetupStatus = `Added ${signers.length} Ledger account${signers.length === 1 ? "" : "s"}.`;
        } catch (err) {
            accountSetupStatus = formatUserError(err);
        }
    }

    async function refreshYubiKeyAccounts() {
        accountSetupStatus = "Refreshing YubiKey accounts...";
        try {
            const response = await chrome.runtime.sendMessage({
                type: "discoverYubiKeyAccounts",
            });
            const accountService = AccountService.getInstance();
            await accountService.ensureInitialized();
            const current = accountService.getCurrentAccount();
            if (!current) {
                const firstYubiKey = accountService
                    .getAccounts()
                    .find((a) => a.id.startsWith("yubikey:"));
                if (firstYubiKey) {
                    await accountService.setCurrentAccount(firstYubiKey.id);
                    appState.chain = firstYubiKey.blockchain;
                    appState.blockchain = protocolChainFor(appState.chain);
                    appState = { ...appState };
                }
            }
            refreshExternalAccountFlags(accountService);
            if (!response?.success) {
                accountSetupStatus =
                    response?.error ?? "YubiKey discovery failed.";
                return;
            }
            accountSetupStatus =
                response.count > 0
                    ? `Added ${response.count} YubiKey account${response.count === 1 ? "" : "s"}.`
                    : "No YubiKey accounts found. Check the native host and card.";
        } catch (err) {
            accountSetupStatus = formatUserError(err);
        }
    }

    async function addSimulationAccount(
        address: string,
        blockchain: Account["blockchain"] = "ethereum",
    ) {
        accountSetupStatus = "";
        try {
            const accountService = AccountService.getInstance();
            await accountService.ensureInitialized();
            const normalized = address.trim();
            const account: Account = {
                id: `simulation:${blockchain}:${normalized.toLowerCase()}`,
                address: normalized,
                name: `Simulation ${chainLabel(blockchain)}`,
                balance: "0",
                blockchain,
                created: Date.now(),
                type: "watch-only",
                metadata: {
                    source: "imported",
                    tags: ["simulation", "watch-only"],
                },
            };
            await accountService.addOrUpdateAccount(account);
            await accountService.setCurrentAccount(account.id);
            appState.chain = blockchain;
            appState.blockchain = protocolChainFor(blockchain);
            appState = { ...appState };
            refreshExternalAccountFlags(accountService);
            accountSetupStatus = "Simulation address added.";
        } catch (err) {
            accountSetupStatus = formatUserError(err);
        }
    }

    // Ext-1d: post-DKG save-wallet form state. These live on the
    // popup component (ephemeral) not appState because they contain
    // the user's password, which must NEVER cross the port boundary
    // cached in background — only on the explicit SAVE_DKG_WALLET
    // message.
    let saveWalletName = "";
    let savePassword = "";
    let saveConfirm = "";
    let saveError = "";
    let saving = false;

    // Ext-2a: Sign Transaction form state. Shown when keystore is
    // initialized + unlocked + there's no active session (can't
    // start a new ceremony mid-ceremony). Popup-local because the
    // typed message doesn't need to survive popup close — if the
    // user closes without hitting Sign, the draft is discarded,
    // which matches TUI's behavior (clear_sign_draft on screen exit).
    let showSignForm = false;
    let signMessage = "";
    let signError = "";
    let signing_ = false;
    let signWalletId = "";

    // Ext-2c: confirm-before-broadcast preview. Populated when the
    // user clicks "Preview" on the sign form. Shows wallet + message
    // + EIP-191 hash (secp256k1 only) so a tap-Enter-once-too-many
    // can't silently announce the wrong payload to the mesh. Mirrors
    // TUI's Stage 3 PendingSignPreview + Modal::Confirm flow (58c9f85).
    // Cancel preserves the draft message so the user can edit +
    // re-preview without retyping.
    type SignPreview = {
        walletName: string;
        walletBlockchain: string;
        walletAddress: string;
        message: string;
        eip191Hash: `0x${string}` | null;
    };
    let signPreview: SignPreview | null = null;

    // Ext-2e: populated when the offscreen FROST ceremony finalizes
    // (via the `signingCompleted` message from background). Renders
    // a dismissable banner with the aggregated signature hex + a
    // copy-to-clipboard button. Ethereum signs the EIP-191 hash with
    // the threshold-ECDSA key, yielding an ecrecover-compatible signature.
    type SignatureBanner = {
        signingId: string;
        signature: string;
        messageHex: string;
        blockchain: "ethereum" | "solana";
        sessionId: string;
    };
    let signatureBanner: SignatureBanner | null = null;
    let signatureVerification = "";
    let signatureCopied = false;

    // Ext-3b: TUI Stage 1 parity (a4c52ca). When a signing-session
    // broadcast lands with us as a participant, auto-open a review
    // modal so a user who has the popup open (maybe after opening
    // it via the Ext-3a notification) sees the request immediately
    // rather than having to scroll to the invites list. User can
    // Review → join, or Later → dismiss (stays in invites list,
    // won't re-pop for this session_id). No auto-modal if we're
    // the proposer or already in an active ceremony.
    let incomingSigningInvite: import("@stars-labs/types/session").SessionInfo | null = null;
    let dismissedSigningInvites: Set<string> = new Set();
    // A signing invite that arrived during another ceremony; shown once
    // that ceremony's session clears (see signingInviteDecision).
    let deferredSigningInvite: import("@stars-labs/types/session").SessionInfo | null = null;
    $: if (deferredSigningInvite && !appState.sessionInfo && !incomingSigningInvite) {
        if (!dismissedSigningInvites.has(signingInviteKey(deferredSigningInvite))) {
            incomingSigningInvite = deferredSigningInvite;
        }
        deferredSigningInvite = null;
    }

    // Ext-3c: proposer-side toast when a co-signer explicitly
    // declines a signing invite we sent. Surfaced as a transient
    // amber banner; auto-dismisses after 6 seconds. Kept distinct
    // from signingProgress (which tracks commit/share rounds) —
    // declines can happen before the ceremony has any FROST state.
    type PeerDeclineToast = {
        sessionId: string;
        declinerId: string;
        expiresAt: number;
    };
    let peerDeclineToasts: PeerDeclineToast[] = [];

    // A dApp signing request that failed in the background (ceremony
    // error, timeout, …). Same transient-toast pattern as declines.
    type SigningErrorToast = {
        signingId: string;
        error: string;
        expiresAt: number;
    };
    let signingErrorToasts: SigningErrorToast[] = [];

    // Ext-2d-progress: live per-peer roster during an active FROST
    // signing ceremony. Updated by the `signingProgress` event from
    // background every time a commitment or share lands on
    // offscreen. Cleared when signingCompleted fires (the success
    // banner takes over the visual slot).
    type SigningProgress = {
        signingId: string;
        state: string;
        selectedSigners: string[];
        commitmentsReceived: string[];
        sharesReceived: string[];
    };
    let signingProgress: SigningProgress | null = null;

    // Application state (consolidated from background) - the single source of truth
    let appState: AppState = { ...INITIAL_APP_STATE };

    // Keep connection to background script
    let port: chrome.runtime.Port;
    
    // UI state flags
    let acceptingSession = false; // Prevent multiple session accept clicks
    let selectedDevices: Set<string> = new Set(); // Track selected devices for session proposal
    
    // Signature request tracking
    let signatureRequests: Array<{
        signingId: string;
        message: string;
        origin: string;
        fromAddress: string;
    }> = [];

    // dApp connect requests. Loaded on open (the request usually predates
    // the popup) and kept live by the RpcHandler's runtime broadcasts.
    let connectRequests: ConnectRequestView[] = [];

    function removeConnectRequest(requestId: string) {
        connectRequests = connectRequests.filter((r) => r.requestId !== requestId);
    }

    function onConnectRequestMessage(message: any) {
        if (message?.type === "signatureRequest") {
            // Sent via runtime.sendMessage, not the popup port.
            handleBackgroundMessage(message);
        } else if (message?.type === "connectRequest" && message.request?.requestId) {
            if (!connectRequests.some((r) => r.requestId === message.request.requestId)) {
                connectRequests = [...connectRequests, message.request];
            }
        } else if (message?.type === "connectRequestResolved" && message.requestId) {
            removeConnectRequest(message.requestId);
        }
    }

    onMount(() => {
        chrome.runtime.onMessage.addListener(onConnectRequestMessage);
        chrome.runtime.sendMessage({ type: "getPendingConnectRequests" }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn("[UI] Failed to load connect requests:", chrome.runtime.lastError.message);
                return;
            }
            if (response?.success && Array.isArray(response.requests)) {
                connectRequests = response.requests;
            }
        });
        chrome.runtime.sendMessage({ type: "getPendingSignatureRequests" }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn("[UI] Failed to load signature requests:", chrome.runtime.lastError.message);
                return;
            }
            if (response?.success && Array.isArray(response.requests)) {
                for (const request of response.requests) {
                    handleBackgroundMessage({ type: "signatureRequest", ...request });
                }
            }
        });
    });
    onDestroy(() => chrome.runtime.onMessage.removeListener(onConnectRequestMessage));

    // Keystore state
    // Explicit typing so `.wallets.find(...)` returns
    // `ExtensionWalletMetadata | undefined` instead of `never`.
    // Without this, TS infers `wallets: never[]` from the empty
    // array literal and every subsequent `.find(w => w.xxx)`
    // narrows w to never, tanking type safety for the whole
    // keystore-dependent UI.
    let keystoreStatus: {
        initialized: boolean;
        locked: boolean;
        wallets: import("@stars-labs/types/keystore").ExtensionWalletMetadata[];
        activeWallet: import("@stars-labs/types/keystore").ExtensionWalletMetadata | null;
        pendingImport: boolean;
    } = {
        initialized: false,
        locked: true,
        wallets: [],
        activeWallet: null,
        pendingImport: false
    };
    // Invitations worth showing: finished DKGs linger on the signal server.
    $: shownInvites = openInvites(
        appState.invites ?? [],
        (keystoreStatus.wallets ?? []).map((w) => w.id),
    );
    
    // Password prompt state
    let showPasswordPrompt = false;
    // Explicit typing — inference would read `onSubmit: null` as
    // type `null` exclusively, then later assignments of actual
    // handler functions fail with "Type '(event) => Promise<void>'
    // is not assignable to type 'null'". Same story for strings.
    let passwordPromptConfig: {
        title: string;
        message: string;
        confirmMode: boolean;
        onSubmit: ((event: CustomEvent) => void | Promise<void>) | null;
        onCancel: (() => void) | null;
    } = {
        title: "Unlock Keystore",
        message: "Enter your password to unlock the wallet",
        confirmMode: false,
        onSubmit: null,
        onCancel: null
    };

    // Local storage for UI preferences persistence (not real-time connection state)
    const UI_STATE_KEY = "starlab_ui_preferences";

    // Save ONLY UI preferences to localStorage (not real-time connection states)
    function saveUIState() {
        const uiState = {
            showSettings: appState.showSettings,
            proposedSessionIdInput: appState.proposedSessionIdInput,
            totalParticipants: appState.totalParticipants,
            threshold: appState.threshold,
            chain: appState.chain,
            timestamp: Date.now(),
        };
        try {
            localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState));
//             console.log("[UI] Saved UI preferences to localStorage:", uiState);
        } catch (error) {
            console.warn("[UI] Failed to save UI preferences:", error);
        }
    }

    // Load ONLY UI preferences from localStorage (not real-time connection states)
    function loadUIState(): Partial<AppState> {
        try {
            const stored = localStorage.getItem(UI_STATE_KEY);
            if (stored) {
                const uiState = JSON.parse(stored);
                // Check if state is not too old (1 hour)
                if (Date.now() - uiState.timestamp < 60 * 60 * 1000) {
                    console.log(
                        "[UI] Loaded UI preferences from localStorage:",
                        uiState,
                    );
                    return {
                        showSettings: uiState.showSettings || false,
                        proposedSessionIdInput:
                            uiState.proposedSessionIdInput || "",
                        totalParticipants: uiState.totalParticipants || 3,
                        threshold: uiState.threshold || 2,
                        chain: uiState.chain || "ethereum",
                    };
                } else {
//                     console.log("[UI] UI preferences expired, using defaults");
                    localStorage.removeItem(UI_STATE_KEY);
                }
            }
        } catch (error) {
            console.warn("[UI] Failed to load UI preferences:", error);
            localStorage.removeItem(UI_STATE_KEY);
        }
        return {};
    }

    // Debug logging to console (throttled to prevent spam)
    let lastDebugLog = "";
    $: {
        const debugInfo = JSON.stringify({
            dkgState: appState.dkgState,
            chainChanged: appState.chain,
            sessionActive: !!appState.sessionInfo,
            meshReady: appState.meshStatus?.type === MeshStatusType.Ready,
        });

        // Only log when significant state changes occur
        if (debugInfo !== lastDebugLog) {
            console.log("[UI Debug] Significant state change:", {
                dkgState: appState.dkgState,
                chain: appState.chain,
                hasSession: !!appState.sessionInfo,
                meshReady: appState.meshStatus?.type === MeshStatusType.Ready,
            });
            lastDebugLog = debugInfo;
        }
    }

    // Reactive computation for WebRTC connection status
    $: webrtcConnected =
        appState.sessionInfo &&
        appState.meshStatus?.type === MeshStatusType.Ready;
    $: webrtcConnecting =
        appState.sessionInfo &&
        appState.meshStatus?.type === MeshStatusType.PartiallyReady;

    // Add reactive statement to log WebRTC connection changes (throttled)
    let lastWebRTCState = "";
    $: {
        // Only log when WebRTC connection state actually changes
        const webrtcState = JSON.stringify(appState.webrtcConnections);
        if (webrtcState !== lastWebRTCState) {
            console.log(
                "[UI] WebRTC Connections updated:",
                appState.webrtcConnections,
            );
            if (Object.keys(appState.webrtcConnections).length > 0) {
                console.log(
                    "[UI] Active WebRTC connections:",
                    Object.entries(appState.webrtcConnections).filter(
                        ([_, connected]) => connected,
                    ),
                );
            }
            lastWebRTCState = webrtcState;
        }
    }

    // Common handler for messages from the background script
    function handleBackgroundMessage(message: any) {
        console.log(
            "[UI] Background message received - Type:",
            message.type,
            "Data:",
            message,
        );

        switch (message.type) {
            case "initialState":
                console.log(
                    "[UI] Processing initialState - state restoration from background",
                );

                // Load persisted UI preferences from localStorage (ONLY UI state, not real-time)
                const persistedUIState = loadUIState();

                // Preserve current UI-specific preferences that aren't managed by background
                const currentUIState = {
                    showSettings: appState.showSettings,
                    proposedSessionIdInput: appState.proposedSessionIdInput,
                    totalParticipants: appState.totalParticipants,
                    threshold: appState.threshold,
                    ...persistedUIState, // Override with persisted preferences if available
                };
                const incomingChain: SupportedChain = isSupportedChain(message.chain)
                    ? message.chain
                    : isSupportedChain(message.blockchain)
                      ? message.blockchain
                      : isSupportedChain((currentUIState as any).chain)
                        ? (currentUIState as any).chain
                        : "ethereum";
                const incomingCurve: WalletCurve =
                    message.curve === "ed25519" || message.curve === "secp256k1"
                        ? message.curve
                        : getRequiredCurve(incomingChain);

                // Update the entire app state from background - real-time state comes from background
                appState = {
                    // Real-time state from background (never from localStorage)
                    deviceId: message.deviceId || "",
                    connecteddevices: [...(message.connecteddevices || [])],
                    wsConnected: message.wsConnected || false,
                    sessionInfo: message.sessionInfo || null,
                    invites: message.invites ? [...message.invites] : [],
                    meshStatus: message.meshStatus || {
                        type: MeshStatusType.Incomplete,
                    },
                    dkgState: message.dkgState || DkgState.Idle,
                    // Gates the post-DKG "Save this wallet" form.
                    pendingKeystoreReady: message.pendingKeystoreReady === true,
                    // Saved wallet's threshold/total (restored from its key
                    // share); shown when no ceremony session is active.
                    dkgLastResult: message.dkgLastResult ?? appState.dkgLastResult,
                    webrtcConnections: message.webrtcConnections || {},
                    blockchain: protocolChainFor(incomingChain),
                    curve: incomingCurve,
                    uiPreferences: message.uiPreferences || {
                        darkMode: false,
                        language: "en",
                        showAdvanced: false,
                    },
                    // UI preferences - preserve from current popup state or use localStorage
                    showSettings: currentUIState.showSettings,
                    chain: incomingChain,
                    proposedSessionIdInput:
                        currentUIState.proposedSessionIdInput,
                    totalParticipants: currentUIState.totalParticipants,
                    threshold: currentUIState.threshold,
                    // Other state fields. The background owns the DKG
                    // result: a popup opened after the ceremony only learns
                    // the group key / address from this snapshot.
                    ...publicWalletState(message),
                    ecdsaDkgStatus: message.ecdsaDkgStatus ?? null,
                    ecdsaPrimes: message.ecdsaPrimes,
                    dkgError: appState.dkgError || "",
                    sessionAcceptanceStatus:
                        message.sessionAcceptanceStatus ||
                        appState.sessionAcceptanceStatus ||
                        {},
                    wsError: message.wsError || appState.wsError || "",
                    isInitializing: message.isInitializing,
                    globalError: message.globalError,
                    setupComplete: message.setupComplete,
                };
                console.log(
                    "[UI] App state updated from initialState:",
                    appState,
                );
                if (!initialStateLoaded && message.lastSignature) {
                    signatureBanner = message.lastSignature;
                    void verifySignatureBanner(signatureBanner!);
                }
                initialStateLoaded = true; // Enable reactive saving after state is loaded

                // Save the current UI preferences immediately after loading to ensure persistence
                saveUIState();
                
                // Check keystore status after initial state is loaded
                checkKeystoreStatus();

                // NOTE: No need for fresh state update - all real-time state comes from background automatically
                // WebSocket updates, device lists, etc. are pushed via port messages, not pulled via getState
                break;

            case "wsStatus":
//                 console.log("[UI] Processing wsStatus:", message);
                appState.wsConnected = message.connected || false;
                if (!message.connected && message.reason) {
                    appState.wsError = guideError(
                        `Disconnected from the signal server: ${message.reason}`,
                        "connection",
                    );
                } else if (message.connected) {
                    appState.wsError = "";
                }
                // Trigger reactivity
                appState = { ...appState };
                break;

            case "wsMessage":
//                 console.log("[UI] Processing wsMessage:", message);
                if (message.message) {
                    console.log("[UI] Server message:", message.message);
                    // Device list updates are handled via "deviceList" messages
                    // No need to handle them here
                }
                break;

            case "wsError":
//                 console.log("[UI] Processing wsError:", message);
                appState.wsError = guideError(message.error, "connection");
                console.error("[UI] WebSocket error:", message.error);
                // Trigger reactivity
                appState = { ...appState };
                break;

            case "deviceList":
//                 console.log("[UI] Processing deviceList:", message);
                // Only update if we have a valid devices array
                if (Array.isArray(message.devices)) {
                    const newConnectedDevices = [...message.devices];
                    console.log("[UI] Updated connected devices:", newConnectedDevices);
                    // Update the entire appState to ensure Svelte detects the change
                    appState = {
                        ...appState,
                        connecteddevices: newConnectedDevices
                    };
                } else {
                    console.warn("[UI] Invalid device list received:", message.devices);
                }
                break;

            case "sessionUpdate":
//                 console.log("[UI] Processing sessionUpdate:", message);
                appState.sessionInfo = message.sessionInfo || null;
                appState.invites = message.invites ? [...message.invites] : [];
                console.log("[UI] Session update:", {
                    sessionInfo: appState.sessionInfo,
                    invites: appState.invites,
                });

                // Log accepted devices for debugging
                if (
                    appState.sessionInfo &&
                    appState.sessionInfo.accepted_devices
                ) {
                    console.log(
                        "[UI] Session accepted devices:",
                        appState.sessionInfo.accepted_devices,
                    );
                    // Filter out any null/undefined values that might have been added
                    appState.sessionInfo.accepted_devices =
                        appState.sessionInfo.accepted_devices.filter(
                            (peer) => peer != null && peer !== undefined,
                        );
                }
                // Trigger reactivity
                appState = { ...appState };
                break;

            case "meshStatusUpdate":
//                 console.log("[UI] Processing meshStatusUpdate:", message);
                const newMeshStatus = message.status || {
                    type: MeshStatusType.Incomplete,
                };
                console.log("[UI] Mesh status update:", newMeshStatus);
                // Update the entire appState to ensure Svelte detects the change
                appState = {
                    ...appState,
                    meshStatus: newMeshStatus
                };
                break;

            case "webrtcConnectionUpdate":
//                 console.log("[UI] Processing webrtcConnectionUpdate:", message);

                if (
                    message.deviceId &&
                    typeof message.connected === "boolean"
                ) {
                    console.log(
                        "[UI] Updating peer connection:",
                        message.deviceId,
                        "->",
                        message.connected,
                    );

                    // Create a new webrtcConnections object to ensure reactivity
                    const newWebrtcConnections = {
                        ...appState.webrtcConnections,
                        [message.deviceId]: message.connected,
                    };

                    // Update the entire appState to ensure Svelte detects the change
                    appState = {
                        ...appState,
                        webrtcConnections: newWebrtcConnections
                    };

                    console.log(
                        "[UI] Updated webrtcConnections:",
                        appState.webrtcConnections,
                    );
                } else {
                    console.warn(
                        "[UI] Invalid webrtcConnectionUpdate message:",
                        message,
                    );
                }
                break;

            case "dkgStateUpdate":
//                 console.log("[UI] Processing dkgStateUpdate:", message);
                appState.dkgState = message.state || DkgState.Idle;
                console.log("[UI] DKG state update:", appState.dkgState);
                // Trigger reactivity
                appState = { ...appState };
                break;

            case "fromOffscreen":
//                 console.log("[UI] Processing fromOffscreen wrapper:", message);
                // Handle wrapped messages from offscreen
                if (message.payload) {
                    console.log(
                        "[UI] Unwrapping and processing payload:",
                        message.payload,
                    );
                    handleBackgroundMessage(message.payload);
                }
                break;

            case "webrtcStatusUpdate":
//                 console.log("[UI] Processing webrtcStatusUpdate:", message);
                if (message.deviceId && message.status) {
                    console.log(
                        `[UI] WebRTC status for ${message.deviceId}: ${message.status}`,
                    );
                    // Update UI state based on WebRTC status if needed
                }
                break;

            case "dataChannelStatusUpdate":
                console.log(
                    "[UI] Processing dataChannelStatusUpdate:",
                    message,
                );
                if (message.deviceId && message.channelName && message.state) {
                    console.log(
                        `[UI] Data channel ${message.channelName} for ${message.deviceId}: ${message.state}`,
                    );
                }
                break;

            case "peerConnectionStatusUpdate":
                console.log(
                    "[UI] Processing peerConnectionStatusUpdate:",
                    message,
                );
                if (message.deviceId && message.connectionState) {
                    console.log(
                        `[UI] Peer connection for ${message.deviceId}: ${message.connectionState}`,
                    );
                }
                break;

            case "dkgAddressUpdate":
//                 console.log("[UI] Processing dkgAddressUpdate:", message);
                if (message.address && message.blockchain) {
                    console.log(
                        "[UI] DKG address automatically fetched:",
                        message.address,
                        "for",
                        message.blockchain,
                    );
                    appState.dkgAddress = message.address;
                    appState.dkgError = "";
                    // Trigger reactivity
                    appState = { ...appState };
                }
                break;
                
            case "accountsUpdated":
//                 console.log("[UI] Processing accountsUpdated:", message);
                // Trigger account refresh in AccountManager component
                // The AccountManager component will automatically refresh when AccountService notifies it
                if (message.blockchain && message.accounts) {
                    console.log(`[UI] Accounts updated for ${message.blockchain}:`, message.accounts);
                    // Force a re-render by updating app state
                    appState = { ...appState, accountsUpdated: Date.now() };
                }
                break;
                
            case "signatureRequest":
                if (
                    message.signingId && message.message && message.origin && message.fromAddress &&
                    !signatureRequests.some((req) => req.signingId === message.signingId)
                ) {
                    // Add new signature request to the list
                    signatureRequests = [...signatureRequests, {
                        signingId: message.signingId,
                        message: message.message,
                        origin: message.origin,
                        fromAddress: message.fromAddress
                    }];
                }
                break;
                
            case "signatureComplete":
//                 console.log("[UI] Processing signatureComplete:", message);
                if (message.signingId) {
                    // Remove the completed request from the list
                    signatureRequests = signatureRequests.filter(req => req.signingId !== message.signingId);
                }
                break;

            case "signingSessionCreated":
                appState = { ...appState, sessionInfo: message.sessionInfo };
                signatureBanner = null;
                signatureVerification = "";
                signingProgress = {
                    signingId: `sign_${message.sessionInfo.session_id}`,
                    state: "Waiting for co-signers",
                    selectedSigners: message.sessionInfo.participants ?? [],
                    commitmentsReceived: [],
                    sharesReceived: [],
                };
                break;

            case "signingCompleted":
                // Ext-2e: FROST threshold signing ceremony finalized.
                // Different from `signatureComplete` (legacy dApp-bridge
                // single-party path); this one comes from the
                // announce-session flow and carries the aggregated
                // signature. Stash it for the banner — user can
                // copy/dismiss. Replaces any prior banner (only one
                // signing ceremony runs at a time).
                console.log("[UI] Signing ceremony completed:", message);
                signatureBanner = {
                    signingId: message.signingId,
                    signature: message.signature,
                    messageHex: message.messageHex,
                    blockchain: message.blockchain,
                    sessionId: message.sessionId,
                };
                signatureCopied = false;
                void verifySignatureBanner(signatureBanner);
                // Success banner replaces the in-progress roster.
                signingProgress = null;
                break;

            case "signingProgress":
                // Ext-2d-progress: roster snapshot. Fires on every
                // commitment/share milestone. Overwrites any prior
                // state for the same signing_id; stale snapshots
                // from abandoned ceremonies get reset to null by
                // signingCompleted or when the user starts a new
                // session.
                signingProgress = {
                    signingId: message.signingId,
                    state: message.state,
                    selectedSigners: message.selectedSigners ?? [],
                    commitmentsReceived: message.commitmentsReceived ?? [],
                    sharesReceived: message.sharesReceived ?? [],
                };
                break;

            case "signingPeerDeclined":
                // Ext-3c: proposer-side handler. A co-signer relayed
                // SigningDecline for our signing session. Show a
                // 6-second amber toast + auto-dismiss. Stack multiple
                // if many declines arrive (rare but harmless).
                {
                    const toast: PeerDeclineToast = {
                        sessionId: message.sessionId,
                        declinerId: message.declinerId,
                        expiresAt: Date.now() + 6000,
                    };
                    peerDeclineToasts = [...peerDeclineToasts, toast];
                    setTimeout(() => {
                        peerDeclineToasts = peerDeclineToasts.filter(
                            (t) => t.expiresAt !== toast.expiresAt,
                        );
                    }, 6000);
                }
                break;

            case "sessionAvailable":
                // Ext-3b: auto-modal for incoming signing invites.
                // Fires once per new session_available broadcast
                // from webSocketManager. Gate mirrors SigningNotifier:
                //   - session_type === "signing"
                //   - we're in participants
                //   - we're NOT the proposer
                //   - we haven't dismissed this session_id already
                //   - no other modal already open (don't stack)
                //   - not already in an active ceremony (busy signal)
                {
                    const s = message.session as
                        | import("@stars-labs/types/session").SessionInfo
                        | undefined;
                    if (!s) break;
                    const decision = signingInviteDecision(s, {
                        deviceId: appState.deviceId,
                        dismissed: dismissedSigningInvites,
                        modalOpen: incomingSigningInvite !== null,
                        busy: !!appState.sessionInfo,
                    });
                    if (decision === "show") incomingSigningInvite = s;
                    else if (decision === "defer") deferredSigningInvite = s;
                }
                break;
                
            case "signatureError":
                // A failed / timed-out threshold signing: leave "Signing in
                // progress" (the toast below says why).
                signingProgress = null;
                if (message.signingId) {
                    // Remove the failed request from the list
                    signatureRequests = signatureRequests.filter(req => req.signingId !== message.signingId);
                    const toast: SigningErrorToast = {
                        signingId: message.signingId,
                        error: String(message.error ?? "Unknown error"),
                        expiresAt: Date.now() + 8000,
                    };
                    signingErrorToasts = [...signingErrorToasts, toast];
                    setTimeout(() => {
                        signingErrorToasts = signingErrorToasts.filter(
                            (t) => t.expiresAt !== toast.expiresAt,
                        );
                    }, 8000);
                }
                break;

            default:
                console.log(
                    "[UI] Unhandled message type:",
                    message.type,
                    message,
                );
        }
    }

    // Removed ensurePrivateKey() and ensureOffscreenDocument() - this is now an MPC-only wallet
    // Offscreen document management is handled entirely by the background script

    // Ext-2c: build a preview of what we're about to broadcast. We
    // deliberately duplicate the EIP-191 hash computation client-side
    // so the user sees exactly what will land on-chain — the
    // background handler still recomputes authoritatively, so a
    // tampered popup can't lie about the preview and sign something
    // different. Matches TUI update.rs SignSubmit → Modal::Confirm.
    function buildSignPreview() {
        signError = "";
        if (!signMessage.trim()) {
            signError = "Message required";
            return;
        }
        if (!signWalletId) {
            signError = "Pick a wallet";
            return;
        }
        const wallet = keystoreStatus.wallets?.find(
            (w: any) => w.id === signWalletId,
        );
        if (!wallet) {
            signError = "Selected wallet not found";
            return;
        }
        const eip191 =
            isEvmChain(wallet.blockchain)
                ? (hashMessage(signMessage) as `0x${string}`)
                : null;
        signPreview = {
            walletName: wallet.name ?? wallet.id,
            walletBlockchain: wallet.blockchain,
            walletAddress: wallet.address,
            message: signMessage,
            eip191Hash: eip191,
        };
    }

    async function confirmSignPreview() {
        if (!signPreview || signing_) return;
        // Option::take equivalent — null out preview before dispatch
        // so a double-click can't double-announce. Matches TUI's
        // Option::take in update.rs ConfirmSigningRequest (58c9f85).
        const preview = signPreview;
        signPreview = null;
        signing_ = true;
        try {
            const response = await chrome.runtime.sendMessage({
                type: MESSAGE_TYPES.CREATE_SIGNING_SESSION,
                walletId: signWalletId,
                message: preview.message,
            });
            if (response?.success) {
                console.log(
                    "[UI] Signing session:",
                    response.sessionId,
                );
                showSignForm = false;
                signMessage = "";
            } else {
                signError = guideError(response?.error ?? "Sign failed", "signing");
            }
        } catch (e) {
            signError = guideError((e as Error).message ?? String(e), "signing");
        } finally {
            signing_ = false;
        }
    }

    function cancelSignPreview() {
        signPreview = null;
        // Note: signMessage intentionally preserved so user can edit
        // and re-preview without retyping. TUI parity with Stage 3
        // CancelSigningRequest behavior.
    }

    async function verifySignatureBanner(banner: SignatureBanner) {
        signatureVerification = "";
        if (banner.blockchain !== "ethereum") return;
        const expected = keystoreStatus.activeWallet?.address || appState.dkgAddress || "";
        signatureVerification = "Verifying signature…";
        const result = await verifyEthereumSignature(banner.messageHex, banner.signature, expected);
        if (signatureBanner !== banner) return;
        signatureVerification = result.verified
            ? "Verified against the wallet's Ethereum address"
            : "Signature could not be verified against the wallet's Ethereum address";
    }

    async function copySignatureToClipboard() {
        if (!signatureBanner) return;
        try {
            await navigator.clipboard.writeText(signatureBanner.signature);
            signatureCopied = true;
            setTimeout(() => {
                signatureCopied = false;
            }, 2000);
        } catch (e) {
            console.warn("[UI] Clipboard copy failed:", e);
        }
    }

    function dismissSignatureBanner() {
        signatureBanner = null;
        signatureCopied = false;
    }

    // Ext-3b: convert the signing session's hex-encoded message to
    // a human-readable preview. For ethereum, signing_message_hex
    // is the EIP-191 hash (opaque 32 bytes) — just show truncated
    // hex. For solana (ed25519), it's raw UTF-8 bytes we can decode.
    function signingMessagePreview(
        hex: string | undefined,
        blockchain: string | undefined,
    ): string {
        if (!hex) return "(empty)";
        const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
        if (blockchain === "solana") {
            try {
                const bytes = new Uint8Array(
                    clean.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [],
                );
                const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
                    bytes,
                );
                return decoded.length > 80
                    ? `${decoded.slice(0, 79)}…`
                    : decoded;
            } catch {
                /* fall through */
            }
        }
        const prefixed = `0x${clean}`;
        return prefixed.length > 66
            ? `${prefixed.slice(0, 34)}…${prefixed.slice(-12)}`
            : prefixed;
    }

    async function reviewSigningInvite() {
        if (!incomingSigningInvite) return;
        const sessionId = incomingSigningInvite.session_id;
        // Reuse the existing Join path — joinDkgSession is
        // generic over session_type; the downstream flow
        // (sessionReadyForSigning trigger in webSocketManager)
        // handles the signing ceremony from there.
        const inv = incomingSigningInvite;
        incomingSigningInvite = null;
        try {
            const response = await chrome.runtime.sendMessage({
                type: MESSAGE_TYPES.JOIN_DKG_SESSION,
                session_id: sessionId,
            });
            if (!response?.success) {
                console.warn(
                    `[UI] Join signing failed: ${response?.error ?? "unknown"}`,
                );
                // Re-open modal so user can retry or dismiss.
                incomingSigningInvite = inv;
            } else {
                console.log("[UI] Joined signing session", sessionId);
                // The server re-broadcasts the session after our join;
                // don't pop the modal again for it.
                dismissedSigningInvites = new Set([
                    ...dismissedSigningInvites,
                    signingInviteKey(inv),
                ]);
            }
        } catch (e) {
            console.error("[UI] Join signing exception:", e);
            incomingSigningInvite = inv;
        }
    }

    function laterSigningInvite() {
        if (!incomingSigningInvite) return;
        // Remember we dismissed this specific session_id so the
        // modal doesn't re-pop on subsequent session_available
        // broadcasts for the same session (status updates).
        dismissedSigningInvites = new Set([
            ...dismissedSigningInvites,
            signingInviteKey(incomingSigningInvite),
        ]);
        incomingSigningInvite = null;
    }

    async function declineSigningInvite() {
        if (!incomingSigningInvite) return;
        const sessionId = incomingSigningInvite.session_id;
        // Add to dismissed immediately so any reentrant
        // sessionAvailable broadcast doesn't re-pop the modal
        // before the relay completes.
        dismissedSigningInvites = new Set([
            ...dismissedSigningInvites,
            signingInviteKey(incomingSigningInvite),
        ]);
        incomingSigningInvite = null;
        try {
            const response = await chrome.runtime.sendMessage({
                type: MESSAGE_TYPES.DECLINE_SIGNING_SESSION,
                session_id: sessionId,
            });
            if (!response?.success) {
                console.warn(
                    `[UI] Decline relay failed: ${response?.error ?? "unknown"}`,
                );
            } else {
                console.log("[UI] Declined signing session", sessionId);
            }
        } catch (e) {
            console.error("[UI] Decline exception:", e);
        }
    }

    onMount(async () => {
        console.log("[UI] Component mounting");
        await refreshSignalRoomState();

        const onStorageChanged = (
            changes: Record<string, chrome.storage.StorageChange>,
            areaName: string,
        ) => {
            if (areaName !== "local" || !(ROOM_STORAGE_KEY in changes)) return;
            const nextRoom = changes[ROOM_STORAGE_KEY].newValue;
            signalRoom = typeof nextRoom === "string" ? nextRoom : "";
            hasSignalRoom = signalRoom.length > 0;
        };

        chrome.storage.onChanged.addListener(onStorageChanged);
        removeSignalRoomStorageListener = () => {
            chrome.storage.onChanged.removeListener(onStorageChanged);
        };

        // Detect mirrored hardware/simulation accounts so the account list
        // can render for non-MPC users (the AccountManager gate below also
        // opens on FROST DkgState.Complete).
        try {
            const accountService = AccountService.getInstance();
            await accountService.ensureInitialized();
            refreshExternalAccountFlags(accountService);
            accountService.onAccountChange(() => {
                refreshExternalAccountFlags(accountService);
            });
        } catch (e) {
            console.warn("[UI] external account detection failed:", e);
        }

        // Set up state tracking before connecting port
        let stateReceived = false;
        let fallbackTimeoutId: ReturnType<typeof setTimeout>;

        // Initialize as false to prevent reactive statements from running
        initialStateLoaded = false;

        port = chrome.runtime.connect({ name: "popup" });
        console.log(
            "[UI] Port connected to background, waiting for initial state...",
        );

        port.onMessage.addListener((message) => {
            console.log("[UI] Port message received:", message.type, message);
            // Track when initial state is received
            if (message.type === "initialState" && !stateReceived) {
                stateReceived = true;
                console.log(
                    "[UI] Initial state received successfully from StateManager",
                );
                // Clear fallback timeout since we received state
                if (fallbackTimeoutId) {
                    clearTimeout(fallbackTimeoutId);
                }
            }
            handleBackgroundMessage(message);
        });

        port.onDisconnect.addListener(() => {
            console.error("[UI] Port disconnected from background");
            appState.wsConnected = false;
            // Clear fallback timeout if port disconnects
            if (fallbackTimeoutId) {
                clearTimeout(fallbackTimeoutId);
            }
        });

        console.log(
            "[UI] Port connected, StateManager should automatically send state...",
        );

        // Add fallback in case automatic state is delayed (StateManager still loading, etc.)
        fallbackTimeoutId = setTimeout(() => {
            if (!stateReceived) {
                console.warn(
                    "[UI] Automatic state not received within 2 seconds, requesting manually as fallback",
                );
                chrome.runtime.sendMessage({ type: "getState" }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error(
                            "[UI] Fallback getState error:",
                            chrome.runtime.lastError.message,
                        );
                        return;
                    }
                    if (response && !stateReceived) {
                        console.log(
                            "[UI] Fallback state response received:",
                            response,
                        );
                        handleBackgroundMessage({
                            type: "initialState",
                            ...response,
                        });
                        stateReceived = true;
                    }
                });
            } else {
                console.log(
                    "[UI] State was received automatically, no fallback needed",
                );
            }
        }, 2000); // Increased to 2 seconds to account for async state loading

        // Removed ensurePrivateKey() call - this is now an MPC-only wallet
        // Removed ensureOffscreenDocument() call - offscreen management is handled by background script
    });

    onDestroy(() => {
        console.log("[UI] Component destroying, cleaning up port connection");
        removeSignalRoomStorageListener?.();
        if (port) {
            port.disconnect();
        }
    });

    // Removed reactive statement for ensurePrivateKey() - this is now an MPC-only wallet

    // Removed single-party reactive statements - this is now an MPC-only wallet

    // REMOVED: All reactive business logic moved to background script
    // The popup should ONLY contain pure UI reactive statements
    // All blockchain selection, state management, etc. happens in background
    // DKG address fetching is now handled automatically by StateManager

    // Reactive statements to save UI preferences to localStorage (UI-only)
    // Only save after initial state has been loaded to prevent premature saves
    let initialStateLoaded = false;
    let lastSavedState = "";

    // Throttled save function to prevent excessive localStorage writes (UI preferences only)
    function throttledSaveUIState() {
        const currentStateStr = JSON.stringify({
            showSettings: appState.showSettings,
            proposedSessionIdInput: appState.proposedSessionIdInput,
            totalParticipants: appState.totalParticipants,
            threshold: appState.threshold,
            chain: appState.chain,
        });

        // Only save if UI preferences actually changed
        if (currentStateStr !== lastSavedState) {
            saveUIState();
            lastSavedState = currentStateStr;
        }
    }

    // Save showSettings changes
    $: if (initialStateLoaded && typeof appState.showSettings !== "undefined") {
        throttledSaveUIState();
    }

    // Save proposedSessionIdInput changes
    $: if (
        initialStateLoaded &&
        typeof appState.proposedSessionIdInput !== "undefined"
    ) {
        throttledSaveUIState();
    }

    // Save totalParticipants changes
    $: if (
        initialStateLoaded &&
        typeof appState.totalParticipants !== "undefined"
    ) {
        throttledSaveUIState();
    }

    // Save threshold changes
    $: if (initialStateLoaded && typeof appState.threshold !== "undefined") {
        throttledSaveUIState();
    }

    // Save chain changes (in addition to the blockchain message sending)
    $: if (initialStateLoaded && typeof appState.chain !== "undefined") {
        throttledSaveUIState();
    }

    $: if (
        initialStateLoaded &&
        isEvmChain(appState.chain) &&
        networkChoicesFor !== appState.chain
    ) {
        loadNetworkChoices(appState.chain);
    }

    // Removed fetchAddress() and fetchDkgAddress() - this is now an MPC-only wallet
    // DKG address fetching is now handled automatically by StateManager when DKG completes

    // Removed signDemoMessage() - this is now an MPC-only wallet

    function requestdeviceList() {
        console.log("[UI] Requesting peer list");
        chrome.runtime.sendMessage({ type: "listdevices" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error(
                    "[UI] Error requesting peer list:",
                    chrome.runtime.lastError.message,
                );
                return;
            }
            console.log("[UI] listdevices response:", response);
        });
    }

    function proposeSession() {
        // Convert Set to Array for selected devices
        const selectedDevicesList = Array.from(selectedDevices);
        
        // Validate selection
        if (selectedDevicesList.length !== appState.totalParticipants - 1) {
            console.error(
                `Please select exactly ${appState.totalParticipants - 1} devices for a ${appState.totalParticipants}-participant session. Currently selected: ${selectedDevicesList.length}`,
            );
            alert(`Please select exactly ${appState.totalParticipants - 1} devices for a ${appState.totalParticipants}-participant session`);
            return;
        }

        if (appState.threshold > appState.totalParticipants) {
            console.error(
                "Threshold cannot be greater than total participants",
            );
            return;
        }

        if (appState.threshold < 1) {
            console.error("Threshold must be at least 1");
            return;
        }

        // Include self and selected devices
        const allParticipants = [appState.deviceId, ...selectedDevicesList];

        const sessionId =
            (appState.proposedSessionIdInput ?? "").trim() ||
            `wallet_${appState.threshold}of${appState.totalParticipants}_${Date.now()}`;

        chrome.runtime.sendMessage({
            type: "proposeSession",
            session_id: sessionId,
            total: appState.totalParticipants,
            threshold: appState.threshold,
            participants: allParticipants,
            blockchain: protocolChainFor(appState.chain), // legacy protocol blockchain
        });
        console.log(
            "[UI] Proposing session:",
            sessionId,
            `(${appState.threshold}-of-${appState.totalParticipants})`,
            "with participants:",
            allParticipants,
        );
        
        // Clear selection after proposing
        selectedDevices.clear();
        selectedDevices = selectedDevices; // Trigger reactivity
    }

    function acceptInvite(sessionId: string) {
        // Prevent multiple clicks
        if (acceptingSession) {
            console.warn("[UI] Already processing a session acceptance");
            return;
        }
        
        // Check if invite still exists before accepting
        const invite = appState.invites.find(inv => inv.session_id === sessionId);
        if (!invite) {
            console.warn("[UI] Session invite not found:", sessionId);
            return;
        }
        
        // Check if we already have an active session
        if (appState.sessionInfo && appState.sessionInfo.session_id === sessionId) {
            console.warn("[UI] Session already accepted:", sessionId);
            return;
        }
        
        // Set flag to prevent multiple clicks
        acceptingSession = true;
        
        const inviteChain = chainFromSession(invite);
        appState.chain = inviteChain;
        appState.blockchain = getProtocolBlockchainForChain(inviteChain);
        appState.curve = getRequiredCurve(inviteChain);
        appState = { ...appState };

        // Same path as the invitations list's "Join": registers us with the
        // signal server (participant_update), which is how CLI/TUI and
        // extension proposers learn who joined.
        chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.JOIN_DKG_SESSION,
            session_id: sessionId,
        }, (response) => {
            acceptingSession = false; // Reset flag
            console.log("[UI] Join session response:", response);
            if (!response || !response.success) {
                console.error("[UI] Failed to join session:", response?.error || "Unknown error");
                // Restore the invite if joining failed
                appState.invites = [...appState.invites, invite];
            }
        });
        console.log(
            "[UI] Accepting session invite:",
            sessionId,
            "with blockchain:",
            getProtocolBlockchainForChain(inviteChain),
        );
        
        // Optimistically update UI to show processing state
        appState.invites = appState.invites.filter(inv => inv.session_id !== sessionId);
    }

    function rejectInvite(sessionId: string) {
        // Remove the invite from local state
        appState.invites = appState.invites.filter(inv => inv.session_id !== sessionId);
        console.log("[UI] Rejected session invite:", sessionId);
        
        // Optionally send rejection to background (for future implementation)
        chrome.runtime.sendMessage({
            type: "rejectSession",
            session_id: sessionId
        });
    }

    // Add function to send direct message for testing
    function sendDirectMessage(todeviceId: string) {
        const testMessage = `Hello from ${appState.deviceId} at ${new Date().toLocaleTimeString()}`;
        chrome.runtime.sendMessage(
            {
                type: "sendDirectMessage",
                todeviceId: todeviceId,
                message: testMessage,
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error(
                        "[UI] Error sending direct message:",
                        chrome.runtime.lastError.message,
                    );
                } else {
                    console.log("[UI] Direct message response:", response);
                    if (!response.success) {
                        console.error(
                            `Failed to send message: ${response.error}`,
                        );
                    }
                }
            },
        );
        console.log(
            "[UI] Sending direct message to:",
            todeviceId,
            "Message:",
            testMessage,
        );
    }

    // Helper function to get WebRTC status for a peer
    function getWebRTCStatus(
        deviceId: string,
    ): "connected" | "connecting" | "disconnected" {
        console.log(
            "[UI] Getting WebRTC status for peer:",
            deviceId,
            "from webrtcConnections:",
            appState.webrtcConnections,
        );

        // Check direct connection status first
        if (appState.webrtcConnections[deviceId] === true) {
            return "connected";
        } else if (
            appState.sessionInfo &&
            appState.sessionInfo.participants.includes(deviceId) &&
            appState.meshStatus?.type === MeshStatusType.PartiallyReady
        ) {
            return "connecting";
        } else {
            return "disconnected";
        }
    }

    // Helper function to get session acceptance status
    function getSessionAcceptanceStatus(
        sessionId: string,
        deviceId: string,
    ): boolean | undefined {
        const statusMap = appState.sessionAcceptanceStatus ?? {};
        if (!statusMap[sessionId]) {
            return undefined;
        }
        return statusMap[sessionId][deviceId];
    }

    // Handle signature request completion
    function handleSignatureRequestComplete(event: CustomEvent) {
        const signingId = event.detail;
        // Remove from list (already handled by background message)
        signatureRequests = signatureRequests.filter(req => req.signingId !== signingId);
    }
    
    // Test MPC signing function
    function testMPCSigning() {
        console.log("[UI] Testing MPC signing");
        
        // Generate a test signing ID
        const signingId = `test_signing_${Date.now()}`;
        
        // Use hex of "hello" (68656c6c6f) to match the TUI node's signing smoke-test fixture.
        const testTransactionData = "68656c6c6f";
        
        // Use the threshold from the current session
        const requiredSigners = appState.sessionInfo?.threshold || 2;
        
        chrome.runtime.sendMessage({
            type: "requestSigning",
            signingId: signingId,
            transactionData: testTransactionData,
            requiredSigners: requiredSigners
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("[UI] Error requesting signing:", chrome.runtime.lastError.message);
                return;
            }
            console.log("[UI] Signing request response:", response);
            if (!response.success) {
                console.error(`Failed to initiate signing: ${response.error}`);
            }
        });
        
        console.log("[UI] Sent signing request:", {
            signingId,
            transactionData: testTransactionData + ' (hex of "hello")',
            requiredSigners
        });
    }
    
    // Keystore management functions
    async function checkKeystoreStatus() {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_KEYSTORE_STATUS }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("[UI] Error getting keystore status:", chrome.runtime.lastError.message);
                return;
            }
            if (response && response.success) {
                keystoreStatus = response.status;
                if (keystoreStatus.locked) {
                    showSignForm = false;
                    signPreview = null;
                }
                console.log("[UI] Keystore status:", keystoreStatus);
                
                // Do NOT auto-pop the Unlock modal on popup open — it was
                // forcing a password prompt every time the popup opened with a
                // locked wallet, blocking the UI (incl. Settings). The user
                // unlocks on demand via the header unlock (🔓) button, or when
                // an action that needs the key prompts for it.

                // Check for pending imports
                checkPendingImports();
            }
        });
    }
    
    onMount(() => observeKeystoreSession(checkKeystoreStatus));

    function showUnlockPrompt() {
        passwordPromptConfig = {
            title: "Unlock Wallet",
            message: "Enter your password to unlock the wallet",
            confirmMode: false,
            onSubmit: handleUnlockPassword,
            onCancel: () => { showPasswordPrompt = false; }
        };
        passwordPromptError = "";
        showPasswordPrompt = true;
    }
    
    function showCreateKeystorePrompt() {
        passwordPromptConfig = {
            title: "Create Wallet",
            message: "Create a password to secure your wallet",
            confirmMode: true,
            onSubmit: handleCreateKeystore,
            onCancel: () => { showPasswordPrompt = false; }
        };
        passwordPromptError = "";
        showPasswordPrompt = true;
    }
    
    let passwordPromptError = "";
    async function handleUnlockPassword(event: CustomEvent) {
        const password = event.detail.password;
        passwordPromptError = "";
        
        chrome.runtime.sendMessage({ 
            type: MESSAGE_TYPES.UNLOCK_KEYSTORE,
            password,
            rememberDuration: 15 * 60 * 1000 // 15 minutes
        }, (response) => {
            if (chrome.runtime.lastError) {
                passwordPromptError = "Could not unlock this device. Try again.";
                return;
            }
            if (response && response.success) {
                showPasswordPrompt = false;
                keystoreStatus.locked = false;
                keystoreStatus.wallets = response.wallets;
                keystoreStatus.activeWallet = response.activeWallet;
                console.log("[UI] Keystore unlocked successfully");
                
                // Check for pending imports after unlock
                checkPendingImports();
            } else {
                passwordPromptError = response?.error ?? "Incorrect password. Try again.";
                // Keep the modal open so the password can be corrected.
            }
        });
    }
    
    async function handleCreateKeystore(event: CustomEvent) {
        const password = event.detail.password;
        passwordPromptError = "";
        
        chrome.runtime.sendMessage({ 
            type: MESSAGE_TYPES.CREATE_KEYSTORE,
            password
        }, (response) => {
            if (chrome.runtime.lastError) {
                passwordPromptError = "Could not create this wallet. Try again.";
                return;
            }
            if (response && response.success) {
                showPasswordPrompt = false;
                keystoreStatus.initialized = true;
                keystoreStatus.locked = false;
                console.log("[UI] Keystore created successfully");
                checkKeystoreStatus();
            } else {
                passwordPromptError = response?.error ?? "Could not create this wallet. Try again.";
            }
        });
    }
    
    async function checkPendingImports() {
        const result = await chrome.storage.local.get(['mpc_pending_import']);
        if (result.mpc_pending_import && !keystoreStatus.locked) {
            // Prompt for migration
            if (confirm("You have imported keystores waiting to be migrated. Would you like to migrate them now?")) {
                migrateKeystores();
            }
        }
    }
    
    async function migrateKeystores() {
        chrome.runtime.sendMessage({ 
            type: MESSAGE_TYPES.MIGRATE_KEYSTORES,
            password: "" // Will be prompted in background if needed
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("[UI] Error migrating keystores:", chrome.runtime.lastError.message);
                return;
            }
            if (response && response.success) {
                console.log(`[UI] Migrated ${response.migratedCount} keystores`);
                keystoreStatus.wallets = response.wallets;
                chrome.storage.local.remove(['mpc_pending_import']);
            } else {
                console.error("[UI] Failed to migrate keystores:", response?.error);
            }
        });
    }
    
    function handleWalletSelect(event: CustomEvent) {
        const wallet = event.detail;
        chrome.runtime.sendMessage({ 
            type: MESSAGE_TYPES.SWITCH_WALLET,
            walletId: wallet.id
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("[UI] Error switching wallet:", chrome.runtime.lastError.message);
                return;
            }
            if (response && response.success) {
                keystoreStatus.activeWallet = wallet;
                refreshWalletData(); // remount balance/activity for the new account (#16)
                console.log("[UI] Switched to wallet:", wallet.id);
            } else {
                console.error("[UI] Failed to switch wallet:", response?.error);
            }
        });
    }
    
    function lockKeystore() {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.LOCK_KEYSTORE }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("[UI] Error locking keystore:", chrome.runtime.lastError.message);
                return;
            }
            if (response && response.success) {
                keystoreStatus.locked = true;
                console.log("[UI] Keystore locked");
            }
        });
    }
</script>

<main class="flex min-h-[600px] flex-col">
    <!-- Header -->
    <header
        class="sticky top-0 z-30 flex items-center gap-1.5 border-b border-line bg-surface px-4 py-3"
    >
        <div
            class="flex h-8 w-8 items-center justify-center rounded-xl text-sm font-black text-white"
            style="background:var(--grad-brand)"
            aria-hidden="true"
        >
            S
        </div>
        <h1 class="flex-1 text-base font-bold tracking-tight">MPC Wallet</h1>

        <button
            class="icon-btn"
            on:click={cycleTheme}
            title={`Theme: ${themeModeValue}`}
            aria-label="Toggle theme"
        >
            <Icon name={themeIcon[themeModeValue]} size={18} />
        </button>

        {#if keystoreStatus.initialized && !keystoreStatus.locked}
            <button
                class="icon-btn"
                on:click={lockKeystore}
                title="Lock wallet"
                aria-label="Lock wallet"
            >
                <Icon name="lock" size={18} />
            </button>
        {:else if keystoreStatus.initialized && keystoreStatus.locked}
            <!-- On-demand unlock — we no longer auto-pop the password modal on
                 open, so this is how you unlock when you actually want to. -->
            <button
                class="icon-btn"
                on:click={showUnlockPrompt}
                title="Unlock wallet"
                aria-label="Unlock wallet"
            >
                <Icon name="lock-open" size={18} />
            </button>
        {/if}

        <button
            class="icon-btn"
            on:click={() => {
                appState.showSettings = !appState.showSettings;
                appState = { ...appState };
            }}
            aria-label="Settings"
            title="Settings"
        >
            <Icon name="settings" size={18} />
        </button>
    </header>

    <div class="flex-1 space-y-4 px-4 py-4">
    {#if appState.showSettings}
        <Settings
            currentAddress={displayAddress}
            on:backToWallet={({ detail }) => {
                if (isSupportedChain(detail.chain)) {
                    appState.chain = detail.chain;
                    appState.blockchain = getProtocolBlockchainForChain(detail.chain);
                }
                if (
                    detail.curve === "secp256k1" ||
                    detail.curve === "ed25519"
                ) {
                    appState.curve = detail.curve;
                }
                appState.showSettings = false;
                appState = { ...appState };
            }}
        />
    {:else if showCreateWallet}
        <!-- Ext-1b: DKG wallet creation form. Covers the popup while
             the user configures threshold/total/curve. On success we
             flip back to the main view; the session_available
             broadcast will populate appState.sessionInfo and the
             existing wallet-status banner will reflect the new state. -->
        {#if appState.ecdsaPrimes && appState.ecdsaPrimes.state !== "ready"}
            <p class="mb-2 text-xs text-faint" data-testid="ecdsa-primes-status">
                {ecdsaPrimesLabel(appState.ecdsaPrimes)} — runs in the background; an Ethereum
                wallet waits for it.
            </p>
        {/if}
        <CreateWalletForm
            deviceId={appState.deviceId}
            wsConnected={appState.wsConnected}
            room={signalRoom}
            on:created={({ detail }) => {
                console.log(
                    "[UI] DKG wallet creation announced:",
                    detail.sessionId,
                );
                createdDkgSessionId = detail.sessionId;
                if (isSupportedChain(detail.chain)) {
                    appState.chain = detail.chain;
                    appState.blockchain = getProtocolBlockchainForChain(detail.chain);
                    appState.curve = getRequiredCurve(detail.chain);
                    appState = { ...appState };
                }
                showCreateWallet = false;
            }}
            on:cancel={() => {
                showCreateWallet = false;
            }}
        />
    {:else if !keystoreStatus.initialized}
        <!-- Keystore not initialized: first-run welcome -->
        <div class="card card-pad mt-6 text-center">
            <div
                class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-white"
                style="background:var(--grad-brand)"
            >
                <Icon name="shield" size={26} />
            </div>
            <h2 class="text-lg font-bold">Welcome to MPC Wallet</h2>
            <p class="mx-auto mt-1.5 max-w-[16rem] text-sm text-muted">
                Set a password to create your wallet. Your keys are split
                across devices — no single device can sign on its own.
            </p>
            <Button class="mt-5" block on:click={showCreateKeystorePrompt}>
                <Icon name="plus" size={16} /> Get started
            </Button>
        </div>
    {:else}
        <!-- ===================== Main wallet view ===================== -->

        <!-- dApp connect requests: nothing is shared with a site until approved -->
        {#if connectRequests.length > 0}
            <div class="space-y-2">
                {#each connectRequests as request (request.requestId)}
                    <ConnectRequest
                        {request}
                        on:complete={(e) => removeConnectRequest(e.detail)}
                    />
                {/each}
            </div>
        {/if}

        {#if keystoreStatus.wallets.length > 0}
            <WalletSelector
                wallets={keystoreStatus.wallets}
                activeWallet={keystoreStatus.activeWallet}
                on:select={handleWalletSelect}
                on:add={() => console.log("[UI] Add wallet clicked")}
                on:manage={() => console.log("[UI] Manage wallets clicked")}
            />
        {/if}

        <div class="flex items-center justify-between gap-2">
            <span class="section-title">Overview</span>
            <div class="flex items-center gap-2">
                {#if isEvmChain(appState.chain) && evmNetworks.length > 1}
                    <!-- Header network switcher (#16) -->
                    <select
                        class="rounded-lg border border-line bg-surface px-1.5 py-0.5 text-xs"
                        value={currentEvmNetworkId}
                        on:change={switchEvmNetwork}
                        title="EVM network"
                    >
                        {#each evmNetworks as n (n.id)}
                            <option value={n.id}>{n.name}</option>
                        {/each}
                    </select>
                {/if}
                <span class="badge {signalStatusBadge}" title={signalStatusTitle}>
                    <span class="h-1.5 w-1.5 rounded-full bg-current"></span>
                    {signalStatusLabel}
                </span>
            </div>
        </div>

        <!-- Hero: address card (shown once a wallet's keys exist). Keyed on
             the group key: the AccountPicker derives every account address
             from it, while the post-DKG `dkgAddress` fetch can lose a race
             with the offscreen document and leave the whole card hidden. -->
        {#if appState.dkgState === DkgState.Complete && appState.dkgGroupPublicKey}
            <div class="hero">
                <div class="relative flex items-center justify-between">
                    <span class="flex items-center gap-2">
                        <span
                            class="text-xs font-semibold uppercase tracking-wide text-muted"
                        >
                            <ChainIcon chain={String(appState.chain)} size={22} /> {chainLabel(appState.chain)}
                        </span>
                        <AccountPicker
                            groupPublicKey={appState.dkgGroupPublicKey || ""}
                            ecdsaGroupPublicKey={appState.ecdsaGroupPublicKey || ""}
                            curve={appState.curve ??
                                getRequiredCurve(isSupportedChain(appState.chain) ? appState.chain : "ethereum")}
                            chain={isSupportedChain(appState.chain) ? appState.chain : "ethereum"}
                            selected={selectedAccount}
                            on:select={onAccountSelect}
                        />
                    </span>
                    {#if appState.sessionInfo}
                        <span
                            class="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold"
                        >
                            {appState.sessionInfo.threshold}-of-{appState
                                .sessionInfo.total}
                        </span>
                    {:else if appState.dkgLastResult}
                        <span
                            class="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold"
                        >
                            {appState.dkgLastResult.threshold}-of-{appState
                                .dkgLastResult.total}
                        </span>
                    {/if}
                </div>
                <!-- Portfolio fiat total (native + tokens, USD). null = loading/unavailable. -->
                {#if heroFiat !== null}
                    <div class="relative mt-2 text-2xl font-bold tracking-tight">
                        ${heroFiat.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                {/if}
                <button
                    class="relative mt-3 flex items-center gap-2"
                    on:click={() => copyAddress(displayAddress)}
                    title="Copy address"
                >
                    <span class="mono text-lg font-semibold tracking-tight">
                        {shortAddr(displayAddress)}
                    </span>
                    <Icon name={addrCopied ? "check" : "copy"} size={15} />
                </button>
                <div class="relative mt-3 flex gap-2">
                    <button
                        class="rounded-lg bg-primary-soft px-2.5 py-1.5 text-xs font-semibold text-primary backdrop-blur transition hover:bg-surface-3"
                        on:click={() => copyAddress(displayAddress)}
                    >
                        {addrCopied ? "Copied" : "Copy address"}
                    </button>
                </div>
            </div>
        {/if}

        <!-- First-run onboarding (#26): guided create-or-join wizard, shown
             until this profile has a wallet (or the user dismisses it). -->
        {#if showAccountSetup || ((keystoreStatus.wallets?.length ?? 0) === 0 && !hasExternalAccounts && !showCreateWallet && !onboardingDismissed)}
            <Onboarding
                wsConnected={appState.wsConnected}
                on:create={() => { showAccountSetup = false; showCreateWallet = true; }}
                on:ledger={connectLedgerAccounts}
                on:yubikey={refreshYubiKeyAccounts}
                on:simulation={({ detail }) =>
                    addSimulationAccount(detail.address, detail.blockchain)}
                on:reconnect={reconnectSignalAfterRoomSave}
                on:done={() => { onboardingDismissed = true; showAccountSetup = false; }}
            />
        {/if}
        {#if accountSetupStatus}
            <div class="alert alert-info text-xs">{accountSetupStatus}</div>
        {/if}

        <!-- Wallet assets + activity + send/receive (shown once a wallet exists).
             Gate on the account address the header already shows: the
             post-DKG `dkgAddress` fetch is one-shot and racy, and a saved
             wallet reloaded from the keystore never sets it. -->
        {@const canCreate =
            !appState.sessionInfo ||
            appState.dkgState === DkgState.Complete}
        {@const canSign =
            keystoreStatus.initialized &&
            !keystoreStatus.locked &&
            (keystoreStatus.wallets?.length ?? 0) > 0 &&
            !appState.sessionInfo}
        {#if canSign && displayAddress}
            {#if showSend && isEvmChain(appState.chain)}
                <div class="card card-pad">
                    {#key `${displayAddress}:${appState.chain}:${currentEvmNetworkId}`}
                    <SendForm
                        from={displayAddress}
                        chain={appState.chain}
                        networkId={currentEvmNetworkId}
                        on:submit={handleSendSubmit}
                        on:cancel={() => (showSend = false)}
                    />
                    {/key}
                </div>
            {:else if showReceive}
                <div class="card card-pad">
                    <ReceiveCard address={displayAddress} chain={String(appState.chain)} network={isEvmChain(appState.chain) ? evmNetworks.find((n) => n.id === currentEvmNetworkId)?.name ?? "" : ""} />
                    <button class="btn-ghost mt-2 w-full" on:click={() => (showReceive = false)}>Close</button>
                </div>
            {:else}
                <div class="grid grid-cols-2 gap-2.5 wallet-actions">
                    <button
                        class="rounded-xl border border-line bg-surface p-3 text-sm font-semibold transition hover:border-primary"
                        on:click={() => { showSend = true; sendStatus = ""; }}
                        disabled={selectedAccount !== 0 || !isEvmChain(appState.chain)}
                        title={selectedAccount !== 0
                            ? "Sending is currently available on Account 0"
                            : isEvmChain(appState.chain)
                              ? "Send"
                              : "Sending is not available for this network"}
                    ><Icon name="send" size={20} /> Send</button>
                    <button
                        class="rounded-xl border border-line bg-surface p-3 text-sm font-semibold transition hover:border-primary"
                        on:click={() => (showReceive = true)}
                    ><Icon name="qr" size={20} /> Receive</button>
                </div>
                {#if sendStatus}
                    <p class="text-xs text-muted">{sendStatus}</p>
                {/if}
                {#key dataEpoch}
                    {#if isEvmChain(appState.chain)}
                        <div class="card card-pad">
                            <TokenList address={displayAddress} chain={appState.chain} networkId={currentEvmNetworkId} />
                        </div>
                        <div class="card card-pad">
                            <ActivityFeed address={displayAddress} chain={appState.chain} />
                        </div>
                        <div class="card card-pad">
                            <NftGallery address={displayAddress} chain={appState.chain || "ethereum"} />
                        </div>
                    {:else if appState.chain === "solana"}
                        <div class="card card-pad">
                            <NftGallery address={displayAddress} chain="solana" />
                        </div>
                    {:else if isSupportedChain(appState.chain)}
                        <div class="alert alert-info text-xs">
                            {CHAIN_METADATA[appState.chain].note ??
                                "Address and threshold signing are available. Transaction tools for this chain are not wired yet."}
                        </div>
                    {/if}
                {/key}
            {/if}
        {/if}

        <!-- Sign message and account tools -->
        {#if canCreate || canSign}<div class="section-title">Wallet tools</div>{/if}
        <!-- Secondary wallet tools -->
        <!-- Wallet management actions -->
        {#if canCreate || canSign}
            <div class="grid grid-cols-2 gap-2.5 wallet-actions">
                {#if canCreate}
                    <button
                        class="group flex flex-col items-start gap-2 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-primary disabled:opacity-50 disabled:hover:border-line"
                        on:click={() => (showCreateWallet = true)}
                        disabled={!appState.wsConnected}
                        title={appState.wsConnected
                            ? "Create a new shared wallet"
                            : signalStatusTitle}
                    >
                        <span
                            class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary"
                        >
                            <Icon name="plus" size={18} />
                        </span>
                        <span class="text-sm font-semibold">Create wallet</span>
                        <span class="text-xs text-muted">New shared wallet</span>
                    </button>
                {/if}
                {#if canSign}
                    <button
                        class="group flex flex-col items-start gap-2 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-primary disabled:opacity-50 disabled:hover:border-line"
                        on:click={() => {
                            showSignForm = true;
                            signError = "";
                            signMessage = "";
                            signWalletId =
                                keystoreStatus.activeWallet?.id ??
                                keystoreStatus.wallets[0].id;
                        }}
                        disabled={!appState.wsConnected}
                        title={appState.wsConnected
                            ? "Start a threshold signing request"
                            : signalStatusTitle}
                    >
                        <span
                            class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-soft text-primary"
                        >
                            <Icon name="edit" size={17} />
                        </span>
                        <span class="text-sm font-semibold">Sign message</span>
                        <span class="text-xs text-muted">Co-sign with your devices</span>
                    </button>
                {/if}
            </div>
        {/if}

        {#if keystoreStatus.initialized}
            <button class="btn btn-secondary btn-block" on:click={() => (showAccountSetup = !showAccountSetup)}><Icon name="plus" size={18} /> Add hardware or watch-only account</button>
        {/if}

        {#if canSign && showSignForm}
            <form
                class="card card-pad space-y-3"
                on:submit|preventDefault={buildSignPreview}
            >
                <FeatureHeader title="Sign a message" subtitle="Review what your devices will approve" icon="edit" />
                <div>
                    <label class="label" for="sign-wallet">Wallet</label>
                    <select
                        id="sign-wallet"
                        bind:value={signWalletId}
                        class="select"
                        disabled={signing_}
                    >
                        {#each keystoreStatus.wallets as w}
                            <option value={w.id}>
                                {w.name ?? w.id} · {chainLabel(w.blockchain)}
                            </option>
                        {/each}
                    </select>
                </div>
                <div>
                    <label class="label" for="sign-msg">Message</label>
                    <textarea
                        id="sign-msg"
                        bind:value={signMessage}
                        class="textarea"
                        rows="3"
                        placeholder="Type the message to sign…"
                        disabled={signing_}
                    ></textarea>
                </div>
                {#if signError}
                    <p class="text-xs text-danger-fg">{signError}</p>
                {/if}
                <div class="flex gap-2">
                    <Button type="submit" block disabled={signing_}>
                        {signing_ ? "Working…" : "Review"}
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={signing_}
                        on:click={() => {
                            showSignForm = false;
                            signMessage = "";
                            signError = "";
                            signPreview = null;
                        }}
                    >
                        Cancel
                    </Button>
                </div>
            </form>
        {/if}

        <!-- Discovered shared-wallet sessions you can join -->
        {#if !appState.sessionInfo && shownInvites.length > 0}
            {@const joinable = shownInvites.filter(
                (inv) =>
                    ((inv.session_type ?? "dkg") === "dkg" ||
                        // M3 reshare: only show if we hold a share in
                        // the wallet's current cohort — outsiders
                        // can't participate in a reshare.
                        (inv.session_type === "reshare" &&
                            (inv.reshare_old_participants ?? []).includes(
                                appState.deviceId,
                            ))) &&
                    inv.proposer_id !== appState.deviceId &&
                    (inv.participants?.length ?? 0) <
                        (inv.total ?? Number.POSITIVE_INFINITY),
            )}
            {#if joinable.length > 0}
                <div class="card card-pad">
                    <h3 class="mb-2 text-sm font-semibold">
                        Wallet invitations
                    </h3>
                    <div class="space-y-2">
                        {#each joinable as inv (inv.session_id)}
                            <div class="list-row">
                                <div class="min-w-0 pr-2">
                                    <p class="text-sm font-medium">
                                        {inv.threshold}-of-{inv.total}
                                        {chainLabel(chainFromSession(inv))}
                                        {#if inv.session_type === "reshare"}
                                            <span class="badge badge-info"
                                                >Reshare</span
                                            >
                                        {/if}
                                    </p>
                                    <p class="truncate text-xs text-muted">
                                        from {inv.proposer_id} ·
                                        {inv.participants?.length ?? 0}/{inv.total}
                                        joined
                                    </p>
                                    {#if inv.session_type === "reshare"}
                                        <p class="truncate text-xs text-muted">
                                            Rotates shares of wallet
                                            {inv.wallet_name ?? "(unknown)"} —
                                            addresses stay the same
                                        </p>
                                    {/if}
                                </div>
                                <Button
                                    size="sm"
                                    variant="success"
                                    disabled={!appState.wsConnected}
                                    on:click={async () => {
                                        try {
                                            const response =
                                                await chrome.runtime.sendMessage(
                                                    {
                                                        type: MESSAGE_TYPES.JOIN_DKG_SESSION,
                                                        session_id:
                                                            inv.session_id,
                                                    },
                                                );
                                            if (!response?.success) {
                                                console.error(
                                                    "[UI] Join failed:",
                                                    response?.error,
                                                );
                                                alert(
                                                    `Join failed: ${response?.error ?? "unknown error"}`,
                                                );
                                            } else {
                                                console.log(
                                                    "[UI] Joined session",
                                                    inv.session_id,
                                                );
                                            }
                                        } catch (e) {
                                            console.error(
                                                "[UI] Join exception:",
                                                e,
                                            );
                                        }
                                    }}
                                >
                                    Join
                                </Button>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}
        {/if}

        <!-- Confirm before broadcasting a signing request. The hash
             shown is computed client-side for display only; the
             background recomputes it before signing. -->
        {#if signPreview}
            <Modal title="Confirm signing request" on:close={cancelSignPreview}>
                <dl class="space-y-3 text-sm">
                    <div>
                        <dt class="label mb-1">Wallet</dt>
                        <dd>
                            {signPreview.walletName}
                            <span class="text-muted">
                                · {chainLabel(signPreview.walletBlockchain)}</span
                            >
                        </dd>
                        <dd class="mono break-all text-[11px] text-muted">
                            {signPreview.walletAddress}
                        </dd>
                    </div>
                    <div>
                        <dt class="label mb-1">Message</dt>
                        <dd
                            class="mono max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2 text-xs"
                        >
                            {signPreview.message}
                        </dd>
                    </div>
                    {#if signPreview.eip191Hash}
                        <details class="rounded-lg border border-line p-2"><summary class="cursor-pointer text-xs text-muted">Technical details</summary>
                            <dt class="label mb-1">
                                EIP-191 hash
                                <span class="font-normal text-faint"
                                    >(signed with threshold ECDSA — ecrecover-compatible)</span
                                >
                            </dt>
                            <dd
                                class="mono break-all rounded-lg bg-warning-soft p-2 text-[10px] text-warning-fg"
                            >
                                {signPreview.eip191Hash}
                            </dd>
                        </details>
                    {/if}
                </dl>
                <p class="mt-3 text-xs text-muted">
                    Once broadcast to your co-signers, the request can't be
                    revoked.
                </p>
                {#if signError}
                    <p class="mt-2 text-xs text-danger-fg">{signError}</p>
                {/if}
                <div class="mt-4 flex gap-2">
                    <Button block on:click={confirmSignPreview} disabled={signing_}>
                        {signing_ ? "Broadcasting…" : "Confirm & broadcast"}
                    </Button>
                    <Button
                        variant="secondary"
                        on:click={cancelSignPreview}
                        disabled={signing_}
                    >
                        Cancel
                    </Button>
                </div>
            </Modal>
        {/if}

        <!-- Incoming signing request from a co-signer (auto-popped) -->
        {#if incomingSigningInvite}
            <Modal
                title="Signing request"
                subtitle="From a co-signer"
                dismissable={false}
            >
                <dl class="space-y-3 text-sm">
                    <div>
                        <dt class="label mb-1">From</dt>
                        <dd class="mono break-all">
                            {incomingSigningInvite.proposer_id}
                        </dd>
                    </div>
                    <div>
                        <dt class="label mb-1">Wallet</dt>
                        <dd>
                            {incomingSigningInvite.wallet_name ?? "(unnamed)"}
                            <span class="text-muted"
                                >· {chainLabel(
                                    signingInviteChain(incomingSigningInvite),
                                )}</span
                            >
                        </dd>
                    </div>
                    <div>
                        <dt class="label mb-1">Threshold</dt>
                        <dd>
                            {incomingSigningInvite.threshold} of
                            {incomingSigningInvite.total}
                        </dd>
                    </div>
                    <div>
                        <dt class="label mb-1">Message</dt>
                        <dd
                            class="mono max-h-24 overflow-auto break-all rounded-lg bg-surface-2 p-2 text-[10px]"
                        >
                            {signingMessagePreview(
                                incomingSigningInvite.signing_message_hex,
                                signingInviteChain(incomingSigningInvite),
                            )}
                        </dd>
                    </div>
                </dl>
                <p class="mt-3 text-xs text-muted">
                    Joining contributes your share toward the threshold. The
                    final signature is visible to all participants.
                </p>
                <div class="mt-4 flex gap-2">
                    <Button block variant="success" on:click={reviewSigningInvite}>
                        Review &amp; join
                    </Button>
                    <Button
                        variant="danger"
                        on:click={declineSigningInvite}
                        title="Tell the proposer you decline"
                    >
                        Decline
                    </Button>
                    <Button
                        variant="ghost"
                        on:click={laterSigningInvite}
                        title="Dismiss; you can still join later"
                    >
                        Later
                    </Button>
                </div>
            </Modal>
        {/if}

        <!-- Peer-decline toasts (auto-dismiss after 6s) -->
        {#if peerDeclineToasts.length > 0}
            <div class="fixed right-4 top-4 z-40 space-y-2">
                {#each peerDeclineToasts as toast (toast.expiresAt)}
                    <div class="alert alert-warning shadow-lg">
                        <p class="font-semibold">A co-signer declined</p>
                        <p class="mono text-[10px] opacity-80">
                            {toast.declinerId}
                        </p>
                    </div>
                {/each}
            </div>
        {/if}

        <!-- Signing-error toasts (auto-dismiss after 8s) -->
        {#if signingErrorToasts.length > 0}
            <div class="fixed right-4 top-4 z-40 space-y-2">
                {#each signingErrorToasts as toast (toast.expiresAt)}
                    <div class="alert alert-danger shadow-lg">
                        <p class="font-semibold">Signing failed</p>
                        <p class="text-[11px] opacity-80">{toast.error}</p>
                    </div>
                {/each}
            </div>
        {/if}

        <!-- Live signing roster: ✓ = commitment, ✓✓ = signature share -->
        {#if signingProgress && !signatureBanner}
            <div class="card card-pad">
                <p class="mb-2 flex items-center gap-2 text-sm font-semibold">
                    Signing in progress
                    <span class="badge badge-info">{signingProgress.state}</span>
                </p>
                <ul class="space-y-1.5">
                    {#each signingProgress.selectedSigners as signer (signer)}
                        {@const hasCommit =
                            signingProgress.commitmentsReceived.includes(signer)}
                        {@const hasShare =
                            signingProgress.sharesReceived.includes(signer)}
                        {@const isSelf = signer === appState.deviceId}
                        <li class="list-row py-1.5 text-xs">
                            <span class="mono truncate" class:font-semibold={isSelf}>
                                {signer}
                                {#if isSelf}
                                    <span class="text-primary">(you)</span>
                                {/if}
                            </span>
                            <span
                                class="badge {hasShare
                                    ? 'badge-success'
                                    : hasCommit
                                      ? 'badge-info'
                                      : 'badge-muted'}"
                                title={hasShare
                                    ? "Commitment + share received"
                                    : hasCommit
                                      ? "Commitment received"
                                      : "Waiting"}
                            >
                                {hasShare ? "✓✓" : hasCommit ? "✓" : "…"}
                            </span>
                        </li>
                    {/each}
                </ul>
                <p class="mt-2 text-[10px] text-muted">
                    ✓ = commitment sent · ✓✓ = signature share sent · … = waiting
                </p>
            </div>
        {/if}

        <!-- Signature complete -->
        {#if signatureBanner}
            <div class="card card-pad">
                <div class="mb-2 flex items-center justify-between">
                    <p
                        class="flex items-center gap-1.5 text-sm font-semibold text-success-fg"
                    >
                        <Icon name="check" size={16} /> Signature complete
                    </p>
                    <button
                        class="icon-btn"
                        style="width:1.8rem;height:1.8rem"
                        on:click={dismissSignatureBanner}
                        aria-label="Dismiss"
                    >
                        <Icon name="x" size={15} />
                    </button>
                </div>
                {#if signatureVerification}
                    <p class="mb-2 text-xs">{signatureVerification}</p>
                {/if}
                <dl class="space-y-2 text-xs">
                    <dd>
                        {#if signatureBanner.blockchain === "ethereum"}
                            <span class="badge badge-info"
                                >EIP-191 · threshold ECDSA</span
                            >
                        {:else}
                            <span class="badge badge-info">ed25519 · Solana</span>
                        {/if}
                    </dd>
                    <div>
                        <dt class="label mb-1">Signature</dt>
                        <dd
                            class="mono break-all rounded-lg bg-surface-2 p-2 text-[10px]"
                        >
                            0x{signatureBanner.signature.replace(/^0x/, "")}
                        </dd>
                    </div>
                    <div>
                        <dt class="label mb-1">Message hash</dt>
                        <dd class="mono break-all text-[10px] text-muted">
                            0x{signatureBanner.messageHex.replace(/^0x/, "")}
                        </dd>
                    </div>
                </dl>
                <Button
                    class="mt-3"
                    block
                    variant="success"
                    on:click={copySignatureToClipboard}
                >
                    {signatureCopied ? "✓ Copied" : "Copy signature"}
                </Button>
            </div>
        {/if}

        <!-- Wallet / ceremony status (the address itself lives in the
             hero card above; this block carries the save form + the
             in-progress states). -->
        {#if appState.sessionInfo && appState.dkgState === DkgState.Complete}
            <!-- Save flow: only when the WASM actually exported a
                 keystore (pendingKeystoreReady). On SW restart the flag
                 is force-reset, so a stale reload won't offer to save
                 empty data. -->
            {#if appState.pendingKeystoreReady}
                <form
                    class="card card-pad space-y-3"
                    on:submit|preventDefault={async () => {
                        saveError = "";
                        if (!savePassword || savePassword.length < 8) {
                            saveError =
                                "Password must be at least 8 characters";
                            return;
                        }
                        if (savePassword !== saveConfirm) {
                            saveError = "Passwords don't match";
                            return;
                        }
                        saving = true;
                        try {
                            const response = await chrome.runtime.sendMessage({
                                type: MESSAGE_TYPES.SAVE_DKG_WALLET,
                                password: savePassword,
                                walletName:
                                    saveWalletName.trim() || undefined,
                            });
                            if (response?.success) {
                                console.log(
                                    "[UI] Wallet saved:",
                                    response.walletId,
                                );
                                savePassword = "";
                                saveConfirm = "";
                                saveWalletName = "";
                            } else {
                                saveError =
                                    response?.error ??
                                    "Save failed (no error returned)";
                            }
                        } catch (e) {
                            saveError = (e as Error).message ?? String(e);
                        } finally {
                            saving = false;
                        }
                    }}
                >
                    <p class="flex items-center gap-1.5 text-sm font-semibold">
                        <Icon name="download" size={15} /> Save this wallet
                    </p>
                    <p class="-mt-1 text-xs text-muted">
                        Encrypt your key share with a password so it survives
                        restarts.
                    </p>
                    <input
                        type="text"
                        placeholder="Wallet name (optional)"
                        bind:value={saveWalletName}
                        class="input"
                        disabled={saving}
                    />
                    <input
                        type="password"
                        placeholder="Password (at least 8 characters)"
                        bind:value={savePassword}
                        class="input"
                        disabled={saving}
                        autocomplete="new-password"
                    />
                    <input
                        type="password"
                        placeholder="Confirm password"
                        bind:value={saveConfirm}
                        class="input"
                        disabled={saving}
                        autocomplete="new-password"
                    />
                    {#if saveError}
                        <p class="text-xs text-danger-fg">{saveError}</p>
                    {/if}
                    <Button type="submit" block variant="success" disabled={saving}>
                        {saving ? "Encrypting…" : "Encrypt & save"}
                    </Button>
                </form>
            {/if}
        {:else if appState.sessionInfo && appState.dkgState === DkgState.Initializing}
            <!-- Creator-side: waiting for joiners to discover the session -->
            {@const needed =
                (appState.sessionInfo.total ?? 0) -
                (appState.sessionInfo.participants?.length ?? 0)}
            <div class="card card-pad">
                <p class="flex items-center gap-1.5 text-sm font-semibold">
                    <Icon name="users" size={15} /> Waiting for people to join
                </p>
                <p class="mt-2 text-xs text-muted">
                    {appState.sessionInfo.threshold}-of-{appState.sessionInfo
                        .total} · share this session so others can join:
                </p>
                <div class="mt-2 rounded-lg border border-line bg-surface-2 p-2.5">
                    <div class="mb-2 flex items-center justify-between gap-2">
                        <span class="text-xs font-semibold">Share setup</span>
                        <CopyButton
                            value={setupInviteText}
                            label="Copy invite"
                            title="Copy room and session ID"
                        />
                    </div>
                    <div class="space-y-1.5">
                        <div class="flex items-center gap-2">
                            <span class="w-16 shrink-0 text-xs text-muted">Room</span>
                            <code class="mono min-w-0 flex-1 truncate text-xs">
                                {signalRoom || "No room set"}
                            </code>
                            {#if signalRoom}
                                <CopyButton
                                    value={signalRoom}
                                    variant="icon"
                                    title="Copy room"
                                />
                            {/if}
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="w-16 shrink-0 text-xs text-muted">Session</span>
                            <code class="mono min-w-0 flex-1 truncate text-xs">
                                {appState.sessionInfo.session_id}
                            </code>
                            <CopyButton
                                value={appState.sessionInfo.session_id}
                                variant="icon"
                                title="Copy session ID"
                            />
                        </div>
                    </div>
                </div>
                <ul class="mt-3 space-y-1">
                    {#each appState.sessionInfo.participants ?? [] as pid}
                        <li class="flex items-center gap-2 text-xs">
                            <span
                                class="h-1.5 w-1.5 rounded-full {pid ===
                                appState.deviceId
                                    ? 'bg-success'
                                    : 'bg-faint'}"
                            ></span>
                            <span class="mono truncate"
                                >{pid}{pid === appState.deviceId
                                    ? " (you)"
                                    : ""}</span
                            >
                        </li>
                    {/each}
                </ul>
                {#if needed > 0}
                    <p class="mt-2 text-xs text-muted">
                        Need {needed} more participant{needed === 1 ? "" : "s"}.
                    </p>
                {/if}
            </div>
        {:else if appState.sessionInfo && appState.dkgState !== DkgState.Idle}
            <div class="alert alert-info">
                Generating keys — your wallet address will appear when complete.
            </div>
        {/if}

        <!-- Multi-account support. Also rendered for hardware/simulation users
             even before any FROST DKG completes. -->
        {#if hasExternalAccounts}
            <AccountManager blockchain={isSupportedChain(appState.chain) ? appState.chain : "ethereum"} />
        {/if}

        <!-- dApp signature requests -->
        {#if signatureRequests.length > 0}
            <div>
                <h2 class="section-title mb-2">Signature requests</h2>
                <div class="space-y-2">
                    {#each signatureRequests as request (request.signingId)}
                        <SignatureRequest
                            signingId={request.signingId}
                            message={request.message}
                            origin={request.origin}
                            fromAddress={request.fromAddress}
                            on:complete={handleSignatureRequestComplete}
                        />
                    {/each}
                </div>
            </div>
        {/if}

    <!-- Active shared-wallet session (DKG ceremony in progress / done) -->
    {#if appState.sessionInfo}
        <div class="card card-pad">
            <div class="mb-3 flex items-center justify-between">
                <h3 class="flex items-center gap-1.5 text-sm font-bold">
                    <Icon name="users" size={16} /> Session
                </h3>
                {#if appState.dkgState === DkgState.Complete}
                    <span class="badge badge-success">Ready to sign</span>
                {:else if appState.dkgState === DkgState.Initializing || appState.dkgState === DkgState.Round1InProgress || appState.dkgState === DkgState.Round1Complete || appState.dkgState === DkgState.Round2InProgress || appState.dkgState === DkgState.Round2Complete || appState.dkgState === DkgState.Finalizing}
                    <span class="badge badge-info">Generating keys…</span>
                {:else if appState.dkgState === DkgState.Failed}
                    <span class="badge badge-danger">Failed</span>
                {:else if appState.meshStatus?.type === MeshStatusType.Ready}
                    <span class="badge badge-warning">Ready to start</span>
                {:else}
                    <span class="badge badge-muted">Connecting…</span>
                {/if}
            </div>

            <div class="grid grid-cols-2 gap-2 text-xs">
                <div class="rounded-lg bg-surface-2 p-2">
                    <span class="text-faint">Threshold</span>
                    <p class="text-sm font-bold">
                        {appState.sessionInfo.threshold} of {appState.sessionInfo
                            .total}
                    </p>
                </div>
                <div class="rounded-lg bg-surface-2 p-2">
                    <span class="text-faint">Stage</span>
                    <p class="text-sm font-semibold">
                        {DkgState[appState.dkgState] || "Unknown"}
                    </p>
                </div>
            </div>

            <div class="mt-3 rounded-lg border border-line bg-surface-2 p-2.5">
                <div class="mb-2 flex items-center justify-between gap-2">
                    <div>
                        <p class="text-xs font-semibold">Share setup</p>
                        <p class="text-[10px] text-muted">
                            Send this to each co-signer joining the wallet.
                        </p>
                    </div>
                    <CopyButton
                        value={setupInviteText}
                        label="Copy invite"
                        title="Copy room and session ID"
                    />
                </div>

                <div class="space-y-1.5">
                    <div class="flex items-center gap-2">
                        <span class="w-16 shrink-0 text-xs text-muted">Room</span>
                        <code class="mono min-w-0 flex-1 truncate text-xs">
                            {signalRoom || "No room set"}
                        </code>
                        {#if signalRoom}
                            <CopyButton
                                value={signalRoom}
                                variant="icon"
                                title="Copy room"
                            />
                        {/if}
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="w-16 shrink-0 text-xs text-muted">Session</span>
                        <code class="mono min-w-0 flex-1 truncate text-xs">
                            {appState.sessionInfo.session_id}
                        </code>
                        <CopyButton
                            value={appState.sessionInfo.session_id}
                            variant="icon"
                            title="Copy session ID"
                        />
                    </div>
                </div>
            </div>

            <div class="mt-3">
                <div class="mb-1.5 flex items-center justify-between">
                    <span class="label mb-0">Participants</span>
                    <span class="text-xs text-faint">
                        {appState.sessionInfo.accepted_devices?.length || 0}/{appState
                            .sessionInfo.participants.length} accepted
                    </span>
                </div>
                <div class="space-y-1">
                    {#each appState.sessionInfo.participants as participant}
                        {@const isAccepted =
                            appState.sessionInfo.accepted_devices?.includes(
                                participant,
                            )}
                        {@const isConnected =
                            appState.webrtcConnections[participant]}
                        <div class="list-row py-1.5 text-xs">
                            <span
                                class="mono truncate"
                                class:font-semibold={participant ===
                                    appState.deviceId}
                            >
                                {participant}{participant === appState.deviceId
                                    ? " (you)"
                                    : ""}
                            </span>
                            <span class="flex items-center gap-1.5">
                                <span
                                    class="badge {isAccepted
                                        ? 'badge-success'
                                        : 'badge-muted'}"
                                    >{isAccepted ? "Accepted" : "Pending"}</span
                                >
                                {#if participant !== appState.deviceId}
                                    <span
                                        class="h-1.5 w-1.5 rounded-full {isConnected
                                            ? 'bg-success'
                                            : 'bg-faint'}"
                                        title={isConnected
                                            ? "Connected"
                                            : "Not connected"}
                                    ></span>
                                {/if}
                            </span>
                        </div>
                    {/each}
                </div>
            </div>

            {#if appState.meshStatus?.type === MeshStatusType.Ready && appState.dkgState === DkgState.Idle}
                <div class="mt-3 border-t border-line pt-3">
                    <p class="mb-2 text-xs text-muted">
                        Everyone's connected — ready to generate keys.
                    </p>
                    <Button block disabled>Start key generation</Button>
                </div>
            {:else if appState.dkgState === DkgState.Complete}
                <div class="mt-3 border-t border-line pt-3">
                    <div class="alert alert-success mb-2">
                        Wallet ready. Any {appState.sessionInfo.threshold} of {appState
                            .sessionInfo.total} can sign together.
                    </div>
                    {#if showDeveloper}
                    <Button
                        variant="ghost"
                        block
                        on:click={testMPCSigning}
                        title="Developer: run a test signing ceremony"
                    >
                        Run test signing
                    </Button>
                    {/if}
                </div>
            {:else if appState.dkgState === DkgState.Initializing || appState.dkgState === DkgState.Round1InProgress || appState.dkgState === DkgState.Round1Complete || appState.dkgState === DkgState.Round2InProgress || appState.dkgState === DkgState.Round2Complete || appState.dkgState === DkgState.Finalizing}
                <div class="mt-3 border-t border-line pt-3">
                    <div class="alert alert-info" data-testid="dkg-progress">
                        {#if appState.dkgState === DkgState.Finalizing && appState.ecdsaDkgStatus === "waiting-primes"}
                            {ecdsaPrimesLabel(appState.ecdsaPrimes)} — the Ethereum key is created as soon as it is done.
                        {:else if appState.dkgState === DkgState.Finalizing && appState.ecdsaDkgStatus === "aux-info"}
                            Creating the Ethereum key (step 1 of 2, takes a few minutes)…
                        {:else if appState.dkgState === DkgState.Finalizing && appState.ecdsaDkgStatus === "keygen"}
                            Creating the Ethereum key (step 2 of 2)…
                        {:else}
                            Generating keys — please keep the popup open until it
                            completes.
                        {/if}
                    </div>
                </div>
            {/if}
        </div>
    {:else if shownInvites.length > 0}
        <!-- Pending invitations -->
        <div class="space-y-2">
            {#each shownInvites as invite}
                <div class="card card-pad">
                    <div class="mb-2 flex items-center justify-between">
                        <h3 class="flex items-center gap-1.5 text-sm font-bold">
                            <Icon name="users" size={15} /> Invitation
                        </h3>
                        <span class="badge badge-warning"
                            >{invite.threshold} of {invite.total}</span
                        >
                    </div>
                    <div class="flex items-center gap-2">
                        <code
                            class="mono min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-2 py-1 text-xs"
                            >{invite.session_id}</code
                        >
                    </div>
                    <p class="mt-1 text-xs text-muted">
                        from {invite.proposer_id}{invite.proposer_id ===
                        appState.deviceId
                            ? " (you)"
                            : ""}
                    </p>
                    <p class="mt-2 text-xs text-muted">
                        Join a {invite.threshold}-of-{invite.total} wallet — any
                        {invite.threshold} participants can sign together.
                    </p>
                    <div class="mt-3 flex gap-2">
                        <Button
                            block
                            variant="success"
                            on:click={() => acceptInvite(invite.session_id)}
                            disabled={acceptingSession}
                        >
                            {acceptingSession ? "Joining…" : "Accept & join"}
                        </Button>
                        <Button
                            variant="secondary"
                            on:click={() => rejectInvite(invite.session_id)}
                        >
                            Decline
                        </Button>
                    </div>
                </div>
            {/each}
        </div>
    {/if}

    <!-- Developer options (connection, devices, manual sessions) -->
    <Collapsible
        title="Advanced"
        subtitle="Connection and device details"
        icon="code"
        bind:open={showDeveloper}
    >
        <div class="space-y-4">
            {#if appState.dkgGroupPublicKey}
                <div>
                    <span class="label">Wallet group key</span>
                    <div class="flex items-center gap-2">
                        <code class="mono min-w-0 flex-1 break-all rounded-lg bg-surface-2 px-2 py-1.5 text-xs">{appState.dkgGroupPublicKey}</code>
                        <CopyButton value={appState.dkgGroupPublicKey} variant="icon" />
                    </div>
                </div>
            {/if}
            <!-- Device id -->
            <div>
                <span class="label">Your device ID</span>
                <div class="flex items-center gap-2">
                    <code
                        class="mono min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-2 py-1.5 text-xs"
                        >{appState.deviceId || "Not connected"}</code
                    >
                    {#if appState.deviceId}
                        <CopyButton value={appState.deviceId} variant="icon" />
                    {/if}
                </div>
            </div>

            <!-- Signal server -->
            <div class="flex items-center justify-between">
                <span class="label mb-0">Signal server</span>
                <span class="badge {signalStatusBadge}" title={signalStatusTitle}>
                    {appState.wsConnected
                        ? "Connected"
                        : hasSignalRoom
                          ? "Disconnected"
                          : "No room configured"}
                </span>
            </div>

            <!-- Connected devices -->
            <div>
                <span class="label"
                    >Connected devices ({appState.connecteddevices.length})</span
                >
                {#if appState.connecteddevices && appState.connecteddevices.length > 0}
                    <ul class="space-y-1.5">
                        {#each appState.connecteddevices as peer}
                            {@const webrtcStatus =
                                appState.webrtcConnections[peer]}
                            {@const isOwnDevice = peer === appState.deviceId}
                            {@const showCheckbox =
                                !isOwnDevice &&
                                !shownInvites.length &&
                                !appState.sessionInfo}
                            {@const isInSession =
                                appState.sessionInfo &&
                                appState.sessionInfo.participants.includes(peer)}
                            <li class="list-row py-1.5 text-xs">
                                <div class="flex min-w-0 items-center gap-2">
                                    {#if showCheckbox}
                                        <input
                                            type="checkbox"
                                            checked={selectedDevices.has(peer)}
                                            disabled={!selectedDevices.has(
                                                peer,
                                            ) &&
                                                selectedDevices.size >=
                                                    appState.totalParticipants -
                                                        1}
                                            on:change={(e) => {
                                                if (e.currentTarget.checked) {
                                                    selectedDevices.add(peer);
                                                } else {
                                                    selectedDevices.delete(peer);
                                                }
                                                selectedDevices = selectedDevices;
                                            }}
                                            class="h-4 w-4 accent-[var(--c-primary)]"
                                        />
                                    {/if}
                                    <code class="mono truncate">{peer}</code>
                                    {#if isOwnDevice}
                                        <span class="badge badge-primary">You</span>
                                    {/if}
                                    {#if isInSession}
                                        <span class="badge badge-info"
                                            >In session</span
                                        >
                                    {/if}
                                </div>
                                {#if !isOwnDevice}
                                    <div class="flex items-center gap-1.5">
                                        {#if webrtcStatus === true}
                                            <span class="badge badge-success"
                                                >P2P</span
                                            >
                                            {#if appState.sessionInfo && appState.meshStatus?.type === MeshStatusType.Ready && isInSession}
                                                <button
                                                    class="btn btn-ghost btn-sm"
                                                    on:click={() =>
                                                        sendDirectMessage(peer)}
                                                >
                                                    Ping
                                                </button>
                                            {/if}
                                        {:else}
                                            <span class="badge badge-muted">—</span>
                                        {/if}
                                    </div>
                                {/if}
                            </li>
                        {/each}
                    </ul>
                    {#if selectedDevices.size > 0 && !shownInvites.length && !appState.sessionInfo}
                        <p class="mt-2 text-xs text-primary">
                            Selected {selectedDevices.size} of {appState.totalParticipants -
                                1} required
                        </p>
                    {/if}
                {:else}
                    <p class="py-2 text-center text-xs text-muted">
                        No devices connected
                    </p>
                {/if}
            </div>

            <!-- Manual session + keystore import/export -->
            {#if !appState.sessionInfo && !shownInvites.length}
                <div class="divider"></div>

                <div class="space-y-2">


                </div>

                <div class="space-y-2">
                    <span class="label">Create session manually</span>
                    <input
                        id="session-id-input"
                        type="text"
                        bind:value={appState.proposedSessionIdInput}
                        class="input"
                        placeholder="Session ID (auto-generated if empty)"
                    />
                    <div class="grid grid-cols-2 gap-2">
                        <div>
                            <label class="label" for="total-participants"
                                >Total</label
                            >
                            <input
                                id="total-participants"
                                type="number"
                                bind:value={appState.totalParticipants}
                                min="2"
                                max={appState.connecteddevices.length}
                                class="input"
                                on:change={() => {
                                    selectedDevices.clear();
                                    selectedDevices = selectedDevices;
                                }}
                            />
                        </div>
                        <div>
                            <label class="label" for="threshold-input"
                                >Threshold</label
                            >
                            <input
                                id="threshold-input"
                                type="number"
                                bind:value={appState.threshold}
                                min="1"
                                max={appState.totalParticipants}
                                class="input"
                            />
                        </div>
                    </div>
                    <Button
                        block
                        on:click={proposeSession}
                        disabled={!appState.wsConnected ||
                            selectedDevices.size !==
                                appState.totalParticipants - 1 ||
                            appState.threshold > appState.totalParticipants ||
                            appState.threshold < 1}
                    >
                        Propose ({appState.threshold}-of-{appState.totalParticipants})
                    </Button>
                    {#if !appState.wsConnected}
                        <p
                            class="text-center text-xs {hasSignalRoom
                                ? 'text-danger-fg'
                                : 'text-warning-fg'}"
                        >
                            {hasSignalRoom
                                ? "Not connected to the signal server"
                                : "Generate and save a signal room first"}
                        </p>
                    {:else if appState.connecteddevices.filter((p) => p !== appState.deviceId).length < appState.totalParticipants - 1}
                        <p class="text-center text-xs text-muted">
                            Need at least {appState.totalParticipants - 1} other device{appState.totalParticipants -
                                1 >
                            1
                                ? "s"
                                : ""}
                        </p>
                    {:else if appState.threshold > appState.totalParticipants || appState.threshold < 1}
                        <p class="text-center text-xs text-danger-fg">
                            Threshold must be between 1 and {appState.totalParticipants}
                        </p>
                    {:else if selectedDevices.size !== appState.totalParticipants - 1}
                        <p class="text-center text-xs text-warning-fg">
                            Select {appState.totalParticipants - 1} device{appState.totalParticipants -
                                1 >
                            1
                                ? "s"
                                : ""} above to include
                        </p>
                    {/if}
                </div>
            {/if}
        </div>
    </Collapsible>

        <!-- Connection error -->
        {#if appState.wsError}
            <div
                class="alert {hasSignalRoom
                    ? 'alert-danger'
                    : 'alert-warning'} flex items-center justify-between gap-2"
            >
                <span class="min-w-0 flex-1">{appState.wsError}</span>
                <button
                    class="icon-btn shrink-0"
                    style="width:1.8rem;height:1.8rem"
                    on:click={() => {
                        appState.wsError = "";
                        appState = { ...appState };
                    }}
                    aria-label="Dismiss"
                >
                    <Icon name="x" size={15} />
                </button>
            </div>
        {/if}
    {/if}
    </div>
</main>

<!-- Password Prompt Modal. Handler slot wrappers coerce the
     nullable `onSubmit`/`onCancel` config fields into plain void
     handlers that Svelte's on:* directive expects (the originals
     can be async — return value is discarded). -->
{#if showPasswordPrompt}
    <PasswordPrompt
        bind:error={passwordPromptError}
        title={passwordPromptConfig.title}
        message={passwordPromptConfig.message}
        confirmMode={passwordPromptConfig.confirmMode}
        on:submit={(e: CustomEvent) => {
            passwordPromptConfig.onSubmit?.(e);
        }}
        on:cancel={() => {
            passwordPromptConfig.onCancel?.();
        }}
    />
{/if}

<!-- All styling now lives in the design system (src/entrypoints/popup/app.css)
     + reusable components in src/lib/ui. No per-screen <style> needed. -->
