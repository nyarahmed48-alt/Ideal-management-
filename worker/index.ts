/**
 * Ideal Management — the Worker.
 *
 * Static files in `public/` are served by Cloudflare without waking this code
 * at all; `run_worker_first` in wrangler.jsonc lists the few paths that reach
 * here. Anything unrecognised falls through to the assets, so a typo'd API path
 * shows the site's 404 rather than a bare error.
 */

import { handleChat } from "./chat";
import type { Env } from "./env";
import { handleHealth } from "./health";
import { handleAdmin, handleSubmit } from "./submissions";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/ideal-chat") return handleChat(request, env);
    if (pathname === "/api/ideal-health") return handleHealth(request, env);
    if (pathname === "/api/submit") return handleSubmit(request, env);
    if (pathname === "/admin" || pathname.startsWith("/admin/")) return handleAdmin(request, env);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
