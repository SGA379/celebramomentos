// PDF/X-4 output and a programmatic preflight for print files (the wall calendar, lib/pod/calendar-pdf.ts).
// Server only (reads the ICC profiles).
//
// Gelato's PDF requirements (https://support.gelato.com/en/articles/8996349, read 2026-11-26): export as
// PDF/X-4 (sRGB and CMYK objects allowed) with the GRACoL 2006 output intent; 4 mm bleed; safe area at
// least 4 mm inside the trim (12 mm on the binding side of wire-bound products); images 150–300 dpi at
// actual size; fonts embedded or outlined (7 pt minimum recommended); layers and transparency flattened;
// no password protection; no crop marks or colour bars.
//
// applyPdfX4 adds what ISO 15930-7 (PDF/X-4) needs on top of a pdf-lib document: PDF 1.6 header, the
// GTS_PDFX output intent with the embedded GRACoL2006_Coated1v2 profile, sRGB2014 as the ICC colour space
// of every image and as DefaultRGB of every page (so the design colours are colour-managed, not
// device-dependent), XMP metadata and Info entries identifying PDF/X-4 (Trapped, dates, ids), and a trailer
// ID. preflightPdf then checks the saved bytes against each requirement and reports PASS / WARN / FAIL.
// It is not a certified ISO validator: it checks the clauses that apply to the files this site makes.
import { createHash, randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHeader, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, type PDFObject } from "pdf-lib";

const PT = 72 / 25.4;

// The output condition Gelato asks for, as the ICC registry identifies it
// (https://www.color.org/registry/GRACoL2006_Coated1v2.xalter: characterization data "CGATS TR006").
export const PDFX_OUTPUT_INTENT = {
  identifier: "CGATS TR006",
  condition: "GRACoL 2006 Coated #1 (ISO 12647-2:2004 sheetfed offset, grade 1 paper)",
  registry: "http://www.color.org",
  info: "GRACoL2006_Coated1v2.icc",
} as const;

// Shipped unmodified in lib/pod/icc (licences in LICENSE-ICC-profiles.txt); listed in next.config.mjs so they
// are deployed with the server functions.
export const ICC_PROFILE_FILES = { cmyk: "GRACoL2006_Coated1v2.icc", rgb: "sRGB2014.icc" } as const;
let profiles: { cmyk: Uint8Array; rgb: Uint8Array } | null = null;
export function iccProfiles() {
  if (profiles) return profiles;
  const dir = path.join(process.cwd(), "lib", "pod", "icc");
  profiles = { cmyk: new Uint8Array(readFileSync(path.join(dir, ICC_PROFILE_FILES.cmyk))), rgb: new Uint8Array(readFileSync(path.join(dir, ICC_PROFILE_FILES.rgb))) };
  return profiles;
}

// ── ICC profiles ──────────────────────────────────────────────────────────────

export type IccHeader = { size: number; version: string; deviceClass: string; colorSpace: string; pcs: string; description: string | null };

// The header of an ICC profile, or the reason it is not a valid one (size field, 'acsp' signature, tag table
// inside the profile, description readable).
export function readIccProfile(bytes: Uint8Array): { ok: true; header: IccHeader } | { ok: false; reason: string } {
  if (bytes.length < 132) return { ok: false, reason: `only ${bytes.length} bytes` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length = 4) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const size = view.getUint32(0);
  if (size !== bytes.length) return { ok: false, reason: `declares ${size} bytes but has ${bytes.length}` };
  if (ascii(36) !== "acsp") return { ok: false, reason: "no 'acsp' signature" };
  const count = view.getUint32(128);
  if (count > 200 || 132 + count * 12 > size) return { ok: false, reason: `tag table of ${count} tags does not fit` };
  let description: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const at = 132 + index * 12;
    const offset = view.getUint32(at + 4);
    const length = view.getUint32(at + 8);
    if (offset + length > size) return { ok: false, reason: `tag ${ascii(at)} lies outside the profile` };
    if (ascii(at) === "desc") {
      const type = ascii(offset);
      if (type === "desc") description = ascii(offset + 12, Math.max(0, view.getUint32(offset + 8) - 1));
      else if (type === "mluc") { const textLength = view.getUint32(offset + 20); const textOffset = view.getUint32(offset + 24); description = Array.from({ length: textLength / 2 }, (_, char) => String.fromCharCode(view.getUint16(offset + textOffset + char * 2))).join(""); }
    }
  }
  return { ok: true, header: { size, version: `${bytes[8]}.${bytes[9] >> 4}`, deviceClass: ascii(12), colorSpace: ascii(16).trim(), pcs: ascii(20).trim(), description } };
}

// ── Making the file PDF/X-4 ───────────────────────────────────────────────────

