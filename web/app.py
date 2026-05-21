"""FireWatch web — serves the static SPA, proxies GeoJSON from Cloud Storage,
and exposes a rate-limited /refresh endpoint that triggers the ingest jobs.

Keeping the bucket private and proxying through here means we can:
- Add server-side caching headers
- Normalize/enrich data later without changing client URLs
- Provide an on-demand refresh trigger without exposing GCP credentials
"""
from __future__ import annotations

import logging
import os
import threading
from time import time

from flask import Flask, Response, abort, jsonify, request
from google.cloud import run_v2, storage

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

PROJECT = os.environ.get("GCP_PROJECT", "sandbox-day3")
REGION = os.environ.get("RUN_REGION", "northamerica-northeast2")
BUCKET = os.environ.get("GCS_BUCKET", "sandbox-day3-firewatch-raw")

ALLOWED_SOURCES = ("cwfis_hotspots", "cwfis_perimeters", "firms_canada", "noaa_hms_smoke")
# Sources we actually re-trigger on user refresh (skip daily-cadence smoke).
TRIGGERABLE_SOURCES = ("cwfis_hotspots", "cwfis_perimeters", "firms_canada")

CACHE_TTL_SECONDS = 60        # short — schedulers update GCS independently
REFRESH_COOLDOWN_SECONDS = 30  # global rate limit on /refresh

app = Flask(__name__, static_folder="static", static_url_path="")
_storage = storage.Client()
_jobs = run_v2.JobsClient()
_cache: dict[str, tuple[float, bytes]] = {}
_refresh_lock = threading.Lock()
_refresh_state = {"last_at": 0.0}


def _fetch_latest(source: str, *, bypass_cache: bool = False) -> bytes:
    if not bypass_cache:
        cached = _cache.get(source)
        now = time()
        if cached and (now - cached[0]) < CACHE_TTL_SECONDS:
            return cached[1]
    blob = _storage.bucket(BUCKET).blob(f"{source}/latest.geojson")
    body = blob.download_as_bytes()
    _cache[source] = (time(), body)
    return body


@app.route("/")
def index() -> Response:
    return app.send_static_file("index.html")


@app.route("/data/<source>.geojson")
def data(source: str) -> Response:
    if source not in ALLOWED_SOURCES:
        abort(404)
    bypass = request.args.get("fresh") == "1"
    try:
        body = _fetch_latest(source, bypass_cache=bypass)
    except Exception as e:
        log.exception("failed to read %s from GCS", source)
        abort(502, description=str(e))
    cache_header = "no-store" if bypass else f"public, max-age={CACHE_TTL_SECONDS}"
    return Response(
        body,
        mimetype="application/geo+json",
        headers={"Cache-Control": cache_header},
    )


@app.route("/refresh", methods=["POST"])
def refresh() -> Response:
    """Trigger the ingest jobs (fire-and-forget). Client polls /data/*?fresh=1.

    Rate-limited globally: one refresh per REFRESH_COOLDOWN_SECONDS across all
    users of this instance. (Cloud Run scales 0-N, so effective rate is N× this
    — still fine for v1.)
    """
    with _refresh_lock:
        now = time()
        elapsed = now - _refresh_state["last_at"]
        if elapsed < REFRESH_COOLDOWN_SECONDS:
            return jsonify({
                "error": "rate_limited",
                "retry_after_seconds": int(REFRESH_COOLDOWN_SECONDS - elapsed) + 1,
            }), 429
        _refresh_state["last_at"] = now

    triggered: list[str] = []
    errors: dict[str, str] = {}
    for source in TRIGGERABLE_SOURCES:
        job_id = f"firewatch-{source.replace('_', '-')}"
        name = f"projects/{PROJECT}/locations/{REGION}/jobs/{job_id}"
        try:
            _jobs.run_job(name=name)  # fire and forget — operation handle ignored
            triggered.append(source)
        except Exception as e:
            log.warning("failed to trigger %s: %s", source, e)
            errors[source] = str(e)

    # Invalidate cache so the next /data fetch reads fresh
    for source in triggered:
        _cache.pop(source, None)

    return jsonify({
        "triggered": triggered,
        "errors": errors,
        "poll_for_seconds": 30,
        "cooldown_seconds": REFRESH_COOLDOWN_SECONDS,
    })


@app.route("/healthz")
def healthz() -> tuple[str, int]:
    return "ok", 200
