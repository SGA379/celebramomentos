import { describe, expect, it } from "vitest";
import { CALENDAR_COVER_INDEX, CALENDAR_PHOTOS, MAX_PRODUCT_PHOTOS, MAX_SELECTION_PHOTOS, requiredPhotoCount } from "@/lib/products";

describe("how many photos a product needs", () => {
  it("a wall calendar always needs all 12 (one per month), whatever the product or size says", () => {
    expect(CALENDAR_PHOTOS).toBe(12);
    expect(requiredPhotoCount({ kind: "CALENDAR", metadata: { photoCount: 1 } }, null)).toBe(12);
    expect(requiredPhotoCount({ kind: "CALENDAR", metadata: null }, { photoCount: 3 })).toBe(12);
  });

  it("other products keep their own rule: the size's count (magnet packs), else the product's, else 1", () => {
    expect(requiredPhotoCount({ kind: "MAGNET", metadata: { photoCount: 1 } }, { photoCount: 5 })).toBe(5);
    expect(requiredPhotoCount({ kind: "MUG", metadata: { photoCount: 1 } }, null)).toBe(1);
    expect(requiredPhotoCount({ kind: "WALL_ART", metadata: null }, null)).toBe(1);
  });

  it("a calendar's optional front cover is stored after the 12 months, so January stays at index 0", () => {
    expect(CALENDAR_COVER_INDEX).toBe(12);
    expect(MAX_SELECTION_PHOTOS).toBe(MAX_PRODUCT_PHOTOS + 1);
  });
});
