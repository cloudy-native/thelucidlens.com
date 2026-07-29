# The Lucid Lens

Minimal multi-subject photography portfolio built with [Astro](https://astro.build).

**Images are not stored in git.** They live on a removable drive, sync to a **stack-created** private S3 bucket, and are served from CloudFront at `https://photos.thelucidlens.com` (OAC). The repo only holds lightweight markdown (titles, captions, EXIF, CDN URLs).

Infrastructure: CDK in [`../stack`](../stack).

## Architecture

```text
/Volumes/Recordings/portfolio/     # source of truth (drive)
  city/
    _subject.yml                   # optional subject blurb / order / cover
    IMG_1493.jpg
    IMG_1493.yml                   # optional title/caption overrides
  coast/ …

        │ import-portfolio.mjs
        ▼
src/content/subjects/*.md          # committed (small)
src/content/photos/*.md            # committed (small); image: https://photos…/

        │ sync-photos-s3.sh → PhotoBucketName (CDK output)
        ▼
s3://thelucidlensstack-photobucket…/city/…

        │ CloudFront + OAC (stack)
        ▼
https://photos.thelucidlens.com/city/…

https://thelucidlens.com           # Astro site (separate website bucket)
```

## Import photos → markdown

```sh
pnpm import:photos \
  --source /Volumes/Recordings/portfolio \
  --base-url https://photos.thelucidlens.com \
  --write-sidecars \
  --clean
```

Or with env vars from `.env.example`:

```sh
export PORTFOLIO_SOURCE=/Volumes/Recordings/portfolio
export PHOTO_BASE_URL=https://photos.thelucidlens.com
pnpm import:photos -- --write-sidecars --clean
```

### What the importer does

| Source | Becomes |
| --- | --- |
| Folder `city/` | Subject `src/content/subjects/city.md` |
| `city/IMG_1493.jpg` | Photo `src/content/photos/city-img-1493.md` |
| EXIF / Spotlight | width, height, date, camera, location (when GPS/place tags exist) |
| `_subject.yml` | title, description, order, cover filename |
| `IMG_1493.yml` | title, caption, location, date, order, `hidden: true` |

Photo display order: explicit sidecar `order` if set, otherwise **filename** (numeric-aware, so `tree-01` … `tree-10` sort correctly). Shoot date is metadata only.

Hand-edit **sidecars on the drive**, then re-run the import. Content under `src/content` is treated as generated output.

## Sync images to S3

Use the bucket name from stack output `PhotoBucketName` (not a fixed name):

```sh
PHOTO_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name TheLucidLensStack \
  --query "Stacks[0].Outputs[?OutputKey=='PhotoBucketName'].OutputValue" \
  --output text)

pnpm sync:photos \
  --source /Volumes/Recordings/portfolio \
  --bucket "$PHOTO_BUCKET" \
  --dry-run

pnpm sync:photos \
  --source /Volumes/Recordings/portfolio \
  --bucket "$PHOTO_BUCKET"
```

Object keys mirror the drive (`city/IMG_1493.jpg`). Sidecars (`.yml`) are excluded. Sync is coarse: full etag/size comparison (not size-only), remote orphans deleted, then the **entire** photo CDN is invalidated (`/*`) after every successful sync.

Import embeds a content-hash query on every image URL (`?v=abc123…`). That busts **browser** cache when you re-export under the same filename — CloudFront invalidation alone cannot clear already-downloaded `immutable` responses.

| Flag | Purpose |
| --- | --- |
| `--no-invalidate` | Skip the global CDN purge |
| `--wait-invalidate` | Block until invalidation completes |
| `--distribution-id` / `PHOTO_CF_DISTRIBUTION_ID` | Override auto-resolve from stack output / domain alias |

## Deploy site

```sh
pnpm build
cd ../stack && npx cdk deploy
```

## Commands

| Command | Action |
| --- | --- |
| `pnpm dev` | Dev server at `localhost:4321` |
| `pnpm build` | Production build to `./dist/` |
| `pnpm import:photos -- …` | Generate subject/photo markdown from the drive |
| `pnpm sync:photos -- …` | `aws s3 sync` images to `s3://thelucidlens.com` |

Prefer `astro dev --background` when running the dev server from agent tooling (see `AGENTS.md`).
