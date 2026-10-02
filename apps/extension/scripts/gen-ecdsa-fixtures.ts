// Generate a 2-of-3 threshold-ECDSA wallet (INSECURE fixture primes —
// test-only key material) for unit tests that need a valid ECDSA key share
// without running the minutes-long aux-info ceremony themselves.
//
//   bun run scripts/gen-ecdsa-fixtures.ts     (from apps/extension, ~6 min)
//
// Writes tests/fixtures/ecdsa/wallet-2of3.json:
//   { participants, threshold, group_public_key, shares: [shareJson × 3] }
import wasmInit, * as wasm from "@stars-labs/core-wasm";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CeremonyJob, type EcdsaWasm } from "../src/ecdsa/driver";

await wasmInit();
const dir = join(import.meta.dir, "../tests/fixtures/ecdsa");
const sets: { primes: unknown[] }[] = JSON.parse(readFileSync(join(dir, "insecure-test-primes.json"), "utf8"));
const participants = ["device-a", "device-b", "device-c"];
const threshold = 2;

const queue: (readonly [number, number, Uint8Array])[] = [];
const jobs: CeremonyJob[] = participants.map(
    (_, index) =>
        new CeremonyJob(
            wasm as unknown as EcdsaWasm,
            {
                kind: "dkg",
                sessionId: "dkg_fixture_ecdsa",
                participants,
                index,
                threshold,
                primesJson: wasm.ecdsa_primes_from_parts(JSON.stringify(sets[index].primes)),
            },
            (m) => queue.push(...m.to.map((to) => [index, to, m.payload] as const)),
        ),
);
jobs.forEach((j) => j.start());
while (queue.length > 0) {
    const [from, to, payload] = queue.shift()!;
    jobs[to].receive(from, payload);
}
const shares = await Promise.all(jobs.map((j) => j.result));
const info = JSON.parse(wasm.ecdsa_share_info(shares[0]));
writeFileSync(
    join(dir, "wallet-2of3.json"),
    JSON.stringify({ participants, threshold, group_public_key: info.group_public_key, shares }, null, 2) + "\n",
);
console.log(`wrote wallet-2of3.json (group ${info.group_public_key})`);
