import { beforeAll, describe, it, expect } from 'bun:test';
import init, { FrostDkgUnified } from '@stars-labs/core-wasm';
import { WebRTCManager, DkgState } from '../../../src/entrypoints/offscreen/webrtc';
import { UNIFIED_ROUND1, UNIFIED_ROUND2 } from '../../../src/entrypoints/offscreen/unifiedDkg';

beforeAll(async () => { await init(); (globalThis as any).FrostDkgUnified = FrostDkgUnified; });
function manager(curve = 'unified') {
    const manager = new WebRTCManager('a', () => {});
    manager.sessionInfo = { session_id: 'dkg_test', proposer_id: 'a', participants: ['c','a','b'], accepted_devices: ['a','b','c'], threshold: 2, total: 3, curve_type: curve, session_type: 'dkg' } as any;
    const frames: Array<{to: string; message: any}> = [];
    manager.sendWebRTCAppMessage = (to, message) => frames.push({to, message});
    return { manager, frames };
}
describe('unified wallet DKG lifecycle', () => {
    it('initializes both curves with canonical identifiers and native JSON round1', async () => {
        const {manager: m, frames} = manager();
        try {
            expect(await m.initializeDkg('solana')).toBe(true);
            expect(m.dkgState).toBe(DkgState.Round1InProgress);
            expect(m.getDkgStatus().participantIndex).toBe(1);
            expect(m.getDkgStatus().frostDkgInitialized).toBe(true);
            expect(m.getDkgStatus().receivedRound1Packages).toEqual(['a']);
            expect(frames.map(f => f.to)).toEqual(['b','c']);
            for (const frame of frames) {
                expect(frame.message.text.startsWith(UNIFIED_ROUND1)).toBe(true);
                const round = JSON.parse(frame.message.text.slice(UNIFIED_ROUND1.length));
                expect(round.ed25519).toMatch(/^[0-9a-f]+$/);
                expect(round.secp256k1).toMatch(/^[0-9a-f]+$/);
            }
            expect(await m.initializeDkg()).toBe(false);
        } finally { m.resetDkgState(); }
    });
    it('rejects single-curve creation and a session cohort missing this device', async () => {
        const legacy = manager('ed25519');
        expect(await legacy.manager.initializeDkg()).toBe(false);
        expect(legacy.frames).toEqual([]);
        const current = manager();
        current.manager.sessionInfo!.participants = ['b','c','d'];
        expect(await current.manager.initializeDkg('solana')).toBe(false);
        expect(current.manager.dkgState).toBe(DkgState.Failed);
        expect(current.frames).toEqual([]);
        current.manager.resetDkgState();
    });
    it('buffers early frames once and resets the prior ceremony rather than replaying it into another', async () => {
        const {manager: m} = manager();
        const peer = new FrostDkgUnified(); peer.init_dkg(2,3,2);
        try {
            const text = UNIFIED_ROUND1 + peer.generate_round1();
            for (let i=0;i<5;i++) m.handleWebRTCAppMessage('b', {webrtc_msg_type:'SimpleMessage', text} as any);
            expect((m as any).bufferedUnifiedFrames).toHaveLength(1);
            expect(await m.initializeDkg()).toBe(true);
            expect(m.getDkgStatus().receivedRound1Packages).toEqual(['a','b']);
            m.resetDkgState();
            expect(m.getDkgStatus().state).toBe(DkgState.Idle);
            expect(m.getDkgStatus().frostDkgInitialized).toBe(false);
            expect((m as any).bufferedUnifiedFrames).toEqual([]);
        } finally { m.resetDkgState(); peer.free(); }
    });
    it('rejects malformed and spoofed round2 without logging or forwarding secret material', async () => {
        const {manager: m} = manager(); const forwarded: unknown[] = [], logs: string[] = [];
        m.onWebRTCAppMessage = (_peer, message) => forwarded.push(message);
        m.onLog = message => logs.push(message);
        try {
            await m.initializeDkg();
            m.handleWebRTCAppMessage('b', {webrtc_msg_type:'SimpleMessage', text:UNIFIED_ROUND2 + JSON.stringify({from_index:3,ed25519:{1:'private-test-share'},secp256k1:{1:'private-test-share'}})} as any);
            expect(m.dkgState).toBe(DkgState.Failed);
            expect(forwarded).toEqual([]);
            expect(logs.join('\n')).not.toContain('private-test-share');
        } finally { m.resetDkgState(); }
    });
    it('cannot complete a cancelled same-session DKG after waiting for primes', async () => {
        const {manager: m} = manager(); let ready!: (value: string) => void; let ran = false; const results: unknown[] = [];
        m.getEcdsaPrimes = () => new Promise(resolve => { ready = resolve; });
        (m.ecdsa as any).runDkg = async () => { ran = true; throw new Error('must not start'); };
        m.onDkgComplete = result => results.push(result);
        (m as any)._updateDkgState(DkgState.Finalizing);
        const pending = (m as any)._runEcdsaDkg({} as any, 'dkg_test', (m as any).dkgEpoch);
        m.resetDkgState(); ready('fixture'); await pending;
        expect(ran).toBe(false); expect(results).toEqual([]); expect(m.dkgState).toBe(DkgState.Idle);
    });
    it('reports an ECDSA worker failure without publishing a partial wallet', async () => {
        const {manager: m} = manager(); const results: unknown[] = [];
        m.getEcdsaPrimes = async () => 'fixture';
        (m.ecdsa as any).runDkg = async () => { throw new Error('peer vanished'); };
        m.onDkgComplete = result => results.push(result);
        (m as any)._updateDkgState(DkgState.Finalizing);
        await (m as any)._runEcdsaDkg({} as any, 'dkg_test', (m as any).dkgEpoch);
        expect(m.dkgState).toBe(DkgState.Failed); expect(results).toEqual([]);
    });
});
