// Orchestrate CLI co-signer peers for the L3c interop harness (#33).
//
// Reuses the verified `scripts/demo/serve_autojoin.py` reactive driver: each
// peer spawns a `starlab-cli serve` node that auto-joins the DKG session the
// EXTENSION creates and auto-approves signing. We parse the driver's
// machine-readable `RESULT <node> dkg_complete <wallet> <addr> <groupkey>` /
// `RESULT <node> signature_complete <hash> <sig>` lines.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The CLI + its driver live in stars-labs/starlab-mpc; by default a sibling
// checkout of this repo. Override with STARLAB_MPC_DIR.
const MPC_DIR = process.env.STARLAB_MPC_DIR ?? path.resolve(HERE, "../../../../../starlab-mpc");
const DRIVER = path.join(MPC_DIR, "scripts/demo/serve_autojoin.py");
export const CLI_BIN = process.env.STARLAB_CLI_BIN ?? path.join(MPC_DIR, "target/release/starlab-cli");
const SIGNAL_BIN = process.env.STARLAB_SIGNAL_BIN ?? path.join(MPC_DIR, "target/release/starlab-signal-server");

export type DkgResult = { wallet: string; address: string; groupKey: string };

export type Peer = {
  deviceId: string;
  proc: ChildProcess;
  keystore: string;
  /** Resolves when this peer reports DKG complete. */
  dkg: Promise<DkgResult>;
  /** Resolves when this peer reports a completed signature. */
  signature: Promise<{ hash: string; sig: string }>;
  /** Stop the node but retain its encrypted share for a fresh CLI process. */
  stop(): Promise<void>;
  kill(): void;
};

/**
 * INSECURE, TESTS ONLY: published ECDSA safe primes (starlab-core's
 * testdata, three distinct sets) so a secp256k1 DKG doesn't spend minutes
 * generating them. Set 0 goes to the extension, set i to CLI peer i.
 */
const PRIME_SETS: unknown[] = JSON.parse(
  fs.readFileSync(path.resolve(HERE, "../fixtures/ecdsa/insecure-test-primes.json"), "utf8"),
);

/** Primes JSON (one `starlab_core::ecdsa::Primes`) for party `i`. */
export function insecureTestPrimes(i: number): string {
  return JSON.stringify(PRIME_SETS[i % PRIME_SETS.length]);
}

/**
 * A `starlab-cli` stand-in for `serve_autojoin.py --cli`: runs the real CLI
 * with the hidden `serve --insecure-test-primes <file>` flag added.
 */
function cliWithTestPrimes(i: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interop-primes-"));
  const primes = path.join(dir, "primes.json");
  fs.writeFileSync(primes, insecureTestPrimes(i));
  const wrapper = path.join(dir, "starlab-cli");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${CLI_BIN}" "$@" --insecure-test-primes "${primes}"\n`, { mode: 0o755 });
  return wrapper;
}

/** A fresh strong room id (≥16 chars, the worker's requirement). */
export function freshRoom(): string {
  return "interop-" + crypto.randomBytes(12).toString("hex");
}

export function ensurePrereqs(): void {
  if (!fs.existsSync(CLI_BIN)) {
    throw new Error(
      `CLI binary not found at ${CLI_BIN}. Run \`cargo build --release -p starlab-cli\` in starlab-mpc (or set STARLAB_MPC_DIR).`,
    );
  }
  if (!fs.existsSync(DRIVER)) {
    throw new Error(`serve_autojoin.py not found at ${DRIVER}.`);
  }
}

/**
 * Spawn `count` CLI co-signer peers on `room`/`signal`, each with an isolated
 * keystore and the shared `password`. They auto-join the extension's DKG.
 */
export function startPeers(opts: {
  count: number;
  signal: string;
  room: string;
  password: string;
}): Peer[] {
  ensurePrereqs();
  const peers: Peer[] = [];
  for (let i = 1; i <= opts.count; i++) {
    // Unique per run: a peer left over from an aborted run keeps its
    // registration on the signal server, and a duplicate id breaks the mesh.
    const deviceId = `interop-cli-${opts.room.slice(-6)}-${i}`;
    const keystore = fs.mkdtempSync(path.join(os.tmpdir(), `interop-ks-${i}-`));
    const pwVar = `MPC_INTEROP_PW_${i}`;

    const proc = spawn(
      "python3",
      [
        DRIVER,
        "--device-id", deviceId,
        "--keystore", keystore,
        "--signal", opts.signal,
        "--room", opts.room,
        "--curve", "unified",
        "--cli", cliWithTestPrimes(i),
        "--pw-var", pwVar,
      ],
      { env: { ...process.env, [pwVar]: opts.password }, stdio: ["ignore", "pipe", "pipe"] },
    );

    let resolveDkg!: (r: DkgResult) => void;
    let resolveSig!: (r: { hash: string; sig: string }) => void;
    const dkg = new Promise<DkgResult>((r) => (resolveDkg = r));
    const signature = new Promise<{ hash: string; sig: string }>((r) => (resolveSig = r));

    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // Mirror to test output for debugging.
        if (line) console.log(line);
        const parts = line.split(/\s+/);
        if (parts[0] === "RESULT" && parts[2] === "dkg_complete") {
          resolveDkg({ wallet: parts[3], address: parts[4], groupKey: parts[5] });
        } else if (parts[0] === "RESULT" && parts[2] === "signature_complete") {
          resolveSig({ hash: parts[3], sig: parts[4] });
        }
      }
    });
    proc.stderr!.on("data", (d: Buffer) => console.error(`[${deviceId}:err] ${d}`));

    const peer: Peer = {
      deviceId,
      proc,
      keystore,
      dkg,
      signature,
      async stop() {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        await new Promise<void>((resolve, reject) => {
          proc.once("exit", () => resolve());
          proc.once("error", reject);
          proc.kill("SIGINT");
        });
      },
      kill() {
        proc.kill("SIGTERM");
        try { fs.rmSync(keystore, { recursive: true, force: true }); } catch { /* best effort */ }
      },
    };
    live.add(peer);
    peers.push(peer);
  }
  return peers;
}

