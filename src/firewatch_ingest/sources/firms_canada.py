"""NASA FIRMS active fire data for Canada (VIIRS S-NPP, last 1 day).

API: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{w,s,e,n}/{day_range}
Requires FIRMS_MAP_KEY env var (register at firms.modaps.eosdis.nasa.gov/api/map_key).

We fetch CSV and convert to GeoJSON points so downstream code only deals with one format.
"""
from __future__ import annotations

import csv
import io
import logging
import os
import requests

from firewatch_ingest.gcs import write_geojson

log = logging.getLogger(__name__)

# Rough Canada bbox: west, south, east, north
CANADA_BBOX = "-141,41,-52,84"
SOURCE = "VIIRS_SNPP_NRT"  # 375 m, near real-time
DAY_RANGE = 1


def _url() -> str:
    key = os.environ.get("FIRMS_MAP_KEY")
    if not key:
        raise RuntimeError("FIRMS_MAP_KEY env var is required")
    return f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{SOURCE}/{CANADA_BBOX}/{DAY_RANGE}"


def _csv_to_geojson(csv_text: str) -> dict:
    reader = csv.DictReader(io.StringIO(csv_text))
    features = []
    for row in reader:
        try:
            lon = float(row.pop("longitude"))
            lat = float(row.pop("latitude"))
        except (KeyError, ValueError):
            continue
        # Coerce numeric-ish fields where present
        for k in ("bright_ti4", "bright_ti5", "frp", "scan", "track", "confidence"):
            if k in row and row[k] not in ("", None):
                try:
                    row[k] = float(row[k])
                except ValueError:
                    pass
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": row,
        })
    return {"type": "FeatureCollection", "features": features}


def run() -> None:
    log.info("fetching FIRMS %s for Canada bbox", SOURCE)
    r = requests.get(_url(), timeout=120)
    r.raise_for_status()
    gj = _csv_to_geojson(r.text)
    write_geojson("firms_canada", gj)
