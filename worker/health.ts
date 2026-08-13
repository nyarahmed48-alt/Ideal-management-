/**
 * Open this when Ideal AI goes quiet: /api/ideal-health
 *
 * It reports what the assistant knows, then makes one real call, and names
 * which half failed — so a missing key, a rate limit, a retired model id, an
 * account policy and an unreadable site are told apart from a browser rather
 * than guessed at. Every field here exists because its absence once cost a
 * round of guessing.
 *
 * Safe to leave public: states, status codes, page paths and ids from the
 * provider's public catalogue. Never the key, never the configured model id,
 * never the provider's own error text.
 *
 *   ?deep=1    also send a full chat-shaped request (one extra provider call)
 *   ?models=1  list the free model ids the provider publishes (costs no quota)
 */

import { apiKey, apiKeyVariable, json, models, providerBase, type Env } from "./env";
import { getSiteKnowledge } from "./knowledge";
import { buildSystemPrompt } from "./prompt";

const PROBE_TIMEOUT_MS = 15_000;
const SUGGESTIONS = 12;

/** Free model ids the provider publishes, and whether the configured one is
 *  among them — which separates "no such id" from "real id, blocked by the
 *  account" outright. The catalogue is public, so this costs no quota. */
async function freeModelIds(base: string, key: string, configured: string) {
  try {
    let response = await fetch(`${base}/models`);
    if (!response.ok && key) {
      response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
    }
    if (!response.ok) return { error: `catalogue lookup returned ${response.status}` };

    const payload: any = await response.json();
    const all: string[] = (payload?.data ?? []).map((m: any) => String(m?.id ?? "")).filter(Boolean);

    return {
      configuredIdExists: all.includes(configured),
      totalModels: all.length,
      free: all.filter((id) => id.endsWith(":free")).sort().slice(0, SUGGESTIONS),
    };
  } catch (error: any) {
    return { error: String(error?.message || error) };
  }
}

/**
 * A probe built the way the chat route builds its calls: same system prompt
 * with the site pages in it, same temperature, same headers.
 *
 * The simple probe answers "is the key good and the model id real". This one
 * answers "does a conversation work", and the two can disagree — a model that
 * accepts a bare ping can still reject the temperature, or fall over a long
 * system prompt. Small max_tokens keeps it cheap; the shape is what is tested.
 */
async function chatShapedProbe(base: string, key: string, model: string, system: string, siteUrl: string) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
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
            : "see the Worker log for the provider's own wording",
      };
    }

    let payload: any = null;
    try {
      payload = JSON.parse(body);
    } catch {
      /* An unparseable 200 is still a failure to answer. */
    }
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

export async function handleHealth(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "METHOD_NOT_ALLOWED" }, 405, { allow: "GET" });
  }

  const url = new URL(request.url);
  const key = apiKey(env);
  const ids = models(env);
  const base = providerBase(env);

  // What the assistant knows is half of whether it works: a bot answering
  // "I don't know" with a healthy key is usually an empty read.
  const knowledge = await getSiteKnowledge(env, url.origin);

  const report: Record<string, unknown> = {
    service: "ideal-ai",
    platform: "cloudflare-workers",
    keyConfigured: Boolean(key),
    keyVariable: apiKeyVariable(env),
    modelsConfigured: ids.length,
    submissionsStore: env.UPLOADS ? "r2" : "kv",
    adminConfigured: Boolean(env.ADMIN_PASSWORD),
    emailConfigured: Boolean(env.RESEND_API_KEY),
    knowledge: {
      source: knowledge.source,
      pagesIndexed: knowledge.pages.length,
      paths: knowledge.pages.map((page) => page.path),
      characters: knowledge.pages.reduce((total, page) => total + page.text.length, 0),
      readAt: knowledge.readAt,
      note: knowledge.note,
    },
    checkedAt: new Date().toISOString(),
  };

  if (url.searchParams.get("models") === "1") {
    report.availableFreeModels = await freeModelIds(base, key || "", ids[0]);
  }

  if (!key) {
    report.state = "not-configured";
    report.detail = "No key on this deployment — set OPENROUTER_API_KEY (or OPENROUTER_KEY) as a Secret.";
    return json(report, 503, { "cache-control": "no-store" });
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-title": "Ideal Management",
      },
      body: JSON.stringify({
        model: ids[0],
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
      /* Behind ?deep=1 because it costs a second provider call, and on a free
         tier the request budget is the scarce thing — a health check that
         quietly doubles the burn rate helps exhaust the quota it diagnoses. */
      if (url.searchParams.get("deep") === "1") {
        report.chatProbe = await chatShapedProbe(base, key, ids[0], buildSystemPrompt(knowledge.pages), url.origin);
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
        "Rate limited or out of credit — not a broken configuration. This is often the upstream provider being busy rather than your account: free capacity is shared. Listing a second model id from a different provider is what rides through it.";
    } else if (response.status === 404 || response.status === 400) {
      report.state = "model";
      report.detail = "The configured model id was not accepted.";
      /* A 404 has two causes needing opposite fixes, and each once cost a
         redeploy to rule out. The provider says which; classify its wording
         rather than echoing a body that can quote the request back. */
      report.cause = /data polic|no allowed provider|privacy|no endpoints found matching/i.test(body)
        ? "account-policy — the id is fine; the account will not route to it. Check Settings > Privacy > Providers > Allowed Providers first (an allowlist there blocks every provider not on it), then Data Training."
        : /no endpoints|not a valid model|model not found|unknown model/i.test(body)
          ? "unknown-model — the provider has no such id. Add ?models=1 for ids it does publish."
          : "unclassified — see the Worker log for the provider's own wording.";
      if (!report.availableFreeModels) {
        report.availableFreeModels = await freeModelIds(base, key, ids[0]);
      }
    } else {
      report.state = "upstream";
      report.detail = "The provider answered with an error.";
    }

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

  // A cached health check is a lie, so say so to every hop.
  return json(report, report.state === "ok" ? 200 : 503, { "cache-control": "no-store" });
}
