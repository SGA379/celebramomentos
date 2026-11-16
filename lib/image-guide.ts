// Image upload recommendations shown next to every customer upload field, and the browser-side
// preparation of an uploaded photo. Shared by the product studios and the card editor (client code).
//
// Every size comes from the print shop specification the server uses to make the print file
// (lib/pod/catalog.ts: mapOrderItem), never from a guessed table:
// - Prodigi magnets: the SKU's print area (850 × 566 px);
// - Printful mugs: the wrap print file (2700 × 1050 px for 11 oz, 2700 × 1140 px for 15 oz);
// - Gelato posters: the printed size at Gelato's recommended 150 dpi;
// - Gelato calendars: the cover and month photo boxes of the calendar PDF at 300 dpi;
// - Printeers phone cases: the model's print area at 300 dpi (given per model by the Printeers API);
// - Prodigi cards: one card page at the SKU's print size (lib/data.ts CARD_SIZES).
import { calendarLayout, boxPixels } from "@/lib/pod/calendar-layout";
import { mapOrderItem, type ItemContext } from "@/lib/pod/catalog";
import { POSTER_DPI } from "@/lib/print-quality";

// dpi: the resolution the size stands for, or null when the print shop gives a pixel size only.
export type PhotoGuide = { width: number; height: number; dpi: number | null; fit?: "contain" };

// Accepted by the upload fields and the server (/api/uploads also takes WEBP, but the studios ask for JPG or PNG).
export const UPLOAD_FORMATS = "JPG, PNG";
export const UPLOAD_ACCEPT = "image/png,image/jpeg";
// Customer photos are sent through a Vercel function at checkout, whose request body limit is 4.5 MB.
// Bigger photos are re-encoded in the browser (prepareUpload) so they always fit.
export const MAX_UPLOAD_MB = 4;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// The recommended photo for one upload slot of a catalog product, or null when the print shop mapping
// gives no size (e.g. a size not mapped yet). Calendars: "cover" or "month" slot.
export function photoGuide(ctx: ItemContext, slot: "photo" | "cover" | "month" = "photo"): PhotoGuide | null {
  const spec = mapOrderItem({ ...ctx, photoCount: Math.max(1, ctx.photoCount) }).units[0]?.specs[0];
  if (!spec) return null;
  if (spec.kind === "calendar") {
    const layout = calendarLayout({ width: spec.widthMm, height: spec.heightMm });
    return { ...boxPixels(slot === "cover" ? layout.cover : layout.month), dpi: 300 };
  }
  if (spec.kind !== "photo") return null;
  if (spec.fit === "fill" && spec.width && spec.height) return { width: spec.width, height: spec.height, dpi: null };
  // Mug wraps: the photo is fitted inside the file on a white background.
  if (spec.fit === "pad" && spec.width && spec.height) return { width: spec.width, height: spec.height, dpi: null, fit: "contain" };
  if (spec.fit === "aspect" && spec.minDpiSize) return { width: Math.round((spec.minDpiSize.widthMm / 25.4) * POSTER_DPI), height: Math.round((spec.minDpiSize.heightMm / 25.4) * POSTER_DPI), dpi: POSTER_DPI };
  return null;
}

const dataUrlBytes = (value: string) => Math.floor(((value.length - value.indexOf(",") - 1) * 3) / 4);

const readAsDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error || new Error("The photo could not be read"));
  reader.readAsDataURL(file);
});

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("The photo could not be opened"));
  image.src = src;
});

// A photo chosen by the customer, as a data URL ready for upload. Photos up to MAX_UPLOAD_MB are kept
// exactly as they are. Bigger ones are re-encoded as high-quality JPEG at full resolution, and scaled
// down only as far as needed to fit (a 4 MB JPEG still holds far more pixels than any print needs).
export async function prepareUpload(file: File): Promise<string> {
  const original = await readAsDataUrl(file);
  if (file.size <= MAX_UPLOAD_BYTES) return original;
  const image = await loadImage(original);
  let scale = 1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) break;
    // JPEG has no transparency: a transparent PNG gets a white background.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.92, 0.85]) {
      const encoded = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlBytes(encoded) <= MAX_UPLOAD_BYTES) return encoded;
    }
    scale *= 0.85;
  }
  throw new Error("The photo is too large");
}
