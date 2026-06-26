import { Buffer } from "buffer/index.js";

// Ledger's browser packages still expect Buffer on globalThis in a few
// transitive paths. Install the browser implementation before Ledger loads.
const globalWithBuffer = globalThis as any;

if (!globalWithBuffer.Buffer) {
    globalWithBuffer.Buffer = Buffer;
}

export { Buffer };
