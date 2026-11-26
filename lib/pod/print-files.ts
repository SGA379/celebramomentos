// Final print files: the customer's design rendered at the exact size the print shop
// needs and stored as its own file, separate from the customer's original upload.
// Server only.
import { cloudinaryObjectKey, uploadFileToCloudinary, uploadRemoteImageToCloudinary } from "@/lib/server/cloudinary";
import { prisma } from "@/lib/server/prisma";
import { compositeFileUrl, isCloudinaryUrl, printFileUrl, type PrintSpec } from "./artwork";
import { buildCalendarPdf, calendarLayout, CALENDAR_MAX_BYTES, CALENDAR_MAX_DPI, CALENDAR_MIN_DPI, CALENDAR_PAGES, CALENDAR_PDF_VERSION, validateCalendarPdf, type Box, type CalendarLanguage } from "./calendar-pdf";

export type StoredFile = { url: string; width: number; height: number };
export type UploadedFile = { width: number; height: number; mimeType: string; kind: string };

// Renders one print file from the customer's photo (crop / fit with Cloudinary) and
// saves it under a fixed name per order item, unit and area, so a re-check replaces it.
export async function renderPrintFile(input: { orderId: string; itemId: string; unit: number; area: string; sourceUrl: string; sourceUrl2?: string; sourceSize?: { width: number; height: number } | null; sourceSize2?: { width: number; height: number } | null; composedUrl?: string | null; spec: Extract<PrintSpec, { kind: "photo" | "mug" }> }): Promise<StoredFile> {
  const name = `${input.itemId}-${input.unit + 1}-${input.area}`;
  const source = input.composedUrl || (input.spec.kind === "photo" ? printFileUrl(input.sourceUrl, input.spec, input.sourceSize) : null);
  if (!source) throw new Error("A mug print file could not be composed");
  const uploaded = await uploadRemoteImageToCloudinary({ url: source, folder: `celebramomentos/print_file/${input.orderId}`, publicId: name });
  if (!uploaded.width || !uploaded.height) throw new Error("Cloudinary did not report the file's pixel size");
  const objectKey = cloudinaryObjectKey(uploaded.publicId);
  const data = {
    bucket: "cloudinary",
    url: uploaded.secureUrl,
    kind: "PRINT_FILE" as const,
    mimeType: uploaded.format === "png" ? "image/png" : "image/jpeg",
    sizeBytes: uploaded.bytes,
    originalName: `${name}.${uploaded.format || input.spec.format}`,
    metadata: { provider: "cloudinary", publicId: uploaded.publicId, version: uploaded.version, width: uploaded.width, height: uploaded.height, role: "print_file", orderItemId: input.itemId, source: input.sourceUrl },
  };
  await prisma.asset.upsert({ where: { objectKey }, create: { objectKey, ...data }, update: data });
  return { url: uploaded.secureUrl, width: uploaded.width, height: uploaded.height };
}

// The 4 card pages composed side by side at the exact print size (see compositeFileUrl), saved as
// this item's print file. The size Cloudinary reports is returned so the caller can verify it.
export async function renderCompositeFile(input: { orderId: string; itemId: string; unit: number; pageUrls: string[]; spec: Extract<PrintSpec, { kind: "pages" }> }): Promise<StoredFile> {
  const url = compositeFileUrl(input.pageUrls, input.spec);
  if (!url) throw new Error("The card pages are not uploads of this shop's image storage");
  const name = `${input.itemId}-${input.unit + 1}-${input.spec.area}`;
  const uploaded = await uploadRemoteImageToCloudinary({ url, folder: `celebramomentos/print_file/${input.orderId}`, publicId: name });
  if (!uploaded.width || !uploaded.height) throw new Error("Cloudinary did not report the file's pixel size");
  const objectKey = cloudinaryObjectKey(uploaded.publicId);
  const data = {
    bucket: "cloudinary",
    url: uploaded.secureUrl,
    kind: "PRINT_FILE" as const,
    mimeType: uploaded.format === "png" ? "image/png" : "image/jpeg",
    sizeBytes: uploaded.bytes,
    originalName: `${name}.${uploaded.format || input.spec.format}`,
    metadata: { provider: "cloudinary", publicId: uploaded.publicId, version: uploaded.version, width: uploaded.width, height: uploaded.height, role: "print_file", orderItemId: input.itemId, pages: input.pageUrls, order: input.spec.pages },
  };
  await prisma.asset.upsert({ where: { objectKey }, create: { objectKey, ...data }, update: data });
  return { url: uploaded.secureUrl, width: uploaded.width, height: uploaded.height };
}

