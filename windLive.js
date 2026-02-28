const WIND_API_URL = "https://api.open-meteo.com/v1/ecmwf";
const WIND_CENTER = { lon: 14.1618, lat: 57.7826 };
const WIND_RADIUS_KM = 30;
const WIND_STEP_KM = 12;
const WIND_REFRESH_MS = 5 * 60 * 1000;

let windState = {
  view: null,
  GraphicsLayer: null,
  Graphic: null,
  FeatureLayer: null,
  layer: null,
  heatLayer: null,
  glowLayer: null,
  enabled: false,
  inFlight: false,
  timer: null
};

function setStatus(text, isError = false) {
  const el = document.getElementById("windStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "";
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildGridPoints() {
  const points = [];
  const stepLat = WIND_STEP_KM / 111;
  const stepLon = WIND_STEP_KM / (111 * Math.cos(toRad(WIND_CENTER.lat)));
  const steps = Math.ceil(WIND_RADIUS_KM / WIND_STEP_KM);
  for (let i = -steps; i <= steps; i += 1) {
    for (let j = -steps; j <= steps; j += 1) {
      const lat = WIND_CENTER.lat + i * stepLat;
      const lon = WIND_CENTER.lon + j * stepLon;
      const dist = distanceKm(WIND_CENTER, { lat, lon });
      if (dist <= WIND_RADIUS_KM + 0.1) points.push({ lat, lon });
    }
  }
  return points;
}

function colorForSpeed(speed) {
  if (!Number.isFinite(speed)) return "#94a3b8";
  if (speed < 2) return "#22c55e";
  if (speed < 5) return "#84cc16";
  if (speed < 8) return "#facc15";
  if (speed < 12) return "#f97316";
  return "#ef4444";
}

function ensureLayer() {
  if (windState.layer || !windState.GraphicsLayer || !windState.view) return;
  windState.layer = new windState.GraphicsLayer({
    title: "Vind (live)",
    elevationInfo: { mode: "relative-to-ground", offset: 8 }
  });
  windState.view.map.add(windState.layer);
}

function ensureGlowLayer() {
  if (windState.glowLayer || !windState.GraphicsLayer || !windState.view) return;
  windState.glowLayer = new windState.GraphicsLayer({
    title: "Vind (glow)",
    elevationInfo: { mode: "relative-to-ground", offset: 7 }
  });
  windState.view.map.add(windState.glowLayer);
  if (windState.layer) {
    const idx = windState.view.map.layers.indexOf(windState.layer);
    if (idx > -1) windState.view.map.reorder(windState.glowLayer, idx);
  }
}

function ensureHeatLayer() {
  if (windState.heatLayer || !windState.FeatureLayer || !windState.view) return;
  windState.heatLayer = new windState.FeatureLayer({
    title: "Vind (heatmap)",
    geometryType: "point",
    spatialReference: { wkid: 4326 },
    fields: [
      { name: "ObjectID", type: "oid" },
      { name: "speed", type: "double" }
    ],
    objectIdField: "ObjectID",
    source: [],
    elevationInfo: { mode: "on-the-ground" },
    opacity: 0.9,
    blendMode: "screen",
    renderer: {
      type: "heatmap",
      field: "speed",
      blurRadius: 55,
      maxPixelIntensity: 4,
      minPixelIntensity: 0,
      colorStops: [
        { ratio: 0, color: "rgba(56, 189, 248, 0)" },
        { ratio: 0.25, color: "rgba(34, 197, 94, 0.6)" },
        { ratio: 0.5, color: "rgba(250, 204, 21, 0.75)" },
        { ratio: 0.75, color: "rgba(249, 115, 22, 0.85)" },
        { ratio: 1, color: "rgba(239, 68, 68, 0.95)" }
      ]
    }
  });
  windState.view.map.add(windState.heatLayer);
  if (windState.layer) {
    const idx = windState.view.map.layers.indexOf(windState.layer);
    if (idx > -1) windState.view.map.reorder(windState.heatLayer, idx);
  }
}

function pickNearestIndex(times, nowSec) {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i += 1) {
    const diff = Math.abs(times[i] - nowSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

async function fetchWindGrid(points) {
  const lats = points.map((p) => p.lat.toFixed(4)).join(",");
  const lons = points.map((p) => p.lon.toFixed(4)).join(",");
  const url = `${WIND_API_URL}?latitude=${encodeURIComponent(lats)}&longitude=${encodeURIComponent(lons)}&hourly=wind_speed_10m,wind_direction_10m&timeformat=unixtime&timezone=UTC&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wind HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [json];
}

async function refreshWind() {
  if (!windState.enabled || windState.inFlight) return;
  windState.inFlight = true;
  try {
    ensureLayer();
    ensureGlowLayer();
    ensureHeatLayer();
    windState.layer.removeAll();
    if (windState.glowLayer) windState.glowLayer.removeAll();
    if (windState.heatLayer?.source) windState.heatLayer.source.removeAll();

    const points = buildGridPoints();
    const responses = await fetchWindGrid(points);
    if (!responses.length) {
      setStatus("Inga vinddata hittades", true);
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let oid = 1;

    responses.forEach((loc) => {
      const lat = Number(loc.latitude);
      const lon = Number(loc.longitude);
      const times = loc.hourly?.time || [];
      const speeds = loc.hourly?.wind_speed_10m || [];
      const dirs = loc.hourly?.wind_direction_10m || [];
      if (!times.length || !speeds.length || !dirs.length) return;
      const idx = pickNearestIndex(times, nowSec);
      const speedVal = Number(speeds[idx]);
      const dirVal = Number(dirs[idx]);
      if (!Number.isFinite(speedVal) || !Number.isFinite(dirVal)) return;
      const angle = (dirVal + 180) % 360;

      const arrow = new windState.Graphic({
        geometry: {
          type: "point",
          longitude: lon,
          latitude: lat
        },
        symbol: {
          type: "simple-marker",
          style: "triangle",
          size: 10,
          color: colorForSpeed(speedVal),
          outline: { color: "#0f172a", width: 0.6 },
          angle
        },
        attributes: {
          stationName: "Vindpunkt",
          speed: speedVal.toFixed(1),
          direction: Math.round(dirVal),
          timestamp: new Date(times[idx] * 1000).toLocaleString("sv-SE", { hour12: false }),
          source: "Open-Meteo (ECMWF)"
        },
        popupTemplate: {
          title: "Vindpunkt",
          content: "Vind: {speed} m/s<br/>Riktning: {direction}°<br/>Tid: {timestamp}<br/>Källa: {source}"
        }
      });
      windState.layer.add(arrow);

      if (windState.glowLayer) {
        const glowSize = Math.max(16, Math.min(50, speedVal * 4));
        windState.glowLayer.add(new windState.Graphic({
          geometry: {
            type: "point",
            longitude: lon,
            latitude: lat
          },
          symbol: {
            type: "simple-marker",
            style: "circle",
            size: glowSize,
            color: colorForSpeed(speedVal) + "33",
            outline: { color: colorForSpeed(speedVal) + "66", width: 0.4 }
          }
        }));
      }

      if (windState.heatLayer?.source) {
        windState.heatLayer.source.add(new windState.Graphic({
          geometry: {
            type: "point",
            longitude: lon,
            latitude: lat
          },
          attributes: {
            ObjectID: oid++,
            speed: speedVal
          }
        }));
      }
    });

    setStatus(`Senast uppdaterad: ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`);
  } catch (err) {
    console.warn("Wind refresh failed", err);
    setStatus("Vinddata otillgänglig just nu", true);
  } finally {
    windState.inFlight = false;
  }
}

function enableWind() {
  windState.enabled = true;
  setStatus("Laddar vind...");
  refreshWind();
  if (windState.timer) clearInterval(windState.timer);
  windState.timer = setInterval(refreshWind, WIND_REFRESH_MS);
}

function disableWind() {
  windState.enabled = false;
  if (windState.timer) {
    clearInterval(windState.timer);
    windState.timer = null;
  }
  if (windState.layer) windState.layer.removeAll();
  if (windState.glowLayer) windState.glowLayer.removeAll();
  if (windState.heatLayer?.source) windState.heatLayer.source.removeAll();
  setStatus("Av");
}

window.initWindLive = (opts) => {
  windState.view = opts?.view || null;
  windState.GraphicsLayer = opts?.GraphicsLayer || null;
  windState.Graphic = opts?.Graphic || null;
  windState.FeatureLayer = opts?.FeatureLayer || null;
  const toggle = document.getElementById("windToggle");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      enableWind();
    } else {
      disableWind();
    }
  });
};
