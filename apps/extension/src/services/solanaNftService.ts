/**
 * Solana NFT display (#20) — Metaplex Token Metadata.
 *
 * No indexer needed: getTokenAccountsByOwner lists every SPL token account,
 * and the classic NFT heuristic (amount == 1 && decimals == 0) picks the
 * NFTs out. Each mint's display data lives in the Metaplex metadata PDA —
 * seeds ["metadata", program_id, mint] under the Token Metadata program —
 * decoded with a minimal borsh reader (we only need name/symbol/uri; the
 * trailing creators/etc are skipped). The uri JSON supplies the image,
 * ipfs-normalized like the EVM path.
 *
 * RPC is a thin injected (method, params) → result function so tests mock
 * it without any network or web3.js Connection machinery.
 */
import { PublicKey } from "@solana/web3.js";
import { normalizeUri, type NftItem } from "./nftService";

/** Metaplex Token Metadata program (mainnet/devnet — same id everywhere). */
export const METAPLEX_METADATA_PROGRAM =
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/** SPL Token program. */
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** JSON-RPC `result` for a given method — injectable for tests. */
export type SolanaRpc = (method: string, params: unknown[]) => Promise<any>;

/** Build a SolanaRpc over plain fetch (no Connection — keeps bundles lean). */
export function makeSolanaRpc(
  url: string,
  fetchFn: typeof fetch = globalThis.fetch,
): SolanaRpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) throw new Error(`Solana RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message}`);
    return body.result;
  };
}

/**
 * Mints that look like NFTs in the owner's wallet: every SPL token account
 * with amount == 1 and decimals == 0. (Fungibles have decimals; SFTs with
 * amount > 1 are out of scope for a gallery.)
 */
export async function discoverSolanaNftMints(
  rpc: SolanaRpc,
  owner: string,
): Promise<string[]> {
  const result = await rpc("getTokenAccountsByOwner", [
    owner,
    { programId: SPL_TOKEN_PROGRAM },
    { encoding: "jsonParsed" },
  ]);
  const mints: string[] = [];
  for (const entry of result?.value ?? []) {
    const info = entry?.account?.data?.parsed?.info;
    const amt = info?.tokenAmount;
    if (info?.mint && amt?.amount === "1" && amt?.decimals === 0) {
      mints.push(info.mint);
    }
  }
  return [...new Set(mints)];
}

/** Metadata PDA for a mint: ["metadata", program, mint] under the program. */
export function metadataPda(mint: string): string {
  const program = new PublicKey(METAPLEX_METADATA_PROGRAM);
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("metadata"), program.toBytes(), new PublicKey(mint).toBytes()],
    program,
  );
  return pda.toBase58();
}

/**
 * Decode the head of a Metaplex Metadata account (borsh):
 * key(u8) + update_authority(32) + mint(32) + name + symbol + uri,
 * each string = u32-LE length prefix + bytes, null-padded on chain.
 */
export function decodeMetaplexMetadata(data: Uint8Array): {
  name: string;
  symbol: string;
  uri: string;
} {
  let off = 1 + 32 + 32; // key + update_authority + mint
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const readString = (): string => {
    if (off + 4 > data.length) throw new Error("metadata truncated");
    const len = view.getUint32(off, true);
    off += 4;
    if (off + len > data.length) throw new Error("metadata truncated");
    const bytes = data.subarray(off, off + len);
    off += len;
    // On-chain strings are padded to fixed width with NULs — strip them.
    return new TextDecoder().decode(bytes).replace(/\0+$/, "");
  };
  const name = readString();
  const symbol = readString();
  const uri = readString();
  return { name, symbol, uri };
}

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Full display item for one mint: PDA → account → borsh head → uri JSON
 * (image, ipfs-normalized). Per-mint failures degrade to a mint-only card.
 */
export async function fetchSolanaNft(
  rpc: SolanaRpc,
  mint: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<NftItem> {
  const item: NftItem = { contract: mint, tokenId: 0n, standard: "metaplex" };
  try {
    const info = await rpc("getAccountInfo", [metadataPda(mint), { encoding: "base64" }]);
    const b64 = info?.value?.data?.[0];
    if (!b64) return item; // no metadata account — bare mint
    const meta = decodeMetaplexMetadata(b64ToBytes(b64));
    item.name = meta.name || undefined;
    item.collection = meta.symbol || undefined;
    if (meta.uri) {
      const res = await fetchFn(normalizeUri(meta.uri));
      if (res.ok) {
        const json = (await res.json()) as { name?: string; image?: string };
        if (json.name) item.name = json.name;
        if (json.image) item.image = normalizeUri(json.image);
      }
    }
  } catch {
    /* metadata unreachable — render mint-only */
  }
  return item;
}

/** One-call gallery load: mints → metadata items (parallel, fault-tolerant). */
export async function loadSolanaNfts(
  rpc: SolanaRpc,
  owner: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<NftItem[]> {
  const mints = await discoverSolanaNftMints(rpc, owner);
  return Promise.all(mints.map((m) => fetchSolanaNft(rpc, m, fetchFn)));
}
