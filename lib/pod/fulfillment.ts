// Print-on-demand fulfilment: turns a paid order into one PodFulfillment per print
// shop, sends it, and keeps its status and tracking in sync. Server only.
//
// Safety rules enforced here:
// - Fulfilments are created only for orders whose payment the server verified (order
//   PAID+ with a SUCCEEDED payment); nothing coming from the browser is trusted.
// - (orderId, provider) is unique and the READY/FAILED → SUBMITTING update is
//   conditional, so an order is never sent twice even if several triggers race.
// - A submission whose outcome is unknown is first looked up at the shop by reference
//   (Prodigi idempotencyKey, Printful external_id, Printeers customIdentifier, Gelato search).
// - Failures never lose the order: it stays FAILED with the error and is retried.
import { Prisma, type OrderItem, type PodFulfillment, type PodProvider } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { normalizeCrop, normalizeMugCrops, type ImageCrop } from "@/lib/crop";
import { CALENDAR_COVER_INDEX, POD_PROVIDERS, podProviderFor, variantAttributes } from "@/lib/products";
import { prisma } from "@/lib/server/prisma";
import { CARD_SIZES } from "@/lib/data";
import type { CardDesignSide } from "@/lib/store";
import { STORED_STATUS, printStage } from "@/lib/order-progress";
import { podProviderLabel } from "@/lib/products";
import { checkPhotoResolution, checkPrintFileSize, isCloudinaryUrl, mugFileUrl, printFileUrl, type PhotoFit, type PrintSpec } from "./artwork";
import { mapOrderItem, wallArtPosterPaper } from "./catalog";
import { podAutoSubmit, podEnvironmentProblem, podMode } from "./config";
import { PodApiError, redact } from "./http";
import { pdfDeliverable, renderCalendarFile, renderCompositeFile, renderPrintFile, uploadedFiles, type UploadedFile } from "./print-files";
import { boxPixels, calendarLayout, CALENDAR_PDF_VERSION, monthName, type CalendarLanguage } from "./calendar-pdf";
import { podAdapter } from "./providers";
import { mergeTracking, readTracking, resolveItems, trackingDates, withStatusChange } from "./tracking";
import type { PodFulfillmentStatus, PodIssue, PodMode, ProviderOrderState, Recipient, SubmissionLine } from "./types";

const PAID_ORDER = ["PAID", "PROCESSING", "SHIPPED", "DELIVERED"] as const;
const SHORT: Partial<Record<PodProvider, string>> = { PRODIGI: "PRD", GELATO: "GEL", PRINTFUL: "PF", PRINTEERS: "PRT" };
const MAX_AUTO_ATTEMPTS = 6;
// Orders paid before print-on-demand went live were handled by hand; never send them automatically.
export const POD_ENABLED_SINCE = new Date("2026-11-01T00:00:00Z");

// One print file slot of an order item (stored in OrderItem.podArtwork).
// - url / source: the file sent to the shop. "design" = rendered by the site from the
//   customer's design at the required size; "admin" = attached by an admin;
//   "customer" = link to the customer's photo (older orders, or rendering failed).
// - width / height / format: what the shop requires; verified: the file's real pixel size.
// - original: the customer's original upload; references: the customer's card pages.
export type DesignReference = { label: string; side?: string; url: string; width?: number; height?: number };
// kind: how the file is made — "photo" / "pages" / "calendar" automatically by the site, "admin" attached by
// hand (only products with no automatic file). Missing on slots saved before it existed.
// signature: what a generated file was made from (calendar: year, language, size, photos), to reuse it.
// file (calendar PDFs): the generated file's size and MD5 (checked against what is delivered) and the photo
// resolution and JPEG quality it was saved with.
export type ArtworkSlot = { unit: number; productRef: string | null; area: string; url: string | null; source: "design" | "customer" | "admin" | null; kind?: "photo" | "pages" | "admin" | "calendar"; description?: string; width?: number; height?: number; format?: "jpg" | "png" | "pdf"; fit?: PhotoFit; original?: string | null; verified?: { width: number; height: number } | null; references?: DesignReference[]; signature?: string; pages?: number; file?: { bytes: number; md5: string; dpi: number; quality: number; maxBytes: number } };

const asObject = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asString = (value: unknown) => (typeof value === "string" ? value : null);
export const readArtwork = (value: Prisma.JsonValue | null) => (Array.isArray(value) ? (value as unknown as ArtworkSlot[]) : []);
export const readIssues = (value: Prisma.JsonValue | null) => (Array.isArray(value) ? (value as unknown as PodIssue[]) : []);

function backoff(attempts: number) {
  return new Date(Date.now() + Math.min(5 * 60_000 * 2 ** Math.max(0, attempts - 1), 24 * 3_600_000));
}

export function logPod(message: string, details: Record<string, unknown>) {
  console.error(`[pod] ${message}`, redact(details));
}

async function orderIsPaid(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, payments: { where: { status: "SUCCEEDED" }, select: { id: true } } } });
  return Boolean(order && (PAID_ORDER as readonly string[]).includes(order.status) && order.payments.length);
}

// ── Preparing an order ───────────────────────────────────────────────────────

type ItemPlan = { item: OrderItem; provider: PodProvider; productRef: string | null; artwork: ArtworkSlot[]; issues: PodIssue[] };

