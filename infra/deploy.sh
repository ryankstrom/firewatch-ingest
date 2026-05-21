#!/usr/bin/env bash
# Deploy firewatch-ingest:
#   1. Build & push image via Cloud Build
#   2. Create/update one Cloud Run Job per source
#   3. Wire a Cloud Scheduler trigger to each job with its native cadence
#
# Prerequisites:
#   - gcloud authenticated with project sandbox-day3 set
#   - FIRMS_MAP_KEY already stored in Secret Manager (secret name: firms-map-key)
#     See: infra/store_firms_key.sh

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

echo "==> Granting scheduler SA permission to run jobs"
for source in cwfis_hotspots cwfis_perimeters firms_canada noaa_hms_smoke; do
  job_name="firewatch-${source//_/-}"
  gcloud run jobs add-iam-policy-binding "${job_name}" \
    --region "${REGION}" --project "${PROJECT}" \
    --member="serviceAccount:${SCHEDULER_SA_EMAIL}" \
    --role="roles/run.invoker" >/dev/null
done

create_schedule() {
  local source="$1"
  local cron="$2"
  local job_name="firewatch-${source//_/-}"
  local sched_name="${job_name}-trigger"
  local uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${job_name}:run"

  echo "==> Scheduling ${sched_name} (${cron})"
  gcloud scheduler jobs describe "${sched_name}" \
    --location "${REGION}" --project "${PROJECT}" >/dev/null 2>&1 \
    && gcloud scheduler jobs delete "${sched_name}" \
         --location "${REGION}" --project "${PROJECT}" --quiet || true

  gcloud scheduler jobs create http "${sched_name}" \
    --location "${REGION}" --project "${PROJECT}" \
    --schedule "${cron}" \
    --time-zone "UTC" \
    --uri "${uri}" \
    --http-method POST \
    --oauth-service-account-email "${SCHEDULER_SA_EMAIL}"
}

# Cadences match each source's native refresh rate (Woz: don't over-poll).
create_schedule cwfis_hotspots    "0 * * * *"     # hourly
create_schedule cwfis_perimeters  "0 */3 * * *"   # every 3 hours
create_schedule firms_canada      "30 */3 * * *"  # every 3 hours, offset
create_schedule noaa_hms_smoke    "0 18 * * *"    # daily 18:00 UTC (~1pm ET)

echo
echo "✓ Deploy complete. Trigger a job manually with:"
echo "  gcloud run jobs execute firewatch-cwfis-hotspots --region ${REGION} --project ${PROJECT}"
