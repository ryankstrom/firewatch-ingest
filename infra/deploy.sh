#!/usr/bin/env bash
# Manual deploy of the firewatch-ingest jobs (build + push + deploy).
# GitHub Actions (.github/workflows/deploy.yml) is the normal path; this script
# exists as a manual fallback / from-scratch bootstrap.
#
# Prerequisites:
#   - gcloud authenticated with project sandbox-day3 set
#   - FIRMS_MAP_KEY already stored in Secret Manager (secret name: firms-map-key)
#     See: infra/store_firms_key.sh
#   - For Cloud Scheduler triggers, run infra/setup-scheduler.sh separately.

set -euo pipefail

PROJECT="${PROJECT:-sandbox-day3}"
REGION="${REGION:-northamerica-northeast2}"
BUCKET="${BUCKET:-sandbox-day3-firewatch-raw}"
REPO="${REPO:-firewatch}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/firewatch-ingest:${IMAGE_TAG}"

SA_NAME="firewatch-ingest"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

SCHEDULER_SA_NAME="firewatch-scheduler"
SCHEDULER_SA_EMAIL="${SCHEDULER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

cd "$(dirname "$0")/.."

echo "==> Building image ${IMAGE}"
gcloud builds submit --tag "${IMAGE}" --project "${PROJECT}"

echo "==> Ensuring service accounts exist"
gcloud iam service-accounts describe "${SA_EMAIL}" --project "${PROJECT}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${SA_NAME}" \
       --display-name="FireWatch ingest runtime" --project "${PROJECT}"

gcloud iam service-accounts describe "${SCHEDULER_SA_EMAIL}" --project "${PROJECT}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${SCHEDULER_SA_NAME}" \
       --display-name="FireWatch scheduler invoker" --project "${PROJECT}"

echo "==> Granting runtime SA write access to bucket"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin" >/dev/null

echo "==> Granting runtime SA read access to FIRMS secret"
gcloud secrets add-iam-policy-binding firms-map-key \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --project "${PROJECT}" >/dev/null

deploy_job() {
  local source="$1"
  local job_name="firewatch-${source//_/-}"
  local extra_env=("--set-env-vars" "GCP_PROJECT=${PROJECT},GCS_BUCKET=${BUCKET}")
  local secrets_args=()

  if [[ "$source" == "firms_canada" ]]; then
    secrets_args=("--set-secrets" "FIRMS_MAP_KEY=firms-map-key:latest")
  fi

  echo "==> Deploying job ${job_name}"
  gcloud run jobs deploy "${job_name}" \
    --image "${IMAGE}" \
    --region "${REGION}" \
    --project "${PROJECT}" \
    --service-account "${SA_EMAIL}" \
    --args "${source}" \
    --max-retries 2 \
    --task-timeout 600s \
    "${extra_env[@]}" \
    "${secrets_args[@]}"
}

deploy_job cwfis_hotspots
deploy_job cwfis_perimeters
deploy_job firms_canada
deploy_job noaa_hms_smoke

# Cloud Scheduler triggers are set up by infra/setup-scheduler.sh.
# (Cloud Scheduler isn't available in northamerica-northeast2 Toronto,
# so schedulers live in northamerica-northeast1 Montreal and call cross-region.)

echo
echo "✓ Deploy complete."
echo "  · Trigger a job manually:"
echo "      gcloud run jobs execute firewatch-cwfis-hotspots --region ${REGION} --project ${PROJECT}"
echo "  · Set up the recurring schedule (one-time):"
echo "      ./infra/setup-scheduler.sh"
