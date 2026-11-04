import { describe, it, test, expect, beforeAll, beforeEach, afterEach, afterAll, jest } from 'bun:test';
import { DkgState, WebRTCManager, SigningState } from '../../../src/entrypoints/offscreen/webrtc';
import {
    initializeWasmIfNeeded,
    isWasmInitialized,
    createTestSessionInfo,
    dummySend,
    cleanupDkgInstances
} from './test-utils';
import { FrostDkgEd25519 } from '@stars-labs/core-wasm';

let manager: WebRTCManager;

let originalConsoleLog: any;
let originalConsoleError: any;
let originalConsoleWarn: any;

beforeAll(async () => {
    await initializeWasmIfNeeded();
    
    // Suppress console output for cleaner test results
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
});

afterAll(() => {
    // Restore console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
});

beforeEach(() => {
    manager = new WebRTCManager("test-peer-a", dummySend);
    (manager as any).sendPayloadToBackgroundForRelay = () => { };
});

describe('WebRTCManager FROST Signing Error Scenarios', () => {
    it('should handle signature share validation errors', async () => {
        const sessionInfo = createTestSessionInfo();
        manager.sessionInfo = sessionInfo as any;
        (manager as any)._updateDkgState(DkgState.Complete);

        // Set up signing process mid-ceremony (share phase)
        (manager as any).signingState = SigningState.SharePhase;

        // Set up signing info to prevent completion
        (manager as any).signingInfo = {
            signing_id: 'test-sig',
            transaction_data: '{"test": "data"}',
            threshold: 2,
            participants: ['a', 'b', 'c'],
            accepted_participants: ['a', 'b'],
            selected_signers: ['a', 'b'],
            step: 'share_phase',
            initiator: 'a'
        };

        // Handle invalid signature share
        await (manager as any)._handleSignatureShare('b', {
            signing_id: 'test-sig',
            sender_identifier: 2,
            share: {
                signer_id: 'b',
                share_data: 'invalid-share-data',
                signing_id: 'test-sig'
            }
        });

        // Should handle gracefully
        expect(manager.signingState).toBe(SigningState.SharePhase);
    });
});
