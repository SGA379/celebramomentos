import { describe, expect, it } from "vitest";
import { gelatoPhoneModel, gelatoPosterFormat, mapOrderItem, mugColorKey, studioPhotoTarget, unavailableCombination, type ItemContext, wallArtPosterPaper } from "@/lib/pod/catalog";
import { photoEnlargement } from "@/lib/print-quality";
import { GELATO_CLASSIC_POSTER_HANGER_UIDS, GELATO_MUSEUM_POSTER_HANGER_UIDS, GELATO_POSTER_HANGER_UIDS, GELATO_TOUGH_CASE_UIDS, WALL_ART_POSTER_PAPER } from "@/lib/pod/gelato-catalog";

const ctx = (overrides: Partial<ItemContext>): ItemContext => ({ kind: "WALL_ART", provider: "GELATO", productName: "Póster", variantName: null, podSku: null, options: {}, photoCount: 1, cardSize: null, cardSku: null, ...overrides });

describe("what the studio checks (same rules as the server)", () => {
  it("a mug is makeable once the studio's colour is included; without any colour it is not", () => {
    const mug = (options: Record<string, string>) => ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "11 oz (325 mL)", options });
    expect(unavailableCombination(mug({ color: "Negro" }))).toBeNull();
    expect(unavailableCombination(mug({}))).toEqual({ reason: "size" });
  });

  it("a mug photo is measured across the complete wrap file, like the server's fill check", () => {
    const target = studioPhotoTarget(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "11 oz (325 mL)", options: { color: "Negro" } }));
    expect(target).toEqual({ width: 2700, height: 1050 });
    expect(photoEnlargement({ width: 400, height: 300 }, target!)).toBeCloseTo(6.75, 3); // low: asks the customer to confirm
    expect(photoEnlargement({ width: 800, height: 600 }, target!)).toBeCloseTo(3.375, 3); // soft: sent with a note
    expect(photoEnlargement({ width: 800, height: 600 }, { width: 2700, height: 1050 })).toBeCloseTo(3.375, 3); // cover rule (posters, magnets)
  });
});

describe("Prodigi mapping", () => {
  it("sends a magnet pack as one magnet per photo with the verified SKU and 850 × 566 px files", () => {
    const result = mapOrderItem(ctx({ kind: "MAGNET", provider: "PRODIGI", variantName: "3 imanes", photoCount: 3 }));
    expect(result.issues).toEqual([]);
    expect(result.units).toHaveLength(3);
    expect(result.units.every((unit) => unit.productRef === "M-MAG-FRI-3X2")).toBe(true);
    expect(result.units[2].specs[0]).toMatchObject({ area: "default", kind: "photo", photoIndex: 2, fit: "fill", width: 850, height: 566 });
  });

  it("maps both card sizes to their SKUs and composes the 4 pages automatically at Prodigi's exact print size", () => {
    const small = mapOrderItem(ctx({ kind: "POSTCARD", provider: "PRODIGI", cardSize: "5x7", cardSku: "CLASSIC-GRE-FEDR-7X5-BLA" }));
    const a5 = mapOrderItem(ctx({ kind: "POSTCARD", provider: "PRODIGI", cardSize: "A5", cardSku: "CLASSIC-GRE-FEDR-A5-BLA" }));
    expect(small.units[0].productRef).toBe("CLASSIC-GRE-FEDR-7X5-BLA");
    expect(small.units[0].specs[0]).toEqual({ area: "default", kind: "pages", pages: ["back", "front", "inside-left", "inside-right"], width: 6120, height: 2160, format: "jpg", description: expect.stringContaining("6120 × 2160") });
    expect(a5.units[0].specs[0]).toMatchObject({ kind: "pages", width: 7086, height: 2526 });
    expect(small.issues).toEqual([]);
  });

  it("does not guess a layout for a card SKU it does not know", () => {
    expect(mapOrderItem(ctx({ kind: "POSTCARD", provider: "PRODIGI", cardSize: "5x7", cardSku: "GLOBAL-GRE-UNKNOWN" })).units[0].specs[0]).toMatchObject({ kind: "admin" });
  });

  it("reports magnets without photos instead of sending an empty order", () => {
    expect(mapOrderItem(ctx({ kind: "MAGNET", provider: "PRODIGI", photoCount: 0 })).issues[0].code).toBe("missing_photos");
  });
});

