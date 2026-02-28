const WIND_API_URL = "https://api.open-meteo.com/v1/ecmwf";
const WIND_CENTER = { lon: 14.1618, lat: 57.7826 };
const WIND_RADIUS_KM = 10;
const WIND_STEP_KM = 10;
const WIND_REFRESH_MS = 5 * 60 * 1000;
const WIND_LAYER_ID = "windLiveLayer";
const WIND_PARTICLE_TARGET = 1000;
const WIND_SPEED_FACTOR = 0.48;
const WIND_SPEED_FACTOR_NEAR = 0.6;
const WIND_UPDATE_INTERVAL_MS = 40;
const WIND_STATIONARY_DEBOUNCE_MS = 300;

let windState = {
  view: null,
  enabled: false,
  inFlight: false,
  timer: null,
  particles: [],
  emitters: [],
  field: null,
  fieldTime: null,
  frameId: null,
  layer: null,
  streamGraphic: null,
  streamGraphicFaint: null,
  streamGraphicMid: null,
  GraphicsLayer: null,
  Graphic: null,
  lastEmitterKey: "",
  lastWind: { speed: null, dir: null },
  fallbackVector: { u: 0, v: 0, speed: 0 },
  speedFactor: WIND_SPEED_FACTOR,
  dt: 0.04,
  jitterMeters: 150,
  maxAge: 300,
  trailLength: 24,
  lastUpdate: 0,
  stationaryTimer: null
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

function directionText(deg) {
  const normalized = ((deg % 360) + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) return "norr";
  if (normalized < 67.5) return "nordost";
  if (normalized < 112.5) return "ost";
  if (normalized < 157.5) return "sydost";
  if (normalized < 202.5) return "syd";
  if (normalized < 247.5) return "sydväst";
  if (normalized < 292.5) return "väst";
  return "nordväst";
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

function vectorFromSpeedDir(speed, dirDeg) {
  const angle = toRad((dirDeg + 180) % 360);
  const u = speed * Math.sin(angle);
  const v = speed * Math.cos(angle);
  return { u, v, speed };
}

function buildField(points, responses) {
  const vectors = new Map();
  const nowSec = Math.floor(Date.now() / 1000);
  let totalU = 0;
  let totalV = 0;
  let totalSpeed = 0;
  let count = 0;
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
    const vec = vectorFromSpeedDir(speedVal, dirVal);
    vectors.set(`${lat.toFixed(4)},${lon.toFixed(4)}`, vec);
    totalU += vec.u;
    totalV += vec.v;
    totalSpeed += vec.speed;
    count += 1;
  });

  const stepLat = WIND_STEP_KM / 111;
  const stepLon = WIND_STEP_KM / (111 * Math.cos(toRad(WIND_CENTER.lat)));
  const fallback = count ? { u: totalU / count, v: totalV / count, speed: totalSpeed / count } : null;

  return {
    points,
    stepLat,
    stepLon,
    fallback,
    getVector(lat, lon) {
      const keyLat = Math.round(lat / stepLat) * stepLat;
      const keyLon = Math.round(lon / stepLon) * stepLon;
      const key = `${keyLat.toFixed(4)},${keyLon.toFixed(4)}`;
      return vectors.get(key) || fallback || null;
    }
  };
}

function buildUniformField(speed, dirDeg) {
  const vec = vectorFromSpeedDir(speed, dirDeg);
  return {
    fallback: vec,
    getVector() {
      return vec;
    }
  };
}

function ensureLayer() {
  if (windState.layer || !windState.GraphicsLayer || !windState.view) return;
  windState.layer = new windState.GraphicsLayer({
    id: WIND_LAYER_ID,
    title: "Vind (live)",
    opacity: 0.85,
    visible: true,
    blendMode: "screen",
    elevationInfo: { mode: "relative-to-ground", offset: 6 },
    listMode: "hide"
  });
  windState.view.map.add(windState.layer);
  windState.view.map.reorder(windState.layer, windState.view.map.layers.length - 1);
  windState.streamGraphic = new windState.Graphic({
    geometry: {
      type: "polyline",
      paths: [],
      spatialReference: { wkid: 4326 }
    },
    symbol: {
      type: "simple-line",
      color: [140, 230, 255, 0.9],
      width: 2.4
    }
  });
  windState.streamGraphicFaint = new windState.Graphic({
    geometry: {
      type: "polyline",
      paths: [],
      spatialReference: { wkid: 4326 }
    },
    symbol: {
      type: "simple-line",
      color: [140, 230, 255, 0.25],
      width: 1.8
    }
  });
  windState.streamGraphicMid = new windState.Graphic({
    geometry: {
      type: "polyline",
      paths: [],
      spatialReference: { wkid: 4326 }
    },
    symbol: {
      type: "simple-line",
      color: [140, 230, 255, 0.55],
      width: 2.1
    }
  });
  windState.layer.add(windState.streamGraphic);
  windState.layer.add(windState.streamGraphicMid);
  windState.layer.add(windState.streamGraphicFaint);
}

