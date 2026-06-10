# deploy for a day (dfad)

Host throwaway single-page HTML apps for **24 hours**, then they vanish. **Live at [dfad.app](https://dfad.app).**

Upload one self-contained `.html` file (the kind an AI coding agent spits out — e.g. a little game or toy), get back a public link that works for a day. After that the link 410s and the content is deleted automatically.

- **Single page only.** One `.html` file, max **5 MB**. External CDN scripts and fonts are allowed (no inlining required).
- **Auto-expiry.** On AWS, DynamoDB TTL + an S3 lifecycle rule delete content automatically. Expiry is also enforced exactly at read time (returns `410 Gone`) since TTL/lifecycle deletion can lag.
- **Abuse guards.** Upload rate limiting per IP; salted-hashed uploader IPs; arbitrary app JS is served with `nosniff` and is meant to live on a separate origin (see isolation note below).

## Quick start (local, no AWS)

```bash
cp .env.example .env       # defaults to STORAGE_DRIVER=local
npm install
npm run dev                # http://localhost:3000
```

Open the page, drop in `~/Downloads/aidle.html`, and follow the returned link.

```bash
npm test                   # unit + flow tests (uses the local disk driver)
npm run build && npm start # production build
```

## How it works

Uploads use a **3-step presigned flow** so the file never passes through the server/Lambda:

| Route | Purpose |
| --- | --- |
| `GET /` | Upload UI (file drop or paste). |
| `POST /api/deploy` | Rate-limited. Mints an id, returns a direct-upload target `{ id, upload: { url, fields } }` (an S3 presigned POST in prod). |
| `POST /api/finalize` | After the browser uploads, sniffs the object is HTML + within size, records metadata, returns `{ id, url, expiresAt }`. |
| `GET /a/:id` | Serves the app; `410` once expired, `404` if unknown. |
| `GET /healthz` | Health check. |

All logic lives in a framework-agnostic service layer (`src/lib/service.ts`) shared by two adapters: the **Fastify server** (`src/server.ts`, local dev/tests, with a local upload endpoint standing in for S3) and the **Lambda handler** (`src/lambda.ts`, production). Storage and metadata sit behind small interfaces (`src/lib/storage.ts`, `src/lib/metadata.ts`) with **local** (disk/JSON) and **AWS** (S3 + DynamoDB) implementations selected by `STORAGE_DRIVER`.

The deployed AWS topology is **Route 53 → CloudFront → API Gateway (HTTP API) → Lambda**, with S3 + DynamoDB-TTL for storage/expiry. See [`infra/README.md`](infra/README.md) for the full picture and resource IDs.

## Configuration

See `.env.example`. Key vars: `APPS_BASE_URL`, `TTL_HOURS` (default 24, accepts fractions for testing), `MAX_BYTES` (default 5 MB), `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_SECONDS`, `IP_HASH_SALT`, and for AWS: `AWS_REGION`, `S3_BUCKET`, `DYNAMODB_TABLE`.

## Origin isolation (important for production)

Served apps run arbitrary uploaded JavaScript. To keep that JS from sharing cookies / `localStorage` / credentialed fetches with the upload site (or with each other), serve apps from a **separate origin** from the home page and point `APPS_BASE_URL` at it (e.g. site on `dfad.example.com`, apps on `apps.dfad.example.com`). See `infra/README.md`.

## Deploying to AWS

See [`infra/README.md`](infra/README.md).
