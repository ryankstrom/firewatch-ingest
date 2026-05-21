#!/usr/bin/env bash
# Store the NASA FIRMS MAP_KEY in Secret Manager.
# Usage: FIRMS_MAP_KEY=xxxxx ./infra/store_firms_key.sh

set -euo pipefail

PROJECT="${PROJECT:-sandbox-day3}"
SECRET_NAME="firms-map-key"

if [[ -z "${FIRMS_MAP_KEY:-}" ]]; then
  echo "FIRMS_MAP_KEY env var is required."
  echo "Register at https://firms.modaps.eosdis.nasa.gov/api/map_key/ first."
  exit 1
fi

if gcloud secrets describe "${SECRET_NAME}" --project "${PROJECT}" >/dev/null 2>&1; then
  echo "==> Adding new version to existing secret ${SECRET_NAME}"
  printf "%s" "${FIRMS_MAP_KEY}" | gcloud secrets versions add "${SECRET_NAME}" \
    --data-file=- --project "${PROJECT}"
else
  echo "==> Creating secret ${SECRET_NAME}"
  printf "%s" "${FIRMS_MAP_KEY}" | gcloud secrets create "${SECRET_NAME}" \
    --replication-policy=automatic --data-file=- --project "${PROJECT}"
fi

echo "✓ FIRMS key stored in Secret Manager as ${SECRET_NAME}"
