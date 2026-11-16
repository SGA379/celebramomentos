// Order confirmation email, sent once after a verified successful payment.
//
// - Provider: SMTP through nodemailer (SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD /
//   SMTP_FROM). Without a complete, non-placeholder configuration the email stays disabled:
//   nothing is sent, checkout is not affected and nothing is recorded as sent.
// - Trigger: only called from the code paths that have already verified the payment (signed
//   Stripe event / Stripe session retrieved server-side / captured PayPal order). The order is
//   re-checked here: it must be PAID or later AND have a SUCCEEDED payment.
// - Idempotency: a unique SiteSetting row (`order_confirmation_email:<orderId>`, hidden from the
//   admin list with isSecret) is claimed before sending. A concurrent or repeated call fails the
//   unique constraint and does nothing. If sending fails the claim is released so that a later
//   payment event or retry can try again.
// - Failures never touch the payment: the email runs in the background (waitUntil) and every error is
//   caught here; the order stays paid and is sent to the print shops as usual.
// - Test payments (Stripe test key / PayPal sandbox) never email the customer. They go to
//   ORDER_EMAIL_TEST_RECIPIENT when it is set (marked as a test), otherwise nothing is sent.
import { waitUntil } from "@vercel/functions";
import nodemailer from "nodemailer";
import { prisma } from "./prisma";
import { PRODUCTION_SITE_URL, siteUrl } from "./site-url";

const PAID_STATUSES = ["PAID", "PROCESSING", "SHIPPED", "DELIVERED"] as const;
const claimKey = (orderId: string) => `order_confirmation_email:${orderId}`;

export const ORDER_EMAIL_PARAGRAPHS = [
  "¡Gracias por tu pedido! 🎁",
  "Ya estamos preparando tus productos personalizados.",
  "Si tu pedido contiene varios artículos, es posible que los recibas en paquetes separados, ya que algunos productos se elaboran en diferentes centros especializados.",
  "Recibirás información de seguimiento a medida que cada paquete sea enviado.",
  "¡Esperamos que te encante tu pedido!",
  "Celebra Momentos 💛",
] as const;

type EmailOrder = { number: string; currency: string; totalCents: number; items: { name: string; quantity: number }[] };
type EmailOptions = { siteUrl?: string; test?: boolean };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
const money = (cents: number, currency: string) => new Intl.NumberFormat("es-ES", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

// Links in the email always point to the public shop (a local development URL would not open for the customer).
export function emailSiteUrl(base = siteUrl()) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(base) ? PRODUCTION_SITE_URL : base;
}

const NAVY = "#182443";
const CORAL = "#ee5264";
const MUTED = "#737b90";

