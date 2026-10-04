import { recoverAddress } from "viem";

/** Verify the already-hashed EIP-191 message against its wallet address. */
export async function verifyEthereumSignature(messageHex: string, signature: string, address: string) {
    try {
        const recovered = await recoverAddress({
            hash: `0x${messageHex.replace(/^0x/, "")}`,
            signature: `0x${signature.replace(/^0x/, "")}`,
        });
        return {verified: !!address && recovered.toLowerCase() === address.toLowerCase(), recovered};
    } catch {
        return {verified: false};
    }
}
