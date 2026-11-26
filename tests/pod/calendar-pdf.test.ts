import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { boxPixels, buildCalendarPdf, calendarLayout, calendarPdfPage, calendarPreflight, CALENDAR_BLEED_MM, CALENDAR_FONT_FILES, CALENDAR_PAGES, CALENDAR_PDF_VERSION, monthGrid, monthName, stripJpegMetadata, validateCalendarPdf } from "@/lib/pod/calendar-pdf";
import { formatPreflightReport, iccProfiles, readIccProfile, withPdfVersion16, type PreflightCheck } from "@/lib/pod/pdf-preflight";

// print-files.ts (calendarPrintPixels) imports the database client and image storage; neither is used here.
vi.mock("@/lib/server/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/server/cloudinary", () => ({ cloudinaryObjectKey: vi.fn(), uploadFileToCloudinary: vi.fn(), uploadRemoteImageToCloudinary: vi.fn() }));
import { calendarPhotoUrl, calendarPrintPixels } from "@/lib/pod/print-files";

const A4 = { width: 210, height: 297 };
const jpeg = new Uint8Array(readFileSync("public/images/magnet-photo-8.jpg"));
// Photos cut to the A5 calendar's boxes at 200 dpi (Gelato: 150–300 dpi at actual size).
const A5 = { width: 148, height: 210 };
const month = new Uint8Array(readFileSync("tests/fixtures/calendar-a5-month-200dpi.jpg"));
const cover = new Uint8Array(readFileSync("tests/fixtures/calendar-a5-cover-200dpi.jpg"));

describe("calendar layout", () => {
  it("Monday-first grids, as in the studio", () => {
    expect(monthGrid(2027, 0)).toEqual({ offset: 4, days: 31 }); // 1 Jan 2027 is a Friday
    expect(monthGrid(2027, 1)).toEqual({ offset: 0, days: 28 }); // 1 Feb 2027 is a Monday
    expect(monthGrid(2028, 1).days).toBe(29); // leap year
    expect(monthName("pt", 2)).toBe("Março");
  });

  it("keeps the photos inside the margins, with room for the wire at the top, in the studio's 1.65:1 shape", () => {
    for (const page of [A4, { width: 297, height: 420 }, { width: 148, height: 400 }]) {
      const layout = calendarLayout(page);
      for (const box of [layout.month, layout.cover]) {
        expect(box.x).toBeGreaterThan(5);
        expect(box.x + box.width).toBeLessThanOrEqual(page.width - layout.margin + 0.01);
        expect(box.y).toBeGreaterThan(layout.margin);
        expect(box.y + box.height).toBeLessThan(page.height - layout.margin);
      }
      expect(layout.month.width / layout.month.height).toBeCloseTo(1.65, 1);
    }
    // A4 month photo at 300 dpi.
    expect(boxPixels(calendarLayout(A4).month)).toEqual({ width: 2183, height: 1323 });
  });
});

