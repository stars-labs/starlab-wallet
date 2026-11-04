import { beforeAll, describe, expect, it, jest } from 'bun:test';
import wasmInit, { ecdsa_share_info } from '@stars-labs/core-wasm';
import { ECDSA_WALLET } from '../../helpers/ecdsaFixture';
import { SessionManager } from '../../../src/entrypoints/background/sessionManager';
import { REAL_WEBCRYPTO } from '../../setup-bun';

let original:any;
beforeAll(async () => { await wasmInit(); original=JSON.parse(ecdsa_share_info(ECDSA_WALLET.shares[0])); });
function setup(blockchain='ethereum') {
    const state:any={deviceId:original.participants[0],chain:blockchain,sessionInfo:null};
    const announcements:any[]=[];const offscreen:any[]=[];
    const manager=new SessionManager({getState:()=>state,updateState:(patch:Record<string,unknown>)=>Object.assign(state,patch),updateStateProperty:(key:string,value:unknown)=>{state[key]=value;}} as any,
        {getReadyState:()=>WebSocket.OPEN,announceSession:(wire:any)=>announcements.push(wire)} as any,
        jest.fn(),async(message:any)=>{offscreen.push(message);return message.type==='deriveAccountGroupKey'?{success:true,groupPublicKey:'frost-account-child'}:{success:true};});
    const share:any={
        curve:'secp256k1',group_public_key:'frost-secp-root',
        frost_group_public_keys:{ed25519:'frost-ed-root',secp256k1:'frost-secp-root'},
        ecdsa_group_public_key:original.group_public_key,
        // A completed FROST refresh retired the middle device. ECDSA did not.
        threshold:2,total_participants:2,participants:[original.participants[0],original.participants[2]],participant_index:1,
        ecdsa_cohort:{participants:original.participants,threshold:original.threshold,total:original.n,participantIndex:original.index+1},
    };
    return {manager,share,announcements,offscreen};
}
async function withCrypto<T>(run:()=>Promise<T>):Promise<T>{const previous=globalThis.crypto;(globalThis as any).crypto=REAL_WEBCRYPTO;try{return await run();}finally{(globalThis as any).crypto=previous;}}
describe('immutable ECDSA cohort after FROST refresh',()=>{
    it('announces the actual ECDSA share cohort and quorum, including the FROST-retired device',async()=>{
        const env=setup();
        const response=await withCrypto(()=>env.manager.createSigningSession({walletId:'wallet',walletName:'Unified',blockchain:'ethereum',keyShare:env.share,signingMessageHex:'11'.repeat(32)}));
        expect(response.success).toBe(true);
        expect(env.announcements[0].participants).toEqual(original.participants);
        expect(env.announcements[0].total).toBe(original.n);
        expect(env.announcements[0].threshold).toBe(original.threshold);
        expect(env.announcements[0].curve_type).toBe('secp256k1-ecdsa');
        expect(env.announcements[0].group_public_key).toBe(original.group_public_key);
    });
    it('refuses Ethereum signing without the ECDSA cohort instead of falling back to FROST',async()=>{
        const env=setup();delete env.share.ecdsa_cohort;
        const response=await env.manager.createSigningSession({walletId:'wallet',walletName:'Unified',blockchain:'ethereum',keyShare:env.share,signingMessageHex:'11'.repeat(32)});
        expect(response.success).toBe(false);expect(response.error).toContain('ECDSA signing cohort');expect(env.announcements).toEqual([]);expect(env.offscreen).toEqual([]);
    });
    it('keeps Bitcoin on its refreshed FROST cohort rather than the ECDSA cohort',async()=>{
        const env=setup('bitcoin');
        const response=await withCrypto(()=>env.manager.createSigningSession({walletId:'wallet',walletName:'Unified',blockchain:'bitcoin',keyShare:env.share,signingMessageHex:'11'}));
        expect(response.success).toBe(true);expect(env.announcements[0].participants).toEqual(env.share.participants);expect(env.announcements[0].total).toBe(2);expect(env.announcements[0].curve_type).toBe('secp256k1');
    });
});
