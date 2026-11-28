// Every way a payment succeeds records its environment (live / test), so a test payment is never taken for a
// real one (lib/pod/fulfillment.ts only prepares and sends print orders for payments of the site's own environment).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ paymentUpdates: [] as { data: Record<string, unknown> }[], background: [] as string[], event: null as Record<string, unknown> | null, orderStatus: "PENDING" }));

vi.mock("@/lib/server/prisma", () => {
  const order = () => ({ id: "o1", status: state.orderStatus, totalCents: 2250, currency: "eur", customerId: "c1", cartLineIds: [], discountUsages: [], items: [], payments: [{ id: "p1", provider: "paypal", stripeCheckoutId: "cs_1", status: "PENDING" }] });
  const tx = {
    stripeEvent: { create: async () => ({}) },
    order: { findUnique: async () => order(), updateMany: async () => { const claimed = state.orderStatus === "PENDING"; state.orderStatus = "PAID"; return { count: claimed ? 1 : 0 }; } },
    payment: { update: async (args: { data: Record<string, unknown> }) => { state.paymentUpdates.push(args); return {}; }, updateMany: async (args: { data: Record<string, unknown> }) => { state.paymentUpdates.push(args); return { count: 1 }; } },
    discount: { update: async () => ({}) },
    cartLine: { deleteMany: async () => ({ count: 0 }) },
  };
  return { prisma: {
    ...tx,
    payment: { ...tx.payment, findUnique: async () => ({ id: "p1", provider: "paypal", orderId: "o1", status: "PENDING", order: order() }) },
    order: { ...tx.order, findUniqueOrThrow: async () => ({ ...order(), status: state.orderStatus }) },
    $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
  } };
});
vi.mock("@/lib/server/stripe", () => ({ stripe: { webhooks: { constructEvent: () => state.event } } }));
vi.mock("@/lib/pod/fulfillment", () => ({ handlePaidOrderInBackground: (id: string) => { state.background.push(id); } }));
vi.mock("@/lib/server/order-email", () => ({ sendOrderConfirmationInBackground: () => undefined }));
vi.mock("@/lib/server/orders", () => ({ serializeOrder: (order: unknown) => order }));
vi.mock("@/lib/server/paypal", async (original) => ({
  ...(await original<typeof import("@/lib/server/paypal")>()),
  getPayPalOrder: async (id: string) => ({ id, status: "COMPLETED", purchase_units: [{ custom_id: "o1", payments: { captures: [{ id: "cap_1", status: "COMPLETED", amount: { currency_code: "EUR", value: "22.50" } }] } }] }),
}));

import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { reconcilePayPalPayment } from "@/lib/server/paypal-checkout";

const stripeEvent = (livemode: boolean, type = "checkout.session.completed") => ({ id: `evt_${livemode}`, type, livemode, data: { object: { id: "cs_1", metadata: { orderId: "o1" }, payment_status: "paid", amount_total: 2250, currency: "eur", payment_intent: "pi_1", livemode } } });
const deliver = () => stripeWebhook(new Request("https://shop.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=x" }, body: "{}" }) as never);

beforeEach(() => { state.paymentUpdates = []; state.background = []; state.orderStatus = "PENDING"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret"; });
afterEach(() => { delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.PAYPAL_MODE; });

describe("Stripe webhook", () => {
  it("records the environment of the signed event on the succeeded payment", async () => {
    state.event = stripeEvent(true);
    expect((await deliver()).status).toBe(200);
    expect(state.paymentUpdates[0].data).toMatchObject({ status: "SUCCEEDED", raw: { environment: "live" } });
    state.paymentUpdates = []; state.orderStatus = "PENDING";
    state.event = stripeEvent(false);
    await deliver();
    expect(state.paymentUpdates[0].data).toMatchObject({ status: "SUCCEEDED", raw: { environment: "test" } });
  });

  it("records it on failed / expired payments as well", async () => {
    state.event = stripeEvent(false, "checkout.session.expired");
    await deliver();
    expect(state.paymentUpdates[0].data).toMatchObject({ status: "CANCELLED", raw: { environment: "test" } });
  });
});

describe("PayPal capture", () => {
  it("records live for the live PayPal API and test for the sandbox", async () => {
    process.env.PAYPAL_MODE = "live";
    await reconcilePayPalPayment("PAYPAL-1");
    expect(state.paymentUpdates.at(-1)!.data).toMatchObject({ status: "SUCCEEDED", raw: { captureId: "cap_1", environment: "live" } });
    state.orderStatus = "PENDING";
    process.env.PAYPAL_MODE = "sandbox";
    await reconcilePayPalPayment("PAYPAL-1");
    expect(state.paymentUpdates.at(-1)!.data).toMatchObject({ status: "SUCCEEDED", raw: { environment: "test" } });
    expect(state.background).toEqual(["o1", "o1"]);
  });
});
