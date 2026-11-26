// The print file of a wall calendar (Gelato): ONE PDF of 14 pages in reading order — cover, January …
// December, back — with the trim layout kept inside a 4 mm bleed on every side. The caller fetches the
// photos (already cut to the photo boxes' shape) and stores the result. Server only (reads the font files).
//
// The month pages repeat what the customer saw in the studio (components/product-studio.tsx,
// CalendarStudio): the month's photo on top, the month name and year under it, then a Monday-first grid.
// Nothing important sits near the edges (white margins, a deeper one at the top for the wire binding), so
// the page prints correctly whether the shop trims or scales for bleed. A month without a photo gets a soft
// panel with its name instead of an empty hole.
//
// Print-shop preflight (Gelato runs callas pdfToolbox; its file rules: 4 mm bleed, fonts embedded or
// outlined, 150–300 dpi). Gelato refused the first version (no bleed) and then failed to preflight the
// second one ("PDFToolBox failed: preflight report was not generated", page 1, Nov 2026). So the file is
// kept to the plainest form a preflight tool can read:
// - every font embedded (Liberation, metric-compatible with Times / Helvetica, so the layout is unchanged;
//   the PDF standard fonts used before are never embedded);
// - TrimBox (the calendar size) and BleedBox (+4 mm) on every page, so the trim line is explicit;
// - photos as plain baseline RGB JPEGs without embedded ICC / EXIF segments (the caller converts them to
//   sRGB first; the cover photo of the refused file carried a non-conformant ICC v4.3 profile);
// - a classic cross-reference table (no object or xref streams);
// - PDF/X-4 with the GRACoL 2006 output intent, as Gelato's PDF requirements ask, the photos and design
//   colours colour-managed as sRGB (lib/pod/pdf-preflight.ts applyPdfX4);
// - every requirement checked on the saved file before it is used (validateCalendarPdf → preflightPdf).
import { readFileSync } from "fs";
import path from "path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { calendarLayout, type Box } from "./calendar-layout";
import { applyPdfX4, preflightPdf, withPdfVersion16, type PreflightCheck } from "./pdf-preflight";

// The layout is shared with the product studio (image size recommendations), which cannot load pdf-lib.
export { boxPixels, calendarLayout, type Box } from "./calendar-layout";

export type CalendarLanguage = "es" | "pt";

export const CALENDAR_PAGES = 14;
export const CALENDAR_BLEED_MM = 4;
export const CALENDAR_MAX_BYTES = 10_485_760;
// Bumped whenever the generated file changes in a way the print shop must receive: calendar PDFs made by
// an older version are made again instead of being reused (see the signature in lib/pod/fulfillment.ts).
export const CALENDAR_PDF_VERSION = 3;
// Gelato's safe area: content at least 4 mm inside the trim, 12 mm on the binding side (the wire at the top).
export const CALENDAR_SAFE_MM = 4;
export const CALENDAR_BINDING_SAFE_MM = 12;
// Gelato: images 150–300 dpi at actual print size.
export const CALENDAR_MIN_DPI = 150;
export const CALENDAR_MAX_DPI = 300;

// Liberation fonts (SIL Open Font License, lib/pod/fonts/LICENSE-Liberation-OFL.txt), shipped unmodified.
// Listed in next.config.mjs (outputFileTracingIncludes) so they are deployed with the server functions.
export const CALENDAR_FONT_FILES = { serif: "LiberationSerif-Bold.ttf", sans: "LiberationSans-Regular.ttf", sansBold: "LiberationSans-Bold.ttf" } as const;
type FontFiles = Record<keyof typeof CALENDAR_FONT_FILES, Uint8Array>;
let fontFiles: FontFiles | null = null;
function calendarFontFiles(): FontFiles {
  if (fontFiles) return fontFiles;
  const dir = path.join(process.cwd(), "lib", "pod", "fonts");
  const read = (name: string) => new Uint8Array(readFileSync(path.join(dir, name)));
  fontFiles = { serif: read(CALENDAR_FONT_FILES.serif), sans: read(CALENDAR_FONT_FILES.sans), sansBold: read(CALENDAR_FONT_FILES.sansBold) };
  return fontFiles;
}

