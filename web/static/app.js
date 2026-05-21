// FireWatch Canada — vanilla JS, MapLibre GL.
// Layers, ranking, hover, refresh-on-demand.

const SOURCES = ["cwfis_hotspots", "cwfis_perimeters", "firms_canada", "noaa_hms_smoke"];

const state = {
  data: { cwfis_hotspots: null, cwfis_perimeters: null, firms_canada: null, noaa_hms_smoke: null, cities: null },
  refreshing: false,
  cooldownUntil: 0,
};

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- data fetch ----------

async function fetchSource(source, { fresh = false } = {}) {
  const url = `/data/${source}.geojson${fresh ? "?fresh=1" : ""}`;
  try {
    const r = await fetch(url, { cache: fresh ? "no-store" : "default" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn(`fetch ${source} failed:`, e);
    return { type: "FeatureCollection", features: [], metadata: {} };
  }
}

async function loadAll({ fresh = false } = {}) {
  const [hotspots, perimeters, firms, smoke, cities] = await Promise.all([
    ...SOURCES.map((s) => fetchSource(s, { fresh })),
    state.data.cities ? Promise.resolve(state.data.cities) : fetch("cities.json").then((r) => r.json()),
  ]);
  state.data.cwfis_hotspots = hotspots;
  state.data.cwfis_perimeters = perimeters;
  state.data.firms_canada = firms;
  state.data.noaa_hms_smoke = smoke;
  state.data.cities = cities;
  return state.data;
}

// ---------- map setup ----------

map.on("load", async () => {
  await loadAll();

  map.addSource("smoke", { type: "geojson", data: state.data.noaa_hms_smoke });
  map.addSource("perimeters", { type: "geojson", data: state.data.cwfis_perimeters });
  map.addSource("hotspots", { type: "geojson", data: state.data.cwfis_hotspots });
  map.addSource("firms", { type: "geojson", data: state.data.firms_canada });
  map.addSource("cities", { type: "geojson", data: state.data.cities });

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
  map.addLayer({ id: "perimeters-fill", type: "fill", source: "perimeters",
    paint: { "fill-color": "#ff6432", "fill-opacity": 0.35 } });
  map.addLayer({ id: "perimeters-line", type: "line", source: "perimeters",
    paint: { "line-color": "#ff6432", "line-width": 1.2, "line-opacity": 0.85 } });
  map.addLayer({ id: "hotspots-circle", type: "circle", source: "hotspots", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.5, 8, 4],
    "circle-color": "#ffb432",
    "circle-opacity": 0.85,
    "circle-stroke-color": "#ff6432",
    "circle-stroke-width": 0.5,
  }});
  map.addLayer({ id: "firms-circle", type: "circle", source: "firms", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 1.2, 8, 3.5],
    "circle-color": "#ffe650",
    "circle-opacity": 0.8,
  }});
  map.addLayer({ id: "cities-circle", type: "circle", source: "cities", paint: {
    "circle-radius": ["interpolate", ["linear"], ["get", "population"], 5, 1.5, 100, 2.5, 3000, 5],
    "circle-color": "#ffffff",
    "circle-opacity": 0.55,
    "circle-stroke-color": "#000",
    "circle-stroke-width": 0.5,
  }});
  map.addLayer({
    id: "cities-label", type: "symbol", source: "cities", minzoom: 3.5,
    layout: {
      "text-field": ["get", "name"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 3.5, 9, 7, 13],
      "text-offset": [0, 0.9],
      "text-anchor": "top",
      "text-font": ["Open Sans Regular"],
    },
    paint: { "text-color": "#dddddd", "text-halo-color": "#000", "text-halo-width": 1.2 },
  });

  setupHover();
  setupLayerToggles();
  setupRefreshButton();
  renderAll();

  // Auto-refresh freshness label every 30s without re-fetching
  setInterval(renderFreshness, 30000);
});

// ---------- update all rendered views from current state.data ----------

function renderAll() {
  // Push current data into map sources (in case it changed)
  if (map.getSource("smoke")) map.getSource("smoke").setData(state.data.noaa_hms_smoke);
  if (map.getSource("perimeters")) map.getSource("perimeters").setData(state.data.cwfis_perimeters);
  if (map.getSource("hotspots")) map.getSource("hotspots").setData(state.data.cwfis_hotspots);
  if (map.getSource("firms")) map.getSource("firms").setData(state.data.firms_canada);

  renderStats();
  renderRanking();
  renderFreshness();
}

function renderStats() {
  document.getElementById("stat-perimeters").textContent =
    state.data.cwfis_perimeters.features.length.toLocaleString();
  document.getElementById("stat-hotspots").textContent = (
    state.data.cwfis_hotspots.features.length + state.data.firms_canada.features.length
  ).toLocaleString();
  document.getElementById("stat-smoke").textContent =
    state.data.noaa_hms_smoke.features.length.toLocaleString();
}

