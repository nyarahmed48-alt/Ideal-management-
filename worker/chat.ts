/**
 * Ideal AI — the chat endpoint behind the circle in the corner of every page.
 *
 * The browser never talks to the model provider directly: that would mean
 * shipping the API key to every visitor. This route is the only thing holding
 * it, and it reads it from the environment.
 */

import { apiKey, json, models, providerBase, type Env } from "./env";
import { getSiteKnowledge } from "./knowledge";
import { buildSystemPrompt } from "./prompt";

/** Replies are short by design — a front desk, not an essayist. */
const MAX_TOKENS = 700;
/** Longest message we forward. Past this it is a paste, not a question. */
const MAX_MESSAGE_CHARS = 800;
/** Turns of context accepted from the client. */
const MAX_HISTORY_TURNS = 10;

const ATTEMPT_TIMEOUT_MS = 20_000;

/** What the visitor sees when a call fails. Provider error strings never reach
 *  the browser: they can quote the prompt back. */
const FALLBACK_MESSAGE =
  "I can't reach my assistant service at the moment. Please try again shortly, or contact us directly — +964 772 252 1000 or imanagement19@gmail.com.";

/* A rate limit is not an outage, and "I can't reach my service" reads as a dead
   website. Free tiers cap requests, so this is the failure a visitor is most
   likely to actually meet. */
const BUSY_MESSAGE =
  "I've hit my limit of questions for now, so I can't answer this one. Please try again a bit later — or contact us directly on +964 772 252 1000 or imanagement19@gmail.com and a person will help you straight away.";

const NOT_CONFIGURED_MESSAGE =
  "Ideal AI isn't switched on for this deployment yet. Call or WhatsApp +964 772 252 1000, or email imanagement19@gmail.com, and one of our consultants will help you directly.";

/** Worth trying the next model id for. A bad key fails identically on all of
 *  them; a busy provider or an exhausted free tier does not. */
const worthRetrying = (status: number | null) =>
  status === null || status === 429 || status === 402 || status === 404 || status >= 500;

async function callModel(
  env: Env,
  model: string,
  system: string,
  messages: Array<{ role: string; content: string }>,
  key: string,
  siteUrl: string,
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ATTEMPT_TIMEOUT_MS);

  try {
    const response = await fetch(`${providerBase(env)}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "http-referer": siteUrl,
        "x-title": "Ideal Management",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0.4,
        messages: [{ role: "system", content: system }, ...messages],
      }),
      signal: abort.signal,
    });

    const raw = await response.text();
    let payload: any = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* A gateway in front of the provider can answer HTML. Let status decide. */
    }

    if (!response.ok) {
      throw Object.assign(
        new Error(`${model} → ${response.status}: ${payload?.error?.message || response.statusText}`),
        { status: response.status },
      );
    }
    // A provider-side failure can arrive inside a 200.
    if (payload?.error) {
      throw Object.assign(new Error(`${model}: ${payload.error.message || "provider error"}`), {
        status: Number(payload.error.code) || 502,
      });
    }

    return String(payload?.choices?.[0]?.message?.content ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED" }, 405, { allow: "POST" });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "BAD_JSON", message: "I couldn't read that message." }, 400);
  }

  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  if (!message) {
    return json({ error: "EMPTY_MESSAGE", message: "Ask me something and I'll do my best." }, 400);
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return json(
      {
        error: "TOO_LONG",
        message: `That's a long one — could you keep it under ${MAX_MESSAGE_CHARS} characters? For anything detailed, email imanagement19@gmail.com.`,
      },
      400,
    );
  }

  /* Rebuild the history rather than forwarding it: the client controls this
     field, and only two roles and plain strings may reach the provider. */
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const messages = history
    .filter(
      (turn: any) =>
        turn &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim(),
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((turn: any) => ({ role: turn.role, content: turn.content.slice(0, MAX_MESSAGE_CHARS) }));

  messages.push({ role: "user", content: message });

  const key = apiKey(env);
  if (!key) {
    console.warn("Ideal AI: no provider key set — answering with the unconfigured message.");
    return json({ error: "NOT_CONFIGURED", message: NOT_CONFIGURED_MESSAGE }, 503);
  }

  const siteUrl = new URL(request.url).origin;
  const knowledge = await getSiteKnowledge(env, siteUrl);
  const system = buildSystemPrompt(knowledge.pages);

  let lastStatus: number | null = null;

  for (const model of models(env)) {
    try {
      const reply = await callModel(env, model, system, messages, key, siteUrl);
      if (reply) return json({ reply }, 200);
      console.warn(`Ideal AI: ${model} returned an empty completion.`);
      lastStatus = 502;
    } catch (error: any) {
      lastStatus = typeof error?.status === "number" ? error.status : null;
      // The breadcrumb that explains an outage later. Never sent to the browser.
      console.warn(`Ideal AI: falling back past ${model} — ${error?.message || error}`);
      if (!worthRetrying(lastStatus)) break;
    }
  }

  const rateLimited = lastStatus === 429 || lastStatus === 402;
  return json(
    {
      error: rateLimited ? "RATE_LIMITED" : "UPSTREAM_FAILED",
      message: rateLimited ? BUSY_MESSAGE : FALLBACK_MESSAGE,
    },
    rateLimited ? 429 : 502,
  );
}
