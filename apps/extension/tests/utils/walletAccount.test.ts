import { describe, it, expect } from 'bun:test';
import { addressForChain, publicWalletState } from '../../src/utils/walletAccount';
import { restoreActiveWallet } from '../../src/entrypoints/background/walletRestore';
import { StateManager } from '../../src/entrypoints/background/stateManager';
import { unifiedCompletion } from '../helpers/unifiedCompletion';
const ed='edabcdef',frost='02abcdef',ecdsa='03abcdef';
describe('popup account identity',()=>{
    it('keeps all public derivation parents and quorums through live DKG and saved-wallet restore',async()=>{
        const manager=new StateManager({deviceId:'device',chain:'ethereum'});await new Promise(resolve=>setTimeout(resolve,0));
        manager.handleOffscreenStateUpdate(unifiedCompletion({frost:{ed25519:{keystoreJson:'SECRET_ED',groupPublicKey:ed},secp256k1:{keystoreJson:'SECRET_SECP',groupPublicKey:frost}},addresses:{ethereum:'0x111'},ecdsa:{groupPublicKey:ecdsa,shareJson:'SECRET_ECDSA'}}) as any);
        const live=publicWalletState(manager.getState());
        expect(live.ecdsaGroupPublicKey).toBe(ecdsa);expect(live.dkgGroupPublicKey).toBe(frost);expect(live.frostGroupPublicKeys).toEqual({ed25519:ed,secp256k1:frost});expect(JSON.stringify(live)).not.toContain('SECRET');
        const root={curve:'secp256k1',key_package:'SECRET_SECP',public_key_package:'PUBLIC',device_id:'device',session_id:'dkg_x',participant_index:1,participants:['device','peer-b','peer-c'],participant_identifiers:{device:1,'peer-b':2,'peer-c':3},group_public_key:frost,threshold:2,total_participants:3,ecdsa_group_public_key:ecdsa,ecdsa_cohort:{participants:['device','peer-b','peer-c'],threshold:2,total:3,participantIndex:1},frost_group_public_keys:{ed25519:ed,secp256k1:frost},blockchains:[{blockchain:'ethereum',address:'0x111'}],created_at:1};
        await restoreActiveWallet(manager,{initialize:async()=>{},isInitialized:async()=>true,isLocked:()=>false,getActiveWallet:()=>({id:'compactwallet',blockchain:'ethereum',address:'0x111'}),getKeyShare:async(_id:string,curve?:string)=>curve==='ed25519'?{...root,curve:'ed25519',group_public_key:ed}:root,getCurveShare:async()=> 'SECRET_ECDSA'} as any);
        expect(publicWalletState(manager.getState())).toEqual(live);
    });
    it('never substitutes an address from another algorithm or chain',()=>{
        expect(addressForChain([{chain:'bitcoin',address:'bc1p123'}],'ethereum')).toBeUndefined();
        expect(addressForChain([{chain:'ethereum',address:'0x123'}],'bitcoin')).toBeUndefined();
        expect(addressForChain([{chain:'solana',address:'SolAddress'}],'sui')).toBeUndefined();
        expect(addressForChain([{chain:'Solana',address:'SolAddress'},{chain:'Sui',address:'0xSui'}],'sui')).toBe('0xSui');
        expect(addressForChain([{chain:'Solana',address:'SolAddress'},{chain:'Ethereum',address:'0x123'}],'polygon')).toBe('0x123');
        expect(addressForChain([{chain:'ethereum',address:'0x123'}],'base')).toBe('0x123');
        expect(addressForChain([{chain:'bitcoin',address:'bc1p123'},{chain:'ethereum',address:'0x123'}],'ethereum')).toBe('0x123');
    });
    it('clears previous public keys and quorums when a new wallet snapshot omits them',()=>{
        expect(publicWalletState({})).toEqual({dkgAddress:'',dkgGroupPublicKey:'',ecdsaGroupPublicKey:'',frostGroupPublicKeys:undefined,walletQuorums:undefined});
    });
});
