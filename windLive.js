const WIND_API_URL = "https://api.open-meteo.com/v1/ecmwf";
const WIND_CENTER = { lon: 14.1618, lat: 57.7826 };
const WIND_RADIUS_KM = 30;
const WIND_STEP_KM = 10;
const WIND_REFRESH_MS = 5 * 60 * 1000;

let windState = {
  view: null,
  enabled: false,
  inFlight: false,
  timer: null,
  particles: [],
  field: null,
  fieldTime: null,
  frameId: null,
  canvas: null,
  ctx: null,
  lastSize: { w: 0, h: 0 },
  arrows: null,
  GraphicsLayer: null,
  Graphic: null
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

function buildUrl(points) {
  const lats = points.map((p) => p.lat.toFixed(4)).join(",");
  const lons = points.map((p) => p.lon.toFixed(4)).join(",");
  return `${WIND_API_URL}?latitude=${encodeURIComponent(lats)}&longitude=${encodeURIComponent(lons)}&hourly=wind_speed_10m,wind_direction_10m&timeformat=unixtime&timezone=UTC&forecast_days=1`;
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

function buildField(points, responses) {
  const vectors = new Map();
  const nowSec = Math.floor(Date.now() / 1000);
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
    const angle = toRad((dirVal + 180) % 360);
    const u = speedVal * Math.sin(angle);
    const v = speedVal * Math.cos(angle);
    vectors.set(`${lat.toFixed(4)},${lon.toFixed(4)}`, { u, v, speed: speedVal });
  });

  const stepLat = WIND_STEP_KM / 111;
  const stepLon = WIND_STEP_KM / (111 * Math.cos(toRad(WIND_CENTER.lat)));

  return {
    points,
    stepLat,
    stepLon,
    vectors,
    getVector(lat, lon) {
      const keyLat = Math.round(lat / stepLat) * stepLat;
      const keyLon = Math.round(lon / stepLon) * stepLon;
      const key = `${keyLat.toFixed(4)},${keyLon.toFixed(4)}`;
      return vectors.get(key) || null;
    }
  };
}

function ensureCanvas() {
  if (windState.canvas) return;
  const host = document.getElementById("sceneView");
  if (!host) return;
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "850";
  host.appendChild(canvas);
  windState.canvas = canvas;
  windState.ctx = canvas.getContext("2d");
}

function ensureArrowLayer() {
  if (windState.arrows || !windState.GraphicsLayer || !windState.view) return;
  windState.arrows = new windState.GraphicsLayer({
    title: "Vind (pilar)",
    elevationInfo: { mode: "relative-to-ground", offset: 9 }
  });
  windState.view.map.add(windState.arrows);
}

function resizeCanvas() {
  if (!windState.canvas) return;
  const host = document.getElementById("sceneView");
  if (!host) return;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (w !== windState.lastSize.w || h !== windState.lastSize.h) {
    windState.canvas.width = w;
    windState.canvas.height = h;
    windState.lastSize = { w, h };
  }
}

function spawnParticle() {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * WIND_RADIUS_KM;
  const lat = WIND_CENTER.lat + (r * Math.cos(angle)) / 111;
  const lon = WIND_CENTER.lon + (r * Math.sin(angle)) / (111 * Math.cos(toRad(WIND_CENTER.lat)));
  return { lat, lon, age: Math.random() * 100 };
}

function initParticles(count) {
  windState.particles = Array.from({ length: count }, () => spawnParticle());
}

function advanceParticles() {
  const ctx = windState.ctx;
  const view = windState.view;
  const field = windState.field;
  if (!ctx || !view || !field) return;

  resizeCanvas();
  ctx.clearRect(0, 0, windState.canvas.width, windState.canvas.height);
  ctx.lineWidth = 1.3;

  const dt = 600; // seconds per frame

  windState.particles.forEach((p) => {
    const vec = field.getVector(p.lat, p.lon);
    if (!vec) {
      Object.assign(p, spawnParticle());
      return;
    }
    const prev = view.toScreen({ latitude: p.lat, longitude: p.lon });
    const dLat = (vec.v * dt) / 111000;
    const dLon = (vec.u * dt) / (111000 * Math.cos(toRad(p.lat)));
    p.lat += dLat;
    p.lon += dLon;
    p.age += 1;
    if (p.age > 120 || distanceKm(WIND_CENTER, p) > WIND_RADIUS_KM * 1.1) {
      Object.assign(p, spawnParticle());
      return;
    }
    const next = view.toScreen({ latitude: p.lat, longitude: p.lon });
    if (!prev || !next) return;
    ctx.strokeStyle = "rgba(200, 240, 255, 0.9)";
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
  });
}

function animate() {
  if (!windState.enabled) return;
  advanceParticles();
  windState.frameId = requestAnimationFrame(animate);
}

async function refreshWind() {
  if (!windState.enabled || windState.inFlight) return;
  windState.inFlight = true;
  try {
    ensureCanvas();
    const points = buildGridPoints();
    const url = buildUrl(points);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wind HTTP ${res.status}`);
    const json = await res.json();
    const responses = Array.isArray(json) ? json : [json];
    windState.field = buildField(points, responses);
    windState.fieldTime = Date.now();
    initParticles(900);
    ensureArrowLayer();
    if (windState.arrows) windState.arrows.removeAll();
    setStatus(`Senast uppdaterad: ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`);

    const nowSec = Math.floor(Date.now() / 1000);
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
      windState.arrows?.add(new windState.Graphic({
        geometry: {
          type: "point",
          longitude: lon,
          latitude: lat
        },
        symbol: {
          type: "simple-marker",
          style: "triangle",
          size: 9,
          color: "rgba(255,255,255,0.9)",
          outline: { color: "rgba(0,0,0,0.6)", width: 0.6 },
          angle
        }
      }));
    });
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
  if (!windState.frameId) animate();
}

function disableWind() {
  windState.enabled = false;
  if (windState.timer) {
    clearInterval(windState.timer);
    windState.timer = null;
  }
  if (windState.frameId) {
    cancelAnimationFrame(windState.frameId);
    windState.frameId = null;
  }
  if (windState.ctx && windState.canvas) {
    windState.ctx.clearRect(0, 0, windState.canvas.width, windState.canvas.height);
  }
  if (windState.arrows) windState.arrows.removeAll();
  setStatus("Av");
}

window.initWindLive = (opts) => {
  windState.view = opts?.view || null;
  windState.GraphicsLayer = opts?.GraphicsLayer || null;
  windState.Graphic = opts?.Graphic || null;
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
