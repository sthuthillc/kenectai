# Kenect AI Google Cloud Backend Blueprint

This document maps the current HyperFrames backend expectations to a Google Cloud-first Kenect AI architecture.

It separates two concerns that are currently mixed in the upstream product:

1. Render infrastructure
2. Product/platform API

The render infrastructure already exists in this repo via the Cloud Run + Workflows adapter. The product API does not; it must be built for Kenect AI.

## 1. Recommended rollout order

### Phase 1: Stand up render infrastructure first

Deploy the existing OSS distributed renderer on Google Cloud:

- Cloud Run render service
- Cloud Workflows orchestration
- Cloud Storage render bucket
- Artifact Registry container image
- Secret Manager for provider/runtime secrets

Goal:

- Own the render pipeline end-to-end
- Prove that rendering works independently of HeyGen-hosted APIs

### Phase 2: Build the Kenect AI product API

Build a separate API service at `https://api.kenectai.com`:

- auth/session endpoints
- asset upload endpoints
- render submission/status endpoints
- publish/project endpoints
- feedback endpoint
- user/account endpoint

Goal:

- Replace the HeyGen API assumptions in the CLI and any future app/backend flows

### Phase 3: Rebrand the repo and point it at Kenect endpoints

Only after Phases 1 and 2:

- rename CLI/package/domain identities
- switch default base URLs
- rename env vars/auth docs/publish docs
- remove old branding without leaving broken features behind

## 2. Target GCP architecture

### A. Render infrastructure

This repo already provides the render-plane building blocks.

Use:

- `packages/gcp-cloud-run/src/server.ts`
- `packages/gcp-cloud-run/src/sdk/renderToCloudRun.ts`
- `packages/gcp-cloud-run/terraform/*`

Recommended GCP services:

- Cloud Run
  - hosts the render worker HTTP service
  - handles `plan`, `renderChunk`, `assemble`
- Cloud Workflows
  - orchestrates distributed rendering
- Cloud Storage
  - stores uploaded project archives, plan tarballs, chunk outputs, final videos
- Artifact Registry
  - stores the render container image
- Cloud Build
  - builds and publishes the container image
- Secret Manager
  - stores provider secrets and API credentials
- Cloud Logging / Monitoring / Error Reporting
  - operational visibility

### B. Product/platform API

This should be a separate Cloud Run service, not mixed into the render worker.

Recommended GCP services:

- Cloud Run
  - `api.kenectai.com`
- Cloud SQL or Firestore
  - user, asset, render, publish, and feedback metadata
- Cloud Storage
  - app-managed uploaded zips, published project archives, generated public artifacts
- Cloud Tasks or Pub/Sub
  - async publish jobs and callback delivery
- Cloud Scheduler
  - cleanup jobs for expired assets, stale presigned URLs, old jobs
- Identity provider
  - your own OAuth/OpenID strategy or a third-party auth system

## 3. Backend surfaces the repo currently expects

These are the contracts currently visible in the codebase.

### A. Auth/user API

Expected by:

- `packages/cli/src/auth/client.ts`
- `packages/cli/src/auth/oauth.ts`

Required endpoint families:

- `GET /v3/users/me`
  - verify current credential
  - return user/account/billing identity info
- `GET /oauth/authorize`
  - browser OAuth start
- `POST /v1/oauth/token`
  - exchange auth code or refresh token
- `POST /v1/oauth/revoke`
  - revoke tokens

Kenect recommendation:

- keep the same shapes initially to reduce CLI changes
- implement with Kenect-owned auth and token issuance

### B. Cloud render API

Expected by:

- `packages/cli/src/commands/cloud/*`
- `packages/cli/src/cloud/upload.ts`
- `packages/cli/src/cloud/_gen/types.ts`

Required endpoint families:

- `POST /v3/assets/direct-uploads`
- `POST /v3/assets/{asset_id}/complete`
- `POST /v3/hyperframes/renders`
- `GET /v3/hyperframes/renders`
- `GET /v3/hyperframes/renders/{render_id}`
- `DELETE /v3/hyperframes/renders/{render_id}`

