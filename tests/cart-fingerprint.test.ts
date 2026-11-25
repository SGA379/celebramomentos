import { describe, expect, it } from "vitest";
import { cartLineFingerprint } from "@/lib/server/cart";
import type { ResolvedCartLine } from "@/lib/server/catalog";
import type { CartItem } from "@/lib/store";

const card = (message: string) => ({
  categoryId: "especial", templateId: "template-3", frameId: null, message,
  frontHeadline: message, frontSubheadline: "", insideLeftText: "", insideRightText: "", backText: "",
  emoji: "", emojiTone: "natural" as const, emojiSize: 32, emojiPosition: { x: 0.5, y: 0.5 }, emojiElements: [],
  photoDataUrl: null, photoDataUrls: [], photoZoom: 1, photoPosition: "center" as const, size: "5x7" as const,
  delivery: "standard" as const, recipientMode: "recipient" as const,
});

const resolved = (product: unknown) => ({
  unitPriceCents: 1200, productId: "product-1", templateSlug: null, product,
  productPriceCents: null, productName: null, cardSizeSku: null,
}) as ResolvedCartLine;

describe("account cart line identity", () => {
  it("is stable when object keys arrive in a different order", () => {
    const first = { id: "a", quantity: 1, productId: "product-1", product: { kind: "CATALOG", productKind: "MUG", options: { color: "red" }, photos: ["https://img.test/a.jpg"] }, card: card("") } as unknown as CartItem;
    const second = { ...first, product: { ...(first.product as object), options: { color: "red" } } } as unknown as CartItem;
    expect(cartLineFingerprint(first, resolved(first.product))).toBe(cartLineFingerprint(second, resolved(second.product)));
  });

  it("changes when the saved customization changes", () => {
    const first = { id: "a", quantity: 1, productId: null, product: null, card: card("one") } as CartItem;
    const second = { ...first, card: card("two") } as unknown as CartItem;
    expect(cartLineFingerprint(first, resolved(null))).not.toBe(cartLineFingerprint(second, resolved(null)));
  });
});
