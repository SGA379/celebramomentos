import { describe, expect, it } from "vitest";
import { cropRect } from "@/lib/crop";

const mugFaceAspect = 1350 / 1050;

describe("mug artwork framing", () => {
  it.each([
    ["portrait", { width: 1200, height: 1800 }],
    ["landscape", { width: 2400, height: 1350 }],
    ["square", { width: 1600, height: 1600 }],
  ])("fills the complete printable face for a %s upload", (_name, source) => {
    const rect = cropRect(source, mugFaceAspect, { zoom: 1, x: 0.5, y: 0.5 });
    expect(rect.width / rect.height).toBeCloseTo(mugFaceAspect, 6);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.left + rect.width).toBeLessThanOrEqual(source.width);
    expect(rect.top + rect.height).toBeLessThanOrEqual(source.height);
  });
});
