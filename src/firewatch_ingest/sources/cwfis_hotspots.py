"""CWFIS active hotspots — last 24 hours of satellite-detected fire pixels.

WFS layer: public:hotspots_last24hrs
Updated frequently throughout the day as new satellite passes are processed.
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
    "typeName": "public:hotspots_last24hrs",
    "outputFormat": "application/json",
    "srsName": "EPSG:4326",
}


def run() -> None:
    log.info("fetching CWFIS hotspots_last24hrs")
    r = requests.get(WFS_URL, params=PARAMS, timeout=120)
    r.raise_for_status()
    gj = r.json()
    write_geojson("cwfis_hotspots", gj)
