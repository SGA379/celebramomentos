import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the few Prisma calls the submission path makes.
const { db, adapter } = vi.hoisted(() => {
  type Row = Record<string, any>;
  const state = { orders: new Map<string, Row>(), fulfillments: new Map<string, Row>(), assets: [] as Row[], failNext: false };
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === "object" && "increment" in value ? (row[key] || 0) + value.increment : value;
    row.updatedAt = new Date();
    return row;
  };
  const prisma = {
    order: {
      findUnique: vi.fn(async ({ where, select, include }: Row) => {
        if (state.failNext) { state.failNext = false; throw new Error("database down"); }
        const order = state.orders.get(where.id);
        if (!order) return null;
        if (select?.payments) return { status: order.status, payments: order.payments.filter((payment: Row) => payment.status === "SUCCEEDED") };
        if (include?.fulfillments) return { ...order, fulfillments: [...state.fulfillments.values()].filter((item) => item.orderId === order.id) };
        return order;
      }),
      update: vi.fn(async ({ where, data }: Row) => apply(state.orders.get(where.id)!, data)),
    },
    podFulfillment: {
      findUnique: vi.fn(async ({ where, include }: Row) => {
        const row = state.fulfillments.get(where.id);
        if (!row) return null;
        return include ? { ...row, items: row.items, order: state.orders.get(row.orderId) } : row;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: Row) => state.fulfillments.get(where.id)),
      // Conditional update = the submission lock.
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const row = state.fulfillments.get(where.id);
        if (!row || (where.status?.in && !where.status.in.includes(row.status))) return { count: 0 };
        if (typeof where.status === "string" && where.status !== row.status) return { count: 0 };
        if ("providerOrderId" in where && (row.providerOrderId ?? null) !== where.providerOrderId) return { count: 0 };
        apply(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: Row) => apply(state.fulfillments.get(where.id)!, data)),
    },
    // Planning an item again (resend) reads its upload records and saves its print files.
    asset: { findMany: vi.fn(async () => state.assets) },
    orderItem: {
      update: vi.fn(async ({ where, data }: Row) => { for (const row of state.fulfillments.values()) for (const line of row.items) if (line.id === where.id) Object.assign(line, data); return {}; }),
      findMany: vi.fn(async ({ where }: Row) => state.fulfillments.get(where.podFulfillmentId)?.items ?? []),
    },
    payment: { update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  };
  const podAdapter = { provider: "GELATO", configurationProblem: vi.fn(() => null as string | null), submit: vi.fn(), findByReference: vi.fn(async (): Promise<unknown> => null), fetchStatus: vi.fn(), cancel: vi.fn() };
  return { db: { state, prisma }, adapter: podAdapter };
});

vi.mock("@/lib/server/prisma", () => ({ prisma: db.prisma }));
vi.mock("@/lib/pod/providers", () => ({ podAdapter: () => adapter }));

import * as fulfillmentModule from "@/lib/pod/fulfillment";
import { artworkProblems, cancelFulfillment, handlePaidOrder, resendFulfillment, submitFulfillment, syncFulfillment, syncOrderStatus, unexpectedCancellation } from "@/lib/pod/fulfillment";
import { PodApiError } from "@/lib/pod/http";

const item = { id: "item1", name: "Póster", quantity: 1, podIssues: [], podArtwork: [{ unit: 0, productRef: "wall_hanging_poster_x", area: "default", url: "https://res.cloudinary.com/x/image/upload/a.jpg", source: "customer" }] };

function seed({ paid = true, status = "READY", attempts = 0 } = {}) {
  db.state.orders.clear();
  db.state.fulfillments.clear();
  db.state.orders.set("o1", { id: "o1", number: "CM-1", status: paid ? "PAID" : "PENDING", email: "a@b.c", shippingAddress: { recipient: "Ana", address: "Calle 1", city: "Madrid", postalCode: "28001", country: "ES" }, payments: [{ status: paid ? "SUCCEEDED" : "PENDING" }] });
  db.state.fulfillments.set("f1", { id: "f1", orderId: "o1", provider: "GELATO", status, mode: "draft", reference: "CM-1-GEL", attempts, items: [item], shippingMethod: "standard" });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.POD_ORDER_MODE;
  adapter.configurationProblem.mockReturnValue(null);
  adapter.findByReference.mockResolvedValue(null);
});

