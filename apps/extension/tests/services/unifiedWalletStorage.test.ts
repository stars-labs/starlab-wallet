/** Real encryption at lock/storage boundaries; all shares are generated test material. */
import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'bun:test';
import init, { FrostDkgEd25519, FrostDkgSecp256k1, FrostReshareEd25519, FrostReshareSecp256k1 } from '@stars-labs/core-wasm';
import { REAL_WEBCRYPTO, mockCrypto } from '../setup-bun';
import { storage } from '../wxt-imports-mock';
import { frostShare } from '../helpers/frostShare';
import { ECDSA_WALLET } from '../helpers/ecdsaFixture';
import { keyShareCoreFromEngine } from '../../src/utils/engineKeystore';
import type { KeyShareData, ExtensionWalletMetadata } from '@stars-labs/types/keystore';
const isolated = '../../src/services/keystoreService.ts?unifiedStorageAudit';
const { KeystoreService } = await import(isolated) as typeof import('../../src/services/keystoreService');
const WALLET = 'unified-storage', PASSWORD = 'test-only-random-vault-secret';
const COHORT = ['device-a','device-b','device-c'];
const INDEX = 'local:mpc_keystore_index', PRIMARY = `local:mpc_keystore_share_${WALLET}`;
const ED = `${PRIMARY}__ed25519`, ECDSA = `${PRIMARY}__secp256k1-ecdsa`;
const originalGet = storage.getItem.getMockImplementation(), originalSet = storage.setItem.getMockImplementation();
let data: Record<string, any>, primary: KeyShareData, secondary: KeyShareData;
let secpPair: {before:KeyShareData;after:KeyShareData}, edPair: {before:KeyShareData;after:KeyShareData};
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => {resolve = r;}); return {promise,resolve}; }
function metadata(): ExtensionWalletMetadata { return {id:WALLET,name:'Fixture',session_id:WALLET,blockchain:'ethereum',address:'public-address',isActive:true,hasBackup:false} as ExtensionWalletMetadata; }
async function fresh() {
    KeystoreService.resetInstance(); (KeystoreService as any).testMode = false;
    const service = KeystoreService.getInstance(); await service.ready(); await service.initialize('device-a'); return service;
}
async function unlocked() { const service = await fresh(); expect(await service.unlock(PASSWORD)).toBe(true); return service; }
async function stageAlgorithms(service: ReturnType<typeof KeystoreService.getInstance>) {
    await service.setCurveShare(WALLET,'ed25519',JSON.stringify(secondary));
    await service.setCurveShare(WALLET,'secp256k1-ecdsa',ECDSA_WALLET.shares[0]!);
}
function assertLockedEmpty(service: ReturnType<typeof KeystoreService.getInstance>) {
    expect(service.isLocked()).toBe(true);
    expect((service as any).keyShares.size).toBe(0); expect((service as any).curveShares.size).toBe(0);
}
function pauseEncryption(operation: 'encrypt' | 'decrypt' = 'encrypt') {
    const entered = deferred(), release = deferred();
    const subtle = new Proxy(REAL_WEBCRYPTO.subtle, { get(target, key) {
        if (key === operation) return async (...args: Parameters<SubtleCrypto['encrypt']>) => {
            const result = await target[operation](...args); entered.resolve(); await release.promise; return result;
        };
        const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    (globalThis as any).crypto = {subtle,getRandomValues:REAL_WEBCRYPTO.getRandomValues.bind(REAL_WEBCRYPTO)};
    return {entered,release};
}
function pauseStorage(keyToPause: string) {
    const entered = deferred(), release = deferred();
    storage.setItem.mockImplementation(async (key, value) => {
        if (key === keyToPause) {entered.resolve(); await release.promise;}
        data[key] = structuredClone(value);
    });
    return {entered,release};
}

/** A genuine share refresh changes secret bytes, retains public group and old IDs. */
function refreshed(curve: 'ed25519' | 'secp256k1'): {before:KeyShareData;after:KeyShareData} {
    const parts = [1,2,3].map(id => {const p = curve==='ed25519' ? new FrostDkgEd25519() : new FrostDkgSecp256k1();p.init_dkg(id,3,2);return p;});
    const refresh = [1,3].map(() => curve==='ed25519' ? new FrostReshareEd25519() : new FrostReshareSecp256k1());
    try {
        const r1=parts.map(p=>p.generate_round1());parts.forEach((p,i)=>r1.forEach((r,j)=>{if(i!==j)p.add_round1_package(j+1,r);}));
        const r2=parts.map(p=>JSON.parse(Buffer.from(p.generate_round2(),'hex').toString()));parts.forEach((p,i)=>r2.forEach((r,j)=>{if(i!==j)p.add_round2_package(j+1,r[i+1]);}));
        const stores=parts.map(p=>p.finalize_dkg()),group=parts[0]!.get_group_public_key(),ids=[1,3];
        refresh.forEach((p,i)=>p.init_reshare(stores[ids[i]!-1]!,'1,3',2));
        const a=refresh.map(p=>p.reshare_round1());refresh.forEach((p,i)=>a.forEach((r,j)=>{if(i!==j)p.add_reshare_round1(ids[j]!,r);}));
        const b=refresh.map(p=>JSON.parse(p.reshare_round2()));refresh.forEach((p,i)=>b.forEach((r,j)=>{if(i!==j)p.add_reshare_round2(ids[j]!,r[ids[i]!]);}));
        return {before:{...keyShareCoreFromEngine(stores[0]!,group,{'device-a':1,'device-b':2,'device-c':3}),session_id:WALLET,device_id:'device-a',blockchains:[],created_at:1},after:{...keyShareCoreFromEngine(refresh[0]!.finalize_reshare(),group,{'device-a':1,'device-c':3}),session_id:WALLET,device_id:'device-a',blockchains:[],created_at:1}};
    } finally {parts.forEach(p=>p.free());refresh.forEach(p=>p.free());}
}
beforeAll(async()=>{(globalThis as any).crypto=REAL_WEBCRYPTO;await init();secpPair=refreshed('secp256k1');edPair=refreshed('ed25519');});
beforeEach(()=>{
    (globalThis as any).crypto=REAL_WEBCRYPTO;data={};
    storage.getItem.mockImplementation(async key=>structuredClone(data[key]??null));
    storage.setItem.mockImplementation(async(key,value)=>{data[key]=structuredClone(value);});
    primary=structuredClone(secpPair.before);
    secondary=structuredClone(edPair.before);
    const roots={ed25519:secondary.group_public_key,secp256k1:primary.group_public_key};
    primary.frost_group_public_keys=roots;secondary.frost_group_public_keys=roots;
    primary.ecdsa_group_public_key=ECDSA_WALLET.group_public_key;secondary.ecdsa_group_public_key=ECDSA_WALLET.group_public_key;
    primary.ecdsa_cohort={participants:[...COHORT],threshold:2,total:3,participantIndex:1};secondary.ecdsa_cohort=primary.ecdsa_cohort;
});
afterEach(()=>{KeystoreService.resetInstance();storage.getItem.mockImplementation(originalGet!);storage.setItem.mockImplementation(originalSet!);(globalThis as any).crypto=mockCrypto;});
describe('unified wallet storage real-crypto boundaries',()=>{
    for (const phase of ['crypto','storage'] as const) {
        it(`lock during primary ${phase} cannot refill plaintext or publish a wallet`,async()=>{
            const service=await unlocked();await stageAlgorithms(service);
            const gate=phase==='crypto'?pauseEncryption():pauseStorage(PRIMARY);
            const save=service.addWallet(WALLET,primary,metadata());
            await gate.entered.promise;service.lock();gate.release.resolve();await expect(save).rejects.toThrow();
            assertLockedEmpty(service);expect(data[INDEX].wallets).toHaveLength(0);
        });
        it(`lock during secondary ${phase} cannot refill the curve cache`,async()=>{
            const service=await unlocked();const gate=phase==='crypto'?pauseEncryption():pauseStorage(ED);
            const save=service.setCurveShare(WALLET,'ed25519',JSON.stringify(secondary));
            await gate.entered.promise;service.lock();gate.release.resolve();await expect(save).rejects.toThrow();
            assertLockedEmpty(service);expect(data[INDEX].wallets).toHaveLength(0);
        });
    }
    it('does not publish a root wallet until both encrypted algorithm shares exist',async()=>{
        const service=await unlocked();
        await expect(service.addWallet(WALLET,primary,metadata())).rejects.toThrow();
        expect(data[INDEX].wallets).toHaveLength(0);
    });
    it('duplicate root ID cannot overwrite ciphertext or duplicate the index',async()=>{
        const service=await unlocked();await stageAlgorithms(service);await service.addWallet(WALLET,primary,metadata());
        const before=structuredClone(data[PRIMARY]);
        const different={...primary,...frostShare('secp256k1',COHORT)};
        await expect(service.addWallet(WALLET,different,metadata())).rejects.toThrow();
        expect(data[INDEX].wallets).toHaveLength(1);expect(data[PRIMARY]).toEqual(before);
    });
    it('concurrent duplicate IDs publish exactly one complete root with its own ciphertext',async()=>{
        let service=await unlocked();await stageAlgorithms(service);
        const candidates=[primary,{...primary,...secpPair.after}];
        const results=await Promise.allSettled(candidates.map(share=>service.addWallet(WALLET,share,metadata())));
        expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
        expect(data[INDEX].wallets).toHaveLength(1);
        const winner=results.findIndex(result=>result.status==='fulfilled');
        service.lock();service=await fresh();expect(await service.unlock(PASSWORD)).toBe(true);
        expect((await service.getKeyShare(WALLET))?.key_package).toBe(candidates[winner]!.key_package);
    });

    it('primary refresh cannot refill plaintext after lock during encryption',async()=>{
        const service=await unlocked();await stageAlgorithms(service);await service.addWallet(WALLET,primary,metadata());
        const gate=pauseEncryption(),save=service.updateWalletKeyShare(WALLET,primary);
        await gate.entered.promise;service.lock();gate.release.resolve();const result=await save.then(()=>null,error=>error);assertLockedEmpty(service);expect(result).toBeInstanceOf(Error);
    });
    for(const curve of ['primary','ed25519'] as const) {
        it(`lock during ${curve} decrypt cannot return or recache plaintext`,async()=>{
            const service=await unlocked();await stageAlgorithms(service);await service.addWallet(WALLET,primary,metadata());
            (service as any).keyShares.clear();(service as any).curveShares.clear();
            const gate=pauseEncryption('decrypt');
            const read=curve==='primary'?service.getKeyShare(WALLET):service.getCurveShare(WALLET,'ed25519');
            await gate.entered.promise;service.lock();gate.release.resolve();
            const result=await read.catch(()=>null);
            assertLockedEmpty(service);expect(result===null).toBe(true);
        });
    }

    it('lock while decrypting the unused-prime cache prevents returning its plaintext',async()=>{
        const service=await unlocked();const ciphertext=await service.encryptSecret('unused-prime-cache','test-only-prime-material');
        const gate=pauseEncryption('decrypt'),read=service.decryptSecret(ciphertext);
        await gate.entered.promise;service.lock();gate.release.resolve();
        await expect(read).rejects.toThrow();assertLockedEmpty(service);
    });

    it('primary and secondary updates preserve the other curve and ECDSA through lock and restart',async()=>{
        let service=await unlocked();await stageAlgorithms(service);await service.addWallet(WALLET,primary,metadata());
        const edBefore=structuredClone(data[ED]),ecdsaBefore=structuredClone(data[ECDSA]);
        // Fresh real curve material exercises independent encrypted entries;
        // both new shares themselves came from genuine retained-ID refreshes.
        const secp={...primary,...secpPair.after};await service.updateWalletKeyShare(WALLET,secp);
        expect(secp.group_public_key).toBe(primary.group_public_key);
        expect(secp.key_package).not.toBe(primary.key_package);
        expect(data[ED]).toEqual(edBefore);expect(data[ECDSA]).toEqual(ecdsaBefore);
        const primaryAfter=structuredClone(data[PRIMARY]),ed={...secondary,...edPair.after};
        await service.updateWalletKeyShare(WALLET,ed);
        expect(ed.group_public_key).toBe(secondary.group_public_key);expect(ed.key_package).not.toBe(secondary.key_package);
        expect(data[PRIMARY]).toEqual(primaryAfter);expect(data[ECDSA]).toEqual(ecdsaBefore);
        service.lock();service=await fresh();expect(service.isLocked()).toBe(true);expect(await service.unlock(PASSWORD)).toBe(true);
        const restored=await service.getKeyShare(WALLET);
        expect(restored?.key_package).toBe(secp.key_package);
        expect(restored?.participants).toEqual(['device-a','device-c']);
        expect(restored?.ecdsa_cohort?.participants).toEqual(COHORT);
        expect(restored?.ecdsa_cohort?.total).toBe(3);
        expect(JSON.parse((await service.getCurveShare(WALLET,'ed25519'))!).key_package).toBe(ed.key_package);
        expect(await service.getCurveShare(WALLET,'secp256k1-ecdsa')).toBe(ECDSA_WALLET.shares[0]!);
        const persisted=JSON.stringify(data);
        for(const secret of [PASSWORD,secp.key_package,ed.key_package,ECDSA_WALLET.shares[0]!,JSON.parse(ECDSA_WALLET.shares[0]!).key_share.core.x])expect(persisted).not.toContain(secret);
    });
});
