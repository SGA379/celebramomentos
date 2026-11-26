import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Wall Art selling prices are managed in Admin → Products (one price per size). Changing a price must update
// that size in place (same variant id, so past orders keep their reference); a size removed in admin is
// deactivated, never deleted; the print shop product mapping is not touched by a price change.
// (Variant ids are the real Wall Art sizes 20 x 25 cm, 30 x 40 cm and A1.)
const db = vi.hoisted(() => ({
  updates: [] as { where: { id: string }; data: { name: string; priceCents: number; attributes: Record<string, unknown>; active: boolean } }[],
  created: [] as unknown[],
  deactivated: [] as unknown[],
  productUpdates: [] as Record<string, unknown>[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/server/auth", () => ({ requireAdmin: async () => ({ error: null, admin: { id: "local-admin" } }) }));
vi.mock("@/lib/server/prisma", () => {
  const product = { id: "wall", slug: "poster-de-papel-mate", name: "Póster", kind: "WALL_ART" };
  const tx = {
    product: {
      update: async ({ data }: { data: Record<string, unknown> }) => { db.productUpdates.push(data); return product; },
      findUniqueOrThrow: async () => product,
    },
    productImage: { create: async () => ({}), deleteMany: async () => ({}) },
    productVariant: {
      findMany: async () => [{ id: "cmvpni67j0001jp088jfulnpy" }, { id: "cmvpni6vt000hjp08qhfobmh8" }, { id: "cmvpni7ja000zjp08m6zpcnmp" }],
      update: async (args: (typeof db.updates)[number]) => { db.updates.push(args); return {}; },
      create: async (args: unknown) => { db.created.push(args); return {}; },
      updateMany: async (args: unknown) => { db.deactivated.push(args); return {}; },
    },
    personalizationOption: { deleteMany: async () => ({}), createMany: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
  return { prisma: { ...tx, product: { ...tx.product, findFirst: async () => ({ kind: "WALL_ART", metadata: { photoCount: 1, provider: "GELATO" } }) }, $transaction: async (run: (client: typeof tx) => unknown) => run(tx) } };
});

import { PATCH } from "@/app/api/admin/products/route";

const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/admin/products?id=wall", { method: "PATCH", body: JSON.stringify(body) }));

beforeEach(() => { db.updates = []; db.created = []; db.deactivated = []; db.productUpdates = []; });

describe("Wall Art prices in admin", () => {
  it("updates the price of each size in place", async () => {
    const response = await patch({ variants: [{ id: "cmvpni67j0001jp088jfulnpy", name: "20 x 25 cm", priceCents: 2799 }, { id: "cmvpni6vt000hjp08qhfobmh8", name: "30 x 40 cm", priceCents: 3999 }, { id: "cmvpni7ja000zjp08m6zpcnmp", name: "A1 (59.4 x 84.1 cm)", priceCents: 5499 }] });
    expect(response.status).toBe(200);
    expect(db.updates.map((update) => [update.where.id, update.data.priceCents, update.data.active])).toEqual([["cmvpni67j0001jp088jfulnpy", 2799, true], ["cmvpni6vt000hjp08qhfobmh8", 3999, true], ["cmvpni7ja000zjp08m6zpcnmp", 5499, true]]);
    expect(db.updates[0].data.attributes).toEqual({ size: "20 x 25 cm" });
    expect(db.created).toEqual([]);
    expect(db.deactivated).toEqual([]);
    // Only the sizes change: the product (and its print shop mapping) stays as it is.
    expect(db.productUpdates).toEqual([{}]);
  });

  it("deactivates a removed size instead of deleting it (past orders keep it)", async () => {
    await patch({ variants: [{ id: "cmvpni67j0001jp088jfulnpy", name: "20 x 25 cm", priceCents: 3299 }, { id: "cmvpni6vt000hjp08qhfobmh8", name: "30 x 40 cm", priceCents: 4499 }] });
    expect(db.deactivated).toEqual([{ where: { id: { in: ["cmvpni7ja000zjp08m6zpcnmp"] } }, data: { active: false } }]);
  });

  it("rejects an invalid price", async () => {
    const response = await patch({ variants: [{ id: "cmvpni67j0001jp088jfulnpy", name: "20 x 25 cm", priceCents: -1 }] });
    expect(response.status).toBe(400);
    expect(db.updates).toEqual([]);
  });
});
