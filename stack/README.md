# thelucidlens.com CDK

AWS CDK stack for **thelucidlens.com**:

| Resource | Purpose |
| --- | --- |
| Website S3 bucket | Astro static build (`../website/dist`) |
| Photo S3 bucket | Portfolio originals (created here; synced outside CDK) |
| Website CloudFront | `thelucidlens.com`, `www.thelucidlens.com` |
| Photo CloudFront | `photos.thelucidlens.com` → photo bucket via **OAC** |
| ACM + Route 53 | Cert + alias records for all three names |

```text
thelucidlens.com  ──►  CloudFront (site)  ──►  website bucket
www.thelucidlens.com ─┘

photos.thelucidlens.com ──► CloudFront (photos, OAC) ──► photo bucket
                                                       (city/…, coast/…, …)
```

## Prerequisites

1. AWS CLI credentials with rights for CloudFormation, S3, CloudFront, ACM, Route 53
2. Hosted zone for `thelucidlens.com` in Route 53
3. Built site: `cd ../website && pnpm build`

## Deploy

```bash
npm install
npx cdk bootstrap   # once per account/region
npx cdk deploy
```

Note the outputs:

| Output | Use |
| --- | --- |
| `PhotosUrl` | `https://photos.thelucidlens.com` → import `--base-url` / `PHOTO_BASE_URL` |
| `PhotoBucketName` | sync target → `sync-photos-s3.sh --bucket …` |
| `PhotoDistributionId` | photo CDN id — resolved automatically by `sync-photos-s3.sh` for invalidation |

```bash
# After deploy — sync portfolio into the stack-created bucket
cd ../website
pnpm sync:photos -- \
  --source /Volumes/Recordings/portfolio \
  --bucket "$(aws cloudformation describe-stacks \
      --stack-name TheLucidLensStack \
      --query "Stacks[0].Outputs[?OutputKey=='PhotoBucketName'].OutputValue" \
      --output text)"

pnpm import:photos -- \
  --source /Volumes/Recordings/portfolio \
  --base-url https://photos.thelucidlens.com \
  --clean
```

## Redeploy site only

```bash
cd ../website && pnpm build
cd ../stack && npx cdk deploy
```

`BucketDeployment` uploads `website/dist` and requests a CloudFront invalidation for the site distribution (it does **not** wait for invalidation to finish — avoids a flaky CDK/CloudFront check). Photos are **not** deployed by CDK.

## Notes

- Website and photo buckets are separate so site deploys never prune portfolio objects.
- Photo bucket is private (`BLOCK_ALL`); only the photo CloudFront distribution can read via OAC (CDK-managed bucket policy).
- Photo bucket uses `RemovalPolicy.RETAIN` so stack destroy does not delete originals.
- Photo cache TTL is one year; `sync-photos-s3.sh` always invalidates the entire photo CDN (`/*`) after each sync.
- If you previously synced to a hand-made `s3://thelucidlens.com` bucket, re-sync into `PhotoBucketName` after the first deploy.
