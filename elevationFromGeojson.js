(() => {
  const STATE = {
    status: "idle",
    points: [],
    bbox: null,
    isWgs84: null
  };
  let loadPromise = null;

  function normalizeKey(key) {
    return String(key || "")
      .toLowerCase()
      .replace(/ö/g, "o")
      .replace(/ä/g, "a")
      .replace(/å/g, "a");
  }

  function extractElevationValue(props) {
    if (!props) return null;
    const entries = Object.entries(props);
    const preferred = ["elevation", "hojd", "hojdskillnad", "z", "height", "grid_code"];
    for (const [k, v] of entries) {
      const nk = normalizeKey(k);
      if (preferred.some((p) => nk === p || nk.includes(p))) {
        const num = Number(v);
        if (Number.isFinite(num)) return num;
      }
    }
    for (const [, v] of entries) {
      const num = Number(v);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  function inferIsWgs84(sample) {
    if (!sample) return true;
    const x = sample[0];
    const y = sample[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    return Math.abs(x) <= 180 && Math.abs(y) <= 90;
  }

  function updateBbox(x, y) {
    if (!STATE.bbox) {
      STATE.bbox = { minX: x, minY: y, maxX: x, maxY: y };
      return;
    }
    STATE.bbox.minX = Math.min(STATE.bbox.minX, x);
    STATE.bbox.minY = Math.min(STATE.bbox.minY, y);
    STATE.bbox.maxX = Math.max(STATE.bbox.maxX, x);
    STATE.bbox.maxY = Math.max(STATE.bbox.maxY, y);
  }

  function cacheElevationGeojson(data) {
    const features = data?.features || [];
    if (!features.length) {
      STATE.points = [];
      STATE.bbox = null;
      STATE.status = "empty";
      return;
    }

    STATE.points = [];
    STATE.bbox = null;

    let sampleCoord = null;
    for (const f of features) {
      const geom = f?.geometry;
      if (!geom) continue;
      const type = geom.type;
      const coords = geom.coordinates;
      if (!coords) continue;

      const pushPoint = (coord, props) => {
        if (!sampleCoord) sampleCoord = coord;
        const x = coord[0];
        const y = coord[1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const zFromCoord = Number.isFinite(coord[2]) ? coord[2] : null;
        const zFromProps = extractElevationValue(props);
        const z = Number.isFinite(zFromCoord) ? zFromCoord : zFromProps;
        if (!Number.isFinite(z)) return;
        STATE.points.push({ x, y, z });
        updateBbox(x, y);
      };

      if (type === "Point") {
        pushPoint(coords, f.properties || f.attributes || null);
      } else if (type === "MultiPoint") {
        const props = f.properties || f.attributes || null;
        coords.forEach((c) => pushPoint(c, props));
      }
    }

    STATE.isWgs84 = inferIsWgs84(sampleCoord);
    STATE.status = STATE.points.length ? "ready" : "empty";
  }

  function loadElevationGeojson() {
    if (loadPromise) return loadPromise;
    STATE.status = "loading";
    const candidates = ["./data/Hojder_Oxnehaga.geojson"];
    loadPromise = (async () => {
      for (const url of candidates) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          cacheElevationGeojson(data);
          return true;
        } catch (e) {
          // try next candidate
        }
      }
      throw new Error("No elevation GeoJSON found");
    })()
      .catch((e) => {
        console.warn("Elevation GeoJSON load failed:", e);
        STATE.status = "error";
        return false;
      });
    return loadPromise;
  }

  function getStatus() {
    return STATE.status;
  }

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(b.y - a.y);
    const dLon = toRad(b.x - a.x);
    const lat1 = toRad(a.y);
    const lat2 = toRad(b.y);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function toDatasetPoint(point) {
    if (!point) return null;
    const sr = point.spatialReference || null;
    const hasLonLat = Number.isFinite(point.longitude) && Number.isFinite(point.latitude);
    const hasXY = Number.isFinite(point.x) && Number.isFinite(point.y);

    if (STATE.isWgs84) {
      if (hasLonLat) return { x: point.longitude, y: point.latitude };
      if (sr && (sr.isWebMercator || sr.wkid === 3857 || sr.wkid === 102100) && window.webMercatorUtils) {
        try {
          const geo = window.webMercatorUtils.webMercatorToGeographic(point);
          return { x: geo.longitude, y: geo.latitude };
        } catch (e) {
          return null;
        }
      }
      if (hasXY) return { x: point.x, y: point.y };
      return null;
    }

    if (hasXY && (!sr || sr.isWebMercator || sr.wkid === 3857 || sr.wkid === 102100)) {
      return { x: point.x, y: point.y };
    }
    if (hasLonLat && window.webMercatorUtils) {
      try {
        const wm = window.webMercatorUtils.geographicToWebMercator({
          type: "point",
          longitude: point.longitude,
          latitude: point.latitude,
          spatialReference: { wkid: 4326 }
        });
        return { x: wm.x, y: wm.y };
      } catch (e) {
        return null;
      }
    }
    if (hasXY) return { x: point.x, y: point.y };
    return null;
  }

  function getElevationAt(point) {
    if (STATE.status !== "ready" || !STATE.points.length) return null;
    const p = toDatasetPoint(point);
    if (!p) return null;
    if (STATE.bbox) {
      if (p.x < STATE.bbox.minX || p.x > STATE.bbox.maxX || p.y < STATE.bbox.minY || p.y > STATE.bbox.maxY) {
        return null;
      }
    }

    const radius = 120;
    const maxNeighbors = 6;
    const pow = 2;
    let nearest = null;
    const neighbors = [];

    for (const pt of STATE.points) {
      let d = null;
      if (STATE.isWgs84) {
        d = haversineMeters({ x: pt.x, y: pt.y }, p);
      } else {
        const dx = pt.x - p.x;
        const dy = pt.y - p.y;
        d = Math.sqrt(dx * dx + dy * dy);
      }
      if (!Number.isFinite(d)) continue;
      if (!nearest || d < nearest.d) nearest = { d, z: pt.z };
      if (d <= radius) neighbors.push({ d, z: pt.z });
    }

    if (!neighbors.length && nearest) return nearest.z;
    if (!neighbors.length) return null;

    neighbors.sort((a, b) => a.d - b.d);
    const slice = neighbors.slice(0, maxNeighbors);
    let wSum = 0;
    let zSum = 0;
    for (const n of slice) {
      if (n.d === 0) return n.z;
      const w = 1 / Math.pow(n.d, pow);
      wSum += w;
      zSum += w * n.z;
    }
    return wSum ? zSum / wSum : null;
  }

  function computeElevationStats(zArray) {
    const clean = (zArray || []).filter((z) => Number.isFinite(z));
    if (clean.length < 2) return null;
    let up = 0;
    let down = 0;
    for (let i = 1; i < clean.length; i++) {
      const delta = clean[i] - clean[i - 1];
      if (delta > 0) up += delta;
      else down += Math.abs(delta);
    }
    return {
      start: clean[0],
      end: clean[clean.length - 1],
      diff: clean[clean.length - 1] - clean[0],
      up,
      down
    };
  }

  function normalizePolyline(polyline) {
    if (!polyline) return null;
    const paths = polyline?.paths || [];
    if (!paths.length || !paths[0].length) return null;
    const sr = polyline.spatialReference;
    if (sr && (sr.isWebMercator || sr.wkid === 3857 || sr.wkid === 102100) && window.webMercatorUtils) {
      try {
        const geo = window.webMercatorUtils.webMercatorToGeographic(polyline);
        const gpaths = geo?.paths || [];
        if (gpaths.length) return gpaths[0].map((p) => ({ longitude: p[0], latitude: p[1] }));
      } catch (e) {
        return null;
      }
    }
    return paths[0].map((p) => ({ longitude: p[0], latitude: p[1] }));
  }

  function buildDistances(points) {
    const distances = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const d = haversineMeters({ x: a.longitude, y: a.latitude }, { x: b.longitude, y: b.latitude });
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

  function sampleElevationAlongPolyline(polyline) {
    if (STATE.status !== "ready") return null;
    const points = normalizePolyline(polyline);
    if (!points || points.length < 2) return null;
    const { distances, total } = buildDistances(points);
    if (!total) return null;

    let step = total <= 200 ? 5 : 10;
    const maxSamples = 200;
    if (total / step > maxSamples) step = total / maxSamples;

    const sampleDistances = [];
    for (let d = 0; d <= total; d += step) sampleDistances.push(d);
    if (sampleDistances[sampleDistances.length - 1] !== total) sampleDistances.push(total);

    const zArray = [];
    for (const d of sampleDistances) {
      const pt = pointAtDistance(points, distances, d);
      if (!pt) continue;
      const z = getElevationAt(pt);
      if (Number.isFinite(z)) zArray.push(z);
    }

    return computeElevationStats(zArray);
  }

  window.ElevationFromGeojson = {
    loadElevationGeojson,
    cacheElevationGeojson,
    getElevationAt,
    sampleElevationAlongPolyline,
    computeElevationStats,
    getStatus
  };
})();
