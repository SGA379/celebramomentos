// Gelato Order API v4 — https://dashboard.gelato.com/docs/
// Auth: X-API-KEY. Base: https://order.gelatoapis.com. Draft mode creates
// `orderType: "draft"` orders, which Gelato neither produces nor charges.
import { gelatoConfig } from "../config";
import { PodApiError, podRequest, type FetchLike } from "../http";
import { assertProviderRequestAllowed, DRY_RUN_PREFIX, isDryRunOrder, providerWritesAllowed } from "../provider-guard";
import { httpsLink, isoDate, primaryShipment, type Shipment, type ShipmentStatus, type TrackingInfo } from "../tracking";
import type { PodAdapter, PodFulfillmentStatus, ProviderOrderState, SubmissionInput } from "../types";

type GelatoFulfillment = { trackingCode?: string; trackingUrl?: string; shipmentMethodName?: string; fulfillmentStatus?: string; fulfillmentCountry?: string };
type GelatoPackage = { id?: string; trackingCode?: string; trackingUrl?: string; orderItemIds?: string[] };
type GelatoOrder = {
  id: string;
  orderReferenceId?: string;
  orderType?: string;
  fulfillmentStatus?: string;
  financialStatus?: string;
  shippedAt?: string | null;
  expectedDispatchDate?: string | null;
  // Why Gelato refused the order / an item (e.g. "Can't process print file item #… - PDFToolBox failed: …").
  refusalReason?: string | null;
  items?: { id?: string; itemReferenceId?: string; fulfillmentStatus?: string; refusalReason?: string | null; fulfillments?: GelatoFulfillment[] | null }[];
  shipment?: { id?: string; shipmentMethodName?: string | null; minDeliveryDate?: string | null; maxDeliveryDate?: string | null; fulfillmentCountry?: string | null; packages?: GelatoPackage[] | null } | null;
};

export type GelatoApiHealth = {
  state: "connected" | "not_configured" | "unavailable";
  detail: string;
};

const STATUS: [RegExp, PodFulfillmentStatus][] = [
  [/cancel/, "CANCELLED"],
  [/^failed$/, "FAILED"],
  [/delivered/, "DELIVERED"],
  [/partial/, "IN_PRODUCTION"],
  [/shipped|in_transit/, "SHIPPED"],
  [/printed|in_production|production/, "IN_PRODUCTION"],
];

// Order states that need someone to look at the order in Gelato.
const PROBLEM: Record<string, string> = {
  failed: "Gelato reports the order failed: open it in the Gelato dashboard to see why",
  on_hold: "Gelato put the order on hold: open it in the Gelato dashboard to see why",
  not_connected: "Gelato could not route the order to a production partner",
  returned: "Gelato reports the parcel was returned to sender",
};

const shipmentState = (value: string | undefined): ShipmentStatus | null => {
  const text = (value || "").toLowerCase();
  if (/cancel/.test(text)) return "cancelled";
  if (/returned/.test(text)) return "returned";
  if (/delivered/.test(text)) return "delivered";
  if (/in_transit/.test(text)) return "in_transit";
  if (/shipped/.test(text)) return "shipped";
  return null;
};