describe("payment verification", () => {
  it("never sends an order whose payment is not verified", async () => {
    seed({ paid: false });
    const result = await submitFulfillment("f1");
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("payment") });
    expect(adapter.submit).not.toHaveBeenCalled();
  });
});

describe("duplicate prevention", () => {
  it("sends one order even when two triggers run at the same time", async () => {
    seed();
    adapter.submit.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { providerOrderId: "g1", providerStatus: "draft", status: "SUBMITTED" }; });
    const [first, second] = await Promise.all([submitFulfillment("f1"), submitFulfillment("f1")]);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(db.state.fulfillments.get("f1")).toMatchObject({ status: "SUBMITTED", providerOrderId: "g1", attempts: 1 });
  });

  it("does not send again once the order is with the print shop", async () => {
    seed({ status: "SUBMITTED" });
    expect((await submitFulfillment("f1")).ok).toBe(false);
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("looks the order up before retrying, in case the last attempt reached the shop", async () => {
    seed({ status: "FAILED", attempts: 1 });
    adapter.findByReference.mockResolvedValue({ providerOrderId: "g-existing", providerStatus: "created", status: "SUBMITTED" });
    const result = await submitFulfillment("f1");
    expect(result.ok).toBe(true);
    expect(adapter.findByReference).toHaveBeenCalledWith("CM-1-GEL", "draft");
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(db.state.fulfillments.get("f1")?.providerOrderId).toBe("g-existing");
  });
});

describe("failures", () => {
  it("keeps a temporarily failed order and schedules a retry", async () => {
    seed();
    adapter.submit.mockRejectedValue(new PodApiError("GELATO", 503, "GELATO answered HTTP 503", true));
    const result = await submitFulfillment("f1");
    const row = db.state.fulfillments.get("f1")!;
    expect(result).toMatchObject({ ok: false, status: "FAILED" });
    expect(row.lastError).toContain("503");
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("does not retry automatically when the request itself is wrong", async () => {
    seed();
    adapter.submit.mockRejectedValue(new PodApiError("GELATO", 400, "GELATO answered HTTP 400: invalid productUid", false));
    await submitFulfillment("f1");
    expect(db.state.fulfillments.get("f1")).toMatchObject({ status: "FAILED", nextAttemptAt: null });
  });

  it("holds the order when the print shop is not configured", async () => {
    seed();
    adapter.configurationProblem.mockReturnValue("GELATO_API_KEY is not set");
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false, status: "NEEDS_ATTENTION" });
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("never throws into the payment flow", async () => {
    seed();
    db.state.failNext = true;
    await expect(handlePaidOrder("o1")).resolves.toBeUndefined();
  });
});

describe("order status", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("ignores print orders of the other environment (a live shop is not moved by test print orders)", async () => {
    vi.stubEnv("POD_ORDER_MODE", "live");
    seed({ status: "SHIPPED" });
    await syncOrderStatus("o1");
    expect(db.state.orders.get("o1")?.status).toBe("PAID");
  });

  it("marks the order shipped when every print order of the environment shipped (test orders while testing)", async () => {
    seed({ status: "SHIPPED" });
    await syncOrderStatus("o1");
    expect(db.state.orders.get("o1")?.status).toBe("SHIPPED");
  });

  it("marks the order shipped when every live print order shipped, in a live shop", async () => {
    vi.stubEnv("POD_ORDER_MODE", "live");
    seed({ status: "SHIPPED" });
    db.state.fulfillments.get("f1")!.mode = "live";
    await syncOrderStatus("o1");
    expect(db.state.orders.get("o1")?.status).toBe("SHIPPED");
  });
});

describe("print files", () => {
  const card = (verified: { width: number; height: number } | null, url: string | null = "https://res.cloudinary.com/x/image/upload/strip.jpg") => ({ unit: 0, productRef: "CLASSIC-GRE-FEDR-7X5-BLA", area: "default", url, source: "design" as const, kind: "pages" as const, width: 6120, height: 2160, format: "jpg" as const, verified });

  it("never sends a card print file that is not exactly the size Prodigi requires", async () => {
    seed({ status: "READY" });
    db.state.fulfillments.get("f1")!.items = [{ ...item, podArtwork: [card({ width: 3260, height: 2160 })] }];
    const result = await submitFulfillment("f1");
    expect(result).toMatchObject({ ok: false, status: "NEEDS_ATTENTION", message: expect.stringContaining("3260 × 2160 px; 6120 × 2160 px is required") });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(db.state.fulfillments.get("f1")?.status).toBe("NEEDS_ATTENTION");
  });

  it("sends it when the verified size matches", async () => {
    seed({ status: "READY" });
    db.state.fulfillments.get("f1")!.items = [{ ...item, podArtwork: [card({ width: 6120, height: 2160 })] }];
    adapter.submit.mockResolvedValue({ providerOrderId: "ord_1", providerStatus: "InProgress", status: "SUBMITTED" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: true, status: "SUBMITTED" });
    expect(adapter.submit.mock.calls[0][0].lines[0].files).toEqual([{ area: "default", url: "https://res.cloudinary.com/x/image/upload/strip.jpg", source: "design" }]);
  });

  it("reports missing and unverified files", () => {
    expect(artworkProblems([card(null, null)])).toEqual(["Print file 1 (default) is missing"]);
    expect(artworkProblems([card(null)])).toEqual(["Print file 1 (default): its pixel size was not verified"]);
    expect(artworkProblems([card({ width: 6120, height: 2160 })])).toEqual([]);
    // A photo sent as the customer uploaded it has no fixed size.
    expect(artworkProblems([{ unit: 0, productRef: "x", area: "default", url: "https://x/a.jpg", source: "design", fit: "original", width: 10, height: 10, verified: null }])).toEqual([]);
  });

  it("has no way to set a print order's status by hand", () => {
    expect("markFulfillment" in fulfillmentModule).toBe(false);
  });
});

describe("cancelling a print order", () => {
  it("marks one never sent as cancelled without calling the print shop", async () => {
    seed({ status: "NEEDS_ATTENTION" });
    adapter.cancel.mockClear();
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(adapter.cancel).not.toHaveBeenCalled();
    // A cancelled print order is never sent afterwards.
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false });
  });

  it("cancels a sent one at the print shop", async () => {
    seed({ status: "SUBMITTED" });
    db.state.fulfillments.get("f1")!.providerOrderId = "g-1";
    adapter.cancel.mockResolvedValueOnce({ providerOrderId: "g-1", providerStatus: "draft deleted", status: "CANCELLED" });
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(adapter.cancel).toHaveBeenCalledWith("g-1", "draft");
  });

  it("reports the print shop's refusal and keeps the order as it was", async () => {
    seed({ status: "IN_PRODUCTION" });
    db.state.fulfillments.get("f1")!.providerOrderId = "g-1";
    adapter.cancel.mockRejectedValueOnce(new PodApiError("GELATO", 409, "Gelato did not cancel the order (status: printed)", false));
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: false, status: "IN_PRODUCTION", message: expect.stringContaining("printed") });
    expect(db.state.fulfillments.get("f1")!.status).toBe("IN_PRODUCTION");
  });

  it("refuses shipped orders and one being sent right now", async () => {
    seed({ status: "SHIPPED" });
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("shipped") });
    seed({ status: "SUBMITTING" });
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("being sent") });
  });
});

