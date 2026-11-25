"use client";

import type { CartItem } from "./store";

type CartResponse = { items?: CartItem[]; item?: CartItem; error?: string };
type CartMutation =
  | { type: "save"; item: CartItem }
  | { type: "quantity"; id: string; quantity: number }
  | { type: "remove"; id: string }
  | { type: "remove-many"; ids: string[] }
  | { type: "clear" }
  | { type: "save-many"; items: CartItem[] };

let readyOwner: string | null = null;
let requestQueue = Promise.resolve();
const serverIds = new Map<string, string>();

export function setCartSyncReady(customerId: string | null) {
  if (customerId !== readyOwner) serverIds.clear();
  readyOwner = customerId;
}

export function isCartSyncReady(customerId: string) {
  return readyOwner === customerId;
}

const uploadCache = new Map<string, Promise<string>>();

async function uploadDataUrl(value: string, fileName: string) {
  if (!value.startsWith("data:image/")) return value;
  const cached = uploadCache.get(value);
  if (cached) return cached;
  const upload = (async () => {
    const blob = await (await fetch(value)).blob();
    const form = new FormData();
    form.append("file", blob, fileName);
    form.append("kind", "CUSTOMER_UPLOAD");
    const response = await fetch("/api/uploads", { method: "POST", body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.asset?.url) throw new Error(body.error || "No se pudo guardar una imagen");
    return body.asset.url as string;
  })();
  uploadCache.set(value, upload);
  return upload;
}

// Account carts must store upload references, not browser data URLs. This keeps
// the database small and makes a design usable on another device.
export async function prepareCartItem(item: CartItem): Promise<CartItem> {
  const product = item.product
    ? {
        ...item.product,
        preview: item.product.preview ? await uploadDataUrl(item.product.preview, "product-preview.jpg") : item.product.preview,
        photos: await Promise.all(item.product.photos.map((photo, index) => photo ? uploadDataUrl(photo, `product-${index}.jpg`) : photo)),
      }
    : item.product;
  const photoDataUrls = await Promise.all((item.card.photoDataUrls || []).map((photo, index) => photo ? uploadDataUrl(photo, `photo-${index}.jpg`) : photo));
  const photoDataUrl = item.card.photoDataUrl ? await uploadDataUrl(item.card.photoDataUrl, "photo-cover.jpg") : item.card.photoDataUrl;
  return { ...item, product, card: { ...item.card, photoDataUrl, photoDataUrls } };
}

async function read(response: Response): Promise<CartResponse> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "No se pudo sincronizar la cesta"), { status: response.status });
  return body as CartResponse;
}

export async function fetchAccountCart() {
  return (await read(await fetch("/api/cart", { cache: "no-store" }))).items || [];
}

export async function mergeGuestCart(items: CartItem[]) {
  const prepared = await Promise.all(items.map(prepareCartItem));
  return (await read(await fetch("/api/cart/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: prepared }), cache: "no-store" }))).items || [];
}

async function sendMutation(mutation: CartMutation) {
  if (mutation.type === "save") {
    const prepared = await prepareCartItem(mutation.item);
    const body = await read(await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...prepared, id: serverIds.get(mutation.item.id) || prepared.id }) }));
    if (body.item?.id) serverIds.set(mutation.item.id, body.item.id);
    return body.items || (body.item ? [body.item] : []);
  }
  if (mutation.type === "quantity") {
    return (await read(await fetch("/api/cart", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: serverIds.get(mutation.id) || mutation.id, quantity: mutation.quantity }) }))).items || [];
  }
  if (mutation.type === "remove") {
    const items = (await read(await fetch(`/api/cart?id=${encodeURIComponent(serverIds.get(mutation.id) || mutation.id)}`, { method: "DELETE" }))).items || [];
    serverIds.delete(mutation.id);
    return items;
  }
  if (mutation.type === "remove-many") {
    let items = await fetchAccountCart();
    for (const id of mutation.ids) {
      items = (await read(await fetch(`/api/cart?id=${encodeURIComponent(serverIds.get(id) || id)}`, { method: "DELETE" }))).items || items;
      serverIds.delete(id);
    }
    return items;
  }
  if (mutation.type === "clear") {
    return (await read(await fetch("/api/cart?all=1", { method: "DELETE" }))).items || [];
  }
  let items: CartItem[] = [];
  for (const item of mutation.items) items = (await sendMutation({ type: "save", item })) || items;
  return items;
}

export function enqueueCartMutation(customerId: string, mutation: CartMutation, apply: (items: CartItem[]) => void, onError?: () => void) {
  requestQueue = requestQueue.then(async () => {
    if (!isCartSyncReady(customerId)) return;
    try {
      const items = await sendMutation(mutation);
      if (isCartSyncReady(customerId)) apply(items);
    } catch (reason) {
      // A later focus/login sync fetches the server copy. Do not discard a local
      // cart just because a single network request was temporarily unavailable.
      console.error("[celebra] account cart sync failed", reason);
      if (isCartSyncReady(customerId)) onError?.();
    }
  }).catch(() => undefined);
}

