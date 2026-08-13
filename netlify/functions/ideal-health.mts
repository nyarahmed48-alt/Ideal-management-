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
import { buildSystemPrompt } from "../../lib/prompt.mts";
import { apiKeyVariable, readApiKey } from "../../lib/provider.mts";

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
    /* The catalogue is public. Sending the key made it answer 400 in
       production, so ask for it the way it expects — unauthenticated — and
       only fall back to the authenticated form if that is what works. */
    let response = await fetch(`${base}/models`, { signal: abort.signal });
    if (!response.ok) {
      response = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: abort.signal,
      });
    }
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

/**
 * A probe built the way the chat endpoint builds its calls: same system prompt
 * with the site pages in it, same temperature, same attribution headers.
 *
 * The minimal probe above answers "is the key good and the model id real".
 * This one answers "does an actual conversation work" — which is the question
 * a visitor is really asking, and the two can disagree. A model that accepts a
 * bare 8-token ping can still reject the temperature parameter, or fall over a
 * long system prompt. Small max_tokens keeps it cheap; the request shape, not
 * the reply length, is what is under test.
 */
async function chatShapedProbe(
  base: string,
  apiKey: string,
  model: string,
  system: string,
  siteUrl: string,
) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": siteUrl,
        "x-title": "Ideal Management",
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          { role: "user", content: "In one short sentence, what does Ideal Management do?" },
        ],
      }),
      signal: abort.signal,
    });

    const body = await response.text();
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      console.warn(`Ideal AI chat-probe: ${response.status} — ${body.slice(0, 400)}`);
      return {
        ok: false,
        status: response.status,
        latencyMs,
        systemPromptChars: system.length,
        hint: /temperature/i.test(body)
          ? "the model rejected the temperature parameter"
          : /context|token|too long|maximum/i.test(body)
            ? "the system prompt is too long for this model's context window"
            : "see the function log for the provider's own wording",
      };
    }

    let payload: any = null;
    try {
      payload = JSON.parse(body);
    } catch {
      /* Fall through: an unparseable 200 is still a failure to answer. */
    }
    // A provider-side failure can arrive inside a 200, which is exactly the
    // shape that makes a chat widget look broken while health looks fine.
    if (payload?.error) {
      console.warn(`Ideal AI chat-probe: 200 with error — ${body.slice(0, 400)}`);
      return { ok: false, status: 200, latencyMs, systemPromptChars: system.length, hint: "provider returned an error inside a 200" };
    }
    const reply = String(payload?.choices?.[0]?.message?.content ?? "").trim();
    return {
      ok: Boolean(reply),
      status: response.status,
      latencyMs,
      systemPromptChars: system.length,
      replyChars: reply.length,
      ...(reply ? {} : { hint: "the model answered with an empty completion — the chat treats that as a failure too" }),
    };
  } catch (error: any) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      systemPromptChars: system.length,
      hint: abort.signal.aborted ? `no answer within ${PROBE_TIMEOUT_MS}ms` : String(error?.message || error),
    };
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

  const apiKey = readApiKey();
  // A key set under a name the code does not read is invisible from the
  // outside: it looks identical to no key at all. So name the one it found.
  const keyVariable = apiKeyVariable();

  const models = (Netlify.env.get("OPENROUTER_MODEL") || DEFAULT_MODEL)
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  // What the assistant knows is half of whether it works, so report it first:
  // a bot answering "I don't know" with a healthy key is usually an empty crawl.
  /* The origin the visitor actually reached is the one guaranteed to be live
     and correct; the configured URL is only a fallback for when there is no
     request to learn it from. */
  const params = new URL(request.url).searchParams;
  const siteUrl = new URL(request.url).origin || context.site?.url || Netlify.env.get("URL") || "";
  const knowledge = await getSiteKnowledge(siteUrl);

  const report: Record<string, unknown> = {
    service: "ideal-ai",
    keyConfigured: Boolean(apiKey),
    keyVariable,
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

  /* ?models=1 lists the free ids the provider publishes, whatever state we are
     in. It used to appear only after a model-class failure, which is no use
     when the failure is a provider-side 429 and what you need right now is a
     second id to fall back to. The catalogue is public and costs no quota. */
  if (params.get("models") === "1") {
    const base = (Netlify.env.get("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    report.availableFreeModels = await freeModelIds(base, apiKey || "", models[0]);
  }

  if (!apiKey) {
    report.state = "not-configured";
    report.detail = "No key on this deployment — set OPENROUTER_API_KEY (or OPENROUTER_KEY).";
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
      /* The simple probe passing is not the same as the chat working, so say
         so explicitly rather than letting "ok" imply more than it proves.

         Behind ?deep=1 because it costs a second provider call, and on a free
         tier the request budget is the scarce thing — a health check that
         quietly doubles the burn rate is how you exhaust the quota you are
         trying to diagnose. */
      if (params.get("deep") === "1") {
      report.chatProbe = await chatShapedProbe(
        base,
        apiKey,
        models[0],
        buildSystemPrompt(knowledge.pages),
        siteUrl,
      );
      if (!(report.chatProbe as any).ok) {
        report.state = "chat-failing";
        report.detail =
          "The key and model id are fine, but a request shaped like a real conversation fails. See chatProbe.hint.";
      }
      } else {
        report.chatProbe = "skipped — add ?deep=1 to test a full chat-shaped request (costs one more provider call)";
      }
    } else if (response.status === 401 || response.status === 403) {
      report.state = "auth";
      report.detail = "The key was rejected — it may be revoked or lack permission for this model.";
    } else if (response.status === 402 || response.status === 429) {
      report.state = "quota";
      report.detail =
        "Rate limited or out of credit — not a broken configuration. Free model variants cap how many requests an account may make per day, and that cap is shared across every ':free' id, so adding a second free model does not raise it. It resets on the provider's schedule; adding credit or using a paid id removes the ceiling. Check the account's limits and activity pages for the current figures.";
    } else if (response.status === 404 || response.status === 400) {
      report.state = "model";
      report.detail = "The configured model id was not accepted. It may have been renamed or retired.";
      /* A 404 here has two very different causes that took a round trip each to
         tell apart: an id that does not exist, and a real id the account's data
         policy is not allowed to route to. The provider says which, so classify
         its wording rather than echoing it — the body can quote the request
         back, and the model id is not something this endpoint publishes. */
      report.cause = /data polic|no allowed provider|privacy|no endpoints found matching/i.test(body)
        ? "account-policy — the id is fine; the account will not route to it. Check, in this order: Settings > Privacy > Providers > Allowed Providers (an allowlist there blocks every provider not on it, which is easy to set and easy to forget), then Data Training, which free variants usually require. The Eligibility Preview on that page shows what the account can currently reach."
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
