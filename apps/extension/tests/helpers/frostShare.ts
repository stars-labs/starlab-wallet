import {FrostDkgEd25519, FrostDkgSecp256k1} from '@stars-labs/core-wasm';
import {keyShareCoreFromEngine} from '../../src/utils/engineKeystore';

/** Real 2-of-N FROST share fixture; initialize WASM before calling. */
export function frostShare(curve: 'ed25519' | 'secp256k1', participants: string[], index = 1) {
    const peers = [...participants].sort();
    const parts = peers.map((_, i) => {
        const p = curve === 'ed25519' ? new FrostDkgEd25519() : new FrostDkgSecp256k1();
        p.init_dkg(i + 1, peers.length, 2);
        return p;
    });
    try {
        const r1 = parts.map(p => p.generate_round1());
        parts.forEach((p, i) => r1.forEach((pkg, j) => { if (i !== j) p.add_round1_package(j + 1, pkg); }));
        const r2 = parts.map(p => {
            const raw = p.generate_round2();
            return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'hex').toString());
        });
        parts.forEach((p, i) => r2.forEach((map, j) => { if (i !== j) p.add_round2_package(j + 1, map[String(i + 1)]); }));
        parts.forEach(p => p.finalize_dkg());
        const p = parts[index - 1];
        return {
            ...keyShareCoreFromEngine(p.export_keystore(), p.get_group_public_key(), Object.fromEntries(peers.map((id, i) => [id,i+1]))),
            device_id: peers[index - 1], session_id:'dkg_fixture', blockchains:[], created_at:Date.now(),
        };
    } finally { parts.forEach(p => p.free()); }
}
