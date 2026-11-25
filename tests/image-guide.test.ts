import { describe, expect, it } from "vitest";
import { photoGuide } from "@/lib/image-guide";
import { boxPixels, calendarLayout } from "@/lib/pod/calendar-layout";
import type { ItemContext } from "@/lib/pod/catalog";

const ctx = (patch: Partial<ItemContext>): ItemContext => ({ kind: "MAGNET", provider: "PRODIGI", productName: "", variantName: null, podSku: null, options: {}, photoCount: 1, cardSize: null, cardSku: null, ...patch });

// Recommended upload sizes come from the print shop specification the server uses for the print file.
describe("photo size recommendations", () => {
  it("magnets: the Prodigi magnet print area", () => {
    expect(photoGuide(ctx({ kind: "MAGNET", provider: "PRODIGI" }))).toEqual({ width: 850, height: 566, dpi: null });
  });

  it("mugs: the full Printful wrap file of the chosen size", () => {
    expect(photoGuide(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "11 oz", options: { color: "Negro" } }))).toEqual({ width: 2700, height: 1050, dpi: null });
    expect(photoGuide(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "15 oz", options: { color: "Negro" } }))).toEqual({ width: 2700, height: 1140, dpi: null });
  });

  it("wall art: the poster size at Gelato's recommended 150 dpi, following the orientation", () => {
    const portrait = photoGuide(ctx({ kind: "WALL_ART", provider: "GELATO", variantName: "30 x 40 cm", options: { orientacion: "Vertical", marco: "Madera natural" } }));
    expect(portrait).toEqual({ width: 1772, height: 2362, dpi: 150 });
    const landscape = photoGuide(ctx({ kind: "WALL_ART", provider: "GELATO", variantName: "30 x 40 cm", options: { orientacion: "Horizontal", marco: "Madera natural" } }));
    expect(landscape).toEqual({ width: 2362, height: 1772, dpi: 150 });
  });

  it("calendars: the cover and month photo boxes of the A4 / A3 calendar PDF at 300 dpi", () => {
    const a4 = calendarLayout({ width: 210, height: 297 });
    expect(photoGuide(ctx({ kind: "CALENDAR", provider: "GELATO", variantName: "A4 (21 x 29.7 cm)" }), "month")).toEqual({ ...boxPixels(a4.month), dpi: 300 });
    expect(photoGuide(ctx({ kind: "CALENDAR", provider: "GELATO", variantName: "A4 (21 x 29.7 cm)" }), "cover")).toEqual({ ...boxPixels(a4.cover), dpi: 300 });
    const a3Cover = photoGuide(ctx({ kind: "CALENDAR", provider: "GELATO", variantName: "A3 (29.7 x 42 cm)" }), "cover")!;
    expect(a3Cover.width).toBeGreaterThan(boxPixels(a4.cover).width);
    // A size the print shop does not make has no recommendation.
    expect(photoGuide(ctx({ kind: "CALENDAR", provider: "GELATO", variantName: "34" }), "cover")).toBeNull();
  });

  it("phone cases: the size comes from the chosen Printeers model's print area, not from this table", () => {
    expect(photoGuide(ctx({ kind: "PHONE_CASE", provider: "PRINTEERS" }))).toBeNull();
    expect(photoGuide(ctx({ kind: "PHONE_CASE", provider: "PRINTEERS", printeers: { productReference: "B67650000", printMm: { width: 70, height: 148 }, crop: null } }))).toEqual({ width: 827, height: 1748, dpi: null });
  });
});
