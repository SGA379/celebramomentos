// The three Printeers phone case types the client approved (2026-11-17). Pure, so admin (browser) and server
// share it. A Printeers product group is recognised by its catalog name, never by a stored ID, because the
// references differ per environment and API version:
//   v1 (test, derived from /stock attributes): "Hard case · Back printed · Transparent"
//   v2 (production product groups):            "Phone Hard cases (back printed, transparent)"
//
// - Hard case: printeers.com/products/back-printed-hard-cases, transparent only (never the black or white
//   insert, nor the fully printed hard case). Transparent is also the cheapest back-printed hard case.
// - Wallet case: printeers.com/products/fully-printed-wallet-cases (not the front-printed black wallet).
// - Soft case: printeers.com/products/soft-tpu-cases, transparent (the shop sells it as a clear case).
export type ApprovedPhoneCase = "hard" | "wallet" | "soft";

export const APPROVED_PHONE_CASES: Record<ApprovedPhoneCase, string> = {
  hard: "Hard case · back printed · transparent",
  wallet: "Wallet case · fully printed",
  soft: "Soft TPU case · back printed · transparent",
};

// MagSafe, hybrid, tough, bumper… are other case types that can share words with the approved ones.
const OTHER_TYPE = /magsafe|hybrid|tough|bumper|crossbody|biodegradable|card case|smart/i;
const OTHER_DEVICE = /\b(?:ipad|airpods|airtag|macbook|tablet)\b/i;

export function approvedPhoneCase(groupName: string | null | undefined): ApprovedPhoneCase | null {
  const name = (groupName || "").toLowerCase();
  if (!name || OTHER_TYPE.test(name) || OTHER_DEVICE.test(name)) return null;
  const has = (word: string) => new RegExp(`\\b${word}\\b`).test(name);
  if (has("hard") && has("back") && has("transparent") && !has("black") && !has("white") && !has("fully") && !has("front")) return "hard";
  if (has("wallet") && has("fully")) return "wallet";
  if (has("soft") && has("back") && has("transparent") && !has("black") && !has("white") && !has("front")) return "soft";
  return null;
}