// `fixedProvider`: an item that already has a print order keeps that order's shop when it is
// planned again (an item kept from a print shop that is no longer used is not re-routed).
export async function planItem(item: OrderItem, previous: ArtworkSlot[], fixedProvider?: PodProvider): Promise<ItemPlan> {
  const personalization = asObject(item.personalization);
  const product = asObject(personalization.product);
  const isCatalog = product.kind === "CATALOG";
  const kind = isCatalog ? String(product.productKind || "") : "POSTCARD";
  const declared = isCatalog ? product.provider : personalization.provider;
  const provider: PodProvider = fixedProvider ?? podProviderFor(kind, declared);
  const variant = item.variantId ? await prisma.productVariant.findUnique({ where: { id: item.variantId }, select: { name: true, attributes: true } }) : null;
  const podSku = asString(product.sku) || (variant ? variantAttributes(variant.attributes).podSku : null);
  const photos = (Array.isArray(product.photos) ? product.photos : []).map((photo) => (typeof photo === "string" && /^https:\/\//.test(photo) ? photo : null));
  const options = Object.fromEntries(Object.entries(asObject(product.options)).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  const mapping = mapOrderItem({
    kind,
    provider,
    productName: asString(product.name) || item.name,
    variantName: variant?.name || null,
    podSku,
    options,
    photoCount: photos.filter(Boolean).length,
    cardSize: asString(personalization.cardSize),
    cardSku: asString(personalization.sku),
    printeers: printeersSelection(product.printeers),
    crop: kind === "MUG" ? normalizeCrop(product.crop as Partial<ImageCrop>) : null,
    mugCrops: kind === "MUG" && product.mugCrops ? normalizeMugCrops(product.mugCrops as { front?: Partial<ImageCrop>; back?: Partial<ImageCrop> }, product.crop as Partial<ImageCrop>) : null,
    // Planned again (e.g. resent): a poster keeps the paper it was first sent with.
    posterPaper: kind === "WALL_ART" ? wallArtPosterPaper(item.podProductRef) : undefined,
  });
  const issues = [...mapping.issues];
  const artwork: ArtworkSlot[] = [];
  const card = asObject(personalization.card);
  const designPanels = (Array.isArray(asObject(card.design).panels) ? asObject(card.design).panels as unknown[] : []).map(asObject);
  // Real pixel sizes of the customer's uploads, attached files and card pages, from our upload records.
  const files = await uploadedFiles([...photos, ...previous.map((slot) => slot.url), ...designPanels.map((panel) => asString(panel.url))]);
  const sizeOf = (url: string | null | undefined) => { const file = url ? files.get(url) : undefined; return file && file.width && file.height && file.mimeType !== "application/pdf" ? { width: file.width, height: file.height } : null; };
  // Pages an admin rendered later are kept; otherwise the ones saved at checkout are used.
  const savedPages = previous.find((slot) => slot.references?.length)?.references;
  const cardPages = kind === "POSTCARD" ? savedPages ?? cardDesignPages(designPanels, asString(card.size), files, issues) : [];

  await Promise.all(mapping.units.map(async (unit, unitIndex) => {
    const prefix = unit.label ? `${unit.label}: ` : "";
    for (const spec of unit.specs as PrintSpec[]) {
      const before = previous.find((slot) => slot.unit === unitIndex && slot.area === spec.area);
      const attached = before?.source === "admin" && before.url ? before : null;
      const required = spec.kind === "photo" ? (spec.width ? { width: spec.width, height: spec.height } : {}) : spec.kind !== "calendar" && spec.width && spec.height ? { width: spec.width, height: spec.height } : {};
      if (spec.kind === "mug") {
        if (attached) {
          const verified = sizeOf(attached.url);
          artwork.push({ kind: "photo", ...attached, productRef: unit.productRef, area: spec.area, width: spec.width, height: spec.height, format: spec.format, original: null, verified });
          const problem = checkPrintFileSize({ width: spec.width, height: spec.height }, verified, `${prefix}Attached mug print file`);
          if (problem) issues.push(problem);
          continue;
        }
        const front = photos[spec.photoIndex];
        const back = photos[spec.backPhotoIndex];
        const signature = `${front || ""}|${back || ""}|${JSON.stringify(spec.crop)}|${JSON.stringify(spec.backCrop)}`;
        if (!front || !back) {
          issues.push({ code: "missing_photos", severity: "blocker", message: `${prefix}Both front and back mug photos are required` });
          artwork.push({ kind: "photo", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: null, source: null, width: spec.width, height: spec.height, format: spec.format, original: signature });
          continue;
        }
        const frontSize = sizeOf(front);
        const backSize = sizeOf(back);
        const halfSpec = { area: spec.area, kind: "photo" as const, photoIndex: 0, fit: "fill" as const, width: Math.floor(spec.width / 2), height: spec.height, format: spec.format, crop: spec.crop };
        const backHalfSpec = { ...halfSpec, crop: spec.backCrop };
        const frontWarning = checkPhotoResolution(halfSpec, frontSize, { accepted: product.qualityAccepted === true });
        const backWarning = checkPhotoResolution(backHalfSpec, backSize, { accepted: product.qualityAccepted === true });
        if (frontWarning) issues.push({ ...frontWarning, message: `${prefix}Front photo: ${frontWarning.message}` });
        if (backWarning) issues.push({ ...backWarning, message: `${prefix}Back photo: ${backWarning.message}` });
        const reusable = before?.source === "design" && before.url && before.verified && before.original === signature && before.width === spec.width && before.height === spec.height && before.format === spec.format ? { url: before.url, ...before.verified } : null;
        let stored = reusable;
        let failure: string | null = null;
        if (!stored) {
          if (!isCloudinaryUrl(front) || !isCloudinaryUrl(back) || !files.has(front) || !files.has(back)) failure = "the front and back photos are not uploads from this shop";
          else {
            const url = mugFileUrl(front, back, spec, frontSize, backSize);
            if (!url) failure = "the front and back photos could not be composed";
            else stored = await renderPrintFile({ orderId: item.orderId, itemId: item.id, unit: unitIndex, area: spec.area, sourceUrl: front, sourceUrl2: back, sourceSize: frontSize, sourceSize2: backSize, spec, composedUrl: url }).catch((reason) => { failure = reason instanceof Error ? reason.message : "unknown error"; return null; });
          }
        }
        if (stored) {
          const verified = { width: stored.width, height: stored.height };
          artwork.push({ kind: "photo", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: stored.url, source: "design", width: spec.width, height: spec.height, format: spec.format, original: signature, verified });
          const problem = checkPrintFileSize({ width: spec.width, height: spec.height }, verified, `${prefix}Mug print file`);
          if (problem) issues.push(problem);
          continue;
        }
        logPod("mug print file not rendered", { itemId: item.id, unit: unitIndex, area: spec.area, failure });
        artwork.push({ kind: "photo", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: mugFileUrl(front, back, spec, frontSize, backSize), source: "customer", width: spec.width, height: spec.height, format: spec.format, original: signature, verified: null });
        issues.push({ code: "print_file_unverified", severity: "warning", message: `${prefix}The front/back mug print file could not be saved (${failure}); retry it before sending` });
        continue;
      }
      if (spec.kind === "pages") {
        // Greeting cards: the print file is composed automatically from the 4 pages the customer's
        // browser rendered at checkout (the customer's real design), in the SKU's page order and at its
        // exact print size. A file composed earlier from the same pages at the same size is reused,
        // so retries never create it again.
        const required = { width: spec.width, height: spec.height };
        const bySide = new Map(cardPages.map((page) => [page.side, page]));
        const ordered = spec.pages.map((side) => bySide.get(side) ?? null);
        const references = cardPages;
        const missing = spec.pages.filter((_, index) => !ordered[index]);
        if (missing.length) {
          artwork.push({ kind: "pages", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: null, source: null, description: spec.description, ...required, format: spec.format, ...(references.length ? { references } : {}) });
          issues.push({ code: "design_missing", severity: "blocker", message: `${prefix}The customer's card pages were not saved at checkout (missing: ${missing.join(", ")}). Create them once with “Create card pages from saved design”; the print file is then made and sent automatically` });
          continue;
        }
        const pageUrls = ordered.map((page) => page!.url);
        const signature = pageUrls.join(" ");
        const reusable = before?.source === "design" && before.url && before.verified && before.original === signature && before.width === spec.width && before.height === spec.height ? { url: before.url, ...before.verified } : null;
        let failure: string | null = null;
        const stored = reusable ?? await renderCompositeFile({ orderId: item.orderId, itemId: item.id, unit: unitIndex, pageUrls, spec }).catch((reason) => { failure = reason instanceof Error ? reason.message : "unknown error"; return null; });
        if (!stored) {
          logPod("card print file not composed", { itemId: item.id, failure });
          artwork.push({ kind: "pages", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: null, source: null, description: spec.description, ...required, format: spec.format, references });
          issues.push({ code: "print_file_render_failed", severity: "blocker", message: `${prefix}The card print file could not be made yet (${failure}); it is retried automatically` });
          continue;
        }
        const verified = { width: stored.width, height: stored.height };
        artwork.push({ kind: "pages", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: stored.url, source: "design", description: spec.description, ...required, format: spec.format, original: signature, verified, references });
        // Never sent unless it is exactly the size the print shop requires.
        const problem = checkPrintFileSize(required, verified, `${prefix}Card print file`);
        if (problem) issues.push(problem);
        continue;
      }
      if (spec.kind === "calendar") {
        // Wall calendars: the 14-page PDF is made from the customer's month photos (only uploads from this
        // site). It is made once and reused while the photos, year, language and size stay the same. A file
        // an admin attached instead is kept.
        if (attached) {
          artwork.push({ kind: "calendar", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: attached.url, source: "admin", description: spec.description, format: "pdf", verified: null });
          const reachable = await pdfDeliverable(attached.url!);
          if (!reachable.ok) issues.push({ code: "print_file_unreachable", severity: "blocker", message: `${prefix}The print shop could not download the attached calendar file: ${reachable.reason}` });
          continue;
        }
        const monthPhotos = Array.from({ length: 12 }, (_, month) => { const url = photos[month]; return url && isCloudinaryUrl(url) && files.has(url) ? url : null; });
        // The customer's own front cover (photos[CALENDAR_COVER_INDEX]); without it the cover uses the first month photo.
        const coverUrl = photos[CALENDAR_COVER_INDEX];
        const cover = coverUrl && isCloudinaryUrl(coverUrl) && files.has(coverUrl) ? coverUrl : null;
        // The studio shows next year's calendar (CalendarStudio); the order's date stands for the day it was designed.
        const year = item.createdAt.getFullYear() + 1;
        const language = await calendarLanguage(item.orderId);
        // The generator version is part of the signature: a PDF made by an older generator (e.g. the ones Gelato's
        // preflight could not process) is made again instead of being reused.
        const signature = [year, language, `${spec.widthMm}x${spec.heightMm}`, ...monthPhotos.map((url) => url || "-"), ...(cover ? [`cover:${cover}`] : []), `pdf:v${CALENDAR_PDF_VERSION}`].join("|");
        const pageMm = { width: spec.widthMm, height: spec.heightMm };
        const base = { kind: "calendar" as const, unit: unitIndex, productRef: unit.productRef, area: spec.area, description: spec.description, format: "pdf" as const };
        if (!monthPhotos.some(Boolean)) {
          artwork.push({ ...base, url: null, source: null });
          issues.push({ code: "missing_photos", severity: "blocker", message: `${prefix}The calendar has no photo that was uploaded to this site` });
          continue;
        }
        const reusable = before?.kind === "calendar" && before.source === "design" && before.url && before.signature === signature ? before : null;
        let failure: string | null = null;
        const made = reusable ? null : await renderCalendarFile({ orderId: item.orderId, itemId: item.id, unit: unitIndex, area: spec.area, photos: monthPhotos, cover, year, language, pageMm }).catch((reason) => { failure = reason instanceof Error ? reason.message : "unknown error"; return null; });
        const url = reusable?.url ?? made?.url ?? null;
        // Kept on the slot so every later check verifies the stored file and the note below survives reuse.
        const file = made ? { bytes: made.bytes, md5: made.md5, dpi: made.dpi, quality: made.quality, maxBytes: made.maxBytes } : reusable?.file ?? null;
        if (!url) {
          logPod("calendar print file not made", { itemId: item.id, failure });
          artwork.push({ ...base, url: null, source: null });
          issues.push({ code: "print_file_render_failed", severity: "blocker", message: `${prefix}The calendar PDF could not be made yet (${failure}); it is retried automatically` });
          continue;
        }
        artwork.push({ ...base, url, source: "design", signature, pages: 14, verified: null, ...(file ? { file } : {}) });
        // Never send a link the print shop cannot open, nor a stored file that is not the one made and checked.
        const reachable = await pdfDeliverable(url, file);
        if (!reachable.ok) issues.push({ code: "print_file_unreachable", severity: "blocker", message: `${prefix}The calendar PDF was made, but the print shop could not download it${reachable.corrupt ? " intact" : ""}: ${reachable.reason}` });
        // Photos are stepped down only to fit the file storage's upload limit; the admin is told, never silently.
        if (file && (file.dpi < 300 || file.quality < 75)) issues.push({ code: "calendar_photos_reduced", severity: "info", message: `${prefix}To stay within the ${Math.round(file.maxBytes / 1_048_576)} MB upload limit of the file storage, the calendar photos were saved at ${file.dpi} dpi, JPEG quality ${file.quality} (within Gelato's 150–300 dpi). A larger storage plan avoids this` });
        // Notes for the admin (the calendar is still sent): empty months and photos below 150 dpi.
        const empty = monthPhotos.map((photo, month) => (photo ? null : monthName(language, month))).filter(Boolean);
        if (empty.length) issues.push({ code: "calendar_months_without_photo", severity: "info", message: `${prefix}${12 - empty.length} of 12 months have a photo; ${empty.join(", ")} get a page with the month name instead` });
        const box = boxPixels(calendarLayout(pageMm).month);
        const low = monthPhotos.map((photo, month) => { const size = sizeOf(photo); return size && Math.max(box.width / size.width, box.height / size.height) > 2 ? monthName(language, month) : null; }).filter(Boolean);
        const coverBox = boxPixels(calendarLayout(pageMm).cover);
        const coverSize = sizeOf(cover);
        if (coverSize && Math.max(coverBox.width / coverSize.width, coverBox.height / coverSize.height) > 2) low.unshift("cover");
        if (low.length) issues.push({ code: "low_resolution", severity: "info", message: `${prefix}Photos below 150 dpi on the calendar page: ${low.join(", ")}` });
        continue;
      }
      if (spec.kind === "admin") {
        // A file an admin attached earlier is kept when the item is planned again; the
        // card pages the customer designed are kept beside it for reference.
        const references = cardPages;
        const verified = attached ? sizeOf(attached.url) : null;
        artwork.push({ kind: "admin", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: attached?.url || null, source: attached ? "admin" : null, description: spec.description, ...required, verified, ...(references.length ? { references } : {}) });
        if (!attached) issues.push({ code: "print_file_required", severity: "blocker", message: `${prefix}Print file needed: ${spec.description}` });
        else { const problem = checkPrintFileSize(required, verified, `${prefix}Attached print file`); if (problem) issues.push(problem); }
        continue;
      }
      const source = photos[spec.photoIndex];
      const fit = { fit: spec.fit, ...required };
      if (attached) {
        const verified = sizeOf(attached.url);
        artwork.push({ kind: "photo", ...attached, productRef: unit.productRef, ...required, format: spec.format, fit: spec.fit, original: source, verified });
        const problem = checkPrintFileSize(fit, verified, `${prefix}Attached print file`);
        if (problem) issues.push(problem);
        continue;
      }
      if (!source) {
        issues.push({ code: "missing_photos", severity: "blocker", message: `${prefix}Photo ${spec.photoIndex + 1} is missing` });
        artwork.push({ kind: "photo", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: null, source: null, ...required, format: spec.format, fit: spec.fit });
        continue;
      }
      const warning = checkPhotoResolution(spec, sizeOf(source), { accepted: product.qualityAccepted === true });
      if (warning) issues.push({ ...warning, message: `${prefix}${warning.message}` });
      // The final file is rendered once and reused while the photo and the required size stay the same.
      const reusable = before?.source === "design" && before.url && before.verified && before.original === source && before.width === required.width && before.height === required.height && before.format === spec.format ? { url: before.url, ...before.verified } : null;
      let stored = reusable;
      let failure: string | null = null;
      if (!stored) {
        if (!isCloudinaryUrl(source) || !files.has(source)) failure = "the photo is not an upload from this shop";
        else stored = await renderPrintFile({ orderId: item.orderId, itemId: item.id, unit: unitIndex, area: spec.area, sourceUrl: source, sourceSize: sizeOf(source), spec }).catch((reason) => { failure = reason instanceof Error ? reason.message : "unknown error"; return null; });
      }
      if (stored) {
        const verified = { width: stored.width, height: stored.height };
        artwork.push({ kind: "photo", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: stored.url, source: "design", ...required, format: spec.format, fit: spec.fit, original: source, verified });
        const problem = checkPrintFileSize(fit, verified, `${prefix}Print file`);
        if (problem) issues.push(problem);
        continue;
      }
      // Never silently send an unchecked file: the order waits until it is rendered or an admin checks it.
      logPod("print file not rendered", { itemId: item.id, unit: unitIndex, area: spec.area, failure });
      artwork.push({ kind: "photo", unit: unitIndex, productRef: unit.productRef, area: spec.area, url: printFileUrl(source, spec, sizeOf(source)), source: "customer", ...required, format: spec.format, fit: spec.fit, original: source, verified: null });
      issues.push({ code: "print_file_unverified", severity: "warning", message: `${prefix}The final print file could not be saved (${failure}); a link to the customer's photo is used instead. Press “Check again” to retry, or open it before sending` });
    }
  }));
  artwork.sort((a, b) => a.unit - b.unit);
  const refs = Array.from(new Set(mapping.units.map((unit) => unit.productRef).filter(Boolean)));
  return { item, provider, productRef: refs.join(", ") || null, artwork, issues };
}

// Calendar language: Portuguese for orders shipped to Portugal, Spanish otherwise.
async function calendarLanguage(orderId: string): Promise<CalendarLanguage> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { shippingAddress: true } }).catch(() => null);
  return asString(asObject(order?.shippingAddress).country)?.toUpperCase() === "PT" ? "pt" : "es";
}