// Gelato shipments: the order's `shipment` (method, delivery window, packages with tracking and the Gelato
// item ids they hold) and, in webhook-shaped orders, item `fulfillments` with their own tracking. Gelato
// gives no carrier events; the delivery window is its estimate, updated by order_delivery_estimate_updated.
export function gelatoTracking(order: GelatoOrder): TrackingInfo {
  const ref = new Map((order.items || []).filter((item) => item.id).map((item) => [item.id!, item.itemReferenceId || null]));
  const itemStatus = new Map((order.items || []).filter((item) => item.id).map((item) => [item.id!, item.fulfillmentStatus]));
  const orderState = shipmentState(order.fulfillmentStatus) ?? "shipped";
  const window = order.shipment && (order.shipment.minDeliveryDate || order.shipment.maxDeliveryDate) ? { from: isoDate(order.shipment.minDeliveryDate), to: isoDate(order.shipment.maxDeliveryDate) } : null;
  const origin = order.shipment?.fulfillmentCountry || null;
  const shipments: Shipment[] = [];
  const add = (shipment: Shipment) => { if (!shipments.some((known) => known.trackingNumber && known.trackingNumber === shipment.trackingNumber)) shipments.push(shipment); };
  (order.shipment?.packages || []).filter((pkg) => pkg.trackingCode || pkg.trackingUrl).forEach((pkg, index) => {
    const states = (pkg.orderItemIds || []).map((id) => shipmentState(itemStatus.get(id))).filter(Boolean) as ShipmentStatus[];
    add({
      id: pkg.id || `gelato-${pkg.trackingCode || index}`,
      carrier: order.shipment?.shipmentMethodName || null,
      service: null,
      trackingNumber: pkg.trackingCode || null,
      trackingUrl: httpsLink(pkg.trackingUrl),
      status: states.length && states.every((state) => state === "delivered") ? "delivered" : states[0] && states.every((state) => state === states[0]) ? states[0] : orderState,
      shippedAt: isoDate(order.shippedAt),
      deliveredAt: null,
      estimatedDelivery: window,
      location: origin ? `Dispatched from ${origin}` : null,
      items: (pkg.orderItemIds || []).map((id) => ({ itemId: ref.get(id) || null, quantity: null })),
      events: [],
    });
  });
  for (const item of order.items || []) {
    for (const [index, fulfillment] of (item.fulfillments || []).entries()) {
      if (!fulfillment.trackingCode && !fulfillment.trackingUrl) continue;
      add({
        id: `gelato-${fulfillment.trackingCode || `${item.id}-${index}`}`,
        carrier: fulfillment.shipmentMethodName || order.shipment?.shipmentMethodName || null,
        service: null,
        trackingNumber: fulfillment.trackingCode || null,
        trackingUrl: httpsLink(fulfillment.trackingUrl),
        status: shipmentState(fulfillment.fulfillmentStatus || item.fulfillmentStatus) ?? orderState,
        shippedAt: isoDate(order.shippedAt),
        deliveredAt: null,
        estimatedDelivery: window,
        location: fulfillment.fulfillmentCountry || origin ? `Dispatched from ${fulfillment.fulfillmentCountry || origin}` : null,
        items: [{ itemId: item.itemReferenceId || null, quantity: null }],
        events: [],
      });
    }
  }
  return { shipments, estimatedDelivery: window, expectedDispatch: isoDate(order.expectedDispatchDate) };
}

// Gelato's refusal reasons (order and items), most detailed first, without repeats. The item reason usually
// carries the preflight detail ("… Issue presents on pages: 1"), the order one repeats its first line.
export function gelatoRefusal(order: GelatoOrder) {
  const reasons = [order.refusalReason, ...(order.items || []).map((item) => item.refusalReason)]
    .flatMap((value) => (typeof value === "string" ? value.split("\n") : []))
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const reason of reasons) if (!kept.some((known) => known.includes(reason))) kept.push(reason);
  return kept.join(" · ").slice(0, 600) || null;
}

export function parseGelatoOrder(order: GelatoOrder): ProviderOrderState {
  const raw = (order.fulfillmentStatus || order.orderType || "created").toLowerCase();
  const status = STATUS.find(([pattern]) => pattern.test(raw))?.[1] ?? "SUBMITTED";
  const tracking = gelatoTracking(order);
  const main = primaryShipment(tracking);
  const refusal = gelatoRefusal(order);
  return {
    providerOrderId: order.id,
    providerStatus: raw,
    status,
    problem: PROBLEM[raw] && refusal ? `${PROBLEM[raw].replace(/: open it in the Gelato dashboard to see why$/, "")}: ${refusal}` : PROBLEM[raw] ?? (refusal && status === "CANCELLED" ? `Gelato's reason: ${refusal}` : null),
    carrier: main?.carrier || order.shipment?.shipmentMethodName || null,
    trackingNumber: main?.trackingNumber || null,
    trackingUrl: main?.trackingUrl || null,
    tracking,
  };
}

