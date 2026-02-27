const CLOUD_API_BASES = [
  "https://opendata-download-metobs.smhi.se/api/version/latest/",
  "https://opendata-download-metobs.smhi.se/api/version/1.0/"
];
const CLOUD_CENTER = { lon: 14.1618, lat: 57.7826 };
const CLOUD_RADIUS_KM = 30;
const CLOUD_REFRESH_MS = 5 * 60 * 1000;

let cloudState = {
  view: null,
  FeatureLayer: null,
  Graphic: null,
  layer: null,
  enabled: false,
  inFlight: false,
  timer: null,
  parameterId: null,
  parameterUnit: null,
  apiBase: null,
  lastWarn: null
};

function warnOnce(key, err) {
  if (cloudState.lastWarn === key) return;
  cloudState.lastWarn = key;
  console.warn(key, err || "");
}

function setStatus(text, isError = false) {
  const el = document.getElementById("cloudStatus");
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

function findCloudParameter(items) {
  const cloudRegex = /(moln|cloud|cloudiness|cloud\s*cover|molnighet|molnm[aä]ngd|molnt[aä]cke|total\s*cloud)/i;
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
    return cloudRegex.test(blob);
  }) || null;
}

async function fetchParameters(base) {
  const url = `${base}parameter.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Parameters HTTP ${res.status}`);
  const json = await res.json();
  return normalizeArray(json);
}

async function resolveCloudParameter() {
  if (cloudState.parameterId) return cloudState.parameterId;
  for (const base of CLOUD_API_BASES) {
    try {
      const params = await fetchParameters(base);
      const cloud = findCloudParameter(params);
      if (cloud) {
        cloudState.apiBase = base;
        cloudState.parameterId = String(cloud.key ?? cloud.id ?? cloud.parameter).trim();
        cloudState.parameterUnit = String(cloud.unit || "").trim();
        return cloudState.parameterId;
      }
    } catch (err) {
      warnOnce("Cloud: parameters fetch failed", err);
    }
  }
  return null;
}

async function fetchStations(parameterId) {
  const base = cloudState.apiBase || CLOUD_API_BASES[0];
  const url = `${base}parameter/${encodeURIComponent(parameterId)}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stations HTTP ${res.status}`);
  const json = await res.json();
  const stations = normalizeArray(json);
  return stations;
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