const PAGE_LABEL: Record<CardDesignSide, string> = { front: "Front", "inside-left": "Inside left", "inside-right": "Inside right", back: "Back" };

// The card pages rendered at checkout, kept only if they are uploads from this site at
// the card's page size.
function cardDesignPages(panels: Record<string, unknown>[], size: string | null, files: Map<string, UploadedFile>, issues: PodIssue[]): DesignReference[] {
  const page = (CARD_SIZES.find((item) => item.id === size) || CARD_SIZES[0]).panel;
  const pages: DesignReference[] = [];
  for (const panel of panels) {
    const url = asString(panel.url);
    const side = asString(panel.side) as CardDesignSide | null;
    const file = url ? files.get(url) : undefined;
    if (!url || !side || !PAGE_LABEL[side] || !file || file.kind !== "CUSTOMER_UPLOAD") continue;
    if (file.width !== page.width || file.height !== page.height) issues.push({ code: "design_page_size", severity: "warning", message: `Card page "${PAGE_LABEL[side]}" is ${file.width} × ${file.height} px instead of ${page.width} × ${page.height} px` });
    pages.push({ label: PAGE_LABEL[side], side, url, width: file.width, height: file.height });
  }
  // Missing pages are reported by the print file that needs them (planItem).
  return pages;
}