function windDetailConfig() {
  const view = windState.view;
  const scale = view?.scale || 0;
  const isFar = scale > 40000;
  const isNear = scale > 0 && scale <= 15000;
  return {
    cols: isFar ? 8 : isNear ? 10 : 9,
    rows: isFar ? 7 : isNear ? 9 : 8,
    particles: isFar ? 520 : isNear ? 720 : 640,
    speedFactor: isNear ? WIND_SPEED_FACTOR_NEAR : WIND_SPEED_FACTOR,
    dt: 0.04,
    jitterMeters: 150,
    maxAge: 300,
    trailLength: 24
  };
}

function buildEmitterGrid(config) {
  const view = windState.view;
  if (!view || !view.width || !view.height) return [];
  const cols = config?.cols || 10;
  const rows = config?.rows || 8;
  const emitters = [];
  const xStep = view.width / (cols + 1);
  const yStep = view.height / (rows + 1);
  for (let c = 1; c <= cols; c += 1) {
    for (let r = 1; r <= rows; r += 1) {
      const jitterX = (Math.random() * 0.8 - 0.4) * xStep;
      const jitterY = (Math.random() * 0.8 - 0.4) * yStep;
      const point = view.toMap({ x: c * xStep + jitterX, y: r * yStep + jitterY });
      if (!point) continue;
      const lat = Number(point.latitude);
      const lon = Number(point.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      emitters.push({ lat, lon });
    }
  }
  windState.emitters = emitters;
  windState.lastEmitterKey = `${cols}x${rows}-${view.width}x${view.height}`;
  return emitters;
}

function spawnParticle() {
  const emitters = windState.emitters;
  if (!emitters.length) return { lat: WIND_CENTER.lat, lon: WIND_CENTER.lon, age: Math.random() * 50 };
  const base = emitters[Math.floor(Math.random() * emitters.length)];
  const jitterMeters = windState.jitterMeters || 250;
  const angle = Math.random() * Math.PI * 2;
  const d = Math.random() * jitterMeters;
  const dLat = (Math.cos(angle) * d) / 111000;
  const dLon = (Math.sin(angle) * d) / (111000 * Math.cos(toRad(base.lat)));
  return { lat: base.lat + dLat, lon: base.lon + dLon, age: Math.random() * 80, trail: [] };
}

function initParticles(count) {
  windState.particles = Array.from({ length: count }, () => spawnParticle());
}

function advanceParticles() {
  const view = windState.view;
  const field = windState.field;
  if (!view || !field || !windState.streamGraphic) return;

  const paths = [];
  const faintPaths = [];
  const midPaths = [];
  const dt = Math.min(windState.dt || 0.04, 0.04);
  const speedFactor = windState.speedFactor || WIND_SPEED_FACTOR;
  const maxAge = windState.maxAge || 200;
  const trailLength = windState.trailLength || 14;

  windState.particles.forEach((p) => {
    const vec = field.getVector(p.lat, p.lon) || windState.fallbackVector;
    if (!vec) {
      Object.assign(p, spawnParticle());
      return;
    }
    const dLat = (vec.v * dt * speedFactor) / 111000;
    const dLon = (vec.u * dt * speedFactor) / (111000 * Math.cos(toRad(p.lat)));
    const nextLat = p.lat + dLat;
    const nextLon = p.lon + dLon;
    p.lat = nextLat;
    p.lon = nextLon;
    p.age += 1;
    if (!Array.isArray(p.trail)) p.trail = [];
    p.trail.push([p.lon, p.lat]);
    if (p.trail.length > trailLength) {
      p.trail.splice(0, p.trail.length - trailLength);
    }

    if (p.age > maxAge) {
      Object.assign(p, spawnParticle());
      return;
    }

    if (p.trail.length >= 2) {
      const third = Math.max(1, Math.floor(p.trail.length / 3));
      const faint = p.trail.slice(0, third + 1);
      const mid = p.trail.slice(third, third * 2 + 1);
      const strong = p.trail.slice(third * 2);
      if (faint.length >= 2) faintPaths.push(faint);
      if (mid.length >= 2) midPaths.push(mid);
      if (strong.length >= 2) paths.push(strong);
    }
  });

  windState.streamGraphic.geometry = {
    type: "polyline",
    paths,
    spatialReference: { wkid: 4326 }
  };
  if (windState.streamGraphicMid) {
    windState.streamGraphicMid.geometry = {
      type: "polyline",
      paths: midPaths,
      spatialReference: { wkid: 4326 }
    };
  }
  if (windState.streamGraphicFaint) {
    windState.streamGraphicFaint.geometry = {
      type: "polyline",
      paths: faintPaths,
      spatialReference: { wkid: 4326 }
    };
  }
  if (typeof view.requestRender === "function") view.requestRender();
}

function animate() {
  if (!windState.enabled) return;
  const now = performance.now();
  if (now - windState.lastUpdate >= WIND_UPDATE_INTERVAL_MS) {
    windState.lastUpdate = now;
    advanceParticles();
  }
  windState.frameId = requestAnimationFrame(animate);
}

function updateLiveWind(speedVal, dirVal, source) {
  const now = new Date();
  const updatedAt = now.toISOString();
  window.liveWind = {
    speed_mps: speedVal,
    direction_deg_from: dirVal,
    updatedAt,
    source
  };
  windState.lastWind = { speed: speedVal, dir: dirVal };
  windState.fallbackVector = vectorFromSpeedDir(speedVal, dirVal);

  const dirText = directionText(dirVal);
  const timeText = now.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  setStatus(`Vind: ${speedVal.toFixed(1)} m/s, ${Math.round(dirVal)}° (från ${dirText}) · ${timeText}`);
}

function setWindTintVisible(isVisible) {
  const el = document.getElementById("windBlueTint");
  if (!el) return;
  if (isVisible) {
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function mockWind() {
  const t = Date.now() / 60000;
  const speed = 2.5 + 1.4 * Math.sin(t / 7);
  const dir = (230 + 40 * Math.sin(t / 5)) % 360;
  return { speed, dir };
}

function refreshEmitters() {
  const view = windState.view;
  if (!view || !windState.enabled) return;
  const config = windDetailConfig();
  windState.speedFactor = config.speedFactor;
  windState.dt = config.dt;
  windState.jitterMeters = config.jitterMeters;
  windState.maxAge = config.maxAge;
  windState.trailLength = config.trailLength;
  buildEmitterGrid(config);
  initParticles(config.particles);
}

async function refreshWind() {
  if (!windState.enabled || windState.inFlight) return;
  windState.inFlight = true;
  try {
    ensureLayer();
    const points = buildGridPoints();
    const url = buildUrl(points);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wind HTTP ${res.status}`);
    const json = await res.json();
    const responses = Array.isArray(json) ? json : [json];
    windState.field = buildField(points, responses);
    windState.fieldTime = Date.now();

    let sampleSpeed = null;
    let sampleDir = null;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const loc of responses) {
      const times = loc.hourly?.time || [];
      const speeds = loc.hourly?.wind_speed_10m || [];
      const dirs = loc.hourly?.wind_direction_10m || [];
      if (!times.length || !speeds.length || !dirs.length) continue;
      const idx = pickNearestIndex(times, nowSec);
      const speedVal = Number(speeds[idx]);
      const dirVal = Number(dirs[idx]);
      if (!Number.isFinite(speedVal) || !Number.isFinite(dirVal)) continue;
      sampleSpeed = speedVal;
      sampleDir = dirVal;
      break;
    }

    if (Number.isFinite(sampleSpeed) && Number.isFinite(sampleDir)) {
      updateLiveWind(sampleSpeed, sampleDir, "live");
    } else {
      const mock = mockWind();
      windState.field = buildUniformField(mock.speed, mock.dir);
      updateLiveWind(mock.speed, mock.dir, "mock");
    }

    refreshEmitters();
  } catch (err) {
    console.warn("Wind refresh failed", err);
    const mock = mockWind();
    windState.field = buildUniformField(mock.speed, mock.dir);
    updateLiveWind(mock.speed, mock.dir, "mock");
  } finally {
    windState.inFlight = false;
  }
}

function enableWind() {
  windState.enabled = true;
  ensureLayer();
  if (windState.layer) {
    windState.layer.visible = true;
    windState.layer.opacity = 0.85;
  }
  setWindTintVisible(true);
  refreshEmitters();
  updateLiveWind(windState.lastWind.speed || 0, windState.lastWind.dir || 0, "mock");
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
  if (windState.layer) windState.layer.visible = false;
  setWindTintVisible(false);
  setStatus("Av");
}

function attachViewWatchers() {
  const view = windState.view;
  if (!view) return;
  if (typeof view.watch === "function") {
    view.watch("stationary", (stationary) => {
      if (!stationary) return;
      if (windState.stationaryTimer) clearTimeout(windState.stationaryTimer);
      windState.stationaryTimer = setTimeout(() => refreshEmitters(), WIND_STATIONARY_DEBOUNCE_MS);
    });
  }
  if (typeof view.on === "function") {
    view.on("resize", () => refreshEmitters());
  }
}

window.initWindLive = (opts) => {
  windState.view = opts?.view || null;
  windState.GraphicsLayer = opts?.GraphicsLayer || null;
  windState.Graphic = opts?.Graphic || null;
  if (!window.liveWind) {
    window.liveWind = {
      speed_mps: 0,
      direction_deg_from: 0,
      updatedAt: new Date().toISOString(),
      source: "mock"
    };
  }

  const toggle = document.getElementById("windToggle");
  if (!toggle || !windState.view) return;

  attachViewWatchers();

  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      enableWind();
    } else {
      disableWind();
    }
  });
};