// Table-based layout with inline styles: renders in Gmail, Outlook and Apple Mail, and is 100% wide on phones
// (max 600 px on desktop).
export function buildOrderConfirmationEmail(order: EmailOrder, options: EmailOptions = {}) {
  const site = (options.siteUrl || PRODUCTION_SITE_URL).replace(/\/+$/, "");
  const contactUrl = `${site}/contact`;
  const accountUrl = `${site}/account`;
  const lines = order.items.map((item) => `${item.quantity} × ${item.name}`);
  const total = money(order.totalCents, order.currency);
  const details = [`Pedido: ${order.number}`, ...lines, `Total: ${total}`];
  const testNote = "PEDIDO DE PRUEBA: pago en modo test. Este email se ha enviado a la dirección de pruebas, no al cliente.";
  const text = `${options.test ? `${testNote}\n\n` : ""}${ORDER_EMAIL_PARAGRAPHS.join("\n\n")}\n\n— Detalles de tu pedido —\n${details.join("\n")}\n\n¿Necesitas ayuda? Escríbenos: ${contactUrl}\nTus pedidos: ${accountUrl}\n`;

  const [title, ...body] = ORDER_EMAIL_PARAGRAPHS;
  const signature = body.pop()!;
  const paragraph = (value: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${NAVY}">${escapeHtml(value)}</p>`;
  // The separate-packages notice is highlighted so it is not missed.
  const notice = body.find((value) => /paquetes separados/.test(value));
  const itemRows = order.items.map((item) => `<tr><td style="padding:10px 0;border-bottom:1px solid #f0e6df;font-size:14px;color:${NAVY}">${escapeHtml(item.name)}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #f0e6df;font-size:14px;color:${MUTED};white-space:nowrap">× ${item.quantity}</td></tr>`).join("");
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#fffaf5;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Pedido ${escapeHtml(order.number)} confirmado · ${escapeHtml(total)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffaf5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:Arial,Helvetica,sans-serif">
${options.test ? `<tr><td style="padding:10px 16px;background:#fff6e0;border:1px solid #f1d9a8;border-radius:12px;font-size:12px;font-weight:bold;color:#8a5a00">${escapeHtml(testNote)}</td></tr><tr><td style="height:12px"></td></tr>` : ""}
<tr><td align="center" style="padding:8px 0 20px"><a href="${site}" style="text-decoration:none"><img src="${site}/images/logo.png" width="56" height="56" alt="Celebra Momentos" style="display:block;border:0;border-radius:50%"></a><div style="margin-top:8px;font-size:15px;font-weight:bold;color:${NAVY}">Celebra <span style="color:${CORAL}">Momentos</span></div></td></tr>
<tr><td style="background:#ffffff;border:1px solid #eadbd3;border-radius:20px;padding:32px 28px">
<p style="margin:0 0 6px;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${CORAL}">Pedido confirmado</p>
<h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;color:${NAVY}">${escapeHtml(title)}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;background:#fff6f0;border-radius:14px"><tr><td style="padding:14px 16px"><div style="font-size:12px;color:${MUTED}">Número de pedido</div><div style="margin-top:2px;font-size:18px;font-weight:bold;color:${NAVY}">${escapeHtml(order.number)}</div></td></tr></table>
${body.filter((value) => value !== notice).slice(0, 1).map(paragraph).join("")}
${notice ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr><td style="padding:12px 14px;border-left:4px solid ${CORAL};background:#fffaf5;border-radius:8px;font-size:14px;line-height:1.6;color:${NAVY}">📦 ${escapeHtml(notice)}</td></tr></table>` : ""}
${body.filter((value) => value !== notice).slice(1).map(paragraph).join("")}
<p style="margin:22px 0 8px;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${MUTED}">Detalles de tu pedido</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRows}<tr><td style="padding:12px 0 0;font-size:15px;font-weight:bold;color:${NAVY}">Total</td><td align="right" style="padding:12px 0 0;font-size:15px;font-weight:bold;color:${NAVY};white-space:nowrap">${escapeHtml(total)}</td></tr></table>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 0"><tr><td style="border-radius:999px;background:${NAVY}"><a href="${accountUrl}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none">Ver mis pedidos</a></td></tr></table>
<p style="margin:22px 0 0;font-size:15px;font-weight:bold;color:${NAVY}">${escapeHtml(signature)}</p>
</td></tr>
<tr><td align="center" style="padding:20px 12px;font-size:12px;line-height:1.6;color:${MUTED}">¿Necesitas ayuda con tu pedido? <a href="${contactUrl}" style="color:${CORAL};font-weight:bold">Contáctanos</a><br><a href="${site}" style="color:${MUTED}">${escapeHtml(site.replace(/^https?:\/\//, ""))}</a></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: `${options.test ? "[PRUEBA] " : ""}¡Gracias por tu pedido! 🎁 · ${order.number}`, text, html };
}

// Whether a payment was made with test credentials: Stripe test keys, or PayPal sandbox. Read from the keys
// the payment was processed with (the same environment variables the checkout uses).
export function isTestPayment(provider: string, env: Record<string, string | undefined> = process.env) {
  if (provider === "paypal") return (env.PAYPAL_MODE || "sandbox").trim().toLowerCase() !== "live";
  return !/^(sk|rk)_live_/.test((env.STRIPE_SECRET_KEY || "").trim());
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
// Where the email of a test payment may go: only an address set explicitly for testing.
export function testRecipient(env: Record<string, string | undefined> = process.env) {
  const value = env.ORDER_EMAIL_TEST_RECIPIENT?.trim();
  return value && EMAIL.test(value) ? value : null;
}

const clean = (name: string) => {
  const value = process.env[name]?.trim();
  return value && !/replace|changeme|example\.com/i.test(value) ? value : null;
};

// null when the provider is not (fully) configured.
export function smtpConfig() {
  const host = clean("SMTP_HOST");
  const user = clean("SMTP_USER");
  const password = clean("SMTP_PASSWORD");
  const from = process.env.SMTP_FROM?.trim();
  if (!host || !user || !password || !from || /example\.com/i.test(from)) return null;
  const port = Number(process.env.SMTP_PORT) || 587;
  return { host, port, secure: port === 465, auth: { user, pass: password }, from };
}

export type OrderEmailResult = "sent" | "disabled" | "skipped" | "test_mode" | "duplicate" | "failed";

export async function sendOrderConfirmationEmail(orderId: string): Promise<OrderEmailResult> {
  try {
    const config = smtpConfig();
    if (!config) return "disabled";
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true, payments: { where: { status: "SUCCEEDED" }, select: { id: true, provider: true } } } });
    // Never for pending, failed, cancelled or refunded orders.
    if (!order || !(PAID_STATUSES as readonly string[]).includes(order.status) || !order.payments.length || !order.email) return "skipped";

    // A test payment never reaches the customer: only the test inbox, when one is configured.
    const test = order.payments.every((payment) => isTestPayment(payment.provider));
    const to = test ? testRecipient() : order.email;
    if (!to) return "test_mode";

    try {
      await prisma.siteSetting.create({ data: { key: claimKey(order.id), value: "sending", isSecret: true } });
    } catch {
      return "duplicate";
    }
    try {
      const mail = buildOrderConfirmationEmail({ number: order.number, currency: order.currency, totalCents: order.totalCents, items: order.items.map((item) => ({ name: item.name, quantity: item.quantity })) }, { siteUrl: emailSiteUrl(), test });
      const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, auth: config.auth, connectionTimeout: 10_000, socketTimeout: 15_000 });
      await transport.sendMail({ from: config.from, to, ...mail });
      await prisma.siteSetting.update({ where: { key: claimKey(order.id) }, data: { value: `sent${test ? " (test inbox)" : ""} ${new Date().toISOString()}` } });
      return "sent";
    } catch (error) {
      // Release the claim so a later payment event can retry. Credentials are never logged.
      await prisma.siteSetting.delete({ where: { key: claimKey(order.id) } }).catch(() => undefined);
      console.error("Order confirmation email failed", { orderId, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return "failed";
    }
  } catch (error) {
    console.error("Order confirmation email could not run", { orderId, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return "failed";
  }
}

// Fire and forget: never delays or breaks the payment response.
export function sendOrderConfirmationInBackground(orderId: string) {
  waitUntil(sendOrderConfirmationEmail(orderId));
}
