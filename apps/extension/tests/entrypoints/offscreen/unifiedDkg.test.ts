import { beforeAll, describe, test, expect } from 'bun:test';
import init, { FrostDkgUnified, FrostDkgEd25519, FrostDkgSecp256k1 } from '@stars-labs/core-wasm';
import { UnifiedDkg, UNIFIED_ROUND1, UNIFIED_ROUND2, type UnifiedFrostResult } from '../../../src/entrypoints/offscreen/unifiedDkg';
beforeAll(async () => { await init(); });
describe('native unified DKG wire with real WASM', () => {
    test('3-party dual FROST completes with recipient-private round2 and matching group keys', () => {
        const cohort = ['c', 'a', 'b'];
        const queue: Array<{from: string; to: string; text: string}> = [];
        const results = new Map<string, UnifiedFrostResult>();
        const drivers = new Map<string, UnifiedDkg>();
        for (const peer of cohort) drivers.set(peer, new UnifiedDkg(new FrostDkgUnified(), cohort, peer, 2, (to, text) => queue.push({ from: peer, to, text }), () => {}, result => results.set(peer, result)));
        try {
            for (const driver of drivers.values()) driver.start();
            let delivered = 0;
            while (queue.length) {
                const frame = queue.shift()!;
                if (frame.text.startsWith(UNIFIED_ROUND2)) {
                    const message = JSON.parse(frame.text.slice(UNIFIED_ROUND2.length));
                    const recipient = [...cohort].sort().indexOf(frame.to) + 1;
                    expect(Object.keys(message.ed25519)).toEqual([String(recipient)]);
                    expect(Object.keys(message.secp256k1)).toEqual([String(recipient)]);
                    expect(message.from_index).toBe([...cohort].sort().indexOf(frame.from) + 1);
                }
                drivers.get(frame.to)!.receive(frame.from, frame.text);
                drivers.get(frame.to)!.receive(frame.from, frame.text);
                if (drivers.get(frame.to)!.round2.size < cohort.length) expect(results.has(frame.to)).toBe(false);
                if (++delivered > 30) throw new Error('Ceremony did not converge');
            }
            expect(results.size).toBe(3);
            expect(new Set([...results.values()].map(r => r.ed25519.groupPublicKey)).size).toBe(1);
            expect(new Set([...results.values()].map(r => r.secp256k1.groupPublicKey)).size).toBe(1);
            for (const result of results.values()) {
                const ed = new FrostDkgEd25519(), secp = new FrostDkgSecp256k1();
                try {
                    ed.import_keystore(result.ed25519.keystoreJson); secp.import_keystore(result.secp256k1.keystoreJson);
                    expect(ed.get_group_public_key()).toBe(result.ed25519.groupPublicKey);
                    expect(secp.get_group_public_key()).toBe(result.secp256k1.groupPublicKey);
                } finally { ed.free(); secp.free(); }
            }
        } finally { for (const driver of drivers.values()) driver.dispose(); }
    });
    test('rejects spoofed sender, nonmember, another recipient and whole-map disclosure', () => {
        const driver = new UnifiedDkg(new FrostDkgUnified(), ['a','b','c'], 'a', 2, () => {}, () => {}, () => {});
        try {
            driver.start();
            const round2 = (from_index: number, ed25519: object, secp256k1: object) => UNIFIED_ROUND2 + JSON.stringify({from_index, ed25519, secp256k1});
            expect(() => driver.receive('outsider', UNIFIED_ROUND1 + '{}')).toThrow();
            expect(() => driver.receive('b', round2(3, {1:'aa'}, {1:'bb'}))).toThrow();
            expect(() => driver.receive('b', round2(2, {3:'aa'}, {3:'bb'}))).toThrow();
            expect(() => driver.receive('b', round2(2, {1:'aa',3:'cc'}, {1:'bb',3:'dd'}))).toThrow();
        } finally { driver.dispose(); }
    });
});
