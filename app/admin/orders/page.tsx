"use client";

// Orders. Statuses are read-only here: the payment status comes from Stripe / PayPal and the
// fulfilment status from the print shops (webhooks, scheduled checks and a refresh when this page
// loads). Clicking an order opens its details (customer, items with the customer's design, print
// orders); the only manual action is deleting an order, after a confirmation.
import { useEffect, useState } from "react";
import { AdminPageHeader, AdminShell } from "@/components/admin";
import { AdminModal, OptionChips, ProviderBadges, Thumb, clickableRow, stopRowClick } from "@/components/admin-ui";
import { BrandLoader } from "@/components/loading";
import { Price, StatusBadge, Toast } from "@/components/site";
import { LoadingButton } from "@/components/loading-button";
import { podProviderLabel } from "@/lib/products";

type Fulfillment = { provider: string; mode: string; status: string; providerStatus: string | null; carrier: string | null; trackingNumber: string | null; trackingUrl: string | null; lastSyncedAt: string | null };
type PrintFile = { url: string; area: string; unit: number; kind: string | null; source: string | null };
type OrderItem = {
  id: string; name: string; quantity: number; unitPrice: number; provider: string | null; productRef: string | null;
  kind: string | null; preview: string | null; detail: string | null; options: { name: string; value: string }[];
  photos: (string | null)[]; pages: { side: string; url: string }[]; cardSize: string | null; printFiles: PrintFile[];
};
type Order = {
  id: string; dbId: string; email: string; amount: number; date: string; status: string; orderStatus: string; item: string;
  shipping: { name: string; phone: string; recipient: string; address: string; city: string; postalCode: string; country: string; billingAddress?: string };
  payment?: { provider: string; status: string } | null;
  fulfillments?: Fulfillment[];
  totals?: { subtotal: number; shipping: number; discount: number; total: number; currency: string };
  customer?: { name: string; email: string; phone: string | null } | null;
  items?: OrderItem[];
  providers?: string[];
};