export function buildGelatoOrder(input: SubmissionInput) {
  const [firstName, ...rest] = input.recipient.name.trim().split(/\s+/);
  return {
    orderType: input.mode === "live" ? "order" : "draft",
    orderReferenceId: input.reference,
    customerReferenceId: input.orderNumber,
    currency: "EUR",
    items: input.lines.map((line) => ({
      itemReferenceId: line.itemId,
      productUid: line.productRef,
      quantity: line.quantity,
      ...(line.pageCount ? { pageCount: line.pageCount } : {}),
      files: line.files.map((file) => ({ type: file.area, url: file.url })),
    })),
    shippingAddress: {
      firstName: firstName || input.recipient.name,
      lastName: rest.join(" ") || firstName || input.recipient.name,
      addressLine1: input.recipient.address1,
      ...(input.recipient.address2 ? { addressLine2: input.recipient.address2 } : {}),
      city: input.recipient.city,
      postCode: input.recipient.postalCode,
      country: input.recipient.countryCode,
      ...(input.recipient.state ? { state: input.recipient.state } : {}),
      email: input.recipient.email,
      ...(input.recipient.phone ? { phone: input.recipient.phone } : {}),
    },
  };
}

// This checks only Gelato API credentials and reachability. Gelato does not expose
// dashboard webhook registration through this API, so webhook setup remains a
// separate informational state in lib/pod/webhooks.ts.
export async function checkGelatoApi(fetchImpl?: FetchLike): Promise<GelatoApiHealth> {
  const { apiKey, baseUrl } = gelatoConfig();
  if (!apiKey) return { state: "not_configured", detail: "GELATO_API_KEY is not set" };
  try {
    const { body } = await podRequest<{ orders?: unknown }>("GELATO", `${baseUrl}/v4/orders:search`, {
      method: "POST",
      body: JSON.stringify({ limit: 1 }),
      fetchImpl,
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    });
    if (!body || !Array.isArray(body.orders)) return { state: "unavailable", detail: "Gelato returned an unexpected API response" };
    return { state: "connected", detail: "Gelato API is authenticated and reachable" };
  } catch (reason) {
    return { state: "unavailable", detail: reason instanceof Error ? reason.message.slice(0, 160) : "Gelato API could not be reached" };
  }
}

// The read-only order quote (POST /v4/orders:quote) for the same order: Gelato checks the products, files and
// address and prices it, without creating anything. Used for dry runs outside production.
export function buildGelatoQuote(input: SubmissionInput) {
  const order = buildGelatoOrder(input);
  return {
    orderReferenceId: order.orderReferenceId,
    customerReferenceId: order.customerReferenceId,
    currency: order.currency,
    allowMultipleQuotes: false,
    recipient: order.shippingAddress,
    products: order.items,
  };
}

type GelatoQuote = { quotes?: { products?: { itemReferenceId?: string; price?: number; currency?: string }[]; shipmentMethods?: { name?: string; price?: number }[] }[] };

