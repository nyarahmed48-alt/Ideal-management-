/**
 * What Ideal AI knows about the site.
 *
 * Rather than hand-maintaining a copy of the site's content inside a prompt —
 * which goes stale the first time someone edits a page — the assistant reads
 * the pages themselves. Edit the HTML, redeploy, and Ideal AI knows the new
 * wording without anyone touching this code.
 *
 * It reads them two ways, in this order:
 *
 *   1. Off the deploy's own filesystem, via `included_files` in netlify.toml.
 *      No network, no latency, and it cannot disagree with what was deployed.
 *   2. By crawling the live site over HTTP, if the files are not where we
 *      expect — which also covers pages that are generated rather than shipped.
 *
 * The first attempt at this only had the crawl, and it came back with zero
 * pages on the real deployment while reporting nothing about why. Hence both
 * paths, and hence `note`: whichever way it goes, the health endpoint can say
 * what happened rather than leaving an empty result to be guessed at.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Pages held in memory between warm invocations. A cold start re-reads. */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Bounds. Every one of these exists to keep a runaway crawl from eating the
 *  function's time budget or the model's context window. */
const MAX_PAGES = 8;
const MAX_DEPTH = 2;
const PAGE_TIMEOUT_MS = 6_000;
const CRAWL_BUDGET_MS = 9_000;
const MAX_CHARS_PER_PAGE = 6_000;
const MAX_TOTAL_CHARS = 14_000;

export interface CrawledPage {
  path: string;
  title: string;
  text: string;
}

export interface SiteKnowledge {
  pages: CrawledPage[];
  /** Where the content came from, for the health endpoint to report. */
  source: "files" | "crawl" | "cache" | "none";
  crawledAt: string | null;
  /** How it went, in words — the thing whose absence made this hard to debug. */
  note: string;
}

/* Module-scope cache. Declarations only — nothing runs at import time. */
let cache: { at: number; pages: CrawledPage[]; source: "files" | "crawl"; note: string } | null = null;

/**
 * The facts we will not let a crawl failure take away. These are also given to
 * the model verbatim, above the crawled text, so a phone number can never be
 * garbled by HTML extraction going wrong.
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
    // Whole elements whose content is not prose.
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Give block boundaries a space so words do not run together.
    .replace(/<\/(p|div|section|li|h[1-6]|tr|br|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (entity) => DECODE[entity.toLowerCase()] ?? " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();
}

/**
 * The page's own content, without the header and footer that repeat on every
 * page. Left as the whole document when there is no <main> to narrow to.
 */
function bodyOf(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return main ? main[1] : html;
}

function titleOf(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? toText(match[1]).slice(0, 120) : "";
}

/** Same-origin page links worth following. Skips assets, anchors, and the API. */
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
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/")) continue;
    // Anything with an extension that is not .html is an asset, not a page.
    if (/\.[a-z0-9]+$/i.test(url.pathname) && !/\.html?$/i.test(url.pathname)) continue;

    url.hash = "";
    url.search = "";
    found.add(url.toString());
  }

  return [...found];
}

/** One page over HTTP. Returns the reason on failure rather than a bare null —
 *  an empty crawl with no explanation is what made this hard to diagnose. */
