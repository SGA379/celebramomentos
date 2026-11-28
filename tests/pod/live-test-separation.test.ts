// Local development (test payments, draft print orders) and production (live payments, live print orders)
// share one database. A test order must never become a real, paid order at Gelato or Printful, every print
// order keeps the mode it was created in, the production cron only touches production print orders, and a
// test payment is never treated as a real paid order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db, adapter } = vi.hoisted(() => {
  type Row = Record<string, any>;
  const state = { orders: new Map<string, Row>(), fulfillments: new Map<string, Row>(), queries: [] as { model: string; where: Row }[] };
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === "object" && "increment" in value ? (row[key] || 0) + value.increment : value;
    row.updatedAt = new Date();
    return row;
  };
  const prisma = {
    order: {
      findUnique: vi.fn(async ({ where, select, include }: Row) => {
        const order = state.orders.get(where.id);
        if (!order) return null;
        if (select?.payments) return { status: order.status, payments: order.payments.filter((payment: Row) => payment.status === "SUCCEEDED") };
        if (include?.fulfillments) return { ...order, fulfillments: [...state.fulfillments.values()].filter((row) => row.orderId === order.id) };
        return order;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: Row) => ({ ...state.orders.get(where.id), items: [], fulfillments: [...state.fulfillments.values()].filter((row) => row.orderId === where.id) })),
      findMany: vi.fn(async ({ where }: Row) => { state.queries.push({ model: "order", where }); return []; }),
      update: vi.fn(),
    },
    podFulfillment: {
      findUnique: vi.fn(async ({ where, include }: Row) => {
        const row = state.fulfillments.get(where.id);
        if (!row) return null;
        return include ? { ...row, items: row.items, order: state.orders.get(row.orderId) } : row;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: Row) => state.fulfillments.get(where.id)),
      // The cron's queries: recorded, and filtered by mode / status like the database would.
      findMany: vi.fn(async ({ where }: Row) => {
        state.queries.push({ model: "podFulfillment", where });
        return [...state.fulfillments.values()].filter((row) => (!where.mode || row.mode === where.mode) && (!where.status || row.status === where.status) && (!where.OR || where.OR.some((clause: Row) => clause.status === row.status && (!clause.nextAttemptAt || row.nextAttemptAt <= clause.nextAttemptAt.lte))));
      }),
      // Conditional update = the submission lock (status, and mode when given).
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const row = state.fulfillments.get(where.id);
        if (!row || (where.status?.in && !where.status.in.includes(row.status)) || (where.mode && where.mode !== row.mode)) return { count: 0 };
        apply(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: Row) => apply(state.fulfillments.get(where.id)!, data)),
      create: vi.fn(),
    },
  };
  const podAdapter = { provider: "GELATO", configurationProblem: vi.fn(() => null as string | null), submit: vi.fn(), findByReference: vi.fn(async (): Promise<unknown> => null), fetchStatus: vi.fn(), cancel: vi.fn(), confirmDraft: vi.fn() };
  return { db: { state, prisma }, adapter: podAdapter };
});

vi.mock("@/lib/server/prisma", () => ({ prisma: db.prisma }));
vi.mock("@/lib/pod/providers", () => ({ podAdapter: () => adapter }));

import { cancelFulfillment, confirmDraft, orderPaymentState, prepareFulfillments, resendFulfillment, runPodMaintenance, submitFulfillment, unpreparedOrdersWhere } from "@/lib/pod/fulfillment";
import { paymentEnvironmentFor, paypalEnvironment, recordedPaymentEnvironment, stripeEnvironment } from "@/lib/server/payment-environment";

type Environment = "live" | "test" | null;
const payment = (environment: Environment) => ({ status: "SUCCEEDED", raw: environment ? { environment } : { sessionId: "cs_1" } });
const item = { id: "item1", name: "Póster", quantity: 1, podIssues: [], podArtwork: [{ unit: 0, productRef: "wall_hanging_poster_x", area: "default", url: "https://res.cloudinary.com/x/image/upload/a.jpg", source: "customer" }] };

function seed({ paidIn = "test" as Environment, mode = "draft", status = "READY", providerOrderId = null as string | null } = {}) {
  db.state.orders.clear();
  db.state.fulfillments.clear();
  db.state.queries = [];
  db.state.orders.set("o1", { id: "o1", number: "CM-1", status: "PAID", email: "a@b.c", shippingAddress: { recipient: "Ana", address: "Calle 1", city: "Madrid", postalCode: "28001", country: "ES" }, payments: [payment(paidIn)] });
  db.state.fulfillments.set("f1", { id: "f1", orderId: "o1", provider: "GELATO", status, mode, reference: "CM-1-GEL", attempts: 0, items: [item], shippingMethod: "standard", providerOrderId, providerStatus: providerOrderId ? "draft" : null });
}
// The site's environment: production is live (Vercel Production + POD_ORDER_MODE=live); local is draft.
const production = () => { process.env.VERCEL_ENV = "production"; process.env.POD_ORDER_MODE = "live"; };
const local = () => { delete process.env.VERCEL_ENV; process.env.POD_ORDER_MODE = "draft"; };

