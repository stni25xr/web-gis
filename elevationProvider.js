(() => {
  const CACHE_KEY = "stn25xr_elev_cache_v1";
  const memoryCache = new Map();
  let storageCache = {};

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) storageCache = JSON.parse(raw) || {};
  } catch (e) {
    storageCache = {};
  }

  function roundCoord(value) {
    return Math.round(value * 1e5) / 1e5;
  }

  function makeKey(lat, lon) {
    return `${roundCoord(lat)},${roundCoord(lon)}`;
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(storageCache));
    } catch (e) {
      // ignore storage errors
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchJson(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const GEOJSON_URL = window.ELEVATION_GEOJSON_URL || "";
  const GEOJSON_PRECISION = 6;
  const GEOJSON_STEP = 1 / 10 ** GEOJSON_PRECISION;
  let geoIndex = null;
  let geoIndexReady = null;

  function roundCoordPrec(value, precision) {
    return Math.round(value * 10 ** precision) / 10 ** precision;
  }

  function makeGeoKey(lat, lon) {
    const rLat = roundCoordPrec(lat, GEOJSON_PRECISION);
    const rLon = roundCoordPrec(lon, GEOJSON_PRECISION);
    return `${rLat},${rLon}`;
  }

  async function ensureGeoIndex() {
    if (!GEOJSON_URL) return null;
    if (geoIndexReady) return geoIndexReady;
    geoIndexReady = (async () => {
      try {
        const res = await fetch(GEOJSON_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const features = data?.features || [];
        geoIndex = new Map();
        for (let i = 0; i < features.length; i++) {
          const feat = features[i];
          const coords = feat?.geometry?.coordinates;
          if (!coords || coords.length < 2) continue;
          const lon = coords[0];
          const lat = coords[1];
          const z = feat?.properties?.grid_code;
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(z)) continue;
          geoIndex.set(makeGeoKey(lat, lon), z);
          if (i % 50000 === 0) await delay(0);
        }
        return geoIndex;
      } catch (e) {
        console.warn("[Elevation] GeoJSON load failed", e);
        geoIndex = null;
        return null;
      }
    })();
    return geoIndexReady;
  }

  async function getElevationFromGeoJSON(lat, lon) {
    if (!GEOJSON_URL) return null;
    const index = await ensureGeoIndex();
    if (!index) return null;
    const key = makeGeoKey(lat, lon);
    if (index.has(key)) return index.get(key);
    // search nearest in a small window (handles rounding mismatch)
    let best = null;
    let bestD = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const candKey = `${roundCoordPrec(lat + dy * GEOJSON_STEP, GEOJSON_PRECISION)},${roundCoordPrec(lon + dx * GEOJSON_STEP, GEOJSON_PRECISION)}`;
        if (!index.has(candKey)) continue;
        const z = index.get(candKey);
        const dLat = (lat - (lat + dy * GEOJSON_STEP));
        const dLon = (lon - (lon + dx * GEOJSON_STEP));
        const d = dLat * dLat + dLon * dLon;
        if (d < bestD) {
          bestD = d;
          best = z;
        }
      }
    }
    return Number.isFinite(best) ? best : null;
  }

  async function getElevation(lat, lon) {
    const key = makeKey(lat, lon);
    if (memoryCache.has(key)) return memoryCache.get(key);
    if (Object.prototype.hasOwnProperty.call(storageCache, key)) {
      const v = storageCache[key];
      memoryCache.set(key, v);
      return v;
    }

    let elevation = null;
    if (GEOJSON_URL) {
      elevation = await getElevationFromGeoJSON(lat, lon);
      if (elevation === null) return null;
    }
    const loc = `${lat},${lon}`;
    try {
      if (elevation === null) {
        const data = await fetchJson(`https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(loc)}`);
        const value = data?.results?.[0]?.elevation;
        if (Number.isFinite(value)) elevation = value;
      }
    } catch (e) {
      elevation = null;
    }

    if (elevation === null) {
      try {
        const data = await fetchJson(`https://api.open-meteo.com/v1/elevation?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`);
        const value = Array.isArray(data?.elevation) ? data.elevation[0] : data?.elevation;
        if (Number.isFinite(value)) elevation = value;
      } catch (e) {
        elevation = null;
      }
    }

    if (elevation !== null) {
      memoryCache.set(key, elevation);
      storageCache[key] = elevation;
      saveCache();
    }
    return elevation;
  }

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(b.latitude - a.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function normalizeRoute(routePolyline) {
    if (!routePolyline) return null;
    const paths = routePolyline?.paths || [];
    if (!paths.length) return null;
    const raw = paths[0];
    let pts = raw.map((p) => ({ longitude: p[0], latitude: p[1] }));
    const sr = routePolyline.spatialReference;
    if (sr && (sr.isWebMercator || sr.wkid === 3857 || sr.wkid === 102100) && window.webMercatorUtils) {
      try {
        const geo = window.webMercatorUtils.webMercatorToGeographic(routePolyline);
        const gpaths = geo?.paths || [];
        if (gpaths.length) {
          pts = gpaths[0].map((p) => ({ longitude: p[0], latitude: p[1] }));
        }
      } catch (e) {
        // ignore conversion error
      }
    }
    return pts;
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
      longitude: a.longitude + (b.longitude - a.longitude) * ratio,
      latitude: a.latitude + (b.latitude - a.latitude) * ratio
    };
  }

  async function sampleRouteElevations(routePolyline) {
    const points = normalizeRoute(routePolyline);
    if (!points || points.length < 2) return null;
    const { distances, total } = buildDistances(points);
    if (!total) return null;

    const maxSamples = 60;
    const step = Math.min(50, Math.max(30, total / maxSamples));
    const sampleDistances = [];
    for (let d = 0; d <= total; d += step) sampleDistances.push(d);
    if (sampleDistances[sampleDistances.length - 1] !== total) sampleDistances.push(total);

    const elevations = [];
    for (const d of sampleDistances) {
      const pt = pointAtDistance(points, distances, d);
      if (!pt) continue;
      const elev = await getElevation(pt.latitude, pt.longitude);
      elevations.push({ distance: d, elevation: elev });
      await delay(120);
    }

    const valid = elevations.filter((e) => Number.isFinite(e.elevation));
    if (valid.length < 2) return null;

    let up = 0;
    let down = 0;
    for (let i = 1; i < valid.length; i++) {
      const delta = valid[i].elevation - valid[i - 1].elevation;
      if (delta > 0) up += delta;
      else down += Math.abs(delta);
    }

    const start = valid[0].elevation;
    const end = valid[valid.length - 1].elevation;
    return {
      start,
      end,
      diff: end - start,
      up,
      down
    };
  }

  window.ElevationProvider = { getElevation, sampleRouteElevations };
})();