async function fetchPage(url: string): Promise<{ html?: string; error?: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      redirect: "follow",
      headers: { "user-agent": "IdealAI-SiteReader/1.0", accept: "text/html" },
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };

    /* Only reject a content type we can positively identify as non-HTML. The
       first version required a text/html header and treated a missing or
       unusual one as a failure, which is one of the ways a crawl can come back
       empty while every page is in fact fine. */
    const type = response.headers.get("content-type") || "";
    if (type && !/text\/html|application\/xhtml/i.test(type)) {
      return { error: `content-type ${type}` };
    }
    return { html: await response.text() };
  } catch (error: any) {
    return { error: abort.signal.aborted ? `timeout after ${PAGE_TIMEOUT_MS}ms` : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The deployed HTML, read straight off disk.
 *
 * netlify.toml ships `public/**` with the functions via `included_files`, but
 * the working directory a function runs in is not something to take on faith,
 * so try the handful of roots it could plausibly be and use the first that has
 * pages in it.
 */
async function readLocalPages(): Promise<{ pages: CrawledPage[]; note: string }> {
  const roots = [
    process.env.LAMBDA_TASK_ROOT ? path.join(process.env.LAMBDA_TASK_ROOT, "public") : null,
    path.join(process.cwd(), "public"),
    path.join(process.cwd(), "..", "public"),
  ].filter((root): root is string => Boolean(root));

  const tried: string[] = [];

  for (const root of roots) {
    let names: string[];
    try {
      names = (await readdir(root)).filter((name: string) => /\.html?$/i.test(name));
    } catch (error: any) {
      tried.push(`${root} (${error?.code || "unreadable"})`);
      continue;
    }
    if (!names.length) {
      tried.push(`${root} (no .html)`);
      continue;
    }

    // index.html first: it is the page most questions are really about.
    names.sort((a, b) => (a.startsWith("index.") ? -1 : b.startsWith("index.") ? 1 : a.localeCompare(b)));

    const pages: CrawledPage[] = [];
    for (const name of names.slice(0, MAX_PAGES)) {
      try {
        const html = await readFile(path.join(root, name), "utf-8");
        const text = toText(bodyOf(html));
        if (!text) continue;
        pages.push({
          // The URL a visitor sees, not the filename on disk.
          path: "/" + name.replace(/index\.html?$/i, "").replace(/\.html?$/i, ""),
          title: titleOf(html),
          text: text.slice(0, MAX_CHARS_PER_PAGE),
        });
      } catch {
        /* One unreadable page should not lose the others. */
      }
    }

    if (pages.length) return { pages, note: `read ${pages.length} page(s) from ${root}` };
    tried.push(`${root} (no readable pages)`);
  }

  return { pages: [], note: `no local pages: ${tried.join("; ")}` };
}

/**
 * Breadth-first crawl of the site's own pages, starting at the homepage.
 * Returns whatever it managed to read — a partial crawl still beats none.
 */
async function crawl(origin: string): Promise<{ pages: CrawledPage[]; note: string }> {
  const deadline = Date.now() + CRAWL_BUDGET_MS;
  const seen = new Set<string>();
  const pages: CrawledPage[] = [];
  const failures: string[] = [];

  let frontier = [new URL("/", origin).toString()];
  seen.add(frontier[0]);

  for (let depth = 0; depth <= MAX_DEPTH && frontier.length && pages.length < MAX_PAGES; depth += 1) {
    if (Date.now() >= deadline) break;

    const batch = frontier.slice(0, MAX_PAGES - pages.length);
    // One level at a time, in parallel: eight small pages should not cost
    // eight round trips of latency.
    const fetched = await Promise.all(batch.map(async (url) => ({ url, ...(await fetchPage(url)) })));

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

  const note = pages.length
    ? `crawled ${pages.length} page(s) from ${origin}`
    : `crawl of ${origin} found nothing — ${failures.join("; ") || "no pages reached"}`;
  return { pages, note };
}

/**
 * The site's pages, from cache when fresh. Disk first, then the network.
 * Never throws: a assistant that cannot read the site still answers from the
 * contact facts, it just says less.
 */
export async function getSiteKnowledge(origin: string | undefined): Promise<SiteKnowledge> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return {
      pages: cache.pages,
      source: "cache",
      crawledAt: new Date(cache.at).toISOString(),
      note: `cached — ${cache.note}`,
    };
  }

  const notes: string[] = [];

  try {
    const local = await readLocalPages();
    if (local.pages.length) {
      cache = { at: Date.now(), pages: local.pages, source: "files", note: local.note };
      return { pages: local.pages, source: "files", crawledAt: new Date(cache.at).toISOString(), note: local.note };
    }
    notes.push(local.note);
  } catch (error) {
    notes.push(`local read failed: ${error}`);
  }

  if (!origin) {
    return { pages: [], source: "none", crawledAt: null, note: [...notes, "no origin to crawl"].join(" | ") };
  }

  try {
    const crawled = await crawl(origin);
    notes.push(crawled.note);
    if (crawled.pages.length) {
      cache = { at: Date.now(), pages: crawled.pages, source: "crawl", note: crawled.note };
      return {
        pages: crawled.pages,
        source: "crawl",
        crawledAt: new Date(cache.at).toISOString(),
        note: notes.join(" | "),
      };
    }
  } catch (error) {
    notes.push(`crawl threw: ${error}`);
  }

  console.warn("Ideal AI: no site knowledge —", notes.join(" | "));
  return { pages: [], source: "none", crawledAt: null, note: notes.join(" | ") };
}

/** The crawled pages as one block of prompt text, within the total cap. */
export function knowledgeToPrompt(pages: CrawledPage[]): string {
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
