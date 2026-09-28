// L3c interop: a CLI PROPOSES signings for an HD account; the extension
// co-signs. 2-of-3 runs two consecutive signings (the second exercises the
// CLI's frame resends from the first; the auto-joining `serve` peer used for
// 3-of-3 handles one signing per session), and 3-of-3 (INTEROP_THRESHOLDS=2,3)
// one, for the
// ethereum-0 and bitcoin-0 accounts. The CLI (Rust engine) aggregates and
// rejects an invalid extension share; bitcoin signatures are also checked as
// BIP-340 against the wallet's bc1p address.
import { test, expect } from "./fixtures";
import { execFileSync } from "node:child_process";
import { startPeers, runCli, CLI_BIN } from "./cli-peers";
import { acceptInvitation, approveSigningRequest, dkgResult, saveWallet } from "./extension-actions";
import { setupExtension, CURVE, PASSWORD, type Env } from "./scenario";
import { schnorrVerify, segwitV1Program } from "../helpers/bip340";
import type { Page } from "@playwright/test";

test.describe.configure({ timeout: 300_000 });
// secp256k1 accounts only (ethereum / bitcoin): runs in the secp256k1 job.
test.skip(CURVE !== "secp256k1", "secp256k1 accounts");
// 3-of-3 needs the joiner to use the session's threshold (#72); until that
// lands a 3-of-3 CLI-created DKG with the extension fails before signing.
const THRESHOLDS = (process.env.INTEROP_THRESHOLDS ?? "2").split(",").map(Number);

const walletIdOf = (out: string) => /Wallet ID:\s+(\S+)/.exec(out)?.[1];

async function lastSignature(page: Page): Promise<string | null> {
  const sig = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "getState" }).then((s) => s?.lastSignature?.signature ?? null),
  );
  return sig ? String(sig).replace(/^0x/, "").toLowerCase() : null;
}

for (const threshold of THRESHOLDS) {
  for (const chain of ["ethereum", "bitcoin"] as const) {
    test(`CLI proposes ${chain}-0 signings on a ${threshold}-of-3 wallet; the extension co-signs`, async ({ page, context, extensionId }) => {
      let env: Env | undefined;
      try {
        env = await setupExtension(page, context, extensionId);
        env.peers = startPeers({ count: 1, signal: env.signal, room: env.room, curve: "secp256k1", password: PASSWORD });
        const cli = { deviceId: "interop-creator", signal: env.signal, room: env.room, password: PASSWORD };
        const creator = runCli({
          ...cli,
          args: ["wallet", "create", "--threshold", String(threshold), "--total", "3", "--curve", "secp256k1", "--timeout", "120"],
        });
        await acceptInvitation(page);
        const walletId = walletIdOf(await creator.done)!;
        await dkgResult(page);
        await saveWallet(page, PASSWORD);

        // 2-of-3: with the serve peer offline the signer set is {creator, extension}.
        if (threshold === 2) env.peers[0].kill();

        let previous: string | null = null;
        const messages = threshold === 2 ? ["11".repeat(32), "22".repeat(32)] : ["11".repeat(32)];
        for (const [i, message] of messages.entries()) {
          const signer = runCli({
            ...cli,
            keystore: creator.keystore,
            args: [
              "sign", "--wallet-id", walletId, "--chain", chain, "--account", "0",
              "--message", message, "--encoding", "hex", "--curve", "secp256k1", "--timeout", "120", "--json",
            ],
          });
          await approveSigningRequest(page);
          const out = await signer.done;
          const cliSig = /"signature"\s*:\s*"(?:0x)?([0-9a-f]+)"/.exec(out)?.[1];
          expect(cliSig, `signing #${i + 1}: no signature in CLI output: ${out}`).toBeTruthy();
          await expect.poll(() => lastSignature(page), { timeout: 60_000 }).not.toBe(previous);
          expect(await lastSignature(page), `signing #${i + 1}`).toBe(cliSig);
          previous = cliSig!;

          if (chain === "bitcoin") {
            const hash = /"message_hash"\s*:\s*"(?:0x)?([0-9a-f]+)"/.exec(out)?.[1] ?? message;
            // Public derivation, no password / network.
            const accounts = execFileSync(CLI_BIN, [
              "wallet", "accounts", "--wallet-id", walletId, "--count", "1",
              "--device-id", cli.deviceId, "--keystore", creator.keystore,
            ]).toString();
            const bc1p = /bc1p[02-9ac-hj-np-z]+/.exec(accounts)?.[0];
            expect(bc1p, `no bc1p address in: ${accounts}`).toBeTruthy();
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
}
