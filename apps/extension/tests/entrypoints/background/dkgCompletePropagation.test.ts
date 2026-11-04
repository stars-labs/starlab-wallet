import {describe, it, expect} from 'bun:test';
import {StateManager, withoutSecrets} from '../../../src/entrypoints/background/stateManager';
import {DkgState} from '@stars-labs/types/dkg';
import {unifiedCompletion} from '../../helpers/unifiedCompletion';

describe('unified DKG completion boundary', () => {
    it('retains both FROST roots and all shares for encryption while selecting the current chain address', () => {
        const mgr = new StateManager({deviceId:'a', chain:'solana', dkgState:DkgState.Finalizing});
        mgr.handleOffscreenStateUpdate(unifiedCompletion() as any);
        const state = mgr.getState();
        expect(state.dkgAddress).toBe('soltest');
        expect(state.frostGroupPublicKeys).toEqual({ed25519:'edabcd', secp256k1:'02cafebabe'});
        expect(state.pendingFrostShares?.ed25519.keystoreJson).toContain('SECRET_ED');
        expect(state.pendingFrostShares?.secp256k1.keystoreJson).toContain('SECRET_SECP');
        expect(state.pendingEcdsaShareJson).toBe('SECRET_ECDSA');
        expect(state.pendingKeystoreReady).toBe(true);
        expect(JSON.stringify(withoutSecrets(state))).not.toContain('SECRET');
        expect(JSON.stringify(withoutSecrets(unifiedCompletion()))).not.toContain('SECRET');
    });
    it('rejects each incomplete algorithm inventory and clears pending secrets', () => {
        for (const omitted of ['ed25519','secp256k1','ecdsa']) {
            const mgr = new StateManager({deviceId:'a'});
            const payload = unifiedCompletion();
            if (omitted === 'ecdsa') delete (payload as any).ecdsa;
            else delete (payload.frost as any)[omitted];
            expect(() => mgr.handleOffscreenStateUpdate(payload as any)).toThrow('Incomplete unified DKG');
            expect(mgr.getState().pendingKeystoreReady).toBe(false);
            expect(mgr.getState().pendingFrostShares).toBeNull();
        }
    });
    it('rejects the removed single-curve result format', () => {
        const mgr = new StateManager({deviceId:'a'});
        expect(() => mgr.handleOffscreenStateUpdate({type:'dkgComplete',keystoreJson:'SECRET',groupPublicKey:'02abcd'} as any)).toThrow('Incomplete unified DKG');
    });
});
