/** Unified inventory persistence uses real crypto and structured-clone storage semantics. */
import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'bun:test';
import init, { derive_account_addresses } from '@stars-labs/core-wasm';
import { REAL_WEBCRYPTO } from '../setup-bun';
import { storage as wxtStorage } from '../wxt-imports-mock';
import { storage as aliasStorage } from '../__mocks__/imports';
import { KeystoreService } from '../../src/services/keystoreService';
import { frostShare } from '../helpers/frostShare';
import { ECDSA_WALLET } from '../helpers/ecdsaFixture';
import { normalizeDerivedAddressChain } from '@stars-labs/types/appstate';
const modulePath='../../src/services/keystoreManager.ts?unified-persistence';
const {KeystoreManager}=await import(modulePath) as typeof import('../../src/services/keystoreManager');
const PASSWORD='test-only-persistence-password',PEERS=['device-a','device-b','device-c'];
let savedCrypto: Crypto,savedChrome: typeof chrome,wxtData:Record<string,unknown>;
const stores=[...new Set([wxtStorage,aliasStorage])];
let originals:Array<{get:any;set:any;remove:any}>;
function area() {
    const data:Record<string,unknown>={};
    return {data,get:async(keys?:string|string[]|null)=>keys==null?structuredClone(data):Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(data[key])])),set:async(items:Record<string,unknown>)=>{Object.assign(data,structuredClone(items));},remove:async(keys:string|string[])=>{for(const key of Array.isArray(keys)?keys:[keys])delete data[key];}};
}
function freshManager() {
    const previous=(KeystoreManager as any).instance;if(previous)previous.lock();
    (KeystoreManager as any).instance=null;KeystoreService.resetInstance();(KeystoreService as any).testMode=false;
    return KeystoreManager.getInstance();
}
async function addUnified(manager: ReturnType<typeof KeystoreManager.getInstance>, id:string, display:'ethereum'|'solana',active:boolean) {
    const primary={...frostShare('secp256k1',PEERS,2),session_id:id};
    const ed={...frostShare('ed25519',PEERS,2),session_id:id};
    const roots={ed25519:ed.group_public_key,secp256k1:primary.group_public_key};
    const addresses=[...JSON.parse(derive_account_addresses('secp256k1',roots.secp256k1,0)),...JSON.parse(derive_account_addresses('ed25519',roots.ed25519,0)),...JSON.parse(derive_account_addresses('secp256k1-ecdsa',ECDSA_WALLET.group_public_key,0))].map((entry:any)=>({blockchain:normalizeDerivedAddressChain(entry.chain)!,address:entry.address,derivationPath:entry.path}));
    const common={frost_group_public_keys:roots,ecdsa_group_public_key:ECDSA_WALLET.group_public_key,ecdsa_cohort:{participants:PEERS,threshold:2,total:3,participantIndex:2},blockchains:addresses};
    Object.assign(primary,common);Object.assign(ed,common);
    await manager.setCurveShare(id,'ed25519',JSON.stringify(ed));await manager.setCurveShare(id,'secp256k1-ecdsa',ECDSA_WALLET.shares[1]!);
    expect(await manager.addWallet(id,primary,{id,name:id,blockchain:display,address:addresses.find(entry=>entry.blockchain===display)!.address,session_id:id,isActive:active,hasBackup:true})).toBe(true);
    return {primary,ed};
}
beforeAll(async()=>{await init();});
beforeEach(()=>{
    savedCrypto=globalThis.crypto;savedChrome=globalThis.chrome;(globalThis as any).crypto=REAL_WEBCRYPTO;
    (globalThis as any).chrome={...savedChrome,storage:{local:area(),session:area()}};
    wxtData={};originals=stores.map(store=>({get:store.getItem.getMockImplementation(),set:store.setItem.getMockImplementation(),remove:store.removeItem.getMockImplementation()}));
    for(const store of stores){store.getItem.mockImplementation(async(key:string)=>structuredClone(wxtData[key]??null));store.setItem.mockImplementation(async(key:string,value:unknown)=>{wxtData[key]=structuredClone(value);});store.removeItem.mockImplementation(async(key:string)=>{delete wxtData[key];});}
    freshManager();
});
afterEach(()=>{
    const manager=(KeystoreManager as any).instance;if(manager)manager.lock();(KeystoreManager as any).instance=null;KeystoreService.resetInstance();
    stores.forEach((store,i)=>{store.getItem.mockImplementation(originals[i]!.get);store.setItem.mockImplementation(originals[i]!.set);store.removeItem.mockImplementation(originals[i]!.remove);});
    (globalThis as any).crypto=savedCrypto;(globalThis as any).chrome=savedChrome;
});
describe('unified wallet persistence integration',()=>{
    it('cold restart decrypts every algorithm from the persisted inventory, never a cached object',async()=>{
        let manager=KeystoreManager.getInstance();await manager.initialize('device-b');expect(await manager.createKeystore(PASSWORD,'device-b')).toBe(true);
        const shares=await addUnified(manager,'wallet-one','ethereum',true);
        manager=freshManager();await manager.initialize('device-b');expect(await manager.isInitialized()).toBe(true);expect(manager.isLocked()).toBe(true);
        expect(await manager.unlock(PASSWORD)).toBe(true);expect(manager.getWallets()).toHaveLength(1);
        expect((await manager.getKeyShare('wallet-one','secp256k1'))?.key_package).toBe(shares.primary.key_package);
        expect((await manager.getKeyShare('wallet-one','ed25519'))?.key_package).toBe(shares.ed.key_package);
        expect(await manager.getCurveShare('wallet-one','secp256k1-ecdsa')).toBe(ECDSA_WALLET.shares[1]!);
        const persisted=JSON.stringify({wxtData,local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)});
        for(const secret of [PASSWORD,shares.primary.key_package,shares.ed.key_package,JSON.parse(ECDSA_WALLET.shares[1]!).key_share.core.x])expect(persisted).not.toContain(secret);
    });
    it('switches complete wallets and retains the selected identity after a real service reload',async()=>{
        let manager=KeystoreManager.getInstance();await manager.initialize('device-b');expect(await manager.createKeystore(PASSWORD,'device-b')).toBe(true);
        await addUnified(manager,'ethereum-primary','ethereum',true);const second=await addUnified(manager,'solana-primary','solana',false);
        expect(manager.getActiveWallet()?.id).toBe('ethereum-primary');expect(await manager.switchWallet('solana-primary')).toBe(true);expect(manager.getActiveWallet()?.id).toBe('solana-primary');
        manager=freshManager();await manager.initialize('device-b');expect(await manager.unlock(PASSWORD)).toBe(true);
        expect(manager.getActiveWallet()?.id).toBe('solana-primary');expect(manager.getWallets()).toHaveLength(2);
        expect((await manager.getKeyShare('solana-primary','ed25519'))?.key_package).toBe(second.ed.key_package);
    });
});
