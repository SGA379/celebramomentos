import { createHash, randomUUID } from "crypto";

export type CloudinaryUploadInput = {
  body: Buffer;
  fileName: string;
  mimeType: string;
  kind: string;
};

export type CloudinaryUploadResult = {
  publicId: string;
  secureUrl: string;
  bytes: number;
  version?: number;
  assetId?: string;
  width?: number;
  height?: number;
};

function config() {
  const urlValue = process.env.CLOUDINARY_URL;
  let url: URL | null = null;
  if (urlValue) {
    try { url = new URL(urlValue); } catch { url = null; }
  }
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || url?.hostname;
  const apiKey = process.env.CLOUDINARY_API_KEY || (url?.username && !url.username.includes("<") ? decodeURIComponent(url.username) : undefined);
  const apiSecret = process.env.CLOUDINARY_API_SECRET || (url?.password && !url.password.includes("<") ? decodeURIComponent(url.password) : undefined);
  const missing = [
    !cloudName ? "CLOUDINARY_CLOUD_NAME" : null,
    !apiKey ? "CLOUDINARY_API_KEY" : null,
    !apiSecret ? "CLOUDINARY_API_SECRET" : null,
  ].filter((value): value is string => Boolean(value));
  if (missing.length) throw new Error(`Cloudinary storage is not configured. Missing: ${missing.join(", ")}.`);
  return { cloudName: cloudName!, apiKey: apiKey!, apiSecret: apiSecret! };
}

export function cloudinaryUploadUrl() {
  return `https://api.cloudinary.com/v1_1/${config().cloudName}/image/upload`;
}

export function cloudinaryAssetUrl(publicId: string, version?: number) {
  const versionPart = version ? `/v${version}` : "";
  return `https://res.cloudinary.com/${config().cloudName}/image/upload${versionPart}/${publicId}`;
}

export function cloudinaryObjectKey(publicId: string) {
  return `cloudinary:${publicId}`;
}

export function signCloudinaryParams(params: Record<string, string | number>) {
  const { apiSecret } = config();
  const serialized = Object.entries(params)
    .filter(([, value]) => value !== "" && value !== undefined && value !== null)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha1").update(`${serialized}${apiSecret}`).digest("hex");
}

export function cloudinaryUploadParams(kind: string) {
  const { cloudName, apiKey } = config();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `celebramomentos/${kind.toLowerCase()}/${new Date().toISOString().slice(0, 10)}`;
  const publicId = randomUUID();
  const signed = { folder, public_id: publicId, timestamp };
  return { cloudName, apiKey, timestamp, folder, publicId, signature: signCloudinaryParams(signed) };
}

export async function uploadImageToCloudinary(input: CloudinaryUploadInput): Promise<CloudinaryUploadResult> {
  const { apiKey } = config();
  const params = cloudinaryUploadParams(input.kind);
  const form = new FormData();
  const binary = new Uint8Array(input.body.length);
  binary.set(input.body);
  form.append("file", new Blob([binary.buffer], { type: input.mimeType }), input.fileName);
  form.append("api_key", apiKey);
  form.append("timestamp", String(params.timestamp));
  form.append("folder", params.folder);
  form.append("public_id", params.publicId);
  form.append("signature", params.signature);

  const response = await fetch(cloudinaryUploadUrl(), { method: "POST", body: form });
  const body = await response.json().catch(() => ({})) as { public_id?: string; secure_url?: string; bytes?: number; version?: number; asset_id?: string; width?: number; height?: number; error?: { message?: string } };
  if (!response.ok || !body.public_id || !body.secure_url) throw new Error(body.error?.message || "Cloudinary image upload failed");
  return { publicId: body.public_id, secureUrl: body.secure_url, bytes: body.bytes || input.body.length, version: body.version, assetId: body.asset_id, width: body.width, height: body.height };
}

// Stores a copy of a remote image (e.g. a Cloudinary transformation URL) as its own
// file under a fixed public id, so uploading the same file again replaces it.
export async function uploadRemoteImageToCloudinary(input: { url: string; folder: string; publicId: string }): Promise<CloudinaryUploadResult & { format?: string }> {
  const { apiKey } = config();
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = { folder: input.folder, overwrite: "true", public_id: input.publicId, timestamp };
  const form = new FormData();
  form.append("file", input.url);
  for (const [key, value] of Object.entries(signed)) form.append(key, String(value));
  form.append("api_key", apiKey);
  form.append("signature", signCloudinaryParams(signed));
  const response = await fetch(cloudinaryUploadUrl(), { method: "POST", body: form, signal: AbortSignal.timeout(45_000) });
  const body = await response.json().catch(() => ({})) as { public_id?: string; secure_url?: string; bytes?: number; version?: number; asset_id?: string; width?: number; height?: number; format?: string; error?: { message?: string } };
  if (!response.ok || !body.public_id || !body.secure_url) throw new Error(body.error?.message || `Cloudinary upload failed (HTTP ${response.status})`);
  return { publicId: body.public_id, secureUrl: body.secure_url, bytes: body.bytes || 0, version: body.version, assetId: body.asset_id, width: body.width, height: body.height, format: body.format };
}