async function fetchLatestValue(parameterId, stationId) {
  const base = cloudState.apiBase || CLOUD_API_BASES[0];
  const latestHour = `${base}parameter/${encodeURIComponent(parameterId)}/station/${encodeURIComponent(stationId)}/period/latest-hour/data.json`;
  let res = await fetch(latestHour);
  if (!res.ok) {
    const latestDay = `${base}parameter/${encodeURIComponent(parameterId)}/station/${encodeURIComponent(stationId)}/period/latest-day/data.json`;
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

function toPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const unit = (cloudState.parameterUnit || "").toLowerCase();
  if (unit.includes("okta") || unit.includes("octa") || unit.includes("octas")) {
    return Math.max(0, Math.min(100, (value / 8) * 100));
  }
  if (value <= 1 && unit.includes("%") === false) {
    return Math.max(0, Math.min(100, value * 100));
  }
  return Math.max(0, Math.min(100, value));
}

function ensureLayer() {
  if (cloudState.layer || !cloudState.FeatureLayer || !cloudState.view) return;
  cloudState.layer = new cloudState.FeatureLayer({
    title: "Moln (live)",
    geometryType: "point",
    spatialReference: { wkid: 4326 },
    fields: [
      { name: "ObjectID", type: "oid" },
      { name: "stationName", type: "string" },
      { name: "cloud", type: "double" },
      { name: "cloudPct", type: "double" },
      { name: "timestamp", type: "string" },
      { name: "source", type: "string" }
    ],
    objectIdField: "ObjectID",
    source: [],
    elevationInfo: { mode: "on-the-ground" },
    renderer: {
      type: "heatmap",
      field: "cloudPct",
      blurRadius: 24,
      maxPixelIntensity: 100,
      minPixelIntensity: 0,
      colorStops: [
        { ratio: 0, color: "rgba(148, 163, 184, 0)" },
        { ratio: 0.25, color: "rgba(191, 219, 254, 0.45)" },
        { ratio: 0.5, color: "rgba(96, 165, 250, 0.65)" },
        { ratio: 0.75, color: "rgba(59, 130, 246, 0.8)" },
        { ratio: 1, color: "rgba(37, 99, 235, 0.95)" }
      ]
    },
    popupTemplate: {
      title: "{stationName}",
      content: "Moln: {cloud}{cloudUnit}<br/>Tid: {timestamp}<br/>Källa: {source}"
    }
  });
  cloudState.view.map.add(cloudState.layer);
}

async function refreshClouds() {
  if (!cloudState.enabled || cloudState.inFlight) return;
  cloudState.inFlight = true;
  try {
    const paramId = await resolveCloudParameter();
    if (!paramId) {
      setStatus("Kunde inte hitta moln-parameter i SMHI API", true);
      cloudState.enabled = false;
      const toggle = document.getElementById("cloudToggle");
      if (toggle) toggle.checked = false;
      return;
    }
    ensureLayer();
    if (cloudState.layer?.source) cloudState.layer.source.removeAll();

    const stations = await fetchStations(paramId);
    const nearby = stations.filter((st) => {
      const coords = getStationCoords(st);
      if (!coords) return false;
      return distanceKm(CLOUD_CENTER, { lat: coords.lat, lon: coords.lon }) <= CLOUD_RADIUS_KM;
    });

    if (!nearby.length) {
      setStatus("Inga moln-stationer hittades", true);
      return;
    }

    let oid = 1;
    for (const st of nearby) {
      const stationId = getStationId(st);
      if (!stationId) continue;
      try {
        const latest = await fetchLatestValue(paramId, stationId);
        if (!latest || !Number.isFinite(latest.value)) continue;
        const coords = getStationCoords(st);
        if (!coords) continue;
        const pct = toPercent(latest.value);
        if (pct === null) continue;
        const graphic = new cloudState.Graphic({
          geometry: {
            type: "point",
            longitude: coords.lon,
            latitude: coords.lat
          },
          attributes: {
            ObjectID: oid++,
            stationName: getStationName(st),
            cloud: latest.value,
            cloudPct: pct,
            cloudUnit: cloudState.parameterUnit ? ` ${cloudState.parameterUnit}` : "",
            timestamp: formatTimestamp(latest.timestamp),
            source: "SMHI (MetObs)"
          }
        });
        if (cloudState.layer?.source) cloudState.layer.source.add(graphic);
      } catch (err) {
        warnOnce("Cloud: station fetch failed", err);
      }
    }

    setStatus(`Senast uppdaterad: ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`);
  } catch (err) {
    warnOnce("Cloud: refresh failed", err);
    setStatus("Molndata otillgänglig just nu", true);
  } finally {
    cloudState.inFlight = false;
  }
}

function enableClouds() {
  cloudState.enabled = true;
  setStatus("Laddar moln...");
  refreshClouds();
  if (cloudState.timer) clearInterval(cloudState.timer);
  cloudState.timer = setInterval(refreshClouds, CLOUD_REFRESH_MS);
}

function disableClouds() {
  cloudState.enabled = false;
  if (cloudState.timer) {
    clearInterval(cloudState.timer);
    cloudState.timer = null;
  }
  if (cloudState.layer) {
    if (cloudState.layer.source) cloudState.layer.source.removeAll();
    cloudState.layer.visible = false;
  }
  setStatus("Av");
}

window.initCloudLive = (opts) => {
  cloudState.view = opts?.view || null;
  cloudState.FeatureLayer = opts?.FeatureLayer || null;
  cloudState.Graphic = opts?.Graphic || null;
  const toggle = document.getElementById("cloudToggle");
  if (!toggle) return;

  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      if (cloudState.layer) cloudState.layer.visible = true;
      enableClouds();
    } else {
      disableClouds();
    }
  });
};
