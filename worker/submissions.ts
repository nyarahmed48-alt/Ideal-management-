/**
 * Form submissions — the CV Pool, the employer request and the contact form.
 *
 * This replaces the previous host's built-in forms product, which Cloudflare
 * has no equivalent of. Submissions are stored in this account (KV, or R2 if a
 * bucket is bound) and readable at /admin. Email is optional on purpose: it
 * needs a third-party account, and a form that only works once someone signs up
 * for something else is a form that quietly loses applications in the meantime.
 * Set RESEND_API_KEY whenever you like and notifications start; until then
 * everything is still captured and nothing is lost.
 *
 * Records are keyed `sub:<form>:<reverse-timestamp>:<id>` so KV's lexicographic
 * listing returns newest first without sorting anything.
 */

import { CONTACT, json, type Env } from "./env";

/** Matches the client-side cap and the honest limit of a single KV value. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Fields that are never part of the submission itself. */
const SKIP_FIELDS = new Set(["form-name", "cv", "company-website", "fax-number", "postal-code"]);

/** The honeypot each form carries: a field people never see and bots fill. */
const HONEYPOTS = ["company-website", "fax-number", "postal-code"];

const FORMS = new Set(["cv-pool", "hire-request", "contact"]);

/** Sorts newest-first under a plain lexicographic key listing. */
const reverseStamp = (at: number) => (9_999_999_999_999 - at).toString().padStart(13, "0");

export async function handleSubmit(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "METHOD_NOT_ALLOWED" }, 405, { allow: "POST" });
  }

  // A native form post expects to be sent somewhere; fetch() wants JSON back.
  const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
  const done = (ok: boolean, message: string, status: number) =>
    wantsHtml
      ? Response.redirect(new URL(ok ? "/thanks" : "/?error=submission", request.url).toString(), 303)
      : json(ok ? { ok: true } : { error: "SUBMIT_FAILED", message }, status);

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    console.warn("Submission: could not read the form body —", error);
    return done(false, "We couldn't read that submission.", 400);
  }

  const formName = String(form.get("form-name") || "").trim();
  if (!FORMS.has(formName)) {
    console.warn(`Submission: unknown form name ${JSON.stringify(formName)}`);
    return done(false, "That form is not recognised.", 400);
  }

  /* Honeypot. Answer as though it worked: telling a bot it was caught only
     teaches whoever wrote it to fill the field differently next time. */
  if (HONEYPOTS.some((field) => String(form.get(field) || "").trim())) {
    console.log(`Submission: honeypot tripped on ${formName}, discarded.`);
    return done(true, "", 200);
  }

  const at = Date.now();
  const id = crypto.randomUUID().slice(0, 8);
  const key = `sub:${formName}:${reverseStamp(at)}:${id}`;

  const fields: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (SKIP_FIELDS.has(name) || typeof value !== "string") continue;
    fields[name] = value.slice(0, 4000);
  }

  // The CV, when there is one.
  let file: { name: string; type: string; size: number; storedAt: string } | null = null;
  const upload = form.get("cv");
  if (upload && typeof upload !== "string" && upload.size > 0) {
    if (upload.size > MAX_FILE_BYTES) {
      return done(false, "That file is larger than 8 MB.", 413);
    }
    const fileKey = `file:${formName}:${reverseStamp(at)}:${id}`;
    const bytes = await upload.arrayBuffer();

    if (env.UPLOADS) {
      await env.UPLOADS.put(fileKey, bytes, {
        httpMetadata: { contentType: upload.type || "application/octet-stream" },
      });
    } else {
      await env.SUBMISSIONS.put(fileKey, bytes, {
        metadata: { contentType: upload.type || "application/octet-stream", name: upload.name },
      });
    }

    file = {
      name: upload.name || "cv",
      type: upload.type || "application/octet-stream",
      size: bytes.byteLength,
      storedAt: fileKey,
    };
  }

  const record = { id, form: formName, at: new Date(at).toISOString(), fields, file };

  try {
    await env.SUBMISSIONS.put(key, JSON.stringify(record));
  } catch (error) {
    // Storage failing is the one case where telling the visitor "sent" would be
    // a lie that costs them a job application.
    console.error("Submission: could not store the record —", error);
    return done(false, "We couldn't save that. Please email it to us instead.", 500);
  }

  // Best effort, and deliberately after the record is safely stored.
  if (env.RESEND_API_KEY) {
    try {
      await notify(env, record);
    } catch (error) {
      console.warn("Submission: stored, but the notification email failed —", error);
    }
  }

  return done(true, "", 200);
}