Kenect recommendation:

- implement these in the product API
- store metadata in DB
- store uploaded zips in GCS
- submit the real render to the existing Cloud Run + Workflows stack

Suggested flow:

1. client asks for direct upload
2. API creates asset record + GCS signed upload URL
3. client uploads zip directly to GCS
4. client finalizes asset
5. client submits render
6. API validates request and calls `renderToCloudRun`
7. API stores execution metadata
8. client polls API, not Workflows directly

### C. Publish/project API

Expected by:

- `packages/cli/src/utils/publishProject.ts`
- `packages/cli/src/commands/publish.ts`
- `packages/cli/src/commands/feedback.ts`

Required endpoint families:

- `POST /v1/hyperframes/projects/publish`
- `POST /v1/hyperframes/projects/publish/upload`
- `POST /v1/hyperframes/projects/publish/complete`

Kenect recommendation:

- model publish separately from render
- published projects should land in a dedicated GCS-backed public hosting path
- app domain should serve/claim/view those projects

Suggested storage model:

- `published_projects`
  - project_id
  - title
  - owner_user_id nullable
  - claim_token
  - is_public
  - archive_gcs_key
  - viewer_url
  - created_at

### D. Feedback API

Expected by:

- `packages/cli/src/utils/submitFeedback.ts`

Required endpoint:

- `POST /v1/hyperframes/feedback`

Kenect recommendation:

- keep this best-effort
- write to DB and optionally forward to analytics
- no hard dependency on external telemetry during v1

## 4. Minimal v1 Kenect API design

To get the repo functional with the fewest moving parts, implement this v1.

### Service 1: `kenect-api`

Primary public API at `api.kenectai.com`

Responsibilities:

- auth and user identity
- direct upload session creation
- asset finalization
- render job creation/status/list/delete
- publish flow
- feedback ingestion

### Service 2: `kenect-render`

Private/internal render service using the existing Cloud Run adapter

Responsibilities:

- `plan`
- `renderChunk`
- `assemble`

Triggered by:

- Cloud Workflows
- optionally by the API service when starting jobs

## 5. Data model recommendation

### Users

- `id`
- `email`
- `name`
- `auth_provider`
- `created_at`

### OAuth / sessions

- `user_id`
- `refresh_token_hash`
- `expires_at`
- `scope`
- `created_at`

### Assets

- `asset_id`
- `owner_user_id`
- `filename`
- `mime_type`
- `size_bytes`
- `gcs_key`
- `status`
- `checksum_sha256`
- `created_at`

### Renders

- `render_id`
- `owner_user_id`
- `asset_id`
- `workflow_execution_name`
- `render_service_url`
- `bucket_name`
- `output_gcs_key`
- `status`
- `failure_message`
- `fps`
- `format`
- `quality`
- `resolution`
- `aspect_ratio`
- `composition`
- `variables_json`
- `callback_url`
- `callback_id`
- `created_at`
- `completed_at`

### Published projects

- `project_id`
- `owner_user_id`
- `title`
- `archive_gcs_key`
- `is_public`
- `claim_token`
- `viewer_url`
- `created_at`

### Feedback

- `id`
- `user_id nullable`
- `rating`
- `comment`
- `cli_version`
- `env`
- `created_at`

## 6. Recommended endpoint mapping for Kenect

Initial compatibility-first strategy:

- keep the current path shapes
- change only the host
- rename paths later if desired

Recommended initial base:

- `https://api.kenectai.com`

Suggested first-pass compatibility paths:

- `GET /v3/users/me`
- `GET /oauth/authorize`
- `POST /v1/oauth/token`
- `POST /v1/oauth/revoke`
- `POST /v3/assets/direct-uploads`
- `POST /v3/assets/{asset_id}/complete`
- `POST /v3/hyperframes/renders`
- `GET /v3/hyperframes/renders`
- `GET /v3/hyperframes/renders/{render_id}`
- `DELETE /v3/hyperframes/renders/{render_id}`
- `POST /v1/hyperframes/projects/publish/upload`
- `POST /v1/hyperframes/projects/publish/complete`
- `POST /v1/hyperframes/projects/publish`
- `POST /v1/hyperframes/feedback`

