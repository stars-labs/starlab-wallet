// ===================================================================
// YUBIKEY MANAGER MODULE
// ===================================================================
//
// Bridges the YubiKey signer backend (src/signers/yubikey) into the
// extension's account + signing world. Lives only in the background
// service worker — that's the sole context where
// `chrome.runtime.connectNative` works.
//
// Responsibilities:
//   1. On startup, discover on-card accounts via the native host and
//      register a live YubiKeySigner per account in a SignerRegistry
//      (the signers hold a HostClient port, so they MUST stay here).
//   2. Mirror each discovered account into AccountService (chrome.storage
//      .local) so the popup renders them alongside FROST accounts with a
//      `type: 'hardware'` marker — the popup can't talk to the host, so
//      storage is the surface we share state through.
//   3. Resolve an address back to its YubiKeySigner so the RPC signing
//      path can route a sign request to the card.
//
// Resilience: if the host is absent, discoverYubiKeyAccounts() returns []
// and everything below is a no-op — FROST is never affected.
// ===================================================================

import AccountService from "../../services/accountService";
import type { Account } from "@starlab/types/account";
import {
    SignerRegistry,
    YubiKeySigner,
    discoverYubiKeyAccounts,
} from "../../signers";

export class YubiKeyManager {
    private readonly registry = new SignerRegistry();
    private readonly accountService: AccountService;
    /** address (lowercased) → signer, for fast routing on sign. */
    private readonly byAddress = new Map<string, YubiKeySigner>();

    constructor() {
        this.accountService = AccountService.getInstance();
    }

    /**
     * Discover YubiKey accounts and register them. Safe to call on every
     * SW wake — re-registering the same id is idempotent in the registry,
     * and mirroring into AccountService uses addOrUpdate semantics.
     */
    async discover(): Promise<YubiKeySigner[]> {
        let signers: YubiKeySigner[];
        try {
            signers = await discoverYubiKeyAccounts();
        } catch (error) {
            // discoverYubiKeyAccounts already swallows host-absent errors
            // and returns []; this catch is belt-and-suspenders so a
            // discovery failure never breaks background startup.
            console.warn("[YubiKeyManager] discovery failed:", error);
            return [];
        }

        if (signers.length === 0) {
            console.log(
                "[YubiKeyManager] no YubiKey accounts (host absent or no card)",
            );
            return [];
        }

        for (const signer of signers) {
            this.registry.register(signer);
            this.byAddress.set(signer.address().toLowerCase(), signer);
        }

        await this.mirrorToAccountService(signers);
        console.log(
            `[YubiKeyManager] registered ${signers.length} YubiKey account(s)`,
        );
        return signers;
    }

    /**
     * Look up the YubiKeySigner backing an address (case-insensitive).
     * Returns undefined for non-YubiKey / unknown addresses so the
     * caller falls through to the FROST path.
     */
    getSignerByAddress(address: string): YubiKeySigner | undefined {
        return this.byAddress.get(address.toLowerCase());
    }

    /** The underlying registry (id-keyed), if a caller wants raw access. */
    getRegistry(): SignerRegistry {
        return this.registry;
    }

    /**
     * Persist discovered accounts into AccountService so the popup —
     * which reads AccountService from chrome.storage.local and cannot
     * reach the native host — can render them. Marked `type: 'hardware'`
     * with `source: 'imported'` (closest existing enum member; these are
     * external keys, not DKG/generated).
     */
    private async mirrorToAccountService(
        signers: YubiKeySigner[],
    ): Promise<void> {
        await this.accountService.ensureInitialized();
        for (const signer of signers) {
            // family on the card is "solana" (ed25519) | "evm" (secp256k1);
            // map to the Account blockchain union the rest of the UI uses.
            const blockchain: Account["blockchain"] =
                signer.curve === "ed25519" ? "solana" : "ethereum";
            const account: Account = {
                // Prefix so the YubiKey id (e.g. "piv:9a:ed25519") can't
                // collide with a FROST wallet id, and so signing routing
                // / cleanup can recognise hardware accounts by id too.
                id: `yubikey:${signer.id}`,
                address: signer.address(),
                name: this.labelFor(signer),
                balance: "0",
                blockchain,
                created: Date.now(),
                type: "hardware",
                metadata: {
                    source: "imported",
                    tags: ["yubikey", signer.kind],
                },
            };
            try {
                await this.accountService.addOrUpdateAccount(account);
            } catch (error) {
                console.warn(
                    `[YubiKeyManager] failed to mirror account ${account.id}:`,
                    error,
                );
            }
        }
    }

    private labelFor(signer: YubiKeySigner): string {
        const applet = signer.kind === "yubikey-openpgp" ? "OpenPGP" : "PIV";
        const chain = signer.curve === "ed25519" ? "Solana" : "EVM";
        return `YubiKey ${applet} (${chain})`;
    }
}
