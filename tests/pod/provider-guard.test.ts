// Gelato and Printful have no test account: local / preview environments use the same live accounts. Nothing
// outside the production deployment may create, confirm, cancel or change anything there, and local testing
// must not change live print orders in the shared database. Real adapters, network stubbed and recorded.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => {
  type Row = Record<string, any>;
  const state = { orders: new Map<string, Row>(), fulfillments: new Map<string, Row>(), writes: [] as string[] };
  const apply = (row: Row, data: Row) => { for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === "object" && "increment" in value ? (row[key] || 0) + value.increment : value; return row; };
  const prisma = {
    order: {
      findUnique: vi.fn(async ({ where, select, include }: Row) => {
        const order = state.orders.get(where.id);
        if (!order) return null;
        if (select?.payments) return { status: order.status, payments: order.payments };
        if (include?.fulfillments) return { ...order, fulfillments: [...state.fulfillments.values()].filter((row) => row.orderId === order.id) };
        return order;
      }),
      update: vi.fn(async () => { state.writes.push("order.update"); return {}; }),
    },
    podFulfillment: {
      findUnique: vi.fn(async ({ where, include }: Row) => { const row = state.fulfillments.get(where.id); return row && include ? { ...row, items: row.items, order: state.orders.get(row.orderId) } : row ?? null; }),
      findUniqueOrThrow: vi.fn(async ({ where }: Row) => state.fulfillments.get(where.id)),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const row = state.fulfillments.get(where.id);
        if (!row || (where.status?.in && !where.status.in.includes(row.status)) || (where.mode && where.mode !== row.mode)) return { count: 0 };
        state.writes.push("podFulfillment.updateMany"); apply(row, data); return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: Row) => { state.writes.push("podFulfillment.update"); return apply(state.fulfillments.get(where.id)!, data); }),
    },
    orderItem: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "item1", podFulfillmentId: "f1", podArtwork: [] })),
      update: vi.fn(async () => { state.writes.push("orderItem.update"); return {}; }),
    },
  };
  return { db: { state, prisma } };
});
vi.mock("@/lib/server/prisma", () => ({ prisma: db.prisma }));

import { PodApiError } from "@/lib/pod/http";
import { assertProviderRequestAllowed, isDryRunOrder, isReadOnlyRequest, providerWritesAllowed } from "@/lib/pod/provider-guard";
import { gelatoAdapter } from "@/lib/pod/providers/gelato";
import { printfulAdapter, registerPrintfulWebhook } from "@/lib/pod/providers/printful";
import { attachPrintFile, cancelFulfillment, refreshReadiness, submitFulfillment, syncFulfillment } from "@/lib/pod/fulfillment";
import type { SubmissionInput } from "@/lib/pod/types";

type Call = { url: string; method: string };
const calls: Call[] = [];
// Network stub: records every request and answers like the provider would.
const network = vi.fn(async (url: string, init: RequestInit = {}) => {
  const method = (init.method || "GET").toUpperCase();
  calls.push({ url, method });
  if (url.endsWith("/v4/orders:quote")) return Response.json({ quotes: [{ products: [{ itemReferenceId: "item1", price: 16.56, currency: "EUR" }] }] });
  if (url.endsWith("/orders/estimate-costs")) return Response.json({ result: { costs: { currency: "EUR", total: 14.91 } } });
  if (url.endsWith("/v4/orders") && method === "POST") return Response.json({ id: "g-real", orderType: "order", fulfillmentStatus: "created" });
  if (url.includes("api.printful.com/orders?confirm=")) return Response.json({ result: { id: 991, status: "pending" } });
  if (url.includes("order.gelatoapis.com/v4/orders/")) return Response.json({ id: "g-real", orderType: "order", fulfillmentStatus: "created" });
  return Response.json({ result: { id: 991, status: "pending" } });
});
// Every request made must be a read (or a read-only POST: quote, cost estimate, search).
const onlyReads = () => calls.every((call) => isReadOnlyRequest(call.url.includes("gelatoapis") ? "GELATO" : "PRINTFUL", call.method, new URL(call.url).pathname));

const input = (mode: "draft" | "live"): SubmissionInput => ({
  reference: "CM-9-GEL", orderNumber: "CM-9", mode, shipping: "standard",
  recipient: { name: "Ana García", email: "ana@example.com", phone: "600000000", address1: "Calle Mayor 1", address2: null, city: "Madrid", postalCode: "28001", countryCode: "ES", state: null },
  lines: [{ itemId: "item1", productRef: "wall_hanging_poster_x", quantity: 1, name: "Póster", files: [{ area: "default", url: "https://res.cloudinary.com/x/image/upload/a.jpg", source: "design" }] }],
});

