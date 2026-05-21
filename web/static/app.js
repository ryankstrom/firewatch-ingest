// FireWatch Canada — vanilla JS, MapLibre GL.
// Layers, ranking, hover, and a sidebar. No build step.

const SOURCES = ["cwfis_hotspots", "cwfis_perimeters", "firms_canada", "noaa_hms_smoke"];

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [-96, 60],
  zoom: 2.8,
  attributionControl: false,
});

map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: "FireWatch · © OSM · © CARTO",
}));
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

// ---------- helpers ----------

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function centroidOf(geom) {
  if (!geom) return null;
  let sx = 0, sy = 0, n = 0;
  const visitRing = (ring) => {
    for (const [x, y] of ring) { sx += x; sy += y; n++; }
  };
  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates) visitRing(ring);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) for (const ring of poly) visitRing(ring);
  } else if (geom.type === "Point") {
    return geom.coordinates;
  } else {
    return null;
  }
  return n === 0 ? null : [sx / n, sy / n];
}

function nearestCity(point, cities) {
  let best = null;
  for (const f of cities.features) {
    const d = haversineKm(point, f.geometry.coordinates);
    if (!best || d < best.distKm) {
      best = { city: f.properties, distKm: d };
    }
  }
  return best;
}

function fmtTimeAgo(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

// ---------- data load ----------

async function loadAll() {
  const fetches = SOURCES.map((s) =>
    fetch(`/data/${s}.geojson`).then((r) => r.json()).catch(() => emptyFC())
  );
  fetches.push(fetch("cities.json").then((r) => r.json()));
  const [hotspots, perimeters, firms, smoke, cities] = await Promise.all(fetches);
  return { hotspots, perimeters, firms, smoke, cities };
}

function emptyFC() {
  return { type: "FeatureCollection", features: [], metadata: {} };
}

// ---------- map setup ----------

map.on("load", async () => {
  const data = await loadAll();

  map.addSource("smoke", { type: "geojson", data: data.smoke });
  map.addSource("perimeters", { type: "geojson", data: data.perimeters });
  map.addSource("hotspots", { type: "geojson", data: data.hotspots });
  map.addSource("firms", { type: "geojson", data: data.firms });
  map.addSource("cities", { type: "geojson", data: data.cities });

  // smoke
  map.addLayer({
    id: "smoke-fill",
    type: "fill",
    source: "smoke",
    paint: {
      "fill-color": [
        "match",
        ["downcase", ["coalesce", ["get", "Density"], ["get", "density"], ""]],
        "heavy", "#aaaaaa",
        "medium", "#bbbbbb",
        "light", "#cccccc",
        /* default */ "#bbbbbb",
      ],
      "fill-opacity": 0.18,
    },
  });

  // perimeters
  map.addLayer({
    id: "perimeters-fill",
    type: "fill",
    source: "perimeters",
    paint: { "fill-color": "#ff6432", "fill-opacity": 0.35 },
  });
  map.addLayer({
    id: "perimeters-line",
    type: "line",
    source: "perimeters",
    paint: { "line-color": "#ff6432", "line-width": 1.2, "line-opacity": 0.85 },
  });

  // hotspots (CWFIS)
  map.addLayer({
    id: "hotspots-circle",
    type: "circle",
    source: "hotspots",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 8, 4],
      "circle-color": "#ffb432",
      "circle-opacity": 0.85,
      "circle-stroke-color": "#ff6432",
      "circle-stroke-width": 0.5,
    },
  });

  // FIRMS (NASA)
  map.addLayer({
    id: "firms-circle",
    type: "circle",
    source: "firms",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.2, 8, 3.5],
      "circle-color": "#ffe650",
      "circle-opacity": 0.8,
    },
  });

  // cities
  map.addLayer({
    id: "cities-circle",
    type: "circle",
    source: "cities",
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["get", "population"],
        5, 1.5,
        100, 2.5,
        3000, 5,
      ],
      "circle-color": "#ffffff",
      "circle-opacity": 0.55,
      "circle-stroke-color": "#000",
      "circle-stroke-width": 0.5,
    },
  });
  map.addLayer({
    id: "cities-label",
    type: "symbol",
    source: "cities",
    minzoom: 3.5,
    layout: {
      "text-field": ["get", "name"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 3.5, 9, 7, 13],
      "text-offset": [0, 0.9],
      "text-anchor": "top",
      "text-font": ["Open Sans Regular"],
    },
    paint: {
      "text-color": "#dddddd",
      "text-halo-color": "#000",
      "text-halo-width": 1.2,
    },
  });

  // hover interactions
  setupHover();

  // layer toggles
  setupLayerToggles();

  // sidebar
  renderStats(data);
  const ranking = rankPerimeters(data.perimeters, data.cities);
  renderRanking(ranking);
  renderFreshness(data);
});

// ---------- ranking ----------

function rankPerimeters(perimeters, cities) {
  const items = [];
  for (const f of perimeters.features) {
    const c = centroidOf(f.geometry);
    if (!c) continue;
    const near = nearestCity(c, cities);
    if (!near) continue;
    items.push({
      feature: f,
      centroid: c,
      city: near.city,
      distKm: near.distKm,
    });
  }
  items.sort((a, b) => a.distKm - b.distKm);
  return items.slice(0, 10);
}

