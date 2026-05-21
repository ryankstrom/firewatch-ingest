"""Cloud Storage upload helpers — shared across all source ingesters."""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

from google.cloud import storage

log = logging.getLogger(__name__)

_client: storage.Client | None = None


def _bucket() -> storage.Bucket:
    global _client
    if _client is None:
        _client = storage.Client(project=os.environ.get("GCP_PROJECT"))
    name = os.environ.get("GCS_BUCKET")
    if not name:
        raise RuntimeError("GCS_BUCKET env var is required")
    return _client.bucket(name)


def write_geojson(source: str, geojson: dict, *, fetched_at: datetime | None = None) -> tuple[str, str]:
    """Write GeoJSON to two paths: a timestamped immutable snapshot and `latest.geojson`.

    Returns (timestamped_path, latest_path).
    """
    ts = fetched_at or datetime.now(timezone.utc)
    day = ts.strftime("%Y-%m-%d")
    hms = ts.strftime("%H%M%S")

    geojson.setdefault("metadata", {})
    geojson["metadata"]["source"] = source
    geojson["metadata"]["fetched_at"] = ts.isoformat()

    body = json.dumps(geojson, separators=(",", ":"))
    bucket = _bucket()

    snapshot_path = f"{source}/{day}/{hms}.geojson"
    latest_path = f"{source}/latest.geojson"

    bucket.blob(snapshot_path).upload_from_string(body, content_type="application/geo+json")
    bucket.blob(latest_path).upload_from_string(body, content_type="application/geo+json")

    log.info("wrote %s features=%s -> gs://%s/%s",
             source, len(geojson.get("features", [])), bucket.name, snapshot_path)
    return snapshot_path, latest_path


def write_raw(source: str, body: bytes, suffix: str, *, fetched_at: datetime | None = None) -> str:
    """Write a non-GeoJSON raw payload (e.g. KML) under {source}/raw/."""
    ts = fetched_at or datetime.now(timezone.utc)
    day = ts.strftime("%Y-%m-%d")
    hms = ts.strftime("%H%M%S")
    path = f"{source}/raw/{day}/{hms}.{suffix}"
    _bucket().blob(path).upload_from_string(body)
    log.info("wrote raw %s -> gs://%s/%s", source, _bucket().name, path)
    return path
