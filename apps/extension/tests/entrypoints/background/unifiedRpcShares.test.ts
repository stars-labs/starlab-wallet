import { beforeEach, afterEach, describe, expect, it, jest, mock } from 'bun:test';
import * as mockImports from '../../wxt-imports-mock';
mock.module('#imports', () => mockImports);
const managerModule = '../../../src/services/keystoreManager.ts?unified-rpc-shares';
const { KeystoreManager } = await import(managerModule) as typeof import('../../../src/services/keystoreManager');
mock.module('../../../src/services/keystoreManager', () => ({ KeystoreManager }));
const rpcModule = '../../../src/entrypoints/background/rpcHandler.ts?unified-rpc-shares';
const { RpcHandler } = await import(rpcModule) as typeof import('../../../src/entrypoints/background/rpcHandler');

const shares = {
    secp256k1: { curve:'secp256k1', group_public_key:'bitcoin-root', participants:['browser','desktop'] },
    ed25519: { curve:'ed25519', group_public_key:'solana-root', participants:['browser','desktop'] },
};
let getKeyShare: ReturnType<typeof jest.fn>;
beforeEach(() => {
    // Omitting the algorithm deliberately returns the canonical primary FROST
    // share, reproducing a unified wallet rather than a single-curve fake.
    getKeyShare = jest.fn(async (_id:string, curve?:keyof typeof shares) => shares[curve ?? 'secp256k1']);
    (KeystoreManager as any).instance = { getKeyShare };
    (chrome as any).notifications = {clear:jest.fn(),create:jest.fn()};
});
afterEach(() => { (KeystoreManager as any).instance = undefined; });

function setup() {
    const rpc = new RpcHandler();
    const calls:any[] = [];
    rpc.setSessionManager({createSigningSession:async(config:any)=>{
        calls.push(config);return {success:true,sessionId:'sign-unified'};
    }} as any);
    return {rpc,calls};
}

describe('unified wallet RPC signing selects the chain algorithm', () => {
    for (const [blockchain,curve] of [['solana','ed25519'],['ethereum','secp256k1']] as const) {
        it(`approved ${blockchain} dApp requests use the ${curve} share`, async () => {
            const {rpc,calls}=setup();
            (rpc as any).pendingDappRequests.set('request',{
                walletId:'wallet',walletName:'Unified',blockchain,messageHex:'11',
            });
            expect((await rpc.approveDappSignature('request',true)).success).toBe(true);
            expect(getKeyShare).toHaveBeenCalledWith('wallet',curve);
            expect(calls[0].keyShare).toBe(shares[curve]);
        });
        it(`internal ${blockchain} transaction signing uses the ${curve} share`, async () => {
            const {rpc,calls}=setup();
            const pending=(rpc as any).signNow({walletId:'wallet',walletName:'Unified',blockchain,messageHex:'11'});
            for(let i=0;i<50&&!(rpc as any).pendingSignatures.has('sign-unified');i++)await Bun.sleep(1);
            rpc.handleSignatureComplete('sign-unified','1122');
            expect(await pending).toBe('0x1122');
            expect(getKeyShare).toHaveBeenCalledWith('wallet',curve);
            expect(calls[0].keyShare).toBe(shares[curve]);
        });
    }
});