function renderRanking(items) {
  const list = document.getElementById("ranking-list");
  const empty = document.getElementById("ranking-empty");
  list.innerHTML = "";
  if (items.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const it of items) {
    const li = document.createElement("li");
    const props = it.feature.properties || {};
    const fireName =
      props.firename || props.fire_name || props.NAME || props.name ||
      props.agency || `Fire ${(props.AREA || "").toString().slice(0, 6)}`;
    li.innerHTML = `
      <span class="where">
        <strong>${escapeHtml(it.city.name)}</strong>, ${escapeHtml(it.city.province)}
        <small>${escapeHtml(String(fireName).trim() || "active perimeter")}</small>
      </span>
      <span class="dist">${it.distKm < 10 ? it.distKm.toFixed(1) : Math.round(it.distKm)} km</span>
    `;
    li.addEventListener("click", () => {
      map.flyTo({ center: it.centroid, zoom: 7.5, speed: 1.2 });
    });
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- stats / freshness ----------

function renderStats(data) {
  document.getElementById("stat-perimeters").textContent = data.perimeters.features.length.toLocaleString();
  document.getElementById("stat-hotspots").textContent = (
    data.hotspots.features.length + data.firms.features.length
  ).toLocaleString();
  document.getElementById("stat-smoke").textContent = data.smoke.features.length.toLocaleString();
}

function renderFreshness(data) {
  const stamps = [data.hotspots, data.perimeters, data.firms, data.smoke]
    .map((d) => d?.metadata?.fetched_at)
    .filter(Boolean);
  if (stamps.length === 0) {
    document.getElementById("freshness").textContent = "Data freshness unknown";
    return;
  }
  const newest = stamps.sort().slice(-1)[0];
  document.getElementById("freshness").textContent = `Last ingest: ${fmtTimeAgo(newest)}`;
}

// ---------- hover popups ----------

function setupHover() {
  const card = document.getElementById("hover-card");
  const showAt = (e, html) => {
    card.innerHTML = html;
    card.hidden = false;
    const pad = 14;
    card.style.left = `${e.originalEvent.clientX + pad}px`;
    card.style.top = `${e.originalEvent.clientY + pad}px`;
  };
  const hide = () => { card.hidden = true; };

  map.on("mousemove", "perimeters-fill", (e) => {
    const f = e.features[0];
    if (!f) return;
    const p = f.properties || {};
    const fireName = p.firename || p.fire_name || p.NAME || p.name || "Active perimeter";
    const area = p.area || p.AREA || p.HECTARES;
    showAt(e, `
      <div class="pop-title">${escapeHtml(String(fireName))}</div>
      ${area ? `<div class="pop-row"><span>Area</span><span>${escapeHtml(String(area))} ha</span></div>` : ""}
      <div class="pop-row"><span>Source</span><span>CWFIS M3</span></div>
    `);
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "perimeters-fill", () => { hide(); map.getCanvas().style.cursor = ""; });

  for (const layerId of ["hotspots-circle", "firms-circle"]) {
    map.on("mousemove", layerId, (e) => {
      const f = e.features[0];
      if (!f) return;
      const p = f.properties || {};
      const bright = p.bright_ti4 || p.bright_ti5 || p.bright || p.temp;
      const sat = p.satellite || p.sensor || p.instrument || "—";
      const t = p.acq_date ? `${p.acq_date} ${p.acq_time || ""}` : "";
      showAt(e, `
        <div class="pop-title">${layerId.startsWith("hot") ? "CWFIS hotspot" : "NASA FIRMS"}</div>
        ${bright ? `<div class="pop-row"><span>Brightness</span><span>${escapeHtml(String(bright))} K</span></div>` : ""}
        ${sat !== "—" ? `<div class="pop-row"><span>Satellite</span><span>${escapeHtml(String(sat))}</span></div>` : ""}
        ${t ? `<div class="pop-row"><span>Detected</span><span>${escapeHtml(t)}</span></div>` : ""}
      `);
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => { hide(); map.getCanvas().style.cursor = ""; });
  }

  map.on("mousemove", "cities-circle", (e) => {
    const f = e.features[0];
    if (!f) return;
    const p = f.properties || {};
    showAt(e, `
      <div class="pop-title">${escapeHtml(p.name)}, ${escapeHtml(p.province)}</div>
      <div class="pop-row"><span>Population</span><span>${(p.population * 1000).toLocaleString()}</span></div>
    `);
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "cities-circle", () => { hide(); map.getCanvas().style.cursor = ""; });
}

// ---------- layer toggles ----------

const LAYER_GROUPS = {
  perimeters: ["perimeters-fill", "perimeters-line"],
  hotspots: ["hotspots-circle"],
  firms: ["firms-circle"],
  smoke: ["smoke-fill"],
  cities: ["cities-circle", "cities-label"],
};

function setupLayerToggles() {
  for (const cb of document.querySelectorAll('#layers input[type="checkbox"]')) {
    cb.addEventListener("change", () => {
      const layers = LAYER_GROUPS[cb.dataset.layer] || [];
      for (const id of layers) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, "visibility", cb.checked ? "visible" : "none");
        }
      }
    });
  }
}