const xmlEscape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Call after everything is drawn and `await pdf.flush()` (so the images and fonts exist), before save();
// pass the saved bytes through withPdfVersion16.
// `images`: the embedded images (all RGB JPEGs, already converted to sRGB by the caller).
export function applyPdfX4(pdf: PDFDocument, options: { title: string; creator: string; images: PDFRef[]; now?: Date }) {
  const { context } = pdf;
  const { cmyk, rgb } = iccProfiles();
  const now = new Date(Math.floor((options.now ?? new Date()).getTime() / 1000) * 1000);
  // (pdf-lib's writer ignores this; withPdfVersion16 sets the header after saving.)
  context.header = PDFHeader.forVersion(1, 6);

  // sRGB as the ICC colour space of the photos and, through DefaultRGB, of every rg / RG design colour.
  const rgbProfile = context.register(context.flateStream(rgb, { N: 3 }));
  const rgbSpace = context.register(context.obj([PDFName.of("ICCBased"), rgbProfile]));
  for (const ref of options.images) {
    const image = context.lookup(ref);
    if (image instanceof PDFRawStream && String(image.dict.get(PDFName.of("ColorSpace"))) === "/DeviceRGB") image.dict.set(PDFName.of("ColorSpace"), rgbSpace);
  }
  for (const page of pdf.getPages()) {
    const resources = page.node.Resources();
    if (!resources) throw new Error("A page has no resources");
    const spaces = resources.lookup(PDFName.of("ColorSpace"));
    if (spaces instanceof PDFDict) spaces.set(PDFName.of("DefaultRGB"), rgbSpace);
    else resources.set(PDFName.of("ColorSpace"), context.obj({ DefaultRGB: rgbSpace }));
  }

  // Subset fonts: ISO 32000 (9.6.4) wants their names to start with a six-letter tag and "+"; pdf-lib names
  // them "LiberationSans-5167". The tag is derived from the name, so it is stable.
  const tagged = new Map<string, string>();
  const tag = (name: string) => {
    if (/^[A-Z]{6}\+/.test(name)) return name;
    const known = tagged.get(name);
    if (known) return known;
    const letters = Array.from(createHash("md5").update(name).digest().subarray(0, 6), (byte) => String.fromCharCode(65 + (byte % 26))).join("");
    const next = `${letters}+${name.replace(/-\d+$/, "")}`;
    tagged.set(name, next);
    return next;
  };
  const renamed = new Set<string>();
  for (const page of pdf.getPages()) {
    const fonts = page.node.Resources()?.lookup(PDFName.of("Font"));
    if (!(fonts instanceof PDFDict)) continue;
    for (const [, ref] of fonts.entries()) {
      if (renamed.has(ref.toString())) continue;
      renamed.add(ref.toString());
      const font = context.lookup(ref);
      const descendants = font instanceof PDFDict ? font.lookup(PDFName.of("DescendantFonts")) : null;
      if (!(font instanceof PDFDict) || !(descendants instanceof PDFArray)) continue;
      const cidFont = context.lookup(descendants.get(0));
      const descriptor = cidFont instanceof PDFDict ? cidFont.lookup(PDFName.of("FontDescriptor")) : null;
      if (!(cidFont instanceof PDFDict) || !(descriptor instanceof PDFDict)) continue;
      const name = tag(String(cidFont.get(PDFName.of("BaseFont"))).slice(1));
      for (const [dict, key] of [[font, "BaseFont"], [cidFont, "BaseFont"], [descriptor, "FontName"]] as const) dict.set(PDFName.of(key), PDFName.of(name));
    }
  }

  // The output intent: GRACoL 2006 (CMYK), embedded.
  const cmykProfile = context.register(context.flateStream(cmyk, { N: 4 }));
  const intent = context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFX",
    OutputConditionIdentifier: PDFString.of(PDFX_OUTPUT_INTENT.identifier),
    OutputCondition: PDFString.of(PDFX_OUTPUT_INTENT.condition),
    RegistryName: PDFString.of(PDFX_OUTPUT_INTENT.registry),
    Info: PDFString.of(PDFX_OUTPUT_INTENT.info),
    DestOutputProfile: cmykProfile,
  });
  pdf.catalog.set(PDFName.of("OutputIntents"), context.obj([intent]));

  // Identification: Info dictionary and XMP metadata saying the same thing.
  const producer = "Celebra Momentos print files (pdf-lib)";
  pdf.setTitle(options.title);
  pdf.setCreator(options.creator);
  pdf.setProducer(producer);
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);
  const info = context.lookup(context.trailerInfo.Info, PDFDict);
  info.set(PDFName.of("Trapped"), PDFName.of("False"));
  info.set(PDFName.of("GTS_PDFXVersion"), PDFString.of("PDF/X-4"));
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const documentId = randomUUID();
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(options.title)}</rdf:li></rdf:Alt></dc:title>
   <xmp:CreateDate>${iso}</xmp:CreateDate>
   <xmp:ModifyDate>${iso}</xmp:ModifyDate>
   <xmp:MetadataDate>${iso}</xmp:MetadataDate>
   <xmp:CreatorTool>${xmlEscape(options.creator)}</xmp:CreatorTool>
   <pdf:Producer>${xmlEscape(producer)}</pdf:Producer>
   <pdf:Trapped>False</pdf:Trapped>
   <xmpMM:DocumentID>uuid:${documentId}</xmpMM:DocumentID>
   <xmpMM:InstanceID>uuid:${documentId}</xmpMM:InstanceID>
   <xmpMM:VersionID>1</xmpMM:VersionID>
   <xmpMM:RenditionClass>default</xmpMM:RenditionClass>
   <pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  // Metadata streams stay uncompressed so any tool can read them.
  pdf.catalog.set(PDFName.of("Metadata"), context.register(context.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML" })));
  const id = createHash("md5").update(documentId).update(options.title).digest("hex").toUpperCase();
  context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
}

// pdf-lib's writer always writes "%PDF-1.7" (it ignores context.header). PDF/X-4 is based on PDF 1.6, and the
// file uses nothing newer, so the version digit is set after saving: same length, so no offset moves.
export function withPdfVersion16(bytes: Uint8Array) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  if (head === "%PDF-1.6") return bytes;
  if (head !== "%PDF-1.7") throw new Error(`Unexpected PDF header ${JSON.stringify(head)}`);
  const out = bytes.slice();
  out[7] = "6".charCodeAt(0);
  return out;
}

// ── Preflight ─────────────────────────────────────────────────────────────────

export type PreflightStatus = "PASS" | "WARN" | "FAIL";
export type PreflightCheck = { id: string; requirement: string; status: PreflightStatus; detail: string };
export type PreflightOptions = {
  pages: number;
  trimMm: { width: number; height: number };
  bleedMm: number;
  // Distance of all content from the trim line, and on the binding edge (wire binding at the top).
  safeMm: number;
  bindingSafeMm: number;
  bindingEdge: "top" | "bottom" | "left" | "right";
  minDpi: number;
  maxDpi: number;
  // Recommended minimum text size (a WARN below it, not a FAIL).
  minFontPt: number;
  // Our own size budget for the file without its (fixed) output intent profile; Gelato sets no limit.
  maxBytes: number;
};

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
// a × b (PDF row-vector convention: apply a, then b).
const multiply = (a: Matrix, b: Matrix): Matrix => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const transform = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
const boundsOf = (points: [number, number][]): Bounds => ({ minX: Math.min(...points.map((p) => p[0])), minY: Math.min(...points.map((p) => p[1])), maxX: Math.max(...points.map((p) => p[0])), maxY: Math.max(...points.map((p) => p[1])) });