// ── Print shop failures after the order was accepted (Gelato, Nov 2026) ──────────

describe("a print order the print shop cancels on its own", () => {
  it("is recorded as failed, not as a deliberate cancellation", () => {
    const state = { providerOrderId: "g", providerStatus: "canceled", status: "CANCELLED" as const, problem: "Gelato's reason: Can't process print file" };
    expect(unexpectedCancellation("SUBMITTED", state, "Gelato", false)).toMatchObject({ status: "FAILED", problem: expect.stringContaining("Can't process print file") });
    expect(unexpectedCancellation("FAILED", state, "Gelato", false)?.status).toBe("FAILED");
    // Cancelled by an admin here, or already cancelled: kept as cancelled.
    expect(unexpectedCancellation("SUBMITTED", state, "Gelato", true)).toBeNull();
    expect(unexpectedCancellation("CANCELLED", state, "Gelato", false)).toBeNull();
    expect(unexpectedCancellation("SUBMITTED", { ...state, status: "SHIPPED" }, "Gelato", false)).toBeNull();
  });

  it("no longer lets the customer's order show shipped when another shop shipped its part", async () => {
    // CM-1795560274677: the Prodigi part shipped, Gelato failed the calendar file and then cancelled it.
    seed({ status: "SUBMITTED" });
    process.env.POD_ORDER_MODE = "live";
    db.state.orders.get("o1")!.status = "PROCESSING";
    Object.assign(db.state.fulfillments.get("f1")!, { mode: "live", providerOrderId: "g-1" });
    db.state.fulfillments.set("f2", { id: "f2", orderId: "o1", provider: "PRODIGI", status: "SHIPPED", mode: "live", reference: "CM-1-PRD", attempts: 1, items: [], providerOrderId: "p-1" });
    adapter.fetchStatus.mockResolvedValueOnce({ providerOrderId: "g-1", providerStatus: "canceled", status: "CANCELLED", problem: "Gelato's reason: Can't process print file item #x" });
    expect(await syncFulfillment("f1")).toMatchObject({ ok: true, status: "FAILED" });
    expect(db.state.fulfillments.get("f1")!.lastError).toMatch(/not produced.*Can't process print file/);
    expect(db.state.orders.get("o1")!.status).toBe("PROCESSING");
  });

  it("is still cancelled for good when an admin cancels it here", async () => {
    seed({ status: "SUBMITTED" });
    db.state.fulfillments.get("f1")!.providerOrderId = "g-1";
    adapter.cancel.mockResolvedValueOnce({ providerOrderId: "g-1", providerStatus: "canceled", status: "CANCELLED" });
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: true, status: "CANCELLED" });
  });

  it("closes a Gelato order Gelato already failed and stopped charging without asking Gelato to cancel it", async () => {
    seed({ status: "FAILED" });
    db.state.fulfillments.get("f1")!.providerOrderId = "g-1";
    adapter.fetchStatus.mockResolvedValueOnce({ providerOrderId: "g-1", providerStatus: "failed", status: "FAILED", raw: { financialStatus: "canceled" } });
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(adapter.cancel).not.toHaveBeenCalled();
  });
});

