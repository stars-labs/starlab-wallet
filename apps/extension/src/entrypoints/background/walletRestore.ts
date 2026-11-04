/** Restore one saved unified wallet, without manufacturing an active ceremony. */
import { isEvmChain, type AppState } from '@stars-labs/types/appstate';
import { DkgState } from '@stars-labs/types/dkg';
import type { KeyShareData } from '@stars-labs/types/keystore';
import type { KeystoreManager } from '../../services/keystoreManager';
import type { StateManager } from './stateManager';

type RestoreStateManager = Pick<StateManager, 'getState' | 'getChain' | 'updateState' | 'broadcastCurrentState'>;
type RestoreKeystore = Pick<KeystoreManager, 'initialize' | 'isInitialized' | 'isLocked' | 'getActiveWallet' | 'getKeyShare' | 'getCurveShare'>;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function validFrost(share: KeyShareData): boolean {
    const names = share.participants;
    const identifiers = share.participant_identifiers;
    return nonempty(share.key_package) && nonempty(share.public_key_package)
        && Number.isInteger(share.threshold) && share.threshold >= 2
        && Number.isInteger(share.total_participants) && share.total_participants >= share.threshold
        && Array.isArray(names) && names.length === share.total_participants && new Set(names).size === names.length
        && !!identifiers && Object.keys(identifiers).length === names.length
        && new Set(Object.values(identifiers)).size === names.length
        && names.every(name => nonempty(name) && Number.isInteger(identifiers[name]) && identifiers[name] > 0)
        && identifiers[share.device_id] === share.participant_index;
}
function validEcdsaCohort(cohort: KeyShareData['ecdsa_cohort'], device: string): boolean {
    return !!cohort && Number.isInteger(cohort.threshold) && cohort.threshold >= 2
        && Number.isInteger(cohort.total) && cohort.total >= cohort.threshold
        && Array.isArray(cohort.participants) && cohort.participants.length === cohort.total
        && cohort.participants.every(nonempty) && new Set(cohort.participants).size === cohort.total
        && Number.isInteger(cohort.participantIndex) && cohort.participantIndex > 0
        && cohort.participants[cohort.participantIndex - 1] === device;
}
function clearWallet(state: RestoreStateManager, error: string): void {
    state.updateState({
        dkgState: DkgState.Failed, dkgError: error,
        dkgAddress: '', dkgGroupPublicKey: '', frostGroupPublicKeys: undefined, ecdsaGroupPublicKey: '',
        walletQuorums: undefined, ethereumAddress: '', solanaAddress: '', dkgLastResult: undefined,
        pendingKeystoreReady: false, accountsUpdated: undefined,
    });
    state.broadcastCurrentState();
}
export async function restoreActiveWallet(stateManager: RestoreStateManager, keystoreManager: RestoreKeystore): Promise<void> {
    try {
        await keystoreManager.initialize(stateManager.getState().deviceId);
        if (!await keystoreManager.isInitialized() || keystoreManager.isLocked()) return;
        const activeWallet = keystoreManager.getActiveWallet();
        if (!activeWallet) return;
        const keyShare = await keystoreManager.getKeyShare(activeWallet.id);
        const roots = keyShare?.frost_group_public_keys;
        if (!keyShare || keyShare.curve !== 'secp256k1' || !validFrost(keyShare)
            || !nonempty(roots?.ed25519) || !nonempty(roots?.secp256k1)
            || roots.secp256k1 !== keyShare.group_public_key || !nonempty(keyShare.ecdsa_group_public_key)
            || !validEcdsaCohort(keyShare.ecdsa_cohort, keyShare.device_id)) {
            throw new Error('Incomplete unified wallet metadata. Recreate this test wallet using unified DKG.');
        }
        // The real manager can throw when either encrypted algorithm entry is missing.
        const edShare = await keystoreManager.getKeyShare(activeWallet.id, 'ed25519');
        const ecdsaShare = await keystoreManager.getCurveShare(activeWallet.id, 'secp256k1-ecdsa');
        if (!edShare || !validFrost(edShare) || edShare.curve !== 'ed25519' || !nonempty(ecdsaShare)
            || edShare.group_public_key !== roots.ed25519
            || edShare.frost_group_public_keys?.ed25519 !== roots.ed25519
            || edShare.frost_group_public_keys?.secp256k1 !== roots.secp256k1
            || edShare.ecdsa_group_public_key !== keyShare.ecdsa_group_public_key
            || edShare.device_id !== keyShare.device_id || edShare.session_id !== keyShare.session_id
            || !validEcdsaCohort(edShare.ecdsa_cohort, edShare.device_id)
            || edShare.ecdsa_cohort!.threshold !== keyShare.ecdsa_cohort!.threshold
            || edShare.ecdsa_cohort!.total !== keyShare.ecdsa_cohort!.total
            || edShare.ecdsa_cohort!.participantIndex !== keyShare.ecdsa_cohort!.participantIndex
            || JSON.stringify(edShare.ecdsa_cohort!.participants) !== JSON.stringify(keyShare.ecdsa_cohort!.participants)) {
            throw new Error('Unified wallet is missing a valid, consistent algorithm share.');
        }
        const state = stateManager.getState();
        // EVM networks share the Ethereum account. Every other chain is exact;
        // the inventory row's primary address may belong to a different chain.
        const chain = stateManager.getChain();
        const addressChain = isEvmChain(chain) ? 'ethereum' : chain;
        const addressFor = (chain: string | undefined) => keyShare.blockchains.find(entry => entry.blockchain === chain)?.address;
        const address = addressFor(addressChain);
        if (!nonempty(address)) throw new Error(`Wallet has no saved address for ${chain}.`);
        const patch: Partial<AppState> = {
            dkgState: DkgState.Complete, dkgError: '', pendingKeystoreReady: false,
            dkgAddress: address, dkgGroupPublicKey: roots.secp256k1, frostGroupPublicKeys: roots,
            ecdsaGroupPublicKey: keyShare.ecdsa_group_public_key,
            walletQuorums: {
                secp256k1: {threshold:keyShare.threshold,total:keyShare.total_participants},
                ed25519: {threshold:edShare.threshold,total:edShare.total_participants},
                'secp256k1-ecdsa': {threshold:keyShare.ecdsa_cohort!.threshold,total:keyShare.ecdsa_cohort!.total},
            },
            ethereumAddress: addressFor('ethereum'), solanaAddress: addressFor('solana'),
            dkgLastResult: {
                groupPublicKey:keyShare.group_public_key,address,blockchain:state.blockchain ?? 'ethereum',chain,
                sessionId:keyShare.session_id,threshold:keyShare.threshold,total:keyShare.total_participants,
                participants:keyShare.participants,participantIndex:keyShare.participant_index,completedAt:keyShare.created_at,
            },
        };
        stateManager.updateState(patch);
        stateManager.broadcastCurrentState();
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not restore the saved wallet.';
        clearWallet(stateManager, message);
        throw new Error(message);
    }
}
