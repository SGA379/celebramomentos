// Page layout of the wall calendar PDF (lib/pod/calendar-pdf.ts), in mm. Pure and dependency-free so the
// product studio can show the exact photo sizes the print file needs (cover and month photo boxes).
export type Box = { x: number; y: number; width: number; height: number }; // mm, from the top-left corner

// The page layout in mm for a page size. Photo boxes are what the caller crops the photos to.
export function calendarLayout(page: { width: number; height: number }) {
  const margin = Math.round(Math.min(page.width, page.height) * 0.06 * 10) / 10;
  // Room for the wire and the hook at the top.
  const top = margin + Math.max(6, Math.round(page.height * 0.025));
  const width = page.width - margin * 2;
  // Same shape as the studio preview (1.65 : 1), never more than half the page.
  const photoHeight = Math.min(width / 1.65, page.height * 0.5);
  const month: Box = { x: margin, y: top, width, height: Math.round(photoHeight * 10) / 10 };
  const coverHeight = Math.round((page.height - top - margin) * 0.74 * 10) / 10;
  const cover: Box = { x: margin, y: top, width, height: coverHeight };
  return { page, margin, top, month, cover };
}

// Pixel size of a photo box at the given resolution (300 dpi: full print quality).
export const boxPixels = (box: Box, dpi = 300) => ({ width: Math.round((box.width / 25.4) * dpi), height: Math.round((box.height / 25.4) * dpi) });