describe("retrying and resending after the print shop failed an order", () => {
  const photo = "https://res.cloudinary.com/x/image/upload/v1/poster.jpg";
  const posterItem = () => ({
    id: "item1", orderId: "o1", name: "Póster", quantity: 1, variantId: null, createdAt: new Date("2026-11-25T12:00:00Z"), podIssues: [], podProductRef: "wall_hanging_poster_x",
    personalization: { product: { kind: "CATALOG", productKind: "WALL_ART", provider: "GELATO", sku: "wall_hanging_poster_x", photos: [photo], options: {} } },
    // Made and verified when the order was first sent: reused, not made again.
    podArtwork: [{ kind: "photo", unit: 0, productRef: "wall_hanging_poster_x", area: "default", url: "https://res.cloudinary.com/x/image/upload/print.jpg", source: "design", format: "jpg", fit: "original", original: photo, verified: { width: 3000, height: 4000 } }],
  });
  const failedAtGelato = (raw: Record<string, unknown> = { financialStatus: "canceled" }) => ({ providerOrderId: "g-1", providerStatus: "failed", status: "FAILED" as const, problem: "Gelato reports the order failed: Can't process print file", raw });

  function seedFailed({ status = "FAILED", mode = "live", reference = "CM-1-GEL" } = {}) {
    seed({ status, attempts: 1 });
    process.env.POD_ORDER_MODE = mode;
    db.state.assets = [{ url: photo, kind: "CUSTOMER_UPLOAD", mimeType: "image/jpeg", metadata: { width: 3000, height: 4000 } }];
    Object.assign(db.state.fulfillments.get("f1")!, { mode, reference, providerOrderId: "g-1", providerStatus: "failed", lastError: "Gelato reports the order failed", items: [posterItem()] });
  }
  // podMode() is "draft" outside Vercel production; "live" here is a fulfilment created by production.
  const runAsProduction = () => { process.env.VERCEL_ENV = "production"; };
  afterEach(() => { delete process.env.VERCEL_ENV; db.state.assets = []; });

  it("“Retry” never re-sends under the reference the shop already used", async () => {
    seedFailed({ mode: "draft" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("Resend as new order") });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.findByReference).not.toHaveBeenCalled();
  });

  it("resends as a NEW order with a new reference once the previous one is dead at the shop, without touching the payment", async () => {
    seedFailed({ mode: "live" });
    runAsProduction();
    process.env.POD_ORDER_MODE = "live";
    adapter.fetchStatus.mockResolvedValueOnce(failedAtGelato());
    adapter.submit.mockResolvedValueOnce({ providerOrderId: "g-2", providerStatus: "created", status: "SUBMITTED" });
    const result = await resendFulfillment("f1");
    expect(result).toMatchObject({ ok: true, status: "SUBMITTED" });
    expect(adapter.fetchStatus).toHaveBeenCalledWith("g-1", "live");
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(adapter.submit.mock.calls[0][0]).toMatchObject({ reference: "CM-1-GEL-R2", mode: "live" });
    // Resent with no lookup of the new reference (attempt 1) and recorded in the history.
    expect(adapter.findByReference).not.toHaveBeenCalled();
    const row = db.state.fulfillments.get("f1")!;
    expect(row).toMatchObject({ status: "SUBMITTED", providerOrderId: "g-2", reference: "CM-1-GEL-R2" });
    expect(JSON.stringify(row.tracking)).toContain("Resent as CM-1-GEL-R2: Gelato order g-1 (failed) was not produced");
    // The payment is only read: never charged, refunded or changed.
    expect(db.prisma.payment.update).not.toHaveBeenCalled();
    expect(db.prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(db.prisma.payment.create).not.toHaveBeenCalled();
    expect(db.prisma.order.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "REFUNDED" }) }));
  });

  it("numbers further resends -R3, -R4…", async () => {
    seedFailed({ mode: "live", reference: "CM-1-GEL-R2" });
    runAsProduction();
    process.env.POD_ORDER_MODE = "live";
    adapter.fetchStatus.mockResolvedValueOnce(failedAtGelato());
    adapter.submit.mockResolvedValueOnce({ providerOrderId: "g-3", providerStatus: "created", status: "SUBMITTED" });
    await resendFulfillment("f1");
    expect(adapter.submit.mock.calls[0][0].reference).toBe("CM-1-GEL-R3");
  });

  it("resends once when clicked twice at the same time", async () => {
    seedFailed({ mode: "live" });
    runAsProduction();
    process.env.POD_ORDER_MODE = "live";
    adapter.fetchStatus.mockResolvedValue(failedAtGelato());
    adapter.submit.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { providerOrderId: "g-2", providerStatus: "created", status: "SUBMITTED" }; });
    const results = await Promise.all([resendFulfillment("f1"), resendFulfillment("f1")]);
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    adapter.fetchStatus.mockReset();
    adapter.submit.mockReset();
  });

  it("refuses while the previous order may still be produced (never two orders for the same items)", async () => {
    seedFailed({ mode: "live" });
    runAsProduction();
    process.env.POD_ORDER_MODE = "live";
    // Gelato failed it but has not stopped charging: it is asked to cancel it first, and refuses.
    adapter.fetchStatus.mockResolvedValueOnce(failedAtGelato({ financialStatus: "pending" }));
    adapter.cancel.mockRejectedValueOnce(new PodApiError("GELATO", 409, "Gelato did not cancel the order (status: in_production)", false));
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("nothing was resent") });
    // The shop says it is in production after all.
    adapter.fetchStatus.mockResolvedValueOnce({ providerOrderId: "g-1", providerStatus: "in_production", status: "IN_PRODUCTION" });
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("may still be produced") });
    // The shop cannot be reached.
    adapter.fetchStatus.mockRejectedValueOnce(new PodApiError("GELATO", null, "GELATO could not be reached", true));
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("nothing was resent") });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(db.state.fulfillments.get("f1")).toMatchObject({ status: "FAILED", providerOrderId: "g-1", reference: "CM-1-GEL" });
  });

  it("refuses unpaid orders, shipped ones, ones never accepted by the shop, and a test order in a live shop", async () => {
    seedFailed({ mode: "live" });
    runAsProduction();
    process.env.POD_ORDER_MODE = "live";
    db.state.orders.get("o1")!.payments = [{ status: "REFUNDED" }];
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("payment") });

    seedFailed({ mode: "live" });
    db.state.fulfillments.get("f1")!.shippedAt = new Date();
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("never shipped") });

    seedFailed({ mode: "live" });
    db.state.fulfillments.get("f1")!.providerOrderId = null;
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("Retry now") });

    // A draft (test-paid) order is never resent as a real one.
    seedFailed({ mode: "draft" });
    runAsProduction();
    process.env.POD_ORDER_MODE = "live";
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("draft") });
    expect(adapter.fetchStatus).not.toHaveBeenCalled();
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("keeps a provider-failed print order failed when an admin checks it again (the cron cannot pick it up)", async () => {
    seedFailed({ mode: "draft" });
    const { refreshReadiness } = await import("@/lib/pod/fulfillment");
    await refreshReadiness("f1", { replan: true });
    expect(db.state.fulfillments.get("f1")).toMatchObject({ status: "FAILED", providerOrderId: "g-1" });
  });
});