/** Emails the submission, if a provider key is configured. */
async function notify(env: Env, record: any) {
  const to = env.NOTIFY_EMAIL || CONTACT.email;
  const lines = Object.entries(record.fields).map(([name, value]) => `${name}: ${value}`);
  if (record.file) lines.push(`CV: ${record.file.name} (${Math.round(record.file.size / 1024)} KB) — download from /admin`);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.NOTIFY_FROM || "Ideal Management <onboarding@resend.dev>",
      to: [to],
      subject: `New ${record.form} submission — Ideal Management`,
      text: `${lines.join("\n")}\n\nReceived ${record.at}\nAll submissions: /admin`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

/* ============================================================== admin ==== */

const unauthorised = () =>
  new Response("Authentication required.", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Ideal Management submissions", charset="UTF-8"' },
  });

/** Constant-time-ish comparison, so a wrong password cannot be found a
 *  character at a time by timing the response. */
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(request: Request, env: Env): boolean {
  // No password set means the page cannot be opened at all. Refusing to serve
  // people's CVs is the only safe default for a missing secret.
  if (!env.ADMIN_PASSWORD) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const [, password = ""] = atob(header.slice(6)).split(":");
    return sameSecret(password, env.ADMIN_PASSWORD);
  } catch {
    return false;
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!authorised(request, env)) return unauthorised();

  const url = new URL(request.url);

  // A file download: /admin/file/<storedAt>
  if (url.pathname.startsWith("/admin/file/")) {
    const storedAt = decodeURIComponent(url.pathname.slice("/admin/file/".length));
    if (!storedAt.startsWith("file:")) return new Response("Not found", { status: 404 });

    if (env.UPLOADS) {
      const object = await env.UPLOADS.get(storedAt);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType || "application/octet-stream",
          "content-disposition": `attachment; filename="${storedAt.split(":").pop()}"`,
        },
      });
    }

    const { value, metadata } = await env.SUBMISSIONS.getWithMetadata(storedAt, "arrayBuffer");
    if (!value) return new Response("Not found", { status: 404 });
    const meta = (metadata || {}) as { contentType?: string; name?: string };
    return new Response(value, {
      headers: {
        "content-type": meta.contentType || "application/octet-stream",
        "content-disposition": `attachment; filename="${(meta.name || "cv").replace(/"/g, "")}"`,
      },
    });
  }

  const listed = await env.SUBMISSIONS.list({ prefix: "sub:", limit: 200 });
  const records = await Promise.all(
    listed.keys.map(async (entry) => {
      const raw = await env.SUBMISSIONS.get(entry.name);
      try {
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }),
  );

  const rows = records
    .filter(Boolean)
    .map((record: any) => {
      const details = Object.entries(record.fields)
        .map(([name, value]) => `<div><b>${escapeHtml(name)}</b>: ${escapeHtml(String(value))}</div>`)
        .join("");
      const cv = record.file
        ? `<a href="/admin/file/${encodeURIComponent(record.file.storedAt)}">${escapeHtml(record.file.name)}</a>
           <small>(${Math.round(record.file.size / 1024)} KB)</small>`
        : "<small>—</small>";
      return `<tr>
        <td><code>${escapeHtml(record.form)}</code><br /><small>${escapeHtml(record.at)}</small></td>
        <td>${details}</td>
        <td>${cv}</td>
      </tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Submissions — Ideal Management</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f3f5ff; color: #0a1633; }
  header { background: #1c2566; color: #fff; padding: 1.25rem clamp(1rem, 4vw, 2.5rem); }
  header h1 { margin: 0; font-size: 1.25rem; }
  header p { margin: .25rem 0 0; color: #b6c2f5; font-size: .85rem; }
  main { padding: clamp(1rem, 4vw, 2.5rem); }
  table { width: 100%; border-collapse: collapse; background: #fff; box-shadow: 0 2px 8px rgb(10 22 51 / .08); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: .85rem 1rem; border-bottom: 1px solid #dfe6f7; vertical-align: top; }
  th { background: #e3e8ff; font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; }
  td div { margin-bottom: .2rem; }
  code { background: #e3e8ff; padding: .1rem .4rem; border-radius: 5px; }
  .empty { padding: 2rem; background: #fff; border-radius: 12px; text-align: center; color: #5a6488; }
  @media (max-width: 700px) { th:nth-child(1), td:nth-child(1) { width: 8rem; } }
</style></head>
<body>
  <header>
    <h1>Submissions</h1>
    <p>${records.filter(Boolean).length} stored · newest first · CV Pool, employer requests and contact messages</p>
  </header>
  <main>
    ${rows ? `<table><thead><tr><th>Form</th><th>Details</th><th>CV</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">Nothing submitted yet.</p>'}
  </main>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}
