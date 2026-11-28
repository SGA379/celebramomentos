// Whether a payment was taken with live (real money) or test (Stripe test mode / PayPal sandbox) credentials.
// Local development and production share one database, so every payment records its environment in
// Payment.raw.environment when it succeeds; print orders are only prepared and sent for payments of the
// site's own environment (lib/pod/fulfillment.ts). Anything uncertain counts as test: a payment is never
// treated as real money unless the payment provider said so.
import type { PodMode } from "@/lib/pod/types";

export type PaymentEnvironment = "live" | "test";

// Stripe marks every object with livemode (true only for live keys).
export const stripeEnvironment = (livemode: boolean | null | undefined): PaymentEnvironment => (livemode === true ? "live" : "test");

// PayPal: the API the capture was made with (PAYPAL_MODE; lib/server/paypal.ts allows "live" only in Vercel Production).
export const paypalEnvironment = (): PaymentEnvironment => ((process.env.PAYPAL_MODE || "").trim().toLowerCase() === "live" ? "live" : "test");

// The environment stored with a payment, or null for payments recorded before it was stored (2026-11-28).
export function recordedPaymentEnvironment(raw: unknown): PaymentEnvironment | null {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).environment : null;
  return value === "live" || value === "test" ? value : null;
}

// The payment environment a print-on-demand mode belongs to: live print orders for live payments, drafts for test ones.
export const paymentEnvironmentFor = (mode: PodMode): PaymentEnvironment => (mode === "live" ? "live" : "test");