const environments = {
  local: { POD_ORDER_MODE: "draft" },
  localClaimingLive: { POD_ORDER_MODE: "live" },
  preview: { VERCEL_ENV: "preview", POD_ORDER_MODE: "live" },
  productionWithoutMode: { VERCEL_ENV: "production" },
  production: { VERCEL_ENV: "production", POD_ORDER_MODE: "live" },
} as const;
const use = (name: keyof typeof environments) => { delete process.env.VERCEL_ENV; delete process.env.POD_ORDER_MODE; Object.assign(process.env, environments[name]); };

const saved = { ...process.env };
beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", network);
  Object.assign(process.env, { GELATO_API_KEY: "gelato-key", PRINTFUL_PRIVATE_TOKEN: "pf-token", PRINTFUL_STORE_ID: "18975889" });
  db.state.writes = [];
});
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

describe("who may change the Gelato / Printful accounts", () => {
  it("only the production deployment, in live mode set explicitly", () => {
    for (const name of ["local", "localClaimingLive", "preview", "productionWithoutMode"] as const) { use(name); expect(providerWritesAllowed(), name).toBe(false); }
    use("production");
    expect(providerWritesAllowed()).toBe(true);
  });

  it("allows reads and the read-only checks everywhere, nothing else outside production", () => {
    use("local");
    for (const [provider, method, path] of [["GELATO", "GET", "/v4/orders/g1"], ["GELATO", "POST", "/v4/orders:search"], ["GELATO", "POST", "/v4/orders:quote"], ["PRINTFUL", "GET", "/orders/@CM-1"], ["PRINTFUL", "POST", "/orders/estimate-costs"]] as const) {
      expect(() => assertProviderRequestAllowed(provider, method, path)).not.toThrow();
    }
    for (const [provider, method, path] of [["GELATO", "POST", "/v4/orders"], ["GELATO", "PATCH", "/v4/orders/g1"], ["GELATO", "DELETE", "/v4/orders/g1"], ["GELATO", "POST", "/v4/orders/g1:cancel"], ["PRINTFUL", "POST", "/orders?confirm=false"], ["PRINTFUL", "POST", "/orders/1/confirm"], ["PRINTFUL", "DELETE", "/orders/1"], ["PRINTFUL", "PUT", "/orders/1"], ["PRINTFUL", "POST", "/webhooks"], ["PRINTFUL", "DELETE", "/webhooks"]] as const) {
      expect(() => assertProviderRequestAllowed(provider, method, path)).toThrow(PodApiError);
    }
  });
});

describe.each(["local", "preview", "localClaimingLive"] as const)("a %s environment never changes a provider account", (name) => {
  beforeEach(() => use(name));

  it("Gelato: a submission is only a quote (dry run); confirm and cancel of a real order are blocked before sending", async () => {
    const state = await gelatoAdapter().submit(input(name === "local" ? "draft" : "live"));
    expect(state).toMatchObject({ providerOrderId: "dryrun_CM-9-GEL", status: "SUBMITTED" });
    await expect(gelatoAdapter().confirmDraft!("g-real")).rejects.toThrow(/not the production site/);
    await expect(gelatoAdapter().cancel("g-real", "live")).rejects.toThrow(/not the production site/);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["POST /v4/orders:quote", "GET /v4/orders/g-real"]);
    expect(onlyReads()).toBe(true);
  });

  it("Printful: a submission is only a cost estimate (dry run); confirm, cancel and webhook setup are blocked before sending", async () => {
    const state = await printfulAdapter().submit(input(name === "local" ? "draft" : "live"));
    expect(state).toMatchObject({ providerOrderId: "dryrun_CM-9-GEL", status: "SUBMITTED", raw: { dryRun: true } });
    await expect(printfulAdapter().confirmDraft!("991")).rejects.toThrow(/not the production site/);
    await expect(printfulAdapter().cancel("991", "live")).rejects.toThrow(/not the production site/);
    await expect(registerPrintfulWebhook("https://www.celebra-momentos.com/api/webhooks/printful?token=x")).rejects.toThrow(/not the production site/);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["POST /orders/estimate-costs"]);
    expect(onlyReads()).toBe(true);
  });
});