export function gelatoAdapter(fetchImpl?: FetchLike): PodAdapter {
  const request = <T>(path: string, init: RequestInit = {}) => {
    // Outside production nothing that could change the Gelato account is ever sent (lib/pod/provider-guard.ts).
    assertProviderRequestAllowed("GELATO", init.method, path);
    const { apiKey, baseUrl } = gelatoConfig();
    return podRequest<T>("GELATO", `${baseUrl}${path}`, { ...init, fetchImpl, headers: { "X-API-KEY": apiKey || "", "Content-Type": "application/json", Accept: "application/json" } });
  };
  // Gelato answers 404 for an order that no longer exists: a draft deleted (by us or in the Gelato dashboard).
  const orderOrGone = async (providerOrderId: string) => {
    try {
      return (await request<GelatoOrder>(`/v4/orders/${encodeURIComponent(providerOrderId)}`)).body;
    } catch (reason) {
      if (reason instanceof PodApiError && reason.status === 404) return null;
      throw reason;
    }
  };
  const gone = (providerOrderId: string): ProviderOrderState => ({ providerOrderId, providerStatus: "deleted at Gelato", status: "CANCELLED", problem: null });
  return {
    provider: "GELATO",
    configurationProblem: () => (gelatoConfig().apiKey ? null : "GELATO_API_KEY is not set"),
    async submit(input) {
      // Not the production site: a dry run. Gelato validates and prices the order (quote), nothing is created.
      if (!providerWritesAllowed()) {
        const { body } = await request<GelatoQuote>("/v4/orders:quote", { method: "POST", body: JSON.stringify(buildGelatoQuote(input)) });
        const quote = body?.quotes?.[0];
        if (!quote?.products?.length) throw new PodApiError("GELATO", null, "Gelato did not return a quote for the dry run", false, body);
        return { providerOrderId: `${DRY_RUN_PREFIX}${input.reference}`, providerStatus: "dry run: validated by Gelato (quote), not sent", status: "SUBMITTED", problem: null, raw: { dryRun: true, products: quote.products.map((product) => ({ itemReferenceId: product.itemReferenceId, price: product.price, currency: product.currency })) } };
      }
      const { body } = await request<GelatoOrder>("/v4/orders", { method: "POST", body: JSON.stringify(buildGelatoOrder(input)) });
      if (!body?.id) throw new Error("Gelato did not return an order id");
      return { ...parseGelatoOrder(body), raw: { id: body.id, orderType: body.orderType, fulfillmentStatus: body.fulfillmentStatus, financialStatus: body.financialStatus } };
    },
    // Gelato has no idempotency key; before re-sending an order whose result is unknown we look it up.
    async findByReference(reference) {
      const { body } = await request<{ orders?: GelatoOrder[] }>("/v4/orders:search", { method: "POST", body: JSON.stringify({ orderReferenceIds: [reference], limit: 10 }) });
      const match = (body.orders || []).find((order) => order.orderReferenceId === reference);
      return match ? parseGelatoOrder(match) : null;
    },
    // Converts the draft into a real order (Gelato then produces and charges it).
    async confirmDraft(providerOrderId) {
      if (isDryRunOrder(providerOrderId)) throw new PodApiError("GELATO", null, "A dry-run order was never sent to Gelato and cannot be confirmed", false);
      const { body } = await request<GelatoOrder>(`/v4/orders/${encodeURIComponent(providerOrderId)}`, { method: "PATCH", body: JSON.stringify({ orderType: "order" }) });
      return parseGelatoOrder(body);
    },
    // A draft is deleted (DELETE /v4/orders/{id}); a real order is cancelled (POST /v4/orders/{id}:cancel),
    // which Gelato only allows before it is passed to production.
    async cancel(providerOrderId) {
      // A dry-run order exists only here: nothing to cancel at Gelato.
      if (isDryRunOrder(providerOrderId)) return { providerOrderId, providerStatus: "dry run cancelled (never sent)", status: "CANCELLED", problem: null };
      const id = encodeURIComponent(providerOrderId);
      const current = await orderOrGone(providerOrderId);
      if (!current) return gone(providerOrderId);
      if ((current.orderType || "").toLowerCase() === "draft") {
        await request<unknown>(`/v4/orders/${id}`, { method: "DELETE" });
        return { providerOrderId, providerStatus: "draft deleted", status: "CANCELLED", problem: null, raw: { deleted: true } };
      }
      await request<unknown>(`/v4/orders/${id}:cancel`, { method: "POST" });
      const { body } = await request<GelatoOrder>(`/v4/orders/${id}`);
      const state = parseGelatoOrder(body);
      if (state.status !== "CANCELLED") throw new PodApiError("GELATO", 409, `Gelato did not cancel the order (status: ${state.providerStatus})`, false);
      return { ...state, raw: { fulfillmentStatus: body.fulfillmentStatus } };
    },
    async fetchStatus(providerOrderId) {
      if (isDryRunOrder(providerOrderId)) return { providerOrderId, providerStatus: "dry run: validated by Gelato (quote), not sent", status: "SUBMITTED", problem: null };
      const body = await orderOrGone(providerOrderId);
      if (!body) return gone(providerOrderId);
      return body?.id ? { ...parseGelatoOrder(body), raw: { fulfillmentStatus: body.fulfillmentStatus, financialStatus: body.financialStatus } } : null;
    },
  };
}