// The Printeers part of a phone case selection, as validated by the server at checkout.
function printeersSelection(value: unknown) {
  const data = asObject(value);
  const reference = asString(data.productReference);
  if (!reference) return null;
  const mm = asObject(data.printMm);
  const crop = asObject(data.crop);
  return {
    productReference: reference,
    printMm: typeof mm.width === "number" && typeof mm.height === "number" ? { width: mm.width, height: mm.height } : null,
    crop: Object.keys(crop).length ? normalizeCrop(crop as Partial<ImageCrop>) : null,
  };
}

// Notes ("info") never hold a print order; blockers and warnings do.
const holds = (issues: PodIssue[]) => issues.filter((issue) => issue.severity !== "info");

function statusFor(issues: PodIssue[], configurationProblem: string | null): PodFulfillmentStatus {
  return holds(issues).length || configurationProblem ? "NEEDS_ATTENTION" : "READY";
}

// Creates the order's fulfilments (one per shop). Safe to call any number of times:
// existing fulfilments are kept and only items without one are added.
export async function prepareFulfillments(orderId: string) {
  if (!(await orderIsPaid(orderId))) return [];
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, fulfillments: true } });
  const pending = order.items.filter((item) => !item.podFulfillmentId);
  if (!pending.length) return order.fulfillments;
  const plans = await Promise.all(pending.map((item) => planItem(item, readArtwork(item.podArtwork))));
  const mode = podMode();
  await Promise.all(Array.from(new Set(plans.map((plan) => plan.provider))).map(async (provider) => {
    const group = plans.filter((plan) => plan.provider === provider);
    const problem = podEnvironmentProblem() ?? podAdapter(provider).configurationProblem(mode);
    let fulfillment = order.fulfillments.find((item) => item.provider === provider);
    if (!fulfillment) {
      try {
        fulfillment = await prisma.podFulfillment.create({ data: { orderId, provider, mode, reference: `${order.number}-${SHORT[provider] ?? "POD"}`, status: statusFor(group.flatMap((plan) => plan.issues), problem), lastError: problem, shippingMethod: asString(asObject(order.items[0]?.personalization).delivery) || "standard" } });
      } catch (reason) {
        // Another trigger created it at the same moment.
        if (!(reason instanceof Prisma.PrismaClientKnownRequestError && reason.code === "P2002")) throw reason;
        fulfillment = await prisma.podFulfillment.findUniqueOrThrow({ where: { orderId_provider: { orderId, provider } } });
      }
    }
    const fulfillmentId = fulfillment.id;
    await Promise.all(group.map((plan) => prisma.orderItem.updateMany({ where: { id: plan.item.id, podFulfillmentId: null }, data: { podFulfillmentId: fulfillmentId, podProvider: provider, podProductRef: plan.productRef, podArtwork: plan.artwork as unknown as Prisma.InputJsonValue, podIssues: plan.issues as unknown as Prisma.InputJsonValue } })));
    await refreshReadiness(fulfillmentId);
  }));
  return prisma.podFulfillment.findMany({ where: { orderId } });
}

// Re-checks a fulfilment that has not been sent yet (after an admin attached a file,
// changed a mapping or added credentials) and moves it between NEEDS_ATTENTION and READY.
export async function refreshReadiness(fulfillmentId: string, { replan = false } = {}) {
  const fulfillment = await prisma.podFulfillment.findUnique({ where: { id: fulfillmentId }, include: { items: true } });
  if (!fulfillment || !["NEEDS_ATTENTION", "READY", "FAILED"].includes(fulfillment.status)) return fulfillment;
  if (replan) {
    for (const item of fulfillment.items) {
      const plan = await planItem(item, readArtwork(item.podArtwork), fulfillment.provider);
      await prisma.orderItem.update({ where: { id: item.id }, data: { podProductRef: plan.productRef, podArtwork: plan.artwork as unknown as Prisma.InputJsonValue, podIssues: plan.issues as unknown as Prisma.InputJsonValue } });
    }
  }
  // The shop already has an order for it (one it failed or cancelled): it stays FAILED, with the shop's
  // reason, until an admin resends it as a new order (resendFulfillment) or cancels it.
  if (fulfillment.providerOrderId) return prisma.podFulfillment.findUnique({ where: { id: fulfillmentId }, include: { items: true } });
  const items = replan ? await prisma.orderItem.findMany({ where: { podFulfillmentId: fulfillmentId } }) : fulfillment.items;
  const problem = podEnvironmentProblem() ?? podAdapter(fulfillment.provider).configurationProblem(podMode());
  const issues = items.flatMap((item) => readIssues(item.podIssues));
  const held = holds(issues);
  if (fulfillment.status === "FAILED" && !held.length && !problem) return fulfillment;
  return prisma.podFulfillment.update({ where: { id: fulfillmentId }, data: { status: statusFor(issues, problem), lastError: problem ?? (held.length ? held.map((issue) => issue.message).join(" · ").slice(0, 900) : null) } });
}

// ── Sending ──────────────────────────────────────────────────────────────────

function recipientOf(order: { email: string; shippingAddress: Prisma.JsonValue }): Recipient {
  const address = asObject(order.shippingAddress);
  return {
    name: asString(address.recipient) || asString(address.name) || "",
    email: order.email,
    phone: asString(address.phone),
    address1: asString(address.address) || "",
    address2: null,
    city: asString(address.city) || "",
    postalCode: asString(address.postalCode) || "",
    countryCode: (asString(address.country) || "ES").toUpperCase(),
    state: null,
  };
}

