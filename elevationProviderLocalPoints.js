(() => {
  const STATE = {
    status: "idle",
    message: "",
    field: null,
    points: [],
    bbox: null,
    grid: new Map(),
    cellSize: 0.0007,
    cache: new Map(),
    view: null,
    webMercatorUtils: null,
    GraphicsLayer: null,
    Graphic: null,
    debugLayer: null
  };
  let initPromise = null;

  function log(msg, ...rest) {
    console.log(`[ELEV] ${msg}`, ...rest);
  }

  function normalizeKey(key) {
    return String(key || "")
      .toLowerCase()
      .replace(/ö/g, "o")
      .replace(/ä/g, "a")
      .replace(/å/g, "a");
  }

  function detectField(props) {
    if (!props) return null;
    const candidates = ["elevation", "elev", "height", "hojd", "hojd_m", "z", "alt", "altitude", "hojd_m"];
    const entries = Object.entries(props);
    for (const k of candidates) {
      const match = entries.find(([key, val]) => normalizeKey(key) === k && Number.isFinite(Number(val)));
      if (match) return match[0];
    }
    return null;
  }

  function setStatus(status, message) {
    STATE.status = status;
    STATE.message = message || "";
  }

  function addToGrid(pt) {
    const key = `${Math.floor(pt.lon / STATE.cellSize)}:${Math.floor(pt.lat / STATE.cellSize)}`;
    if (!STATE.grid.has(key)) STATE.grid.set(key, []);
    STATE.grid.get(key).push(pt);
  }

  function updateBbox(lon, lat) {
    if (!STATE.bbox) {
      STATE.bbox = { minLon: lon, maxLon: lon, minLat: lat, maxLat: lat };
      return;
    }
    STATE.bbox.minLon = Math.min(STATE.bbox.minLon, lon);
    STATE.bbox.maxLon = Math.max(STATE.bbox.maxLon, lon);
    STATE.bbox.minLat = Math.min(STATE.bbox.minLat, lat);
    STATE.bbox.maxLat = Math.max(STATE.bbox.maxLat, lat);
  }

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function cacheGet(lat, lon) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (STATE.cache.has(key)) return STATE.cache.get(key);
    return null;
  }

  function cacheSet(lat, lon, value) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (STATE.cache.has(key)) return;
    STATE.cache.set(key, value);
    if (STATE.cache.size > 2000) {
      const first = STATE.cache.keys().next().value;
      STATE.cache.delete(first);
    }
  }

  async function init(options = {}) {
    if (initPromise) return initPromise;
    STATE.view = options.view || null;
    STATE.webMercatorUtils = options.webMercatorUtils || null;
    STATE.GraphicsLayer = options.GraphicsLayer || null;
    STATE.Graphic = options.Graphic || null;
    setStatus("loading", "Höjd: laddar…");

    initPromise = fetch("./data/Hojder_Oxnehaga_2.geojson")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data?.type !== "FeatureCollection") {
          throw new Error("Invalid GeoJSON");
        }
        const feats = Array.isArray(data.features) ? data.features : [];
        const points = [];
        let field = null;
        for (const f of feats) {
          const geom = f?.geometry;
          if (!geom || geom.type !== "Point") continue;
          const coords = geom.coordinates || [];
          const lon = coords[0];
          const lat = coords[1];
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          let z = null;
          if (coords.length >= 3 && Number.isFinite(coords[2])) {
            z = coords[2];
          } else {
            if (!field) {
              field = detectField(f.properties || f.attributes || null);
            }
            if (field) {
              const raw = (f.properties || f.attributes || {})[field];
              const v = Number(raw);
              if (Number.isFinite(v)) z = v;
            }
          }
          if (!Number.isFinite(z)) continue;
          const pt = { lon, lat, z };
          points.push(pt);
          updateBbox(lon, lat);
        }
        STATE.points = points;
        STATE.field = field;
        points.forEach(addToGrid);

        log(`loaded points: ${points.length}`);
        if (STATE.bbox) log("bbox:", STATE.bbox);
        log("elevationField:", field || "coords[2]");

        if (!points.length) {
          setStatus("empty", "Höjd: kunde inte laddas");
        } else if (!field && !(points[0] && Number.isFinite(points[0].z))) {
          setStatus("no-field", "Höjddata: saknar höjdfält");
        } else {
          setStatus("ready", "");
        }

        if (window.ELEV_DEBUG) {
          drawDebugPoints();
        }
        return true;
      })
      .catch((e) => {
        console.error("[ELEV] load failed:", e);
        setStatus("error", "Höjd: kunde inte laddas");
        return false;
      });

    return initPromise;
  }

  function getStatus() {
    return { status: STATE.status, message: STATE.message };
  }

  function getCandidates(lat, lon, ring) {
    const size = STATE.cellSize;
    const cx = Math.floor(lon / size);
    const cy = Math.floor(lat / size);
    const candidates = [];
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const key = `${cx + dx}:${cy + dy}`;
        const bucket = STATE.grid.get(key);
        if (bucket && bucket.length) candidates.push(...bucket);
      }
    }
    return candidates;
  }

  function getElevationAt(lat, lon) {
    if (STATE.status !== "ready") return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (STATE.bbox) {
      if (lon < STATE.bbox.minLon || lon > STATE.bbox.maxLon || lat < STATE.bbox.minLat || lat > STATE.bbox.maxLat) {
        return null;
      }
    }

    const cached = cacheGet(lat, lon);
    if (cached !== null) return cached;

    let candidates = getCandidates(lat, lon, 1);
    if (!candidates.length) candidates = getCandidates(lat, lon, 2);
    if (!candidates.length) return null;

    const distances = candidates.map((pt) => ({
      pt,
      d: haversineMeters({ lat, lon }, { lat: pt.lat, lon: pt.lon })
    })).filter((d) => Number.isFinite(d.d));

    if (!distances.length) return null;
    distances.sort((a, b) => a.d - b.d);

    const radius = 200;
    const within = distances.filter((d) => d.d <= radius).slice(0, 6);
    if (within.length >= 2) {
      let wSum = 0;
      let zSum = 0;
      for (const n of within) {
        if (n.d === 0) {
          cacheSet(lat, lon, n.pt.z);
          return n.pt.z;
        }
        const w = 1 / (n.d * n.d);
        wSum += w;
        zSum += w * n.pt.z;
      }
      const z = wSum ? zSum / wSum : null;
      if (Number.isFinite(z)) cacheSet(lat, lon, z);
      return Number.isFinite(z) ? z : null;
    }

    const nearest = distances[0];
    if (nearest && Number.isFinite(nearest.pt.z)) {
      cacheSet(lat, lon, nearest.pt.z);
      return nearest.pt.z;
    }
    return null;
  }

  function normalizePolyline(polyline) {
    if (!polyline) return null;
    const paths = polyline?.paths || [];
    if (!paths.length || !paths[0].length) return null;
    const sr = polyline.spatialReference;
    if (sr && (sr.isWebMercator || sr.wkid === 3857 || sr.wkid === 102100) && STATE.webMercatorUtils) {
      try {
        const geo = STATE.webMercatorUtils.webMercatorToGeographic(polyline);
        const gpaths = geo?.paths || [];
        if (gpaths.length) return gpaths[0].map((p) => ({ lon: p[0], lat: p[1] }));
      } catch (e) {
        return null;
      }
    }
    return paths[0].map((p) => ({ lon: p[0], lat: p[1] }));
  }

  function buildDistances(points) {
    const distances = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const d = haversineMeters(points[i - 1], points[i]);
      total += d;
      distances.push(total);
    }
    return { distances, total };
  }

  function pointAtDistance(points, distances, target) {
    if (!points.length) return null;
    const total = distances[distances.length - 1] || 0;
    const t = Math.max(0, Math.min(target, total));
    let i = 0;
    while (i < distances.length - 2 && distances[i + 1] < t) i += 1;
    const d0 = distances[i];
    const d1 = distances[i + 1];
    const ratio = d1 > d0 ? (t - d0) / (d1 - d0) : 0;
    const a = points[i];
    const b = points[i + 1] || a;
    return {
      lon: a.lon + (b.lon - a.lon) * ratio,
      lat: a.lat + (b.lat - a.lat) * ratio
    };
  }

  function computeForPolyline(polyline) {
    if (STATE.status !== "ready") return { error: STATE.status };
    const points = normalizePolyline(polyline);
    if (!points || points.length < 2) return { error: "no-line" };
    const { distances, total } = buildDistances(points);
    if (!total) return { error: "no-line" };

    let spacing = 30;
    const maxSamples = 120;
    if (total / spacing > maxSamples) spacing = total / maxSamples;

    const sampleDistances = [];
    for (let d = 0; d <= total; d += spacing) sampleDistances.push(d);
    if (sampleDistances[sampleDistances.length - 1] !== total) sampleDistances.push(total);

    const zArray = [];
    let valid = 0;
    for (const d of sampleDistances) {
      const pt = pointAtDistance(points, distances, d);
      if (!pt) continue;
      const z = getElevationAt(pt.lat, pt.lon);
      if (Number.isFinite(z)) {
        zArray.push(z);
        valid += 1;
      }
    }

    if (!zArray.length || valid / sampleDistances.length < 0.5) {
      console.debug("[ELEV] sparse samples", { valid, total: sampleDistances.length });
      return { error: "sparse", valid, total: sampleDistances.length };
    }

    let up = 0;
    let down = 0;
    for (let i = 1; i < zArray.length; i++) {
      const delta = zArray[i] - zArray[i - 1];
      if (delta > 0) up += delta;
      else down += Math.abs(delta);
    }

    if (window.ELEV_DEBUG) {
      drawRouteSamples(points, distances, sampleDistances);
    }

    return {
      start: zArray[0],
      end: zArray[zArray.length - 1],
      diff: zArray[zArray.length - 1] - zArray[0],
      up,
      down
    };
  }

  function drawDebugPoints() {
    if (!STATE.view || !STATE.GraphicsLayer || !STATE.Graphic) return;
    if (!STATE.debugLayer) {
      STATE.debugLayer = new STATE.GraphicsLayer({ title: "ELEV DEBUG" });
      STATE.view.map.add(STATE.debugLayer);
    }
    STATE.debugLayer.removeAll();
    const sample = STATE.points.slice(0, 200);
    sample.forEach((pt) => {
      STATE.debugLayer.add(new STATE.Graphic({
        geometry: { type: "point", longitude: pt.lon, latitude: pt.lat },
        symbol: { type: "simple-marker", size: 4, color: [0, 0, 0, 0.6] }
      }));
    });
  }

  function drawRouteSamples(points, distances, sampleDistances) {
    if (!STATE.view || !STATE.GraphicsLayer || !STATE.Graphic) return;
    if (!STATE.debugLayer) {
      STATE.debugLayer = new STATE.GraphicsLayer({ title: "ELEV DEBUG" });
      STATE.view.map.add(STATE.debugLayer);
    }
    sampleDistances.forEach((d) => {
      const pt = pointAtDistance(points, distances, d);
      if (!pt) return;
      STATE.debugLayer.add(new STATE.Graphic({
        geometry: { type: "point", longitude: pt.lon, latitude: pt.lat },
        symbol: { type: "simple-marker", size: 5, color: [239, 68, 68, 0.7] }
      }));
    });
  }

  window.ELEV_DEBUG = false;
  window.ElevationLocal = {
    init,
    getStatus,
    getElevationAt,
    computeForPolyline
  };
})();
