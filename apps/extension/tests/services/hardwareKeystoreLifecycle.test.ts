/** Real WebCrypto persistence/lifecycle audit. PRF bytes here are fixtures;
 * actual WebAuthn PRF is independently exercised by prf-extension-browser.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ECDSA_WALLET } from '../helpers/ecdsaFixture';
import { REAL_WEBCRYPTO, mockCrypto } from '../setup-bun';
import { resetWxtStorageData } from '../wxt-imports-mock';
import { KeystoreService } from '../../src/services/keystoreService';
import { encodeBytes, getHardwareVault, HARDWARE_VAULT_KEY, type HardwareAssertion } from '../../src/services/hardwareVault';
import type { KeyShareData, ExtensionWalletMetadata } from '@stars-labs/types/keystore';
const realModule = '../../src/services/keystoreManager.ts?hardwareLifecycleAudit';
const { KeystoreManager } = await import(realModule) as typeof import('../../src/services/keystoreManager');
const random = () => encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
const auth = (): HardwareAssertion => ({credentialId:random(),prfSalt:random(),prfOutput:random()});
const share: KeyShareData = {key_package:'public-fixture-FROST-secret',public_key_package:'fixture-public-package',group_public_key:'fixture-group',session_id:'fixture-wallet',device_id:'fixture-device',participant_index:1,threshold:2,total_participants:3,participants:['fixture-device','b','c'],participant_identifiers:{'fixture-device':1,b:2,c:3},curve:'secp256k1',blockchains:[],created_at:1};
share.frost_group_public_keys={ed25519:'fixture-ed-group',secp256k1:share.group_public_key};
share.ecdsa_group_public_key=ECDSA_WALLET.group_public_key;
async function stage(manager: ReturnType<typeof KeystoreManager.getInstance>) {
 await manager.setCurveShare(share.session_id,'ed25519',JSON.stringify({...share,curve:'ed25519',group_public_key:share.frost_group_public_keys!.ed25519}));
 await manager.setCurveShare(share.session_id,'secp256k1-ecdsa',ECDSA_WALLET.shares[0]!);
}
const metadata = {id:'fixture-wallet',name:'Lifecycle fixture',curve:'secp256k1',blockchain:'bitcoin',address:'fixture-address',groupPublicKey:'fixture-group',createdAt:1,isActive:true,threshold:2,totalParticipants:3} as unknown as ExtensionWalletMetadata;
let wxtData:Record<string,unknown>;
let sessionData:Record<string,unknown>;
let previousSession:typeof chrome.storage.session;
function freshManager() {
 const previous=(KeystoreManager as any).instance;
 if(previous?.lockTimer)clearTimeout(previous.lockTimer);
 (KeystoreManager as any).instance=null;
 KeystoreService.resetInstance();
 // The production loader must actually read the persisted index on restart.
 (KeystoreService as any).testMode=false;
 return KeystoreManager.getInstance();
}
describe('hardware keystore real-crypto restart and lock boundary',()=>{
 beforeEach(async()=>{
  (globalThis as any).crypto=REAL_WEBCRYPTO;
  previousSession=chrome.storage.session;
  await chrome.storage.local.clear();wxtData={};sessionData={};
  resetWxtStorageData(()=>wxtData);
  (chrome.storage as any).session={get:async()=>structuredClone(sessionData),set:async(items:Record<string,unknown>)=>{Object.assign(sessionData,structuredClone(items));},remove:async(keys:string|string[])=>{for(const k of typeof keys==='string'?[keys]:keys)delete sessionData[k];}};
  freshManager();
 });
 afterEach(()=>{
  KeystoreManager.getInstance().lock();KeystoreService.resetInstance();
  (KeystoreManager as any).instance=null;
  (chrome.storage as any).session=previousSession;
  resetWxtStorageData();(globalThis as any).crypto=mockCrypto;
 });
 it('persists encrypted FROST/ECDSA/prime data, restarts locked, and restores only with the correct hardware assertion',async()=>{
  const assertion=auth();let manager=KeystoreManager.getInstance();
  await manager.createHardwareKeystore(assertion,'fixture-device');
  expect(manager.isLocked()).toBe(false);
  await stage(manager);expect(await manager.addWallet(share.session_id,share,metadata)).toBe(true);
  const ecdsa=ECDSA_WALLET.shares[0]!,primes='public-fixture-unused-primes';
  await manager.setCurveShare(share.session_id,'secp256k1-ecdsa',ecdsa);
  const cached=await manager.encryptSecret('prime-fixture',primes);
  await chrome.storage.local.set({primeFixture:cached});
  const master=(KeystoreService.getInstance() as any).password as string;
  expect(typeof master).toBe('string');
  const persisted=JSON.stringify({local:await chrome.storage.local.get(null),wxt:wxtData,session:sessionData});
  for(const secret of [master,assertion.prfOutput,share.key_package,ecdsa,primes])expect(persisted.includes(secret)).toBe(false);
  expect((await chrome.storage.local.get('keystorePasswordHash')).keystorePasswordHash).toBeUndefined();
  manager.lock();expect(manager.isLocked()).toBe(true);expect(manager.hasRecentHardwareVerification()).toBe(false);
  manager=freshManager();await manager.initialize('fixture-device');
  expect((await manager.getAuthStatus()).mode).toBe('hardware');expect(manager.isLocked()).toBe(true);
  expect(await manager.getKeyShare(share.session_id)).toBeNull();
  await expect(manager.unlockHardwareKeystore({...assertion,prfOutput:random()})).rejects.toThrow();
  expect(manager.isLocked()).toBe(true);expect(manager.hasRecentHardwareVerification()).toBe(false);
  await manager.unlockHardwareKeystore(assertion);
  expect(manager.isLocked()).toBe(false);expect(manager.hasRecentHardwareVerification()).toBe(true);
  expect((await manager.getKeyShare(share.session_id))?.key_package===share.key_package).toBe(true);
  expect(await manager.getCurveShare(share.session_id,'secp256k1-ecdsa')===ecdsa).toBe(true);
  expect(await manager.decryptSecret(cached)===primes).toBe(true);
 });
 it('does not trust a stored unlocked session after a service-worker-style restart',async()=>{
  const assertion=auth();let manager=KeystoreManager.getInstance();await manager.createHardwareKeystore(assertion,'fixture-device');
  expect(manager.isLocked()).toBe(false);
  // Drop instances without calling lock, preserving the prior unlocked session.
  manager=freshManager();await manager.initialize('fixture-device');
  expect((await manager.getAuthStatus()).mode).toBe('hardware');expect(manager.isLocked()).toBe(true);
  expect(manager.hasRecentHardwareVerification()).toBe(false);
 });
 it('refuses password fallback or re-enrollment over a configured hardware vault',async()=>{
  const assertion=auth(),manager=KeystoreManager.getInstance();await manager.createHardwareKeystore(assertion,'fixture-device');manager.lock();
  const before=JSON.stringify(await chrome.storage.local.get(HARDWARE_VAULT_KEY));
  expect(await manager.unlock('guess')).toBe(false);
  expect(await manager.createKeystore('replacement-password','fixture-device')).toBe(false);
  await expect(manager.createHardwareKeystore(auth(),'fixture-device')).rejects.toThrow();
  expect(JSON.stringify(await chrome.storage.local.get(HARDWARE_VAULT_KEY))===before).toBe(true);
  expect(manager.isLocked()).toBe(true);
 });
 it('rejects a correct hardware assertion when the stored wallet share is missing',async()=>{
  const assertion=auth(),manager=KeystoreManager.getInstance();await manager.createHardwareKeystore(assertion,'fixture-device');
  await stage(manager);expect(await manager.addWallet(share.session_id,share,metadata)).toBe(true);
  delete wxtData[`local:mpc_keystore_share_${share.session_id}`];
  await expect(manager.unlockHardwareKeystore(assertion)).rejects.toThrow();
  expect(manager.isLocked()).toBe(true);expect(manager.hasRecentHardwareVerification()).toBe(false);
  expect(await manager.getKeyShare(share.session_id)).toBeNull();
 });
 it('tampered persisted envelope cannot unlock or replace the existing vault',async()=>{
  const assertion=auth(),manager=KeystoreManager.getInstance();await manager.createHardwareKeystore(assertion,'fixture-device');
  const record=await getHardwareVault();if(!record)throw new Error('Fixture hardware vault missing');
  const tampered={...record,ciphertext:random()};await chrome.storage.local.set({[HARDWARE_VAULT_KEY]:tampered});
  await expect(manager.unlockHardwareKeystore(assertion)).rejects.toThrow();
  expect(manager.isLocked()).toBe(true);expect(manager.hasRecentHardwareVerification()).toBe(false);
  expect(JSON.stringify((await chrome.storage.local.get(HARDWARE_VAULT_KEY))[HARDWARE_VAULT_KEY])===JSON.stringify(tampered)).toBe(true);
 });
 it('lock wins over a pending hardware unwrap and real service decrypt',async()=>{
  const assertion=auth(),manager=KeystoreManager.getInstance();await manager.createHardwareKeystore(assertion,'fixture-device');
  await stage(manager);expect(await manager.addWallet(share.session_id,share,metadata)).toBe(true);manager.lock();
  const service=KeystoreService.getInstance(),original=service.unlock;
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
  service.unlock=async(password:string)=>{enter();await gate;return original.call(service,password);};
  const completion=manager.unlockHardwareKeystore(assertion).then(()=>({ok:true}),()=>({ok:false}));
  try {
   await entered;manager.lock();expect(manager.isLocked()).toBe(true);release();
   const outcome=await completion;
   expect(outcome.ok).toBe(false);expect(manager.isLocked()).toBe(true);
   expect(service.isLocked()).toBe(true);expect(manager.hasRecentHardwareVerification()).toBe(false);
   expect(await manager.getKeyShare(share.session_id)).toBeNull();
  }finally{release();await completion;service.unlock=original;}
 });
 it('concurrent password create cannot replace an in-flight hardware create',async()=>{
  const manager=KeystoreManager.getInstance(),assertion=auth(),service=KeystoreService.getInstance(),original=service.initialize;
  let enter!:()=>void,release!:()=>void,calls=0;
  const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
  service.initialize=async(device:string)=>{if(++calls===1){enter();await gate;}return original.call(service,device);};
  const hardware=manager.createHardwareKeystore(assertion,'fixture-device').then(()=>({ok:true}),()=>({ok:false}));
  try {
   await entered;const password=await manager.createKeystore('competing-password','fixture-device');release();const outcome=await hardware;
   expect(password).toBe(false);expect(outcome.ok).toBe(true);expect((await manager.getAuthStatus()).mode).toBe('hardware');
  }finally{release();await hardware;service.initialize=original;}
 });
 it('concurrent hardware create cannot replace an in-flight password create',async()=>{
  const manager=KeystoreManager.getInstance(),assertion=auth(),service=KeystoreService.getInstance(),original=service.unlock;
  let enter!:()=>void,release!:()=>void,calls=0;
  const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
  service.unlock=async(password:string)=>{if(++calls===1){enter();await gate;}return original.call(service,password);};
  const password=manager.createKeystore('initial-password','fixture-device');
  try {
   await entered;const hardware=await manager.createHardwareKeystore(assertion,'fixture-device').then(()=>({ok:true}),()=>({ok:false}));release();
   const outcome=await password;
   expect(hardware.ok).toBe(false);expect(outcome).toBe(true);expect((await manager.getAuthStatus()).mode).toBe('password');
  }finally{release();await password;service.unlock=original;}
 });
 it('requires a fresh hardware verification for export and clears freshness on failure',async()=>{
  const assertion=auth(),manager=KeystoreManager.getInstance();await manager.createHardwareKeystore(assertion,'fixture-device');
  manager.assertHardwareExportAuthorized();
  (manager as any).hardwareVerifiedAt=Date.now()-60_001;
  expect(()=>manager.assertHardwareExportAuthorized()).toThrow();
  await manager.unlockHardwareKeystore(assertion);manager.assertHardwareExportAuthorized();
  await expect(manager.unlockHardwareKeystore({...assertion,credentialId:random()})).rejects.toThrow();
  expect(()=>manager.assertHardwareExportAuthorized()).toThrow();expect(manager.isLocked()).toBe(true);
 });
});
