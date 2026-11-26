// Upload reliability of the calendar print file: retries of temporary storage failures, no retry of
// permanent ones, integrity checks of what was stored and of what the print shop will download, and the whole
// render pipeline (photos → PDF → preflight → upload → delivery check) with failures injected.
import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jpeg from "jpeg-js";

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@/lib/server/prisma", () => ({ prisma: { asset: { upsert } } }));

import { uploadFileToCloudinary } from "@/lib/server/cloudinary";
import { pdfDeliverable, renderCalendarFile } from "@/lib/pod/print-files";

const pdfBytes = new TextEncoder().encode("%PDF-1.6\n% test file!\n%%EOF\n"); // 28 bytes
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stored = (bytes: Uint8Array, extra: Record<string, unknown> = {}) => json(200, { public_id: "celebramomentos/print_file/o1/item-1-default-calendar.pdf", secure_url: "https://res.cloudinary.com/demo/raw/upload/v2/celebramomentos/print_file/o1/item-1-default-calendar.pdf", bytes: bytes.byteLength, version: 2, etag: md5(bytes), ...extra });
const input = { bytes: pdfBytes, folder: "celebramomentos/print_file/o1", publicId: "item-1-default-calendar.pdf", contentType: "application/pdf" };
const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

const saved = { ...process.env };
beforeEach(() => { Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key", CLOUDINARY_API_SECRET: "secret" }); upsert.mockReset(); });
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("uploading the calendar PDF to the file storage", () => {
  it("retries a timeout and a temporary server error, then verifies the stored size and MD5", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValueOnce(json(503, { error: { message: "Service Unavailable" } })).mockResolvedValueOnce(stored(pdfBytes));
    const wait = vi.fn(async () => undefined);
    const result = await uploadFileToCloudinary(input, { fetchImpl: fetchImpl as unknown as typeof fetch, wait });
    expect(result).toMatchObject({ bytes: pdfBytes.byteLength, md5: md5(pdfBytes), attempts: 3 });
    expect(wait.mock.calls).toEqual([[1000], [3000]]);
    // Every attempt writes the same public id with overwrite: a retry can never create a second file.
    for (const [, init] of fetchImpl.mock.calls) {
      const form = (init as RequestInit).body as FormData;
      expect(form.get("public_id")).toBe(input.publicId);
      expect(form.get("overwrite")).toBe("true");
    }
  });

  it("does not retry a permanent refusal (e.g. a file over the plan's size limit) and keeps the exact error", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(400, { error: { message: "File size too large. Got 10600000. Maximum is 10485760." } }));
    await expect(uploadFileToCloudinary(input, { fetchImpl: fetchImpl as unknown as typeof fetch, wait: async () => undefined })).rejects.toThrow("Cloudinary upload failed (HTTP 400): File size too large. Got 10600000. Maximum is 10485760. [upload attempt 1/3, 28 bytes]");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never accepts an incomplete or different stored file", async () => {
    const truncated = vi.fn().mockImplementation(async () => stored(pdfBytes, { bytes: 10 }));
    await expect(uploadFileToCloudinary(input, { fetchImpl: truncated as unknown as typeof fetch, wait: async () => undefined })).rejects.toThrow(/stored 10 bytes .* instead of 28 bytes/);
    expect(truncated).toHaveBeenCalledTimes(3);
    const otherFile = vi.fn().mockResolvedValueOnce(stored(pdfBytes, { etag: "0".repeat(32) })).mockResolvedValueOnce(stored(pdfBytes));
    await expect(uploadFileToCloudinary(input, { fetchImpl: otherFile as unknown as typeof fetch, wait: async () => undefined })).resolves.toMatchObject({ attempts: 2 });
  });

  it("gives up after three network failures with the last error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(uploadFileToCloudinary(input, { fetchImpl: fetchImpl as unknown as typeof fetch, wait: async () => undefined })).rejects.toThrow("Cloudinary upload could not be sent (fetch failed) [upload attempt 3/3, 28 bytes]");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("what the print shop will download", () => {
  const delivered = (total: number, etag: string | null, status = 206, body = "%PDF-1.6") => vi.fn().mockResolvedValue(new Response(body, { status, headers: { "content-range": `bytes 0-7/${total}`, ...(etag ? { etag: `"${etag}"` } : {}) } }));

  it("accepts the exact file and refuses a different size or checksum", async () => {
    const url = "https://res.cloudinary.com/demo/raw/upload/v2/a.pdf";
    expect(await pdfDeliverable(url, { bytes: 28, md5: md5(pdfBytes) }, delivered(28, md5(pdfBytes)) as unknown as typeof fetch)).toEqual({ ok: true });
    expect(await pdfDeliverable(url, { bytes: 28, md5: md5(pdfBytes) }, delivered(27, md5(pdfBytes)) as unknown as typeof fetch)).toMatchObject({ ok: false, corrupt: true, reason: "the stored PDF is 27 bytes instead of 28" });
    expect(await pdfDeliverable(url, { bytes: 28, md5: md5(pdfBytes) }, delivered(28, "f".repeat(32)) as unknown as typeof fetch)).toMatchObject({ ok: false, corrupt: true });
    // Without an ETag only the size can be compared.
    expect(await pdfDeliverable(url, { bytes: 28, md5: md5(pdfBytes) }, delivered(28, null) as unknown as typeof fetch)).toEqual({ ok: true });
    // Blocked delivery is reported as unreachable, not as corruption.
    expect(await pdfDeliverable(url, { bytes: 28 }, delivered(28, null, 401, "denied") as unknown as typeof fetch)).toMatchObject({ ok: false, reason: expect.stringContaining("Allow delivery of PDF") });
    expect(await pdfDeliverable(url, null, delivered(28, null, 200, "<html>") as unknown as typeof fetch)).toMatchObject({ ok: false, reason: expect.stringContaining("not a PDF") });
  });
});

