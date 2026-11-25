import Stripe from "stripe";

// The fallback is only a syntactically valid placeholder for module loading. It is
// never used for a request: assertStripeConfigured() fails before checkout starts.
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_unconfigured");

export function assertStripeConfigured() {
  const key = process.env.STRIPE_SECRET_KEY?.trim() || "";
  if (!key || key.includes("replace") || !/^(sk|rk)_/.test(key)) throw new Error("Stripe is not configured");
  if (process.env.VERCEL_ENV === "production" && !/^(sk|rk)_live_/.test(key)) throw new Error("A live Stripe secret key is required in Vercel Production");
  if (process.env.VERCEL_ENV !== "production" && /^(sk|rk)_live_/.test(key)) throw new Error("Local development cannot use a live Stripe secret key");
}
