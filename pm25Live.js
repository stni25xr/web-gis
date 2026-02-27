const PM25_API_BASE = "https://datavardluft.smhi.se/52North/api/";
const PM25_CENTER = { lon: 14.1618, lat: 57.7826 };
const PM25_RADIUS_KM = 30;
const PM25_REFRESH_MS = 5 * 60 * 1000;

let pm25State = {
  view: null,
  GraphicsLayer: null,
  Graphic: null,
  layer: null,
  enabled: false,
  inFlight: false,
  timer: null,
  pm25PhenomenonId: null,
  lastWarn: null
};

function warnOnce(key, err) {
  if (pm25State.lastWarn === key) return;
  pm25State.lastWarn = key;
  console.warn(key, err || "");
}

function setStatus(text, isError = false) {
  const el = document.getElementById("pm25Status");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "";
}

function normalizeArray(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.member)) return json.member;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.features)) return json.features;
  return [];
}

function findPm25Phenomenon(items) {
  const isPm25 = (item) => {
    const label = String(item.label || item.name || item.shortName || item.description || "").toLowerCase();
    const domainId = String(item.domainId || item.identifier || item.id || "").toLowerCase();
    return domainId.includes("/600")
      || domainId === "600"
      || domainId.includes("pm2.5")
      || domainId.includes("pm2,5")
      || label.includes("pm2.5")
      || label.includes("pm 2.5")
      || label.includes("pm2,5")
      || label.includes("pm 2,5");
  };
  return items.find(isPm25) || null;
}

async function fetchPhenomenaPage(offset, limit) {
  const url = `${PM25_API_BASE}phenomena?limit=${limit}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Phenomena HTTP ${res.status}`);
  const json = await res.json();
  return normalizeArray(json);
}

