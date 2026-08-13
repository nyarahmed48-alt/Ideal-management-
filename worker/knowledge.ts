/**
 * What Ideal AI knows about the site.
 *
 * Rather than hand-maintaining a copy of the site's content inside a prompt —
 * which goes stale the first time someone edits a page — the assistant reads
 * the pages themselves. Edit the HTML, push, and it knows the new wording.
 *
 * On Workers the pages come through the ASSETS binding: the same files the
 * visitor is served, read without leaving the edge. No network call, no
 * cold-start latency, and no way for it to disagree with what was deployed.
 * (The previous host read them off the function's filesystem for the same
 * reason. An earlier version crawled the live site over HTTP and returned zero
 * pages in production while reporting nothing about why — hence `note`.)
 */

import type { Env } from "./env";

/** Pages held between requests on a warm isolate. A cold start re-reads. */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Bounds, so a mistake cannot eat the request or the context window. */
const MAX_PAGES = 8;
const MAX_DEPTH = 2;
const MAX_CHARS_PER_PAGE = 6_000;
const MAX_TOTAL_CHARS = 14_000;

export interface SitePage {
  path: string;
  title: string;
  text: string;
}

export interface SiteKnowledge {
  pages: SitePage[];
  source: "assets" | "cache" | "none";
  readAt: string | null;
  /** How it went, in words — the thing whose absence made this hard to debug. */
  note: string;
}

let cache: { at: number; pages: SitePage[]; note: string } | null = null;

/**
 * Facts we will not let a read failure take away. Given to the model verbatim,
 * above the page text, so a phone number cannot be garbled by HTML extraction.
 */
export const CONTACT_FACTS = `
Phone and WhatsApp: +964 772 252 1000
Email: imanagement19@gmail.com
Company: Ideal Management — recruitment, HR and business management.
`.trim();

const DECODE: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&times;": "×",
  "&hellip;": "…",
};

/** HTML → readable text. Not a parser: a marketing page does not need one, and
 *  a regex that only ever deletes markup cannot produce broken markup. */
function toText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|li|h[1-6]|tr|br|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (entity) => DECODE[entity.toLowerCase()] ?? " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();
}

/** The page's own content, without the header and footer repeated on every one. */
const bodyOf = (html: string) => html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;

const titleOf = (html: string) => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? toText(match[1]).slice(0, 120) : "";
};

/** Same-origin page links worth following. Skips assets, anchors and the API. */
function linksIn(html: string, origin: string, from: string): string[] {
  const found = new Set<string>();

  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;

    let url: URL;
    try {
      url = new URL(raw, from);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) continue;
    // A confirmation page teaches the assistant nothing about the business.
    if (url.pathname.startsWith("/thanks")) continue;
    if (/\.[a-z0-9]+$/i.test(url.pathname) && !/\.html?$/i.test(url.pathname)) continue;

    url.hash = "";
    url.search = "";
    found.add(url.toString());
  }

  return [...found];
}

/** The site's pages, from cache when fresh. Never throws. */
export async function getSiteKnowledge(env: Env, origin: string): Promise<SiteKnowledge> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return {
      pages: cache.pages,
      source: "cache",
      readAt: new Date(cache.at).toISOString(),
      note: `cached — ${cache.note}`,
    };
  }

  const pages: SitePage[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();

  let frontier = [new URL("/", origin).toString()];
  seen.add(frontier[0]);

  try {
    for (let depth = 0; depth <= MAX_DEPTH && frontier.length && pages.length < MAX_PAGES; depth += 1) {
      const batch = frontier.slice(0, MAX_PAGES - pages.length);
      const fetched = await Promise.all(
        batch.map(async (url) => {
          try {
            const response = await env.ASSETS.fetch(new Request(url));
            if (!response.ok) return { url, error: `HTTP ${response.status}` };
            return { url, html: await response.text() };
          } catch (error: any) {
            return { url, error: String(error?.message || error) };
          }
        }),
      );

      const next: string[] = [];
      for (const { url, html, error } of fetched) {
        if (!html) {
          failures.push(`${new URL(url).pathname}: ${error || "no body"}`);
          continue;
        }

        const text = toText(bodyOf(html));
        if (text) {
          pages.push({
            path: new URL(url).pathname,
            title: titleOf(html),
            text: text.slice(0, MAX_CHARS_PER_PAGE),
          });
        }

        for (const link of linksIn(html, new URL(origin).origin, url)) {
          if (!seen.has(link)) {
            seen.add(link);
            next.push(link);
          }
        }
      }
      frontier = next;
    }
  } catch (error) {
    return { pages: [], source: "none", readAt: null, note: `read threw: ${error}` };
  }

  if (!pages.length) {
    return {
      pages: [],
      source: "none",
      readAt: null,
      note: `no pages read — ${failures.join("; ") || "nothing reached"}`,
    };
  }

  const note = `read ${pages.length} page(s) from the deployed assets`;
  cache = { at: Date.now(), pages, note };
  return { pages, source: "assets", readAt: new Date(cache.at).toISOString(), note };
}

/** The pages as one block of prompt text, within the total cap. */
export function knowledgeToPrompt(pages: SitePage[]): string {
  let budget = MAX_TOTAL_CHARS;
  const blocks: string[] = [];

  for (const page of pages) {
    if (budget <= 200) break;
    const block = `### Page: ${page.path}${page.title ? ` — ${page.title}` : ""}\n${page.text.slice(0, budget)}`;
    blocks.push(block);
    budget -= block.length;
  }

  return blocks.join("\n\n");
}
