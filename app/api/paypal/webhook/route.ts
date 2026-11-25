import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { handleApiError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { paypalWebhookConfigured, verifyPayPalWebhook } from "@/lib/server/paypal";
import { reconcilePayPalPayment } from "@/lib/server/paypal-checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENT_TYPES = new Set([
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "CHECKOUT.ORDER.COMPLETED",
]);

function relatedOrderId(event: Record<string, unknown>) {
  const resource = event.resource && typeof event.resource === "object" ? event.resource as Record<string, unknown> : {};
  const supplementary = resource.supplementary_data && typeof resource.supplementary_data === "object" ? resource.supplementary_data as Record<string, unknown> : {};
  const related = supplementary.related_ids && typeof supplementary.related_ids === "object" ? supplementary.related_ids as Record<string, unknown> : {};
  const candidates = [related.order_id, resource.parent_payment, resource.order_id, resource.id];
  return candidates.find((value): value is string => typeof value === "string" && /^[A-Z0-9]+$/i.test(value)) || null;
}

export async function POST(request: NextRequest) {
  if (!paypalWebhookConfigured()) return NextResponse.json({ error: "PayPal webhook is not configured" }, { status: 503 });
  const raw = await request.text();
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid event");
    event = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const verified = await verifyPayPalWebhook({
    transmissionId: request.headers.get("paypal-transmission-id"),
    transmissionTime: request.headers.get("paypal-transmission-time"),
    certUrl: request.headers.get("paypal-cert-url"),
    authAlgo: request.headers.get("paypal-auth-algo"),
    transmissionSig: request.headers.get("paypal-transmission-sig"),
    webhookEvent: event,
  }).catch(() => false);
  if (!verified) return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });

  const eventId = typeof event.id === "string" ? event.id : null;
  const eventType = typeof event.event_type === "string" ? event.event_type : "unknown";
  if (!eventId) return NextResponse.json({ received: true, ignored: "missing event id" });
  try {
    await prisma.payPalEvent.create({ data: { id: eventId, type: eventType } });
  } catch (reason) {
    if (reason instanceof Prisma.PrismaClientKnownRequestError && reason.code === "P2002") return NextResponse.json({ received: true, duplicate: true });
    return handleApiError(reason);
  }
  if (!EVENT_TYPES.has(eventType)) return NextResponse.json({ received: true, ignored: eventType });

  const paypalOrderId = relatedOrderId(event);
  if (!paypalOrderId) return NextResponse.json({ received: true, matched: false });
  try {
    const result = await reconcilePayPalPayment(paypalOrderId);
    return NextResponse.json({ received: true, matched: Boolean(result), status: result?.status || "unknown" });
  } catch (reason) {
    // Release the claim so PayPal can retry the event after a transient provider
    // or database failure. Reconciliation itself remains idempotent.
    await prisma.payPalEvent.delete({ where: { id: eventId } }).catch(() => undefined);
    console.error("PayPal webhook reconciliation failed", { eventId, paypalOrderId, message: reason instanceof Error ? reason.message.slice(0, 200) : "unknown" });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 503 });
  }
}
