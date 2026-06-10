/**
 * Address book + name resolution (#25).
 *
 * - **Contacts**: named addresses persisted in chrome.storage, deduped by
 *   (chain, address). The send form offers them as quick picks; anywhere an
 *   address is shown the label can be substituted.
 * - **ENS**: `resolveRecipient` turns "vitalik.eth" into an address via the
 *   supplied viem client (`getEnsAddress` — mainnet resolution regardless of
 *   the send network, which is how every major wallet treats ENS). Plain 0x
 *   addresses pass through untouched. SNS (Solana) is a follow-up; the
 *   resolver shape already allows another backend.
 */
import type { PublicClient } from "viem";

export interface Contact {
  name: string;
  address: string;
  /** "ethereum" | "solana" — display/scoping hint, not enforced. */
  chain?: string;
  note?: string;
}

const STORAGE_KEY = "wallet_address_book";

function keyOf(c: Pick<Contact, "address" | "chain">): string {
  return `${c.chain ?? "ethereum"}:${c.address.toLowerCase()}`;
}

export class AddressBookService {
  private static instance: AddressBookService;
  private contacts: Record<string, Contact> = {};
  private loaded = false;

  static getInstance(): AddressBookService {
    if (!AddressBookService.instance) AddressBookService.instance = new AddressBookService();
    return AddressBookService.instance;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (typeof chrome !== "undefined" && chrome.storage) {
      const res = await chrome.storage.local.get([STORAGE_KEY]);
      this.contacts = (res[STORAGE_KEY] as Record<string, Contact>) ?? {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (typeof chrome !== "undefined" && chrome.storage) {
      await chrome.storage.local.set({ [STORAGE_KEY]: this.contacts });
    }
  }

  /** Add or update (same chain+address overwrites — rename-friendly). */
  async add(contact: Contact): Promise<void> {
    await this.ensureLoaded();
    this.contacts[keyOf(contact)] = contact;
    await this.persist();
  }

  async remove(address: string, chain?: string): Promise<void> {
    await this.ensureLoaded();
    delete this.contacts[keyOf({ address, chain })];
    await this.persist();
  }

  /** All contacts, name-sorted. Optional chain filter. */
  async list(chain?: string): Promise<Contact[]> {
    await this.ensureLoaded();
    return Object.values(this.contacts)
      .filter((c) => chain === undefined || (c.chain ?? "ethereum") === chain)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Label for an address if the user saved one (case-insensitive). */
  async labelFor(address: string, chain?: string): Promise<string | undefined> {
    await this.ensureLoaded();
    return this.contacts[keyOf({ address, chain })]?.name;
  }
}

export interface ResolvedRecipient {
  /** The 0x address to send to. */
  address: string;
  /** The ENS name it came from, when input was a name. */
  ens?: string;
}

/**
 * Resolve a recipient input: 0x address passes through (checksum untouched);
 * an ENS name (contains a dot, no 0x prefix) resolves via the client. Throws
 * on an unresolvable name or unrecognizable input — the caller surfaces it
 * pre-sign, never silently sends to garbage.
 */
export async function resolveRecipient(
  client: Pick<PublicClient, "getEnsAddress">,
  input: string,
): Promise<ResolvedRecipient> {
  const trimmed = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { address: trimmed };
  }
  if (!trimmed.startsWith("0x") && trimmed.includes(".")) {
    const address = await client.getEnsAddress({ name: trimmed.toLowerCase() });
    if (!address) throw new Error(`ENS name ${trimmed} does not resolve`);
    return { address, ens: trimmed.toLowerCase() };
  }
  throw new Error("Enter a 0x address or an ENS name");
}
