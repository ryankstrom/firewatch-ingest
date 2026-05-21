"""CWFIS M3 fire perimeter estimates — polygons derived from clustered hotspots.

WFS layer: public:m3_polygons_current
"""
from __future__ import annotations

import logging
import requests

from firewatch_ingest.gcs import write_geojson

log = logging.getLogger(__name__)

WFS_URL = "https://cwfis.cfs.nrcan.gc.ca/geoserver/wfs"
PARAMS = {
    "service": "WFS",
    "version": "2.0.0",
    "request": "GetFeature",
    "typeName": "public:m3_polygons_current",
    "outputFormat": "application/json",
    "srsName": "EPSG:4326",
}


def run() -> None:
    log.info("fetching CWFIS m3_polygons_current")
    r = requests.get(WFS_URL, params=PARAMS, timeout=180)
    r.raise_for_status()
    gj = r.json()
    write_geojson("cwfis_perimeters", gj)