// Content stream tokens: hex strings, literal strings, names, array brackets, numbers and operators.
const TOKEN = /<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\)|\/[^\s/[\]()<>{}%]+|\[|\]|[^\s/[\]()<>{}%]+/g;

type FontMetrics = { twoByte: boolean; widths: Map<number, number>; defaultWidth: number; ascent: number; descent: number };

function fontMetrics(pdf: PDFDocument, font: PDFDict): FontMetrics {
  const num = (value: PDFObject | undefined, fallback: number) => (value instanceof PDFNumber ? value.asNumber() : fallback);
  const descendants = font.lookup(PDFName.of("DescendantFonts"));
  const target = descendants instanceof PDFArray ? (pdf.context.lookup(descendants.get(0)) as PDFDict) : font;
  const descriptor = target.lookup(PDFName.of("FontDescriptor"));
  const ascent = descriptor instanceof PDFDict ? num(descriptor.lookup(PDFName.of("Ascent")), 800) : 800;
  const descent = descriptor instanceof PDFDict ? num(descriptor.lookup(PDFName.of("Descent")), -200) : -200;
  const widths = new Map<number, number>();
  if (descendants instanceof PDFArray) {
    // CID widths: [c [w1 w2 …]] or [c_first c_last w].
    const list = target.lookup(PDFName.of("W"));
    const items = list instanceof PDFArray ? list.asArray().map((item) => pdf.context.lookup(item) ?? item) : [];
    for (let index = 0; index < items.length;) {
      const first = (items[index] as PDFNumber).asNumber();
      const next = items[index + 1];
      if (next instanceof PDFArray) { next.asArray().forEach((width, offset) => widths.set(first + offset, (width as PDFNumber).asNumber())); index += 2; }
      else { const last = (next as PDFNumber).asNumber(); const width = (items[index + 2] as PDFNumber).asNumber(); for (let cid = first; cid <= last; cid += 1) widths.set(cid, width); index += 3; }
    }
    return { twoByte: true, widths, defaultWidth: num(target.lookup(PDFName.of("DW")), 1000), ascent, descent };
  }
  const firstChar = num(font.lookup(PDFName.of("FirstChar")), 0);
  const list = font.lookup(PDFName.of("Widths"));
  if (list instanceof PDFArray) list.asArray().forEach((width, offset) => widths.set(firstChar + offset, (pdf.context.lookup(width) as PDFNumber ?? width as PDFNumber).asNumber()));
  return { twoByte: false, widths, defaultWidth: 500, ascent, descent };
}

const stringCodes = (token: string, twoByte: boolean): number[] => {
  let bytes: number[];
  if (token.startsWith("<")) { const hex = token.slice(1, -1).replace(/\s/g, ""); bytes = Array.from({ length: Math.ceil(hex.length / 2) }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2).padEnd(2, "0"), 16)); }
  else bytes = Array.from(token.slice(1, -1).replace(/\\(.)/g, "$1"), (char) => char.charCodeAt(0) & 0xff);
  if (!twoByte) return bytes;
  return Array.from({ length: Math.floor(bytes.length / 2) }, (_, index) => (bytes[index * 2] << 8) | bytes[index * 2 + 1]);
};

type PageContent = { bounds: (Bounds & { kind: string })[]; images: { name: string; ppiX: number; ppiY: number; bounds: Bounds }[]; fontSizesPt: number[]; deviceRgb: boolean; spotColour: string | null; inlineImage: boolean; forms: number };

