import { beforeAll, describe, test, expect } from 'bun:test';
import init, { FrostDkgUnified } from '@stars-labs/core-wasm';
import { WebRTCManager, DkgState } from './webrtc';
beforeAll(async () => { await init(); });
function manager() {
    const manager = new WebRTCManager('a', () => {});
    manager.sessionInfo = { session_id: 'environment', session_type: 'dkg', curve_type: 'unified', participants: ['a','b'], accepted_devices: ['a','b'], proposer_id: 'a', threshold: 2, total: 2 } as any;
    return manager;
}
describe('offscreen unified WASM bootstrap', () => {
    test('fails closed when unified WASM was not registered, without a single-curve fallback', async () => {
        const previous = (globalThis as any).FrostDkgUnified;
        const instance = manager();
        try {
            delete (globalThis as any).FrostDkgUnified;
            expect(await instance.initializeDkg()).toBe(false);
            expect(instance.dkgState).toBe(DkgState.Failed);
        } finally { instance.resetDkgState(); (globalThis as any).FrostDkgUnified = previous; }
    });
    test('registered production WASM starts both curves from the same session', async () => {
        const previous = (globalThis as any).FrostDkgUnified;
        const instance = manager(), sent: string[] = [];
        try {
            (globalThis as any).FrostDkgUnified = FrostDkgUnified;
            instance.sendWebRTCAppMessage = (_peer, message) => sent.push((message as any).text);
            expect(await instance.initializeDkg()).toBe(true);
            expect(sent).toHaveLength(1);
            expect(sent[0]).toStartWith('UNIFIED_DKG_ROUND1:');
            const round = JSON.parse(sent[0]!.slice('UNIFIED_DKG_ROUND1:'.length));
            expect(round.ed25519).toMatch(/^[0-9a-f]+$/);
            expect(round.secp256k1).toMatch(/^[0-9a-f]+$/);
        } finally { instance.resetDkgState(); (globalThis as any).FrostDkgUnified = previous; }
    });
});