// Last check before anything is sent: every print file must exist and, when the shop gives an exact
// pixel size, be exactly that size (as measured when the file was stored). Pure, for tests.
export function artworkProblems(slots: ArtworkSlot[]) {
  const problems: string[] = [];
  for (const slot of slots) {
    const label = `Print file ${slot.unit + 1} (${slot.area})`;
    if (!slot.url) { problems.push(`${label} is missing`); continue; }
    if (!slot.width || !slot.height || slot.fit === "original" || slot.fit === "aspect") continue;
    if (!slot.verified) { if (slot.source !== "customer") problems.push(`${label}: its pixel size was not verified`); continue; }
    if (slot.verified.width !== slot.width || slot.verified.height !== slot.height) problems.push(`${label} is ${slot.verified.width} × ${slot.verified.height} px; ${slot.width} × ${slot.height} px is required`);
  }
  return problems;
}

function linesOf(items: OrderItem[]): SubmissionLine[] {
  return items.flatMap((item) => {
    const slots = readArtwork(item.podArtwork);
    const units = Array.from(new Set(slots.map((slot) => slot.unit))).sort((a, b) => a - b);
    return units.map((unit) => {
      const unitSlots = slots.filter((slot) => slot.unit === unit);
      return {
        itemId: units.length > 1 ? `${item.id}-${unit + 1}` : item.id,
        productRef: unitSlots[0]?.productRef || "",
        quantity: item.quantity,
        name: item.name.slice(0, 120),
        files: unitSlots.filter((slot) => slot.url).map((slot) => ({ area: slot.area, url: slot.url!, source: slot.source || "customer" })),
        ...(unitSlots.some((slot) => slot.kind === "calendar") ? { pageCount: unitSlots.find((slot) => slot.pages)?.pages ?? 14 } : {}),
      };
    });
  });
}

// A print order the shop cancelled by itself (Gelato cancels an order whose file it could not process; a
// draft deleted in the shop's dashboard reads as cancelled too) was never produced. Recording it as
// CANCELLED would let the customer's order look shipped once its other print orders ship (cancelled print
// orders are ignored by printStage), so it is recorded as FAILED with the reason, for an admin to resend or
// cancel. Pure, for tests.
export function unexpectedCancellation(currentStatus: PodFulfillmentStatus, state: ProviderOrderState, label: string, cancelledHere: boolean): ProviderOrderState | null {
  if (cancelledHere || state.status !== "CANCELLED" || !["SUBMITTING", "SUBMITTED", "IN_PRODUCTION", "FAILED"].includes(currentStatus)) return null;
  const reason = state.problem ? ` ${state.problem}` : "";
  return { ...state, status: "FAILED", problem: `${label} cancelled this order on its side (${state.providerStatus}); it was not produced.${reason} Fix the cause and use “Resend as new order”, or cancel it here if the customer no longer wants it.`.slice(0, 900) };
}

async function saveState(fulfillmentId: string, incoming: ProviderOrderState, extra: Prisma.PodFulfillmentUpdateInput = {}, { cancelledHere = false } = {}) {
  const current = await prisma.podFulfillment.findUniqueOrThrow({ where: { id: fulfillmentId }, include: { items: { select: { id: true, podProductRef: true } } } });
  const state = unexpectedCancellation(current.status, incoming, podProviderLabel(current.provider), cancelledHere) ?? incoming;
  // Never move backwards (e.g. a late "in production" push after "shipped").
  const rank: Record<string, number> = { SUBMITTED: 1, IN_PRODUCTION: 2, SHIPPED: 3, DELIVERED: 4 };
  const status = rank[current.status] && rank[state.status] && rank[state.status] < rank[current.status] ? current.status : state.status;
  // Shipments are merged into what is stored (several shipments, events kept once each) and the status
  // change, if any, is added to the history.
  const stored = readTracking(current.tracking);
  const merged = state.tracking ? mergeTracking(stored, resolveItems(state.tracking, current.items)) : stored;
  const tracking = withStatusChange(merged, current.providerStatus, state.providerStatus, podProviderLabel(current.provider));
  const dates = trackingDates(tracking);
  const changed = JSON.stringify(tracking) !== JSON.stringify(stored);
  const updated = await prisma.podFulfillment.update({
    where: { id: fulfillmentId },
    data: {
      ...extra,
      status,
      providerOrderId: state.providerOrderId || current.providerOrderId,
      providerStatus: state.providerStatus,
      carrier: state.carrier ?? current.carrier,
      trackingNumber: state.trackingNumber ?? current.trackingNumber,
      trackingUrl: state.trackingUrl ?? current.trackingUrl,
      lastSyncedAt: new Date(),
      ...(changed ? { tracking: tracking as unknown as Prisma.InputJsonValue } : {}),
      // What the print shop says is wrong with the order (or that it is fine again).
      ...(state.problem !== undefined ? { lastError: state.problem } : {}),
      // The shop's own dispatch / delivery dates when it gives them; otherwise when we first saw the status.
      ...((status === "SHIPPED" || status === "DELIVERED") && !current.shippedAt ? { shippedAt: dates.shippedAt ? new Date(dates.shippedAt) : new Date() } : {}),
      ...(status === "DELIVERED" && !current.deliveredAt ? { deliveredAt: dates.deliveredAt ? new Date(dates.deliveredAt) : new Date() } : {}),
      ...(state.raw !== undefined ? { lastResponse: redact(state.raw) as Prisma.InputJsonValue } : {}),
    },
  });
  await syncOrderStatus(updated.orderId);
  return updated;
}

export type SubmitResult = { ok: boolean; status: PodFulfillmentStatus; message?: string };

// Sends one fulfilment to its shop. `allowWarnings` lets an admin send an order held
// only for warnings (e.g. a low resolution photo) after checking it.
export async function submitFulfillment(fulfillmentId: string, { allowWarnings = false } = {}): Promise<SubmitResult> {
  const fulfillment = await prisma.podFulfillment.findUnique({ where: { id: fulfillmentId }, include: { items: true, order: true } });
  if (!fulfillment) return { ok: false, status: "FAILED", message: "Print order not found" };
  if (!(await orderIsPaid(fulfillment.orderId))) return { ok: false, status: fulfillment.status, message: "The order payment is not verified" };
  const issues = fulfillment.items.flatMap((item) => readIssues(item.podIssues));
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  const allowed: PodFulfillmentStatus[] = ["READY", "FAILED", ...(allowWarnings && !blockers.length ? (["NEEDS_ATTENTION"] as PodFulfillmentStatus[]) : [])];
  if (!allowed.includes(fulfillment.status)) return { ok: false, status: fulfillment.status, message: blockers.length ? blockers.map((issue) => issue.message).join(" · ") : fulfillment.lastError || `Print order is already ${fulfillment.status.toLowerCase().replace("_", " ")}` };
  // The shop already has an order under this reference that it failed: sending again would only find that
  // same failed order (or, at a shop without a reference lookup, create a duplicate). It is resent as a new
  // order on purpose instead (resendFulfillment).
  if (fulfillment.providerOrderId) return { ok: false, status: fulfillment.status, message: `${podProviderLabel(fulfillment.provider)} already has order ${fulfillment.providerOrderId} for this print order (${fulfillment.providerStatus || fulfillment.status.toLowerCase()}). Fix the cause, then use “Resend as new order”.` };
  const mode = podMode();
  const adapter = podAdapter(fulfillment.provider);
  const problem = podEnvironmentProblem() ?? adapter.configurationProblem(mode);
  if (problem) {
    await prisma.podFulfillment.update({ where: { id: fulfillmentId }, data: { status: "NEEDS_ATTENTION", lastError: problem } });
    return { ok: false, status: "NEEDS_ATTENTION", message: problem };
  }
  if (blockers.length) return { ok: false, status: fulfillment.status, message: blockers.map((issue) => issue.message).join(" · ") };
  const sizeProblems = artworkProblems(fulfillment.items.flatMap((item) => readArtwork(item.podArtwork)));
  if (sizeProblems.length) {
    const message = sizeProblems.join(" · ").slice(0, 900);
    await prisma.podFulfillment.update({ where: { id: fulfillmentId }, data: { status: "NEEDS_ATTENTION", lastError: message } });
    return { ok: false, status: "NEEDS_ATTENTION", message };
  }

  // The lock: only one caller can move it to SUBMITTING.
  const locked = await prisma.podFulfillment.updateMany({ where: { id: fulfillmentId, status: { in: allowed } }, data: { status: "SUBMITTING", mode, attempts: { increment: 1 }, lastError: null, nextAttemptAt: null } });
  if (locked.count !== 1) return { ok: false, status: "SUBMITTING", message: "This print order is already being sent" };
  const attempts = fulfillment.attempts + 1;
  try {
    // A previous attempt may have reached the shop before failing on our side.
    const existing = attempts > 1 ? await adapter.findByReference(fulfillment.reference, mode) : null;
    const state = existing || await adapter.submit({ reference: fulfillment.reference, orderNumber: fulfillment.order.number, mode, recipient: recipientOf(fulfillment.order), lines: linesOf(fulfillment.items), shipping: fulfillment.shippingMethod === "express" ? "express" : "standard" });
    const saved = await saveState(fulfillmentId, state, { submittedAt: new Date(), lastError: null });
    return { ok: true, status: saved.status };
  } catch (reason) {
    const retryable = reason instanceof PodApiError ? reason.retryable : false;
    const message = reason instanceof Error ? reason.message : "Unknown error";
    logPod("submission failed", { fulfillmentId, provider: fulfillment.provider, attempts, retryable, message });
    await prisma.podFulfillment.update({
      where: { id: fulfillmentId },
      data: { status: "FAILED", lastError: message.slice(0, 900), lastResponse: reason instanceof PodApiError ? (redact(reason.body) as Prisma.InputJsonValue) ?? Prisma.JsonNull : Prisma.JsonNull, nextAttemptAt: retryable && attempts < MAX_AUTO_ATTEMPTS ? backoff(attempts) : null },
    });
    return { ok: false, status: "FAILED", message };
  }
}

