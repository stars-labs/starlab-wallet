import { describe, it, expect, jest } from 'bun:test';
import { restoreActiveWallet } from '../../../src/entrypoints/background/walletRestore';
import { DkgState } from '@stars-labs/types/dkg';
import type { AppState, SupportedChain } from '@stars-labs/types/appstate';

const ROOTS={ed25519:'edabcdef',secp256k1:'02abcdef'};
const COHORT={participants:['cli-alice','ext-bob','tui-carol'],threshold:2,total:3,participantIndex:2};
const KEY_SHARE={key_package:'SECRET',public_key_package:'pkp',group_public_key:ROOTS.secp256k1,ecdsa_group_public_key:'03abcdef',ecdsa_cohort:COHORT,frost_group_public_keys:ROOTS,session_id:'dkg_abc',device_id:'ext-bob',participant_index:2,threshold:2,total_participants:3,participants:COHORT.participants,participant_identifiers:{'cli-alice':1,'ext-bob':2,'tui-carol':3},curve:'secp256k1',blockchains:[{blockchain:'ethereum',address:'0xEthereum'},{blockchain:'bitcoin',address:'bc1pBitcoin'},{blockchain:'solana',address:'SolanaAddress'},{blockchain:'sui',address:'0xSui'}],created_at:1};
const ED_SHARE={...KEY_SHARE,curve:'ed25519',group_public_key:ROOTS.ed25519};
const WALLET={id:'wallet-1',name:'Team wallet',blockchain:'ethereum',address:'0xEthereum',session_id:'dkg_abc',isActive:true,hasBackup:false};
function keystore(opts: {locked?:boolean;primary?:any;ed?:any;ecdsa?:string|null;wallet?:any}={}) {
    const primary=opts.primary===undefined?structuredClone(KEY_SHARE):opts.primary;
    const ed=opts.ed===undefined?structuredClone(ED_SHARE):opts.ed;
    return {initialize:jest.fn(async()=>{}),isInitialized:jest.fn(async()=>true),isLocked:jest.fn(()=>opts.locked??false),getActiveWallet:jest.fn(()=>opts.wallet===undefined?WALLET:opts.wallet),getKeyShare:jest.fn(async(_id:string,curve?:string)=>curve==='ed25519'?ed:primary),getCurveShare:jest.fn(async()=>opts.ecdsa===undefined?'secret ECDSA fixture':opts.ecdsa)} as any;
}
function stateManager(chain: SupportedChain='ethereum', old=false) {
    let state={deviceId:'ext-bob',chain,blockchain:chain==='solana'||chain==='sui'?'solana':'ethereum',sessionInfo:null,dkgState:DkgState.Idle,...(old?{dkgState:DkgState.Complete,dkgGroupPublicKey:'old-frost',ecdsaGroupPublicKey:'old-ecdsa',frostGroupPublicKeys:{ed25519:'old-ed',secp256k1:'old-frost'},walletQuorums:{ed25519:{threshold:2,total:5}},dkgAddress:'old-address',ethereumAddress:'old-ethereum',solanaAddress:'old-solana',dkgLastResult:{groupPublicKey:'old-public'},pendingKeystoreReady:true}: {})} as AppState;
    return {getState:()=>state,getChain:()=>chain,updateState:jest.fn((patch:Partial<AppState>)=>{state={...state,...patch};}),broadcastCurrentState:jest.fn()};
}
function cleared(manager:ReturnType<typeof stateManager>) {
    const state=manager.getState();expect(state.dkgGroupPublicKey).toBe('');expect(state.ecdsaGroupPublicKey).toBe('');expect(state.frostGroupPublicKeys).toBeUndefined();expect(state.walletQuorums).toBeUndefined();expect(state.dkgAddress).toBe('');expect(state.ethereumAddress).toBe('');expect(state.solanaAddress).toBe('');expect(state.dkgLastResult).toBeUndefined();expect(state.pendingKeystoreReady).toBe(false);
}
describe('restoreActiveWallet unified identity',()=>{
    it('restores all three public parents, addresses and true cohort without synthesizing a session',async()=>{
        const state=stateManager();await restoreActiveWallet(state,keystore());const restored=state.getState();
        expect(restored.sessionInfo).toBeNull();expect(restored.dkgState).toBe(DkgState.Complete);expect(restored.dkgAddress).toBe('0xEthereum');expect(restored.frostGroupPublicKeys).toEqual(ROOTS);expect(restored.ecdsaGroupPublicKey).toBe('03abcdef');expect(restored.dkgLastResult?.participants).toEqual(COHORT.participants);expect(restored.dkgError).toBe('');expect(state.broadcastCurrentState).toHaveBeenCalledTimes(1);
    });
    it('uses Ethereum for a Polygon view even when the inventory primary address is Solana',async()=>{
        const state=stateManager('polygon');await restoreActiveWallet(state,keystore({wallet:{...WALLET,blockchain:'solana',address:'SolanaAddress'}}));
        expect(state.getState().dkgAddress).toBe('0xEthereum');expect(state.getState().ethereumAddress).toBe('0xEthereum');expect(state.getState().solanaAddress).toBe('SolanaAddress');
    });
    it('uses the exact Sui address rather than the primary Solana address',async()=>{
        const state=stateManager('sui');await restoreActiveWallet(state,keystore({wallet:{...WALLET,blockchain:'solana',address:'SolanaAddress'}}));expect(state.getState().dkgAddress).toBe('0xSui');
    });
    it('restores independent algorithm quorums after FROST-only refreshes',async()=>{
        const root={...KEY_SHARE,total_participants:2,participants:['ext-bob','tui-carol'],participant_identifiers:{'ext-bob':2,'tui-carol':3}};
        const ed={...ED_SHARE,threshold:3,total_participants:4,participants:[...COHORT.participants,'extra'],participant_identifiers:{'cli-alice':1,'ext-bob':2,'tui-carol':3,extra:4}};
        const state=stateManager();await restoreActiveWallet(state,keystore({primary:root,ed}));
        expect(state.getState().walletQuorums).toEqual({secp256k1:{threshold:2,total:2},ed25519:{threshold:3,total:4},'secp256k1-ecdsa':{threshold:2,total:3}});
    });
    it('rejects missing public roots, missing ECDSA cohort and contradictory primary metadata',async()=>{
        for(const patch of [{frost_group_public_keys:undefined},{frost_group_public_keys:{...ROOTS,ed25519:''}},{ecdsa_group_public_key:''},{ecdsa_cohort:undefined},{ecdsa_cohort:{...COHORT,participants:[]}},{group_public_key:'different-root'}]) {
            const state=stateManager('ethereum',true);await expect(restoreActiveWallet(state,keystore({primary:{...KEY_SHARE,...patch}}))).rejects.toThrow();cleared(state);expect(state.getState().dkgState).toBe(DkgState.Failed);expect(state.getState().dkgError).toBeTruthy();
        }
    });
    it('clears every previous public identity and ready marker on missing or mismatched algorithm shares',async()=>{
        for(const opts of [{primary:null},{ed:null},{ecdsa:null},{ed:{...ED_SHARE,group_public_key:'wrong-ed-root'}},{ed:{...ED_SHARE,ecdsa_group_public_key:'wrong-ecdsa-root'}},{ed:{...ED_SHARE,ecdsa_cohort:{...COHORT,threshold:3}}}]) {
            const state=stateManager('ethereum',true);await expect(restoreActiveWallet(state,keystore(opts))).rejects.toThrow();cleared(state);expect(state.getState().dkgState).toBe(DkgState.Failed);
        }
    });
    it('cleans up when the real selected-curve load throws',async()=>{
        const state=stateManager('ethereum',true),ks=keystore();ks.getKeyShare.mockImplementation(async(_id:string,curve?:string)=>{if(curve==='ed25519')throw new Error('Missing encrypted algorithm share');return KEY_SHARE;});
        await expect(restoreActiveWallet(state,ks)).rejects.toThrow('Missing encrypted algorithm share');cleared(state);expect(state.getState().dkgError).toContain('Missing encrypted');expect(state.broadcastCurrentState).toHaveBeenCalledTimes(1);
    });
    it('never falls back to an unrelated address if the selected chain is missing',async()=>{
        const state=stateManager('sui',true);await expect(restoreActiveWallet(state,keystore({primary:{...KEY_SHARE,blockchains:KEY_SHARE.blockchains.filter(entry=>entry.blockchain!=='sui')}}))).rejects.toThrow('sui');cleared(state);
    });
    it('does not erase pending unsaved DKG or public accounts on normal early return',async()=>{
        for(const ks of [keystore({locked:true}),keystore({wallet:null})]) {
            const state=stateManager('ethereum',true),before=structuredClone(state.getState());
            await restoreActiveWallet(state,ks);expect(state.getState()).toEqual(before);expect(state.broadcastCurrentState).not.toHaveBeenCalled();
        }
    });
});
