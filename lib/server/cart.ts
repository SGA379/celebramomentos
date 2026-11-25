import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import type { CartItem } from "@/lib/store";
import { prisma } from "./prisma";
import { ensureCatalog, resolveCartLine, type ResolvedCartLine } from "./catalog";

export function publicCustomer(customer: { id: string; name: string; email: string; phone: string | null; createdAt: Date }) {
  return { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone, createdAt: customer.createdAt.toISOString() };
}

export function toCartItem(line: { id: string; quantity: number; productId?: string | null; payload: Prisma.JsonValue }): CartItem {
  const payload = (line.payload && typeof line.payload === "object" ? line.payload : {}) as Partial<CartItem>;
  return {
    id: line.id,
    quantity: line.quantity,
    // The payload keeps the product id so a line still points at its product
    // (and is rejected) after the product row is deleted and the relation is nulled.
    productId: line.productId || payload.productId || null,
    product: payload.product ?? null,
    productPriceCents: payload.productPriceCents ?? null,
    productName: payload.productName ?? null,
    // Retired extras (stickers, envelope text, gift packaging) in older payloads are ignored.
    card: payload.card as CartItem["card"],
  };
}

export async function getCustomerCart(customerId: string) {
  await ensureCatalog();
  const lines = await prisma.cartLine.findMany({ where: { customerId }, orderBy: { createdAt: "asc" } });
  return { items: lines.map(toCartItem) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export function cartLineFingerprint(item: CartItem, resolved: ResolvedCartLine) {
  const product = resolved.product ? { ...resolved.product, preview: null } : null;
  const identity = canonical({ productId: resolved.productId, templateSlug: resolved.templateSlug, product, card: item.card });
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function legacyLineFingerprint(line: { productId: string | null; templateSlug: string | null; payload: Prisma.JsonValue }) {
  const payload = (line.payload && typeof line.payload === "object" ? line.payload : {}) as { product?: unknown; productId?: string | null; card?: unknown };
  const product = payload.product && typeof payload.product === "object" ? { ...(payload.product as Record<string, unknown>), preview: null } : null;
  return createHash("sha256").update(JSON.stringify(canonical({ productId: line.productId || payload.productId || null, templateSlug: line.templateSlug, product, card: payload.card }))).digest("hex");
}

function lineData(customerId: string, item: CartItem, resolved: ResolvedCartLine, fingerprint: string, quantity = item.quantity) {
  const payload = {
    productId: resolved.productId,
    product: resolved.product,
    productPriceCents: resolved.productPriceCents,
    productName: resolved.productName,
    card: item.card,
  } satisfies Omit<CartItem, "id" | "quantity">;
  return {
    customerId,
    templateSlug: resolved.templateSlug,
    productId: resolved.productId,
    quantity: Math.max(1, Math.min(99, quantity)),
    unitPriceCents: resolved.unitPriceCents,
    fingerprint,
    payload: payload as Prisma.InputJsonValue,
  };
}

export async function upsertCartLine(customerId: string, item: CartItem) {
  await ensureCatalog();
  const resolved = await resolveCartLine(item);
  const fingerprint = cartLineFingerprint(item, resolved);
  const line = await prisma.$transaction(async (tx) => {
    const existingById = item.id ? await tx.cartLine.findFirst({ where: { id: item.id, customerId } }) : null;
    const existingByFingerprint = existingById ? null : await tx.cartLine.findFirst({ where: { customerId, fingerprint } });
    const existing = existingById || existingByFingerprint;
    if (existing) {
      const quantity = existingByFingerprint ? Math.min(99, existing.quantity + item.quantity) : item.quantity;
      return tx.cartLine.update({ where: { id: existing.id }, data: lineData(customerId, item, resolved, fingerprint, quantity) });
    }
    return tx.cartLine.create({ data: lineData(customerId, item, resolved, fingerprint) });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return toCartItem(line);
}

async function mergeCustomerCartOnce(customerId: string, items: CartItem[]) {
  const resolved = await Promise.all(items.map(async (item) => {
    const selection = await resolveCartLine(item);
    return { item, selection, fingerprint: cartLineFingerprint(item, selection) };
  }));
  await prisma.$transaction(async (tx) => {
    const existing = await tx.cartLine.findMany({ where: { customerId } });
    for (const entry of resolved) {
      const current = existing.find((line) => (line.fingerprint || legacyLineFingerprint(line)) === entry.fingerprint);
      if (current) {
        const updated = await tx.cartLine.update({ where: { id: current.id }, data: lineData(customerId, entry.item, entry.selection, entry.fingerprint, current.quantity + entry.item.quantity) });
        existing.splice(existing.indexOf(current), 1, updated);
      } else {
        const created = await tx.cartLine.create({ data: lineData(customerId, entry.item, entry.selection, entry.fingerprint) });
        existing.push(created);
      }
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// Guest items are resolved and merged inside a serializable transaction. A second
// login racing the first one is retried instead of creating duplicate lines.
export async function mergeCustomerCart(customerId: string, items: CartItem[]) {
  await ensureCatalog();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mergeCustomerCartOnce(customerId, items);
      return getCustomerCart(customerId);
    } catch (reason) {
      if (attempt === 1 || !(reason instanceof Prisma.PrismaClientKnownRequestError) || reason.code !== "P2034") throw reason;
    }
  }
  return getCustomerCart(customerId);
}
