/**
 * Open this when Ideal AI goes quiet.
 *
 * It makes one real call down the same path the chat widget uses, and crawls
 * the site the same way, then says which half failed — so a missing key, an
 * exhausted free tier, a retired model id and a site the crawler cannot read
 * are told apart from a browser instead of guessed at.
 *
 * When the configured id is rejected it also asks the provider which free ids
 * it actually publishes, and lists some. Guessing model ids from memory is how
 * this endpoint came to exist: they are renamed and retired constantly, and
 * ":free" is part of an id rather than a suffix that can be appended to any
 * model. A list from the provider itself ends the guessing.
 *
 * Safe to leave public: it returns states, status codes, page paths and ids
 * from the provider's public catalogue. Never the key, never the configured
 * model id, never the provider's own error text.
 */

import type { Config, Context } from "@netlify/functions";
import { getSiteKnowledge } from "../../lib/knowledge.mts";

const DEFAULT_MODEL = "poolside/laguna-xs-2.1:free";
const PROBE_TIMEOUT_MS = 12_000;
const CATALOGUE_TIMEOUT_MS = 8_000;
const SUGGESTIONS = 12;

/**
 * Free model ids the provider currently publishes, and whether the configured
 * one is among them — which separates "no such id" from "real id, blocked by
 * policy" with no ambiguity left in it.
 */
async function freeModelIds(base: string, apiKey: string, configured: string) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CATALOGUE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: abort.signal,
    });
    if (!response.ok) return { error: `catalogue lookup returned ${response.status}` };

    const payload: any = await response.json();
    const all: string[] = (payload?.data ?? [])
      .map((model: any) => String(model?.id ?? ""))
      .filter(Boolean);

    return {
      configuredIdExists: all.includes(configured),
      totalModels: all.length,
      free: all.filter((id) => id.endsWith(":free")).sort().slice(0, SUGGESTIONS),
    };
  } catch (error: any) {
    return { error: abort.signal.aborted ? "catalogue lookup timed out" : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export default async (request: Request, context: Context) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "GET" },
    });
  }

  const apiKey = Netlify.env.get("OPENROUTER_API_KEY");
  const models = (Netlify.env.get("OPENROUTER_MODEL") || DEFAULT_MODEL)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  // What the assistant knows is half of whether it works, so report it first:
  // a bot answering "I don't know" with a healthy key is usually an empty crawl.
  /* The origin the visitor actually reached is the one guaranteed to be live
     and correct; the configured URL is only a fallback for when there is no
     request to learn it from. */
  const siteUrl = new URL(request.url).origin || context.site?.url || Netlify.env.get("URL");
  const knowledge = await getSiteKnowledge(siteUrl);

  const report: Record<string, unknown> = {
    service: "ideal-ai",
    keyConfigured: Boolean(apiKey),
    modelsConfigured: models.length,
    knowledge: {
      source: knowledge.source,
      pagesIndexed: knowledge.pages.length,
      paths: knowledge.pages.map((page) => page.path),
      characters: knowledge.pages.reduce((total, page) => total + page.text.length, 0),
      crawledAt: knowledge.crawledAt,
      // Says why when pagesIndexed is 0, instead of leaving it to be guessed at.
      note: knowledge.note,
    },
    checkedAt: new Date().toISOString(),
  };

  if (!apiKey) {
    report.state = "not-configured";
    report.detail = "OPENROUTER_API_KEY is not set on this deployment.";
    return new Response(JSON.stringify(report, null, 2), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const base = (Netlify.env.get("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-title": "Ideal Management",
      },
      body: JSON.stringify({
        model: models[0],
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
      signal: abort.signal,
    });

    const body = await response.text();

    report.latencyMs = Date.now() - startedAt;
    report.status = response.status;

    if (response.ok) {
      report.state = "ok";
    } else if (response.status === 401 || response.status === 403) {
      report.state = "auth";
      report.detail = "The key was rejected — it may be revoked or lack permission for this model.";
    } else if (response.status === 402 || response.status === 429) {
      report.state = "quota";
      report.detail = "Out of credit or over the free daily cap. It should recover, or set a paid model id.";
    } else if (response.status === 404 || response.status === 400) {
      report.state = "model";
      report.detail = "The configured model id was not accepted. It may have been renamed or retired.";
      /* A 404 here has two very different causes that took a round trip each to
         tell apart: an id that does not exist, and a real id the account's data
         policy is not allowed to route to. The provider says which, so classify
         its wording rather than echoing it — the body can quote the request
         back, and the model id is not something this endpoint publishes. */
      report.cause = /data polic|no allowed provider|privacy/i.test(body)
        ? "data-policy — the account's Data Training / privacy settings do not permit routing to this model. Free variants usually require Data Training to be enabled."
        : /no endpoints|not a valid model|model not found|unknown model/i.test(body)
          ? "unknown-model — the provider has no such id. Copy one from `availableFreeModels` below; a ':free' suffix only works on models that publish a free variant."
          : "unclassified — see the function log for the provider's own wording.";

      /* Only on a model-class failure, and only then: an extra call on every
         health check would be waste, and this is exactly when it earns itself. */
      report.availableFreeModels = await freeModelIds(base, apiKey, models[0]);
    } else {
      report.state = "upstream";
      report.detail = "The provider answered with an error.";
    }

    // The provider's own text, for the logs only. Never the response body.
    if (!response.ok) console.warn(`Ideal AI health: ${response.status} — ${body.slice(0, 400)}`);
  } catch (error: any) {
    report.latencyMs = Date.now() - startedAt;
    report.state = abort.signal.aborted ? "timeout" : "network";
    report.detail = abort.signal.aborted
      ? `No answer within ${PROBE_TIMEOUT_MS}ms.`
      : "Could not reach the provider from this deployment.";
  } finally {
    clearTimeout(timer);
  }

  return new Response(JSON.stringify(report, null, 2), {
    // A cached health check is a lie, so say so to every hop.
    status: report.state === "ok" ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

export const config: Config = {
  path: "/api/ideal-health",
};