// Whether a print file can be downloaded by the print shop (no credentials) and is really a PDF. With
// `expected`, the file delivered must also be exactly the one made: the total size (Content-Range) and, when the
// CDN gives it, the ETag (Cloudinary's ETag is the file's MD5, checked 2026-11-26). Cloudinary blocks PDF
// delivery unless "Allow delivery of PDF and ZIP files" is on (answering 401).
export async function pdfDeliverable(url: string, expected?: { bytes: number; md5?: string } | null, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; reason: string; corrupt?: boolean }> {
  try {
    const response = await fetchImpl(url, { headers: { Range: "bytes=0-7" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const head = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()).slice(0, 5));
    if ((response.status === 200 || response.status === 206) && head === "%PDF-") {
      if (!expected) return { ok: true };
      const total = Number(response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1] ?? (response.status === 200 ? response.headers.get("content-length") : NaN));
      const etag = response.headers.get("etag")?.replace(/^W\//, "").replace(/"/g, "") || null;
      if (Number.isFinite(total) && total !== expected.bytes) return { ok: false, corrupt: true, reason: `the stored PDF is ${total} bytes instead of ${expected.bytes}` };
      if (expected.md5 && etag && /^[0-9a-f]{32}$/i.test(etag) && etag.toLowerCase() !== expected.md5) return { ok: false, corrupt: true, reason: `the stored PDF's checksum (${etag}) differs from the file made (${expected.md5})` };
      return { ok: true };
    }
    if (response.status === 401 && /res\.cloudinary\.com/.test(url)) return { ok: false, reason: "Cloudinary blocks downloading PDF files. In Cloudinary → Settings → Security, turn on “Allow delivery of PDF and ZIP files”, then press “Check again”" };
    return { ok: false, reason: `the PDF link answers HTTP ${response.status}${head === "%PDF-" ? "" : " and is not a PDF"}` };
  } catch (reason) {
    return { ok: false, reason: `the PDF link could not be read (${reason instanceof Error ? reason.message : "error"})` };
  }
}

// Gelato accepts at most 10 MiB for this PDF. Start at the professional 300 DPI target and step down
// only when the complete PDF still exceeds the provider limit. The last profile remains suitable for
// the calendar's physical size and is preferable to silently submitting an oversized file.
const CALENDAR_IMAGE_PROFILES = [
  { dpi: 300, quality: 75 },
  { dpi: 300, quality: 65 },
  { dpi: 240, quality: 70 },
  { dpi: 200, quality: 65 },
  { dpi: 150, quality: 60 },
] as const;

function calendarMaxBytes() {
  const configured = Number(process.env.GELATO_CALENDAR_MAX_PDF_BYTES);
  return Number.isInteger(configured) && configured >= 1_000_000 ? configured : CALENDAR_MAX_BYTES;
}

// cs_srgb: Cloudinary converts the photo to sRGB (phone photos are often Display P3, some carry
// non-standard compact profiles); the PDF then embeds it as plain RGB without the profile
// (lib/pod/calendar-pdf.ts stripJpegMetadata), so the colours print as the customer saw them.
// Pixel size of a photo box for the print file. Gelato wants 150–300 dpi at actual size: rounding to the
// nearest pixel can land a hair above 300 dpi (e.g. 300.04), so the top profile rounds down and the lowest
// one up. (boxPixels, rounding to nearest, stays what the studio recommends.)
export function calendarPrintPixels(box: Box, dpi: number) {
  const round = dpi >= CALENDAR_MAX_DPI ? Math.floor : dpi <= CALENDAR_MIN_DPI ? Math.ceil : Math.round;
  return { width: round((box.width / 25.4) * dpi), height: round((box.height / 25.4) * dpi) };
}

export function calendarPhotoUrl(url: string, box: Box, profile: { dpi: number; quality: number }) {
  const { width, height } = calendarPrintPixels(box, profile.dpi);
  const source = url.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/);
  if (!source) throw new Error("A calendar photo is not an upload from this shop");
  return `${source[1]}c_fill,g_center,w_${width},h_${height},q_${profile.quality},f_jpg,cs_srgb/${source[2]}`;
}