/**
 * Start a private signal server on a free local port. The server keeps
 * sessions announced by earlier runs, and CLI peers auto-join any DKG they
 * see — so a shared server lets a stale session capture them. A fresh one
 * per test keeps runs independent.
 */
export async function startSignalServer(): Promise<{ url: string; kill(): void; restart(): Promise<void> }> {
  if (!fs.existsSync(SIGNAL_BIN)) {
    throw new Error(
      `Signal server not found at ${SIGNAL_BIN}. Run \`cargo build --release -p starlab-signal-server\` in starlab-mpc.`,
    );
  }
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
  const launch = async () => {
    const proc = spawn(SIGNAL_BIN, [], {
      env: { ...process.env, MPC_SIGNAL_BIND: `127.0.0.1:${port}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      proc.stderr!.on("data", (d: Buffer) => {
        if (d.toString().includes("listening")) resolve();
      });
      proc.once("exit", (code) => reject(new Error(`signal server exited with ${code}`)));
    });
    return proc;
  };
  let proc = await launch();
  const server = {
    url: `ws://127.0.0.1:${port}`,
    kill: () => proc.kill("SIGTERM"),
    /** Simulate an outage: stop, then come back on the same address. */
    async restart() {
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
      });
      proc = await launch();
    },
  };
  live.add(server);
  return server;
}

/**
 * Run a one-shot `starlab-cli` command (e.g. `wallet create`, `sign`) as a
 * device with its own keystore. Resolves with its stdout once it exits 0.
 */
export function runCli(opts: {
  args: string[];
  deviceId: string;
  keystore?: string;
  signal: string;
  room: string;
  password: string;
}): { keystore: string; done: Promise<string>; kill(): void } {
  ensurePrereqs();
  const keystore = opts.keystore ?? fs.mkdtempSync(path.join(os.tmpdir(), `interop-ks-${opts.deviceId}-`));
  const proc = spawn(
    CLI_BIN,
    [
      ...opts.args,
      "--device-id", opts.deviceId,
      "--keystore", keystore,
      "--signal-server", opts.signal,
      "--room", opts.room,
      "--password-env", "MPC_INTEROP_PW",
      // INTEROP_CLI_LOG=info (debug aid) for the CLI's own protocol logs.
      "--log-level", process.env.INTEROP_CLI_LOG ?? "warn",
    ],
    { env: { ...process.env, MPC_INTEROP_PW: opts.password }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  proc.stdout!.on("data", (d: Buffer) => {
    out += d.toString();
    console.log(`[${opts.deviceId}] ${d.toString().trimEnd()}`);
  });
  proc.stderr!.on("data", (d: Buffer) => console.error(`[${opts.deviceId}:err] ${d.toString().trimEnd()}`));
  const done = new Promise<string>((resolve, reject) => {
    proc.once("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`starlab-cli ${opts.args.join(" ")} exited ${code}`)),
    );
  });
  const handle = { keystore, done, kill: () => proc.kill("SIGTERM") };
  live.add(handle);
  return handle;
}

// A run killed from outside (Ctrl-C, CI timeout) skips the spec's `finally`.
const live = new Set<{ kill(): void }>();
process.once("exit", () => live.forEach((p) => p.kill()));

export function killPeers(peers: Peer[]): void {
  for (const p of peers) p.kill();
}

/** Public encrypted-file headers only: never decrypt or log a private share. */
export function nativeGroupKeys(keystore: string, deviceId: string, walletId: string) {
  const key = (curve: string): string => {
    const file = path.join(keystore, deviceId, curve, `${walletId}.json`);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const group = value.metadata?.group_public_key;
    if (typeof group !== "string" || !/^[0-9a-f]+$/i.test(group)) {
      throw new Error(`Missing public group key for ${curve}`);
    }
    return group.toLowerCase();
  };
  return { ed25519: key("ed25519"), secp256k1: key("secp256k1"), ecdsa: key("secp256k1-ecdsa") };
}
