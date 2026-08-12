/**
 * Where the model provider's settings come from.
 *
 * Shared by both functions so the two can never disagree about which
 * environment variable holds what — a disagreement that is invisible from the
 * outside and looks exactly like a missing key.
 */

/**
 * The API key.
 *
 * OPENROUTER_API_KEY is the documented name, but OPENROUTER_KEY is the obvious
 * thing to type, and getting it wrong costs a full redeploy to discover — the
 * function simply reports "not configured" while the key sits right there in
 * the dashboard under a name nothing reads. Accept both: a key present under a
 * near-miss name is a naming disagreement, not a configuration to refuse.
 */
export const readApiKey = (): string | undefined =>
  Netlify.env.get("OPENROUTER_API_KEY") || Netlify.env.get("OPENROUTER_KEY");

/** Which name the key was found under, for the health report to name. */
export const apiKeyVariable = (): string | null =>
  Netlify.env.get("OPENROUTER_API_KEY")
    ? "OPENROUTER_API_KEY"
    : Netlify.env.get("OPENROUTER_KEY")
      ? "OPENROUTER_KEY (accepted alias of OPENROUTER_API_KEY)"
      : null;
