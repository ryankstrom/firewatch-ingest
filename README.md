# firewatch-ingest

Pulls live Canadian wildfire data from four sources and writes timestamped GeoJSON snapshots to Cloud Storage.

| Source | Module | Cadence | Endpoint |
|---|---|---|---|
| CWFIS hotspots (last 24h) | `cwfis_hotspots` | hourly | `cwfis.cfs.nrcan.gc.ca/geoserver/wfs` |
| CWFIS fire perimeters (M3) | `cwfis_perimeters` | every 3h | `cwfis.cfs.nrcan.gc.ca/geoserver/wfs` |
| NASA FIRMS (VIIRS, Canada bbox) | `firms_canada` | every 3h | `firms.modaps.eosdis.nasa.gov/api/area` |
| NOAA HMS smoke | `noaa_hms_smoke` | daily | `ospo.noaa.gov/Products/land/hms/data` |

## GCS layout

```
gs://sandbox-day3-firewatch-raw/
├── cwfis_hotspots/
│   ├── 2026-05-21/
│   │   └── 143000.geojson
│   └── latest.geojson
├── cwfis_perimeters/...
├── firms_canada/...
└── noaa_hms_smoke/...
```

`latest.geojson` is overwritten each run for easy serving. Timestamped files are kept as immutable history (later loaded into BigQuery).

## Local run

```
cd firewatch-ingest
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export GCP_PROJECT=sandbox-day3
export GCS_BUCKET=sandbox-day3-firewatch-raw
export FIRMS_MAP_KEY=...  # only needed for firms_canada

python -m firewatch_ingest cwfis_hotspots
python -m firewatch_ingest cwfis_perimeters
python -m firewatch_ingest firms_canada
python -m firewatch_ingest noaa_hms_smoke
```

## Deploy to GCP

See `infra/deploy.sh` — builds one container, deploys four Cloud Run Jobs, attaches a Cloud Scheduler trigger to each with its native cadence.
