"""Entry point: `python -m firewatch_ingest <source>`

Each source module exposes a `run()` function that fetches its data,
normalizes to GeoJSON, and writes to Cloud Storage.
"""
from __future__ import annotations

import argparse
import logging
import sys

from firewatch_ingest.sources import (
    cwfis_hotspots,
    cwfis_perimeters,
    firms_canada,
    noaa_hms_smoke,
)

SOURCES = {
    "cwfis_hotspots": cwfis_hotspots.run,
    "cwfis_perimeters": cwfis_perimeters.run,
    "firms_canada": firms_canada.run,
    "noaa_hms_smoke": noaa_hms_smoke.run,
}


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(prog="firewatch_ingest")
    parser.add_argument("source", choices=sorted(SOURCES.keys()))
    args = parser.parse_args()
    SOURCES[args.source]()
    return 0


if __name__ == "__main__":
    sys.exit(main())
