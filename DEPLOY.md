# Deploying Structures DST (MVP)

The MVP is one self-contained web page (`deploy/public/index.html`, 3.6 MB). The engine, data and checks all run in
the visitor's browser. The only server-side code is `deploy/lib/claude-proxy.js`, a small function that forwards the
AI features' requests to the Claude API with your key. Without a key, everything except the AI works.

## Pick a route

| Route | Use when | AI features |
| --- | --- | --- |
| **A. Vercel** (recommended) | Fastest: one command, free tier, HTTPS link | Yes: `api/claude.js` runs as a serverless function |
| **B. Docker or Node** | Your company hosts it (Azure App Service, AWS, Render, Railway, a VM) | Yes: `server.mjs` serves the page and `/api/claude` |
| **C. Static only** | Any static host (GitHub Pages, Netlify, S3) | No: the page says AI is not configured, and everything else works |

## Settings (environment variables)

| Name | Needed | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **Required** | Key from console.anthropic.com. It stays on the server and is never sent to the browser or shared with anyone |
| `DST_ACCESS_CODE` | **Required** (at least 6 characters) | Visitors type this code on the Ask the data page before any AI request is sent. Share it only with people who should use the AI |

**AI fails closed.** If either value is missing, the server refuses every AI request and the page says
"AI is switched off on this server". There is no setting that opens the AI to anyone with the link.
| `DST_MODEL_DEFAULT` / `_QUICK` / `_COMPLEX` | Optional | Model ids. Defaults: `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5` |
| `DST_RATE_PER_MIN` | Optional | AI requests per minute per visitor IP (default 30) |

## Route A - Vercel

```bash
cd deploy
npm i -g vercel                     # once
vercel login                        # once, in the browser
vercel link                         # create or choose a project
vercel env add ANTHROPIC_API_KEY production
vercel env add DST_ACCESS_CODE production
vercel deploy --prod                # prints the public URL
```
`vercel.json` already sets `public/` as the site and gives the AI function a 60 s limit.

Note on how Vercel builds this (CLI 64, checked 19 Oct 2026): it detects `server.mjs` as the root entrypoint, so one
Node function serves both the page and `/api/claude` - the same `lib/claude-proxy.js` either way. Two consequences:
- `vercel.json` must **not** set `"buildCommand": ""`. That skips the build step, and the build step is where Vercel
  turns `api/` into functions, so the deploy fails with *pattern "api/claude.js" doesn't match any Serverless Functions*.
- The `functions` limit therefore does not apply; functions default to 300 s on all plans under Fluid Compute, which is
  longer than the 60 s it asked for, so AI requests are not at risk of being cut short.

When passing `DST_ACCESS_CODE` to `vercel env add` from a pipe on Windows, use `printf` (git bash), not PowerShell's
`"code" |`: PowerShell sends `\r\n`, Vercel strips only the `\n`, and the stored code keeps a trailing `\r`. The
comparison in `claude-proxy.js` is exact, so every correct code is then rejected with 401.

## Route B - Docker or plain Node (Node 18+)

```bash
cd deploy
docker build -t structures-dst .
docker run -p 8080:8080 -e ANTHROPIC_API_KEY=... -e DST_ACCESS_CODE=... structures-dst
# or without Docker:
ANTHROPIC_API_KEY=... DST_ACCESS_CODE=... node server.mjs
```
The health check is `GET /healthz`. Put it behind HTTPS (most platforms do this for you).

## Route C - static only
Upload `deploy/public/index.html` to any static host. Leave out `api/`, `lib/` and `server.mjs`.

## Check the deployment (5 minutes)

First run the automatic check (it needs no secrets):
```bash
cd deploy && node verify.mjs https://YOUR-URL               # page served, no key in the page, AI locked
node verify.mjs https://YOUR-URL YOUR-ACCESS-CODE           # optional: also proves the AI answers (one tiny request)
```
Then in a browser:

1. Open the URL. Within a few seconds the top bar shows **"✓ Matches SAVI v1.10"**: the engine re-checked itself against SAVI in the browser.
2. Overview shows **GRC £377.9m, DRC £257.4m**.
3. Ask the data: enter the access code, then ask *"What is the gross replacement cost?"*. The answer quotes £377.9m with a green "figures traced" badge.
4. 5-year programme → Export CSV downloads `programme-R001-….csv`.
5. Optional: Evaluation & trust → AI evaluation → Run quick set (8). Expect 8/8. The claude.ai baseline was 26/26 (decision D-027). Results are shown, not stored, on a hosted deployment.

## Updating
After changing the source, rebuild and redeploy:
```bash
cd web && npm ci && npm test && node build.mjs     # rewrites deploy/public/index.html
cd ../deploy && vercel deploy --prod               # or rebuild the Docker image
```

## What a hosted MVP does not do (by design, see the production plan)
- Data and decisions last for the visitor's browser session. Use Data entry → Export to keep them.
- No sign-in or roles. The access code only protects AI spend; the engine pages are open to anyone with the link.
- The audit log and evaluation history are per session (on claude.ai they are shared).
