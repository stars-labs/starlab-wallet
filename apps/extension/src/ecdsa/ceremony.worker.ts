/**
 * Web Worker running one threshold-ECDSA job (safe prime / DKG / signing)
 * off the offscreen document's thread — cggmp24's Paillier and ZK math
 * blocks for seconds to minutes. Spawned by `spawnEcdsaWorker`.
 */
import wasmInit, * as wasm from "@stars-labs/core-wasm";
import { workerHost, type HostWasm } from "./workerHost";
import type { FromWorker, ToWorker } from "./protocol";

const scope = self as unknown as {
    postMessage(m: FromWorker): void;
    onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
};

const handle = workerHost(
    async () => {
        await wasmInit();
        return wasm as unknown as HostWasm;
    },
    (m) => scope.postMessage(m),
);

scope.onmessage = (ev) => handle(ev.data);
