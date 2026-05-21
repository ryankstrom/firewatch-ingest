"""FireWatch web — serves the static SPA and proxies GeoJSON from Cloud Storage.

Keeping the bucket private and proxying through here means we can:
- Add server-side caching headers
- Normalize/enrich data later without changing client URLs
- Audit who's reading what
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from time import time

from flask import Flask, Response, abort
from google.cloud import storage

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

BUCKET = os.environ.get("GCS_BUCKET", "sandbox-day3-firewatch-raw")
ALLOWED_SOURCES = {"cwfis_hotspots", "cwfis_perimeters", "firms_canada", "noaa_hms_smoke"}
CACHE_TTL_SECONDS = 300  # 5 min — match the fastest ingest cadence (hourly hotspots)

app = Flask(__name__, static_folder="static", static_url_path="")
_storage = storage.Client()
_cache: dict[str, tuple[float, bytes]] = {}


def _fetch_latest(source: str) -> bytes:
    cached = _cache.get(source)
    now = time()
    if cached and (now - cached[0]) < CACHE_TTL_SECONDS:
        return cached[1]
    blob = _storage.bucket(BUCKET).blob(f"{source}/latest.geojson")
    body = blob.download_as_bytes()
    _cache[source] = (now, body)
    return body


@app.route("/")
def index() -> Response:
    return app.send_static_file("index.html")


@app.route("/data/<source>.geojson")
def data(source: str) -> Response:
    if source not in ALLOWED_SOURCES:
        abort(404)
    try:
        body = _fetch_latest(source)
    except Exception as e:
        log.exception("failed to read %s from GCS", source)
        abort(502, description=str(e))
    return Response(
        body,
        mimetype="application/geo+json",
        headers={"Cache-Control": f"public, max-age={CACHE_TTL_SECONDS}"},
    )


@app.route("/healthz")
def healthz() -> tuple[str, int]:
    return "ok", 200
