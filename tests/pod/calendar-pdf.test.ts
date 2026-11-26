import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { boxPixels, buildCalendarPdf, calendarLayout, calendarPdfPage, CALENDAR_BLEED_MM, CALENDAR_FONT_FILES, CALENDAR_PAGES, CALENDAR_PDF_VERSION, monthGrid, monthName, stripJpegMetadata, validateCalendarPdf } from "@/lib/pod/calendar-pdf";

const A4 = { width: 210, height: 297 };
const jpeg = new Uint8Array(readFileSync("public/images/magnet-photo-8.jpg"));

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
    const bytes = await buildCalendarPdf({ page: A4, year: 2027, language: "es", monthPhotos: [jpeg, jpeg, jpeg, ...Array(9).fill(null)], coverPhoto: jpeg });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(CALENDAR_PAGES);
    const output = calendarPdfPage(A4);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo((output.width * 72) / 25.4, 3);
      expect(page.getHeight()).toBeCloseTo((output.height * 72) / 25.4, 3);
    }
    await expect(validateCalendarPdf(bytes, A4)).resolves.toMatchObject({ pages: CALENDAR_PAGES, pageMm: output, bleedMm: CALENDAR_BLEED_MM, bytes: bytes.byteLength });
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

// A calendar made the way the refused files were: standard (non-embedded) fonts, no trim box, object streams.
async function legacyPdf(options: { fonts?: boolean; boxes?: boolean; objectStreams?: boolean; pages?: number } = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = options.fonts === false ? await pdf.embedFont(StandardFonts.Helvetica) : await pdf.embedFont(readFileSync(`lib/pod/fonts/${CALENDAR_FONT_FILES.sans}`), { subset: true });
  const output = calendarPdfPage(A3);
  for (let index = 0; index < (options.pages ?? 14); index += 1) {
    const page = pdf.addPage([output.width * PT, output.height * PT]);
    page.drawText("2027", { x: 50, y: 50, size: 20, font });
    if (options.boxes !== false) { page.setBleedBox(0, 0, output.width * PT, output.height * PT); page.setTrimBox(4 * PT, 4 * PT, A3.width * PT, A3.height * PT); }
  }
  return pdf.save({ useObjectStreams: options.objectStreams ?? false });
}

describe("calendar PDF: what the print shop's preflight reads", () => {
  it("embeds every font, sets TrimBox / BleedBox, keeps photos free of ICC / EXIF and uses a classic xref table", async () => {
    const bytes = await buildCalendarPdf({ page: A3, year: 2027, language: "es", monthPhotos: Array(12).fill(withIcc(jpeg)), coverPhoto: withIcc(jpeg) });
    const report = await validateCalendarPdf(bytes, A3);
    expect(report).toMatchObject({ pages: 14, fonts: 3, images: 1, pageMm: { width: 305, height: 428 } });
    const pdf = await PDFDocument.load(bytes);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toMatch(/\nxref\n/);
    expect(text).not.toMatch(/\/ObjStm|\/Type\s*\/XRef/);
    // No PDF standard font left (those are never embedded).
    expect(text).not.toMatch(/\/BaseFont\s*\/(Helvetica|Times)/);
    for (const page of pdf.getPages()) {
      expect(page.getTrimBox()).toMatchObject({ x: expect.closeTo(4 * PT, 3), y: expect.closeTo(4 * PT, 3), width: expect.closeTo(297 * PT, 3), height: expect.closeTo(420 * PT, 3) });
      expect(page.getBleedBox()).toMatchObject({ x: 0, y: 0, width: expect.closeTo(305 * PT, 3), height: expect.closeTo(428 * PT, 3) });
    }
    const image = pdf.getPages()[0].node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const stream = pdf.context.lookup(image.values()[0] as PDFRef) as PDFRawStream;
    expect(markers(stream.contents)).not.toContain(0xe2);
    expect(String(stream.dict.get(PDFName.of("ColorSpace")))).toBe("/DeviceRGB");
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
      const samples = [...Array.from({ length: 12 }, (_, month) => monthName("es", month).toUpperCase()), ...Array.from({ length: 12 }, (_, month) => monthName("pt", month).toUpperCase()), "CALENDARIO", "CALENDÁRIO", "0123456789", "celebra-momentos.com", "LMXJVSDTQ"];
      for (const sample of samples) expect(drawn(after, sample)).toBeCloseTo(drawn(before, sample), 0);
    }
  });

  it("strips EXIF / ICC / Photoshop segments without touching the image data", () => {
    const source = withIcc(jpeg);
    expect(markers(source)).toEqual(expect.arrayContaining([0xe1, 0xe2, 0xed]));
    const stripped = stripJpegMetadata(source);
    expect(markers(stripped)).not.toEqual(expect.arrayContaining([0xe1]));
    expect(markers(stripped).filter((marker) => marker >= 0xe1 && marker <= 0xef)).toEqual([]);
    // Frame, tables and restart interval are kept; the compressed data is byte for byte the same.
    expect(markers(stripped)).toEqual(expect.arrayContaining([0xe0, 0xc0, 0xc4, 0xdb, 0xdd, 0xda]));
    expect(Buffer.from(scanData(stripped)).equals(Buffer.from(scanData(jpeg)))).toBe(true);
  });

  it("refuses photos that are not complete JPEGs", () => {
    expect(() => stripJpegMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/not a JPEG/);
    expect(() => stripJpegMetadata(jpeg.subarray(0, 40))).toThrow(/truncated|no image data/);
  });

  it("rejects files the preflight could not read: non-embedded fonts, no trim box, object streams, wrong pages, not a PDF", async () => {
    await expect(validateCalendarPdf(await legacyPdf(), A3)).resolves.toMatchObject({ pages: 14 });
    await expect(validateCalendarPdf(await legacyPdf({ fonts: false }), A3)).rejects.toThrow(/not embedded/);
    await expect(validateCalendarPdf(await legacyPdf({ boxes: false }), A3)).rejects.toThrow(/TrimBox/);
    await expect(validateCalendarPdf(await legacyPdf({ objectStreams: true }), A3)).rejects.toThrow(/cross-reference/);
    await expect(validateCalendarPdf(await legacyPdf({ pages: 13 }), A3)).rejects.toThrow(/13 pages/);
    await expect(validateCalendarPdf(new TextEncoder().encode("<html>not a pdf</html>"), A3)).rejects.toThrow(/PDF header/);
    // A page at the trim size only (the first refusal: "does not include bleeds").
    await expect(validateCalendarPdf(await legacyPdf(), { width: 305, height: 428 })).rejects.toThrow(/expected 313 × 436 mm/);
  });

  it("reports an oversized file as a size problem (the caller retries with smaller photos)", async () => {
    const bytes = await legacyPdf();
    await expect(validateCalendarPdf(bytes, A3, bytes.byteLength - 1)).rejects.toThrow(/allows at most/);
  });

  it("is versioned so files from the generator Gelato could not preflight are made again", () => {
    expect(CALENDAR_PDF_VERSION).toBeGreaterThanOrEqual(2);
  });
});
