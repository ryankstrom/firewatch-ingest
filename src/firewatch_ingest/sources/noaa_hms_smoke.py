"""NOAA HMS smoke plumes — daily analyst-curated smoke polygons over North America.

Source: https://www.ospo.noaa.gov/Products/land/hms/data/latest_smoke_final.kml

The "final" KML is human-QC'd; if absent, fall back to the preliminary KML.
We convert KML <Placemark><Polygon> entries to GeoJSON Polygon features,
preserving ExtendedData fields (smoke density, start/end times).
"""
from __future__ import annotations

import logging
import re
import requests
import xml.etree.ElementTree as ET

from firewatch_ingest.gcs import write_geojson, write_raw

log = logging.getLogger(__name__)

PRIMARY = "https://www.ospo.noaa.gov/Products/land/hms/data/latest_smoke_final.kml"
FALLBACK = "https://www.ospo.noaa.gov/Products/land/hms/data/latest_smoke.kml"

KML_NS = {"k": "http://www.opengis.net/kml/2.2"}


def _fetch_kml() -> bytes:
    for url in (PRIMARY, FALLBACK):
        r = requests.get(url, timeout=120)
        if r.status_code == 200 and r.content.strip():
            log.info("fetched HMS smoke from %s (%d bytes)", url, len(r.content))
            return r.content
        log.warning("HMS smoke fetch failed at %s: %s", url, r.status_code)
    raise RuntimeError("could not fetch HMS smoke KML from any URL")


def _parse_coords(text: str) -> list[list[float]]:
    """KML coordinates are 'lon,lat[,alt] lon,lat[,alt] ...'"""
    points = []
    for token in re.split(r"\s+", text.strip()):
        if not token:
            continue
        parts = token.split(",")
        if len(parts) < 2:
            continue
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        points.append([lon, lat])
    return points


def _kml_to_geojson(kml_bytes: bytes) -> dict:
    root = ET.fromstring(kml_bytes)
    features = []
    for pm in root.iter("{http://www.opengis.net/kml/2.2}Placemark"):
        props: dict = {}
        name_el = pm.find("k:name", KML_NS)
        if name_el is not None and name_el.text:
            props["name"] = name_el.text.strip()
        for data in pm.iter("{http://www.opengis.net/kml/2.2}Data"):
            key = data.attrib.get("name")
            value_el = data.find("k:value", KML_NS)
            if key and value_el is not None:
                props[key] = (value_el.text or "").strip()

        coords_el = pm.find(".//k:Polygon//k:outerBoundaryIs//k:LinearRing//k:coordinates", KML_NS)
        if coords_el is None or not coords_el.text:
            continue
        ring = _parse_coords(coords_el.text)
        if len(ring) < 4:
            continue
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [ring]},
            "properties": props,
        })
    return {"type": "FeatureCollection", "features": features}


def run() -> None:
    log.info("fetching NOAA HMS smoke KML")
    kml = _fetch_kml()
    write_raw("noaa_hms_smoke", kml, "kml")
    gj = _kml_to_geojson(kml)
    write_geojson("noaa_hms_smoke", gj)
