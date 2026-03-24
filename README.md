# ARP Governing Documents Interface

This project builds a GitHub Pages-friendly ARP governing documents interface.

The current scope is English only.

## What it does

- Fetches the latest governing document links from the ARP governing documents page.
- Downloads the current PDF files for doctrinal standards, church government, discipline, worship, and authorities.
- Extracts text with Open Data Loader.
- Pulls additional context from the ARP "What We Believe" page.
- Builds a static search index with source citations.
- Publishes a front-end chat-style interface to GitHub Pages.
- Supports optional OpenAI-backed answers in local/server mode.

## Source authority

The build targets these source pages directly:

- [Governing Documents](https://arpchurch.org/governing-documents/)
- [What We Believe](https://arpchurch.org/what-we-believe/)

The workflow intentionally discovers the live PDF links from the governing documents page at build time so it can track updated file URLs without hardcoding them.

## Local requirements

To build locally you need:

- Node.js 20+
- Java 11+ on `PATH`

Open Data Loader's Node quick start documents the same requirements:

- [Quick Start with Node.js](https://opendataloader.org/docs/quick-start-nodejs)

## Commands

```bash
npm install
npm run build
```

`npm run build` will:

1. Fetch the two ARP source pages.
2. Download the selected PDFs.
3. Convert the PDFs to markdown and JSON with Open Data Loader.
4. Generate `build/data/search-index.json`.
5. Copy the static site into `docs/` for GitHub Pages publishing.

## OpenAI API mode

To enable LLM-backed answers in local preview:

1. Copy `.env.example` to `.env.local`
2. Set `OPENAI_API_KEY`
3. Optionally change `OPENAI_MODEL` and `OPENAI_REASONING_EFFORT`
4. Optionally set `OPENAI_DAILY_LIMIT` to cap OpenAI-backed answers per user per day

When `OPENAI_API_KEY` is present, the local preview server will:

- retrieve from the ARP sources in priority order
- send that evidence to the OpenAI Responses API
- return a synthesized answer grounded in those citations
- enforce a simple per-user daily limit for OpenAI-backed requests when `OPENAI_DAILY_LIMIT` is set to a positive number

If no key is configured, the app falls back to the local citation-based answerer.

The default configuration uses `gpt-5.4` for stronger reasoning over the ARP source hierarchy. If you want a cheaper or faster option later, you can lower `OPENAI_MODEL` in `.env.local`.

## Deployment

The included GitHub Actions workflow:

- runs on manual dispatch
- runs on every push to `main`
- rebuilds every Monday at 11:00 UTC
- deploys the static site from `docs/` to GitHub Pages

## Front-end behavior

- GitHub Pages can run the browser fallback mode against the built search index in `docs/data/`.
- Local/server mode can call the OpenAI-backed `/api/chat` endpoint when an API key is configured.
- Questions are classified before retrieval so doctrinal, procedural, governmental, and worship questions can be routed differently.
- Users can leave routing on `Auto` or manually override the question type in the interface.
- Governing documents are always treated as the primary answer source.
- Supplemental belief-context material is shown only as additional comments when it is relevant.
- Each answer shows page-level links back to the ARP source PDF or page.

## Local launch

- Double-click `Run-Preview.vbs` to refresh the ARP data in the background, start the local preview server, and open the interface in your browser.

## Cloudflare Pages + Functions

This repo is now prepared for a Cloudflare-hosted LLM setup.

Files added for Cloudflare:

- `functions/api/chat.js`
- `functions/api/health.js`
- `functions/api/status.js`
- `functions/_lib/api.js`
- `wrangler.toml`

Recommended production setup:

1. GitHub remains the source repo.
2. Cloudflare Pages deploys the front-end from `docs/`.
3. Cloudflare Functions handles `/api/chat`, `/api/health`, and `/api/status`.
4. Cloudflare secrets hold the OpenAI key and model config.
5. A Cloudflare KV binding named `USAGE_LIMITS` enforces the daily per-user LLM cap.

Cloudflare environment variables / secrets:

```text
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5.4
OPENAI_REASONING_EFFORT=medium
OPENAI_DAILY_LIMIT=25
```

Cloudflare binding:

- KV namespace binding name: `USAGE_LIMITS`

Notes:

- If `USAGE_LIMITS` is not configured, the Cloudflare API will still work, but the daily limit will not be enforced across requests.
- The front-end will use same-origin `/api/...` routes on Cloudflare automatically.
- If you later move the front-end somewhere else, you can set `window.ARP_API_BASE` before `app.js` loads and point the UI to another backend URL.

## Bluehost migration path

When you move this to Bluehost later:

1. Keep the static assets in `site/` as the base UI.
2. Replace the client-side `search()` call in `site/app.js` with a fetch to your hosted chat API.
3. Keep the GitHub Actions ingestion workflow if you want GitHub to remain the rebuild pipeline.
4. Point the Bluehost page at the external API endpoint instead of relying on a browser-only index.

That lets you preserve the same interface while upgrading from static retrieval to a full conversational backend.

## Current limitations

- GitHub Pages hosting uses the browser fallback mode unless you point the frontend at an external backend API.
- The local preview server provides the OpenAI-backed mode, but GitHub Pages itself does not run the Node backend.
- For public production hosting with LLM answers, keep the same frontend and connect it to your own deployed backend API.
- Cloudflare LLM mode requires you to set the Pages environment variables/secrets and add the `USAGE_LIMITS` KV binding in the Cloudflare dashboard.
