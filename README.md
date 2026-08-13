# Ideal Management

Recruitment, HR and business management. One Cloudflare Worker serves the site
and four API routes; there is no build step and no framework.

- **Ideal AI** — a chat assistant powered by CoreOs, in a circle in the corner of
  every page. It **reads the site's own pages before answering**, so editing a
  page is how you retrain it.
- **The CV Pool** — candidates submit a profile and a CV; employers send a
  hiring brief. Submissions and files are stored in this Cloudflare account and
  read at `/admin`.
- **A contact page** — phone, WhatsApp and email, plus a form that requires the
  visitor's number so a consultant can call back.

Contact details throughout: **+964 772 252 1000**, **imanagement19@gmail.com**.

## Changing the key or the model

This is a dashboard edit and takes effect immediately — no redeploy, no build,
no developer:

**Workers & Pages → ideal-management → Settings → Variables and Secrets**

| Name | Kind | What it does |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Secret | The provider key. `OPENROUTER_KEY` also works. |
| `OPENROUTER_MODEL` | Variable | Comma-separated model ids, tried in order. |
| `ADMIN_PASSWORD` | Secret | Opens `/admin`. Without it `/admin` refuses to serve. |
| `RESEND_API_KEY` | Secret | Optional. Set it and submissions are emailed too. |
| `NOTIFY_EMAIL` | Variable | Where those emails go. Defaults to the address above. |
| `NOTIFY_FROM` | Variable | The From address; must be a domain verified with Resend. |
| `OPENROUTER_BASE_URL` | Variable | Optional. Point the calls at a proxy. |

**List two model ids from different providers.** Free capacity is shared and
gets busy; a 429 from one provider is normal, and the second id is what rides
through it. A second *free* id from the *same* provider does not help.

## What's here

```
.
├── public/                 ← the site, served as static assets
│   ├── index.html          home
│   ├── contact.html        /contact
│   ├── thanks.html         /thanks — where forms land
│   └── assets/             styles.css, app.js, the logo marks, favicon
├── worker/
│   ├── index.ts            routing: /api/*, /admin, else static
│   ├── env.ts              bindings and settings, in one place
│   ├── knowledge.ts        reads the site's pages for Ideal AI
│   ├── prompt.ts           the rules the assistant answers under
│   ├── chat.ts             POST /api/ideal-chat
│   ├── health.ts           GET  /api/ideal-health
│   └── submissions.ts      POST /api/submit, and /admin
└── wrangler.jsonc          assets, KV binding, variables
```

Asset URLs carry a `?v=` marker that changes when the file does, so a fix cannot
sit behind a stale cached copy. **If you edit `styles.css` or `app.js`, bump that
number in the HTML** or returning visitors keep the old one for a day.

## Running it locally

```bash
npm install
cp .env.example .dev.vars   # then fill in the key and an admin password
npx wrangler dev
```

## Deploying

Connected to GitHub: every push to `main` deploys. To set it up once —
**Workers & Pages → Create → Import a repository**, pick this repo, and accept
the defaults; `wrangler.jsonc` supplies the rest. No build command, no output
directory.

## How Ideal AI learns the site

`worker/knowledge.ts` reads the deployed pages through the assets binding —
the same files a visitor gets, without leaving the edge. It follows links from
`/`, takes the text inside each `<main>`, and caches for 15 minutes.

Bounded at 8 pages, 2 levels, 6,000 characters per page and 14,000 overall.
Today's pages come to about 6,200.

**Change the copy on a page, push, and the assistant knows the new wording.**
It knows nothing that is not on the site, and is told to say so and hand over the
phone number rather than guess.

## Submissions

`POST /api/submit` handles all three forms. Records go to the `SUBMISSIONS` KV
namespace, keyed so that listing returns newest first; a CV is stored alongside.
Read them at **`/admin`**, password-protected by `ADMIN_PASSWORD`.

Email is optional on purpose. Notifications need a third-party account, and a
form that only works once somebody signs up for something else is a form that
quietly loses applications in the meantime. Without `RESEND_API_KEY` everything
is still captured and readable; set the key whenever you like and emails start.

Each form carries a honeypot field that people never see and bots usually fill.
A tripped honeypot is answered as though it worked — telling a bot it was caught
only teaches whoever wrote it to fill the field differently.

**If R2 gets enabled on the account**, add an `UPLOADS` bucket binding to
`wrangler.jsonc` and files go there instead. That is a config change, not a code
one — KV values cap at 25 MiB, which is fine for an 8 MB CV but not a place to
keep growing.

### Cloud files, and why the CV form holds a copy

A picked file is a reference, not a copy, and a cloud provider can withdraw it.
On Android a CV chosen from Google Drive is a `content://` URI that may be gone
by the time the form is submitted — the browser finds out mid-upload and aborts
with `ERR_UPLOAD_FILE_CHANGED`, leaving a blank error page and a lost form. Drive
is where most people keep their CV, so on a public recruitment site that is the
common path, not an edge case.

So `app.js` reads the file into memory the moment it is chosen, while the
reference is certainly valid, and submits that copy. Reading a cloud file also
forces it to download, which is why choosing one shows a "preparing" state — on a
slow connection that pause is the download. If the file cannot be read even at
pick time, the form says so immediately and suggests saving it to the device.

Without JavaScript the form still posts natively: worse for cloud files, never
broken.

## When something breaks

Open **`/api/ideal-health`**. It reports what the assistant can read and what the
provider said, and names the cause rather than leaving it to be guessed at.

- `?deep=1` — also send a full chat-shaped request. The plain probe sends eight
  tokens with no system prompt; passing it proves the key and the model id and
  nothing about whether a conversation works. Costs one extra provider call.
- `?models=1` — list the free model ids the provider publishes, and whether the
  configured one is among them. Costs no quota.

Two failures worth knowing, because each cost a day to find:

- **A 404 from the provider usually is not a dead model id.** An Allowed
  Providers allowlist under *OpenRouter → Settings → Privacy* silently
  disqualifies every provider not on it, and looks identical to a retired id.
  `cause` in the health output tells the two apart.
- **A 429 is usually the upstream provider being busy**, not your account. Check
  the account's activity page before believing you are out of quota — and list a
  second model id from a different provider, which is what makes it invisible.

Provider error text never reaches the browser: it can quote the prompt back.
Failures come out as a plain sentence, with the detail in the Worker logs.
