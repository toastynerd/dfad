# dfad on AWS — deployed architecture

This is the architecture actually running in production (account `992382469622`,
region `us-west-2`, domain `dfad.app`).

```
            Route 53 (dfad.app, apps.dfad.app  ->  ALIAS)
                       │
                 CloudFront  (ACM cert in us-east-1, *.dfad.app + dfad.app)
                       │   origin: API Gateway  (CachingDisabled, AllViewerExceptHostHeader)
                       ▼
            API Gateway (HTTP API, $default route, AWS_PROXY)
                       ▼
                  Lambda  (nodejs20, handler=lambda.handler)
                  ├── POST /api/deploy   -> presigned S3 POST (≤5MB, text/html)
                  ├── POST /api/finalize -> sniff + write DynamoDB record (TTL)
                  └── GET  /a/:id        -> expiry check (410) + serve from S3
                       │                                    ▲
          ┌────────────┴───────────┐                       │
   DynamoDB (TTL on expiresAt)   S3 (apps/<id>.html)  ← browser uploads here directly
```

### Why API Gateway and not a Lambda Function URL
The original design used a Lambda Function URL (with response streaming). This
account's **SCP blocks Lambda Function URLs** — both public (`AuthType=NONE`) and
CloudFront-OAC-signed (`AuthType=AWS_IAM`) requests returned `403 Forbidden` with
zero invocations. API Gateway (HTTP API) is the SCP-friendly equivalent. We lose
response streaming, but uploads bypass Lambda (presigned S3) and a ≤5 MB download
fits comfortably under API Gateway's 10 MB response limit, so it's a non-issue.

## Deployed resources

| Resource | Identifier |
| --- | --- |
| S3 bucket | `dfad-apps-992382469622` (us-west-2, private, CORS for dfad.app, 1-day lifecycle) |
| DynamoDB table | `dfad-deployments` (PK `id`, on-demand, TTL on `expiresAt`) |
| IAM role | `dfad-lambda-role` (logs + S3 `apps/*` + DynamoDB table access) |
| Lambda | `dfad` (nodejs20.x, 512 MB, 30s, handler `lambda.handler`) |
| API Gateway | HTTP API `ybojlzfxa4` ($default → Lambda AWS_PROXY) |
| ACM cert | `dfad.app` + `*.dfad.app` (**us-east-1**, DNS-validated) |
| CloudFront | `E17STVFYZ4BILW` → `d3kvnjz7zvecc3.cloudfront.net` |
| Route 53 | hosted zone `Z052032817DN1PDEC45CW`; A/AAAA aliases for `dfad.app` + `apps.dfad.app` |

Namecheap nameservers point at the Route 53 delegation set for `dfad.app`.

## Lambda environment variables

```
STORAGE_DRIVER=s3
S3_BUCKET=dfad-apps-992382469622
DYNAMODB_TABLE=dfad-deployments
APPS_BASE_URL=https://apps.dfad.app
TTL_HOURS=24
MAX_BYTES=5242880
RATE_LIMIT_MAX=10
RATE_LIMIT_WINDOW_SECONDS=600
IP_HASH_SALT=<secret>
# AWS_REGION is provided automatically by the Lambda runtime (us-west-2).
```

## Redeploying code

```bash
npm run package:lambda          # esbuild bundle -> build/{lambda.js,index.html,package.json}
( cd build && zip -qr /tmp/dfad-lambda.zip . )
aws lambda update-function-code --function-name dfad --region us-west-2 \
  --zip-file fileb:///tmp/dfad-lambda.zip
```
CloudFront caching is disabled, so code changes are live as soon as the function
update finishes (no invalidation needed).

## Origin isolation

Apps are served from `apps.dfad.app`, a different origin from the upload UI on
`dfad.app`, so uploaded JS cannot read the upload site's cookies/localStorage.
Both hostnames currently share one CloudFront distribution and the Lambda routes
by path. A per-app subdomain scheme (`<id>.apps.dfad.app`) would isolate apps from
each other too, but needs the wildcard cert (already issued) plus host-based routing.

## Smoke test

```bash
# 3-step deploy from the CLI (mirrors the browser):
curl -s -XPOST https://dfad.app/api/deploy            # -> {id, upload:{url,fields}}
# ...POST the file to upload.url (fields first, file last)...
curl -s -XPOST https://dfad.app/api/finalize -d '{"id":"..."}' -H 'content-type: application/json'
# -> {url: https://apps.dfad.app/a/<id>}; open it.
```

## Teardown

```bash
aws cloudfront get-distribution-config --id E17STVFYZ4BILW   # disable Enabled, update, wait, then:
aws cloudfront delete-distribution --id E17STVFYZ4BILW --if-match <etag>
aws apigatewayv2 delete-api --api-id ybojlzfxa4 --region us-west-2
aws lambda delete-function --function-name dfad --region us-west-2
aws iam delete-role-policy --role-name dfad-lambda-role --policy-name dfad-data-access
aws iam detach-role-policy --role-name dfad-lambda-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name dfad-lambda-role
aws dynamodb delete-table --table-name dfad-deployments --region us-west-2
aws s3 rb s3://dfad-apps-992382469622 --force
aws acm delete-certificate --region us-east-1 --certificate-arn <cert-arn>   # after CloudFront is gone
# Route 53 hosted zone Z052032817DN1PDEC45CW + records, if fully decommissioning.
```
