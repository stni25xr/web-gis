const WIND_API_BASES = [
  "https://opendata-download-metobs.smhi.se/api/version/latest/",
  "https://opendata-download-metobs.smhi.se/api/version/1.0/"
];
const WIND_CENTER = { lon: 14.1618, lat: 57.7826 };
const WIND_RADIUS_KM = 30;
const WIND_RADIUS_FALLBACK_KM = 120;
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
  timer: null,
  apiBase: null,
  windSpeedParam: null,
  windDirParam: null,
  lastWarn: null
};

function warnOnce(key, err) {
  if (windState.lastWarn === key) return;
  windState.lastWarn = key;
  console.warn(key, err || "");
}

function setStatus(text, isError = false) {
  const el = document.getElementById("windStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "";
}

function normalizeArray(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.parameter)) return json.parameter;
  if (Array.isArray(json.parameters)) return json.parameters;
  if (Array.isArray(json.station)) return json.station;
  if (Array.isArray(json.stationList)) return json.stationList;
  if (Array.isArray(json.data)) return json.data;
  if (json.data && Array.isArray(json.data.value)) return json.data.value;
  if (Array.isArray(json.value)) return json.value;
  return [];
}

function collectObjects(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectObjects(item, out));
    return;
  }
  if (typeof node === "object") {
    out.push(node);
    Object.values(node).forEach((val) => collectObjects(val, out));
  }
}

function findParam(items, regex) {
  return items.find((item) => {
    const blob = [
      item.name,
      item.summary,
      item.description,
      item.title,
      item.unit,
      item.key,
      item.id
    ].filter(Boolean).join(" ");
    return regex.test(blob.toLowerCase());
  }) || null;
}

function extractParamInfo(json) {
  const objects = [];
  collectObjects(json, objects);
  for (const obj of objects) {
    const key = obj.key ?? obj.id ?? obj.parameter ?? obj.param;
    const name = obj.name ?? obj.title ?? obj.summary ?? obj.description;
    if (key !== undefined && name) {
      return {
        key: String(key).trim(),
        name: String(name),
        unit: obj.unit ? String(obj.unit) : ""
      };
    }
  }
  return null;
}

async function fetchParameters(base) {
  const url = `${base}parameter.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Parameters HTTP ${res.status}`);
  const json = await res.json();
  const items = normalizeArray(json);
  if (items.length) return items;
  const objects = [];
  collectObjects(json, objects);
  return objects;
}

