import { it, expect } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { hashMessage } from "viem";
import { verifyEthereumSignature } from "../../src/utils/signatureVerification";
it("checks a recoverable EIP-191 signature against the actual wallet address", async () => {
    const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
    const hash = hashMessage("threshold result");
    const signature = await account.sign({hash});
    expect((await verifyEthereumSignature(hash, signature, account.address)).verified).toBe(true);
    expect((await verifyEthereumSignature(hash, signature, `0x${"2".repeat(40)}`)).verified).toBe(false);
    expect((await verifyEthereumSignature(hashMessage("other"), signature, account.address)).verified).toBe(false);
    expect((await verifyEthereumSignature(hash, "bad", account.address)).verified).toBe(false);
});