function renderRanking() {
  const items = [];
  for (const f of state.data.cwfis_perimeters.features) {
    const c = centroidOf(f.geometry);
    if (!c) continue;
    const near = nearestCity(c, state.data.cities);
    if (!near) continue;
    items.push({ feature: f, centroid: c, city: near.city, distKm: near.distKm });
  }
  items.sort((a, b) => a.distKm - b.distKm);
  const top = items.slice(0, 10);

  const list = document.getElementById("ranking-list");
  const empty = document.getElementById("ranking-empty");
  list.innerHTML = "";
  if (top.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const it of top) {
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

function renderFreshness() {
  const stamps = SOURCES
    .map((s) => state.data[s]?.metadata?.fetched_at)
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

// ---------- refresh ----------

function setupRefreshButton() {
  document.getElementById("refresh-btn").addEventListener("click", onRefreshClick);
}

async function onRefreshClick() {
  if (state.refreshing) return;
  const btn = document.getElementById("refresh-btn");
  const label = btn.querySelector(".label");
  const freshness = document.getElementById("freshness");
  const now = Date.now();

  if (now < state.cooldownUntil) {
    const wait = Math.ceil((state.cooldownUntil - now) / 1000);
    showCooldown(wait);
    return;
  }

  state.refreshing = true;
  btn.disabled = true;
  btn.classList.add("spinning");
  label.textContent = "Refreshing";
  freshness.textContent = "Pulling fresh data…";

  let resp;
  try {
    resp = await fetch("/refresh", { method: "POST" });
  } catch (e) {
    finishError("Network error");
    return;
  }
  const body = await resp.json().catch(() => ({}));

  if (resp.status === 429) {
    const wait = body.retry_after_seconds || 30;
    state.cooldownUntil = Date.now() + wait * 1000;
    showCooldown(wait);
    return;
  }
  if (!resp.ok || (body.triggered || []).length === 0) {
    finishError("Refresh failed");
    return;
  }

  // Start cooldown so the next click is blocked
  state.cooldownUntil = Date.now() + (body.cooldown_seconds || 30) * 1000;

  // Poll for updated fetched_at on the triggered sources
  const initialStamps = {};
  for (const s of body.triggered) initialStamps[s] = state.data[s]?.metadata?.fetched_at;
  const pollSeconds = body.poll_for_seconds || 30;
  const deadline = Date.now() + pollSeconds * 1000;
  const remaining = new Set(body.triggered);

  while (Date.now() < deadline && remaining.size > 0) {
    await sleep(3000);
    label.textContent = `Refreshing (${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s)`;
    for (const s of [...remaining]) {
      const fresh = await fetchSource(s, { fresh: true });
      const newStamp = fresh?.metadata?.fetched_at;
      if (newStamp && newStamp !== initialStamps[s]) {
        state.data[s] = fresh;
        const sourceId = sourceIdFor(s);
        if (sourceId && map.getSource(sourceId)) {
          map.getSource(sourceId).setData(fresh);
        }
        remaining.delete(s);
      }
    }
    renderStats();
    renderRanking();
    renderFreshness();
  }

  finishOk(body.triggered.length - remaining.size);
}

function sourceIdFor(source) {
  return ({
    cwfis_hotspots: "hotspots",
    cwfis_perimeters: "perimeters",
    firms_canada: "firms",
    noaa_hms_smoke: "smoke",
  })[source];
}

function finishOk(updatedCount) {
  state.refreshing = false;
  const btn = document.getElementById("refresh-btn");
  btn.classList.remove("spinning");
  const label = btn.querySelector(".label");

  if (updatedCount === 0) {
    label.textContent = "No new data";
  } else {
    label.textContent = "Updated";
  }
  setTimeout(() => {
    label.textContent = "Refresh";
    btn.disabled = Date.now() < state.cooldownUntil;
    if (btn.disabled) startCooldownCountdown();
  }, 2500);
}

function finishError(msg) {
  state.refreshing = false;
  const btn = document.getElementById("refresh-btn");
  btn.classList.remove("spinning");
  btn.querySelector(".label").textContent = msg;
  setTimeout(() => {
    btn.querySelector(".label").textContent = "Refresh";
    btn.disabled = false;
  }, 2500);
}

function showCooldown(seconds) {
  state.refreshing = false;
  const btn = document.getElementById("refresh-btn");
  btn.classList.remove("spinning");
  btn.classList.add("cooldown");
  btn.disabled = true;
  startCooldownCountdown();
}

function startCooldownCountdown() {
  const btn = document.getElementById("refresh-btn");
  const label = btn.querySelector(".label");
  btn.classList.add("cooldown");
  const tick = () => {
    const remain = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
    if (remain <= 0) {
      label.textContent = "Refresh";
      btn.disabled = false;
      btn.classList.remove("cooldown");
      return;
    }
    label.textContent = `Wait ${remain}s`;
    setTimeout(tick, 1000);
  };
  tick();
}