// Turns a draft (Gelato, Printful) into a real production order. Only in live mode.
export async function confirmDraft(fulfillmentId: string): Promise<SubmitResult> {
  const fulfillment = await prisma.podFulfillment.findUnique({ where: { id: fulfillmentId } });
  if (!fulfillment?.providerOrderId || fulfillment.mode !== "draft" || fulfillment.status !== "SUBMITTED") return { ok: false, status: fulfillment?.status ?? "FAILED", message: "Only a sent draft can be confirmed" };
  if (podMode() !== "live") return { ok: false, status: fulfillment.status, message: "Set POD_ORDER_MODE=live before confirming drafts for production" };
  if (!(await orderIsPaid(fulfillment.orderId))) return { ok: false, status: fulfillment.status, message: "The order payment is not verified" };
  const adapter = podAdapter(fulfillment.provider);
  if (!adapter.confirmDraft) return { ok: false, status: fulfillment.status, message: `${fulfillment.provider} has no drafts to confirm` };
  const state = await adapter.confirmDraft(fulfillment.providerOrderId);
  const saved = await saveState(fulfillmentId, state, { mode: "live" });
  return { ok: true, status: saved.status };
}

// Whether the shop's previous order can no longer be produced (or charged). Gelato cancels the payment of an
// order it failed (financialStatus "canceled"), so such an order is dead even though it reads "failed".
function previousOrderDead(provider: PodProvider, state: ProviderOrderState) {
  if (state.status === "CANCELLED") return true;
  const raw = asObject(state.raw);
  return provider === "GELATO" && state.status === "FAILED" && String(raw.financialStatus || "").toLowerCase() === "canceled";
}

// Sends a print order again as a NEW order at the shop after the shop failed or cancelled the previous one
// (e.g. a print file its preflight refused). Only on an admin's request. Safety:
// - the customer's payment is only read: never charged again, never refunded;
// - the previous order is read from the shop first and must be dead there (cancelled, or a Gelato order it
//   failed and stopped charging); one the shop only marks failed is cancelled there first. So two orders for
//   the same items never exist;
// - only in the mode it was first sent in (a test-paid order is never resent as a real one);
// - claimed atomically on (status, previous shop order id): two clicks resend it once;
// - the new order gets a new reference (…-R2, -R3…) and its print files are made again (planItem).
export async function resendFulfillment(fulfillmentId: string): Promise<SubmitResult> {
  const fulfillment = await prisma.podFulfillment.findUnique({ where: { id: fulfillmentId } });
  if (!fulfillment) return { ok: false, status: "FAILED", message: "Print order not found" };
  const label = podProviderLabel(fulfillment.provider);
  const previousId = fulfillment.providerOrderId;
  if (!previousId) return { ok: false, status: fulfillment.status, message: "The print shop never accepted this print order: use “Retry now” instead" };
  if (!["FAILED", "CANCELLED"].includes(fulfillment.status) || fulfillment.shippedAt) return { ok: false, status: fulfillment.status, message: "Only a print order the print shop failed or cancelled, and that never shipped, can be resent" };
  if (!(await orderIsPaid(fulfillment.orderId))) return { ok: false, status: fulfillment.status, message: "The order payment is not verified" };
  const mode: PodMode = fulfillment.mode === "live" ? "live" : "draft";
  if (podMode() !== mode) return { ok: false, status: fulfillment.status, message: `It was sent as a ${mode} order but the site now runs in ${podMode()} mode; it cannot be resent from here` };
  const adapter = podAdapter(fulfillment.provider);
  const problem = podEnvironmentProblem() ?? adapter.configurationProblem(mode);
  if (problem) return { ok: false, status: fulfillment.status, message: problem };

  let previous: ProviderOrderState | null;
  try {
    previous = await adapter.fetchStatus(previousId, mode);
    if (previous && !previousOrderDead(fulfillment.provider, previous) && previous.status === "FAILED") previous = await adapter.cancel(previousId, mode);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "unknown error";
    logPod("resend check failed", { fulfillmentId, provider: fulfillment.provider, message });
    return { ok: false, status: fulfillment.status, message: `${label} order ${previousId} could not be checked or cancelled (${message}); nothing was resent` };
  }
  if (!previous) return { ok: false, status: fulfillment.status, message: `${label} gives no status for order ${previousId}; nothing was resent` };
  if (!previousOrderDead(fulfillment.provider, previous)) return { ok: false, status: fulfillment.status, message: `${label} order ${previousId} is “${previous.providerStatus}”, not cancelled: it may still be produced, so nothing was resent. Refresh its status, or cancel it first` };

  const base = fulfillment.reference.replace(/-R\d+$/, "");
  const reference = `${base}-R${Number(fulfillment.reference.match(/-R(\d+)$/)?.[1] ?? 1) + 1}`;
  const note = `Resent as ${reference}: ${label} order ${previousId} (${previous.providerStatus}) was not produced`;
  const before = readTracking(fulfillment.tracking);
  const tracking = { shipments: [], estimatedDelivery: null, expectedDispatch: null, history: [...(before.history || []), { at: new Date().toISOString(), description: note, location: null }].slice(-50) };
  try {
    const claimed = await prisma.podFulfillment.updateMany({
      where: { id: fulfillmentId, status: fulfillment.status, providerOrderId: previousId },
      data: { status: "NEEDS_ATTENTION", reference, providerOrderId: null, providerStatus: null, carrier: null, trackingNumber: null, trackingUrl: null, attempts: 0, nextAttemptAt: null, submittedAt: null, lastSyncedAt: null, lastError: note, lastResponse: Prisma.JsonNull, tracking: tracking as unknown as Prisma.InputJsonValue },
    });
    if (claimed.count !== 1) return { ok: false, status: fulfillment.status, message: "Its state changed meanwhile; refresh and try again" };
  } catch (reason) {
    if (reason instanceof Prisma.PrismaClientKnownRequestError && reason.code === "P2002") return { ok: false, status: fulfillment.status, message: `Reference ${reference} is already used; refresh and try again` };
    throw reason;
  }
  logPod("resending print order", { fulfillmentId, provider: fulfillment.provider, previousId, previousStatus: previous.providerStatus, reference });
  // Print files are made again (a calendar PDF from an older generator is replaced) and checked.
  const ready = await refreshReadiness(fulfillmentId, { replan: true });
  if (ready?.status !== "READY") return { ok: false, status: ready?.status ?? "NEEDS_ATTENTION", message: `Ready to resend as ${reference}, but held: ${ready?.lastError || "check the print files"}` };
  return submitFulfillment(fulfillmentId);
}

