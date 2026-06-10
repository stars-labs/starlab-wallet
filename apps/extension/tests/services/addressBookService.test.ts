/**
 * addressBookService tests — contact CRUD round-trip + the recipient resolver
 * (0x passthrough, ENS resolution, unresolvable/garbage must throw — never
 * silently send to a bad parse).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  AddressBookService,
  resolveRecipient,
} from "../../src/services/addressBookService";

const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function fresh(): AddressBookService {
  const svc = AddressBookService.getInstance();
  (svc as any).contacts = {};
  (svc as any).loaded = false;
  return svc;
}

describe("AddressBookService", () => {
  beforeEach(() => {
    fresh();
  });

  it("adds, lists (name-sorted), labels, removes", async () => {
    const svc = AddressBookService.getInstance();
    await svc.add({ name: "Bob", address: ADDR });
    await svc.add({ name: "Alice", address: "0x1111111111111111111111111111111111111111" });
    const list = await svc.list();
    expect(list.map((c) => c.name)).toEqual(["Alice", "Bob"]);
    expect(await svc.labelFor(ADDR.toUpperCase())).toBe("Bob"); // case-insensitive
    await svc.remove(ADDR);
    expect(await svc.labelFor(ADDR)).toBeUndefined();
  });

  it("same chain+address overwrites (rename), different chain coexists", async () => {
    const svc = AddressBookService.getInstance();
    await svc.add({ name: "Old", address: ADDR });
    await svc.add({ name: "New", address: ADDR });
    expect((await svc.list()).length).toBe(1);
    expect(await svc.labelFor(ADDR)).toBe("New");
    await svc.add({ name: "SolBob", address: ADDR, chain: "solana" });
    expect((await svc.list()).length).toBe(2);
    expect((await svc.list("solana"))[0].name).toBe("SolBob");
  });

  it("persists through storage reload", async () => {
    const svc = AddressBookService.getInstance();
    await svc.add({ name: "Bob", address: ADDR });
    (svc as any).loaded = false;
    (svc as any).contacts = {};
    expect(await svc.labelFor(ADDR)).toBe("Bob");
  });
});

describe("resolveRecipient", () => {
  const client = {
    getEnsAddress: async ({ name }: { name: string }) =>
      name === "vitalik.eth" ? ADDR : null,
  } as any;

  it("0x address passes through", async () => {
    const r = await resolveRecipient(client, ` ${ADDR} `);
    expect(r).toEqual({ address: ADDR });
  });

  it("ENS name resolves (lowercased) and reports the name", async () => {
    const r = await resolveRecipient(client, "Vitalik.ETH");
    expect(r.address).toBe(ADDR);
    expect(r.ens).toBe("vitalik.eth");
  });

  it("unresolvable ENS throws", async () => {
    await expect(resolveRecipient(client, "nobody.eth")).rejects.toThrow("does not resolve");
  });

  it("garbage input throws (never a silent bad send)", async () => {
    await expect(resolveRecipient(client, "0x123")).rejects.toThrow();
    await expect(resolveRecipient(client, "hello")).rejects.toThrow();
  });
});