// Interprets a page's content: where each image, path and text run lands (user space, points), the
// images' effective resolution and the text sizes, and the colour operators used.
function readPageContent(pdf: PDFDocument, pageIndex: number): PageContent {
  const page = pdf.getPages()[pageIndex];
  const resources = page.node.Resources();
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : contents ? [contents] : [];
  const text = streams.map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream as PDFRawStream).decode())).join("\n");
  const fonts = resources?.lookup(PDFName.of("Font"));
  const objects = resources?.lookup(PDFName.of("XObject"));
  const spaces = resources?.lookup(PDFName.of("ColorSpace"));
  const metrics = new Map<string, FontMetrics>();
  const result: PageContent = { bounds: [], images: [], fontSizesPt: [], deviceRgb: false, spotColour: null, inlineImage: false, forms: 0 };
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;
  let leading = 0;
  let font: FontMetrics | null = null;
  let fontSize = 0;
  let pathPoints: [number, number][] = [];
  const operands: string[] = [];
  const number = (index: number) => Number(operands[operands.length - index]);
  const showText = (codes: number[]) => {
    if (!font) return;
    const advance = codes.reduce((sum, code) => sum + (font!.widths.get(code) ?? font!.defaultWidth), 0) / 1000 * fontSize;
    const m = multiply(tm, ctm);
    const corners = [transform(m, 0, (font.descent / 1000) * fontSize), transform(m, advance, (font.descent / 1000) * fontSize), transform(m, 0, (font.ascent / 1000) * fontSize), transform(m, advance, (font.ascent / 1000) * fontSize)];
    result.bounds.push({ kind: "text", ...boundsOf(corners) });
    result.fontSizesPt.push(fontSize * Math.hypot(m[0], m[1]));
    tm = multiply([1, 0, 0, 1, advance, 0], tm);
  };
  const colourSpace = (name: string) => {
    if (name === "/DeviceRGB") result.deviceRgb = true;
    const space = spaces instanceof PDFDict ? spaces.lookup(PDFName.of(name.slice(1))) : undefined;
    const family = space instanceof PDFArray ? String(space.get(0)) : space ? String(space) : name;
    if (family === "/Separation" || family === "/DeviceN") result.spotColour = name;
  };
  for (const token of text.match(TOKEN) || []) {
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(token) || token.startsWith("/") || token.startsWith("<") || token.startsWith("(") || token === "[" || token === "]") { operands.push(token); continue; }
    switch (token) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() ?? IDENTITY; break;
      case "cm": ctm = multiply([number(6), number(5), number(4), number(3), number(2), number(1)], ctm); break;
      case "BT": tm = IDENTITY; lineMatrix = IDENTITY; break;
      case "Tf": { const name = operands[operands.length - 2].slice(1); fontSize = number(1); if (!metrics.has(name)) { const dict = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(name)) : null; if (dict instanceof PDFDict) metrics.set(name, fontMetrics(pdf, dict)); } font = metrics.get(name) ?? null; break; }
      case "TL": leading = number(1); break;
      case "Tm": tm = lineMatrix = [number(6), number(5), number(4), number(3), number(2), number(1)]; break;
      case "Td": lineMatrix = multiply([1, 0, 0, 1, number(2), number(1)], lineMatrix); tm = lineMatrix; break;
      case "TD": leading = -number(1); lineMatrix = multiply([1, 0, 0, 1, number(2), number(1)], lineMatrix); tm = lineMatrix; break;
      case "T*": lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix); tm = lineMatrix; break;
      case "Tj": case "'": case "\"": showText(stringCodes(operands[operands.length - 1], font?.twoByte ?? false)); break;
      case "TJ": { const start = operands.lastIndexOf("["); for (const item of operands.slice(start + 1, -1)) if (item.startsWith("<") || item.startsWith("(")) showText(stringCodes(item, font?.twoByte ?? false)); else if (font) tm = multiply([1, 0, 0, 1, (-Number(item) / 1000) * fontSize, 0], tm); break; }
      case "m": case "l": pathPoints.push(transform(ctm, number(2), number(1))); break;
      case "c": pathPoints.push(transform(ctm, number(6), number(5)), transform(ctm, number(4), number(3)), transform(ctm, number(2), number(1))); break;
      case "v": case "y": pathPoints.push(transform(ctm, number(4), number(3)), transform(ctm, number(2), number(1))); break;
      case "re": { const [x, y, w, h] = [number(4), number(3), number(2), number(1)]; pathPoints.push(transform(ctm, x, y), transform(ctm, x + w, y), transform(ctm, x, y + h), transform(ctm, x + w, y + h)); break; }
      case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*": case "S": case "s":
        if (pathPoints.length) result.bounds.push({ kind: "path", ...boundsOf(pathPoints) });
        pathPoints = []; break;
      case "n": pathPoints = []; break;
      case "rg": case "RG": result.deviceRgb = true; break;
      case "cs": case "CS": colourSpace(operands[operands.length - 1]); break;
      case "BI": result.inlineImage = true; break;
      case "Do": {
        const name = operands[operands.length - 1].slice(1);
        const object = objects instanceof PDFDict ? objects.lookup(PDFName.of(name)) : null;
        if (!(object instanceof PDFRawStream)) break;
        if (String(object.dict.get(PDFName.of("Subtype"))) === "/Form") { result.forms += 1; break; }
        const widthPx = (object.dict.get(PDFName.of("Width")) as PDFNumber).asNumber();
        const heightPx = (object.dict.get(PDFName.of("Height")) as PDFNumber).asNumber();
        const bounds = boundsOf([transform(ctm, 0, 0), transform(ctm, 1, 0), transform(ctm, 0, 1), transform(ctm, 1, 1)]);
        const widthPt = Math.hypot(ctm[0], ctm[1]);
        const heightPt = Math.hypot(ctm[2], ctm[3]);
        result.images.push({ name, ppiX: widthPx / (widthPt / 72), ppiY: heightPx / (heightPt / 72), bounds });
        result.bounds.push({ kind: "image", ...bounds });
        break;
      }
    }
    operands.length = 0;
  }
  return result;
}