// Cancels a print order. One not sent yet is simply marked cancelled (it is never sent); one sent is
// cancelled at the print shop first, which only works before production starts. Shipped orders and one being
// sent right now are refused. Never touches the payment: refunds are done in Stripe / PayPal.
export async function cancelFulfillment(fulfillmentId: string): Promise<SubmitResult> {
  const fulfillment = await prisma.podFulfillment.findUnique({ where: { id: fulfillmentId } });
  if (!fulfillment) return { ok: false, status: "FAILED", message: "Print order not found" };
  if (fulfillment.status === "CANCELLED") return { ok: true, status: "CANCELLED" };
  if (fulfillment.status === "SUBMITTING") return { ok: false, status: fulfillment.status, message: "It is being sent right now; try again in a minute" };
  if (fulfillment.status === "SHIPPED" || fulfillment.status === "DELIVERED") return { ok: false, status: fulfillment.status, message: "It has already shipped and can no longer be cancelled" };
  if (!fulfillment.providerOrderId) {
    // Claimed atomically, so a send that starts at the same moment cannot slip through.
    const claimed = await prisma.podFulfillment.updateMany({ where: { id: fulfillmentId, status: { in: ["NEEDS_ATTENTION", "READY", "FAILED"] }, providerOrderId: null }, data: { status: "CANCELLED", nextAttemptAt: null, lastError: "Cancelled before it was sent to the print shop" } });
    return claimed.count === 1 ? { ok: true, status: "CANCELLED" } : { ok: false, status: fulfillment.status, message: "Its state changed meanwhile; refresh and try again" };
  }
  try {
    const adapter = podAdapter(fulfillment.provider);
    const mode = fulfillment.mode === "live" ? "live" : "draft";
    // An order the shop already failed and stopped (e.g. Gelato after a refused file) is only closed here.
    const current = fulfillment.status === "FAILED" ? await adapter.fetchStatus(fulfillment.providerOrderId, mode) : null;
    const state = current && previousOrderDead(fulfillment.provider, current) ? { ...current, status: "CANCELLED" as const } : await adapter.cancel(fulfillment.providerOrderId, mode);
    const saved = await saveState(fulfillmentId, { ...state, problem: null }, { nextAttemptAt: null }, { cancelledHere: true });
    return { ok: saved.status === "CANCELLED", status: saved.status, ...(saved.status === "CANCELLED" ? {} : { message: "The print shop did not cancel it" }) };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Unknown error";
    logPod("cancel failed", { fulfillmentId, provider: fulfillment.provider, message });
    return { ok: false, status: fulfillment.status, message };
  }
}

// Reads the latest status and tracking from the shop.
export async function syncFulfillment(fulfillmentId: string): Promise<SubmitResult> {
  const fulfillment = await prisma.podFulfillment.findUnique({ where: { id: fulfillmentId } });
  if (!fulfillment?.providerOrderId) return { ok: false, status: fulfillment?.status ?? "FAILED", message: "Not sent to the print shop yet" };
  try {
    const state = await podAdapter(fulfillment.provider).fetchStatus(fulfillment.providerOrderId, fulfillment.mode === "live" ? "live" : "draft");
    if (!state) {
      await prisma.podFulfillment.update({ where: { id: fulfillmentId }, data: { lastSyncedAt: new Date() } });
      return { ok: false, status: fulfillment.status, message: `${fulfillment.provider} has no status endpoint` };
    }
    const saved = await saveState(fulfillmentId, state);
    return { ok: true, status: saved.status };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Unknown error";
    logPod("status sync failed", { fulfillmentId, provider: fulfillment.provider, message });
    return { ok: false, status: fulfillment.status, message };
  }
}

// Problems that mean the print file itself is missing or wrong.
const ARTWORK_BLOCKERS = ["missing_photos", "print_file_required", "print_file_invalid"];
const NOT_SENT = ["NEEDS_ATTENTION", "READY", "FAILED"];

// An order item whose print files can still change (its print order was not sent).
async function editableItem(itemId: string) {
  const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
  if (!item.podFulfillmentId) throw new Error("This item has no print order");
  const fulfillment = await prisma.podFulfillment.findUniqueOrThrow({ where: { id: item.podFulfillmentId } });
  if (!NOT_SENT.includes(fulfillment.status)) throw new Error("The print order was already sent; files can no longer change");
  return { item, fulfillmentId: item.podFulfillmentId };
}

async function saveSlots(itemId: string, fulfillmentId: string, slots: ArtworkSlot[]) {
  await prisma.orderItem.update({ where: { id: itemId }, data: { podArtwork: slots as unknown as Prisma.InputJsonValue } });
  // Planning again checks the file's size against the shop's requirement.
  return refreshReadiness(fulfillmentId, { replan: true });
}

// Attaches (or replaces) a print file on one slot of an order item.
export async function attachPrintFile(itemId: string, input: { unit: number; area: string; url: string }) {
  const { item, fulfillmentId } = await editableItem(itemId);
  const slots = readArtwork(item.podArtwork);
  const index = slots.findIndex((slot) => slot.unit === input.unit && slot.area === input.area);
  // Card print files are made from the customer's design automatically; they cannot be replaced by hand.
  if (index >= 0 && slots[index].kind === "pages") throw new Error("This print file is made automatically from the customer's design and cannot be replaced");
  const slot: ArtworkSlot = { ...(index >= 0 ? slots[index] : { unit: input.unit, productRef: item.podProductRef, area: input.area }), url: input.url, source: "admin" };
  const next = index >= 0 ? slots.map((current, position) => (position === index ? slot : current)) : [...slots, slot];
  return saveSlots(itemId, fulfillmentId, next);
}

// Removes an admin's file so the print file is rendered again from the customer's design.
export async function resetPrintFile(itemId: string, input: { unit: number; area: string }) {
  const { item, fulfillmentId } = await editableItem(itemId);
  const next = readArtwork(item.podArtwork).map((slot) => (slot.unit === input.unit && slot.area === input.area && slot.source === "admin" ? { ...slot, url: null, source: null, verified: null } : slot));
  return saveSlots(itemId, fulfillmentId, next);
}

// Saves card pages an admin rendered from the order's saved design (for orders whose
// pages were not saved at checkout). Only files uploaded to this site at the card's page size.
export async function attachDesignPages(itemId: string, pages: { side: CardDesignSide; url: string }[]) {
  const { item, fulfillmentId } = await editableItem(itemId);
  const card = asObject(asObject(item.personalization).card);
  const size = (CARD_SIZES.find((entry) => entry.id === asString(card.size)) || CARD_SIZES[0]).panel;
  const files = await uploadedFiles(pages.map((page) => page.url));
  const references = pages.map((page) => {
    const file = files.get(page.url);
    if (!file || file.width !== size.width || file.height !== size.height) throw new Error(`The ${PAGE_LABEL[page.side]} page must be an upload of ${size.width} × ${size.height} px`);
    return { label: PAGE_LABEL[page.side], side: page.side, url: page.url, width: file.width, height: file.height };
  });
  if (references.length !== 4) throw new Error("All 4 card pages are needed");
  return saveSlots(itemId, fulfillmentId, readArtwork(item.podArtwork).map((slot) => ({ ...slot, references })));
}

