import { describe, it, expect, beforeAll, afterAll, jest } from 'bun:test';
import { DkgState, WebRTCManager } from '../../../src/entrypoints/offscreen/webrtc';
import {
    initializeWasmIfNeeded,
    isWasmInitialized,
    createTestSessionInfo,
    dummySend,
    extractPackageFromMap,
    createTestDkgInstances,
    cleanupDkgInstances
} from './test-utils';
import { FrostDkgEd25519 } from '@stars-labs/core-wasm';

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

/**
 * Mid-ceremony signing bookkeeping, as set up by initiateSigningCeremony
 * (the production sessionReadyForSigning path). The legacy
 * SigningRequest/acceptance handshake was deleted — every co-signer now
 * derives the same signingInfo deterministically from the session announce.
 */
function makeSigningInfo(signingId: string, transactionData: string) {
    return {
        signing_id: signingId,
        transaction_data: transactionData,
        threshold: 2,
        participants: ['a', 'b', 'c'],
        acceptances: new Map<string, boolean>(),
        accepted_participants: ['a'],
        // First-come signer set: our own commitment is in; peers join it
        // as their commitments arrive (up to threshold).
        selected_signers: ['a'],
        signer_identifiers: { a: 1, b: 2, c: 3 },
        step: 'commitment_phase' as const,
        initiator: 'a',
    };
}

describe('WebRTCManager FROST Signing Process', () => {
    const sessionInfo = createTestSessionInfo();

    it('should complete full FROST signing process with real cryptography', async () => {
        if (!isWasmInitialized()) {
            console.warn('⚠️ WASM not initialized, skipping FROST signing test.');
            return;
        }

        const managerA = new WebRTCManager('a', dummySend);
        const managerB = new WebRTCManager('b', dummySend);

        // Set up completed DKG state for both managers
        managerA.sessionInfo = sessionInfo as any;
        managerB.sessionInfo = sessionInfo as any;
        (managerA as any)._updateDkgState(DkgState.Complete);
        (managerB as any)._updateDkgState(DkgState.Complete);
        (managerA as any).groupPublicKey = 'shared-group-public-key';
        (managerB as any).groupPublicKey = 'shared-group-public-key';
        (managerA as any).solanaAddress = 'shared-solana-address';
        (managerB as any).solanaAddress = 'shared-solana-address';

        let frostDkgA: FrostDkgEd25519 | null = null;
        let frostDkgB: FrostDkgEd25519 | null = null;
        let frostDkgC: FrostDkgEd25519 | null = null;

        try {
            // Create and set up complete DKG instances
            const dkgInstances = await createTestDkgInstances(false);
            frostDkgA = dkgInstances.frostDkgA as FrostDkgEd25519;
            frostDkgB = dkgInstances.frostDkgB as FrostDkgEd25519;
            frostDkgC = dkgInstances.frostDkgC as FrostDkgEd25519;

            // Complete DKG process to enable signing
            const round1A = frostDkgA.generate_round1();
            const round1B = frostDkgB.generate_round1();
            const round1C = frostDkgC.generate_round1();

            frostDkgA.add_round1_package(2, round1B);
            frostDkgA.add_round1_package(3, round1C);
            frostDkgB.add_round1_package(1, round1A);
            frostDkgB.add_round1_package(3, round1C);
            frostDkgC.add_round1_package(1, round1A);
            frostDkgC.add_round1_package(2, round1B);

            const round2A = frostDkgA.generate_round2();
            const round2B = frostDkgB.generate_round2();
            const round2C = frostDkgC.generate_round2();

            frostDkgA.add_round2_package(2, extractPackageFromMap(1, round2B, false));
            frostDkgA.add_round2_package(3, extractPackageFromMap(1, round2C, false));
            frostDkgB.add_round2_package(1, extractPackageFromMap(2, round2A, false));
            frostDkgB.add_round2_package(3, extractPackageFromMap(2, round2C, false));
            frostDkgC.add_round2_package(1, extractPackageFromMap(3, round2A, false));
            frostDkgC.add_round2_package(2, extractPackageFromMap(3, round2B, false));

            frostDkgA.finalize_dkg();
            frostDkgB.finalize_dkg();
            frostDkgC.finalize_dkg();

            // Only A and B will participate in signing (threshold 2 of 3)
            (managerA as any).frostDkg = frostDkgA;
            (managerB as any).frostDkg = frostDkgB;

            const signingId = 'complete-flow-test';
            const transactionData = '{"transaction": "complete-flow-test-data", "amount": 1000, "recipient": "recipient-address"}';
            const transactionMessageHex = Array.from(new TextEncoder().encode(transactionData))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            // A is mid-ceremony: it has committed (signing_commit registers
            // its own commitment in the engine) and waits for a co-signer.
            (managerA as any).signingInfo = makeSigningInfo(signingId, transactionMessageHex);
            (managerB as any).signingInfo = makeSigningInfo(signingId, transactionMessageHex);
            const commitmentHexA = frostDkgA.signing_commit();
            (managerA as any).signingCommitments.set('a', commitmentHexA);
            const commitmentHexB = frostDkgB.signing_commit();

            // B's commitment completes A's 2-of-3 signer set → A signs.
            await (managerA as any)._handleSigningCommitment('b', {
                signing_id: signingId,
                commitment: commitmentHexB
            });
            expect((managerA as any).signingCommitments.has('b')).toBe(true);
            expect(managerA.signingInfo!.selected_signers).toEqual(['a', 'b']);
            const signatureShareHexA = (managerA as any).signingShares.get('a');
            expect(signatureShareHexA).toBeTruthy();

            // B signs over the same package; its share lets A aggregate.
            frostDkgB.add_signing_commitment(1, commitmentHexA);
            const signatureShareHexB = frostDkgB.sign(transactionMessageHex);
            await (managerA as any)._handleSignatureShare('b', {
                signing_id: signingId,
                share: signatureShareHexB
            });
            const aggregatedSignature = managerA.signingInfo!.final_signature!;

            // B learns the result via the AggregatedSignature broadcast handler.
            await (managerB as any)._handleAggregatedSignature('a', {
                webrtc_msg_type: 'AggregatedSignature' as const,
                signing_id: signingId,
                signature: aggregatedSignature
            });

            // Assertions
            expect(managerB.signingInfo!.final_signature).toBe(aggregatedSignature);
            expect(aggregatedSignature).toMatch(/^[a-f0-9]{128}$/); // Ed25519 signature format

            console.log(`✅ Generated authentic FROST signature: ${aggregatedSignature}`);

        } finally {
            cleanupDkgInstances(frostDkgA, frostDkgB, frostDkgC);
        }
    });
});
