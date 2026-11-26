// Every Gelato calendar format, every page: the generated PDF meets each published requirement
// (https://support.gelato.com/en/articles/8996349). Photos are made at each format's exact print size.
import { describe, expect, it, vi } from "vitest";
import jpeg from "jpeg-js";
import { PDFDocument } from "pdf-lib";
import { buildCalendarPdf, calendarLayout, calendarPdfPage, calendarPreflight, CALENDAR_PAGES, type Box } from "@/lib/pod/calendar-pdf";
import { GELATO_CALENDAR_PAGE_MM } from "@/lib/pod/gelato-catalog";
import { formatPreflightReport } from "@/lib/pod/pdf-preflight";

vi.mock("@/lib/server/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/server/cloudinary", () => ({ cloudinaryObjectKey: vi.fn(), uploadFileToCloudinary: vi.fn(), uploadRemoteImageToCloudinary: vi.fn() }));
import { calendarPrintPixels } from "@/lib/pod/print-files";

const PT = 72 / 25.4;

// A smooth gradient photo of the given size (fast to encode, realistic JPEG structure).
function photo(width: number, height: number) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const at = (y * width + x) * 4;
    data[at] = (x * 255) / width; data[at + 1] = (y * 255) / height; data[at + 2] = 128; data[at + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, 70).data);
}
// The lowest quality step (150 dpi) keeps the test fast; the 300 dpi step is covered by calendarPrintPixels below.
const photoFor = (box: Box, dpi: number) => { const { width, height } = calendarPrintPixels(box, dpi); return photo(width, height); };

describe.each(Object.entries(GELATO_CALENDAR_PAGE_MM))("calendar format %s", (format, trim) => {
  it(`meets every requirement on every page (${trim.width} × ${trim.height} mm)`, async () => {
    const layout = calendarLayout(trim);
    const month = photoFor(layout.month, 150);
    const bytes = await buildCalendarPdf({ page: trim, year: 2027, language: "es", monthPhotos: Array(12).fill(month), coverPhoto: photoFor(layout.cover, 150) });
    const { checks } = await calendarPreflight(bytes, trim, undefined, { year: 2027, language: "es" });
    expect(checks.filter((check) => check.status !== "PASS"), `${format}\n${formatPreflightReport(checks)}`).toEqual([]);
    expect(checks.find((check) => check.id === "image-resolution")?.detail).toMatch(/^13 placed images, 15\d\.\d–15\d\.\d dpi$/);

    // Geometry read back page by page: MediaBox = BleedBox = trim + 4 mm on each side, TrimBox = trim.
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(CALENDAR_PAGES);
    const output = calendarPdfPage(trim);
    for (const page of pdf.getPages()) {
      const media = page.getMediaBox();
      const bleed = page.getBleedBox();
      const box = page.getTrimBox();
      expect(media.width / PT).toBeCloseTo(output.width, 2);
      expect(media.height / PT).toBeCloseTo(output.height, 2);
      expect(bleed).toEqual(media);
      expect(box.x / PT).toBeCloseTo(4, 2);
      expect(box.y / PT).toBeCloseTo(4, 2);
      expect(box.width / PT).toBeCloseTo(trim.width, 2);
      expect(box.height / PT).toBeCloseTo(trim.height, 2);
    }
  }, 60_000);

  it("keeps the photos between 150 and 300 dpi at every quality step", () => {
    const layout = calendarLayout(trim);
    for (const box of [layout.month, layout.cover]) for (const dpi of [300, 240, 200, 150]) {
      const { width, height } = calendarPrintPixels(box, dpi);
      for (const effective of [width / (box.width / 25.4), height / (box.height / 25.4)]) {
        expect(effective).toBeGreaterThanOrEqual(150);
        expect(effective).toBeLessThanOrEqual(300);
      }
    }
  });
});
