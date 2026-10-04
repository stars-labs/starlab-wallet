// L3c interop: a CLI PROPOSES signings for HD accounts; the extension
// co-signs. One CLI-created wallet per threshold signs ethereum-0 (threshold
// ECDSA: READY/SET/DONE, the signature must ecrecover to the wallet's
// Ethereum address) and bitcoin-0 (FROST BIP-340 for the bc1p address). On
// 2-of-3 the ethereum account signs twice (consecutive ceremonies) with the
// serve peer offline, so the signer set is always {creator, extension}.
import { test, expect } from "./fixtures";
import { execFileSync } from "node:child_process";
import { recoverAddress } from "viem";
import { startPeers, runCli, CLI_BIN } from "./cli-peers";
import { acceptInvitation, approveSigningRequest, dkgResult, saveWallet } from "./extension-actions";
import { setupExtension, CURVE, PASSWORD, CLI_TIMEOUT_S, specTimeout, extensionEthereumAddress, type Env } from "./scenario";
import { schnorrVerify, segwitV1Program } from "../helpers/bip340";
import type { Page } from "@playwright/test";

test.describe.configure({ timeout: specTimeout(1) + 300_000 });
// secp256k1 accounts only (ethereum / bitcoin): runs in the secp256k1 job.
test.skip(CURVE !== "secp256k1", "secp256k1 accounts");

const walletIdOf = (out: string) => /Wallet ID:\s+(\S+)/.exec(out)?.[1];

async function lastSignature(page: Page): Promise<string | null> {
  const sig = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "getState" }).then((s) => s?.lastSignature?.signature ?? null),
  );
  return sig ? String(sig).replace(/^0x/, "").toLowerCase() : null;
}

for (const threshold of [2, 3]) {
  test(`CLI proposes ethereum-0 and bitcoin-0 signings on a ${threshold}-of-3 wallet; the extension co-signs`, async ({ page, context, extensionId }) => {
    let env: Env | undefined;
    try {
      env = await setupExtension(page, context, extensionId);
      env.peers = startPeers({ count: 1, signal: env.signal, room: env.room, curve: "secp256k1", password: PASSWORD });
      const cli = { deviceId: "interop-creator", signal: env.signal, room: env.room, password: PASSWORD };
      const creator = runCli({
        ...cli,
        args: ["wallet", "create", "--threshold", String(threshold), "--total", "3", "--curve", "secp256k1", "--timeout", CLI_TIMEOUT_S],
      });
      await acceptInvitation(page);
      const walletId = walletIdOf(await creator.done)!;
      await dkgResult(page);
      await saveWallet(page, PASSWORD);
      const ethAddress = await extensionEthereumAddress(page);
      // Public derivation, no password / network: the CLI's account-0 list.
      const accounts = execFileSync(CLI_BIN, [
        "wallet", "accounts", "--wallet-id", walletId, "--count", "1",
        "--device-id", cli.deviceId, "--keystore", creator.keystore,
      ]).toString();
      // (Its Ethereum row is only right from starlab-mpc 5f4b7bc on; the
      // ecrecover checks below pin the Ethereum account instead.)
      const bc1p = /bc1p[02-9ac-hj-np-z]+/.exec(accounts)?.[0];
      expect(bc1p, `no bc1p address in: ${accounts}`).toBeTruthy();

      // 2-of-3: with the serve peer offline the signer set is {creator, extension}.
      if (threshold === 2) env.peers[0].kill();

      const signings: { chain: "ethereum" | "bitcoin"; message: string }[] =
        threshold === 2
          ? [
              { chain: "ethereum", message: "11".repeat(32) },
              { chain: "ethereum", message: "22".repeat(32) },
              { chain: "bitcoin", message: "33".repeat(32) },
            ]
          : [
              { chain: "ethereum", message: "11".repeat(32) },
              { chain: "bitcoin", message: "33".repeat(32) },
            ];
      let previous: string | null = null;
      for (const [i, { chain, message }] of signings.entries()) {
        const signer = runCli({
          ...cli,
          keystore: creator.keystore,
          args: [
            "sign", "--wallet-id", walletId, "--chain", chain, "--account", "0",
            "--message", message, "--encoding", "hex", "--curve", "secp256k1", "--timeout", "180", "--json",
          ],
        });
        await approveSigningRequest(page);
        const out = await signer.done;
        const cliSig = /"signature"\s*:\s*"(?:0x)?([0-9a-f]+)"/.exec(out)?.[1];
        expect(cliSig, `signing #${i + 1}: no signature in CLI output: ${out}`).toBeTruthy();
        await expect.poll(() => lastSignature(page), { timeout: 120_000 }).not.toBe(previous);
        expect(await lastSignature(page), `signing #${i + 1} (${chain})`).toBe(cliSig);
        previous = cliSig!;
        const hash = /"message_hash"\s*:\s*"(?:0x)?([0-9a-f]+)"/.exec(out)?.[1] ?? message;

        if (chain === "ethereum") {
          expect(cliSig!.length, "r ‖ s ‖ v").toBe(130);
          const recovered = await recoverAddress({ hash: `0x${hash}`, signature: `0x${cliSig}` });
          expect(recovered.toLowerCase(), "ecrecover == the wallet's Ethereum address").toBe(ethAddress);
        } else {
          expect(
            schnorrVerify(segwitV1Program(bc1p!), Buffer.from(hash, "hex"), Buffer.from(cliSig!, "hex")),
            "BIP-340 signature for the bc1p address",
          ).toBe(true);
        }
      }
    } finally {
      env?.cleanup();
    }
  });
}