// JPEG segments a print RIP never needs: APP1 (EXIF / XMP), APP2 (ICC profile), APP3–APP13, APP15 and
// comments. APP0 (JFIF) and APP14 (Adobe: tells the decoder how the colours are encoded) are kept, as is
// everything from the quantisation / frame / Huffman tables onwards, so the image data is untouched.
const DROPPED_SEGMENT = (marker: number) => (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;

export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("A calendar photo is not a JPEG");
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("A calendar photo is not a valid JPEG");
    const marker = bytes[offset + 1];
    // Start of scan: the rest is image data.
    if (marker === 0xda) { parts.push(bytes.subarray(offset)); break; }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) throw new Error("A calendar photo is a truncated JPEG");
    if (!DROPPED_SEGMENT(marker)) parts.push(bytes.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  if (parts.length < 2 || parts[parts.length - 1][1] !== 0xda) throw new Error("A calendar photo has no image data");
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export function calendarPdfPage(page: { width: number; height: number }) {
  return { width: page.width + CALENDAR_BLEED_MM * 2, height: page.height + CALENDAR_BLEED_MM * 2 };
}

const MONTHS: Record<CalendarLanguage, string[]> = {
  es: ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"],
  pt: ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"],
};
// Monday first.
const WEEKDAYS: Record<CalendarLanguage, string[]> = { es: ["L", "M", "X", "J", "V", "S", "D"], pt: ["S", "T", "Q", "Q", "S", "S", "D"] };
const TITLE: Record<CalendarLanguage, string> = { es: "Calendario", pt: "Calendário" };

export const monthName = (language: CalendarLanguage, month: number) => MONTHS[language][month];

// Where the 1st falls in a Monday-first week (0 = Monday) and how many days the month has.
export function monthGrid(year: number, month: number) {
  return { offset: (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7, days: new Date(Date.UTC(year, month + 1, 0)).getUTCDate() };
}

const PT = 72 / 25.4;
const NAVY = rgb(24 / 255, 36 / 255, 67 / 255);
const CORAL = rgb(238 / 255, 82 / 255, 100 / 255);
const LINE = rgb(234 / 255, 223 / 255, 216 / 255);
const PANEL = rgb(246 / 255, 239 / 255, 233 / 255);
const MUTED = rgb(146 / 255, 151 / 255, 164 / 255);

type Fonts = { serif: PDFFont; sans: PDFFont; sansBold: PDFFont };

export type CalendarInput = {
  page: { width: number; height: number }; // trim/content size in mm
  year: number;
  language: CalendarLanguage;
  // 12 JPEGs (January first) cut to layout.month's shape, or null for a month without a photo.
  monthPhotos: (Uint8Array | null)[];
  // A JPEG cut to layout.cover's shape, or null.
  coverPhoto: Uint8Array | null;
};

export async function buildCalendarPdf(input: CalendarInput): Promise<Uint8Array> {
  if (input.monthPhotos.length !== 12) throw new Error("A calendar needs 12 month slots");
  if (!(input.page.width > 0) || !(input.page.height > 0)) throw new Error("A calendar page needs positive dimensions");
  const layout = calendarLayout(input.page);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${TITLE[input.language]} ${input.year}`);
  pdf.setCreator("Celebra Momentos");
  const files = calendarFontFiles();
  // Subsets: only the glyphs used are embedded (a few kB per font).
  const fonts: Fonts = { serif: await pdf.embedFont(files.serif, { subset: true }), sans: await pdf.embedFont(files.sans, { subset: true }), sansBold: await pdf.embedFont(files.sansBold, { subset: true }) };
  const outputPage = calendarPdfPage(input.page);
  const size: [number, number] = [outputPage.width * PT, outputPage.height * PT];
  const embeddedImages = new Map<string, PDFImage>();

  const imageKey = (bytes: Uint8Array) => {
    // Two small independent hashes avoid embedding the same optimized upload repeatedly while keeping
    // this shared module browser-safe (the product studio imports its layout helpers).
    let first = 2_166_136_261;
    let second = 2_654_435_761;
    for (const byte of bytes) {
      first = Math.imul(first ^ byte, 16_777_619);
      second = Math.imul(second ^ (byte + 31), 2_246_822_519);
    }
    return `${bytes.length}:${first >>> 0}:${second >>> 0}`;
  };

  const imageFor = async (bytes: Uint8Array) => {
    const key = imageKey(bytes);
    const existing = embeddedImages.get(key);
    if (existing) return existing;
    const image = await pdf.embedJpg(stripJpegMetadata(bytes));
    embeddedImages.set(key, image);
    return image;
  };

  // Trim (the calendar's size) and bleed (the whole page) boxes, in points.
  const bleed = CALENDAR_BLEED_MM * PT;
  const addPage = () => {
    const page = pdf.addPage(size);
    page.setBleedBox(0, 0, size[0], size[1]);
    page.setTrimBox(bleed, bleed, size[0] - bleed * 2, size[1] - bleed * 2);
    return page;
  };

  // y in mm from the top → PDF points from the bottom.
  const at = (page: PDFPage) => ({
    rect: (box: Box, color = PANEL) => page.drawRectangle({ x: (CALENDAR_BLEED_MM + box.x) * PT, y: (outputPage.height - CALENDAR_BLEED_MM - box.y - box.height) * PT, width: box.width * PT, height: box.height * PT, color }),
    line: (x1: number, y1: number, x2: number, y2: number, thickness = 0.5, color = LINE) => page.drawLine({ start: { x: (CALENDAR_BLEED_MM + x1) * PT, y: (outputPage.height - CALENDAR_BLEED_MM - y1) * PT }, end: { x: (CALENDAR_BLEED_MM + x2) * PT, y: (outputPage.height - CALENDAR_BLEED_MM - y2) * PT }, thickness, color }),
    // Text whose baseline is at `y` mm; align left / center / right of x.
    text: (value: string, x: number, y: number, font: PDFFont, sizeMm: number, color = NAVY, align: "left" | "center" | "right" = "left") => {
      const points = sizeMm * PT;
      const textWidth = font.widthOfTextAtSize(value, points) / PT;
      const left = align === "left" ? x : align === "center" ? x - textWidth / 2 : x - textWidth;
      page.drawText(value, { x: (CALENDAR_BLEED_MM + left) * PT, y: (outputPage.height - CALENDAR_BLEED_MM - y) * PT, size: points, font, color });
    },
  });

  const photo = async (page: PDFPage, box: Box, bytes: Uint8Array | null, label: string) => {
    const draw = at(page);
    if (bytes) {
      const image = await imageFor(bytes);
      page.drawImage(image, { x: (CALENDAR_BLEED_MM + box.x) * PT, y: (outputPage.height - CALENDAR_BLEED_MM - box.y - box.height) * PT, width: box.width * PT, height: box.height * PT });
      return;
    }
    draw.rect(box);
    draw.text(label, box.x + box.width / 2, box.y + box.height / 2 + box.height * 0.05, fonts.serif, Math.min(box.height * 0.16, box.width * 0.09), MUTED, "center");
  };

  // ── Cover ──
  const cover = addPage();
  // The caller cuts the customer's first photo to the cover's shape; without any photo the panel shows the year.
  await photo(cover, layout.cover, input.coverPhoto, String(input.year));
  const coverText = at(cover);
  const below = layout.cover.y + layout.cover.height;
  const room = input.page.height - layout.margin - below;
  coverText.text(String(input.year), input.page.width / 2, below + room * 0.62, fonts.serif, Math.min(room * 0.5, input.page.width * 0.14), NAVY, "center");
  coverText.text(TITLE[input.language].toUpperCase(), input.page.width / 2, below + room * 0.86, fonts.sansBold, Math.min(room * 0.1, input.page.width * 0.025), CORAL, "center");

  // ── Months ──
  for (let month = 0; month < 12; month += 1) {
    const page = addPage();
    const draw = at(page);
    const name = MONTHS[input.language][month];
    await photo(page, layout.month, input.monthPhotos[month], name);
    const left = layout.margin;
    const right = input.page.width - layout.margin;
    const width = right - left;
    // Title row: month name (serif, like the studio) and the year.
    const titleSize = Math.min(width * 0.075, (input.page.height - layout.month.y - layout.month.height) * 0.09);
    const titleBase = layout.month.y + layout.month.height + titleSize * 1.55;
    draw.text(name.toUpperCase(), left, titleBase, fonts.serif, titleSize);
    draw.text(String(input.year), right, titleBase, fonts.sansBold, titleSize * 0.42, NAVY, "right");
    const ruleY = titleBase + titleSize * 0.45;
    draw.line(left, ruleY, right, ruleY, 0.9, NAVY);
    // Weekday header and a 6-row grid filling the rest of the page.
    const headerSize = titleSize * 0.36;
    const headerBase = ruleY + headerSize * 2.2;
    const column = width / 7;
    WEEKDAYS[input.language].forEach((day, index) => draw.text(day, left + column * index + column / 2, headerBase, fonts.sansBold, headerSize, index === 6 ? CORAL : MUTED, "center"));
    const gridTop = headerBase + headerSize * 1.2;
    const gridBottom = input.page.height - layout.margin;
    const row = (gridBottom - gridTop) / 6;
    for (let line = 0; line <= 6; line += 1) draw.line(left, gridTop + row * line, right, gridTop + row * line);
    for (let line = 0; line <= 7; line += 1) draw.line(left + column * line, gridTop, left + column * line, gridBottom);
    const { offset, days } = monthGrid(input.year, month);
    const numberSize = Math.min(row * 0.32, column * 0.3);
    for (let day = 1; day <= days; day += 1) {
      const cell = offset + day - 1;
      const x = left + column * (cell % 7) + column * 0.1;
      const y = gridTop + row * Math.floor(cell / 7) + numberSize * 1.25;
      draw.text(String(day), x, y, fonts.sans, numberSize, cell % 7 === 6 ? CORAL : NAVY);
    }
  }

  // ── Back ──
  const back = addPage();
  // Never below 7 pt (Gelato's minimum text size); only the narrow formats (< 154 mm wide) reach that floor.
  at(back).text("celebra-momentos.com", input.page.width / 2, input.page.height - layout.margin - 4, fonts.sans, Math.min(3.2, Math.max(input.page.width * 0.016, 7 / PT)), MUTED, "center");

  // The pages are left unpainted outside the design (the paper is white).
  await pdf.flush();
  applyPdfX4(pdf, { title: `${TITLE[input.language]} ${input.year}`, creator: "Celebra Momentos", images: Array.from(embeddedImages.values(), (image) => image.ref) });
  return withPdfVersion16(await pdf.save({ useObjectStreams: false }));
}

// Every requirement the print shop's preflight looks at, checked on the saved file (PASS / WARN / FAIL).
export async function calendarPreflight(bytes: Uint8Array, trimPage: { width: number; height: number }, maxBytes = CALENDAR_MAX_BYTES) {
  return preflightPdf(bytes, { pages: CALENDAR_PAGES, trimMm: trimPage, bleedMm: CALENDAR_BLEED_MM, safeMm: CALENDAR_SAFE_MM, bindingSafeMm: CALENDAR_BINDING_SAFE_MM, bindingEdge: "top", minDpi: CALENDAR_MIN_DPI, maxDpi: CALENDAR_MAX_DPI, minFontPt: 7, maxBytes });
}

// The last check before the file is stored and sent. Throws with the first failed requirement; a size
// problem says "allows at most" (the caller then retries with smaller photos).
export async function validateCalendarPdf(bytes: Uint8Array, trimPage: { width: number; height: number }, maxBytes = CALENDAR_MAX_BYTES) {
  const { checks } = await calendarPreflight(bytes, trimPage, maxBytes);
  const failed = checks.find((check) => check.status === "FAIL");
  if (failed) throw new Error(failed.detail);
  // Leading numbers of the font and image lines: embedded fonts, placed images.
  const count = (id: string) => Number(checks.find((check) => check.id === id)?.detail.match(/^(\d+)/)?.[1] ?? 0);
  return { pages: CALENDAR_PAGES, bytes: bytes.byteLength, pageMm: calendarPdfPage(trimPage), bleedMm: CALENDAR_BLEED_MM, fonts: count("fonts-embedded"), images: count("image-resolution"), checks: checks as PreflightCheck[] };
}