describe("Printful mug mapping", () => {
  it("uses the verified variant ids of the colour-inside mug", () => {
    expect(mapOrderItem(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "11 oz (325 mL)", options: { color: "Negro" } })).units[0].productRef).toBe("11051");
    expect(mapOrderItem(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "15 oz (444 mL)", options: { color: "Azul marino" } })).units[0].productRef).toBe("22373");
    expect(mapOrderItem(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "11 oz", options: { color: "Amarillo" } })).units[0].productRef).toBe("11048");
  });

  it("uses the 11 oz and 15 oz print file sizes", () => {
    expect(mapOrderItem(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "11 oz", options: { color: "Rojo" } })).units[0].specs[0]).toMatchObject({ fit: "fill", width: 2700, height: 1050, repeat: true });
    expect(mapOrderItem(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "15 oz", options: { color: "Rojo" } })).units[0].specs[0]).toMatchObject({ fit: "fill", width: 2700, height: 1140, repeat: true });
  });

  it("carries one shared crop into the complete mug wrap file", () => {
    const crop = { zoom: 1.8, x: 0.2, y: 0.7 };
    expect(mapOrderItem(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "11 oz", options: { color: "Rojo" }, crop })).units[0].specs[0]).toMatchObject({ fit: "fill", width: 2700, height: 1050, crop, repeat: true });
  });

  it("maps independent front and back mug crops into one POD wrap file", () => {
    const mugCrops = { front: { zoom: 1, x: 0.2, y: 0.5 }, back: { zoom: 1.4, x: 0.8, y: 0.3 } };
    expect(mapOrderItem(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "11 oz", options: { color: "Rojo" }, photoCount: 2, mugCrops })).units[0].specs[0]).toEqual({ area: "default", kind: "mug", photoIndex: 0, backPhotoIndex: 1, width: 2700, height: 1050, format: "jpg", crop: mugCrops.front, backCrop: mugCrops.back });
  });

  it("blocks a colour Printful does not make in that size", () => {
    expect(mapOrderItem(ctx({ kind: "MUG", provider: "PRINTFUL", variantName: "15 oz", options: { color: "Naranja" } })).issues[0].code).toBe("unmapped");
  });

  it("recognises Spanish and Portuguese colour names", () => {
    expect(mugColorKey("Azul-marinho")).toBe("navy");
    expect(mugColorKey("Preto")).toBe("black");
    expect(mugColorKey("Vermelho")).toBe("red");
  });
});

describe("Gelato mapping", () => {
  it("maps storefront poster sizes to Gelato formats", () => {
    expect(gelatoPosterFormat("30 x 40 cm")).toBe("300x400-mm-12x16-inch");
    expect(gelatoPosterFormat("28 x 43 cm")).toBe("280x430-mm-XL");
    expect(gelatoPosterFormat("A3 (29.7 x 42 cm)")).toBe("A3");
    expect(gelatoPosterFormat("21 x 21.97 cm")).toBeNull();
  });

  it("picks the poster with the chosen orientation and hanger colour", () => {
    const portrait = mapOrderItem(ctx({ variantName: "30 x 40 cm", options: { orientacion: "Vertical" } }));
    const landscape = mapOrderItem(ctx({ variantName: "30 x 40 cm", options: { orientacion: "Horizontal", colgador: "Negro" } }));
    expect(portrait.units[0].productRef).toBe(GELATO_POSTER_HANGER_UIDS["300x400-mm-12x16-inch|ver|natural-wood"]);
    expect(landscape.units[0].productRef).toBe(GELATO_POSTER_HANGER_UIDS["300x400-mm-12x16-inch|hor|black"]);
    expect(landscape.units[0].productRef).toMatch(/^wall_hanging_poster_.*black.*_hor$/);
    expect(landscape.units[0].specs[0]).toMatchObject({ fit: "aspect", width: 400, height: 300 });
  });

  it("supports all four hanger colours", () => {
    for (const [name, color] of [["Blanco", "white"], ["Madera natural", "natural-wood"], ["Madera oscura", "dark-wood"], ["Negro", "black"]]) {
      expect(mapOrderItem(ctx({ variantName: "50 x 70 cm", options: { colgador: name } })).units[0].productRef).toBe(GELATO_POSTER_HANGER_UIDS[`500x700-mm-20x28-inch|ver|${color}`]);
    }
  });

  it("blocks sizes or orientations Gelato does not make", () => {
    expect(mapOrderItem(ctx({ variantName: "21 x 21.97 cm" })).issues[0].code).toBe("unmapped");
    expect(mapOrderItem(ctx({ variantName: "A1 (59.4 x 84.1 cm)", options: { orientacion: "Horizontal" } })).issues[0].code).toBe("unmapped");
    expect(mapOrderItem(ctx({ variantName: "A1 (59.4 x 84.1 cm)", options: { orientacion: "Vertical" } })).issues).toEqual([]);
  });

  it("maps the three calendar sizes to a 14-page PDF made by the site at Gelato's page size", () => {
    const pages: Record<string, [number, number]> = { "A4 (21 x 29.7 cm)": [210, 297], "A3 (29.7 x 42 cm)": [297, 420], "14.8 x 40 cm": [148, 400] };
    for (const [size, [width, height]] of Object.entries(pages)) {
      const result = mapOrderItem(ctx({ kind: "CALENDAR", variantName: size, photoCount: 3 }));
      expect(result.units[0].productRef).toMatch(/^wall_calendar_unified_/);
      expect(result.units[0].specs[0]).toMatchObject({ kind: "calendar", widthMm: width, heightMm: height });
    }
    expect(mapOrderItem(ctx({ kind: "CALENDAR", variantName: "A4 (21 x 29.7 cm)", photoCount: 0 })).issues[0].code).toBe("missing_photos");
  });

  it("maps tough cases only for models Gelato makes", () => {
    expect(gelatoPhoneModel("iPhone 15 Pro Max")).toBe("iphone-15promax");
    expect(gelatoPhoneModel("Samsung S23 Ultra 5G")).toBe("galaxy-s23ultra");
    const supported = mapOrderItem(ctx({ kind: "PHONE_CASE", productName: "Funda rígida Tough", options: { modelo: "iPhone 15 Pro Max" } }));
    expect(supported.units[0].productRef).toBe(GELATO_TOUGH_CASE_UIDS["iphone-15promax"]);
    expect(mapOrderItem(ctx({ kind: "PHONE_CASE", productName: "Funda rígida Tough", options: { modelo: "iPhone 17 Pro" } })).issues[0].code).toBe("unmapped");
  });
});

