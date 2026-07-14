# @kenectai/api

Cloud Run-ready Kenect AI product API.

This package provides the first Google Cloud backend surface for the Kenect AI fork. It exposes compatibility endpoints for the current CLI cloud/publish/feedback/auth flows while delegating actual rendering to the existing Cloud Run + Workflows renderer.

## Required environment

```bash
KENECT_GCP_PROJECT=project-b6d52049-a76d-44bd-99e
KENECT_RENDER_BUCKET=kenect-render-bucket
KENECT_RENDER_LOCATION=us-central1
KENECT_RENDER_WORKFLOW_ID=hyperframes-render
KENECT_RENDER_SERVICE_URL=https://your-render-service.run.app
KENECT_API_BASE_URL=https://api.kenectai.com
KENECT_APP_BASE_URL=https://app.kenectai.com
KENECT_JWT_SECRET=long-random-string   # signs OAuth access tokens and session cookies
```

Optional:

```bash
KENECT_API_KEYS=dev-key,another-key
GEMINI_API_KEY=your-gemini-api-key      # required for /v1/products/* — 501 without it
KENECT_GEMINI_MODEL=gemini-3.5-flash    # defaults to gemini-3.5-flash (GA, frontier agentic/coding)
PORT=8080
```

When `KENECT_API_KEYS` is unset, the service runs in development mode and accepts anonymous requests.

## OAuth

Self-contained OAuth 2.0 authorization-code + PKCE server for the Kenect AI CLI (public client, loopback redirect). Users, authorization codes, and refresh tokens are stored as JSON objects in `KENECT_RENDER_BUCKET`.

- `GET /oauth/authorize` — validates the flow, renders login/signup then consent
- `POST /oauth/authorize/login` — password login, sets the `kenect_session` cookie
- `POST /oauth/authorize/signup` — account creation, sets the session cookie
- `POST /oauth/authorize/consent` — allow/deny; redirects to the loopback `redirect_uri` with `code` + `state`
- `POST /v1/oauth/token` — `authorization_code` (with PKCE verification, single-use codes) and `refresh_token` (rotating) grants
- `POST /v1/oauth/revoke` — revokes a refresh token; always returns `200 { "revoked": true }`

Access tokens are HS256 JWTs (1 h) accepted as `Authorization: Bearer …` by the API; refresh tokens (`krt_…`, 30 d) rotate on every refresh.

## Products (Gemini-backed)

Two hosted generators, both auth-gated (API key or bearer token — see above) and backed by the Gemini API (`src/gemini.ts`, zero SDK dependency). Neither is available until `GEMINI_API_KEY` is set; requests get `501` until then.

Default model is `gemini-3.5-flash` (GA). Code/creative-authoring calls (composition HTML, `FRAME.md`, lint repairs) request `thinkingLevel: "high"`; the structured design-token extraction call uses `"medium"`. `thinkingLevel` is Gemini-3-only (`generationConfig.thinkingConfig.thinkingLevel`, values `minimal`/`low`/`medium`/`high`) — if `KENECT_GEMINI_MODEL` is overridden to a Gemini 2.5 model, drop `thinkingLevel` from the call sites first (2.5 uses the older token-budget `thinkingConfig.thinkingBudget` field instead, which this client doesn't set).

### `POST /v1/products/frame-pack`

Any brand-adjacent document (a `design.md`, an SEO strategy, product notes — whatever's on hand) in, a 3-file pack out: a video-first design-token spec plus a real, renderable showcase composition.

```bash
curl -X POST https://api.kenectai.com/v1/products/frame-pack \
  -H "x-api-key: $KENECT_API_KEY" -H "content-type: application/json" \
  -d '{"source_text": "<paste the document>"}'
# -> { job_id, status: "completed", product_name, download_url, files: [...] }
```

Pipeline: one Gemini call derives strict-JSON design tokens (6 roled colors + a typography triple) from the source text; a second Gemini call authors `FRAME.md` from those exact tokens. `frame-showcase.html` and `README.html` are then built **deterministically** from the tokens JSON (not parsed back out of the LLM markdown) — see `src/products/framePack.ts` — so that half of the pipeline is fast, reliable, and independently testable. The showcase is lint-gated by construction: `buildFrameShowcaseHtml`'s test asserts `errorCount === 0` against `@kenectai/lint`. The three files are zipped and uploaded to `KENECT_UPLOAD_BUCKET`; the response includes a 15-minute signed download URL. Poll `GET /v1/products/frame-pack/:jobId` for the job record.

### `POST /v1/products/website-video`

A URL in, a rendering video out — dispatched through the same render path as `/v3/kenectai/renders` (`dispatchRender`, shared with `createRenderHandler`; no separate render infra).

```bash
curl -X POST https://api.kenectai.com/v1/products/website-video \
  -H "x-api-key: $KENECT_API_KEY" -H "content-type: application/json" \
  -d '{"url": "https://example.com", "duration_s": 20}'
# -> { job_id, render_id, status: "rendering", poll_url: "/v3/kenectai/renders/<render_id>" }
```

Pipeline (`src/products/websiteVideo.ts`): fetch the page (12s timeout, 5 MB cap) → extract brand hints via regex (title, meta description, `theme-color`, `og:image`, h1/h2 text — no DOM parser dependency) → Gemini authors a single composition HTML under the full HyperFrame contract (paused GSAP timeline, `class="clip"` + `data-*` timing, transform/opacity-only tweens, deterministic) → lint-gated with **exactly one repair pass**: on lint failure, the errors are fed back to Gemini for a full-document fix, then re-linted. Still failing → `422` with the lint findings (`CompositionLintError`), no infinite loop. On success the composition is zipped, base64-encoded, and handed to the exact same render dispatcher the CLI uses. Poll render status at the returned `poll_url` (existing render endpoints — no new status machinery).
