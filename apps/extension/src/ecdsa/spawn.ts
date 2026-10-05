import type { WorkerLike } from "./protocol";

/** A fresh ECDSA Web Worker (offscreen document only — service workers
 * can't spawn workers). Vite bundles `ceremony.worker.ts` + the wasm. */
export function spawnEcdsaWorker(): WorkerLike {
    return new Worker(new URL("./ceremony.worker.ts", import.meta.url), {
        type: "module",
        name: "starlab-ecdsa",
    }) as unknown as WorkerLike;
}