const ORDER_LABEL: Record<string, string> = { PENDING: "Awaiting payment", PAID: "Paid", PROCESSING: "In production", SHIPPED: "Shipped", DELIVERED: "Delivered", CANCELLED: "Cancelled", REFUNDED: "Refunded" };
const PAYMENT_LABEL: Record<string, string> = { PENDING: "Pending", SUCCEEDED: "Paid", FAILED: "Failed", CANCELLED: "Cancelled", REFUNDED: "Refunded" };
const FULFILLMENT_LABEL: Record<string, string> = { NEEDS_ATTENTION: "Needs attention", READY: "Ready to send", SUBMITTING: "Sending", SUBMITTED: "Sent", IN_PRODUCTION: "In production", SHIPPED: "Shipped", DELIVERED: "Delivered", CANCELLED: "Cancelled", FAILED: "Failed (retrying)" };
const KIND_LABEL: Record<string, string> = { POSTCARD: "Card", WALL_ART: "Wall art", MAGNET: "Magnets", PHONE_CASE: "Phone case", MUG: "Mug", CALENDAR: "Calendar" };
const PAGE_LABEL: Record<string, string> = { front: "Front", "inside-left": "Inside left", "inside-right": "Inside right", back: "Back" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const tone = (status: string) => (["DELIVERED", "SHIPPED", "SUCCEEDED", "PAID"].includes(status) ? "green" : ["CANCELLED", "REFUNDED", "FAILED"].includes(status) ? "rose" : "amber") as "green" | "rose" | "amber";
const when = (value: string | null) => (value ? new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "not yet");
const placed = (value: string) => new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function AdminOrdersPage() {
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelProblem, setCancelProblem] = useState("");
  const [toast, setToast] = useState("");

  const load = async () => {
    const response = await fetch("/api/admin/orders", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Unable to load orders");
    setOrders(body.orders || []);
  };
  const reload = () => { setLoaded(false); setLoadFailed(false); void load().catch((reason) => { setToast(reason instanceof Error ? reason.message : "Unable to load orders"); setLoadFailed(true); }).finally(() => setLoaded(true)); };
  // Loaded once when the page opens (and again from Retry).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, []);

  const open = (order: Order) => { setSelected(order); setConfirming(false); setCancelProblem(""); };
  const close = () => { setSelected(null); setConfirming(false); setCancelProblem(""); };

  const remove = async (force = false) => {
    if (!selected) return;
    const response = await fetch(`/api/admin/orders?id=${selected.dbId}${force ? "&force=1" : ""}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      // A print order could not be cancelled at its shop: say so and let the admin decide.
      if (body.cancelFailed) { setCancelProblem(body.error); return; }
      throw new Error(body.error || "Unable to delete order");
    }
    close();
    await load();
    setToast("Order deleted");
  };

  return <AdminShell>
    <AdminPageHeader eyebrow="COMMERCE" title="Orders" body="Payment status comes from Stripe / PayPal and print status from the print shops, automatically. Click an order to see everything the customer ordered and designed." action={<span className="rounded-full bg-[#e8f5ed] px-4 py-3 text-xs font-black text-[#24714b]">{orders.length} orders</span>} />
    <section className="mt-8 overflow-hidden rounded-2xl border border-[#e4e7ee] bg-white">
      {!loaded ? <BrandLoader compact label="Loading orders…" />
        : loadFailed ? <div role="alert" className="p-12 text-center"><p className="font-black text-[#c94758]">Unable to load orders</p><button type="button" onClick={reload} className="mt-3 rounded-full border border-[#dfd3cc] px-4 py-2 text-xs font-black">Retry</button></div>
        : orders.length === 0 ? <div className="p-12 text-center"><p className="font-black">No orders yet</p></div>
        : <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left">
          <thead><tr className="border-b border-[#e4e7ee] bg-[#fafbfc] text-[10px] uppercase tracking-[.14em] text-[#9297a4]"><th className="px-5 py-3">Order</th><th className="px-5 py-3">Customer</th><th className="px-5 py-3">Total</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Provider</th><th className="px-5 py-3">Payment</th><th className="px-5 py-3">Print</th><th className="px-5 py-3 text-right">Actions</th></tr></thead>
          <tbody>{orders.map((order) => <tr key={order.dbId} {...clickableRow(() => open(order))} className="cursor-pointer border-b border-[#eef0f4] text-sm outline-none transition hover:bg-[#fafbfc] focus-visible:bg-[#fff6f2]">
            <td className="px-5 py-4"><span className="block font-black">{order.id}</span><span className="block text-[11px] text-[#9297a4]">{placed(order.date)}</span></td>
            <td className="px-5 py-4"><p className="font-bold">{order.shipping.name}</p><p className="text-xs text-[#737b90]">{order.email}</p></td>
            <td className="whitespace-nowrap px-5 py-4 font-black"><Price value={order.amount} /></td>
            <td className="whitespace-nowrap px-5 py-4"><StatusBadge tone={tone(order.orderStatus)}>{ORDER_LABEL[order.orderStatus] || order.orderStatus}</StatusBadge></td>
            <td className="px-5 py-4"><ProviderBadges providers={order.providers || []} /></td>
            <td className="px-5 py-4 text-xs">{order.payment ? <StatusBadge tone={tone(order.payment.status)}>{PAYMENT_LABEL[order.payment.status] || order.payment.status}</StatusBadge> : "—"}</td>
            <td className="px-5 py-4 text-xs">{order.fulfillments?.length ? order.fulfillments.map((item) => <span key={item.provider} className="block">{podProviderLabel(item.provider)}: <b>{FULFILLMENT_LABEL[item.status] || item.status}</b></span>) : <span className="text-[#9297a4]">—</span>}</td>
            <td className="px-5 py-4 text-right" {...stopRowClick}><button type="button" onClick={() => open(order)} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#dfd3cc] px-3.5 py-1.5 text-xs font-black text-[#182443] transition hover:border-[#182443] hover:bg-[#fafbfc]">View <span aria-hidden="true">→</span></button></td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    {selected && <AdminModal eyebrow="ORDER DETAILS" title={selected.id} subtitle={<>Placed {placed(selected.date)} · {selected.email}</>} onClose={close}>
      <OrderDetails order={selected} />

      {!confirming
        ? <button type="button" onClick={() => setConfirming(true)} className="mt-8 w-full rounded-full border border-[#f3c6c2] px-5 py-3.5 text-sm font-black text-[#c94758] sm:w-auto">Delete this order</button>
        : <div role="alertdialog" aria-modal="true" aria-labelledby="delete-order-title" className="mt-8 rounded-2xl border border-[#f3c6c2] bg-[#fff0e8] p-4">
          <p id="delete-order-title" className="text-sm font-black text-[#c94758]">Delete order {selected.id}?</p>
          <p className="mt-1 text-xs leading-5 text-[#59627b]">This permanently removes the order with its items, payment records and print orders from this site. The customer account and the products are kept. Print orders already sent are <b>cancelled at the print shop first</b> (only possible before production starts). Payments are not refunded automatically.</p>
          {cancelProblem && <p role="alert" className="mt-2 rounded-lg bg-white p-2 text-xs font-bold text-[#c94758]">{cancelProblem}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => { setConfirming(false); setCancelProblem(""); }} className="flex-1 rounded-full border border-[#dfd3cc] bg-white px-4 py-2.5 text-xs font-black">Keep order</button>
            <LoadingButton onClick={() => remove(Boolean(cancelProblem))} loadingLabel={cancelProblem ? "Deleting…" : "Cancelling and deleting…"} errorMessage="Unable to delete the order. Try again." className="flex-1 rounded-full bg-[#c94758] px-4 py-2.5 text-xs font-black text-white disabled:opacity-60">{cancelProblem ? "Delete anyway" : "Delete permanently"}</LoadingButton>
          </div>
        </div>}
    </AdminModal>}
    {toast && <Toast message={toast} onClose={() => setToast("")} />}
  </AdminShell>;
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="mt-7 first:mt-0"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-black">{title}</h3>{action}</div><div className="mt-3">{children}</div></section>;
}

function OrderDetails({ order }: { order: Order }) {
  const ship = order.shipping;
  const items = order.items || [];
  return <>
    <Section title="Summary">
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-xs sm:grid-cols-[110px_1fr_110px_1fr]">
        <dt className="font-black text-[#9297a4]">Status</dt><dd><StatusBadge tone={tone(order.orderStatus)}>{ORDER_LABEL[order.orderStatus] || order.orderStatus}</StatusBadge></dd>
        <dt className="font-black text-[#9297a4]">Payment</dt><dd>{order.payment ? <><StatusBadge tone={tone(order.payment.status)}>{PAYMENT_LABEL[order.payment.status] || order.payment.status}</StatusBadge> <span className="text-[#737b90]">via {order.payment.provider === "paypal" ? "PayPal" : "Stripe"}</span></> : "—"}</dd>
        <dt className="font-black text-[#9297a4]">Provider</dt><dd><ProviderBadges providers={order.providers || []} /></dd>
        <dt className="font-black text-[#9297a4]">Customer sees</dt><dd>{order.status}</dd>
      </dl>
    </Section>

    <Section title="Customer & shipping">
      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div className="rounded-xl border border-[#e4e7ee] p-3">
          <p className="font-black text-[#9297a4]">Customer</p>
          <p className="mt-1 font-black">{order.customer?.name || ship.name || "—"}</p>
          <p className="break-all text-[#59627b]">{order.email}</p>
          {(ship.phone || order.customer?.phone) && <p className="text-[#59627b]">{ship.phone || order.customer?.phone}</p>}
          <p className="mt-1 text-[11px] text-[#9297a4]">{order.customer ? "Customer account" : "Guest checkout"}</p>
        </div>
        <div className="rounded-xl border border-[#e4e7ee] p-3">
          <p className="font-black text-[#9297a4]">Ship to</p>
          <p className="mt-1 font-black">{ship.recipient || ship.name || "—"}</p>
          <p className="text-[#59627b]">{ship.address}</p>
          <p className="text-[#59627b]">{[ship.postalCode, ship.city].filter(Boolean).join(" ")}{ship.country ? ` · ${ship.country}` : ""}</p>
          {ship.billingAddress && <p className="mt-1 text-[11px] text-[#9297a4]">Billing: {ship.billingAddress}</p>}
        </div>
      </div>
    </Section>

    <Section title={`Items (${items.length})`}>
      {items.length ? <div className="space-y-3">{items.map((item) => <OrderItemCard key={item.id} item={item} />)}</div> : <p className="text-xs text-[#9297a4]">{order.item || "No items"}</p>}
    </Section>

    {order.totals && <Section title="Totals">
      <dl className="ml-auto grid max-w-[320px] grid-cols-[1fr_auto] gap-y-1 text-xs">
        <dt className="text-[#737b90]">Subtotal</dt><dd className="text-right font-bold"><Price value={order.totals.subtotal} /></dd>
        <dt className="text-[#737b90]">Shipping</dt><dd className="text-right font-bold"><Price value={order.totals.shipping} /></dd>
        {order.totals.discount > 0 && <><dt className="text-[#737b90]">Discount</dt><dd className="text-right font-bold text-[#24714b]">− <Price value={order.totals.discount} /></dd></>}
        <dt className="mt-1 border-t border-[#eef0f4] pt-1 font-black">Total</dt><dd className="mt-1 border-t border-[#eef0f4] pt-1 text-right font-black"><Price value={order.totals.total} /></dd>
      </dl>
    </Section>}

    <Section title="Print orders" action={order.fulfillments?.length ? <a href={`/admin/fulfillment?q=${encodeURIComponent(order.id)}`} className="text-xs font-black text-[#ee5264]">Open in Fulfillment →</a> : undefined}>
      {order.fulfillments?.length ? <div className="grid gap-2 sm:grid-cols-2">{order.fulfillments.map((item) => <div key={item.provider} className="rounded-xl border border-[#e4e7ee] p-3 text-xs">
        <p className="flex flex-wrap items-center gap-2 font-black"><ProviderBadges providers={[item.provider]} />{item.mode === "draft" && <span className="rounded-full bg-[#fff6e0] px-2 py-0.5 text-[10px] text-[#8a5a00]">TEST</span>}<StatusBadge tone={tone(item.status)}>{FULFILLMENT_LABEL[item.status] || item.status}</StatusBadge></p>
        {item.providerStatus && <p className="mt-1 text-[#737b90]">Print shop says: {item.providerStatus}</p>}
        {(item.trackingNumber || item.trackingUrl) && <p className="mt-1">Tracking{item.carrier ? ` (${item.carrier})` : ""}: {item.trackingUrl ? <a href={item.trackingUrl} target="_blank" rel="noreferrer" className="font-black text-[#ee5264] underline">{item.trackingNumber || "open"}</a> : item.trackingNumber}</p>}
        <p className="mt-1 text-[#9297a4]">Last checked with the print shop: {when(item.lastSyncedAt)}</p>
      </div>)}</div> : <p className="text-xs text-[#9297a4]">No print order yet (created automatically once the payment is confirmed).</p>}
      <p className="mt-3 text-[11px] text-[#9297a4]">Statuses update automatically and cannot be changed by hand.</p>
    </Section>
  </>;
}

// One ordered item: the customer's design first (studio preview, or the card's front page), then the choices,
// the price, the print shop, the uploaded photos and the print files made for the print shop.
function OrderItemCard({ item }: { item: OrderItem }) {
  const photos = item.photos.map((url, index) => ({ url, index })).filter((photo): photo is { url: string; index: number } => Boolean(photo.url));
  const calendar = item.kind === "CALENDAR";
  return <article className="rounded-2xl border border-[#e4e7ee] p-4">
    <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
      {item.preview ? <Thumb url={item.preview} size="lg" label="Customer's design" detail={item.kind === "POSTCARD" ? "front page, as rendered at checkout" : "as shown in the studio"} />
        : <span className="flex h-56 items-center justify-center rounded-lg border border-dashed border-[#e4e7ee] px-4 text-center text-xs font-bold text-[#9297a4]">No design preview saved for this item</span>}
      <div className="min-w-0 text-xs">
        <p className="text-sm font-black">{item.quantity} × {item.name}</p>
        <p className="mt-0.5 text-[#737b90]">{item.kind ? KIND_LABEL[item.kind] || item.kind : "Product"}{item.cardSize ? ` · ${item.cardSize}` : ""} · <Price value={item.unitPrice} /> each · <b className="text-[#182443]"><Price value={item.unitPrice * item.quantity} /></b></p>
        {item.detail && <p className="mt-2 text-[#59627b]">{item.detail}</p>}
        <div className="mt-2"><OptionChips options={item.options} /></div>
        <dl className="mt-3 grid grid-cols-[96px_1fr] gap-x-2 gap-y-1">
          <dt className="font-black text-[#9297a4]">Provider</dt><dd><ProviderBadges providers={[item.provider]} /></dd>
          <dt className="font-black text-[#9297a4]">Shop product</dt><dd className="break-all">{item.productRef || <span className="text-[#9297a4]">mapped when the print order is made</span>}</dd>
        </dl>
      </div>
    </div>
    {item.pages.length > 0 && <div className="mt-4">
      <p className="text-[11px] font-black">Card pages ({item.pages.length})</p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">{item.pages.map((page) => <Thumb key={page.url} url={page.url} size="sm" label={PAGE_LABEL[page.side] || page.side} />)}</div>
    </div>}
    {photos.length > 0 && <div className="mt-4">
      <p className="text-[11px] font-black">Customer&apos;s uploaded photos ({photos.length}{calendar ? " of 12 months" : ""})</p>
      <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">{photos.map((photo) => <Thumb key={photo.index} url={photo.url} size="sm" label={calendar ? MONTHS[photo.index] || `Month ${photo.index + 1}` : `Photo ${photo.index + 1}`} />)}</div>
    </div>}
    <div className="mt-4">
      <p className="text-[11px] font-black">Print files sent to the print shop{item.printFiles.length ? ` (${item.printFiles.length})` : ""}</p>
      {item.printFiles.length ? <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">{item.printFiles.map((file) => <Thumb key={`${file.unit}-${file.area}`} url={file.url} size="sm" label={`${file.area}${file.unit ? ` · ${file.unit + 1}` : ""}`} detail={file.source === "admin" ? "attached by admin" : file.kind === "calendar" ? "14-page PDF" : "from the customer's design"} />)}</div>
        : <p className="mt-1 text-[11px] text-[#9297a4]">Made automatically from the customer&apos;s design once the payment is confirmed.</p>}
    </div>
  </article>;
}