describe("the whole calendar pipeline with failures injected", () => {
  // A photo of the size the transformation URL asks for (w_ / h_), like Cloudinary's c_fill.
  const photoResponse = (url: string) => {
    const width = Number(url.match(/w_(\d+)/)![1]);
    const height = Number(url.match(/h_(\d+)/)![1]);
    return new Response(new Uint8Array(jpeg.encode({ data: Buffer.alloc(width * height * 4, 120), width, height }, 60).data), { status: 200 });
  };

  async function run(deliver: (bytes: Uint8Array) => Response) {
    let uploaded: Uint8Array | null = null;
    let photoCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/image/upload/")) {
        photoCalls += 1;
        // The first transformation request fails like a busy CDN; the retry gets the photo.
        return photoCalls === 1 ? new Response("busy", { status: 502 }) : photoResponse(url);
      }
      if (url.includes("api.cloudinary.com")) { uploaded = new Uint8Array(await ((init!.body as FormData).get("file") as Blob).arrayBuffer()); return stored(uploaded); }
      return deliver(uploaded!);
    }));
    return { result: renderCalendarFile({ orderId: "o1", itemId: "item", unit: 0, area: "default", photos: [...Array(11).fill(null), "https://res.cloudinary.com/demo/image/upload/v1/jan.jpg"], cover: null, year: 2027, language: "es", pageMm: { width: 148, height: 210 } }), uploaded: () => uploaded, photoCalls: () => photoCalls };
  }

  it("makes, checks, uploads and verifies the file, retrying a failed photo download", async () => {
    const pipeline = await run((bytes) => new Response("%PDF-1.6", { status: 206, headers: { "content-range": `bytes 0-7/${bytes.byteLength}`, etag: `"${md5(bytes)}"` } }));
    const result = await pipeline.result;
    expect(pipeline.photoCalls()).toBe(3); // December photo: failed once, then fetched; cover: same photo, fetched once
    expect(result).toMatchObject({ pages: 14, dpi: 300, quality: 75, optimizationAttempts: 1, bytes: pipeline.uploaded()!.byteLength, md5: md5(pipeline.uploaded()!) });
    expect(Buffer.from(pipeline.uploaded()!.subarray(0, 8)).toString("latin1")).toBe("%PDF-1.6");
    expect(upsert.mock.calls[0][0].create.metadata).toMatchObject({ pdfVersion: 4, md5: md5(pipeline.uploaded()!), uploadAttempts: 1, dpi: 300, quality: 75 });
  }, 60_000);

  it("refuses a stored file that is not the one made (and saves nothing)", async () => {
    const pipeline = await run((bytes) => new Response("%PDF-1.6", { status: 206, headers: { "content-range": `bytes 0-7/${bytes.byteLength - 100}` } }));
    await expect(pipeline.result).rejects.toThrow(/The uploaded calendar PDF is incomplete or corrupted: the stored PDF is \d+ bytes instead of \d+/);
    expect(upsert).not.toHaveBeenCalled();
  }, 60_000);
});
