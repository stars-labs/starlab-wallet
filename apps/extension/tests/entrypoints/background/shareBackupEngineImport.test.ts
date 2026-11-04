/**
 * Cross-client restore, engine → extension: the fixtures under
 * tests/fixtures/engine-share were written by the engine's own
 * `Keystore::export_share` (starlab-mpc apps/tui/src/keystore/storage.rs,
 * branch feat/wallet-import-export) for a 2-of-3 wallet held by
 * device-a/b/c; `*.expected.json` is the engine's account-0 addresses.
 * "Import keystore" must restore the same wallet: id, label, group key,
 * cohort → FROST ids, and a share that derives the same account.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, jest, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);

const keystore = {
    wallets: [] as any[],
    added: [] as any[],
    initializedIds: [] as string[],
    trace: [] as string[],
    initialize: async function(deviceId:string) { this.initializedIds.push(deviceId); this.trace.push(`initialize:${deviceId}`); },
    isInitialized: async () => true,
    isLocked: () => false,
    getWallets() { return this.wallets; },
    async addWallet(id: string, keyShare: any, meta: any) { this.trace.push('addWallet'); this.added.push({ id, keyShare, meta }); return true; },
    curves: [] as any[],
    async setCurveShare(id: string, curve: string, data: string) { this.curves.push({id,curve,data}); },
    async setActiveWallet() { return true; },
};
mock.module("../../../src/services/keystoreManager", () => ({
    KeystoreManager: { getInstance: () => keystore },
}));
mock.module("../../../src/entrypoints/background/index", () => ({ checkAndRestoreKeystores: async () => {} }));

import wasmInit, {
    FrostDkgEd25519,
    FrostDkgSecp256k1,
    FrostReshareSecp256k1,
    derive_account_addresses,
    derive_child_keystore_ed25519,
    derive_child_keystore_secp256k1,
    standard_account_path,
    ecdsa_share_info,
    ecdsa_ethereum_address,
} from "@stars-labs/core-wasm";
import { ECDSA_WALLET } from "../../helpers/ecdsaFixture";
import { REAL_WEBCRYPTO } from "../../setup-bun";
import { PopupMessageHandler } from "../../../src/entrypoints/background/messageHandlers";
import { openShareBackup, encryptEcdsaShareBackup, encryptShareBackup } from "../../../src/utils/shareBackup";
import { toEngineKeystoreJson, keyShareCoreFromEngine } from "../../../src/utils/engineKeystore";
import { engineBlobFromKeystore, keystoreFromEngineBlob } from "../../../src/utils/frostShareBlob";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { DEVICE_ID_STORAGE_KEY } from "../../../src/config/device";

/** The engine's plaintext share blob, decrypted independently of our code. */
function engineBlob(file: string, password: string): Uint8Array {
    const raw = Buffer.from(JSON.parse(file).data, "base64");
    const key = pbkdf2Sync(password, raw.subarray(0, 16), 100_000, 32, "sha256");
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(16, 28));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return new Uint8Array(Buffer.concat([d.update(raw.subarray(28, raw.length - 16)), d.final()]));
}

const FIXTURES = join(import.meta.dir, "../../fixtures/engine-share");
const fixture = (curve: string) => ({
    file: readFileSync(join(FIXTURES, `engine-share-${curve}.json`), "utf8"),
    expected: JSON.parse(readFileSync(join(FIXTURES, `engine-share-${curve}.expected.json`), "utf8")),
});

