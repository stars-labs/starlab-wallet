import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { REAL_WEBCRYPTO, mockCrypto } from '../setup-bun';
import { resetStorageData } from '../__mocks__/imports';
import { resetWxtStorageData } from '../wxt-imports-mock';
import { KeystoreService } from '../../src/services/keystoreService';
import type { KeyShareData, ExtensionWalletMetadata } from '@stars-labs/types/keystore';

describe('portable backup into a distinct hardware vault encryption domain', () => {
    let data: Record<string, unknown>;
    beforeEach(() => {
        (globalThis as any).crypto = REAL_WEBCRYPTO;
        data = {}; resetStorageData(() => data); resetWxtStorageData(() => data);
        KeystoreService.resetInstance();
    });
    afterEach(() => { KeystoreService.resetInstance(); resetStorageData(); resetWxtStorageData(); (globalThis as any).crypto = mockCrypto; });
    it('authenticates source password and reencrypts under target secret, preserving share format', async () => {
        const share = { key_package: 'test-only secret share', group_public_key: 'public', session_id: 'wallet', device_id: 'device', participant_index: 1, threshold: 2, total_participants: 3, participants: ['device'], curve: 'ed25519', created_at: 1 } as KeyShareData;
        const metadata = { id: 'wallet', name: 'Test', blockchain: 'solana', address: 'public-address', session_id: 'wallet', isActive: true, hasBackup: false, createdAt: 1 } as ExtensionWalletMetadata;
        let service = KeystoreService.getInstance();
        await service.initialize('device'); await service.unlock('portable-source-password'); await service.addWallet('wallet', share, metadata);
        const backup = await service.exportWallet('wallet');
        KeystoreService.resetInstance(); data = {};
        service = KeystoreService.getInstance(); await service.initialize('device'); await service.unlock('random-internal-target-secret');
        await expect(service.importWallet(backup, 'wrong-source-password')).rejects.toThrow();
        expect(service.getWallets()).toHaveLength(0);
        await service.importWallet(backup, 'portable-source-password');
        expect(await service.getKeyShare('wallet')).toEqual(share);
        service.lock();
        expect(await service.unlock('portable-source-password')).toBe(false);
        expect(service.isLocked()).toBe(true);
        expect(await service.unlock('random-internal-target-secret')).toBe(true);
        expect(await service.getKeyShare('wallet')).toEqual(share);
        expect(JSON.stringify(data)).not.toContain('test-only secret share');
        expect(JSON.stringify(data)).not.toContain('random-internal-target-secret');
    });
});
