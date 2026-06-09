# Deploying dfad to AWS

The app needs three things: an **S3 bucket** (HTML objects), a **DynamoDB table** (metadata, with TTL), and a place to **run the container** (App Runner is simplest; ECS Fargate works too).

Set `STORAGE_DRIVER=s3` in the deployed environment.

## 1. S3 bucket

```bash
aws s3api create-bucket --bucket dfad-apps --region us-east-1
# keep it private — the app streams objects, they are never publicly readable
aws s3api put-public-access-block --bucket dfad-apps \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Backstop lifecycle rule — delete objects 1 day after creation (`lifecycle.json`):

```json
{ "Rules": [ { "ID": "expire-apps", "Filter": { "Prefix": "apps/" },
  "Status": "Enabled", "Expiration": { "Days": 1 } } ] }
```

```bash
aws s3api put-bucket-lifecycle-configuration --bucket dfad-apps --lifecycle-configuration file://lifecycle.json
```

> S3 lifecycle expiration is *approximate* (runs roughly daily). The app's read-time
> check is what enforces the exact 24h cutoff — lifecycle is just cleanup.

## 2. DynamoDB table (with TTL)

```bash
aws dynamodb create-table --table-name dfad-deployments \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region us-east-1

aws dynamodb update-time-to-live --table-name dfad-deployments \
  --time-to-live-specification "Enabled=true, AttributeName=expiresAt"
```

> DynamoDB TTL deletion can lag up to ~48h. Again, the app's read-time check returns
> `410` exactly at `expiresAt`; TTL is just background cleanup.

## 3. IAM policy for the service role

```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::dfad-apps/apps/*" },
  { "Effect": "Allow",
    "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:DeleteItem"],
    "Resource": "arn:aws:dynamodb:*:*:table/dfad-deployments" }
] }
```

## 4. Run the container (App Runner)

Build & push the image (ECR), then create an App Runner service from it with the
instance role above and these env vars:

```
STORAGE_DRIVER=s3
AWS_REGION=us-east-1
S3_BUCKET=dfad-apps
DYNAMODB_TABLE=dfad-deployments
TTL_HOURS=24
MAX_BYTES=5242880
APPS_BASE_URL=https://apps.dfad.example.com
IP_HASH_SALT=<long-random-string>
RATE_LIMIT_MAX=10
RATE_LIMIT_WINDOW=10 minutes
```

Health check path: `/healthz`.

## 5. DNS / origin isolation

For safety, serve the **apps** on a different host than the upload UI and set
`APPS_BASE_URL` to that apps host:

- `dfad.example.com` → the upload site
- `apps.dfad.example.com` (or wildcard `*.apps.dfad.example.com`) → served apps

This prevents uploaded JS from touching the upload site's origin (cookies/storage).
A wildcard-subdomain-per-app scheme (`<id>.apps.example.com`) is the strongest option
but requires a wildcard TLS cert; it's listed as a future enhancement in the plan.

## Smoke test

1. Upload via the deployed page; open the returned link and confirm it renders.
2. Confirm a row in DynamoDB with a future `expiresAt`, and the object under `apps/` in S3.
3. Set a test row's `expiresAt` to the past → `GET /a/<id>` returns `410`.
