/** Actual extension-origin WebAuthn + WebCrypto capability probe.
 * Uses an isolated MV3 fixture bundling the production helpers, not a user
 * browser or mocked credentials. CDP virtual hardware is not a physical key.
 * Run with Bun; DISPLAY must point to a dedicated test X server when headed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '../..');
const output = path.resolve(process.env.PRF_TEST_OUTPUT || '/tmp/starlab-prf-extension-browser');
await fs.mkdir(output, {recursive:true});
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'starlab-prf-isolated-'));
const ext = path.join(scratch, 'extension');
await fs.mkdir(ext);
const importPath = process.env.PLAYWRIGHT_MODULE || '@playwright/test';
const { chromium } = await import(importPath);
const entry = path.join(scratch, 'entry.ts');
await fs.writeFile(entry, `import * as auth from ${JSON.stringify(path.join(extensionRoot,'src/services/hardwareWebAuthn.ts'))};\nimport * as vault from ${JSON.stringify(path.join(extensionRoot,'src/services/hardwareVault.ts'))};\nObject.assign(globalThis,{prfApi:{...auth,...vault}});`);
const build = await Bun.build({entrypoints:[entry],outdir:ext,target:'browser',format:'esm',naming:'entry.js'});
assert(build.success, 'production helper bundle failed');
await fs.writeFile(path.join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'Starlab isolated PRF test',version:'0.0.1',permissions:['storage'],background:{service_worker:'background.js'}}));
await fs.writeFile(path.join(ext,'background.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
await fs.writeFile(path.join(ext,'probe.html'),'<html><body>Isolated WebAuthn PRF test<script type="module" src="entry.js"></script></body></html>');
const options={headless:false,executablePath:process.env.PLAYWRIGHT_CHROME_PATH,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--no-sandbox','--no-first-run']};
let context;
const result={scope:'CDP virtual authenticator, production WebAuthn/HKDF/AES-GCM helpers, isolated extension origin; physical YubiKey unverified',checks:{}};
try {
 context=await chromium.launchPersistentContext(path.join(scratch,'profile'),options);
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const id=new URL(worker.url()).hostname;
 const page=await context.newPage();
 await page.goto(`chrome-extension://${id}/probe.html`);
 await page.waitForFunction(()=>!!globalThis.prfApi);
 await page.bringToFront();
 const cdp=await context.newCDPSession(page);
 await cdp.send('WebAuthn.enable',{enableUI:false});
 const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'usb',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,hasPrf:true,automaticPresenceSimulation:true}});
 result.browser=await context.browser().version();result.origin=await page.evaluate(()=>location.origin);
 assert.match(result.origin,/^chrome-extension:\/\/[a-p]{32}$/);
 result.checks.enrollment=await page.evaluate(async()=>{
  const api=globalThis.prfApi;
  const auth=await api.createHardwareCredential();
  const secret=api.encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
  const record=await api.sealHardwareVault(auth,secret);
  const second=await api.getHardwareAssertion(record);
  const opened=await api.openHardwareVault(record,second);
  const key=await crypto.subtle.importKey('raw',api.decodeBytes(secret),{name:'AES-GCM'},false,['encrypt']);
  const testIv=crypto.getRandomValues(new Uint8Array(12));
  const testCipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:testIv},key,new TextEncoder().encode('public restart fixture'));
  const persisted=JSON.stringify(record);
  await chrome.storage.local.set({[api.HARDWARE_VAULT_KEY]:record,testPayload:{iv:api.encodeBytes(testIv),cipher:api.encodeBytes(new Uint8Array(testCipher))}});
  globalThis.testMemory={auth,secret};
  return {secure:isSecureContext,prfBytes:api.decodeBytes(auth.prfOutput).length,stablePrf:auth.prfOutput===second.prfOutput,roundtrip:opened===secret,noSecretStored:!persisted.includes(secret)&&!persisted.includes(auth.prfOutput),recordKeys:Object.keys(record).sort()};
 });
 assert.equal(result.checks.enrollment.prfBytes,32);assert(result.checks.enrollment.stablePrf&&result.checks.enrollment.roundtrip&&result.checks.enrollment.noSecretStored);
 const {credentials}=await cdp.send('WebAuthn.getCredentials',{authenticatorId});
 result.defaultRpId=credentials[0].rpId;
 assert.equal(result.defaultRpId,result.origin);
 result.checks.tamper=await page.evaluate(async()=>{
  const api=globalThis.prfApi,record=await api.getHardwareVault(),auth=globalThis.testMemory.auth;
  const bad={...auth,credentialId:api.encodeBytes(crypto.getRandomValues(new Uint8Array(32)))};
  let wrong=false,tamper=false;
  try{await api.openHardwareVault(record,bad)}catch{wrong=true}
  try{await api.openHardwareVault({...record,ciphertext:api.encodeBytes(crypto.getRandomValues(new Uint8Array(48)))},auth)}catch{tamper=true}
  return {wrongCredentialRejected:wrong,tamperedCiphertextRejected:tamper};
 });
 assert(result.checks.tamper.wrongCredentialRejected&&result.checks.tamper.tamperedCiphertextRejected);
 await cdp.send('WebAuthn.setAutomaticPresenceSimulation',{authenticatorId,enabled:false});
 result.checks.cancel=await page.evaluate(async()=>{
  const api=globalThis.prfApi,record=await api.getHardwareVault(),before=JSON.stringify(record),controller=new AbortController();
  setTimeout(()=>controller.abort(),150);
  let error='';try{await api.getHardwareAssertion(record,controller.signal)}catch(e){error=e.name}
  return {aborted:error==='AbortError',recordUnchanged:JSON.stringify(await api.getHardwareVault())===before};
 });
 assert(result.checks.cancel.aborted&&result.checks.cancel.recordUnchanged);
 await cdp.send('WebAuthn.setAutomaticPresenceSimulation',{authenticatorId,enabled:true});
 await page.reload();await page.waitForFunction(()=>!!globalThis.prfApi);
 result.checks.pageRestart=await page.evaluate(async()=>{
  const api=globalThis.prfApi,record=await api.getHardwareVault(),auth=await api.getHardwareAssertion(record),secret=await api.openHardwareVault(record,auth);
  const payload=(await chrome.storage.local.get('testPayload')).testPayload;
  const key=await crypto.subtle.importKey('raw',api.decodeBytes(secret),{name:'AES-GCM'},false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:api.decodeBytes(payload.iv)},key,api.decodeBytes(payload.cipher));
  return {memoryGone:globalThis.testMemory===undefined,restored:new TextDecoder().decode(plain)==='public restart fixture'};
 });
 assert(result.checks.pageRestart.memoryGone&&result.checks.pageRestart.restored);
 // An authenticator without PRF must not silently become a password vault.
 await cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId});
 const {authenticatorId:wrongAuthenticator}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'usb',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,hasPrf:true,automaticPresenceSimulation:true}});
 result.checks.wrongAuthenticator=await page.evaluate(async()=>{
  const api=globalThis.prfApi,record=await api.getHardwareVault(),before=JSON.stringify(record),controller=new AbortController();
  setTimeout(()=>controller.abort(),200);
  let rejected=false;try{await api.getHardwareAssertion(record,controller.signal)}catch{rejected=true}
  return {noCredentialReturned:rejected,recordUnchanged:JSON.stringify(await api.getHardwareVault())===before};
 });
 assert(result.checks.wrongAuthenticator.noCredentialReturned&&result.checks.wrongAuthenticator.recordUnchanged);
 await cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId:wrongAuthenticator});
 await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'usb',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,hasPrf:false,automaticPresenceSimulation:true}});
 result.checks.unsupported=await page.evaluate(async()=>{
  try{await globalThis.prfApi.createHardwareCredential();return false}catch(e){return /PRF/.test(e.message)}
 });
 assert(result.checks.unsupported,'non-PRF key must fail closed');
 result.passed=true;
 await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
} finally {
 await context?.close();
 await fs.rm(scratch,{recursive:true,force:true});
}