beforeEach(() => {
  vi.clearAllMocks();
  adapter.configurationProblem.mockReturnValue(null);
  adapter.findByReference.mockResolvedValue(null);
  adapter.submit.mockResolvedValue({ providerOrderId: "g-1", providerStatus: "created", status: "SUBMITTED" });
});
afterEach(() => { delete process.env.VERCEL_ENV; delete process.env.POD_ORDER_MODE; delete process.env.PAYPAL_MODE; });

describe("payment environment", () => {
  it("is live only when the payment provider says so", () => {
    expect(stripeEnvironment(true)).toBe("live");
    expect(stripeEnvironment(false)).toBe("test");
    expect(stripeEnvironment(undefined)).toBe("test");
    process.env.PAYPAL_MODE = "live";
    expect(paypalEnvironment()).toBe("live");
    process.env.PAYPAL_MODE = "sandbox";
    expect(paypalEnvironment()).toBe("test");
    delete process.env.PAYPAL_MODE;
    expect(paypalEnvironment()).toBe("test");
    expect(recordedPaymentEnvironment({ environment: "live" })).toBe("live");
    expect(recordedPaymentEnvironment({ environment: "LIVE" })).toBeNull();
    expect(recordedPaymentEnvironment({ sessionId: "cs_1" })).toBeNull();
    expect(recordedPaymentEnvironment(null)).toBeNull();
    expect(paymentEnvironmentFor("live")).toBe("live");
    expect(paymentEnvironmentFor("draft")).toBe("test");
  });

  it("classifies an order's payment against an environment", () => {
    const order = (environments: Environment[], status = "PAID") => ({ status, payments: environments.map(payment) });
    expect(orderPaymentState(order(["live"]), "live")).toBe("verified");
    expect(orderPaymentState(order(["test"]), "draft")).toBe("verified");
    expect(orderPaymentState(order(["test"]), "live")).toBe("other");
    expect(orderPaymentState(order(["live"]), "draft")).toBe("other");
    expect(orderPaymentState(order([null]), "live")).toBe("legacy");
    expect(orderPaymentState(order(["live"], "PENDING"), "live")).toBe("unpaid");
    expect(orderPaymentState({ status: "PAID", payments: [{ status: "FAILED", raw: { environment: "live" } }] }, "live")).toBe("unpaid");
    expect(orderPaymentState(null, "live")).toBe("unpaid");
  });
});

describe("a test order never reaches a live account", () => {
  it("production never sends a test (draft) print order, and leaves its mode as it was", async () => {
    production();
    seed({ paidIn: "test", mode: "draft", status: "READY" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("test (draft) print order") });
    db.state.fulfillments.get("f1")!.status = "FAILED";
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.findByReference).not.toHaveBeenCalled();
    expect(db.state.fulfillments.get("f1")).toMatchObject({ mode: "draft", attempts: 0 });
  });

  it("also when the test order was paid before payment environments were recorded", async () => {
    production();
    seed({ paidIn: null, mode: "draft", status: "READY" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false });
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("a live print order of an order paid in test mode is refused too", async () => {
    production();
    seed({ paidIn: "test", mode: "live", status: "READY" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("paid in the test payment environment") });
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("a test environment never sends (or cancels) a live print order", async () => {
    local();
    seed({ paidIn: "live", mode: "live", status: "READY" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("live print order") });
    db.state.fulfillments.get("f1")!.status = "SUBMITTED";
    db.state.fulfillments.get("f1")!.providerOrderId = "g-live";
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("only be cancelled from a live environment") });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.cancel).not.toHaveBeenCalled();
    expect(db.state.fulfillments.get("f1")).toMatchObject({ status: "SUBMITTED", mode: "live" });
  });

  it("a test draft is never confirmed into a real order", async () => {
    production();
    for (const paidIn of ["test", null] as Environment[]) {
      seed({ paidIn, mode: "draft", status: "SUBMITTED", providerOrderId: "g-draft" });
      expect(await confirmDraft("f1")).toMatchObject({ ok: false, message: expect.stringContaining("live payment") });
    }
    expect(adapter.confirmDraft).not.toHaveBeenCalled();
    // A draft of an order recorded as paid live can still be confirmed on purpose.
    seed({ paidIn: "live", mode: "draft", status: "SUBMITTED", providerOrderId: "g-draft" });
    adapter.confirmDraft.mockResolvedValueOnce({ providerOrderId: "g-draft", providerStatus: "created", status: "SUBMITTED" });
    expect(await confirmDraft("f1")).toMatchObject({ ok: true });
  });

  it("a test order is never resent as a live one", async () => {
    production();
    seed({ paidIn: "test", mode: "live", status: "FAILED", providerOrderId: "g-1" });
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("test payment environment") });
    seed({ paidIn: "test", mode: "draft", status: "FAILED", providerOrderId: "g-1" });
    expect(await resendFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("test (draft) print order") });
    expect(adapter.fetchStatus).not.toHaveBeenCalled();
    expect(adapter.submit).not.toHaveBeenCalled();
  });
});