describe("Printeers mapping (phone cases)", () => {
  const printeers = { productReference: "Product_soft_iphone15", printMm: { width: 71.5, height: 147.6 }, crop: { zoom: 1.5, x: 0.2, y: 0.8 } };

  it("sends the chosen Printeers product with the customer's framed photo at 300 dpi of its print area", () => {
    const result = mapOrderItem(ctx({ kind: "PHONE_CASE", provider: "PRINTEERS", productName: "Funda Soft TPU", options: { modelo: "iPhone 15" }, printeers }));
    expect(result.issues).toEqual([]);
    expect(result.units).toEqual([{ productRef: "Product_soft_iphone15", specs: [{ area: "default", kind: "photo", photoIndex: 0, fit: "fill", width: 844, height: 1743, format: "jpg", crop: { zoom: 1.5, x: 0.2, y: 0.8 } }] }]);
  });

  it("holds cases ordered before their product was linked to Printeers", () => {
    expect(mapOrderItem(ctx({ kind: "PHONE_CASE", provider: "PRINTEERS", productName: "Funda transparente", options: { modelo: "iPhone 15" } })).issues[0].code).toBe("printeers_product_missing");
  });

  it("does not guess a print size Printeers did not give", () => {
    expect(mapOrderItem(ctx({ kind: "PHONE_CASE", provider: "PRINTEERS", printeers: { ...printeers, printMm: null } })).issues[0].code).toBe("printeers_print_area_missing");
  });

  it("never prepares anything for a print shop that is no longer used", () => {
    expect(mapOrderItem(ctx({ kind: "PHONE_CASE", provider: "ALERIO_PRINT", productName: "Funda transparente", options: { modelo: "iPhone 15" } }))).toMatchObject({ units: [], issues: [{ code: "provider_inactive", severity: "blocker" }] });
  });
});

describe("admin override", () => {
  it("lets a size's Print shop SKU replace the built-in mapping", () => {
    expect(mapOrderItem(ctx({ kind: "PHONE_CASE", provider: "PRINTEERS", podSku: "Product_override", printeers: { productReference: "Product_chosen", printMm: { width: 70, height: 150 }, crop: null } })).units[0].productRef).toBe("Product_override");
    expect(mapOrderItem(ctx({ variantName: "21 x 21.97 cm", podSku: "custom_uid" })).units[0].productRef).toBe("custom_uid");
  });
});

