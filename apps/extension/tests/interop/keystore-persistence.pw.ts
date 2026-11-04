// One real unified ceremony, a browser restart, and restored three-file backup.
// All private material remains encrypted; assertions inspect public headers only.
import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { recoverAddress } from "viem";
import { schnorrVerify, segwitV1Program } from "../helpers/bip340";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupExtension, extensionInitiatedDkg, extensionGroupKeys, PASSWORD, specTimeout, type Env } from "./scenario";
import { runCli } from "./cli-peers";
import { approveSigningRequest, extSignature, useSignalServer, setRoom, closeSettings } from "./extension-actions";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = process.env.STARLAB_EXTENSION_DIR ?? path.resolve(HERE, "../../.output/chrome-mv3");
async function launch(profile: string) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false, executablePath: process.env.PLAYWRIGHT_CHROME_PATH || undefined,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`,
      "--no-first-run", "--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extensionId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return { context, extensionId, page };
}

test.describe.configure({ timeout: specTimeout(1) + 600_000 });
test("unified wallet restarts, signs all four chains, and restores all three backup files", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "interop-unified-restart-"));
  const restoredProfile = fs.mkdtempSync(path.join(os.tmpdir(), "interop-unified-restore-"));
  let context: BrowserContext | undefined;
  let env: Env | undefined;
  try {
    let browser = await launch(profile); context = browser.context;
    env = await setupExtension(browser.page, context, browser.extensionId);
    await extensionInitiatedDkg(browser.page, env, { threshold: 2, cliPeers: 2 });
    const keys = await extensionGroupKeys(browser.page);
    const walletId = (await env.peers[0].dkg).wallet;
    await Promise.all(env.peers.map(peer => peer.stop()));
    await context.close();
    browser = await launch(profile); context = browser.context;
    const page = browser.page;
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lockKeystore" }));
    expect((await page.evaluate(() => chrome.runtime.sendMessage({ type: "unlockKeystore", password: "wrong-password" }))).success).toBe(false);
    expect((await page.evaluate(password => chrome.runtime.sendMessage({ type: "unlockKeystore", password }), PASSWORD)).success).toBe(true);

    // A fresh native process per curve/account loads the original encrypted
    // files. The third participant stays offline: the extension must co-sign.
    for (const chain of ["solana", "sui", "bitcoin", "ethereum"]) {
      const peer = env.peers[0];
      const signer = runCli({ deviceId: peer.deviceId, keystore: peer.keystore,
        signal: env.signal, room: env.room, password: PASSWORD,
        args: ["sign", "--wallet-id", walletId, "--chain", chain, "--account", "1",
          "--message", "42".repeat(32), "--encoding", chain === "ethereum" ? "prehash" : "hex", "--curve",
          chain === "solana" || chain === "sui" ? "ed25519" : "secp256k1", "--timeout", "180", "--json"],
      });
      await approveSigningRequest(page);
      const output = await signer.done;
      const signature = /"signature"\s*:\s*"(?:0x)?([0-9a-f]+)"/.exec(output)?.[1];
      expect(signature, `${chain} native aggregate signature`).toBeTruthy();
      await expect.poll(() => extSignature(page), { timeout: 120_000 }).toBe(signature);
      const curve = chain === "solana" || chain === "sui" ? "ed25519" : chain === "ethereum" ? "secp256k1-ecdsa" : "secp256k1";
      const groupPublicKey = curve === "ed25519" ? keys.ed25519 : curve === "secp256k1" ? keys.secp256k1 : keys.ecdsa;
      const derived = await page.evaluate(payload => chrome.runtime.sendMessage({ type: "deriveAccounts", ...payload }),
        { curve, groupPublicKey, count: 2 });
      expect(derived.success).toBe(true);
      const address = derived.accounts[1].addresses.find((entry: { chain: string }) => entry.chain.toLowerCase() === chain)?.address;
      expect(address).toBeTruthy();
      const hash = /"message_hash"\s*:\s*"(?:0x)?([0-9a-f]+)"/.exec(output)?.[1];
      expect(hash).toBe("42".repeat(32));
      if (chain === "solana") {
        const publicKey = createPublicKey({ format: "der", type: "spki",
          key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(bs58.decode(address))]) });
        expect(verify(null, Buffer.from(hash!, "hex"), publicKey, Buffer.from(signature!, "hex")), "standard Ed25519 verifier").toBe(true);
      } else if (chain === "bitcoin") {
        expect(schnorrVerify(segwitV1Program(address), Buffer.from(hash!, "hex"), Buffer.from(signature!, "hex")), "BIP-340 verifier").toBe(true);
      } else if (chain === "ethereum") {
        expect((await recoverAddress({ hash: `0x${hash}`, signature: `0x${signature}` })).toLowerCase()).toBe(address.toLowerCase());
      }
    }
    const backup = await page.evaluate(password => chrome.runtime.sendMessage({ type: "exportKeystore", password }), PASSWORD);
    expect(backup.success).toBe(true);
    expect(backup.files.map((file: { curve: string }) => file.curve).sort()).toEqual(["ed25519", "secp256k1", "secp256k1-ecdsa"]);
    const publicKeys = Object.fromEntries(backup.files.map((file: { curve: string; keystoreData: string }) =>
      [file.curve, JSON.parse(file.keystoreData).metadata.group_public_key]));
    expect(publicKeys).toEqual({ ed25519: keys.ed25519, secp256k1: keys.secp256k1, "secp256k1-ecdsa": keys.ecdsa });
    await context.close();
    browser = await launch(restoredProfile); context = browser.context;
    // Configure the same private network before import adopts the saved device
    // identity. The original profile and both serve peers are already closed.
    await useSignalServer(context.serviceWorkers()[0], env.signal);
    await setRoom(browser.page, env.room);
    await closeSettings(browser.page);
    const restored = await browser.page.evaluate(({ files, password }) => chrome.runtime.sendMessage({
      type: "importKeystore", keystoreFiles: files, password,
    }), { files: backup.files.map((file: { keystoreData: string }) => file.keystoreData), password: PASSWORD });
    expect(restored.success).toBe(true);
    expect(restored.walletId).toBe(walletId);
    const exportedAgain = await browser.page.evaluate(password => chrome.runtime.sendMessage({ type: "exportKeystore", password }), PASSWORD);
    expect(exportedAgain.success).toBe(true);
    expect(Object.fromEntries(exportedAgain.files.map((file: { curve: string; keystoreData: string }) =>
      [file.curve, JSON.parse(file.keystoreData).metadata.group_public_key]))).toEqual(publicKeys);
    // Public metadata alone cannot prove recovery: require a real signature
    // with the recovered private share and its restored participant identity.
    const peer = env.peers[0];
    const restoredSigner = runCli({ deviceId: peer.deviceId, keystore: peer.keystore,
      signal: env.signal, room: env.room, password: PASSWORD,
      args: ["sign", "--wallet-id", walletId, "--chain", "ethereum", "--account", "1",
        "--message", "53".repeat(32), "--encoding", "prehash", "--curve", "secp256k1", "--timeout", "180", "--json"],
    });
    await approveSigningRequest(browser.page);
    const restoredOutput = await restoredSigner.done;
    const restoredSignature = /"signature"\s*:\s*"(?:0x)?([0-9a-f]+)"/.exec(restoredOutput)?.[1];
    expect(restoredSignature, "restored profile must co-sign with its original participant identity").toBeTruthy();
    await expect.poll(() => extSignature(browser.page), { timeout: 120_000 }).toBe(restoredSignature);
    const restoredAddress = await browser.page.evaluate(groupPublicKey => chrome.runtime.sendMessage({
      type: "deriveAccounts", curve: "secp256k1-ecdsa", groupPublicKey, count: 2,
    }).then(result => result.accounts[1].addresses.find((entry: { chain: string }) => entry.chain.toLowerCase() === "ethereum").address), keys.ecdsa);
    expect((await recoverAddress({ hash: `0x${"53".repeat(32)}`, signature: `0x${restoredSignature}` })).toLowerCase()).toBe(restoredAddress.toLowerCase());
  } finally {
    await context?.close(); env?.cleanup();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(restoredProfile, { recursive: true, force: true });
  }
});
