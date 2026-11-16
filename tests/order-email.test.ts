import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const claims = new Map<string, string>();
let order: Record<string, unknown> | null = null;

vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    order: { findUnique: async () => order },
    siteSetting: {
      create: async ({ data }: { data: { key: string; value: string } }) => { if (claims.has(data.key)) throw new Error("Unique constraint"); claims.set(data.key, data.value); },
      update: async ({ where, data }: { where: { key: string }; data: { value: string } }) => { claims.set(where.key, data.value); },
      delete: async ({ where }: { where: { key: string } }) => { claims.delete(where.key); },
    },
  },
}));

import { buildOrderConfirmationEmail, emailSiteUrl, isTestPayment, ORDER_EMAIL_PARAGRAPHS, sendOrderConfirmationEmail, smtpConfig, testRecipient } from "@/lib/server/order-email";

const paidOrder = (patch: Record<string, unknown> = {}) => ({ id: "o1", number: "CM-1", email: "cliente@example.org", currency: "eur", totalCents: 2350, status: "PAID", items: [{ name: "Tarjeta <b>", quantity: 2 }], payments: [{ id: "p1", provider: "stripe" }], ...patch });

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({});
  claims.clear();
  order = paidOrder();
  Object.assign(process.env, { SMTP_HOST: "smtp.mailer.test", SMTP_PORT: "587", SMTP_USER: "user", SMTP_PASSWORD: "secret-pass", SMTP_FROM: "Celebra Momentos <hola@celebra-momentos.test>" });
  // Live payments unless a test says otherwise (fake values: nothing here reaches Stripe or PayPal).
  Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_live_fake_for_tests", PAYPAL_MODE: "live" });
  delete process.env.ORDER_EMAIL_TEST_RECIPIENT;
});

describe("order confirmation email", () => {
  it("contains the exact Spanish text from the client", () => {
    const mail = buildOrderConfirmationEmail({ number: "CM-1", currency: "eur", totalCents: 2350, items: [{ name: "Tarjeta", quantity: 1 }] });
    expect(ORDER_EMAIL_PARAGRAPHS.join("\n\n")).toBe("¡Gracias por tu pedido! 🎁\n\nYa estamos preparando tus productos personalizados.\n\nSi tu pedido contiene varios artículos, es posible que los recibas en paquetes separados, ya que algunos productos se elaboran en diferentes centros especializados.\n\nRecibirás información de seguimiento a medida que cada paquete sea enviado.\n\n¡Esperamos que te encante tu pedido!\n\nCelebra Momentos 💛");
    expect(mail.text).toContain("Pedido: CM-1");
    expect(mail.text).toContain("1 × Tarjeta");
  });

  it("escapes order data in the HTML body", () => {
    expect(buildOrderConfirmationEmail({ number: "CM-1", currency: "eur", totalCents: 100, items: [{ name: "<script>x</script>", quantity: 1 }] }).html).not.toContain("<script>");
  });

  it("sends once for a paid order and never twice", async () => {
    expect(await sendOrderConfirmationEmail("o1")).toBe("sent");
    expect(await sendOrderConfirmationEmail("o1")).toBe("duplicate");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: "cliente@example.org" });
  });

  it("never sends for pending / failed payments", async () => {
    order = paidOrder({ status: "PENDING" });
    expect(await sendOrderConfirmationEmail("o1")).toBe("skipped");
    order = paidOrder({ status: "CANCELLED" });
    expect(await sendOrderConfirmationEmail("o1")).toBe("skipped");
    order = paidOrder({ payments: [] });
    expect(await sendOrderConfirmationEmail("o1")).toBe("skipped");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("releases the claim when delivery fails so it can be retried, without leaking credentials", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMail.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect(await sendOrderConfirmationEmail("o1")).toBe("failed");
    expect(claims.size).toBe(0);
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-pass");
    expect(await sendOrderConfirmationEmail("o1")).toBe("sent");
    error.mockRestore();
  });

  it("stays disabled without a complete SMTP configuration", async () => {
    process.env.SMTP_PASSWORD = "replace_me";
    expect(smtpConfig()).toBeNull();
    expect(await sendOrderConfirmationEmail("o1")).toBe("disabled");
    expect(sendMail).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);
  });

  it("is a responsive, branded email with the order number, the separate-packages notice and a contact link", () => {
    const mail = buildOrderConfirmationEmail({ number: "CM-77", currency: "eur", totalCents: 4599, items: [{ name: "Calendario", quantity: 1 }, { name: "Taza", quantity: 2 }] }, { siteUrl: "https://www.celebra-momentos.com" });
    expect(mail.subject).toBe("¡Gracias por tu pedido! 🎁 · CM-77");
    expect(mail.html).toContain('name="viewport"');
    expect(mail.html).toContain("CM-77");
    expect(mail.html).toContain("paquetes separados");
    expect(mail.html).toContain('href="https://www.celebra-momentos.com/contact"');
    expect(mail.html).toContain("https://www.celebra-momentos.com/images/logo.png");
    expect(mail.text).toContain("https://www.celebra-momentos.com/contact");
    expect(mail.text).toContain("2 × Taza");
  });

  it("links to the public shop, never to a local development URL", () => {
    expect(emailSiteUrl("http://localhost:3000")).toBe("https://www.celebra-momentos.com");
    expect(emailSiteUrl("https://preview.example.org")).toBe("https://preview.example.org");
  });

  it("tells test payments from live ones by the keys in use", () => {
    expect(isTestPayment("stripe", { STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(true);
    expect(isTestPayment("stripe", { STRIPE_SECRET_KEY: "sk_live_abc" })).toBe(false);
    expect(isTestPayment("stripe", {})).toBe(true);
    expect(isTestPayment("paypal", { PAYPAL_MODE: "sandbox" })).toBe(true);
    expect(isTestPayment("paypal", {})).toBe(true);
    expect(isTestPayment("paypal", { PAYPAL_MODE: "live" })).toBe(false);
    expect(testRecipient({ ORDER_EMAIL_TEST_RECIPIENT: "not an email" })).toBeNull();
  });

  it("never emails the customer for a test payment; only the test inbox when one is set", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    expect(await sendOrderConfirmationEmail("o1")).toBe("test_mode");
    expect(sendMail).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);

    process.env.ORDER_EMAIL_TEST_RECIPIENT = "pruebas@example.org";
    expect(await sendOrderConfirmationEmail("o1")).toBe("sent");
    expect(await sendOrderConfirmationEmail("o1")).toBe("duplicate");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: "pruebas@example.org" });
    expect(sendMail.mock.calls[0][0].subject).toMatch(/^\[PRUEBA\]/);
    expect(JSON.stringify(sendMail.mock.calls[0][0])).not.toContain("cliente@example.org");
  });

  it("a PayPal sandbox payment is a test payment too", async () => {
    process.env.PAYPAL_MODE = "sandbox";
    order = paidOrder({ payments: [{ id: "p1", provider: "paypal" }] });
    expect(await sendOrderConfirmationEmail("o1")).toBe("test_mode");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("a delivery failure is reported, never thrown (the payment response is not affected)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMail.mockRejectedValueOnce(new Error("Invalid login"));
    await expect(sendOrderConfirmationEmail("o1")).resolves.toBe("failed");
    error.mockRestore();
  });
});
