// ===================================================================
// SAVED-WALLET RESTORE
// ===================================================================
//
// Rehydrates the background state from the keystore's active wallet on
// service-worker start, unlock, wallet switch and migration.
//
// Restores the WALLET only — never a session. `sessionInfo` means "a
// ceremony is in progress" (the popup disables Sign and hides signing
// invites while it is set), and sessions are ephemeral by design. The
// wallet's real threshold / total / cohort come from its key share.
// ===================================================================

import type { AppState } from "@stars-labs/types/appstate";
import { DkgState } from "@stars-labs/types/dkg";
import type { KeystoreManager } from "../../services/keystoreManager";
import type { StateManager } from "./stateManager";

type RestoreStateManager = Pick<StateManager, "getState" | "updateState" | "broadcastCurrentState">;
type RestoreKeystore = Pick<
    KeystoreManager,
    "initialize" | "isInitialized" | "isLocked" | "getActiveWallet" | "getKeyShare"
>;

export async function restoreActiveWallet(
    stateManager: RestoreStateManager,
    keystoreManager: RestoreKeystore,
): Promise<void> {
    await keystoreManager.initialize(stateManager.getState().deviceId);

    if (!await keystoreManager.isInitialized()) {
        console.log("🔑 [Background] No keystore found");
        return;
    }
    if (keystoreManager.isLocked()) {
        // The popup will prompt for the password; unlock restores again.
        console.log("🔑 [Background] Keystore is locked - password required");
        return;
    }
    const activeWallet = keystoreManager.getActiveWallet();
    if (!activeWallet) {
        console.log("🔑 [Background] No active wallet found");
        return;
    }

    console.log(`🔑 [Background] Restoring wallet: ${activeWallet.id}`);
    const keyShare = await keystoreManager.getKeyShare(activeWallet.id);
    const blockchain: AppState["blockchain"] =
        activeWallet.blockchain === "solana" ? "solana" : "ethereum";

    const patch: Partial<AppState> = {
        dkgState: DkgState.Complete,
        dkgAddress: activeWallet.address,
    };
    if (activeWallet.address) {
        if (blockchain === "ethereum") patch.ethereumAddress = activeWallet.address;
        else patch.solanaAddress = activeWallet.address;
        chrome.storage.local.set({ [`mpc_${blockchain}_address`]: activeWallet.address });
    }
    if (keyShare) {
        patch.dkgGroupPublicKey = keyShare.group_public_key;
        patch.dkgLastResult = {
            groupPublicKey: keyShare.group_public_key,
            address: activeWallet.address || null,
            blockchain,
            sessionId: keyShare.session_id,
            threshold: keyShare.threshold,
            total: keyShare.total_participants,
            participants: keyShare.participants,
            participantIndex: keyShare.participant_index,
            completedAt: keyShare.created_at,
        };
    } else {
        console.warn(`🔑 [Background] No key share for wallet ${activeWallet.id}; threshold unknown`);
    }

    stateManager.updateState(patch);
    stateManager.broadcastCurrentState();
    console.log(`🔑 [Background] Wallet restored successfully: ${activeWallet.address}`);
}