function pageBox(node: PDFDict, name: string) {
  const value = node.lookup(PDFName.of(name));
  if (!(value instanceof PDFArray) || value.size() !== 4) return null;
  const [x1, y1, x2, y2] = value.asArray().map((item) => (item as PDFNumber).asNumber());
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

const mm = (points: number) => points / PT;
const close = (a: number, b: number, tolerance = 0.01) => Math.abs(a - b) <= tolerance;
const fmt = (value: number, digits = 2) => value.toFixed(digits);

// JPEG header segments that carry metadata (EXIF / XMP / ICC / Photoshop / comments).
const JPEG_METADATA = (marker: number) => (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
function jpegMarkers(bytes: Uint8Array) {
  const markers: number[] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    markers.push(marker);
    if (marker === 0xda) break;
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  return markers;
}

function fontEmbedded(pdf: PDFDocument, font: PDFDict): boolean {
  const descendants = font.lookup(PDFName.of("DescendantFonts"));
  if (descendants instanceof PDFArray) return descendants.asArray().every((item) => { const child = pdf.context.lookup(item); return child instanceof PDFDict && fontEmbedded(pdf, child); });
  const descriptor = font.lookup(PDFName.of("FontDescriptor"));
  return descriptor instanceof PDFDict && ["FontFile", "FontFile2", "FontFile3"].some((key) => descriptor.get(PDFName.of(key)) instanceof PDFRef);
}

const pdfText = (value: PDFObject | undefined) => (value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : value ? String(value) : null);

// Checks a print file against every requirement it can measure. Never throws for a bad file: each problem is
// a FAIL (or WARN) line; a file that cannot even be parsed gets a single FAIL.
export async function preflightPdf(bytes: Uint8Array, options: PreflightOptions): Promise<{ checks: PreflightCheck[]; outputIntentBytes: number }> {
  const checks: PreflightCheck[] = [];
  const add = (id: string, requirement: string, status: PreflightStatus, detail: string) => checks.push({ id, requirement, status, detail });
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  const version = head.match(/^%PDF-(\d)\.(\d)/);
  if (!version) { add("pdf", "The file is a PDF", "FAIL", "Calendar PDF does not start with a PDF header"); return { checks, outputIntentBytes: 0 }; }
  const raw = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt\b/.test(raw)) { add("no-password", "No password protection or encryption", "FAIL", "Calendar PDF must not be encrypted"); return { checks, outputIntentBytes: 0 }; }
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes, { updateMetadata: false }); } catch (reason) { add("pdf", "The file is a readable PDF", "FAIL", `Calendar PDF cannot be read: ${reason instanceof Error ? reason.message : "unknown error"}`); return { checks, outputIntentBytes: 0 }; }
  add("pdf", "The file is a readable PDF", "PASS", `PDF ${version[1]}.${version[2]}, ${bytes.byteLength} bytes`);
  add("no-password", "No password protection or encryption", pdf.isEncrypted ? "FAIL" : "PASS", pdf.isEncrypted ? "Calendar PDF must not be encrypted" : "No /Encrypt dictionary");

  // ── PDF/X-4 ──
  const versionOk = Number(version[1]) === 1 && Number(version[2]) <= 6;
  add("pdfx-version-header", "PDF/X-4: PDF version 1.6 or lower", versionOk ? "PASS" : "FAIL", versionOk ? `%PDF-${version[1]}.${version[2]}` : `Calendar PDF is version ${version[1]}.${version[2]}; PDF/X-4 needs 1.6 or lower`);
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  const infoDict = info instanceof PDFDict ? info : null;
  const metadata = pdf.catalog.lookup(PDFName.of("Metadata"));
  const xmp = metadata instanceof PDFRawStream ? new TextDecoder("utf-8").decode(decodePDFRawStream(metadata).decode()) : "";
  const xmpValue = (tag: string) => xmp.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
  const infoX = infoDict ? pdfText(infoDict.lookup(PDFName.of("GTS_PDFXVersion"))) : null;
  const xmpX = xmpValue("pdfxid:GTS_PDFXVersion");
  add("pdfx-identification", "PDF/X-4: identified as PDF/X-4 in XMP metadata and the Info dictionary", xmpX === "PDF/X-4" && infoX === "PDF/X-4" ? "PASS" : "FAIL", xmpX === "PDF/X-4" && infoX === "PDF/X-4" ? "pdfxid:GTS_PDFXVersion and Info GTS_PDFXVersion = PDF/X-4" : `Calendar PDF is not identified as PDF/X-4 (XMP: ${xmpX ?? "none"}, Info: ${infoX ?? "none"})`);
  const trappedInfo = infoDict ? String(infoDict.lookup(PDFName.of("Trapped")) ?? "") : "";
  const trappedXmp = xmpValue("pdf:Trapped");
  const missingXmp = ["xmp:CreateDate", "xmp:ModifyDate", "xmpMM:DocumentID", "xmpMM:VersionID", "xmpMM:RenditionClass"].filter((tag) => !xmpValue(tag));
  const titleInfo = infoDict ? pdfText(infoDict.lookup(PDFName.of("Title"))) : null;
  const titleXmp = xmp.match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]*)<\/rdf:li>/)?.[1]?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") ?? null;
  const metadataProblems = [
    ...(metadata instanceof PDFRawStream ? [] : ["no XMP metadata stream"]),
    ...missingXmp.map((tag) => `XMP ${tag} missing`),
    ...(["/True", "/False"].includes(trappedInfo) && trappedXmp === trappedInfo.slice(1) ? [] : [`Trapped is "${trappedInfo || "missing"}" in Info and "${trappedXmp ?? "missing"}" in XMP`]),
    ...(infoDict?.lookup(PDFName.of("CreationDate")) && infoDict.lookup(PDFName.of("ModDate")) ? [] : ["Info CreationDate / ModDate missing"]),
    ...(titleInfo && titleInfo === titleXmp ? [] : [`title differs between Info (${titleInfo}) and XMP (${titleXmp})`]),
    ...(pdf.context.trailerInfo.ID ? [] : ["no trailer ID"]),
  ];
  add("pdfx-metadata", "PDF/X-4: document metadata (XMP + Info consistent, Trapped key, version and rendition class, trailer ID)", metadataProblems.length ? "FAIL" : "PASS", metadataProblems.length ? `Calendar PDF metadata: ${metadataProblems.join("; ")}` : `Trapped=${trappedXmp}, DocumentID ${xmpValue("xmpMM:DocumentID")}, created ${xmpValue("xmp:CreateDate")}`);

  const intents = pdf.catalog.lookup(PDFName.of("OutputIntents"));
  const pdfxIntents = intents instanceof PDFArray ? intents.asArray().map((item) => pdf.context.lookup(item)).filter((item): item is PDFDict => item instanceof PDFDict && String(item.get(PDFName.of("S"))) === "/GTS_PDFX") : [];
  let outputIntentBytes = 0;
  if (pdfxIntents.length !== 1) add("output-intent", "PDF/X-4 output intent: GRACoL 2006 (Gelato)", "FAIL", `Calendar PDF has ${pdfxIntents.length} GTS_PDFX output intents; PDF/X-4 needs exactly one (GRACoL 2006)`);
  else {
    const intent = pdfxIntents[0];
    const profile = intent.lookup(PDFName.of("DestOutputProfile"));
    const identifier = pdfText(intent.lookup(PDFName.of("OutputConditionIdentifier")));
    const parsed = profile instanceof PDFRawStream ? readIccProfile(decodePDFRawStream(profile).decode()) : null;
    outputIntentBytes = profile instanceof PDFRawStream ? profile.contents.length : 0;
    const n = profile instanceof PDFRawStream ? (profile.dict.get(PDFName.of("N")) as PDFNumber | undefined)?.asNumber() : undefined;
    const problems = [
      ...(identifier ? [] : ["no OutputConditionIdentifier"]),
      ...(parsed === null ? ["no embedded DestOutputProfile"] : parsed.ok ? [] : [`DestOutputProfile is not a valid ICC profile (${parsed.reason})`]),
      ...(parsed?.ok && (parsed.header.colorSpace !== "CMYK" || parsed.header.deviceClass !== "prtr" || n !== 4) ? [`DestOutputProfile is ${parsed.header.deviceClass} ${parsed.header.colorSpace} (N ${n}); a CMYK printer profile is needed`] : []),
      ...(parsed?.ok && !/GRACoL\s*2006/i.test(parsed.header.description || "") ? [`output intent is ${parsed.header.description}, not GRACoL 2006`] : []),
    ];
    add("output-intent", "PDF/X-4 output intent: GRACoL 2006 (Gelato)", problems.length ? "FAIL" : "PASS", problems.length ? `Calendar PDF output intent: ${problems.join("; ")}` : `${identifier} · embedded ${parsed && parsed.ok ? `${parsed.header.description} (ICC v${parsed.header.version} ${parsed.header.deviceClass} ${parsed.header.colorSpace}, ${parsed.header.size} bytes)` : ""}`);
  }

  // ── Structure ──
  const plain = !/\/Type\s*\/(ObjStm|XRef)\b/.test(raw) && /\nxref\r?\n/.test(raw);
  add("structure", "Plain file structure (classic xref table, no object streams)", plain ? "PASS" : "FAIL", plain ? "Classic cross-reference table" : "Calendar PDF must use a classic cross-reference table (no object or xref streams)");
  const interactive = [
    ...(pdf.catalog.get(PDFName.of("AcroForm")) ? ["form fields"] : []),
    ...(pdf.catalog.get(PDFName.of("OpenAction")) || pdf.catalog.get(PDFName.of("AA")) ? ["actions"] : []),
    ...(/\/JavaScript\b|\/JS\b/.test(raw) ? ["JavaScript"] : []),
    ...(/\/EmbeddedFiles\b/.test(raw) ? ["embedded files"] : []),
    // pdf-lib gives every page an empty /Annots array; only actual annotations count.
    ...(pdf.getPages().some((page) => { const annots = page.node.lookup(PDFName.of("Annots")); return annots instanceof PDFArray && annots.size() > 0; }) ? ["annotations / marks"] : []),
  ];
  add("no-interactive", "No forms, scripts, actions, attachments or annotations (crop marks, colour bars)", interactive.length ? "FAIL" : "PASS", interactive.length ? `Calendar PDF contains ${interactive.join(", ")}` : "None present");
  const layers = Boolean(pdf.catalog.get(PDFName.of("OCProperties")));
  add("no-layers", "Layers flattened (no optional content)", layers ? "FAIL" : "PASS", layers ? "Calendar PDF has layers (optional content)" : "No optional content");

  // ── Pages and boxes ──
  const pages = pdf.getPages();
  add("page-count", `${options.pages} pages (cover, 12 months, back) as single pages`, pages.length === options.pages ? "PASS" : "FAIL", pages.length === options.pages ? `${pages.length} pages` : `Calendar PDF has ${pages.length} pages; Gelato requires ${options.pages}`);
  const expected = { width: options.trimMm.width + options.bleedMm * 2, height: options.trimMm.height + options.bleedMm * 2 };
  const sizeProblems: string[] = [];
  const bleedProblems: string[] = [];
  const trimProblems: string[] = [];
  for (const [index, page] of pages.entries()) {
    const label = `page ${index + 1}`;
    const media = page.getMediaBox();
    if (!close(mm(media.width), expected.width) || !close(mm(media.height), expected.height)) sizeProblems.push(`${label} is ${fmt(mm(media.width))} × ${fmt(mm(media.height))} mm; expected ${expected.width} × ${expected.height} mm including ${options.bleedMm} mm bleed`);
    if (page.getRotation().angle % 360 !== 0) sizeProblems.push(`${label} is rotated`);
    const trim = pageBox(page.node, "TrimBox");
    const bleed = pageBox(page.node, "BleedBox");
    if (!trim) { trimProblems.push(`${label} has no TrimBox`); continue; }
    if (!close(mm(trim.width), options.trimMm.width) || !close(mm(trim.height), options.trimMm.height)) trimProblems.push(`${label} TrimBox is ${fmt(mm(trim.width))} × ${fmt(mm(trim.height))} mm, not ${options.trimMm.width} × ${options.trimMm.height} mm`);
    if (!bleed) { bleedProblems.push(`${label} has no BleedBox`); continue; }
    const sides = { left: mm(trim.x - bleed.x), bottom: mm(trim.y - bleed.y), right: mm(bleed.x + bleed.width - trim.x - trim.width), top: mm(bleed.y + bleed.height - trim.y - trim.height) };
    for (const [side, value] of Object.entries(sides)) if (!close(value, options.bleedMm)) bleedProblems.push(`${label} bleed on the ${side} is ${fmt(value)} mm`);
    if (bleed.x < media.x - 0.01 || bleed.y < media.y - 0.01 || bleed.x + bleed.width > media.x + media.width + 0.01 || bleed.y + bleed.height > media.y + media.height + 0.01) bleedProblems.push(`${label} BleedBox extends beyond the page`);
  }
  add("page-size", `Page size = trim + ${options.bleedMm} mm bleed (${expected.width} × ${expected.height} mm), not rotated`, sizeProblems.length ? "FAIL" : "PASS", sizeProblems.length ? `Calendar PDF ${sizeProblems[0]}${sizeProblems.length > 1 ? ` (+${sizeProblems.length - 1} more)` : ""}` : `All ${pages.length} pages ${expected.width} × ${expected.height} mm`);
  add("bleed-box", `BleedBox: exactly ${options.bleedMm} mm beyond the trim on all four sides`, bleedProblems.length ? "FAIL" : "PASS", bleedProblems.length ? `Calendar PDF ${bleedProblems[0]}${bleedProblems.length > 1 ? ` (+${bleedProblems.length - 1} more)` : ""}` : `${options.bleedMm} mm left, right, top and bottom on every page`);
  add("trim-box", `TrimBox: the ${options.trimMm.width} × ${options.trimMm.height} mm calendar size`, trimProblems.length ? "FAIL" : "PASS", trimProblems.length ? `Calendar PDF ${trimProblems[0]} of ${options.trimMm.width} × ${options.trimMm.height} mm inside the ${options.bleedMm} mm bleed` : `${options.trimMm.width} × ${options.trimMm.height} mm at ${options.bleedMm} mm from each page edge`);

  // ── Content: safe area, resolution, fonts, colour ──
  const contents = pages.map((_, index) => readPageContent(pdf, index));
  const margins = { left: Infinity, right: Infinity, top: Infinity, bottom: Infinity };
  const outside: string[] = [];
  contents.forEach((content, index) => {
    const trim = pageBox(pages[index].node, "TrimBox");
    if (!trim) return;
    for (const item of content.bounds) {
      const distance = { left: mm(item.minX - trim.x), bottom: mm(item.minY - trim.y), right: mm(trim.x + trim.width - item.maxX), top: mm(trim.y + trim.height - item.maxY) };
      for (const side of Object.keys(margins) as (keyof typeof margins)[]) {
        margins[side] = Math.min(margins[side], distance[side]);
        const needed = side === options.bindingEdge ? options.bindingSafeMm : options.safeMm;
        if (distance[side] < needed - 0.01 && outside.length < 5) outside.push(`page ${index + 1}: ${item.kind} ${fmt(distance[side], 1)} mm from the ${side} trim (needs ${needed} mm)`);
      }
    }
  });
  add("safe-area", `Safe area: content ≥ ${options.safeMm} mm inside the trim (${options.bindingSafeMm} mm on the ${options.bindingEdge} binding edge)`, outside.length ? "FAIL" : "PASS", outside.length ? `Calendar PDF content outside the safe area: ${outside.join("; ")}` : `Closest content: left ${fmt(margins.left, 1)} mm, right ${fmt(margins.right, 1)} mm, top ${fmt(margins.top, 1)} mm, bottom ${fmt(margins.bottom, 1)} mm from the trim`);

  const placed = contents.flatMap((content, index) => content.images.map((image) => ({ ...image, page: index + 1 })));
  const badDpi = placed.filter((image) => Math.min(image.ppiX, image.ppiY) < options.minDpi || Math.max(image.ppiX, image.ppiY) > options.maxDpi);
  const ppis = placed.flatMap((image) => [image.ppiX, image.ppiY]);
  add("image-resolution", `Images ${options.minDpi}–${options.maxDpi} dpi at actual print size`, badDpi.length ? "FAIL" : "PASS", badDpi.length ? `Calendar PDF page ${badDpi[0].page} has an image at ${fmt(badDpi[0].ppiX, 1)} × ${fmt(badDpi[0].ppiY, 1)} dpi${badDpi.length > 1 ? ` (+${badDpi.length - 1} more)` : ""}` : placed.length ? `${placed.length} placed images, ${fmt(Math.min(...ppis), 1)}–${fmt(Math.max(...ppis), 1)} dpi` : "No images");

  const fontProblems: string[] = [];
  const fontsSeen = new Set<string>();
  const fontNames: string[] = [];
  for (const page of pages) {
    const dict = page.node.Resources()?.lookup(PDFName.of("Font"));
    if (!(dict instanceof PDFDict)) continue;
    for (const [, ref] of dict.entries()) {
      if (fontsSeen.has(ref.toString())) continue;
      fontsSeen.add(ref.toString());
      const font = pdf.context.lookup(ref);
      if (!(font instanceof PDFDict) || !fontEmbedded(pdf, font)) fontProblems.push(font instanceof PDFDict ? String(font.get(PDFName.of("BaseFont"))) : ref.toString());
      else fontNames.push(String(font.get(PDFName.of("BaseFont"))).slice(1));
    }
  }
  add("fonts-embedded", "Fonts embedded (or text outlined)", fontProblems.length ? "FAIL" : "PASS", fontProblems.length ? `Calendar PDF uses a font that is not embedded (${fontProblems.join(", ")})` : `${fontsSeen.size} fonts, all embedded: ${fontNames.join(", ")}`);
  const untagged = fontNames.filter((name) => !/^[A-Z]{6}\+/.test(name));
  add("font-names", "Embedded subset fonts named with the ABCDEF+ subset tag (ISO 32000 9.6.4)", untagged.length ? "WARN" : "PASS", untagged.length ? `Fonts without a subset tag (fine if fully embedded): ${untagged.join(", ")}` : "All embedded fonts carry a subset tag");
  const sizes = contents.flatMap((content) => content.fontSizesPt);
  const smallest = sizes.length ? Math.min(...sizes) : null;
  add("font-size", `Text at least ${options.minFontPt} pt (Gelato recommendation)`, smallest !== null && smallest < options.minFontPt ? "WARN" : "PASS", smallest === null ? "No text" : `Smallest text ${fmt(smallest, 1)} pt`);

  // Colour: every image ICC-based (or DeviceGray / DeviceCMYK), DeviceRGB design colours only with a
  // DefaultRGB colour space, no spot colours, every ICC profile valid, no metadata inside JPEGs.
  const colourProblems: string[] = [];
  let iccProfilesChecked = 0;
  const checkIccSpace = (space: PDFObject | undefined, where: string) => {
    const array = space instanceof PDFRef ? pdf.context.lookup(space) : space;
    if (!(array instanceof PDFArray) || String(array.get(0)) !== "/ICCBased") return false;
    const stream = pdf.context.lookup(array.get(1));
    const parsed = stream instanceof PDFRawStream ? readIccProfile(decodePDFRawStream(stream).decode()) : null;
    const n = stream instanceof PDFRawStream ? (stream.dict.get(PDFName.of("N")) as PDFNumber | undefined)?.asNumber() : undefined;
    iccProfilesChecked += 1;
    if (!parsed?.ok) colourProblems.push(`${where}: invalid ICC profile${parsed && !parsed.ok ? ` (${parsed.reason})` : ""}`);
    else if ({ RGB: 3, CMYK: 4, GRAY: 1 }[parsed.header.colorSpace] !== n) colourProblems.push(`${where}: ICC profile is ${parsed.header.colorSpace} but N is ${n}`);
    return true;
  };
  const imagesSeen = new Set<string>();
  pages.forEach((page, index) => {
    const resources = page.node.Resources();
    const spaces = resources?.lookup(PDFName.of("ColorSpace"));
    const defaultRgb = spaces instanceof PDFDict ? spaces.get(PDFName.of("DefaultRGB")) : undefined;
    const managedRgb = defaultRgb !== undefined && checkIccSpace(defaultRgb, `page ${index + 1} DefaultRGB`);
    if (contents[index].deviceRgb && !managedRgb) colourProblems.push(`page ${index + 1} uses device RGB colours without a DefaultRGB ICC colour space`);
    if (contents[index].spotColour) colourProblems.push(`page ${index + 1} uses a spot colour (${contents[index].spotColour})`);
    if (contents[index].inlineImage) colourProblems.push(`page ${index + 1} has an inline image`);
    const objects = resources?.lookup(PDFName.of("XObject"));
    if (!(objects instanceof PDFDict)) return;
    for (const [, ref] of objects.entries()) {
      if (imagesSeen.has(ref.toString())) continue;
      imagesSeen.add(ref.toString());
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream) || String(stream.dict.get(PDFName.of("Subtype"))) !== "/Image") continue;
      const space = stream.dict.get(PDFName.of("ColorSpace"));
      const spaceName = String(space instanceof PDFRef ? pdf.context.lookup(space) : space);
      const iccBased = checkIccSpace(space, `page ${index + 1} image`);
      if (!iccBased && !["/DeviceGray", "/DeviceCMYK"].includes(spaceName) && !(spaceName === "/DeviceRGB" && managedRgb)) colourProblems.push(`page ${index + 1} has an image in ${spaceName} without an ICC profile`);
      if (String(stream.dict.get(PDFName.of("BitsPerComponent"))) !== "8") colourProblems.push(`page ${index + 1} has an image that is not 8 bits per channel`);
      if (String(stream.dict.get(PDFName.of("Filter"))) === "/DCTDecode") {
        const markers = jpegMarkers(stream.contents);
        if (markers.some(JPEG_METADATA)) colourProblems.push(`page ${index + 1} has a JPEG photo with embedded ICC / EXIF metadata`);
        if (!markers.includes(0xc0) && !markers.includes(0xc1)) colourProblems.push(`page ${index + 1} has a JPEG photo that is not baseline-encoded`);
      }
    }
  });
  add("colour", "Colour: sRGB/CMYK objects colour-managed (ICC-based), valid ICC profiles, no spot colours, no profiles hidden in JPEGs", colourProblems.length ? "FAIL" : "PASS", colourProblems.length ? `Calendar PDF colour: ${colourProblems.slice(0, 4).join("; ")}` : `${iccProfilesChecked} ICC colour space uses checked; design colours through DefaultRGB (sRGB2014)`);

  // Transparency (Gelato: flatten it): soft masks, constant alpha below 1, blend modes, transparency groups.
  const transparency: string[] = [];
  pages.forEach((page, index) => {
    if (page.node.get(PDFName.of("Group"))) transparency.push(`page ${index + 1} transparency group`);
    const states = page.node.Resources()?.lookup(PDFName.of("ExtGState"));
    if (states instanceof PDFDict) for (const [name, ref] of states.entries()) {
      const state = pdf.context.lookup(ref);
      if (!(state instanceof PDFDict)) continue;
      const alpha = [state.get(PDFName.of("CA")), state.get(PDFName.of("ca"))].filter((value): value is PDFNumber => value instanceof PDFNumber).some((value) => value.asNumber() < 1);
      const mask = state.get(PDFName.of("SMask"));
      const blend = state.get(PDFName.of("BM"));
      if (alpha || (mask && String(mask) !== "/None") || (blend && !["/Normal", "/Compatible"].includes(String(blend)))) transparency.push(`page ${index + 1} ${name}`);
    }
  });
  if (/\/SMask\s*\d+\s+\d+\s+R/.test(raw)) transparency.push("an image with a soft mask");
  add("no-transparency", "Transparency flattened", transparency.length ? "FAIL" : "PASS", transparency.length ? `Calendar PDF has transparency: ${transparency.slice(0, 3).join(", ")}` : "No soft masks, alpha or blend modes");

  const forms = contents.reduce((sum, content) => sum + content.forms, 0);
  if (forms) add("no-form-xobjects", "Content readable by this preflight (no nested form XObjects)", "WARN", `${forms} form XObjects were not inspected`);

  const budget = bytes.byteLength - outputIntentBytes;
  add("file-size", "File size within our budget (Gelato sets no maximum)", budget > options.maxBytes ? "FAIL" : "PASS", budget > options.maxBytes ? `Calendar PDF is ${budget} bytes without its output intent profile; Gelato allows at most ${options.maxBytes} bytes in our setup` : `${bytes.byteLength} bytes (${budget} without the ${outputIntentBytes}-byte output intent profile; budget ${options.maxBytes})`);
  return { checks, outputIntentBytes };
}

// A plain-text PASS / WARN / FAIL report.
export function formatPreflightReport(checks: PreflightCheck[]) {
  const width = Math.max(...checks.map((check) => check.requirement.length));
  return checks.map((check) => `${check.status.padEnd(4)}  ${check.requirement.padEnd(width)}  ${check.detail}`).join("\n");
}