describe("every print order keeps the mode it was created in", () => {
  it("a live print order of a live payment is sent as live, and sending does not rewrite its mode", async () => {
    production();
    seed({ paidIn: "live", mode: "live", status: "READY" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: true, status: "SUBMITTED" });
    expect(adapter.submit.mock.calls[0][0]).toMatchObject({ mode: "live", reference: "CM-1-GEL" });
    expect(db.state.fulfillments.get("f1")).toMatchObject({ mode: "live", providerOrderId: "g-1" });
    const lock = db.prisma.podFulfillment.updateMany.mock.calls.find(([args]) => args.data.status === "SUBMITTING")![0];
    expect(lock.where.mode).toBe("live");
    expect(lock.data).not.toHaveProperty("mode");
  });

  it("orders paid before environments were recorded keep working in their own mode (the existing live customer orders)", async () => {
    production();
    seed({ paidIn: null, mode: "live", status: "READY" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: true });
    local();
    seed({ paidIn: null, mode: "draft", status: "READY" });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: true });
    expect(adapter.submit.mock.calls.map(([input]) => input.mode)).toEqual(["live", "draft"]);
  });

  it("is not sent if its mode changes between the checks and the lock", async () => {
    production();
    seed({ paidIn: "live", mode: "live", status: "READY" });
    db.prisma.podFulfillment.findUnique.mockImplementationOnce(async () => {
      const row = db.state.fulfillments.get("f1")!;
      const snapshot = { ...row, items: row.items, order: db.state.orders.get("o1") };
      row.mode = "draft"; // changed by someone else after this read
      return snapshot;
    });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false, status: "SUBMITTING" });
    expect(adapter.submit).not.toHaveBeenCalled();
  });
});

describe("print orders are only created for payments of the site's environment", () => {
  it("production creates none for a test payment or a payment without a recorded environment", async () => {
    production();
    for (const paidIn of ["test", null] as Environment[]) {
      seed({ paidIn });
      db.state.fulfillments.clear();
      expect(await prepareFulfillments("o1")).toEqual([]);
    }
    expect(db.prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(db.prisma.podFulfillment.create).not.toHaveBeenCalled();
  });

  it("a test environment creates none for a live (real customer) payment", async () => {
    local();
    seed({ paidIn: "live" });
    db.state.fulfillments.clear();
    expect(await prepareFulfillments("o1")).toEqual([]);
    expect(db.prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("each environment prepares the orders paid in it", async () => {
    production();
    seed({ paidIn: "live" });
    db.state.fulfillments.clear();
    await prepareFulfillments("o1");
    local();
    seed({ paidIn: "test" });
    db.state.fulfillments.clear();
    await prepareFulfillments("o1");
    expect(db.prisma.order.findUniqueOrThrow).toHaveBeenCalledTimes(2);
  });
});

describe("the production cron only processes production print orders", () => {
  it("queries only live print orders and orders paid live, and never sends a due test order", async () => {
    production();
    // A test print order that failed and is due for a retry, as left by local development.
    seed({ paidIn: "test", mode: "draft", status: "FAILED" });
    db.state.fulfillments.get("f1")!.nextAttemptAt = new Date(Date.now() - 60_000);
    await runPodMaintenance({ budgetMs: 5_000 });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(db.state.fulfillments.get("f1")).toMatchObject({ status: "FAILED", mode: "draft" });
    const fulfillmentQueries = db.state.queries.filter((query) => query.model === "podFulfillment");
    expect(fulfillmentQueries).toHaveLength(4); // interrupted, unrendered, due, tracking
    for (const query of fulfillmentQueries) expect(query.where.mode).toBe("live");
    const [orders] = db.state.queries.filter((query) => query.model === "order");
    expect(orders.where).toEqual(unpreparedOrdersWhere("live"));
    expect(orders.where.payments.some).toMatchObject({ status: "SUCCEEDED", raw: { path: ["environment"], equals: "live" } });
  });

  it("retries a due live print order of a live payment", async () => {
    production();
    seed({ paidIn: "live", mode: "live", status: "FAILED" });
    db.state.fulfillments.get("f1")!.nextAttemptAt = new Date(Date.now() - 60_000);
    await runPodMaintenance({ budgetMs: 5_000 });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(adapter.submit.mock.calls[0][0].mode).toBe("live");
  });

  it("the test environment's cron leaves live print orders alone", async () => {
    local();
    seed({ paidIn: "live", mode: "live", status: "FAILED" });
    db.state.fulfillments.get("f1")!.nextAttemptAt = new Date(Date.now() - 60_000);
    await runPodMaintenance({ budgetMs: 5_000 });
    expect(adapter.submit).not.toHaveBeenCalled();
    for (const query of db.state.queries.filter((entry) => entry.model === "podFulfillment")) expect(query.where.mode).toBe("draft");
  });
});
