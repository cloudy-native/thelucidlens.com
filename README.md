# thelucidlens.com

Multi-subject photography portfolio for **[thelucidlens.com](https://thelucidlens.com)**.

| Piece | Path | Role |
| --- | --- | --- |
| **Website** | [`website/`](website/) | Astro static site (pages, galleries, generated markdown) |
| **Infrastructure** | [`stack/`](stack/) | AWS CDK — S3, CloudFront, ACM, Route 53 |
| **Photos (source)** | Removable drive (e.g. `/Volumes/Recordings/portfolio`) | Full-resolution originals + optional YAML sidecars |
| **Photos (served)** | Private S3 + CloudFront | `https://photos.thelucidlens.com/…` |

**Git does not store image binaries.** The repo holds only lightweight markdown (metadata + CDN URLs). Images live on the drive and in the stack-created photo bucket.

---

## Architecture

```text
/Volumes/Recordings/portfolio/          # source of truth (drive)
  city/
    _subject.yml                        # optional subject blurb / order / cover
    IMG_1072.jpg
    IMG_1072.yml                        # optional title / caption overrides
  coast/ …

        │  import-portfolio.mjs
        ▼
website/src/content/subjects/*.md       # committed
website/src/content/photos/*.md         # committed (image: https://photos…/…)

        │  sync-photos-s3.sh
        ▼
s3://<PhotoBucketName>/city/…           # private; CDK-created

        │  CloudFront (OAC)
        ▼
https://photos.thelucidlens.com/city/…

https://thelucidlens.com                # Astro site → website S3 + CloudFront
https://www.thelucidlens.com
```

Two CloudFront distributions:

| Host | Origin |
| --- | --- |
| `thelucidlens.com`, `www.thelucidlens.com` | Website bucket (Astro `dist/`) |
| `photos.thelucidlens.com` | Photo bucket (OAC; not public) |

---

## Prerequisites

- **Node.js** ≥ 22.12 (website)
- **pnpm** (website)
- **npm** (stack)
- **AWS CLI** with SSO/credentials for the deploy account
- **AWS CDK** via the stack’s local `aws-cdk` package (`npx cdk`)
- Route 53 **hosted zone** for `thelucidlens.com`
- Portfolio drive mounted when importing or syncing photos

```bash
# Typical auth (adjust profile as needed)
aws sso login
```

Region should be **`us-east-1`** (CloudFront ACM certificates must live there).

---

## Repository layout

```text
thelucidlens.com/
├── README.md                 ← this file
├── website/                  # Astro app
│   ├── src/
│   │   ├── content/          # subjects + photos (generated; commit these)
│   │   ├── pages/
│   │   └── components/
│   ├── scripts/
│   │   ├── import-portfolio.mjs
│   │   └── sync-photos-s3.sh
│   └── package.json
└── stack/                    # CDK
    ├── bin/thelucidlens.ts
    ├── lib/thelucidlens-stack.ts
    └── package.json
```

More detail: [`website/README.md`](website/README.md), [`stack/README.md`](stack/README.md).

---

## First-time setup

### 1. Install dependencies

```bash
# Website
cd website
pnpm install

# Stack
cd ../stack
npm install
```

### 2. Bootstrap CDK (once per account/region)

```bash
cd stack
npx cdk bootstrap
```

### 3. Build the site

```bash
cd website
pnpm build
```

### 4. Deploy infrastructure + site

```bash
cd stack
npx cdk deploy
```

Note the stack outputs (especially **`PhotoBucketName`** and **`PhotosUrl`**).

If deploy fails with *“CNAMEs … already associated with a different resource”*, another CloudFront distribution already owns `thelucidlens.com` / `www` / `photos`. Free those alternate domain names (or delete the old distribution), wait a few minutes, redeploy. ACM validation CNAMEs in Route 53 are expected and are not the conflict.

### 5. Sync photos into the new bucket

```bash
cd website

PHOTO_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name TheLucidLensStack \
  --query "Stacks[0].Outputs[?OutputKey=='PhotoBucketName'].OutputValue" \
  --output text)

pnpm sync:photos -- \
  --source /Volumes/Recordings/portfolio \
  --bucket "$PHOTO_BUCKET"
```

### 6. Generate content from the drive

```bash
cd website

pnpm import:photos -- \
  --source /Volumes/Recordings/portfolio \
  --base-url https://photos.thelucidlens.com \
  --clean
```

### 7. Build and redeploy the site (so galleries match the import)

```bash
cd website && pnpm build
cd ../stack && npx cdk deploy
```

### 8. Commit content changes

```bash
git add website/src/content
git commit -m "Update portfolio content from drive"
```

---

## Day-to-day workflows

### A. Local site development (no deploy)

```bash
cd website
pnpm install   # if needed
pnpm dev       # http://localhost:4321
```

Photos load from `https://photos.thelucidlens.com` even in dev. The drive is not required for `pnpm dev` unless you are re-importing.

---

### B. Add / remove / replace photos

1. **Edit the drive** — add, delete, or replace files under subject folders:

   ```text
   /Volumes/Recordings/portfolio/<subject>/<file>.jpg
   ```

2. **Optional metadata on the drive**

   Subject folder:

   ```yaml
   # city/_subject.yml
   title: City
   description: Night streets and glass.
   order: 1
   cover: IMG_1072.jpg
   ```

   Per photo:

   ```yaml
   # city/IMG_1072.yml
   title: Rain on Swanston   # human title only; never shown if empty
   caption: After the show.
   location: Melbourne, Australia
   # hidden: true
   ```

   Camera filenames are **never shown** in the UI. Only sidecar (or real EXIF) titles/captions appear.

3. **Re-import content** (regenerates markdown; `--clean` deletes stale entries):

   ```bash
   cd website
   pnpm import:photos -- \
     --source /Volumes/Recordings/portfolio \
     --base-url https://photos.thelucidlens.com \
     --clean
   ```

   Optional: create empty sidecars on the drive for later editing:

   ```bash
   pnpm import:photos -- \
     --source /Volumes/Recordings/portfolio \
     --base-url https://photos.thelucidlens.com \
     --write-sidecars \
     --clean
   ```

4. **Sync images to S3**

   ```bash
   cd website
   PHOTO_BUCKET=$(aws cloudformation describe-stacks \
     --stack-name TheLucidLensStack \
     --query "Stacks[0].Outputs[?OutputKey=='PhotoBucketName'].OutputValue" \
     --output text)

   # Preview
   pnpm sync:photos -- \
     --source /Volumes/Recordings/portfolio \
     --bucket "$PHOTO_BUCKET" \
     --dry-run

   # Upload (adds/updates; does not delete orphans by default)
   pnpm sync:photos -- \
     --source /Volumes/Recordings/portfolio \
     --bucket "$PHOTO_BUCKET"
   ```

   Sidecars (`.yml`) and `.DS_Store` are excluded from the sync.

   To **also remove** objects deleted from the drive, run a one-off:

   ```bash
   aws s3 sync /Volumes/Recordings/portfolio "s3://${PHOTO_BUCKET}" \
     --delete \
     --exclude ".DS_Store" \
     --exclude "*.yml" \
     --exclude "*.yaml" \
     --exclude "*.json" \
     --exclude "*.md" \
     --exclude ".*" \
     --exclude "*/.*"
   ```

   Use `--delete` carefully; it removes any S3 key not present on the drive.

5. **Build and deploy the site** (markdown + UI only; does not re-upload the photo library):

   ```bash
   cd website && pnpm build
   cd ../stack && npx cdk deploy
   ```

6. **Commit** updated `website/src/content/**`.

---

### C. Change site copy / layout only

No drive or photo sync needed:

```bash
# Edit website/src/…
cd website
pnpm dev          # iterate locally
pnpm build
cd ../stack && npx cdk deploy
```

`BucketDeployment` uploads `website/dist` and requests a CloudFront invalidation for the **site** distribution. It does not wait for invalidation to finish (avoids a flaky CDK/CloudFront waiter). Hard-refresh if you briefly see an old page.

---

### D. Change infrastructure only

```bash
cd stack
# Edit lib/thelucidlens-stack.ts, bin/thelucidlens.ts, …
npx cdk diff
npx cdk deploy
```

Always have a current `website/dist` when deploying: `BucketDeployment` packages that folder. If the site hasn’t changed, rebuild is still required if `dist/` is missing:

```bash
cd website && pnpm build
cd ../stack && npx cdk deploy
```

---

### E. Full “publish everything” sequence

Use this after a large portfolio update or on a new machine:

```bash
# Auth
aws sso login

# Paths
export PORTFOLIO_SOURCE=/Volumes/Recordings/portfolio
export PHOTO_BASE_URL=https://photos.thelucidlens.com
export PHOTO_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name TheLucidLensStack \
  --query "Stacks[0].Outputs[?OutputKey=='PhotoBucketName'].OutputValue" \
  --output text)

# 1) Content from drive → git
cd website
pnpm import:photos -- \
  --source "$PORTFOLIO_SOURCE" \
  --base-url "$PHOTO_BASE_URL" \
  --clean

# 2) Images → S3
pnpm sync:photos -- \
  --source "$PORTFOLIO_SOURCE" \
  --bucket "$PHOTO_BUCKET"

# 3) Site → S3 + CloudFront
pnpm build
cd ../stack
npx cdk deploy

# 4) Commit content
cd ..
git add website/src/content
git status
```

---

## Stack outputs (reference)

| Output | Meaning |
| --- | --- |
| `WebsiteUrl` | `https://thelucidlens.com` |
| `PhotosUrl` | `https://photos.thelucidlens.com` — use as import `--base-url` |
| `PhotoBucketName` | Target for `sync-photos-s3.sh --bucket` |
| `WebsiteBucketName` | Astro deploy bucket (managed by CDK) |
| `WebsiteDistributionDomainName` | Site CloudFront domain |
| `PhotoDistributionDomainName` | Photo CloudFront domain |
| `PhotoDistributionId` | Photo CloudFront id — used by `sync-photos-s3.sh` for a full `/*` invalidation after each sync |

```bash
aws cloudformation describe-stacks \
  --stack-name TheLucidLensStack \
  --query "Stacks[0].Outputs" \
  --output table
```

---

## What is committed vs not

| Committed | Not committed |
| --- | --- |
| Site source (`website/src/**`) | JPEG/PNG originals |
| Generated content markdown | Drive sidecars (optional; live on the volume) |
| CDK source (`stack/lib`, `stack/bin`) | `node_modules/`, `dist/`, `cdk.out/` |
| Lockfiles | AWS credentials |

Photo bucket: **`RemovalPolicy.RETAIN`** — destroying the stack does not delete portfolio objects.

---

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Images 404 on the site | Sync to `PhotoBucketName`; confirm keys like `city/file.jpg`; wait for CF edge |
| Gallery shows old photos after re-export | Re-run `pnpm sync:photos` (full sync + global `/*` CDN invalidation); hard-refresh browser |
| Gallery shows deleted photos | Re-run import with `--clean`, rebuild, redeploy |
| Import can’t find drive | Mount volume; path must match `--source` |
| CDK: CNAME already associated | Free alternate domain names on the **old** CloudFront distribution |
| CDK: invalidation Lambda error | Already mitigated with `waitForDistributionInvalidation: false`; retry deploy |
| Cert stuck pending | ACM DNS validation CNAMEs in the hosted zone; wait for DNS |
| `pnpm install` supply-chain age errors | Known with very new packages; retry later or use project-documented workarounds |

---

## Quick command cheat sheet

```bash
# Dev
cd website && pnpm dev

# Import (drive → markdown)
cd website && pnpm import:photos -- \
  --source /Volumes/Recordings/portfolio \
  --base-url https://photos.thelucidlens.com \
  --clean

# Sync (drive → photo S3)
PHOTO_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name TheLucidLensStack \
  --query "Stacks[0].Outputs[?OutputKey=='PhotoBucketName'].OutputValue" \
  --output text)
cd website && pnpm sync:photos -- \
  --source /Volumes/Recordings/portfolio \
  --bucket "$PHOTO_BUCKET"

# Deploy (site + stack)
cd website && pnpm build
cd ../stack && npx cdk deploy
```
