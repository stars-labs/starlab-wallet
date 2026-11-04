/** Account-zero provider routing must use per-chain public metadata, never the wallet's primary view. */
import {beforeEach,afterEach,describe,it,expect,jest,mock} from 'bun:test';
import * as mockImports from '../../wxt-imports-mock';
mock.module('#imports',()=>mockImports);
const managerModule='../../../src/services/keystoreManager.ts?unified-dapp-addresses';
const {KeystoreManager}=await import(managerModule) as typeof import('../../../src/services/keystoreManager');
mock.module('../../../src/services/keystoreManager',()=>({KeystoreManager}));
const rpcModule='../../../src/entrypoints/background/rpcHandler.ts?unified-dapp-addresses';
const {RpcHandler}=await import(rpcModule) as typeof import('../../../src/entrypoints/background/rpcHandler');
import {PermissionService} from '../../../src/services/permissionService';
import {setBlocklist} from '../../../src/services/phishingService';
const EVM='0x1111111111111111111111111111111111111111';
const ACCOUNT_ONE='0x2222222222222222222222222222222222222222';
const SOL='7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const ORIGIN='https://app.example.org';
let wallets:any[]=[];
let selectedShares:string[]=[];
beforeEach(()=>{
    mockImports.resetWxtStorageData();(PermissionService as any).instance=null;
    wallets=[];selectedShares=[];setBlocklist([]);
    (KeystoreManager as any).instance={getWallets:()=>wallets,getKeyShare:async(_id:string,curve:string)=>{selectedShares.push(curve);return{curve};}};
    (chrome as any).notifications={clear:jest.fn(),create:jest.fn()};
    (chrome as any).action={openPopup:async()=>{}};
    chrome.runtime.sendMessage=jest.fn(async()=>undefined) as any;
});
afterEach(()=>{(KeystoreManager as any).instance=undefined;});
async function setup(primary:'ethereum'|'solana'){
    wallets=[{id:'unified-wallet',name:'Unified',blockchain:primary,address:primary==='ethereum'?EVM:SOL,chainAddresses:{ethereum:EVM,solana:SOL,bitcoin:'bc1p-public',sui:'0x'+'11'.repeat(32)}}];
    const permissions=PermissionService.getInstance();await permissions.ensureInitialized();
    (permissions as any).permissions=new Map();
    const rpc=new RpcHandler();(rpc as any).permissionService=permissions;
    (rpc as any).accountService={ensureInitialized:async()=>{},getAccounts:()=>[],getAccountsByBlockchain:()=>[],getCurrentAccount:()=>null,ensureDefaultAccount:async()=>null};
    (rpc as any).networkService={getCurrentNetwork:()=>({id:1})};rpc.setOrigin(ORIGIN);
    const sessions:any[]=[];rpc.setSessionManager({createSigningSession:async(config:any)=>{sessions.push(config);return{success:true,sessionId:`sign-${sessions.length}`};}} as any);
    return{rpc,permissions,sessions};
}
async function connect(rpc:InstanceType<typeof RpcHandler>,method:'eth_requestAccounts'|'solana_connect',address:string){
    const settled=rpc.handleRpcRequest({jsonrpc:'2.0',id:1,method,params:[]}).then(value=>({value}),error=>({error}));
    await Bun.sleep(5);const request=rpc.getPendingConnectRequests()[0];expect(request).toBeDefined();expect(request.accounts).toEqual([{address,name:'Unified'}]);
    expect((await rpc.resolveConnectRequest(request.requestId,true,[address])).success).toBe(true);
    expect(await settled).toEqual({value:method==='eth_requestAccounts'?[address]:address});
}
async function sign(rpc:InstanceType<typeof RpcHandler>,method:string,params:unknown[],address:string){
    const settled=rpc.handleRpcRequest({jsonrpc:'2.0',id:2,method,params}).then(value=>({value}),error=>({error}));
    await Bun.sleep(5);const request=rpc.getPendingSignatureRequests()[0];expect(request).toBeDefined();expect(request.fromAddress).toBe(address);
    const approval=await rpc.approveDappSignature(request.signingId,true);expect(approval.success).toBe(true);
    rpc.handleSignatureComplete(approval.sessionId!,'1122');expect(await settled).toEqual({value:'0x1122'});
}
describe('unified wallet account-zero dApp addresses',()=>{
    for(const primary of ['ethereum','solana'] as const){
        it(`${primary} primary view exposes and signs both chain-specific accounts`,async()=>{
            const {rpc,permissions,sessions}=await setup(primary);
            await connect(rpc,'eth_requestAccounts',EVM);await connect(rpc,'solana_connect',SOL);
            expect(await rpc.handleRpcRequest({jsonrpc:'2.0',id:3,method:'eth_accounts',params:[]})).toEqual([EVM]);
            expect(await rpc.handleRpcRequest({jsonrpc:'2.0',id:4,method:'solana_connect',params:[]})).toBe(SOL);
            expect(rpc.getPendingConnectRequests()).toEqual([]);
            expect(permissions.getConnectedAccounts(ORIGIN).sort()).toEqual([EVM,SOL].sort());
            await sign(rpc,'personal_sign',['0x6869',EVM],EVM);
            await sign(rpc,'solana_signBytes',[SOL,'6869'],SOL);
            expect(sessions.map(session=>[session.walletId,session.blockchain,session.keyShare.curve])).toEqual([
                ['unified-wallet','ethereum','secp256k1'],['unified-wallet','solana','ed25519'],
            ]);
        });
    }
    it('personal_sign treats a 20-byte payload as data, not as another account address',async()=>{
        const {rpc,sessions}=await setup('solana');
        await sign(rpc,'personal_sign',[ACCOUNT_ONE,EVM],EVM);
        const {hashMessage}=await import('viem');
        expect(sessions[0].signingMessageHex).toBe(hashMessage({raw:ACCOUNT_ONE as `0x${string}`}).slice(2));
    });
    it('eth_sign uses its standard address-first order',async()=>{
        const {rpc,sessions}=await setup('solana');
        await sign(rpc,'eth_sign',[EVM,'0x6869'],EVM);
        expect(sessions[0].blockchain).toBe('ethereum');
    });
    it('rejects reversed parameters, implicit addresses and the removed nonstandard alias',async()=>{
        const {rpc}=await setup('ethereum');
        for(const request of [
            {method:'personal_sign',params:[EVM,'0x6869']},
            {method:'eth_sign',params:['0x6869',EVM]},
            {method:'personal_sign',params:['0x6869']},
            {method:'eth_signMessage',params:['0x6869',EVM]},
        ]) await expect(rpc.handleRpcRequest({jsonrpc:'2.0',id:20,...request})).rejects.toThrow();
        expect(rpc.getPendingSignatureRequests()).toEqual([]);
    });
    it('EIP-712 finds Ethereum account zero even when the primary address is Solana',async()=>{
        const {rpc,sessions}=await setup('solana');
        const data={domain:{name:'Starlab test'},types:{Message:[{name:'contents',type:'string'}]},primaryType:'Message',message:{contents:'hello'}};
        await sign(rpc,'eth_signTypedData_v4',[EVM,JSON.stringify(data)],EVM);
        expect(sessions[0].walletId).toBe('unified-wallet');expect(sessions[0].blockchain).toBe('ethereum');
    });
    it('never treats an unmapped primary address or an account-one address as account zero',async()=>{
        const {rpc}=await setup('ethereum');
        expect(await (rpc as any).findEvmWallet(ACCOUNT_ONE)).toBeUndefined();
        await expect(rpc.handleRpcRequest({jsonrpc:'2.0',id:5,method:'personal_sign',params:['0x6869',ACCOUNT_ONE]})).rejects.toThrow('No wallet found');
        wallets=[{id:'unmapped',name:'Unmapped',blockchain:'ethereum',address:EVM}];
        expect(await (rpc as any).findEvmWallet(EVM)).toBeUndefined();expect(await (rpc as any).listSolanaWallets()).toEqual([]);
        await expect(rpc.handleRpcRequest({jsonrpc:'2.0',id:6,method:'eth_requestAccounts',params:[]})).rejects.toThrow();
    });
    it('matches Solana addresses case-sensitively for ownership and approval',async()=>{
        const {rpc}=await setup('ethereum');const different=SOL.slice(0,1)+'X'+SOL.slice(2);
        expect(await (rpc as any).findSolanaWallet(different)).toBeUndefined();
        await expect(rpc.handleRpcRequest({jsonrpc:'2.0',id:7,method:'solana_signBytes',params:[different,'6869']})).rejects.toThrow('No Solana wallet');
        const pending=rpc.handleRpcRequest({jsonrpc:'2.0',id:8,method:'solana_connect',params:[]});await Bun.sleep(5);
        const request=rpc.getPendingConnectRequests()[0];expect(request).toBeDefined();
        expect((await rpc.resolveConnectRequest(request.requestId,true,[different])).success).toBe(false);
        await rpc.resolveConnectRequest(request.requestId,true,[SOL]);expect(await pending).toBe(SOL);
    });
});