describe("dry-run orders", () => {
  it("are never looked up, confirmed or cancelled at the provider, in any environment", async () => {
    for (const name of ["local", "production"] as const) {
      use(name);
      for (const adapter of [gelatoAdapter(), printfulAdapter()]) {
        expect(await adapter.fetchStatus("dryrun_CM-9-GEL", "draft")).toMatchObject({ status: "SUBMITTED", providerStatus: expect.stringContaining("dry run") });
        expect(await adapter.cancel("dryrun_CM-9-GEL", "draft")).toMatchObject({ status: "CANCELLED" });
        await expect(adapter.confirmDraft!("dryrun_CM-9-GEL")).rejects.toThrow(/dry-run order/);
      }
    }
    expect(calls).toHaveLength(0);
    expect(isDryRunOrder("dryrun_x")).toBe(true);
    expect(isDryRunOrder("g-1")).toBe(false);
  });
});

describe("the production deployment still sends real orders", () => {
  it("Gelato creates the order, Printful creates and confirms it", async () => {
    use("production");
    expect(await gelatoAdapter().submit(input("live"))).toMatchObject({ providerOrderId: "g-real" });
    expect(await printfulAdapter().submit(input("live"))).toMatchObject({ providerOrderId: "991" });
    expect(calls.map((call) => `${call.method} ${call.url.replace(/^https:\/\/[^/]+/, "")}`)).toEqual(["POST /v4/orders", "POST /orders?confirm=true"]);
  });
});

describe("local testing end to end (real adapters, shared database)", () => {
  const seed = (mode: "draft" | "live", environment: "test" | "live", status = "READY", providerOrderId: string | null = null) => {
    db.state.orders.set("o1", { id: "o1", number: "CM-9", status: "PAID", email: "ana@example.com", shippingAddress: { recipient: "Ana García", address: "Calle Mayor 1", city: "Madrid", postalCode: "28001", country: "ES" }, payments: [{ status: "SUCCEEDED", raw: { environment } }] });
    db.state.fulfillments.set("f1", { id: "f1", orderId: "o1", provider: "GELATO", status, mode, reference: "CM-9-GEL", attempts: 0, items: [{ id: "item1", name: "Póster", quantity: 1, podIssues: [], podArtwork: [{ unit: 0, productRef: "wall_hanging_poster_x", area: "default", url: "https://res.cloudinary.com/x/image/upload/a.jpg", source: "design" }] }], shippingMethod: "standard", providerOrderId, tracking: null });
  };

  it("a local test order is validated by a quote and stored as a dry run: nothing is created at Gelato", async () => {
    use("local");
    seed("draft", "test");
    expect(await submitFulfillment("f1")).toMatchObject({ ok: true, status: "SUBMITTED" });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["POST /v4/orders:quote"]);
    expect(db.state.fulfillments.get("f1")).toMatchObject({ status: "SUBMITTED", mode: "draft", providerOrderId: "dryrun_CM-9-GEL" });
    // Cancelling it locally never reaches Gelato either.
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(calls).toHaveLength(1);
  });

  it("a local environment cannot cancel a real Gelato draft created before this change", async () => {
    use("local");
    seed("draft", "test", "SUBMITTED", "g-old-draft");
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("not the production site") });
    expect(onlyReads()).toBe(true);
    expect(db.state.fulfillments.get("f1")).toMatchObject({ status: "SUBMITTED", providerOrderId: "g-old-draft" });
  });

  it("a local environment changes nothing about a live print order in the shared database", async () => {
    use("local");
    seed("live", "live", "SUBMITTED", "g-live");
    expect(await syncFulfillment("f1")).toMatchObject({ ok: false, message: expect.stringContaining("only updated by a live environment") });
    expect(await cancelFulfillment("f1")).toMatchObject({ ok: false });
    expect(await submitFulfillment("f1")).toMatchObject({ ok: false });
    db.state.fulfillments.get("f1")!.status = "FAILED";
    await refreshReadiness("f1", { replan: true });
    await expect(attachPrintFile("item1", { unit: 0, area: "default", url: "https://res.cloudinary.com/x/image/upload/b.jpg" })).rejects.toThrow(/only be changed from a live environment/);
    expect(calls).toHaveLength(0);
    expect(db.state.writes).toEqual([]);
    expect(db.state.fulfillments.get("f1")).toMatchObject({ mode: "live", providerOrderId: "g-live", status: "FAILED" });
  });
});
