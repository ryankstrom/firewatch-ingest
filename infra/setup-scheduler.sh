#!/usr/bin/env bash
# One-time setup of Cloud Scheduler triggers for the four ingest jobs.
#
# Cloud Scheduler isn't available in northamerica-northeast2 (Toronto), so the
# scheduler lives in northamerica-northeast1 (Montreal) and makes HTTPS calls
# cross-region to the jobs in Toronto. ~10ms extra — negligible.
#
# Idempotent: safe to re-run; existing schedulers are deleted and recreated.

set -euo pipefail

PROJECT="${PROJECT:-sandbox-day3}"
RUN_REGION="${RUN_REGION:-northamerica-northeast2}"
SCHED_REGION="${SCHED_REGION:-northamerica-northeast1}"

SA_NAME="firewatch-scheduler"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

echo "==> Ensuring scheduler service account exists"
gcloud iam service-accounts describe "${SA_EMAIL}" --project "${PROJECT}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${SA_NAME}" \
       --display-name="FireWatch Cloud Scheduler invoker" \
       --project "${PROJECT}"

# Wait for SA propagation — IAM is eventually consistent across services.
until gcloud iam service-accounts describe "${SA_EMAIL}" --project "${PROJECT}" >/dev/null 2>&1; do
  sleep 2
done

echo "==> Granting run.invoker on each ingest job"
for source in cwfis_hotspots cwfis_perimeters firms_canada noaa_hms_smoke; do
  job_name="firewatch-${source//_/-}"
  gcloud run jobs add-iam-policy-binding "${job_name}" \
    --region "${RUN_REGION}" --project "${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/run.invoker" >/dev/null
done

create_schedule() {
  local source="$1"
  local cron="$2"
  local desc="$3"
  local job_name="firewatch-${source//_/-}"
  local sched_name="${job_name}-trigger"
  local uri="https://${RUN_REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${job_name}:run"

  if gcloud scheduler jobs describe "${sched_name}" \
       --location "${SCHED_REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud scheduler jobs delete "${sched_name}" \
      --location "${SCHED_REGION}" --project "${PROJECT}" --quiet
  fi

  echo "==> Creating ${sched_name} (${cron})"
  gcloud scheduler jobs create http "${sched_name}" \
    --location "${SCHED_REGION}" --project "${PROJECT}" \
    --schedule "${cron}" \
    --time-zone "UTC" \
    --uri "${uri}" \
    --http-method POST \
    --oauth-service-account-email "${SA_EMAIL}" \
    --description "${desc}"
}

# Cadences match each source's native refresh rate (don't over-poll).
create_schedule cwfis_hotspots    "0 * * * *"     "Hourly CWFIS hotspot ingest"
create_schedule cwfis_perimeters  "15 */3 * * *"  "Every 3h CWFIS active perimeter ingest"
create_schedule firms_canada      "30 */3 * * *"  "Every 3h NASA FIRMS Canada ingest"
create_schedule noaa_hms_smoke    "0 18 * * *"    "Daily 18:00 UTC NOAA HMS smoke ingest"

echo
echo "✓ Schedulers ready. List them:"
echo "  gcloud scheduler jobs list --location ${SCHED_REGION} --project ${PROJECT}"