describe("calendar PDF", () => {
  it("has 14 pages with 4 mm bleed around the exact trim size", async () => {
    const bytes = await buildCalendarPdf({ page: A5, year: 2027, language: "es", monthPhotos: [month, month, month, ...Array(9).fill(null)], coverPhoto: cover });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(CALENDAR_PAGES);
    const output = calendarPdfPage(A5);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo((output.width * 72) / 25.4, 3);
      expect(page.getHeight()).toBeCloseTo((output.height * 72) / 25.4, 3);
    }
    await expect(validateCalendarPdf(bytes, A5)).resolves.toMatchObject({ pages: CALENDAR_PAGES, pageMm: output, bleedMm: CALENDAR_BLEED_MM, bytes: bytes.byteLength });
    expect(pdf.getTitle()).toBe("Calendario 2027");
  });

  it("uses Gelato's A3 dimensions: 305 × 428 mm including 4 mm bleed", async () => {
    const trim = { width: 297, height: 420 };
    const bytes = await buildCalendarPdf({ page: trim, year: 2027, language: "es", monthPhotos: Array(12).fill(null), coverPhoto: null });
    const pdf = await PDFDocument.load(bytes);
    expect(calendarPdfPage(trim)).toEqual({ width: 305, height: 428 });
    expect(pdf.getPages()).toHaveLength(14);
    expect(pdf.getPages()[0].getWidth()).toBeCloseTo((305 * 72) / 25.4, 3);
    expect(pdf.getPages()[0].getHeight()).toBeCloseTo((428 * 72) / 25.4, 3);
    await expect(validateCalendarPdf(bytes, trim)).resolves.toMatchObject({ pageMm: { width: 305, height: 428 }, bleedMm: 4 });
  });

  it("works with Portuguese months (accents) and no photo at all, and refuses a wrong month count", async () => {
    const pdf = await PDFDocument.load(await buildCalendarPdf({ page: { width: 148, height: 400 }, year: 2027, language: "pt", monthPhotos: Array(12).fill(null), coverPhoto: null }));
    expect(pdf.getPageCount()).toBe(14);
    expect(pdf.getTitle()).toBe("Calendário 2027");
    await expect(buildCalendarPdf({ page: A4, year: 2027, language: "es", monthPhotos: [jpeg], coverPhoto: null })).rejects.toThrow(/12 month/);
  });
});

// ── Gelato preflight (Nov 2026: "PDFToolBox failed: preflight report was not generated", page 1) ──

// JPEG header markers up to the image data.
function markers(bytes: Uint8Array) {
  const found: number[] = [];
  let offset = 2;
  while (bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    found.push(marker);
    if (marker === 0xda) break;
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  return found;
}
// The sample photo with an ICC profile segment (APP2) added after SOI, like phone photos from Cloudinary.
function withIcc(bytes: Uint8Array) {
  const payload = new Uint8Array([...new TextEncoder().encode("ICC_PROFILE\0"), 1, 1, ...new Uint8Array(40)]);
  const segment = new Uint8Array([0xff, 0xe2, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]);
  return new Uint8Array([...bytes.subarray(0, 2), ...segment, ...bytes.subarray(2)]);
}
const scanData = (bytes: Uint8Array) => { let offset = 2; while (bytes[offset + 1] !== 0xda) offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]); return bytes.subarray(offset); };
const A3 = { width: 297, height: 420 };
const PT = 72 / 25.4;

// A calendar made the way the refused files were: standard (non-embedded) fonts, no trim box, object streams,
// PDF 1.7, no output intent.
async function legacyPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const output = calendarPdfPage(A3);
  for (let index = 0; index < 14; index += 1) pdf.addPage([output.width * PT, output.height * PT]).drawText("2027", { x: 100, y: 100, size: 20, font });
  return pdf.save({ useObjectStreams: true });
}

const status = (checks: PreflightCheck[], id: string) => checks.find((check) => check.id === id)?.status;
const failed = (checks: PreflightCheck[]) => checks.filter((check) => check.status === "FAIL").map((check) => check.id);
// A good calendar changed one way, saved like the generator saves.
async function changed(edit: (pdf: PDFDocument) => void | Promise<void>) {
  const pdf = await PDFDocument.load(await buildCalendarPdf({ page: A5, year: 2027, language: "es", monthPhotos: Array(12).fill(month), coverPhoto: cover }), { updateMetadata: false });
  await edit(pdf);
  return calendarPreflight(withPdfVersion16(await pdf.save({ useObjectStreams: false })), A5);
}