async function searchPhenomena(term) {
  const url = `${PM25_API_BASE}phenomena?limit=100&searchText=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return normalizeArray(json);
}

async function resolvePm25PhenomenonId() {
  if (pm25State.pm25PhenomenonId) return pm25State.pm25PhenomenonId;
  const searchTerms = ["PM2.5", "PM 2.5", "PM2,5", "PM 2,5"];
  let items = [];
  for (const term of searchTerms) {
    const found = await searchPhenomena(term);
    items = items.concat(found);
  }
  let pm25 = findPm25Phenomenon(items);
  if (!pm25) {
    const limit = 200;
    let offset = 0;
    for (let i = 0; i < 10; i += 1) {
      const page = await fetchPhenomenaPage(offset, limit);
      if (!page.length) break;
      pm25 = findPm25Phenomenon(page);
      if (pm25) break;
      offset += limit;
    }
  }
  if (!pm25) return null;
  pm25State.pm25PhenomenonId = pm25.id || pm25.identifier || pm25.domainId;
  return pm25State.pm25PhenomenonId;
}

function makeNearParam() {
  const near = {
    center: { type: "Point", coordinates: [PM25_CENTER.lon, PM25_CENTER.lat] },
    radius: PM25_RADIUS_KM
  };
  return encodeURIComponent(JSON.stringify(near));
}

function makeBboxParam() {
  const bbox = {
    ll: { type: "Point", coordinates: [13.7, 57.5] },
    ur: { type: "Point", coordinates: [14.7, 58.1] }
  };
  return encodeURIComponent(JSON.stringify(bbox));
}

async function fetchStations(phenomenonId) {
  const nearUrl = `${PM25_API_BASE}stations?phenomenon=${encodeURIComponent(phenomenonId)}&limit=100&near=${makeNearParam()}`;
  let res = await fetch(nearUrl);
  if (!res.ok) {
    const bboxUrl = `${PM25_API_BASE}stations?phenomenon=${encodeURIComponent(phenomenonId)}&limit=100&bbox=${makeBboxParam()}`;
    res = await fetch(bboxUrl);
  }
  if (!res.ok) throw new Error(`Stations HTTP ${res.status}`);
  const json = await res.json();
  const features = normalizeArray(json);
  if (json && Array.isArray(json.features)) return json.features;
  return features;
}

function getFeatureId(feature) {
  return feature?.properties?.id
    || feature?.id
    || feature?.properties?.identifier
    || feature?.properties?.stationId
    || feature?.properties?.station
    || null;
}

function getFeatureLabel(feature) {
  return feature?.properties?.label
    || feature?.properties?.name
    || feature?.properties?.stationName
    || feature?.properties?.station
    || "Station";
}

function getFeatureCoords(feature) {
  const coords = feature?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    return { lon: coords[0], lat: coords[1] };
  }
  return null;
}

function formatTimestamp(ts) {
  if (!ts) return "Okänt";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString("sv-SE", { hour12: false });
}

function pickLatestFromArray(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const last = values[values.length - 1];
  if (Array.isArray(last) && last.length >= 2) {
    return { value: Number(last[1]), timestamp: last[0] };
  }
  if (typeof last === "object") {
    return {
      value: Number(last.value ?? last.v ?? last.result ?? last.pm25),
      timestamp: last.timestamp ?? last.time ?? last.t
    };
  }
  return null;
}

async function fetchLatestValue(phenomenonId, stationId) {
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 60 * 60 * 1000);
  const timespan = `${start.toISOString()}/${end.toISOString()}`;
  const url = `${PM25_API_BASE}timeseries?phenomenon=${encodeURIComponent(phenomenonId)}&station=${encodeURIComponent(stationId)}&timespan=${encodeURIComponent(timespan)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Timeseries HTTP ${res.status}`);
  let json = await res.json();
  if (json && json.href) {
    const hrefRes = await fetch(json.href);
    if (hrefRes.ok) json = await hrefRes.json();
  }

  const items = normalizeArray(json);
  const first = items[0] || json;
  if (first) {
    if (Array.isArray(first.values)) {
      return pickLatestFromArray(first.values);
    }
    if (Array.isArray(first.data)) {
      return pickLatestFromArray(first.data);
    }
    if (first.lastValue) {
      return {
        value: Number(first.lastValue.value ?? first.lastValue.v ?? first.lastValue.result),
        timestamp: first.lastValue.timestamp ?? first.lastValue.time
      };
    }
  }
  if (Array.isArray(json.values)) return pickLatestFromArray(json.values);
  if (Array.isArray(json.data)) return pickLatestFromArray(json.data);
  return null;
}

function colorForValue(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "#94a3b8";
  if (value < 10) return "#22c55e";
  if (value < 25) return "#facc15";
  if (value < 50) return "#f97316";
  return "#ef4444";
}

function ensureLayer() {
  if (pm25State.layer || !pm25State.GraphicsLayer || !pm25State.view) return;
  pm25State.layer = new pm25State.GraphicsLayer({
    title: "PM2.5 (live)",
    elevationInfo: { mode: "relative-to-ground", offset: 6 }
  });
  pm25State.view.map.add(pm25State.layer);
}

async function refreshPm25() {
  if (!pm25State.enabled || pm25State.inFlight) return;
  pm25State.inFlight = true;
  try {
    const phenomenonId = await resolvePm25PhenomenonId();
    if (!phenomenonId) {
      setStatus("Kunde inte hitta PM2.5 i API", true);
      pm25State.enabled = false;
      const toggle = document.getElementById("pm25Toggle");
      if (toggle) toggle.checked = false;
      return;
    }
    ensureLayer();
    pm25State.layer.removeAll();

    const stations = await fetchStations(phenomenonId);
    if (!stations.length) {
      setStatus("Inga PM2.5-stationer hittades", true);
      return;
    }

    const latestByStation = await Promise.all(stations.map(async (feature) => {
      const stationId = getFeatureId(feature);
      if (!stationId) return null;
      try {
        const latest = await fetchLatestValue(phenomenonId, stationId);
        return { feature, stationId, latest };
      } catch (err) {
        warnOnce("PM2.5: timeseries fetch failed", err);
        return { feature, stationId, latest: null };
      }
    }));

    latestByStation.filter(Boolean).forEach((item) => {
      const coords = getFeatureCoords(item.feature);
      if (!coords) return;
      const label = getFeatureLabel(item.feature);
      const value = item.latest?.value;
      const ts = item.latest?.timestamp;
      const graphic = new pm25State.Graphic({
        geometry: {
          type: "point",
          longitude: coords.lon,
          latitude: coords.lat
        },
        symbol: {
          type: "simple-marker",
          color: colorForValue(value),
          size: 10,
          outline: { color: "#0f172a", width: 0.8 }
        },
        attributes: {
          stationName: label,
          pm25: value !== undefined && value !== null && !Number.isNaN(value) ? value.toFixed(1) : "Saknas",
          timestamp: formatTimestamp(ts),
          source: "Naturvårdsverket/SMHI (Datavärd luft)"
        },
        popupTemplate: {
          title: "{stationName}",
          content: "PM2.5: {pm25} µg/m³<br/>Tid: {timestamp}<br/>Källa: {source}"
        }
      });
      pm25State.layer.add(graphic);
    });

    setStatus(`Senast uppdaterad: ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`);
  } catch (err) {
    warnOnce("PM2.5: refresh failed", err);
    setStatus("PM2.5-data otillgänglig just nu", true);
  } finally {
    pm25State.inFlight = false;
  }
}

function enablePm25() {
  pm25State.enabled = true;
  setStatus("Laddar PM2.5...");
  refreshPm25();
  if (pm25State.timer) clearInterval(pm25State.timer);
  pm25State.timer = setInterval(refreshPm25, PM25_REFRESH_MS);
}

function disablePm25() {
  pm25State.enabled = false;
  if (pm25State.timer) {
    clearInterval(pm25State.timer);
    pm25State.timer = null;
  }
  if (pm25State.layer) {
    pm25State.layer.removeAll();
    pm25State.layer.visible = false;
  }
  setStatus("Av");
}

window.initPm25Live = (opts) => {
  pm25State.view = opts?.view || null;
  pm25State.GraphicsLayer = opts?.GraphicsLayer || null;
  pm25State.Graphic = opts?.Graphic || null;
  const toggle = document.getElementById("pm25Toggle");
  if (!toggle) return;

  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      if (pm25State.layer) pm25State.layer.visible = true;
      enablePm25();
    } else {
      disablePm25();
    }
  });
};
