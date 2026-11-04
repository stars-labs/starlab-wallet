/** Trust-boundary/lifecycle tests of the actual controller. The injected vault
 * only counts operations; real crypto and WebAuthn have separate test files. */
import { beforeEach, afterEach, describe, expect, it } from 'bun:test';
import { REAL_WEBCRYPTO, mockCrypto } from '../../setup-bun';
import { SecurityKeyAuthController } from '../../../src/entrypoints/background/securityKeyAuth';
import type { HardwareAssertion } from '../../../src/services/hardwareVault';
const ID='a'.repeat(32), KEY='starlab_security_key_request';
const getURL=(p:string)=>`chrome-extension://${ID}/${p}`;
const popup=():chrome.runtime.MessageSender=>({id:ID,url:getURL('popup.html'),frameId:0});
// Only the browser-assigned ID is consulted by this controller.
const fakeTab=(id:number)=>({id} as chrome.tabs.Tab);
const assertion=():HardwareAssertion=>({credentialId:'a'.repeat(43),prfSalt:'b'.repeat(43),prfOutput:'c'.repeat(43)});
let session:Record<string,any>,tabs:Map<number,any>,creates:number,unlocks:number,completed:number,tabCreates:number;
let saved:{session:any,tabs:any,id:string,getURL:any};
function controller(status:'unconfigured'|'hardware'='unconfigured') {
 return new SecurityKeyAuthController(()=> 'fixture-device',async()=>{completed++;},()=>({
  getAuthStatus:async()=>({mode:status,...(status==='hardware'?{credential:{credentialId:'a'.repeat(43),prfSalt:'b'.repeat(43)}}:{})}) as any,
  createHardwareKeystore:async()=>{creates++;},unlockHardwareKeystore:async()=>{unlocks++;},
 }));
}
function owner(request:any, overrides:Record<string,any>={}):chrome.runtime.MessageSender {
 const pending=session[KEY];return {...popup(),url:request.url,tab:fakeTab(pending.tabId),...overrides};
}
async function open(c:SecurityKeyAuthController,action:'create'|'unlock'='create') {return await c.handle({type:'openSecurityKeyAuth',action},popup()) as any;}
describe('security-key controller isolation',()=>{
 beforeEach(()=>{
  (globalThis as any).crypto=REAL_WEBCRYPTO;
  saved={session:chrome.storage.session,tabs:chrome.tabs,id:chrome.runtime.id,getURL:chrome.runtime.getURL};
  session={};tabs=new Map();creates=0;unlocks=0;completed=0;tabCreates=0;
  (chrome.runtime as any).id=ID;(chrome.runtime as any).getURL=getURL;
  (chrome.storage as any).session={get:async()=>structuredClone(session),set:async(items:any)=>{Object.assign(session,structuredClone(items));},remove:async(keys:string|string[])=>{for(const k of typeof keys==='string'?[keys]:keys)delete session[k];}};
  (chrome as any).tabs={
   create:async(options:any)=>{const tab={id:++tabCreates,...options};tabs.set(tab.id,tab);return {...tab};},
   update:async(id:number,options:any)=>{const tab={...tabs.get(id),...options};tabs.set(id,tab);return {...tab};},
   get:async(id:number)=>{if(!tabs.has(id))throw new Error('No tab');return {...tabs.get(id)};},
   query:async(options:{url?:string|string[]})=>{
    expect(options.url).toBe(getURL('security-key.html*'));
    return [...tabs.values()].filter(tab=>{try{const u=new URL(tab.pendingUrl??tab.url??'');return u.protocol==='chrome-extension:'&&u.hostname===ID&&u.pathname==='/security-key.html';}catch{return false;}}).map(tab=>({...tab}));
   },
   remove:async(id:number)=>{tabs.delete(id);},
  };
 });
 afterEach(()=>{
  (chrome.storage as any).session=saved.session;(chrome as any).tabs=saved.tabs;
  (chrome.runtime as any).id=saved.id;(chrome.runtime as any).getURL=saved.getURL;(globalThis as any).crypto=mockCrypto;
 });
 it('rejects content scripts, other extensions and subframes before opening tabs',async()=>{
  const c=controller();
  for(const sender of [{id:ID,url:'https://attacker.example/',tab:fakeTab(10)}, {...popup(),id:'b'.repeat(32)}, {...popup(),frameId:1}, {id:ID}]){
   await expect(c.handle({type:'openSecurityKeyAuth',action:'create'},sender)).rejects.toThrow();
  }
  expect(tabCreates).toBe(0);expect(creates).toBe(0);
 });
 it('binds page, tab and nonce; stores no assertion; consumes completion once',async()=>{
  const c=controller(),r=await open(c),sender=owner(r);
  expect(Object.keys(session[KEY]).sort()).toEqual(['action','expiresAt','id','tabId']);
  for(const wrong of [{...sender,url:getURL('popup.html')},{...sender,tab:fakeTab(999)},{...sender,url:getURL('security-key.html?request=wrong')}])await expect(c.handle({type:'completeSecurityKeyAuth',requestId:r.requestId,assertion:assertion()},wrong)).rejects.toThrow();
  await expect(c.handle({type:'completeSecurityKeyAuth',requestId:'wrong',assertion:assertion()},sender)).rejects.toThrow();
  expect(creates).toBe(0);expect(session[KEY].id).toBe(r.requestId);
  await c.handle({type:'completeSecurityKeyAuth',requestId:r.requestId,assertion:assertion()},sender);
  expect(creates).toBe(1);expect(completed).toBe(1);expect(session[KEY]).toBeUndefined();
  await expect(c.handle({type:'completeSecurityKeyAuth',requestId:r.requestId,assertion:assertion()},sender)).rejects.toThrow();
  expect(creates).toBe(1);
 });
 it('duplicate open rejects without clearing or replacing the original request',async()=>{
  const c=controller(),r=await open(c),before=JSON.stringify(session[KEY]);
  await expect(open(c)).rejects.toThrow();expect(JSON.stringify(session[KEY])).toBe(before);expect(tabCreates).toBe(1);
  await c.handle({type:'cancelSecurityKeyAuth',requestId:r.requestId},owner(r));expect(session[KEY]).toBeUndefined();expect(creates).toBe(0);
 });
 it('simultaneous open creates only one request and tab',async()=>{
  const c=controller(),results=await Promise.allSettled([open(c),open(c)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(tabCreates).toBe(1);expect(session[KEY]).toBeDefined();
 });
 for(const first of ['cancel','complete'] as const)it(`${first}-first concurrent cancellation/completion has exactly one winner`,async()=>{
  const c=controller(),r=await open(c),sender=owner(r);
  const cancel={type:'cancelSecurityKeyAuth' as const,requestId:r.requestId};
  const complete={type:'completeSecurityKeyAuth' as const,requestId:r.requestId,assertion:assertion()};
  const messages=first==='cancel'?[cancel,complete]:[complete,cancel];
  const results=await Promise.allSettled(messages.map(m=>c.handle(m,sender)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(session[KEY]).toBeUndefined();
  expect(creates).toBe(first==='cancel'?0:1);expect(completed).toBe(creates);
 });
 it('global lock invalidates completion already suspended while consuming its nonce',async()=>{
  const c=controller('hardware'),request=await open(c,'unlock'),sender=owner(request);
  const original=chrome.storage.session.remove.bind(chrome.storage.session);
  let enter!:()=>void,release!:()=>void,calls=0;
  const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
  chrome.storage.session.remove=async(keys:string|string[])=>{if(++calls===1){enter();await gate;}return original(keys);};
  const completion=c.handle({type:'completeSecurityKeyAuth',requestId:request.requestId,assertion:assertion()},sender).then(()=>({ok:true}),()=>({ok:false}));
  try{
   await entered;await c.cancelPending();release();
   expect((await completion).ok).toBe(false);expect(unlocks).toBe(0);expect(completed).toBe(0);expect(session[KEY]).toBeUndefined();
  }finally{release();await completion;chrome.storage.session.remove=original;}
  // A storage error must not revive the old physical-touch request either.
  const next=controller('hardware'),pending=await open(next,'unlock'),pendingSender=owner(pending),ownerId=session[KEY].tabId;
  tabs.set(900,{id:900,url:'https://elsewhere.example/security-key.html'});tabs.set(901,{id:901,url:getURL('popup.html')});
  chrome.storage.session.remove=async()=>{throw new Error('Fixture session remove failure');};
  try{await expect(next.cancelPending()).rejects.toThrow();}finally{chrome.storage.session.remove=original;}
  const late=await next.handle({type:'completeSecurityKeyAuth',requestId:pending.requestId,assertion:assertion()},pendingSender).then(()=>({ok:true}),()=>({ok:false}));
  expect(late.ok).toBe(false);expect(unlocks).toBe(0);expect(completed).toBe(0);
  expect(tabs.has(ownerId)).toBe(false);expect(tabs.has(900)).toBe(true);expect(tabs.has(901)).toBe(true);
  const recreated=controller('hardware');
  await expect(recreated.handle({type:'completeSecurityKeyAuth',requestId:pending.requestId,assertion:assertion()},pendingSender)).rejects.toThrow();
  expect(unlocks).toBe(0);
  const retry=await open(next,'unlock');expect(retry.requestId).not.toBe(pending.requestId);
  await next.handle({type:'completeSecurityKeyAuth',requestId:retry.requestId,assertion:assertion()},owner(retry));expect(unlocks).toBe(1);
 });
 it('new controller after worker suspension cannot replay a consumed request',async()=>{
  const c=controller(),r=await open(c),sender=owner(r);
  await c.handle({type:'cancelSecurityKeyAuth',requestId:r.requestId},sender);
  await expect(controller().handle({type:'completeSecurityKeyAuth',requestId:r.requestId,assertion:assertion()},sender)).rejects.toThrow();expect(creates).toBe(0);
 });
 it('expired metadata cannot authenticate and does not block a new request',async()=>{
  const c=controller(),r=await open(c),sender=owner(r);session[KEY].expiresAt=Date.now()-1;
  await expect(c.handle({type:'completeSecurityKeyAuth',requestId:r.requestId,assertion:assertion()},sender)).rejects.toThrow();
  const next=await open(c);expect(next.requestId).not.toBe(r.requestId);expect(creates).toBe(0);
 });
 it('closed owner tab releases stale metadata so a new request can open',async()=>{
  const c=controller(),r=await open(c);tabs.delete(session[KEY].tabId);
  const next=await open(c);expect(next.requestId).not.toBe(r.requestId);expect(tabCreates).toBe(2);expect(creates).toBe(0);
 });
 it('owner tab navigating away releases stale metadata without authenticating',async()=>{
  const c=controller(),r=await open(c),id=session[KEY].tabId;tabs.set(id,{id,url:'https://elsewhere.example/'});
  const next=await open(c);expect(next.requestId).not.toBe(r.requestId);expect(creates).toBe(0);
 });
 it('reuses only the dedicated authentication tab with a fresh nonce and rejects its previous request',async()=>{
  const c=controller('hardware'),first=await open(c,'unlock'),firstSender=owner(first),tabId=session[KEY].tabId;
  await c.handle({type:'completeSecurityKeyAuth',requestId:first.requestId,assertion:assertion()},firstSender);
  const second=await open(c,'unlock');
  expect(second.requestId).not.toBe(first.requestId);expect(session[KEY].tabId).toBe(tabId);expect(tabCreates).toBe(1);
  await expect(c.handle({type:'completeSecurityKeyAuth',requestId:first.requestId,assertion:assertion()},firstSender)).rejects.toThrow();
  // The old page/URL cannot submit the new nonce either.
  await expect(c.handle({type:'completeSecurityKeyAuth',requestId:second.requestId,assertion:assertion()},firstSender)).rejects.toThrow();
  expect(unlocks).toBe(1);
  await c.handle({type:'completeSecurityKeyAuth',requestId:second.requestId,assertion:assertion()},owner(second));expect(unlocks).toBe(2);
 });
 for(const target of ['https://elsewhere.example/',getURL('popup.html'),getURL('offscreen.html')])it(`does not reuse a previous authentication tab navigated to ${target}`,async()=>{
  const c=controller(),first=await open(c),sender=owner(first),oldId=session[KEY].tabId;
  await c.handle({type:'cancelSecurityKeyAuth',requestId:first.requestId},sender);
  tabs.set(oldId,{id:oldId,url:target});
  const second=await open(c);expect(session[KEY].tabId).not.toBe(oldId);expect(second.requestId).not.toBe(first.requestId);expect(tabCreates).toBe(2);
  expect(tabs.get(oldId).url).toBe(target);expect(creates).toBe(0);
 });
 it('allows an initial navigation that has the exact request as pendingUrl',async()=>{
  const c=controller(),r=await open(c),id=session[KEY].tabId;
  tabs.set(id,{id,url:'about:blank',pendingUrl:r.url});
  await expect(open(c)).rejects.toThrow();expect(session[KEY].id).toBe(r.requestId);
 });
});