This lets the CLI keep working with smaller code changes while the brand rename proceeds.

## 7. GCP deployment recommendation

### Render plane

- Deploy the render image from `packages/gcp-cloud-run/Dockerfile`
- Provision the Terraform module in `packages/gcp-cloud-run/terraform`
- Capture:
  - render bucket name
  - workflow name
  - service URL
  - region

Kenect project id:

- `project-b6d52049-a76d-44bd-99e`

### API plane

- New Cloud Run service: `kenect-api`
- Backed by:
  - Cloud SQL Postgres or Firestore
  - GCS upload bucket
  - Secret Manager
  - Cloud Tasks / PubSub

### Networking

- `api.kenectai.com` -> Cloud Run API
- optional `app.kenectai.com` -> frontend/app host
- optional `docs.kenectai.com` -> docs host

## 8. What to build first

### Sprint 1

- Deploy OSS render stack on GCP
- Verify one end-to-end render via `renderToCloudRun`
- Create Kenect API service skeleton
- Implement `POST /v3/assets/direct-uploads`
- Implement `POST /v3/assets/{asset_id}/complete`
- Implement `POST /v3/hyperframes/renders`
- Implement `GET /v3/hyperframes/renders/{render_id}`

Success criteria:

- a local script can upload a zip, submit a render, and poll it through Kenect API

### Sprint 2

- Implement `GET /v3/users/me`
- Implement OAuth/token endpoints
- Wire CLI auth/status/login to Kenect API
- Implement render list/delete

Success criteria:

- `kenectai auth login`
- `kenectai auth status`
- `kenectai cloud render`

### Sprint 3

- Implement publish upload/finalize/complete
- Implement feedback endpoint
- Serve published project URLs from Kenect domain

Success criteria:

- `kenectai publish`
- `kenectai feedback`

## 9. Recommendation on renaming

Do not rename the repo’s auth/publish/cloud defaults until:

- `api.kenectai.com` exists
- the render backend is deployed
- the compatibility endpoints above are live

Otherwise the codebase will look rebranded while core features fail at runtime.

## 10. Immediate next action

Build the GCP render plane first, then scaffold the Kenect API with the following first endpoints:

1. `POST /v3/assets/direct-uploads`
2. `POST /v3/assets/{asset_id}/complete`
3. `POST /v3/hyperframes/renders`
4. `GET /v3/hyperframes/renders/{render_id}`

That gives the shortest path to a working Kenect-owned cloud render flow.

## 11. Implementation status

Started in `packages/kenect-api`.

Implemented first-pass Cloud Run API scaffold:

- health route: `GET /healthz`
- user route: `GET /v3/users/me`
- OAuth placeholders: `GET /oauth/authorize`, `POST /v1/oauth/token`, `POST /v1/oauth/revoke`
- asset upload flow: `POST /v3/assets/direct-uploads`, `POST /v3/assets/{asset_id}/complete`
- render flow: `POST /v3/hyperframes/renders`, `GET /v3/hyperframes/renders`, `GET /v3/hyperframes/renders/{render_id}`, `DELETE /v3/hyperframes/renders/{render_id}`
- publish staged flow: `POST /v1/hyperframes/projects/publish/upload`, `POST /v1/hyperframes/projects/publish/complete`
- feedback flow: `POST /v1/hyperframes/feedback`

The current implementation uses GCS for uploaded project zips and lightweight JSON metadata. Render creation bridges the existing CLI zip upload format to the GCP renderer by expanding the zip in `/tmp` and calling `renderToCloudRun`.

Current deployment project:

- `KENECT_GCP_PROJECT=project-b6d52049-a76d-44bd-99e`

Still needed before production:

- real OAuth provider integration
- Firestore or Cloud SQL metadata store
- callback delivery
- published project viewer/claim service
- production auth/authorization policy
- end-to-end deployment smoke test on GCP