// ── Order status ─────────────────────────────────────────────────────────────

// Moves the order forward from the state of its print orders in the shop's current environment (real ones
// when live, test ones while testing; never the other kind). The customer sees the same progress.
export async function syncOrderStatus(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { fulfillments: true } });
  if (!order || !["PAID", "PROCESSING", "SHIPPED"].includes(order.status)) return;
  const mode = podMode();
  const next = STORED_STATUS[printStage(order.fulfillments.filter((item) => item.mode === mode))];
  const rank = { PAID: 0, PROCESSING: 1, SHIPPED: 2, DELIVERED: 3 } as const;
  if (next && rank[next] > rank[order.status as keyof typeof rank]) await prisma.order.update({ where: { id: orderId }, data: { status: next } });
}

// ── Triggers ─────────────────────────────────────────────────────────────────

// Called right after a payment is verified on the server (Stripe webhook / return,
// PayPal capture). Never throws: payment handling must not fail because of a print shop.
export async function handlePaidOrder(orderId: string) {
  try {
    const fulfillments = await prepareFulfillments(orderId);
    if (!podAutoSubmit()) return;
    // Different print shops are independent: send them in parallel.
    await Promise.all(fulfillments.filter((item) => item.status === "READY").map((item) => submitFulfillment(item.id)));
  } catch (reason) {
    logPod("handling a paid order failed", { orderId, message: reason instanceof Error ? reason.message : String(reason) });
  }
}

// For the payment routes: answers the payment provider straight away and lets the
// print shop work finish after the response (Vercel keeps the function alive with
// waitUntil; elsewhere the Node process simply continues). Anything not finished is
// picked up by the cron job.
export function handlePaidOrderInBackground(orderId: string) {
  const work = handlePaidOrder(orderId);
  waitUntil(work);
}

// Refreshes print orders whose status has not been read from the print shop for a while, so admin
// pages always show the latest status without anyone pressing a button (webhooks and the cron job
// do the same in the background). Bounded in number and time; a failed read changes nothing
// (syncFulfillment keeps the stored status and only records the error in the log).
// Print orders whose tracking is still worth reading: not delivered yet, and shipped less than
// TRACKING_WINDOW_DAYS ago (Prodigi and Printeers never report a delivery, so their shipped orders would
// otherwise be read for ever).
const TRACKING_WINDOW_DAYS = 45;
const trackable = (): Prisma.PodFulfillmentWhereInput => ({
  provider: { in: [...POD_PROVIDERS] },
  providerOrderId: { not: null },
  OR: [{ status: { in: ["SUBMITTED", "IN_PRODUCTION"] } }, { status: "SHIPPED", OR: [{ shippedAt: null }, { shippedAt: { gte: new Date(Date.now() - TRACKING_WINDOW_DAYS * 86_400_000) } }] }],
});

export async function syncStaleFulfillments({ maxAgeMs = 5 * 60_000, limit = 12, budgetMs = 6_000, orderIds }: { maxAgeMs?: number; limit?: number; budgetMs?: number; orderIds?: string[] } = {}) {
  const stale = await prisma.podFulfillment.findMany({
    where: { ...(orderIds ? { orderId: { in: orderIds } } : {}), AND: [trackable(), { OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(Date.now() - maxAgeMs) } }] }] },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: limit,
    select: { id: true },
  });
  if (!stale.length) return 0;
  const work = Promise.all(stale.map((item) => syncFulfillment(item.id).catch(() => null)));
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, budgetMs))]);
  return stale.length;
}

// Periodic job (cron): prepares paid orders the payment hook missed, retries failed
// submissions, recovers interrupted ones and refreshes tracking.
export async function runPodMaintenance({ budgetMs = 45_000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const report = { prepared: 0, rerendered: 0, submitted: 0, retried: 0, recovered: 0, synced: 0 };
  const left = () => Date.now() < deadline;

  const unprepared = await prisma.order.findMany({ where: { status: { in: [...PAID_ORDER] }, createdAt: { gte: POD_ENABLED_SINCE }, fulfillments: { none: {} }, payments: { some: { status: "SUCCEEDED" } } }, select: { id: true }, take: 20, orderBy: { createdAt: "asc" } });
  for (const order of unprepared) { if (!left()) break; await prepareFulfillments(order.id); report.prepared += 1; }

  const stale = await prisma.podFulfillment.findMany({ where: { status: "SUBMITTING", updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, take: 20 });
  for (const fulfillment of stale) {
    if (!left()) break;
    const found = await podAdapter(fulfillment.provider).findByReference(fulfillment.reference, fulfillment.mode === "live" ? "live" : "draft").catch(() => null);
    if (found) await saveState(fulfillment.id, found, { submittedAt: new Date() });
    else await prisma.podFulfillment.update({ where: { id: fulfillment.id }, data: { status: "FAILED", lastError: "The last submission was interrupted; it will be retried", nextAttemptAt: new Date() } });
    report.recovered += 1;
  }

  // Print files that could not be made (e.g. image storage briefly unavailable) are tried again, and
  // Prodigi card orders still waiting for a hand-made file (planned before card files were made
  // automatically) are planned again so their file is composed and they are sent.
  const unrendered = await prisma.podFulfillment.findMany({ where: { status: "NEEDS_ATTENTION", updatedAt: { lt: new Date(Date.now() - 5 * 60_000) }, OR: [
    { items: { some: { podIssues: { array_contains: [{ code: "print_file_render_failed" }] } } } },
    // A calendar PDF the print shop could not download (e.g. Cloudinary blocking PDF delivery until the
    // setting is turned on) is checked again, so it goes out once the link works.
    { items: { some: { podIssues: { array_contains: [{ code: "print_file_unreachable" }] } } } },
    // Orders held for a small photo under the old rules: a small photo no longer holds an order.
    { items: { some: { podIssues: { array_contains: [{ code: "low_resolution", severity: "warning" }] } } } },
    // Calendar orders placed before calendar PDFs were made automatically: planned again so the PDF is made.
    { provider: "GELATO", items: { some: { podIssues: { array_contains: [{ code: "print_file_required" }] } } } },
    { provider: "PRODIGI", items: { some: { podIssues: { array_contains: [{ code: "print_file_required" }] } } } },
  ] }, select: { id: true }, take: 10 });
  for (const fulfillment of unrendered) { if (!left()) break; await refreshReadiness(fulfillment.id, { replan: true }); report.rerendered += 1; }

  const due: PodFulfillment[] = await prisma.podFulfillment.findMany({ where: { OR: [{ status: "FAILED", nextAttemptAt: { lte: new Date() } }, ...(podAutoSubmit() ? [{ status: "READY" as const }] : [])] }, take: 20, orderBy: { updatedAt: "asc" } });
  for (const fulfillment of due) {
    if (!left()) break;
    const result = await submitFulfillment(fulfillment.id);
    if (fulfillment.status === "FAILED") report.retried += 1; else if (result.ok) report.submitted += 1;
  }

  const active = await prisma.podFulfillment.findMany({ where: { AND: [trackable(), { OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(Date.now() - 3 * 3_600_000) } }] }] }, take: 40, orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } } });
  for (const fulfillment of active) { if (!left()) break; if ((await syncFulfillment(fulfillment.id)).ok) report.synced += 1; }
  return report;
}

export type { PodMode };
