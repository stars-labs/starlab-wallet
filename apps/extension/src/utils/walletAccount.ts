import { isEvmChain, isSupportedChain, normalizeDerivedAddressChain } from "@stars-labs/types/appstate";
import type { AppState } from "@stars-labs/types/appstate";

/** Public derivation parents must travel together for live DKG and saved wallets. */
export function publicWalletState(state: Partial<AppState>) {
    return {
        dkgAddress: state.dkgAddress ?? "",
        dkgGroupPublicKey: state.dkgGroupPublicKey ?? "",
        ecdsaGroupPublicKey: state.ecdsaGroupPublicKey ?? "",
    };
}

/** A missing account on one chain must never display another chain's address. */
export function addressForChain(
    addresses: { chain: string; address: string }[],
    chain: string | undefined,
): string | undefined {
    const desired = isSupportedChain(chain) ? chain : "ethereum";
    const normalized = addresses.map((addr) => ({
        ...addr, chain: normalizeDerivedAddressChain(addr.chain) ?? addr.chain.toLowerCase(),
    }));
    return normalized.find((addr) => addr.chain === desired)?.address ??
        (isEvmChain(desired) ? normalized.find((addr) => addr.chain === "ethereum")?.address : undefined);
}