// Uploads a generated file (e.g. a calendar PDF) as a Cloudinary "raw" asset, delivered as it is at
// https://res.cloudinary.com/<cloud>/raw/upload/…/<publicId> (the public id keeps the file extension).
// Reliability: a timeout, a network error or a 420 / 429 / 5xx answer is retried (3 attempts, 1 s then 3 s
// apart); the public id is fixed and overwritten, so a retry after an upload that did arrive replaces the
// same file instead of making a second one. Other errors (e.g. a file over the plan's size limit) are not
// retried. The stored size (and MD5 etag, when Cloudinary returns it) must equal the bytes sent.
const RETRYABLE_UPLOAD = (status: number) => status === 420 || status === 429 || status >= 500;
export type FileUploadOptions = { attempts?: number; timeoutMs?: number; fetchImpl?: typeof fetch; wait?: (ms: number) => Promise<unknown> };

export async function uploadFileToCloudinary(input: { bytes: Uint8Array; folder: string; publicId: string; contentType: string }, options: FileUploadOptions = {}): Promise<CloudinaryUploadResult & { format?: string; md5: string; attempts: number }> {
  const { attempts = 3, timeoutMs = 60_000, fetchImpl = fetch, wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  const { apiKey } = config();
  const md5 = createHash("md5").update(input.bytes).digest("hex");
  let lastError = new Error("Cloudinary upload was not attempted");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const label = `[upload attempt ${attempt}/${attempts}, ${input.bytes.byteLength} bytes]`;
    const retry = async () => { if (attempt < attempts) await wait(1000 * 3 ** (attempt - 1)); return attempt < attempts; };
    const timestamp = Math.floor(Date.now() / 1000);
    const signed = { folder: input.folder, overwrite: "true", public_id: input.publicId, timestamp };
    const form = new FormData();
    form.append("file", new Blob([input.bytes as unknown as BlobPart], { type: input.contentType }), input.publicId);
    for (const [key, value] of Object.entries(signed)) form.append(key, String(value));
    form.append("api_key", apiKey);
    form.append("signature", signCloudinaryParams(signed));
    let response: Response;
    try {
      response = await fetchImpl(cloudinaryUploadUrl().replace("/image/upload", "/raw/upload"), { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (reason) {
      const timedOut = reason instanceof Error && (reason.name === "TimeoutError" || reason.name === "AbortError");
      lastError = new Error(`Cloudinary upload ${timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `could not be sent (${reason instanceof Error ? reason.message : "network error"})`} ${label}`);
      if (await retry()) continue;
      break;
    }
    const body = await response.json().catch(() => ({})) as { public_id?: string; secure_url?: string; bytes?: number; version?: number; asset_id?: string; etag?: string; format?: string; error?: { message?: string } };
    if (!response.ok || !body.public_id || !body.secure_url) {
      lastError = new Error(`Cloudinary upload failed (HTTP ${response.status}): ${body.error?.message || "no file in the answer"} ${label}`);
      if (RETRYABLE_UPLOAD(response.status) && await retry()) continue;
      throw lastError;
    }
    if (body.bytes !== input.bytes.byteLength || (body.etag && body.etag !== md5)) {
      lastError = new Error(`Cloudinary stored ${body.bytes ?? "?"} bytes (etag ${body.etag ?? "none"}) instead of ${input.bytes.byteLength} bytes (md5 ${md5}) ${label}`);
      if (await retry()) continue;
      throw lastError;
    }
    return { publicId: body.public_id, secureUrl: body.secure_url, bytes: body.bytes, version: body.version, assetId: body.asset_id, format: body.format, md5, attempts: attempt };
  }
  throw lastError;
}

export function verifyCloudinaryUpload(input: { publicId: string; version: number; signature: string; secureUrl: string }) {
  const { cloudName } = config();
  const expected = signCloudinaryParams({ public_id: input.publicId, version: input.version });
  if (expected !== input.signature) throw new Error("Cloudinary upload signature is invalid");
  const allowedPrefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;
  if (!input.secureUrl.startsWith(allowedPrefix)) throw new Error("Cloudinary asset URL is invalid");
}

export function cloudinaryConfigStatus() {
  try { config(); return { configured: true }; } catch (error) { return { configured: false, error: error instanceof Error ? error.message : "Cloudinary is not configured" }; }
}
