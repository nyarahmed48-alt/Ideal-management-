/**
 * The Worker's bindings and settings.
 *
 * Everything configurable lives here so there is one place to look, and so the
 * two names a key might plausibly be stored under are resolved once rather than
 * in each route.
 */

export interface Env {
  /** The static site in `public/`, fetchable from Worker code. */
  ASSETS: Fetcher;
  /** Form submissions and their CVs. Optional so the site can deploy before
   *  storage is wired up; the form route refuses clearly when it is missing. */
  SUBMISSIONS?: KVNamespace;
  /** Optional. If R2 is enabled and bound, files go here instead of KV. */
  UPLOADS?: R2Bucket;

  /** Secret. Set in the dashboard, never in the repo. */
  OPENROUTER_API_KEY?: string;
  /** Accepted alias — an easy name to reach for, and a costly one to get wrong. */
  OPENROUTER_KEY?: string;
  /** Comma-separated model ids, tried in order. Editable in the dashboard. */
  OPENROUTER_MODEL?: string;
  /** Optional. Point the calls at a proxy or a stand-in endpoint. */
  OPENROUTER_BASE_URL?: string;

  /** Secret. Password for /admin. Without it, /admin refuses to open at all. */
  ADMIN_PASSWORD?: string;
  /** Optional secret. With it, submissions are emailed as well as stored. */
  RESEND_API_KEY?: string;
  /** Where submission emails go. Defaults to the address on the site. */
  NOTIFY_EMAIL?: string;
  /** The From address Resend sends as. Must be a domain verified with Resend. */
  NOTIFY_FROM?: string;
}

/** The model provider key, under either name it may have been saved as. */
export const apiKey = (env: Env) => env.OPENROUTER_API_KEY || env.OPENROUTER_KEY;

/** Which name it was found under, so a mismatch is visible rather than inferred. */
export const apiKeyVariable = (env: Env) =>
  env.OPENROUTER_API_KEY
    ? "OPENROUTER_API_KEY"
    : env.OPENROUTER_KEY
      ? "OPENROUTER_KEY (accepted alias of OPENROUTER_API_KEY)"
      : null;

/* Model ids get renamed and retired, which is why this is a variable rather
   than a constant: changing it is a dashboard edit that takes effect at once.

   This id was verified live on 2026-08-12. It once looked dead — every call
   404'd — but the id was fine and the account had an Allowed Providers
   allowlist excluding its provider. Before swapping ids again: a 404 here is at
   least as likely to be an account setting, and /api/ideal-health says which. */
const DEFAULT_MODEL = "poolside/laguna-xs-2.1:free";

/** The model ids to try, in order. */
export const models = (env: Env) =>
  (env.OPENROUTER_MODEL || DEFAULT_MODEL)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

export const providerBase = (env: Env) =>
  (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

export const CONTACT = {
  phone: "+964 772 252 1000",
  email: "imanagement19@gmail.com",
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
