import { describe, expect, it } from "vitest";
import { itemCustomization, itemProvider } from "@/lib/server/orders";

// Shapes as saved in OrderItem.personalization at checkout (catalog products and cards).
const mug = {
  product: {
    kind: "CATALOG", productKind: "MUG", productId: "p1", variantId: "v1", name: "Taza", detail: "11 oz · Blanco",
    options: { color: "Blanco", empty: "" }, photos: ["https://res.cloudinary.com/x/image/upload/photo.jpg", "data:image/png;base64,AAA"],
    image: "https://res.cloudinary.com/x/image/upload/default-product.jpg", preview: "https://res.cloudinary.com/x/image/upload/studio-preview.png",
    provider: "PRINTFUL", sku: null, priceCents: 1500,
  },
};
const calendar = { product: { kind: "CATALOG", productKind: "CALENDAR", photos: ["https://a/1.jpg", null, "https://a/3.jpg"], preview: "https://a/preview.png", provider: "GELATO", options: {} } };
const card = {
  provider: "PRODIGI", cardSize: "a5",
  card: { size: "a5", design: { panels: [{ side: "front", url: "https://a/front.jpg" }, { side: "back", url: "https://a/back.jpg" }, { side: "inside-left", url: "blob:local" }] } },
};

describe("itemCustomization", () => {
  it("returns the studio preview, never the default product image", () => {
    const design = itemCustomization(mug);
    expect(design.preview).toBe("https://res.cloudinary.com/x/image/upload/studio-preview.png");
    expect(design.kind).toBe("MUG");
    expect(design.detail).toBe("11 oz · Blanco");
  });

  it("keeps only filled options and https photos, in order", () => {
    const design = itemCustomization(mug);
    expect(design.options).toEqual([{ name: "color", value: "Blanco" }]);
    expect(design.photos).toEqual(["https://res.cloudinary.com/x/image/upload/photo.jpg", null]);
    // A calendar keeps an empty month in its place.
    expect(itemCustomization(calendar).photos).toEqual(["https://a/1.jpg", null, "https://a/3.jpg"]);
  });

  it("returns a card's rendered pages, its front page as the preview, and its size", () => {
    const design = itemCustomization(card);
    expect(design.kind).toBe("POSTCARD");
    expect(design.preview).toBe("https://a/front.jpg");
    expect(design.pages).toEqual([{ side: "front", url: "https://a/front.jpg" }, { side: "back", url: "https://a/back.jpg" }]);
    expect(design.cardSize).toBe("a5");
    expect(design.photos).toEqual([]);
  });

  it("is empty for an item with nothing saved", () => {
    expect(itemCustomization(null)).toEqual({ kind: null, preview: null, detail: null, options: [], photos: [], pages: [], cardSize: null });
  });
});

describe("itemProvider", () => {
  it("uses the print shop the item was planned for", () => {
    expect(itemProvider({ podProvider: "GELATO", personalization: mug })).toBe("GELATO");
  });

  it("otherwise tells where the item will be sent, with the same rule as fulfilment", () => {
    expect(itemProvider({ podProvider: null, personalization: mug })).toBe("PRINTFUL");
    expect(itemProvider({ personalization: card })).toBe("PRODIGI");
    // Phone cases are always made by Printeers.
    expect(itemProvider({ personalization: { product: { kind: "CATALOG", productKind: "PHONE_CASE", provider: "GELATO" } } })).toBe("PRINTEERS");
    // No provider saved: the category default.
    expect(itemProvider({ personalization: { product: { kind: "CATALOG", productKind: "WALL_ART" } } })).toBe("GELATO");
  });

  it("is null when nothing tells the print shop", () => {
    expect(itemProvider({ podProvider: null, personalization: null })).toBeNull();
  });
});
