import { beforeEach, describe, expect, it, vi } from "vitest";

// Calendar front cover: the customer's own cover photo (photos[12]) is used on the cover page of the
// Gelato calendar PDF; calendars ordered without one keep using the January photo.
const CLOUD = "https://res.cloudinary.com/celebra/image/upload/v1/celebramomentos/customer_upload/";
const month = (index: number) => `${CLOUD}month-${index}.jpg`;
const COVER = `${CLOUD}cover.jpg`;
const state = vi.hoisted(() => ({ calls: [] as { photos: (string | null)[]; cover?: string | null }[] }));

vi.mock("@/lib/server/prisma", () => ({ prisma: {
  productVariant: { findUnique: async () => ({ name: "A4 (21 x 29.7 cm)", attributes: {} }) },
  order: { findUnique: async () => ({ shippingAddress: { country: "ES" } }) },
  asset: {
    findMany: async ({ where }: { where: { url: { in: string[] } } }) => where.url.in.filter((url) => url.includes("customer_upload")).map((url) => ({ url, kind: "CUSTOMER_UPLOAD", mimeType: "image/jpeg", metadata: { width: 3000, height: 2400 } })),
    upsert: async () => ({}),
  },
} }));
vi.mock("@/lib/pod/print-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pod/print-files")>()),
  renderCalendarFile: async (input: { photos: (string | null)[]; cover?: string | null }) => { state.calls.push({ photos: input.photos, cover: input.cover }); return { url: "https://res.cloudinary.com/celebra/raw/upload/v2/calendar.pdf", pages: 14, bytes: 1000 }; },
  pdfDeliverable: async () => ({ ok: true }),
}));

import { planItem } from "@/lib/pod/fulfillment";
import { buildCalendarPdf } from "@/lib/pod/calendar-pdf";

const calendarItem = (photos: (string | null)[]) => ({
  id: "item1", orderId: "o1", name: "Calendarios de pared", quantity: 1, variantId: "v1", productId: "p1", templateId: null, unitPriceCents: 2299, createdAt: new Date("2026-11-16T10:00:00Z"),
  podFulfillmentId: null, podProvider: null, podProductRef: null, podArtwork: null, podIssues: null,
  personalization: { product: { kind: "CATALOG", productKind: "CALENDAR", productId: "p1", variantId: "v1", name: "Calendarios de pared", options: {}, photos, provider: "GELATO", sku: null } },
}) as never;
const months = Array.from({ length: 12 }, (_, index) => month(index));

beforeEach(() => { state.calls = []; });

describe("calendar front cover", () => {
  it("sends the customer's own cover photo to the calendar PDF, separate from January", async () => {
    const plan = await planItem(calendarItem([...months, COVER]), []);
    expect(plan.issues.filter((issue) => issue.severity === "blocker")).toEqual([]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].cover).toBe(COVER);
    expect(state.calls[0].photos).toEqual(months);
    expect(plan.artwork[0]).toMatchObject({ kind: "calendar", source: "design", pages: 14 });
    expect(plan.artwork[0].signature).toContain(`cover:${COVER}`);
  });

  it("keeps calendars without a cover photo exactly as before (cover from January, same signature)", async () => {
    const plan = await planItem(calendarItem(months), []);
    expect(state.calls[0].cover).toBeNull();
    expect(plan.artwork[0].signature).not.toContain("cover:");
  });

  it("makes the PDF again when the cover photo changes", async () => {
    const first = await planItem(calendarItem([...months, COVER]), []);
    await planItem(calendarItem([...months, COVER]), first.artwork);
    expect(state.calls).toHaveLength(1);
    await planItem(calendarItem([...months, `${CLOUD}other-cover.jpg`]), first.artwork);
    expect(state.calls).toHaveLength(2);
  });

  it("never uses a cover photo that is not an upload from this site", async () => {
    await planItem(calendarItem([...months, "https://example.org/cover.jpg"]), []);
    expect(state.calls[0].cover).toBeNull();
  });

  it("the PDF is still 14 pages (cover, 12 months, back)", async () => {
    const bytes = await buildCalendarPdf({ page: { width: 210, height: 297 }, year: 2027, language: "es", monthPhotos: Array(12).fill(null), coverPhoto: null });
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(14);
  });
});