describe("calendar PDF: Gelato's PDF requirements (PDF/X-4, GRACoL 2006)", () => {
  it("passes every requirement: the report for a full A5 calendar", async () => {
    const bytes = await buildCalendarPdf({ page: A5, year: 2027, language: "pt", monthPhotos: Array(12).fill(withIcc(month)), coverPhoto: withIcc(cover) });
    const { checks } = await calendarPreflight(bytes, A5);
    expect(checks.filter((check) => check.status !== "PASS"), formatPreflightReport(checks)).toEqual([]);
    expect(checks.map((check) => check.id)).toEqual(["pdf", "no-password", "pdfx-version-header", "pdfx-identification", "pdfx-metadata", "output-intent", "structure", "no-interactive", "no-layers", "page-count", "page-size", "bleed-box", "trim-box", "safe-area", "image-resolution", "fonts-embedded", "font-names", "font-size", "colour", "no-transparency", "file-size"]);
    await expect(validateCalendarPdf(bytes, A5)).resolves.toMatchObject({ pages: 14, fonts: 3, images: 13 });
  });

  it("is a PDF 1.6 file identified as PDF/X-4 with the embedded GRACoL 2006 output intent", async () => {
    const bytes = await buildCalendarPdf({ page: A3, year: 2027, language: "es", monthPhotos: Array(12).fill(null), coverPhoto: null });
    expect(Buffer.from(bytes.subarray(0, 8)).toString("latin1")).toBe("%PDF-1.6");
    const pdf = await PDFDocument.load(bytes);
    const [intent] = pdf.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).asArray().map((item) => pdf.context.lookup(item) as PDFDict);
    expect(String(intent.get(PDFName.of("S")))).toBe("/GTS_PDFX");
    expect(intent.lookup(PDFName.of("OutputConditionIdentifier"))!.toString()).toBe("(CGATS TR006)");
    const profile = intent.lookup(PDFName.of("DestOutputProfile")) as PDFRawStream;
    expect((profile.dict.get(PDFName.of("N")) as PDFNumber).asNumber()).toBe(4);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toMatch(/<pdfxid:GTS_PDFXVersion>PDF\/X-4<\/pdfxid:GTS_PDFXVersion>/);
    expect(text).toMatch(/\/Trapped \/False/);
    expect(text).toMatch(/\/ID \[/);
    expect(text).not.toMatch(/\/BaseFont\s*\/(Helvetica|Times)/);
  });

  it("places the trim inside exactly 4 mm of bleed on all four sides, and the content inside the safe area", async () => {
    const bytes = await buildCalendarPdf({ page: A3, year: 2027, language: "es", monthPhotos: Array(12).fill(null), coverPhoto: null });
    const pdf = await PDFDocument.load(bytes);
    for (const page of pdf.getPages()) {
      const trim = page.getTrimBox();
      const bleed = page.getBleedBox();
      expect(trim.x - bleed.x).toBeCloseTo(4 * PT, 3);
      expect(trim.y - bleed.y).toBeCloseTo(4 * PT, 3);
      expect(bleed.x + bleed.width - (trim.x + trim.width)).toBeCloseTo(4 * PT, 3);
      expect(bleed.y + bleed.height - (trim.y + trim.height)).toBeCloseTo(4 * PT, 3);
      expect(trim.width).toBeCloseTo(297 * PT, 3);
      expect(trim.height).toBeCloseTo(420 * PT, 3);
    }
    const { checks } = await calendarPreflight(bytes, A3);
    expect(checks.find((check) => check.id === "safe-area")).toMatchObject({ status: "PASS", detail: expect.stringContaining("top 28.8 mm") });
  });

  it("keeps photos within 150–300 dpi at print size for every Gelato calendar format and quality step", () => {
    const formats = [[210, 297], [203.2, 304.8], [297, 420], [279.41, 419.1], [420, 594], [419.1, 558.8], [148, 210], [139.7, 215.9], [148, 400]];
    for (const [width, height] of formats) {
      const layout = calendarLayout({ width, height });
      for (const box of [layout.month, layout.cover]) for (const dpi of [300, 240, 200, 150]) {
        const pixels = calendarPrintPixels(box, dpi);
        for (const [px, mm] of [[pixels.width, box.width], [pixels.height, box.height]]) {
          const effective = px / (mm / 25.4);
          expect(effective).toBeGreaterThanOrEqual(150);
          expect(effective).toBeLessThanOrEqual(300);
        }
      }
    }
    // Rounding to the nearest pixel would give 300.04 dpi on A4; the print file rounds down.
    expect(boxPixels(calendarLayout(A4).month).width / (calendarLayout(A4).month.width / 25.4)).toBeGreaterThan(300);
    expect(calendarPhotoUrl("https://res.cloudinary.com/x/image/upload/v1/a.jpg", calendarLayout(A4).month, { dpi: 300, quality: 75 })).toBe("https://res.cloudinary.com/x/image/upload/c_fill,g_center,w_2182,h_1322,q_75,f_jpg,cs_srgb/v1/a.jpg");
  });

  it("embeds the photos as sRGB (ICCBased) and colour-manages the design colours through DefaultRGB", async () => {
    const bytes = await buildCalendarPdf({ page: A5, year: 2027, language: "es", monthPhotos: Array(12).fill(withIcc(month)), coverPhoto: withIcc(cover) });
    const pdf = await PDFDocument.load(bytes);
    const page = pdf.getPages()[1];
    const resources = page.node.Resources()!;
    const defaultRgb = resources.lookup(PDFName.of("ColorSpace"), PDFDict).lookup(PDFName.of("DefaultRGB"), PDFArray);
    expect(String(defaultRgb.get(0))).toBe("/ICCBased");
    const images = resources.lookup(PDFName.of("XObject"), PDFDict);
    const stream = pdf.context.lookup(images.values()[0] as PDFRef) as PDFRawStream;
    expect(String((pdf.context.lookup(stream.dict.get(PDFName.of("ColorSpace"))) as PDFArray).get(0))).toBe("/ICCBased");
    expect(markers(stream.contents)).not.toContain(0xe2);
  });

  it("ships valid, unmodified ICC profiles and recognises broken ones", () => {
    const { cmyk, rgb: srgb } = iccProfiles();
    expect(readIccProfile(cmyk)).toMatchObject({ ok: true, header: { deviceClass: "prtr", colorSpace: "CMYK", description: "GRACoL2006_Coated1v2.icc", size: 2_747_956 } });
    expect(readIccProfile(srgb)).toMatchObject({ ok: true, header: { deviceClass: "mntr", colorSpace: "RGB", description: "sRGB2014" } });
    expect(readIccProfile(new Uint8Array(200))).toMatchObject({ ok: false });
    const truncated = cmyk.slice(0, 5000);
    expect(readIccProfile(truncated)).toMatchObject({ ok: false, reason: expect.stringContaining("declares") });
  });

  it("names the embedded subset fonts with an ABCDEF+ tag", async () => {
    const bytes = await buildCalendarPdf({ page: A5, year: 2027, language: "es", monthPhotos: Array(12).fill(null), coverPhoto: null });
    const { checks } = await calendarPreflight(bytes, A5);
    expect(checks.find((check) => check.id === "fonts-embedded")?.detail).toMatch(/[A-Z]{6}\+LiberationSerif-Bold, [A-Z]{6}\+LiberationSans-Bold, [A-Z]{6}\+LiberationSans$/);
  });

  it("keeps the layout: the embedded fonts have the same widths as the Times / Helvetica the design was made with", async () => {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const pairs = [[StandardFonts.TimesRomanBold, CALENDAR_FONT_FILES.serif], [StandardFonts.Helvetica, CALENDAR_FONT_FILES.sans], [StandardFonts.HelveticaBold, CALENDAR_FONT_FILES.sansBold]] as const;
    for (const [standard, file] of pairs) {
      const before = await pdf.embedFont(standard);
      const after = await pdf.embedFont(readFileSync(`lib/pod/fonts/${file}`));
      // pdf-lib draws text glyph by glyph (no kerning), so the drawn width is the sum of the glyph advances:
      // identical for every character the calendar prints (Spanish and Portuguese months, digits, the URL).
      const drawn = (font: typeof before, value: string) => Array.from(value).reduce((sum, char) => sum + font.widthOfTextAtSize(char, 100), 0);
      const samples = [...Array.from({ length: 12 }, (_, index) => monthName("es", index).toUpperCase()), ...Array.from({ length: 12 }, (_, index) => monthName("pt", index).toUpperCase()), "CALENDARIO", "CALENDÁRIO", "0123456789", "celebra-momentos.com", "LMXJVSDTQ"];
      for (const sample of samples) expect(drawn(after, sample)).toBeCloseTo(drawn(before, sample), 0);
    }
  });

  it("strips EXIF / ICC / Photoshop segments without touching the image data", () => {
    const source = withIcc(jpeg);
    expect(markers(source)).toEqual(expect.arrayContaining([0xe1, 0xe2, 0xed]));
    const stripped = stripJpegMetadata(source);
    expect(markers(stripped).filter((marker) => marker >= 0xe1 && marker <= 0xef)).toEqual([]);
    // Frame, tables and restart interval are kept; the compressed data is byte for byte the same.
    expect(markers(stripped)).toEqual(expect.arrayContaining([0xe0, 0xc0, 0xc4, 0xdb, 0xdd, 0xda]));
    expect(Buffer.from(scanData(stripped)).equals(Buffer.from(scanData(jpeg)))).toBe(true);
  });

  it("refuses photos that are not complete JPEGs", () => {
    expect(() => stripJpegMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/not a JPEG/);
    expect(() => stripJpegMetadata(jpeg.subarray(0, 40))).toThrow(/truncated|no image data/);
  });

  it("fails the refused files' style: PDF 1.7, no PDF/X-4, no output intent, non-embedded fonts, no trim box, object streams", async () => {
    const { checks } = await calendarPreflight(await legacyPdf(), A3);
    expect(failed(checks)).toEqual(expect.arrayContaining(["pdfx-version-header", "pdfx-identification", "pdfx-metadata", "output-intent", "structure", "trim-box", "fonts-embedded", "colour"]));
    await expect(validateCalendarPdf(await legacyPdf(), A3)).rejects.toThrow();
  });

  it("fails low-resolution photos (below 150 dpi at print size)", async () => {
    const bytes = await buildCalendarPdf({ page: A5, year: 2027, language: "es", monthPhotos: Array(12).fill(jpeg), coverPhoto: jpeg });
    const { checks } = await calendarPreflight(bytes, A5);
    expect(failed(checks)).toEqual(["image-resolution"]);
    await expect(validateCalendarPdf(bytes, A5)).rejects.toThrow(/dpi/);
  });

  it("fails a wrong bleed, a missing output intent, a broken ICC profile, layers, annotations and transparency", async () => {
    const bleed3 = await changed((pdf) => { for (const page of pdf.getPages()) page.setBleedBox(1 * PT, 1 * PT, page.getWidth() - 2 * PT, page.getHeight() - 2 * PT); });
    expect(failed(bleed3.checks)).toEqual(["bleed-box"]);
    const noIntent = await changed((pdf) => { pdf.catalog.delete(PDFName.of("OutputIntents")); });
    expect(failed(noIntent.checks)).toEqual(["output-intent"]);
    const brokenIcc = await changed((pdf) => {
      const intent = pdf.context.lookup(pdf.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).get(0)) as PDFDict;
      intent.set(PDFName.of("DestOutputProfile"), pdf.context.register(pdf.context.flateStream(new Uint8Array(300), { N: 4 })));
    });
    expect(failed(brokenIcc.checks)).toEqual(["output-intent"]);
    const layers = await changed((pdf) => { pdf.catalog.set(PDFName.of("OCProperties"), pdf.context.obj({ OCGs: [] })); });
    expect(failed(layers.checks)).toEqual(["no-layers"]);
    const annotated = await changed((pdf) => { pdf.getPages()[0].node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.obj({ Type: "Annot", Subtype: "Square", Rect: [0, 0, 10, 10] })])); });
    expect(failed(annotated.checks)).toEqual(["no-interactive"]);
    const transparent = await changed((pdf) => { pdf.getPages()[1].drawRectangle({ x: 100, y: 100, width: 50, height: 50, color: rgb(1, 0, 0), opacity: 0.5 }); });
    expect(failed(transparent.checks)).toEqual(["no-transparency"]);
  });

  it("fails content outside the safe area (4 mm, 12 mm at the wire binding) and unmanaged device RGB", async () => {
    // A mark 2 mm inside the trim (the bleed is 4 mm): outside the 4 mm safe area.
    const edge = await changed((pdf) => { pdf.getPages()[3].drawRectangle({ x: 6 * PT, y: 100, width: 10, height: 10, color: rgb(0, 0, 0) }); });
    expect(failed(edge.checks)).toEqual(["safe-area"]);
    expect(edge.checks.find((check) => check.id === "safe-area")?.detail).toMatch(/page 4: path 2\.0 mm from the left trim/);
    // The wire binding at the top needs 12 mm.
    const top = await changed((pdf) => { const page = pdf.getPages()[2]; page.drawRectangle({ x: 200, y: page.getHeight() - 14 * PT, width: 10, height: 2, color: rgb(0, 0, 0) }); });
    expect(failed(top.checks)).toEqual(["safe-area"]);
    const unmanaged = await changed((pdf) => { for (const page of pdf.getPages()) page.node.Resources()!.delete(PDFName.of("ColorSpace")); });
    expect(failed(unmanaged.checks)).toEqual(["colour"]);
  });

  it("fails encryption, a wrong page count, and a file that is not a PDF", async () => {
    const good = await buildCalendarPdf({ page: A5, year: 2027, language: "es", monthPhotos: Array(12).fill(null), coverPhoto: null });
    const encrypted = new TextEncoder().encode(Buffer.from(good).toString("latin1").replace("trailer\n<<", "trailer\n<<\n/Encrypt 999 0 R"));
    expect(failed((await calendarPreflight(encrypted, A5)).checks)).toEqual(["no-password"]);
    const short = await changed((pdf) => { pdf.removePage(13); });
    expect(failed(short.checks)).toEqual(["page-count"]);
    expect(failed((await calendarPreflight(new TextEncoder().encode("<html>not a pdf</html>"), A5)).checks)).toEqual(["pdf"]);
    await expect(validateCalendarPdf(new TextEncoder().encode("<html>not a pdf</html>"), A5)).rejects.toThrow(/PDF header/);
    // A page at the trim size only (the first refusal: "does not include bleeds").
    await expect(validateCalendarPdf(good, { width: 156, height: 218 })).rejects.toThrow(/expected 164 × 226 mm/);
  });

  it("reports an oversized file as a size problem, not counting the fixed output intent profile", async () => {
    const bytes = await buildCalendarPdf({ page: A5, year: 2027, language: "es", monthPhotos: Array(12).fill(month), coverPhoto: cover });
    const { checks, outputIntentBytes } = await calendarPreflight(bytes, A5, bytes.byteLength - 1);
    expect(outputIntentBytes).toBeGreaterThan(2_000_000);
    expect(status(checks, "file-size")).toBe("PASS");
    await expect(validateCalendarPdf(bytes, A5, bytes.byteLength - outputIntentBytes - 1)).rejects.toThrow(/allows at most/);
  });

  it("is versioned so files from the generators Gelato could not preflight are made again", () => {
    expect(CALENDAR_PDF_VERSION).toBeGreaterThanOrEqual(3);
  });
});
