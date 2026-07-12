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