// Client request 2026-11-26 (Sonia): Wall Art moves from the museum-quality matte paper (250 gsm archival) to the
// Classic Matte Paper (170 gsm) Poster+Hanger product. Gelato catalog and prices checked that day.
describe("Wall Art: classic matte paper poster with hanger", () => {
  // Every size on sale in the shop (Admin → Products, 2026-11-26).
  const SIZES = ["20 x 25 cm", "25 x 25 cm", "25 x 60 cm", "27 x 35 cm", "28 x 43 cm", "A3 (29.7 x 42 cm)", "30 x 30 cm", "30 x 40 cm", "30 x 45 cm", "35 x 35 cm", "40 x 40 cm", "40 x 60 cm", "A2 (42 x 59.4 cm)", "45 x 45 cm", "50 x 50 cm", "50 x 70 cm", "60 x 80 cm", "60 x 90 cm", "70 x 70 cm", "70 x 100 cm", "75 x 100 cm", "A1 (59.4 x 84.1 cm)", "A0 (84.1 x 118.9 cm)"];
  const HANGERS = ["Madera natural", "Madera oscura", "Blanco", "Negro"];

  it("sends new orders as the classic matte paper product", () => {
    expect(WALL_ART_POSTER_PAPER).toBe("classic");
    const ref = mapOrderItem(ctx({ variantName: "30 x 40 cm", options: { orientacion: "Vertical", colgador: "Madera natural" } })).units[0].productRef;
    expect(ref).toBe("wall_hanging_poster_310-mm_natural-wood_wood_w14xt20-mm_300x400-mm-12x16-inch_170-gsm-65lb-uncoated_4-0_ver");
    expect(GELATO_POSTER_HANGER_UIDS).toBe(GELATO_CLASSIC_POSTER_HANGER_UIDS);
  });

  it("offers every size, orientation and hanger exactly as before, with the same print file requirements", () => {
    let combos = 0;
    for (const size of SIZES) for (const orientation of ["Vertical", "Horizontal"]) for (const hanger of HANGERS) {
      const options = { orientacion: orientation, colgador: hanger };
      const classic = mapOrderItem(ctx({ variantName: size, options }));
      const museum = mapOrderItem(ctx({ variantName: size, options, posterPaper: "museum" }));
      // Same availability (A1 / A0 exist in one orientation only, as before).
      expect(classic.issues.map((issue) => issue.code)).toEqual(museum.issues.map((issue) => issue.code));
      if (classic.issues.length) continue;
      combos += 1;
      expect(classic.units[0].productRef).toMatch(/_170-gsm-65lb-uncoated_/);
      expect(classic.units[0].productRef).toBe(museum.units[0].productRef!.replace("_250-gsm-100lb-uncoated-offwhite-archival_", "_170-gsm-65lb-uncoated_"));
      expect(classic.units[0].specs).toEqual(museum.units[0].specs);
    }
    expect(combos).toBe(21 * 8 + 2 * 4);
  });

  it("has a classic product for every museum-quality one, differing only in the paper", () => {
    expect(Object.keys(GELATO_CLASSIC_POSTER_HANGER_UIDS).sort()).toEqual(Object.keys(GELATO_MUSEUM_POSTER_HANGER_UIDS).sort());
    for (const [key, uid] of Object.entries(GELATO_MUSEUM_POSTER_HANGER_UIDS)) expect(GELATO_CLASSIC_POSTER_HANGER_UIDS[key]).toBe(uid.replace("_250-gsm-100lb-uncoated-offwhite-archival_", "_170-gsm-65lb-uncoated_"));
  });

  it("keeps the museum-quality paper for items bought and planned with it (e.g. when a print order is resent)", () => {
    // The poster of the paid order CM-1795608595030 (its print order failed with the calendar and may be resent).
    const bought = "wall_hanging_poster_290-mm_dark-wood_wood_w14xt20-mm_250x250-mm-10x10-inch_250-gsm-100lb-uncoated-offwhite-archival_4-0_ver";
    expect(wallArtPosterPaper(bought)).toBe("museum");
    expect(wallArtPosterPaper(null)).toBe("classic");
    expect(wallArtPosterPaper("wall_hanging_poster_290-mm_dark-wood_wood_w14xt20-mm_250x250-mm-10x10-inch_170-gsm-65lb-uncoated_4-0_ver")).toBe("classic");
    const replanned = mapOrderItem(ctx({ variantName: "25 x 25 cm", options: { colgador: "Madera oscura", orientacion: "Vertical" }, posterPaper: wallArtPosterPaper(bought) }));
    expect(replanned.units[0].productRef).toBe(bought);
  });

  it("still lets an admin print shop SKU override the mapping", () => {
    expect(mapOrderItem(ctx({ variantName: "30 x 40 cm", podSku: "wall_hanging_poster_custom" })).units[0].productRef).toBe("wall_hanging_poster_custom");
  });
});