async function fetchParameterMeta(base, id) {
  const url = `${base}parameter/${encodeURIComponent(id)}.json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const info = extractParamInfo(json);
  if (!info) return null;
  return { ...info, id: String(id) };
}

async function probeWindParams(base) {
  const candidates = [4, 8, 9, 10, 11, 13, 14, 15, 21, 22, 24, 25, 26, 27];
  let speed = null;
  let dir = null;
  for (const id of candidates) {
    const info = await fetchParameterMeta(base, id);
    if (!info) continue;
    const blob = `${info.name} ${info.unit}`.toLowerCase();
    if (!speed && /vind|wind/.test(blob) && /(m\/?s|ms|m\/s)/.test(blob)) {
      speed = info;
      continue;
    }
    if (!dir && /vind|wind/.test(blob) && /(grad|degree|deg|°)/.test(blob)) {
      dir = info;
      continue;
    }
    if (!dir && /vindriktning|wind\s*direction/.test(blob)) {
      dir = info;
      continue;
    }
  }
  return { speed, dir };
}

async function resolveWindParams() {
  if (windState.windSpeedParam && windState.windDirParam) return true;
  const speedRegex = /(vindhastighet|vindstyrka|wind\s*speed|windspeed|wind\s*velocity)/i;
  const dirRegex = /(vindriktning|wind\s*direction|winddirection|wind\s*dir)/i;
  for (const base of WIND_API_BASES) {
    try {
      const params = await fetchParameters(base);
      const speed = findParam(params, speedRegex);
      const dir = findParam(params, dirRegex);
      if (speed && dir) {
        windState.apiBase = base;
        windState.windSpeedParam = String(speed.key ?? speed.id ?? speed.parameter).trim();
        windState.windDirParam = String(dir.key ?? dir.id ?? dir.parameter).trim();
        return true;
      }
      const probe = await probeWindParams(base);
      if (probe.speed && probe.dir) {
        windState.apiBase = base;
        windState.windSpeedParam = probe.speed.key || probe.speed.id;
        windState.windDirParam = probe.dir.key || probe.dir.id;
        return true;
      }
    } catch (err) {
      warnOnce("Wind: parameters fetch failed", err);
    }
  }
  return false;
}

async function fetchStations(parameterId) {
  const base = windState.apiBase || WIND_API_BASES[0];
  const url = `${base}parameter/${encodeURIComponent(parameterId)}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stations HTTP ${res.status}`);
  const json = await res.json();
  return normalizeArray(json);
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

function getStationCoords(st) {
  const lat = Number(st.latitude ?? st.lat ?? st.y);
  const lon = Number(st.longitude ?? st.lon ?? st.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function getStationId(st) {
  return st.id ?? st.key ?? st.stationId ?? st.station ?? null;
}

function getStationName(st) {
  return st.name ?? st.title ?? st.station ?? "Station";
}

function formatTimestamp(ts) {
  if (!ts) return "Okänt";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString("sv-SE", { hour12: false });
}

async function fetchLatestValue(paramId, stationId) {
  const base = windState.apiBase || WIND_API_BASES[0];
  const latestHour = `${base}parameter/${encodeURIComponent(paramId)}/station/${encodeURIComponent(stationId)}/period/latest-hour/data.json`;
  let res = await fetch(latestHour);
  if (!res.ok) {
    const latestDay = `${base}parameter/${encodeURIComponent(paramId)}/station/${encodeURIComponent(stationId)}/period/latest-day/data.json`;
    res = await fetch(latestDay);
  }
  if (!res.ok) throw new Error(`Data HTTP ${res.status}`);
  const json = await res.json();
  const values = normalizeArray(json);
  if (!values.length) return null;
  const last = values[values.length - 1];
  return {
    value: Number(last.value ?? last.v ?? last[1]),
    timestamp: last.date ?? last.timestamp ?? last.time ?? last[0]
  };
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

async function refreshWind() {
  if (!windState.enabled || windState.inFlight) return;
  windState.inFlight = true;
  try {
    const ok = await resolveWindParams();
    if (!ok) {
      setStatus("Kunde inte hitta vind‑parametrar i SMHI API", true);
      windState.enabled = false;
      const toggle = document.getElementById("windToggle");
      if (toggle) toggle.checked = false;
      return;
    }
    ensureLayer();
    ensureHeatLayer();
    ensureGlowLayer();
    windState.layer.removeAll();
    if (windState.glowLayer) windState.glowLayer.removeAll();
    if (windState.heatLayer?.source) windState.heatLayer.source.removeAll();

    const stations = await fetchStations(windState.windSpeedParam);
    let nearby = stations.filter((st) => {
      const coords = getStationCoords(st);
      if (!coords) return false;
      return distanceKm(WIND_CENTER, { lat: coords.lat, lon: coords.lon }) <= WIND_RADIUS_KM;
    });

    if (!nearby.length) {
      nearby = stations.filter((st) => {
        const coords = getStationCoords(st);
        if (!coords) return false;
        return distanceKm(WIND_CENTER, { lat: coords.lat, lon: coords.lon }) <= WIND_RADIUS_FALLBACK_KM;
      });
    }

    if (!nearby.length) {
      setStatus("Inga vindstationer hittades", true);
      return;
    }

    const results = await Promise.all(nearby.map(async (st) => {
      const stationId = getStationId(st);
      if (!stationId) return null;
      try {
        const [speed, dir] = await Promise.all([
          fetchLatestValue(windState.windSpeedParam, stationId),
          fetchLatestValue(windState.windDirParam, stationId)
        ]);
        return { station: st, speed, dir };
      } catch (err) {
        warnOnce("Wind: station fetch failed", err);
        return null;
      }
    }));

    let oid = 1;
    results.filter(Boolean).forEach((item) => {
      const coords = getStationCoords(item.station);
      if (!coords) return;
      const speedVal = item.speed?.value;
      const dirVal = item.dir?.value;
      if (!Number.isFinite(speedVal) || !Number.isFinite(dirVal)) return;
      const angle = (dirVal + 180) % 360;
      const graphic = new windState.Graphic({
        geometry: {
          type: "point",
          longitude: coords.lon,
          latitude: coords.lat
        },
        symbol: {
          type: "simple-marker",
          style: "triangle",
          size: 12,
          color: colorForSpeed(speedVal),
          outline: { color: "#0f172a", width: 0.6 },
          angle
        },
        attributes: {
          stationName: getStationName(item.station),
          speed: speedVal.toFixed(1),
          direction: Math.round(dirVal),
          timestamp: formatTimestamp(item.speed?.timestamp || item.dir?.timestamp),
          source: "SMHI (MetObs)"
        },
        popupTemplate: {
          title: "{stationName}",
          content: "Vind: {speed} m/s<br/>Riktning: {direction}°<br/>Tid: {timestamp}<br/>Källa: {source}"
        }
      });
      windState.layer.add(graphic);
      if (windState.glowLayer) {
        const glowSize = Math.max(18, Math.min(60, speedVal * 4));
        windState.glowLayer.add(new windState.Graphic({
          geometry: {
            type: "point",
            longitude: coords.lon,
            latitude: coords.lat
          },
          symbol: {
            type: "simple-marker",
            style: "circle",
            size: glowSize,
            color: colorForSpeed(speedVal) + "33",
            outline: { color: colorForSpeed(speedVal) + "66", width: 0.5 }
          }
        }));
      }
      if (windState.heatLayer?.source) {
        windState.heatLayer.source.add(new windState.Graphic({
          geometry: {
            type: "point",
            longitude: coords.lon,
            latitude: coords.lat
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
    warnOnce("Wind: refresh failed", err);
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
