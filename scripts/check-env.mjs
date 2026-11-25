#!/usr/bin/env node
// Environment check: keeps local (test/sandbox) and production (live) credentials apart.
// Read-only: it never calls an API, never writes a file and NEVER prints a value, only variable names.
//
//   npm run env:check              local profile: loads the env files like `next dev` (.env)
//   npm run env:check:production   production profile: checks .env.production.vercel
//   node scripts/check-env.mjs --profile production --file other.env | --process-env (e.g. in a Vercel build)
//
// Exit code 1 when an error is found.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const profile = flag("profile") || "local";
const file = flag("file") || (profile === "production" && !args.includes("--process-env") ? ".env.production.vercel" : null);
if (!["local", "production"].includes(profile)) { console.error("--profile must be local or production"); process.exit(2); }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// Minimal KEY=VALUE parser (same rules as the files in this repo: optional quotes, # comments).
function parseFile(filePath) {
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

function loadLocal() {
  // Same files and precedence as `next dev` (.env.development.local > .env.local > .env.development > .env).
  const { loadEnvConfig } = createRequire(import.meta.url)("@next/env");
  const silent = { info() {}, error: console.error };
  const { combinedEnv, loadedEnvFiles } = loadEnvConfig(root, true, silent, true);
  return { env: combinedEnv, source: loadedEnvFiles.map((f) => f.path).join(", ") || "(no env files)" };
}

const { env, source } = file ? { env: parseFile(path.resolve(file)), source: file } : profile === "local" ? loadLocal() : { env: process.env, source: "process.env" };

// Same "not set" rule as the app (lib/pod/config.ts, lib/server/*).
const get = (name) => { const v = env[name]?.trim(); return v && !/replace|changeme|example\.com/i.test(v) ? v : null; };
const has = (name) => Boolean(get(name));
const errors = [], warnings = [];
const error = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const require_ = (names, level = error) => names.filter((n) => !has(n)).forEach((n) => level(`${n} is not set`));

const LIVE_ONLY = ["PRODIGI_API_KEY", "PRINTEERS_V1_PARTNER_CODE", "PRINTEERS_V1_API_KEY", "PRINTEERS_API_KEY", "PRINTEERS_WEBHOOK_SECRET", "PRINTEERS_STORE_REFERENCE", "PRINTEERS_BRAND_REFERENCE", "PRODIGI_BASE_URL", "PRINTEERS_BASE_URL", "PRINTEERS_V2_BASE_URL"];
const TEST_ONLY = ["PRODIGI_SANDBOX_API_KEY", "PRODIGI_SANDBOX_BASE_URL", "PRINTEERS_V1_TEST_PARTNER_CODE", "PRINTEERS_V1_TEST_API_KEY", "PRINTEERS_TEST_API_KEY", "PRINTEERS_TEST_WEBHOOK_SECRET", "PRINTEERS_TEST_STORE_REFERENCE", "PRINTEERS_TEST_BRAND_REFERENCE", "PRINTEERS_TEST_BASE_URL", "PRINTEERS_TEST_V2_BASE_URL"];
const stripeKey = get("STRIPE_SECRET_KEY") || "";
const isLiveStripe = /^(sk|rk)_live_/.test(stripeKey);
const isTestStripe = /^(sk|rk)_test_/.test(stripeKey);
const paypalMode = (get("PAYPAL_MODE") || "sandbox").toLowerCase();
const podMode = (get("POD_ORDER_MODE") || "draft").toLowerCase();
const appUrl = get("APP_URL") || get("NEXT_PUBLIC_APP_URL") || "";

// ── Both profiles ──────────────────────────────────────────────────────────────
// Only NEXT_PUBLIC_APP_URL is meant for the browser; anything else NEXT_PUBLIC_ is bundled into client code.
for (const name of Object.keys(env).filter((n) => n.startsWith("NEXT_PUBLIC_") && n !== "NEXT_PUBLIC_APP_URL")) {
  if (/KEY|SECRET|TOKEN|PASSWORD|PRIVATE|DATABASE/i.test(name)) error(`${name} looks like a secret but NEXT_PUBLIC_ variables are sent to the browser`);
  else warn(`${name} is exposed to the browser (NEXT_PUBLIC_); make sure it is not secret`);
}
for (const [name, value] of Object.entries(env)) {
  if (name.startsWith("NEXT_PUBLIC_") && /^(sk|rk)_(live|test)_|^whsec_|Secret_Key_|postgres(ql)?:\/\//.test(value || "")) error(`${name} contains a server secret`);
}
if (stripeKey && !isLiveStripe && !isTestStripe) error("STRIPE_SECRET_KEY is not a Stripe secret/restricted key (sk_… / rk_…)");
if (/^pk_/.test(stripeKey)) error("STRIPE_SECRET_KEY holds a publishable key (pk_…); it needs the secret or restricted key");
if (!["sandbox", "live"].includes(paypalMode)) error("PAYPAL_MODE must be sandbox or live");
if (get("AUTH_SECRET") && get("AUTH_SECRET").length < 32) error("AUTH_SECRET must be at least 32 characters");

if (profile === "local") {
  // ── Local: test / sandbox only ───────────────────────────────────────────────
  require_(["DATABASE_URL", "AUTH_SECRET", "STRIPE_SECRET_KEY", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]);
  if (isLiveStripe) error("STRIPE_SECRET_KEY is a LIVE key; local development must use sk_test_…");
  if (!has("STRIPE_WEBHOOK_SECRET")) warn("STRIPE_WEBHOOK_SECRET is a placeholder: the local Stripe webhook will be refused (use `stripe listen` to get one); the success page still confirms payments");
  if (paypalMode === "live") error("PAYPAL_MODE=live; local development must use the PayPal sandbox");
  if (!has("POD_ORDER_MODE") || podMode !== "draft") error("POD_ORDER_MODE must be explicitly set to draft for local development");
  LIVE_ONLY.filter(has).forEach((n) => error(`${n} is a live/production-only variable; remove it from local env files`));
  if (has("PRODIGI_SANDBOX_API_KEY") && !/^test_/.test(get("PRODIGI_SANDBOX_API_KEY"))) warn("PRODIGI_SANDBOX_API_KEY does not look like a Prodigi sandbox key (test_…)");
  require_(["PRODIGI_SANDBOX_API_KEY", "PRINTEERS_V1_TEST_PARTNER_CODE", "PRINTEERS_V1_TEST_API_KEY", "GELATO_API_KEY", "PRINTFUL_PRIVATE_TOKEN"], warn);
  if (has("GELATO_API_KEY") || has("PRINTFUL_PRIVATE_TOKEN")) warn("Gelato / Printful have no sandbox: their keys reach real accounts (drafts only while POD_ORDER_MODE=draft)");
} else {
  // ── Production: live only ────────────────────────────────────────────────────
  require_(["DATABASE_URL", "AUTH_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "POD_WEBHOOK_SECRET", "CRON_SECRET", "PRODIGI_API_KEY", "GELATO_API_KEY", "PRINTFUL_PRIVATE_TOKEN", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]);
  if (stripeKey && !isLiveStripe) error("STRIPE_SECRET_KEY is not a live key (sk_live_… / rk_live_…)");
  if (has("STRIPE_WEBHOOK_SECRET") && !/^whsec_/.test(get("STRIPE_WEBHOOK_SECRET"))) error("STRIPE_WEBHOOK_SECRET is not a Stripe signing secret (whsec_…)");
  if (paypalMode !== "live") error("PAYPAL_MODE must be \"live\" in production (it defaults to sandbox when unset)");
  if (!has("POD_ORDER_MODE") || podMode !== "live") error("POD_ORDER_MODE must be explicitly set to live in production; refusing a sandbox/draft fallback");
  if (/^test_/.test(get("PRODIGI_API_KEY") || "")) error("PRODIGI_API_KEY is a Prodigi sandbox key (test_…)");
  const v2 = (get("PRINTEERS_API_VERSION") || "").toLowerCase() === "v2";
  if (v2) { require_(["PRINTEERS_API_KEY"]); if (has("PRINTEERS_API_KEY") && !/^Secret_Key_/.test(get("PRINTEERS_API_KEY"))) error("PRINTEERS_API_KEY is not a Printeers v2 secret key (Secret_Key_…)"); }
  else require_(["PRINTEERS_V1_PARTNER_CODE", "PRINTEERS_V1_API_KEY"]);
  require_(["PRINTEERS_WEBHOOK_SECRET"], warn);
  TEST_ONLY.filter(has).forEach((n) => error(`${n} is a test/sandbox-only variable; do not set it in production`));
  if (has("ORDER_EMAIL_TEST_RECIPIENT")) warn("ORDER_EMAIL_TEST_RECIPIENT is set; it is only used for test payments");
  if (!/^https:\/\//.test(appUrl) || /localhost|127\.0\.0\.1/.test(appUrl)) error("NEXT_PUBLIC_APP_URL / APP_URL must be the public https address");
  for (const name of ["PRODIGI_BASE_URL", "GELATO_BASE_URL", "PRINTFUL_BASE_URL", "PRINTEERS_BASE_URL", "PRINTEERS_V2_BASE_URL"]) {
    if (has(name) && /sandbox|test-printeers|api\.test\.|localhost|127\.0\.0\.1/i.test(get(name))) error(`${name} points to a test/sandbox endpoint in production`);
  }
  if ((get("POD_WEBHOOK_SECRET") || "").length && get("POD_WEBHOOK_SECRET").length < 24) error("POD_WEBHOOK_SECRET must be at least 24 characters");
  require_(["PAYPAL_WEBHOOK_ID"], warn);
  require_(["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"], warn);
  // Production must not share secrets or the database with local development (compared, never printed).
  for (const localName of [".env", ".env.local"]) {
    const localFile = path.join(root, localName);
    if (!existsSync(localFile)) continue;
    const local = parseFile(localFile);
    for (const name of ["DATABASE_URL", "AUTH_SECRET", "POD_WEBHOOK_SECRET", "CRON_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PAYPAL_CLIENT_ID"]) {
      if (has(name) && local[name] && local[name].trim() === get(name)) error(`${name} is the same as in ${localName}${name === "DATABASE_URL" ? " (production and local development must use separate databases)" : ""}`);
    }
  }
}

console.log(`Environment check · profile: ${profile} · source: ${source}`);
for (const msg of errors) console.log(`  ✗ ${msg}`);
for (const msg of warnings) console.log(`  ! ${msg}`);
if (!errors.length) console.log(`  ✓ no errors${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})` : ""}`);
process.exit(errors.length ? 1 : 0);
