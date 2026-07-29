#!/usr/bin/env bash
# Sync local portfolio images to an S3 bucket used as a CloudFront origin,
# then invalidate the entire photo CDN.
#
# Coarse by design: re-uploads when objects differ (no --size-only), and always
# purges /* on the photo distribution after a successful sync.
#
# Prerequisites:
#   - AWS CLI configured (aws configure / SSO)
#   - Bucket exists (private is fine; CloudFront OAC recommended)
#
# Usage:
#   ./scripts/sync-photos-s3.sh \
#     --source /Volumes/Recordings/portfolio \
#     --bucket <PhotoBucketName from cdk deploy> \
#     [--distribution-id <PhotoDistributionId>] \
#     [--profile default] \
#     [--prefix ''] \
#     [--stack-name TheLucidLensStack] \
#     [--photos-domain photos.thelucidlens.com] \
#     [--no-invalidate] \
#     [--wait-invalidate] \
#     [--dry-run]
#
# Object keys mirror the folder layout:
#   s3://$BUCKET/city/IMG_1493.jpg
# so CloudFront URL https://photos.thelucidlens.com/city/IMG_1493.jpg matches
# import-portfolio --base-url https://photos.thelucidlens.com
#
# Resolve stack outputs after deploy:
#   aws cloudformation describe-stacks --stack-name TheLucidLensStack \
#     --query "Stacks[0].Outputs[?OutputKey=='PhotoBucketName'].OutputValue" --output text
#   aws cloudformation describe-stacks --stack-name TheLucidLensStack \
#     --query "Stacks[0].Outputs[?OutputKey=='PhotoDistributionId'].OutputValue" --output text

set -euo pipefail

SOURCE="${PORTFOLIO_SOURCE:-}"
BUCKET="${PHOTO_S3_BUCKET:-}"
PROFILE="${AWS_PROFILE:-}"
DISTRIBUTION_ID="${PHOTO_CF_DISTRIBUTION_ID:-}"
STACK_NAME="${PHOTO_STACK_NAME:-TheLucidLensStack}"
PHOTOS_DOMAIN="${PHOTO_CF_DOMAIN:-photos.thelucidlens.com}"
PREFIX=""
DRY_RUN=0
NO_INVALIDATE=0
WAIT_INVALIDATE=0

usage() {
  sed -n '2,36p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --distribution-id) DISTRIBUTION_ID="$2"; shift 2 ;;
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --photos-domain) PHOTOS_DOMAIN="$2"; shift 2 ;;
    --no-invalidate) NO_INVALIDATE=1; shift ;;
    --wait-invalidate) WAIT_INVALIDATE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

if [[ -z "$SOURCE" || -z "$BUCKET" ]]; then
  echo "Error: --source and --bucket are required." >&2
  usage 1
fi

if [[ ! -d "$SOURCE" ]]; then
  echo "Source not found: $SOURCE" >&2
  echo "Is the removable drive mounted?" >&2
  exit 1
fi

DEST="s3://${BUCKET}"
if [[ -n "$PREFIX" ]]; then
  PREFIX="${PREFIX#/}"
  PREFIX="${PREFIX%/}"
  DEST="${DEST}/${PREFIX}"
fi

AWS=(aws)
if [[ -n "$PROFILE" ]]; then
  AWS+=(--profile "$PROFILE")
fi

# Full sync: compare etag/size (not size-only), delete remote orphans.
ARGS=(
  s3 sync "$SOURCE" "$DEST"
  --exclude ".DS_Store"
  --exclude "*.yml"
  --exclude "*.yaml"
  --exclude "*.json"
  --exclude "*.md"
  --exclude ".*"
  --exclude "*/.*"
  --delete
)

# Long browser/edge cache; we always invalidate CloudFront after sync.
ARGS+=(--cache-control "public, max-age=31536000, immutable")

if [[ "$DRY_RUN" -eq 1 ]]; then
  ARGS+=(--dryrun)
fi

echo "Sync: $SOURCE  →  $DEST"
echo "Cmd:  ${AWS[*]} ${ARGS[*]}"
echo

"${AWS[@]}" "${ARGS[@]}"

echo

resolve_distribution_id() {
  if [[ -n "$DISTRIBUTION_ID" ]]; then
    printf '%s\n' "$DISTRIBUTION_ID"
    return 0
  fi

  local id=""

  if [[ -n "$STACK_NAME" ]]; then
    id="$("${AWS[@]}" cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --query "Stacks[0].Outputs[?OutputKey=='PhotoDistributionId'].OutputValue | [0]" \
      --output text 2>/dev/null || true)"
    if [[ -n "$id" && "$id" != "None" && "$id" != "null" ]]; then
      printf '%s\n' "$id"
      return 0
    fi
  fi

  if [[ -n "$PHOTOS_DOMAIN" ]]; then
    id="$("${AWS[@]}" cloudfront list-distributions \
      --query "DistributionList.Items[?Aliases.Items!=null && contains(Aliases.Items, '${PHOTOS_DOMAIN}')].Id | [0]" \
      --output text 2>/dev/null || true)"
    if [[ -n "$id" && "$id" != "None" && "$id" != "null" ]]; then
      printf '%s\n' "$id"
      return 0
    fi
  fi

  return 1
}

if [[ "$NO_INVALIDATE" -eq 1 ]]; then
  echo "CloudFront invalidation skipped (--no-invalidate)."
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run: would invalidate CloudFront path /* on the photo distribution."
else
  if ! DISTRIBUTION_ID="$(resolve_distribution_id)"; then
    echo "Error: could not resolve photo CloudFront distribution id." >&2
    echo "Pass --distribution-id, set PHOTO_CF_DISTRIBUTION_ID, or ensure stack output PhotoDistributionId / alias ${PHOTOS_DOMAIN} exists." >&2
    exit 1
  fi

  echo "Invalidating entire photo CDN (/*) on ${DISTRIBUTION_ID}…"
  INV_OUT="$("${AWS[@]}" cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/*" \
    --query '{Id:Invalidation.Id,Status:Invalidation.Status}' \
    --output text)"
  echo "Invalidation: $INV_OUT"

  if [[ "$WAIT_INVALIDATE" -eq 1 ]]; then
    INV_ID="${INV_OUT%%[[:space:]]*}"
    echo "Waiting for invalidation ${INV_ID}…"
    "${AWS[@]}" cloudfront wait invalidation-completed \
      --distribution-id "$DISTRIBUTION_ID" \
      --id "$INV_ID"
    echo "Invalidation completed."
  else
    echo "(Not waiting; edges usually refresh within 1–2 minutes. Use --wait-invalidate to block.)"
  fi
fi

echo
echo "Done. Import markdown with:"
echo "  node scripts/import-portfolio.mjs --source \"$SOURCE\" --base-url \"https://${PHOTOS_DOMAIN}\""