/** Independent real FROST DKG then a {1,3} refresh; all material is test-only. */
function refreshedShares() {
    const original = [1,2,3].map(index => {const engine = new FrostDkgSecp256k1(); engine.init_dkg(index,3,2); return engine;});
    const refreshed = [new FrostReshareSecp256k1(),new FrostReshareSecp256k1()];
    try {
        const r1 = original.map(engine => engine.generate_round1());
        original.forEach((engine,i) => r1.forEach((message,j) => {if(i!==j) engine.add_round1_package(j+1,message);}));
        const r2 = original.map(engine => JSON.parse(Buffer.from(engine.generate_round2(),'hex').toString()));
        original.forEach((engine,i) => r2.forEach((message,j) => {if(i!==j) engine.add_round2_package(j+1,message[i+1]);}));
        const stores = original.map(engine => engine.finalize_dkg());
        const group = original[0]!.get_group_public_key(), ids = [1,3];
        refreshed.forEach((engine,i) => engine.init_reshare(stores[ids[i]!-1]!, '1,3', 2));
        const rr1 = refreshed.map(engine => engine.reshare_round1());
        refreshed.forEach((engine,i) => rr1.forEach((message,j) => {if(i!==j) engine.add_reshare_round1(ids[j]!,message);}));
        const rr2 = refreshed.map(engine => JSON.parse(engine.reshare_round2()));
        refreshed.forEach((engine,i) => rr2.forEach((message,j) => {if(i!==j) engine.add_reshare_round2(ids[j]!,message[ids[i]!]);}));
        return refreshed.map((engine,i) => ({...keyShareCoreFromEngine(engine.finalize_reshare(),group,{'device-a':1,'device-c':3}),session_id:'w-transfer',device_id:i===0?'device-a':'device-c',blockchains:[],created_at:1}));
    } finally { original.forEach(engine => engine.free()); refreshed.forEach(engine => engine.free()); }
}

const savedCrypto = (globalThis as any).crypto;
beforeAll(async () => {
    await wasmInit();
});
beforeEach(() => {
    (globalThis as any).crypto = REAL_WEBCRYPTO;
    keystore.wallets = [];
    keystore.added = [];
    keystore.curves = [];
    keystore.initializedIds = [];
    keystore.trace = [];
});
afterEach(() => {
    (globalThis as any).crypto = savedCrypto;
});

describe("engine share file → extension (openShareBackup)", () => {
    for (const curve of ["secp256k1", "ed25519"] as const) {
        it(`${curve}: restores the wallet id, cohort and group key`, async () => {
            const { file, expected } = fixture(curve);
            const { metadata, keyShare } = await openShareBackup(file, expected.password);
            expect(metadata.session_id).toBe("w-transfer");
            expect(metadata.label).toBe("Savings");
            expect(keyShare.group_public_key).toBe(expected.group_public_key);
            expect(keyShare.participant_identifiers).toEqual({ "device-a": 1, "device-b": 2, "device-c": 3 });
            expect(keyShare.participant_index).toBe(1);
            expect([keyShare.threshold, keyShare.total_participants]).toEqual([2, 3]);
        });

        it(`${curve}: the share loads into the engine and derives the engine's account 0`, async () => {
            const { file, expected } = fixture(curve);
            const { keyShare } = await openShareBackup(file, expected.password);
            const chain = curve === "secp256k1" ? "bitcoin" : "solana";
            const derive = curve === "secp256k1" ? derive_child_keystore_secp256k1 : derive_child_keystore_ed25519;
            const inst = curve === "secp256k1" ? new FrostDkgSecp256k1() : new FrostDkgEd25519();
            try {
                inst.import_keystore(derive(toEngineKeystoreJson(keyShare), standard_account_path(chain, 0)!));
                const engineAccount0 = expected.account0.find((a: string[]) => a[1] === standard_account_path(chain, 0));
                if (curve === "secp256k1") {
                    // The share's group key lists the engine's Taproot (bc1p…) account 0.
                    const listed = JSON.parse(derive_account_addresses("secp256k1", keyShare.group_public_key, 0));
                    expect(listed.find((a: any) => a.chain === "Bitcoin").address).toBe(engineAccount0[2]);
                } else {
                    expect(inst.get_address().toLowerCase()).toBe(engineAccount0[2].toLowerCase());
                }
            } finally {
                inst.free();
            }
        });
    }

    for (const curve of ["secp256k1", "ed25519"] as const) {
        it(`${curve}: the share blob codec round-trips the engine's bytes exactly`, () => {
            const { file, expected } = fixture(curve);
            const blob = engineBlob(file, expected.password);
            const { keystoreJson, groupPublicKey } = keystoreFromEngineBlob(blob, 3);
            expect(groupPublicKey).toBe(expected.group_public_key);
            expect(Buffer.from(engineBlobFromKeystore(keystoreJson)).toString("hex")).toBe(Buffer.from(blob).toString("hex"));
        });
    }

    it('preserves real refreshed FROST identifiers {1,3} and validates source parameters', async () => {
        const shares = refreshedShares();
        for (const share of shares) {
            const file = await encryptShareBackup(share,{id:'w-transfer'},'refresh-backup-password');
            const restored = await openShareBackup(file,'refresh-backup-password');
            expect(restored.keyShare.participant_identifiers).toEqual({'device-a':1,'device-c':3});
            expect(restored.keyShare.participant_index).toBe(share.participant_index);
            expect(restored.keyShare.total_participants).toBe(2);
            for (const patch of [{threshold:3},{participant_index:2},{total_participants:3},{device_id:'other-device'}]) {
                const invalid = JSON.parse(file); Object.assign(invalid.metadata,patch);
                await expect(openShareBackup(JSON.stringify(invalid),'refresh-backup-password')).rejects.toThrow();
            }
        }
    });

    it("rejects the wrong password", async () => {
        const { file } = fixture("secp256k1");
        await expect(openShareBackup(file, "not-the-password")).rejects.toThrow("Wrong password");
    });
});

