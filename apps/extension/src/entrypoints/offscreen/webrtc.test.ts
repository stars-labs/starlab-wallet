import { describe, it, expect } from 'bun:test';
import { WebRTCManager, MeshStatusType } from './webrtc';
const dummySend = (_peer: string, _message: any) => {};

describe('WebRTCManager mesh readiness', () => {
    const sessionInfo = {
        session_id: 'test-session',
        participants: ['a', 'b', 'c'],
        accepted_devices: ['a', 'b', 'c'],
        total: 3,
        threshold: 2
    };

    it('should transition to PartiallyReady when first MeshReady received', () => {
        const manager = new WebRTCManager('a', dummySend);
        // Set session and initial mesh status
        manager.sessionInfo = sessionInfo as any;
        (manager as any)._updateMeshStatus({ type: MeshStatusType.Incomplete });

        // Simulate receiving MeshReady from 'b'
        (manager as any)._processPeerMeshReady('b');

        expect(manager.meshStatus.type).toBe(MeshStatusType.PartiallyReady);
        const readydevices = (manager.meshStatus as any).ready_devices as Set<string>;
        expect(readydevices.has('a')).toBe(true);
        expect(readydevices.has('b')).toBe(true);
    });

    it('should transition to Ready when all MeshReady received', () => {
        const manager = new WebRTCManager('a', dummySend);
        manager.sessionInfo = sessionInfo as any;
        // Simulate two devices already ready
        (manager as any)._updateMeshStatus({
            type: MeshStatusType.PartiallyReady,
            ready_devices: new Set(['a', 'b']),
            total_devices: 3
        });

        // Now simulate receiving MeshReady from 'c'
        (manager as any)._processPeerMeshReady('c');

        expect(manager.meshStatus.type).toBe(MeshStatusType.Ready);
    });
});

describe('#29 canonical participant ordering (ext↔CLI interop)', () => {
    // FROST identifiers must come from SORTED participant order to match the
    // Rust core's canonical_identifier (dkg.rs: participants.sort() then pos+1).
    it('sorts participants when a session is assigned', () => {
        const m = new WebRTCManager('m', dummySend) as any;
        const sorted = m._withSortedParticipants({
            session_id: 's', participants: ['z', 'a', 'm'], accepted_devices: [],
        });
        expect(sorted.participants).toEqual(['a', 'm', 'z']);
        // canonical identifier for 'm' = sorted position + 1 = 2 (NOT 3, its
        // index in the original join-order array).
        expect(sorted.participants.indexOf('m') + 1).toBe(2);
    });

    it('is null/empty safe', () => {
        const m = new WebRTCManager('m', dummySend) as any;
        expect(m._withSortedParticipants(null)).toBeNull();
        const empty = m._withSortedParticipants({ session_id: 's', participants: [], accepted_devices: [] });
        expect(empty.participants).toEqual([]);
    });

    it('does not mutate the input array', () => {
        const m = new WebRTCManager('m', dummySend) as any;
        const input = { session_id: 's', participants: ['z', 'a'], accepted_devices: [] };
        m._withSortedParticipants(input);
        expect(input.participants).toEqual(['z', 'a']); // original untouched
    });
});

describe('WebRTCManager DKG threshold', () => {
    it('joins with the session threshold, not ceil(n/2)', async () => {
        // A 3-of-3 invite: ceil(3/2) = 2 would give this peer a different
        // commitment count and every participant's part2 fails.
        const calls: number[][] = [];
        const g = globalThis as any;
        const saved = g.FrostDkgUnified;
        class FakeDkg {
            init_dkg(...args: number[]) { calls.push(args); }
            generate_round1() { return JSON.stringify({ed25519:"aa",secp256k1:"bb"}); }
            free() {}
        }
        g.FrostDkgUnified = FakeDkg;
        try {
            const manager = new WebRTCManager('b', dummySend);
            manager.sessionInfo = {
                session_id: 'three-of-three',
                curve_type: 'unified',
                participants: ['a', 'b', 'c'],
                accepted_devices: ['a', 'b', 'c'],
                total: 3,
                threshold: 3,
            } as any;
            await manager.initializeDkg('ethereum');
            expect(calls).toEqual([[2, 3, 3]]);
            manager.resetDkgState();
        } finally {
            g.FrostDkgUnified = saved;
        }
    });
});
