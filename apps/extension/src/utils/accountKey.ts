/**
 * The group key of a wallet's HD account child — what an engine proposer
 * (TUI / desktop / CLI) announces as a signing session's `group_public_key`
 * for `{wallet}-{chain}-{account}`, and the key the ceremony aggregates
 * under (bitcoin: the BIP-86 output key). Derived from this device's share
 * with the same core-wasm call signing uses. Offscreen-only (needs WASM).
 */
import type { KeyShareData } from "@stars-labs/types/keystore";
import { toEngineKeystoreJson } from "./engineKeystore";
import { curveForChain } from "./wallet-id";

export async function deriveAccountGroupKey(
    keyShare: KeyShareData,
    target: { chain: string; account: number },
): Promise<string> {
    const curve = curveForChain(target.chain);
    if (!curve) throw new Error(`Unsupported chain: ${target.chain}`);
    if (curve !== keyShare.curve) {
        throw new Error(`Wallet is ${keyShare.curve}; ${target.chain} signs with ${curve}`);
    }
    const wasm = await import("@stars-labs/core-wasm");
    const path = wasm.standard_account_path(target.chain, target.account);
    if (!path) throw new Error(`No standard path for ${target.chain}`);
    const parent = toEngineKeystoreJson(keyShare);
    const instance = curve === "secp256k1" ? new wasm.FrostDkgSecp256k1() : new wasm.FrostDkgEd25519();
    try {
        instance.import_keystore(
            curve === "secp256k1"
                ? wasm.derive_child_keystore_secp256k1(parent, path)
                : wasm.derive_child_keystore_ed25519(parent, path),
        );
        return instance.get_group_public_key();
    } finally {
        instance.free();
    }
}