describe("importKeystore handler with a complete engine wallet", () => {
    function environment(patch:Record<string,unknown> = {}) {
        const state:any = {deviceId:'ext-new',invites:['old-invite'],sessionInfo:null,pendingKeystoreReady:false,...patch};
        const initCalls:string[]=[];
        let reconnects=0;
        const offscreenManager = {
            createOffscreenDocument: jest.fn(async () => {}),
            sendInitData: jest.fn(async (deviceId:string) => {keystore.trace.push(`sendInitData:${deviceId}`);initCalls.push(deviceId);expect((await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY))[DEVICE_ID_STORAGE_KEY]).toBe(deviceId);return{success:true};}),
            sendToOffscreen: jest.fn(async (msg: any) => {
                keystore.trace.push(msg.type==='deriveAccounts'?`derive:${msg.curve}`:msg.type);
                return msg.type === 'ecdsaShareInfo'
                    ? {success:true, info: JSON.parse(ecdsa_share_info(msg.shareJson))}
                    : {success:true, accounts:[{account:0, addresses:JSON.parse(derive_account_addresses(msg.curve,msg.groupPublicKey,0))}]};
            }),
        };
        const instance = new PopupMessageHandler(
            {getState:()=>state,getChain:()=> 'ethereum',updateState:(value:any)=>{keystore.trace.push('updateState');Object.assign(state,value);}} as any,
            offscreenManager as any,{reconnect:async()=>{keystore.trace.push('reconnect');reconnects++;}} as any,{} as any,{} as any,{} as any,
        );
        return {instance,state,initCalls,get reconnects(){return reconnects;}};
    }
    async function bundle() {
        const secp = fixture('secp256k1'), ed = fixture('ed25519');
        expect(secp.expected.password).toBe(ed.expected.password);
        const info = JSON.parse(ecdsa_share_info(ECDSA_WALLET.shares[0]!));
        const ecdsa = await encryptEcdsaShareBackup(ECDSA_WALLET.shares[0]!, info, {id:'w-transfer',deviceId:'device-a',name:'Savings'}, secp.expected.password);
        return { files:[secp.file,ed.file,ecdsa], password:secp.expected.password, secp, ed, info };
    }
    async function restore(files: string[], password: string, env = environment()) {
        return await new Promise<any>(resolve => (env.instance as any).handleImportKeystoreMessage({type:'importKeystore',keystoreFiles:files,password},resolve));
    }
    it('adopts the original backup identity in an empty profile before publishing shares', async () => {
        const b=await bundle(),env=environment();
        await chrome.storage.local.set({[DEVICE_ID_STORAGE_KEY]:'ext-new'});
        (chrome.storage.local.set as any).mockClear();
        const result=await restore(b.files,b.password,env);
        expect(result.success).toBe(true);
        expect((await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY))[DEVICE_ID_STORAGE_KEY]).toBe('device-a');
        expect(env.state.deviceId).toBe('device-a');expect(env.state.invites).toEqual([]);
        expect(keystore.initializedIds).toEqual(['ext-new','device-a']);
        expect(env.initCalls).toEqual(['device-a']);expect(env.reconnects).toBe(1);
        expect(keystore.trace.indexOf('derive:ed25519')).toBeLessThan(keystore.trace.indexOf('updateState'));
        expect(keystore.trace.indexOf('updateState')).toBeLessThan(keystore.trace.indexOf('sendInitData:device-a'));
        expect(keystore.trace.indexOf('sendInitData:device-a')).toBeLessThan(keystore.trace.indexOf('reconnect'));
        expect(keystore.trace.indexOf('reconnect')).toBeLessThan(keystore.trace.indexOf('addWallet'));
    });
    it('does not rebind an already matching identity', async () => {
        const b=await bundle(),env=environment({deviceId:'device-a'});
        await chrome.storage.local.set({[DEVICE_ID_STORAGE_KEY]:'device-a'});
        (chrome.storage.local.set as any).mockClear();
        expect((await restore(b.files,b.password,env)).success).toBe(true);
        expect(keystore.initializedIds).toEqual(['device-a']);expect(env.initCalls).toEqual([]);expect(env.reconnects).toBe(0);
        expect(keystore.trace).not.toContain('updateState');
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
    for(const state of ['other-wallet','active-session','pending-wallet'])it(`refuses identity adoption with ${state} without identity/share writes`, async()=>{
        const b=await bundle();
        if(state==='other-wallet')keystore.wallets=[{id:'other-wallet'}];
        const env=environment(state==='active-session'?{sessionInfo:{session_id:'active'}}:state==='pending-wallet'?{pendingKeystoreReady:true}:{});
        await chrome.storage.local.set({[DEVICE_ID_STORAGE_KEY]:'ext-new'});
        (chrome.storage.local.set as any).mockClear();
        const result=await restore(b.files,b.password,env);expect(result.success).toBe(false);
        expect(env.state.deviceId).toBe('ext-new');expect((await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY))[DEVICE_ID_STORAGE_KEY]).toBe('ext-new');
        expect(env.initCalls).toEqual([]);expect(env.reconnects).toBe(0);expect(keystore.added).toEqual([]);expect(keystore.curves).toEqual([]);expect(keystore.trace).not.toContain('updateState');expect(chrome.storage.local.set).not.toHaveBeenCalled();
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
    it('never adopts identity or initializes target storage for unauthenticated source files',async()=>{
        const b=await bundle();const bad=JSON.parse(b.files[2]!);bad.data='invalidciphertext';
        const env=environment();await chrome.storage.local.set({[DEVICE_ID_STORAGE_KEY]:'ext-new'});
        (chrome.storage.local.set as any).mockClear();
        expect((await restore([b.files[0]!,b.files[1]!,JSON.stringify(bad)],b.password,env)).success).toBe(false);
        expect(env.state.deviceId).toBe('ext-new');expect((await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY))[DEVICE_ID_STORAGE_KEY]).toBe('ext-new');
        expect(keystore.initializedIds).toEqual([]);expect(keystore.added).toEqual([]);expect(keystore.curves).toEqual([]);expect(env.initCalls).toEqual([]);expect(env.reconnects).toBe(0);expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
    it('publishes one wallet with all three algorithms and canonical account addresses', async () => {
        const b = await bundle(), result = await restore(b.files,b.password);
        expect(result.success).toBe(true);
        expect(keystore.added).toHaveLength(1);
        const [{id,keyShare,meta}] = keystore.added;
        expect(id).toBe('w-transfer'); expect(meta.name).toBe('Savings');
        expect(meta.address).toBe(ecdsa_ethereum_address(b.info.group_public_key,0));
        expect(keyShare.group_public_key).toBe(b.secp.expected.group_public_key);
        expect(keyShare.frost_group_public_keys).toEqual({ed25519:b.ed.expected.group_public_key,secp256k1:b.secp.expected.group_public_key});
        expect(keyShare.ecdsa_group_public_key).toBe(b.info.group_public_key);
        expect(keyShare.ecdsa_cohort).toEqual({participants:b.info.participants,threshold:b.info.threshold,total:b.info.n,participantIndex:b.info.index+1});
        expect(keyShare.participants).toEqual(['device-a','device-b','device-c']);
        expect(keystore.curves.map(part => part.curve).sort()).toEqual(['ed25519','secp256k1-ecdsa']);
        const ed = JSON.parse(keystore.curves.find(part => part.curve === 'ed25519').data);
        expect(ed.group_public_key).toBe(b.ed.expected.group_public_key);
        expect(ed.frost_group_public_keys).toEqual(keyShare.frost_group_public_keys);
    });
    it('restores independent FROST refresh cohorts without changing the unrefreshed ECDSA cohort', async () => {
        const b = await bundle();
        const secp = refreshedShares()[0]!;
        const refreshedFile = await encryptShareBackup(secp,{id:'w-transfer',name:'Savings'},b.password);
        const result = await restore([refreshedFile,b.files[1]!,b.files[2]!],b.password);
        expect(result.success).toBe(true);
        expect(keystore.added[0].keyShare.participant_identifiers).toEqual({'device-a':1,'device-c':3});
        expect(keystore.added[0].keyShare.total_participants).toBe(2);
        expect(keystore.added[0].keyShare.ecdsa_cohort.total).toBe(3);
        expect(keystore.added[0].keyShare.ecdsa_cohort.participants).toEqual(["device-a","device-b","device-c"]);
        const ed = JSON.parse(keystore.curves.find(part => part.curve==='ed25519').data);
        expect(ed.total_participants).toBe(3);
        expect(ed.participant_identifiers).toEqual({'device-a':1,'device-b':2,'device-c':3});
    });

    it('rejects incomplete, duplicate, wrong-wallet and wrong-device bundles before any write', async () => {
        const b = await bundle();
        const wrongWallet = JSON.parse(b.files[2]!); wrongWallet.metadata.session_id = 'other-wallet';
        const wrongDevice = JSON.parse(b.files[2]!); wrongDevice.metadata.device_id = 'other-device';
        for (const files of [b.files.slice(0,2),[b.files[0]!,b.files[0]!,b.files[2]!],[b.files[0]!,b.files[1]!,JSON.stringify(wrongWallet)],[b.files[0]!,b.files[1]!,JSON.stringify(wrongDevice)]]) {
            const result = await restore(files,b.password);
            expect(result.success).toBe(false);
            expect(keystore.added).toHaveLength(0);
            expect(keystore.curves).toHaveLength(0);
        }
    });
    it('binds ECDSA metadata to its own actual cohort, index, threshold and count', async () => {
        const b = await bundle();
        // FROST cohorts may legitimately differ after refresh. These changes
        // target only ECDSA's own metadata, whose source share is unchanged.
        for (const patch of [ {participants:['device-a','device-c','device-b']}, {participant_index:2}, {threshold:3}, {total_participants:4} ]) {
            const ecdsa = JSON.parse(b.files[2]!);
            Object.assign(ecdsa.metadata, patch);
            const result = await restore([b.files[0]!,b.files[1]!,JSON.stringify(ecdsa)],b.password);
            expect(result.success).toBe(false);
            expect(result.error).toContain('cohort');
            expect(keystore.added).toHaveLength(0);
            expect(keystore.curves).toHaveLength(0);
        }
    });

    it('authenticates all three source files before writing a target share', async () => {
        const b = await bundle();
        const corrupt = JSON.parse(b.files[2]!); corrupt.data = 'invalidciphertext';
        const result = await restore([b.files[0]!,b.files[1]!,JSON.stringify(corrupt)],b.password);
        expect(result.success).toBe(false); expect(keystore.added).toHaveLength(0); expect(keystore.curves).toHaveLength(0);
    });
    it('refuses a complete wallet already present locally', async () => {
        const b = await bundle(); keystore.wallets = [{id:'w-transfer'}];
        const result = await restore(b.files,b.password);
        expect(result.success).toBe(false); expect(keystore.added).toHaveLength(0); expect(keystore.curves).toHaveLength(0);
    });
});
