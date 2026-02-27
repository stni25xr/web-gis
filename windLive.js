const WIND_API_BASES = [
  "https://opendata-download-metobs.smhi.se/api/version/latest/",
  "https://opendata-download-metobs.smhi.se/api/version/1.0/"
];
const WIND_CENTER = { lon: 14.1618, lat: 57.7826 };
const WIND_RADIUS_KM = 30;
const WIND_REFRESH_MS = 5 * 60 * 1000;

let windState = {
  view: null,
  GraphicsLayer: null,
  Graphic: null,
  layer: null,
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

async function fetchParameters(base) {
  const url = `${base}parameter.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Parameters HTTP ${res.status}`);
  const json = await res.json();
  return normalizeArray(json);
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
    windState.layer.removeAll();

    const stations = await fetchStations(windState.windSpeedParam);
    const nearby = stations.filter((st) => {
      const coords = getStationCoords(st);
      if (!coords) return false;
      return distanceKm(WIND_CENTER, { lat: coords.lat, lon: coords.lon }) <= WIND_RADIUS_KM;
    });

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