// A photo cut to its box by Cloudinary. A large transformation can answer 420 / 5xx or time out the first time
// it is made: retried twice (1 s, 3 s). The answer must be a complete JPEG (the PDF builder checks it).
async function boxPhoto(url: string, box: Box, profile: { dpi: number; quality: number }) {
  const address = calendarPhotoUrl(url, box, profile);
  let failure = "unknown error";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(address, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return bytes;
        failure = `the answer is not a complete JPEG (${bytes.byteLength} bytes)`;
      } else {
        failure = `HTTP ${response.status}`;
        if (!(response.status === 420 || response.status === 429 || response.status >= 500)) break;
      }
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : "network error";
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * 3 ** (attempt - 1)));
  }
  throw new Error(`A calendar photo could not be read (${failure})`);
}

// The 14-page calendar PDF (cover, 12 months, back) made from the customer's photos, saved as this item's
// print file. The cover uses the customer's own cover photo, or (calendars ordered without one) the first
// month photo. Photos that are not uploads from this site are left out (their month gets a plain page).
export async function renderCalendarFile(input: { orderId: string; itemId: string; unit: number; area: string; photos: (string | null)[]; cover?: string | null; year: number; language: CalendarLanguage; pageMm: { width: number; height: number } }) {
  const layout = calendarLayout(input.pageMm);
  const usable = input.photos.map((url) => (url && isCloudinaryUrl(url) ? url : null));
  const cover = (input.cover && isCloudinaryUrl(input.cover) ? input.cover : null) ?? usable.find(Boolean) ?? null;
  const maxBytes = calendarMaxBytes();
  const optimizedPhotos = new Map<string, Promise<Uint8Array>>();
  const photoFor = (url: string, box: Box, profile: { dpi: number; quality: number }) => {
    const key = `${url}|${box.width}x${box.height}|${profile.dpi}|${profile.quality}`;
    const existing = optimizedPhotos.get(key);
    if (existing) return existing;
    const request = boxPhoto(url, box, profile);
    optimizedPhotos.set(key, request);
    return request;
  };

  let bytes: Uint8Array | null = null;
  let selected: { dpi: number; quality: number; attempt: number; validation: Awaited<ReturnType<typeof validateCalendarPdf>> } | null = null;
  for (const [index, profile] of CALENDAR_IMAGE_PROFILES.entries()) {
    const [monthPhotos, coverPhoto] = await Promise.all([
      Promise.all(usable.map((url) => (url ? photoFor(url, layout.month, profile) : Promise.resolve(null)))),
      cover ? photoFor(cover, layout.cover, profile) : Promise.resolve(null),
    ]);
    const candidate = await buildCalendarPdf({ page: input.pageMm, year: input.year, language: input.language, monthPhotos, coverPhoto });
    try {
      const validation = await validateCalendarPdf(candidate, input.pageMm, maxBytes, { year: input.year, language: input.language });
      selected = { dpi: profile.dpi, quality: profile.quality, attempt: index + 1, validation };
      bytes = candidate;
      console.info("[pod] calendar PDF validated", { itemId: input.itemId, attempt: index + 1, dpi: profile.dpi, quality: profile.quality, bytes: candidate.byteLength, pages: validation.pages, pageMm: validation.pageMm, bleedMm: validation.bleedMm });
      break;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "calendar PDF validation failed";
      if (candidate.byteLength > maxBytes && message.includes("allows at most")) {
        console.warn("[pod] calendar PDF exceeds the upload limit; retrying with smaller photos", { itemId: input.itemId, attempt: index + 1, dpi: profile.dpi, quality: profile.quality, bytes: candidate.byteLength, maxBytes });
        continue;
      }
      throw reason;
    }
  }
  if (!bytes || !selected) throw new Error(`Calendar PDF remains above the ${maxBytes}-byte upload limit after ${CALENDAR_IMAGE_PROFILES.length} optimization attempts`);
  const name = `${input.itemId}-${input.unit + 1}-${input.area}-calendar.pdf`;
  const uploaded = await uploadFileToCloudinary({ bytes, folder: `celebramomentos/print_file/${input.orderId}`, publicId: name, contentType: "application/pdf" });
  // What the print shop will download must be exactly the file made and checked (size and MD5). A link
  // Cloudinary refuses to deliver (PDF delivery setting) is reported by the caller as an unreachable file.
  const delivered = await pdfDeliverable(uploaded.secureUrl, { bytes: bytes.byteLength, md5: uploaded.md5 });
  if (!delivered.ok && delivered.corrupt) throw new Error(`The uploaded calendar PDF is incomplete or corrupted: ${delivered.reason}`);
  const objectKey = cloudinaryObjectKey(uploaded.publicId);
  const data = {
    bucket: "cloudinary",
    url: uploaded.secureUrl,
    kind: "PRINT_FILE" as const,
    mimeType: "application/pdf",
    sizeBytes: uploaded.bytes || bytes.byteLength,
    originalName: name,
    metadata: { provider: "cloudinary", resourceType: "raw", publicId: uploaded.publicId, version: uploaded.version, md5: uploaded.md5, uploadAttempts: uploaded.attempts, pdfVersion: CALENDAR_PDF_VERSION, pages: CALENDAR_PAGES, pageMm: input.pageMm, pdfPageMm: selected.validation.pageMm, bleedMm: selected.validation.bleedMm, dpi: selected.dpi, quality: selected.quality, optimizationAttempts: selected.attempt, bytes: bytes.byteLength, maxBytes, role: "print_file", orderItemId: input.itemId, photos: usable.filter(Boolean).length, coverPhoto: Boolean(input.cover && isCloudinaryUrl(input.cover)) },
  };
  await prisma.asset.upsert({ where: { objectKey }, create: { objectKey, ...data }, update: data });
  return { url: uploaded.secureUrl, pages: CALENDAR_PAGES, bytes: bytes.byteLength, md5: uploaded.md5, pageMm: selected.validation.pageMm, bleedMm: selected.validation.bleedMm, dpi: selected.dpi, quality: selected.quality, optimizationAttempts: selected.attempt, maxBytes };
}

// Files uploaded through this site, by URL, with the pixel size Cloudinary reported on upload.
export async function uploadedFiles(urls: (string | null | undefined)[]) {
  const wanted = Array.from(new Set(urls.filter((url): url is string => Boolean(url))));
  const assets = wanted.length ? await prisma.asset.findMany({ where: { url: { in: wanted } }, select: { url: true, kind: true, mimeType: true, metadata: true } }) : [];
  return new Map(assets.map((asset) => {
    const meta = asset.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata) ? (asset.metadata as Record<string, unknown>) : {};
    return [asset.url!, { width: Number(meta.width) || 0, height: Number(meta.height) || 0, mimeType: asset.mimeType, kind: asset.kind } satisfies UploadedFile];
  }));
}
