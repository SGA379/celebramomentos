// Gelato and Printful have no separate test account: the keys used by local development reach the same live
// accounts as production. So nothing outside production may create, confirm, cancel or change anything there:
// - a request that could change the account (anything but a read, and the read-only POSTs listed below) is
//   only made by the production deployment (VERCEL_ENV=production, not preview) running in live mode with
//   POD_ORDER_MODE=live set explicitly; everywhere else it is refused before it leaves the server;
// - local / preview "submissions" are dry runs: the order is validated with the provider's own read-only check
//   (Gelato order quote, Printful cost estimate), nothing is created, and the print order gets a simulated id
//   (DRY_RUN_PREFIX) that is never sent to the provider.
// Prodigi and Printeers have real sandboxes / test environments with their own keys and are not affected.
import { podEnvironmentProblem, podMode } from "./config";
import { PodApiError } from "./http";

export const DRY_RUN_PREFIX = "dryrun_";
export const isDryRunOrder = (providerOrderId: string | null | undefined) => Boolean(providerOrderId?.startsWith(DRY_RUN_PREFIX));

export type GuardedProvider = "GELATO" | "PRINTFUL";
const LABEL: Record<GuardedProvider, string> = { GELATO: "Gelato", PRINTFUL: "Printful" };

// POST endpoints that only read or calculate (they create nothing).
const READ_ONLY_POSTS: Record<GuardedProvider, RegExp[]> = {
  GELATO: [/^\/v4\/orders:search$/, /^\/v4\/orders:quote$/],
  PRINTFUL: [/^\/orders\/estimate-costs$/],
};

// Whether this server may change anything in the Gelato / Printful accounts: only the production deployment in
// live mode, configured explicitly.
export function providerWritesAllowed() {
  return process.env.VERCEL_ENV === "production" && podMode() === "live" && podEnvironmentProblem() === null;
}

export function isReadOnlyRequest(provider: GuardedProvider, method: string | undefined, path: string) {
  const verb = (method || "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD") return true;
  return verb === "POST" && READ_ONLY_POSTS[provider].some((pattern) => pattern.test(path.split("?")[0]));
}

// Throws (before anything is sent) for a request that could change the provider account, outside production.
export function assertProviderRequestAllowed(provider: GuardedProvider, method: string | undefined, path: string) {
  if (isReadOnlyRequest(provider, method, path) || providerWritesAllowed()) return;
  const label = LABEL[provider];
  throw new PodApiError(provider, null, `Blocked: this is not the production site, so it never creates, confirms, cancels or changes anything in the ${label} account (${(method || "GET").toUpperCase()} ${path.split("?")[0]}). Test orders are validated with a dry run instead.`, false);
}
