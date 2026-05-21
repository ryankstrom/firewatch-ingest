"""NOAA HMS smoke plumes — daily analyst-curated smoke polygons over North America.

The "latest_smoke_final.kml" URL is just a NetworkLink wrapper; the real data
is a KMZ at ospo.noaa.gov/data/spl/kmlfiles/fire/smoke.kmz, which contains a
single smoke.kml file with Placemark/Polygon features (when smoke is present).

We convert each smoke Placemark to a GeoJSON Polygon feature, preserving
ExtendedData fields (smoke density, start/end times). On clean-air days the
KML legitimately contains zero Placemarks — that's not an error.
"""
from __future__ import annotations

import io
import logging
import re
import xml.etree.ElementTree as ET
import zipfile

import requests

from firewatch_ingest.gcs import write_geojson, write_raw

log = logging.getLogger(__name__)

KMZ_URL = "https://www.ospo.noaa.gov/data/spl/kmlfiles/fire/smoke.kmz"

KML_NS = {"k": "http://www.opengis.net/kml/2.2"}


def _fetch_kml_from_kmz() -> bytes:
    log.info("fetching HMS smoke KMZ from %s", KMZ_URL)
    r = requests.get(KMZ_URL, timeout=120)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        kml_names = [n for n in zf.namelist() if n.lower().endswith(".kml")]
        if not kml_names:
            raise RuntimeError(f"no .kml file inside KMZ; contents: {zf.namelist()}")
        # Prefer one named smoke.kml at the root; otherwise take the first.
        chosen = next((n for n in kml_names if n.lower() == "smoke.kml"), kml_names[0])
        log.info("extracting %s from KMZ (%d bytes total)", chosen, len(r.content))
        return zf.read(chosen)


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
        # Skip ScreenOverlays and chrome — only keep Placemarks with a Polygon
        coords_el = pm.find(".//k:Polygon//k:outerBoundaryIs//k:LinearRing//k:coordinates", KML_NS)
        if coords_el is None or not coords_el.text:
            continue

        props: dict = {}
        name_el = pm.find("k:name", KML_NS)
        if name_el is not None and name_el.text:
            props["name"] = name_el.text.strip()
        for data in pm.iter("{http://www.opengis.net/kml/2.2}Data"):
            key = data.attrib.get("name")
            value_el = data.find("k:value", KML_NS)
            if key and value_el is not None:
                props[key] = (value_el.text or "").strip()

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
    kml_bytes = _fetch_kml_from_kmz()
    write_raw("noaa_hms_smoke", kml_bytes, "kml")
    gj = _kml_to_geojson(kml_bytes)
    log.info("parsed %d smoke polygons", len(gj["features"]))
    write_geojson("noaa_hms_smoke", gj)
