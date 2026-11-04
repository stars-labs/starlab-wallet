/** Canonical three-file backup decrypted and reencrypted into a hardware vault. */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import init, { ecdsa_share_info } from '@stars-labs/core-wasm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REAL_WEBCRYPTO, mockCrypto } from '../setup-bun';
import { resetStorageData } from '../__mocks__/imports';
import { resetWxtStorageData } from '../wxt-imports-mock';
import { KeystoreService } from '../../src/services/keystoreService';
import { encodeBytes, sealHardwareVault, openHardwareVault } from '../../src/services/hardwareVault';
import { openShareBackup, openEcdsaShareBackup, encryptShareBackup, encryptEcdsaShareBackup } from '../../src/utils/shareBackup';
import { ECDSA_WALLET } from '../helpers/ecdsaFixture';
import type { ExtensionWalletMetadata } from '@stars-labs/types/keystore';
beforeAll(async()=>{await init();});
describe('portable canonical backup into a distinct hardware vault encryption domain', () => {
    let data: Record<string, unknown>;
    beforeEach(() => {
        (globalThis as any).crypto = REAL_WEBCRYPTO;
        data = {}; resetStorageData(() => data); resetWxtStorageData(() => data);
        KeystoreService.resetInstance();
    });
    afterEach(() => { KeystoreService.resetInstance(); resetStorageData(); resetWxtStorageData(); (globalThis as any).crypto = mockCrypto; });
    it('authenticates the portable password and restores all three shares under the wrapped target secret', async () => {
        const file=(curve:string)=>readFileSync(join(import.meta.dir,`../fixtures/engine-share/engine-share-${curve}.json`),'utf8');
        const expected=JSON.parse(readFileSync(join(import.meta.dir,'../fixtures/engine-share/engine-share-secp256k1.expected.json'),'utf8'));
        const sourcePassword='portable-source-password';
        const [secp,ed]=await Promise.all(['secp256k1','ed25519'].map(curve=>openShareBackup(file(curve),expected.password)));
        const sourceFiles=await Promise.all([
            encryptShareBackup({...secp!.keyShare,blockchains:[],created_at:1},{id:'w-transfer'},sourcePassword),
            encryptShareBackup({...ed!.keyShare,blockchains:[],created_at:1},{id:'w-transfer'},sourcePassword),
            encryptEcdsaShareBackup(ECDSA_WALLET.shares[0]!,JSON.parse(ecdsa_share_info(ECDSA_WALLET.shares[0]!)),{id:'w-transfer',deviceId:'device-a'},sourcePassword),
        ]);
        const secret=encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
        const assertion={credentialId:encodeBytes(crypto.getRandomValues(new Uint8Array(32))),prfSalt:encodeBytes(crypto.getRandomValues(new Uint8Array(32))),prfOutput:encodeBytes(crypto.getRandomValues(new Uint8Array(32)))};
        const persistedEnvelope=JSON.stringify(await sealHardwareVault(assertion,secret));
        let service=KeystoreService.getInstance();await service.initialize('device-a');await service.unlock(secret);
        await expect(openShareBackup(sourceFiles[0]!, 'wrong-source-password')).rejects.toThrow();
        expect(service.getWallets()).toHaveLength(0);
        const primary={...(await openShareBackup(sourceFiles[0]!,sourcePassword)).keyShare,blockchains:[],created_at:1};
        const secondary={...(await openShareBackup(sourceFiles[1]!,sourcePassword)).keyShare,blockchains:[],created_at:1};
        const ecdsa=await openEcdsaShareBackup(sourceFiles[2]!,sourcePassword);
        const roots={ed25519:secondary.group_public_key,secp256k1:primary.group_public_key};
        const cohort={participants:ECDSA_WALLET.participants,threshold:2,total:3,participantIndex:1};
        Object.assign(primary,{frost_group_public_keys:roots,ecdsa_group_public_key:ECDSA_WALLET.group_public_key,ecdsa_cohort:cohort});
        Object.assign(secondary,{frost_group_public_keys:roots,ecdsa_group_public_key:ECDSA_WALLET.group_public_key,ecdsa_cohort:cohort});
        await service.setCurveShare('w-transfer','ed25519',JSON.stringify(secondary));
        await service.setCurveShare('w-transfer','secp256k1-ecdsa',ecdsa.shareJson);
        await service.addWallet('w-transfer',primary,{id:'w-transfer',name:'Restored',blockchain:'ethereum',address:'public',session_id:'w-transfer',isActive:true,hasBackup:true} as ExtensionWalletMetadata);
        service.lock();KeystoreService.resetInstance();(KeystoreService as any).testMode=false;
        service=KeystoreService.getInstance();await service.ready();
        expect(await service.unlock(sourcePassword)).toBe(false);expect(service.isLocked()).toBe(true);
        expect(await service.unlock(await openHardwareVault(JSON.parse(persistedEnvelope),assertion))).toBe(true);
        expect((await service.getKeyShare('w-transfer'))?.key_package).toBe(primary.key_package);
        expect(JSON.parse((await service.getCurveShare('w-transfer','ed25519'))!).key_package).toBe(secondary.key_package);
        expect(await service.getCurveShare('w-transfer','secp256k1-ecdsa')).toBe(ECDSA_WALLET.shares[0]!);
        const persisted=JSON.stringify(data)+persistedEnvelope;
        for(const plaintext of [secret,assertion.prfOutput,primary.key_package,secondary.key_package,ECDSA_WALLET.shares[0]!,JSON.parse(ECDSA_WALLET.shares[0]!).key_share.core.x])expect(persisted).not.toContain(plaintext);
    });
});
