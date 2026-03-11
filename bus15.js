(() => {
  const DEFAULTS = {
    updateMs: 5000,
    dwellMs: 5000
  };
  const BUS_GROUND_OFFSET_METERS = 6;
  const BUS_SIM_SPEED_MULTIPLIER = 1;
  const GTFS_ROUTE_JOIN_MAX_METERS = 900;
  const HARD_FALLBACK_LOOP = [
    [14.2620, 57.7722],
    [14.2642, 57.7737],
    [14.2673, 57.7736],
    [14.2696, 57.7721],
    [14.2692, 57.7702],
    [14.2669, 57.7694],
    [14.2638, 57.7697],
    [14.2622, 57.7711]
  ];
  const DEMO_STOPS = {
    "2001": { name: "Hisingsängens vändplan", coord: [14.142919, 57.794633] },
    "2002": { name: "Jönköping Resecentrum", coord: [14.164596, 57.784145] },
    "2003": { name: "Jönköping Ekhagen centrum", coord: [14.226090, 57.777860] },
    "1018": { name: "Kungsporten", coord: [14.261092639000026, 57.781745461000071] },
    "1412": { name: "Hästhagsgatan", coord: [14.263372397000069, 57.779142051000065] },
    "1420": { name: "Huskvarna Oxhagsskolan", coord: [14.26059093300006, 57.77735702400008] },
    "1415": { name: "Öxnegården", coord: [14.25969862200003, 57.77542438200004] },
    "1414": { name: "Öxnehaga centrum", coord: [14.264104008000061, 57.775388269000075] },
    "1413": { name: "Lahagsgatan", coord: [14.268596427000034, 57.774886093000077] },
    "1419": { name: "Kalvhagsgatan", coord: [14.268249268000034, 57.771191051000073] },
    "1418": { name: "Kohagsgatan", coord: [14.264283418000048, 57.771573884000077] },
    "1417": { name: "Rishagsgatan", coord: [14.258814077000068, 57.771740692000037] },
    "1416": { name: "Öxnehaga idrottsplats", coord: [14.25666525400004, 57.773645170000066] },
    "1228": { name: "Lövhagen", coord: [14.269413961000055, 57.769885116000069] },
    "1229": { name: "Stekelvägen", coord: [14.271560191000049, 57.766830973000083] },
    "1422": { name: "Lövhagsgatan", coord: [14.269915089000051, 57.763623099000029] }
  };
  const DEMO_LINE_ROUTES = {
    "15": {
      outStopIds: ["1422", "1229", "1228", "1419", "1413", "1414", "1415", "1420", "1412", "1018"],
      inStopIds: ["1018", "1412", "1420", "1415", "1414", "1413", "1419", "1228", "1229", "1422"]
    },
    "2": {
      outStopIds: ["2001", "2002", "2003", "1420"],
      inStopIds: ["1420", "2003", "2002", "2001"]
    }
  };

  const LINES = {
    "15": {
      lineShortName: "15",
      label: "15",
      stopNames: { a: "Lövhagsgatan", b: "Esplanaden" },
      headwayMinutes: 20,
      loopMinutes: 80,
      busCount: 4,
      preferGtfs: true,
      colors: ["#9ca3af", "#6b7280", "#4b5563", "#d1d5db"]
    },
    "2": {
      lineShortName: "2",
      label: "2",
      stopNames: { a: "Hisingsängens vändplan", b: "Oxhagsskolan" },
      headwayMinutes: 10,
      loopMinutes: 80,
      busCount: 4,
      preferGtfs: true,
      colors: ["#16a34a", "#22c55e", "#15803d", "#86efac"]
    }
  };

  const state = {
    lines: new Map(),
    widgetEl: null,
    raf: null,
    lastStatusUpdate: 0,
    startMs: 0,
    clickHandle: null
  };

  const gtfsStaticCache = {
    key: "",
    data: null,
    promise: null
  };

  function statusLine(lineState, text) {
    if (lineState.statusEl) lineState.statusEl.textContent = text;
  }

  function updateWidget() {
    if (!state.widgetEl) return;
    const parts = [];
    let total = 0;
    state.lines.forEach((line) => {
      if (!line.enabled) return;
      const cfg = line.config;
      total += cfg.busCount;
      parts.push(`Bus ${cfg.label}: Simulated (${cfg.busCount} buses, every ${cfg.headwayMinutes} min, ${cfg.loopMinutes} min loop)`);
    });
    if (parts.length) {
      parts.push(`Total buses: ${total}`);
    }
    state.widgetEl.innerHTML = parts.length ? parts.join("<br>") : "Bus simulation: av";
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\"") {
        if (inQuotes && text[i + 1] === "\"") {
          cur += "\"";
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        row.push(cur);
        cur = "";
      } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
        if (cur.length || row.length) {
          row.push(cur);
          rows.push(row);
          row = [];
          cur = "";
        }
      } else {
        cur += ch;
      }
    }
    if (cur.length || row.length) {
      row.push(cur);
      rows.push(row);
    }
    const headers = rows.shift() || [];
    return rows.map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = r[idx] ?? "";
      });
      return obj;
    });
  }

  function demoStopsFromIds(ids) {
    if (!Array.isArray(ids) || ids.length < 2) return [];
    return ids
      .map((id) => {
        const stop = DEMO_STOPS[String(id)];
        if (!stop) return null;
        return { id: String(id), name: stop.name, lon: stop.coord[0], lat: stop.coord[1] };
      })
      .filter(Boolean);
  }

  async function resolveRoadRoute(rawPoints, cacheKey) {
    if (!Array.isArray(rawPoints) || rawPoints.length < 2) return null;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length >= 2) return parsed;
      }
    } catch (_) {
      // ignore cache issues and continue
    }
    try {
      const coords = rawPoints.map((p) => `${Number(p[0])},${Number(p[1])}`).join(";");
      const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM ${res.status}`);
      const data = await res.json();
      const route = data?.routes?.[0]?.geometry?.coordinates;
      if (Array.isArray(route) && route.length >= 2) {
        try { localStorage.setItem(cacheKey, JSON.stringify(route)); } catch (_) {}
        return route;
      }
    } catch (err) {
      console.warn("Bus route OSRM fallback to stop polyline:", err);
    }
    return rawPoints;
  }

  async function buildDemoLineRoutes(lineShortName) {
    const def = DEMO_LINE_ROUTES[String(lineShortName)];
    if (!def) return null;
    const outStops = demoStopsFromIds(def.outStopIds);
    const inStops = demoStopsFromIds(def.inStopIds);
    if (outStops.length < 2 || inStops.length < 2) return null;
    const outRaw = outStops.map((s) => [s.lon, s.lat]);
    const inRaw = inStops.map((s) => [s.lon, s.lat]);
    const outRoute = await resolveRoadRoute(outRaw, `bus_demo_${lineShortName}_out_v4`);
    const inRoute = await resolveRoadRoute(inRaw, `bus_demo_${lineShortName}_in_v4`);
    if (!Array.isArray(outRoute) || outRoute.length < 2 || !Array.isArray(inRoute) || inRoute.length < 2) {
      return null;
    }
    return {
      out: { route: outRoute, stops: outStops },
      in: { route: inRoute, stops: inStops }
    };
  }

  function buildSampler(Polyline, webMercatorUtils, routePoints) {
    if (!routePoints || routePoints.length < 2) return null;
    const baseLine = new Polyline({
      paths: [routePoints],
      spatialReference: { wkid: 4326 }
    });
    const wmLine = webMercatorUtils.geographicToWebMercator(baseLine);
    if (!wmLine || !wmLine.paths || !wmLine.paths[0] || wmLine.paths[0].length < 2) return null;
    const path = wmLine.paths[0];
    const cum = [0];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i][0] - path[i - 1][0];
      const dy = path[i][1] - path[i - 1][1];
      const seg = Math.hypot(dx, dy);
      total += seg;
      cum[i] = total;
    }
    if (total <= 0) return null;
    const pointAt = (dist) => {
      if (dist <= 0) return path[0];
      if (dist >= total) return path[path.length - 1];
      let i = 1;
      while (i < cum.length && cum[i] < dist) i++;
      const prev = cum[i - 1];
      const segLen = cum[i] - prev;
      const t = segLen === 0 ? 0 : (dist - prev) / segLen;
      const p0 = path[i - 1];
      const p1 = path[i];
      return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    };
    const distanceAtPoint = (pt) => {
      if (!pt) return 0;
      let bestDist = 0;
      let bestSq = Infinity;
      for (let i = 1; i < path.length; i++) {
        const x1 = path[i - 1][0];
        const y1 = path[i - 1][1];
        const x2 = path[i][0];
        const y2 = path[i][1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        let t = 0;
        if (lenSq > 0) {
          t = ((pt[0] - x1) * dx + (pt[1] - y1) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
        }
        const projX = x1 + t * dx;
        const projY = y1 + t * dy;
        const sx = pt[0] - projX;
        const sy = pt[1] - projY;
        const sq = sx * sx + sy * sy;
        if (sq < bestSq) {
          bestSq = sq;
          bestDist = cum[i - 1] + Math.hypot(projX - x1, projY - y1);
        }
      }
      return bestDist;
    };
    return {
      kind: "webmercator",
      total,
      distanceAtPoint,
      toGeo: (dist) => {
        const pt = pointAt(dist);
        return webMercatorUtils.webMercatorToGeographic({
          type: "point",
          x: pt[0],
          y: pt[1],
          spatialReference: wmLine.spatialReference
        });
      }
    };
  }

  function haversineMeters(a, b) {
    if (!a || !b) return 0;
    const lon1 = Number(a[0]);
    const lat1 = Number(a[1]);
    const lon2 = Number(b[0]);
    const lat2 = Number(b[1]);
    if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) return 0;
    const R = 6371000;
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function routePairLooksValid(routes) {
    const outRoute = routes?.out?.route;
    const inRoute = routes?.in?.route;
    if (!Array.isArray(outRoute) || outRoute.length < 2 || !Array.isArray(inRoute) || inRoute.length < 2) {
      return false;
    }
    const outStart = outRoute[0];
    const outEnd = outRoute[outRoute.length - 1];
    const inStart = inRoute[0];
    const inEnd = inRoute[inRoute.length - 1];
    const joinOutToIn = haversineMeters(outEnd, inStart);
    const joinInToOut = haversineMeters(inEnd, outStart);
    return joinOutToIn <= GTFS_ROUTE_JOIN_MAX_METERS && joinInToOut <= GTFS_ROUTE_JOIN_MAX_METERS;
  }

  function buildGeoSampler(routePoints) {
    if (!routePoints || routePoints.length < 2) return null;
    const path = routePoints
      .map((p) => [Number(p[0]), Number(p[1])])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (path.length < 2) return null;
    const cum = [0];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      total += haversineMeters(path[i - 1], path[i]);
      cum[i] = total;
    }
    if (total <= 0) return null;
    const pointAt = (dist) => {
      if (dist <= 0) return path[0];
      if (dist >= total) return path[path.length - 1];
      let i = 1;
      while (i < cum.length && cum[i] < dist) i++;
      const prev = cum[i - 1];
      const segLen = cum[i] - prev;
      const t = segLen === 0 ? 0 : (dist - prev) / segLen;
      const p0 = path[i - 1];
      const p1 = path[i];
      return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    };
    const distanceAtPoint = (p) => {
      const lon = Number(Array.isArray(p) ? p[0] : (p?.longitude ?? p?.x));
      const lat = Number(Array.isArray(p) ? p[1] : (p?.latitude ?? p?.y));
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 0;
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < path.length; i++) {
        const d = haversineMeters([lon, lat], path[i]);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      return cum[bestI] || 0;
    };
    return {
      kind: "geographic",
      total,
      distanceAtPoint,
      toGeo: (dist) => {
        const p = pointAt(dist);
        return { type: "point", longitude: p[0], latitude: p[1], spatialReference: { wkid: 4326 } };
      }
    };
  }

  function distanceOnSampler(sampler, webMercatorUtils, lon, lat) {
    if (!sampler || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    if (sampler.kind === "geographic") {
      const d = sampler.distanceAtPoint([lon, lat]);
      return Number.isFinite(d) ? d : null;
    }
    const wm = webMercatorUtils.geographicToWebMercator({
      type: "point",
      longitude: lon,
      latitude: lat,
      spatialReference: { wkid: 4326 }
    });
    if (!wm || !Number.isFinite(wm.x) || !Number.isFinite(wm.y)) return null;
    const d = sampler.distanceAtPoint([wm.x, wm.y]);
    return Number.isFinite(d) ? d : null;
  }

  function normalizeLoopStopDistances(distances, loopLen) {
    if (!Array.isArray(distances) || !Number.isFinite(loopLen) || loopLen <= 0) return [];
    const normalized = distances
      .map((d) => Number(d))
      .filter((d) => Number.isFinite(d))
      .map((d) => {
        let v = d % loopLen;
        if (v < 0) v += loopLen;
        return v;
      })
      .sort((a, b) => a - b);
    if (normalized.length < 2) return [];
    const dedup = [];
    normalized.forEach((d) => {
      if (!dedup.length || Math.abs(d - dedup[dedup.length - 1]) > 1) dedup.push(d);
    });
    return dedup;
  }

  async function loadGtfsStaticTables({ JSZip, key }) {
    if (!key || !JSZip) return null;
    if (gtfsStaticCache.key === key && gtfsStaticCache.data) {
      return gtfsStaticCache.data;
    }
    if (gtfsStaticCache.key === key && gtfsStaticCache.promise) {
      return gtfsStaticCache.promise;
    }
    gtfsStaticCache.key = key;
    gtfsStaticCache.promise = (async () => {
      const url = `https://opendata.samtrafiken.se/gtfs/jlt/jlt.zip?key=${encodeURIComponent(key)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GTFS static HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const [routesText, tripsText, shapesText, stopsText, stopTimesText] = await Promise.all([
        zip.file("routes.txt").async("string"),
        zip.file("trips.txt").async("string"),
        zip.file("shapes.txt").async("string"),
        zip.file("stops.txt").async("string"),
        zip.file("stop_times.txt").async("string")
      ]);
      return {
        routes: parseCsv(routesText),
        trips: parseCsv(tripsText),
        shapes: parseCsv(shapesText),
        stops: parseCsv(stopsText),
        stopTimes: parseCsv(stopTimesText)
      };
    })();
    try {
      gtfsStaticCache.data = await gtfsStaticCache.promise;
      return gtfsStaticCache.data;
    } finally {
      gtfsStaticCache.promise = null;
    }
  }

  function readCachedGtfsShapes(cacheKey) {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed?.out?.route) || !Array.isArray(parsed?.in?.route)) return null;
      if (parsed.out.route.length < 2 || parsed.in.route.length < 2) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function writeCachedGtfsShapes(cacheKey, shapes) {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(shapes));
    } catch (_) {
      // ignore storage errors
    }
  }

  async function loadGtfsShapes({ JSZip, key, lineShortName, stopNames }) {
    const cacheKey = `gtfs_shapes_${String(lineShortName)}_${String(stopNames?.a || "")}_${String(stopNames?.b || "")}_v1`;
    const cachedShapes = readCachedGtfsShapes(cacheKey);
    if (cachedShapes) return cachedShapes;

    const tables = await loadGtfsStaticTables({ JSZip, key });
    if (!tables) return null;
    const { routes, trips, shapes, stops, stopTimes } = tables;

    const routeIds = new Set();
    routes.forEach((r) => {
      const shortName = String(r.route_short_name || "").trim().replace(/^0+/, "");
      if (shortName === lineShortName) routeIds.add(r.route_id);
    });
    if (!routeIds.size) return null;

    const stopById = new Map();
    stops.forEach((s) => {
      if (s.stop_id) stopById.set(s.stop_id, s);
    });

    const useStopFilter = !!(stopNames && stopNames.a && stopNames.b);
    let stopAIds = [];
    let stopBIds = [];
    if (useStopFilter) {
      const matchStopIds = (needle) => {
        const ids = [];
        stops.forEach((s) => {
          const name = String(s.stop_name || "").toLowerCase();
          if (name.includes(needle.toLowerCase())) ids.push(s.stop_id);
        });
        return ids;
      };
      stopAIds = matchStopIds(stopNames.a);
      stopBIds = matchStopIds(stopNames.b);
      if (!stopAIds.length || !stopBIds.length) return null;
    }

    const tripsById = new Map();
    trips.forEach((t) => {
      if (routeIds.has(t.route_id)) tripsById.set(t.trip_id, t);
    });
    if (!tripsById.size) return null;

    const tripsWithStops = new Map();
    stopTimes.forEach((st) => {
      if (!tripsById.has(st.trip_id)) return;
      const stopId = st.stop_id;
      if (!stopId) return;
      if (!tripsWithStops.has(st.trip_id)) tripsWithStops.set(st.trip_id, []);
      tripsWithStops.get(st.trip_id).push(st);
    });

    const shapeByDir = {};
    const stopSeqByDir = {};
    tripsWithStops.forEach((stopsForTrip, tripId) => {
      const trip = tripsById.get(tripId);
      const dir = trip?.direction_id != null ? String(trip.direction_id) : "0";
      if (useStopFilter) {
        const hasA = stopsForTrip.some((s) => stopAIds.includes(s.stop_id));
        const hasB = stopsForTrip.some((s) => stopBIds.includes(s.stop_id));
        if (!hasA || !hasB) return;
      }
      const shapeId = trip?.shape_id;
      if (!shapeId) return;
      const key = `${dir}:${shapeId}`;
      shapeByDir[key] = (shapeByDir[key] || 0) + 1;
      const ordered = stopsForTrip.slice().sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
      stopSeqByDir[key] = ordered.map((s) => {
        const stop = stopById.get(s.stop_id);
        return stop ? { id: s.stop_id, name: stop.stop_name, lat: Number(stop.stop_lat), lon: Number(stop.stop_lon) } : null;
      }).filter(Boolean);
    });

    const pickBest = (dir) => {
      const best = Object.entries(shapeByDir)
        .filter(([k]) => k.startsWith(dir + ":"))
        .sort((a, b) => b[1] - a[1])[0];
      if (!best) return null;
      const shapeId = best[0].split(":")[1];
      const stopSeq = stopSeqByDir[best[0]] || [];
      return { shapeId, stopSeq };
    };

    const dir0 = pickBest("0");
    const dir1 = pickBest("1");
    if (!dir0 || !dir1) return null;

    const shapesById = new Map();
    shapes.forEach((s) => {
      if (![dir0.shapeId, dir1.shapeId].includes(s.shape_id)) return;
      const lat = Number(s.shape_pt_lat);
      const lon = Number(s.shape_pt_lon);
      const seq = Number(s.shape_pt_sequence);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seq)) return;
      if (!shapesById.has(s.shape_id)) shapesById.set(s.shape_id, []);
      shapesById.get(s.shape_id).push({ lat, lon, seq });
    });

    const toRoute = (shapeId) => {
      const pts = (shapesById.get(shapeId) || []).sort((a, b) => a.seq - b.seq);
      if (pts.length < 2) return null;
      return pts.map((p) => [p.lon, p.lat]);
    };

    const result = {
      out: { route: toRoute(dir0.shapeId), stops: dir0.stopSeq },
      in: { route: toRoute(dir1.shapeId), stops: dir1.stopSeq }
    };
    if (!Array.isArray(result?.out?.route) || !Array.isArray(result?.in?.route)) return null;
    if (result.out.route.length < 2 || result.in.route.length < 2) return null;
    writeCachedGtfsShapes(cacheKey, result);
    return result;
  }

  function etaToNextStop(progress, stopCount, travelMinutes) {
    if (stopCount < 2) return null;
    const segCount = stopCount - 1;
    const segProgress = progress * segCount;
    const nextIdx = Math.min(stopCount - 1, Math.ceil(segProgress));
    const segmentTime = (travelMinutes * 60) / segCount;
    const eta = Math.max(0, (nextIdx - segProgress) * segmentTime);
    return { nextIdx, eta };
  }

  function updatePopup(view, graphic, info) {
    const vehicleId = info.vehicleId || ((info.line && info.busId) ? `${info.line}-${info.busId}` : (info.busId || "-"));
    view.popup.open({
      title: `Buss ${vehicleId}`,
      location: graphic.geometry,
      content: `
        <div><b>Buss-ID:</b> ${vehicleId}</div>
        <div><b>Linje:</b> ${info.line || "-"}</div>
        <div><b>Direction:</b> ${info.direction}</div>
        <div><b>Segment:</b> ${info.segment}</div>
        <div><b>Next stop:</b> ${info.nextStop} (${info.eta} min)</div>
        <div style="margin-top:6px;font-size:11px;color:#64748b;">Source: ${info.source}</div>
      `
    });
  }

  function createBusGraphic(Graphic, point, color) {
    return new Graphic({
      geometry: point,
      symbol: {
        type: "simple-marker",
        style: "circle",
        color,
        size: 11,
        outline: { color: [255, 255, 255, 0.95], width: 1.5 }
      }
    });
  }

  async function buildLineState(ctx, config, overrides = {}) {
    const opts = { ...DEFAULTS, ...config, ...overrides };
    const { map, GraphicsLayer, Polyline, webMercatorUtils } = ctx;

    const lineState = {
      config: opts,
      enabled: true,
      statusEl: null,
      layer: new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: BUS_GROUND_OFFSET_METERS } }),
      routeLayer: new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 2 }, visible: false }),
      routeLayer2: new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 2 }, visible: false }),
      samplers: { out: null, in: null, loop: null },
      stopSeq: { out: [], in: [] },
      loopStops: [],
      loopStopDistances: [],
      graphics: new Map()
    };

    map.addMany([lineState.routeLayer, lineState.routeLayer2, lineState.layer]);
    if (typeof map.reorder === "function") {
      map.reorder(lineState.layer, map.layers.length - 1);
    }

    let routes = null;
    const wantsGtfs = opts.preferGtfs !== false;
    const key = window.TRAFIKLAB_API_KEY || window.GTFS_STATIC_KEY || "";
    if (wantsGtfs && key && window.JSZip) {
      try {
        routes = await loadGtfsShapes({
          JSZip: window.JSZip,
          key,
          lineShortName: opts.lineShortName,
          stopNames: opts.stopNames
        });
        if (!routes || !routePairLooksValid(routes)) {
          if (routes) {
            console.warn(`Bus ${opts.label}: GTFS shapes invalid pair, using local route fallback`);
          }
          routes = null;
        }
      } catch (e) {
        routes = null;
      }
    }

    if (!routes || !routes.out?.route || !routes.in?.route) {
      routes = await buildDemoLineRoutes(opts.lineShortName);
      if (routes?.out?.route?.length >= 2 && routes?.in?.route?.length >= 2) {
        statusLine(lineState, `Bus ${opts.label}: Simulating (lokal låst rutt)`);
      } else {
        const points = HARD_FALLBACK_LOOP.slice();
        statusLine(lineState, `Bus ${opts.label}: Simulating (hard fallback route)`);
        const mid = Math.max(2, Math.floor(points.length / 2));
        routes = {
          out: { route: points.slice(0, mid), stops: [] },
          in: { route: points.slice(mid).concat(points[0]), stops: [] }
        };
        if (routes.out.route.length < 2 || routes.in.route.length < 2) return null;
      }
    } else {
      statusLine(lineState, `Bus ${opts.label}: Simulating from timetable (GTFS shapes)`);
    }

    const outLine = new Polyline({ paths: [routes.out.route], spatialReference: { wkid: 4326 } });
    const inLine = new Polyline({ paths: [routes.in.route], spatialReference: { wkid: 4326 } });
    lineState.routeLayer.visible = false;
    lineState.routeLayer2.visible = false;

    lineState.samplers.out = buildSampler(Polyline, webMercatorUtils, routes.out.route) || buildGeoSampler(routes.out.route);
    lineState.samplers.in = buildSampler(Polyline, webMercatorUtils, routes.in.route) || buildGeoSampler(routes.in.route);
    const loopRoute = routes.out.route.concat(routes.in.route.slice(1));
    lineState.samplers.loop = buildSampler(Polyline, webMercatorUtils, loopRoute) || buildGeoSampler(loopRoute);
    lineState.stopSeq.out = routes.out.stops || [];
    lineState.stopSeq.in = routes.in.stops || [];
    lineState.loopStops = lineState.stopSeq.out.concat(lineState.stopSeq.in.slice(1));

    if (lineState.samplers.loop && lineState.loopStops.length) {
      const rawStopDistances = lineState.loopStops
        .map((s) => distanceOnSampler(lineState.samplers.loop, webMercatorUtils, Number(s.lon), Number(s.lat)))
        .filter((d) => Number.isFinite(d));
      lineState.loopStopDistances = normalizeLoopStopDistances(rawStopDistances, lineState.samplers.loop.total);
    }

    return lineState;
  }

  function buildBusList(config) {
    const ids = ["A", "B", "C", "D", "E", "F", "G"];
    const offsets = [];
    const loopMs = Math.max(1, config.loopMinutes * 60 * 1000);
    const desiredHeadwayMs = Math.max(1, config.headwayMinutes * 60 * 1000);
    const effectiveHeadwayMs = (desiredHeadwayMs * config.busCount > loopMs)
      ? (loopMs / Math.max(1, config.busCount))
      : desiredHeadwayMs;
    for (let i = 0; i < config.busCount; i++) {
      offsets.push(i * effectiveHeadwayMs);
    }
    return offsets.map((offsetMs, idx) => ({
      id: ids[idx] || String(idx + 1),
      vehicleId: `${config.label}-${ids[idx] || String(idx + 1)}`,
      color: config.colors[idx % config.colors.length],
      offsetMs
    }));
  }

  function updateLine(ctx, lineState, now) {
    if (!lineState.enabled) return;
    const { Graphic } = ctx;
    const { config } = lineState;
    const loopSampler = lineState.samplers.loop;
    const outSampler = lineState.samplers.out;
    const inSampler = lineState.samplers.in;
    if (!loopSampler || !outSampler || !inSampler) {
      console.warn(`Bus ${config.label}: missing route sampler`);
      return;
    }
    const loopMs = config.loopMinutes * 60 * 1000;
    const loopLen = loopSampler.total;
    const outLen = outSampler.total;
    const inLen = inSampler.total;
    const stopDistances = lineState.loopStopDistances || [];
    const stopCount = stopDistances.length;
    const travelMs = Math.max(0, loopMs - DEFAULTS.dwellMs * stopCount);
    const buses = buildBusList(config);

    buses.forEach((bus) => {
      const simNow = (now - state.startMs) * BUS_SIM_SPEED_MULTIPLIER;
      const t = ((simNow - bus.offsetMs) % loopMs + loopMs) % loopMs;
      let dist = 0;
      if (stopCount >= 2 && travelMs > 0) {
        let remaining = t;
        for (let i = 0; i < stopCount; i++) {
          const cur = stopDistances[i];
          const next = stopDistances[(i + 1) % stopCount];
          const segLen = i === stopCount - 1 ? (loopLen - cur + next) : (next - cur);
          const segMs = segLen / loopLen * travelMs;
          if (remaining <= DEFAULTS.dwellMs) {
            dist = cur;
            remaining = 0;
            break;
          }
          remaining -= DEFAULTS.dwellMs;
          if (remaining <= segMs) {
            const frac = segMs === 0 ? 0 : remaining / segMs;
            dist = cur + segLen * frac;
            if (dist > loopLen) dist -= loopLen;
            remaining = 0;
            break;
          }
          remaining -= segMs;
        }
      } else {
        dist = (t / loopMs) * loopLen;
      }

      const pt = loopSampler.toGeo(dist);
      if (!pt) return;
      const outbound = dist <= outLen;
      const dirKey = outbound ? "out" : "in";
      const dirName = outbound ? "Outbound" : "Inbound";
      const dirProgress = outbound ? dist / outLen : (dist - outLen) / inLen;
      const seq = lineState.stopSeq[dirKey] || [];
      const eta = etaToNextStop(dirProgress, seq.length, config.loopMinutes / 2);
      const nextStop = eta && seq[eta.nextIdx] ? seq[eta.nextIdx].name : "Okänd";
      const segment = eta && seq[eta.nextIdx - 1] && seq[eta.nextIdx]
        ? `${seq[eta.nextIdx - 1].name} → ${seq[eta.nextIdx].name}`
        : "Okänd";

      let g = lineState.graphics.get(bus.id);
      if (!g) {
        g = createBusGraphic(Graphic, pt, bus.color);
        lineState.graphics.set(bus.id, g);
        lineState.layer.add(g);
      } else {
        g.geometry = pt;
      }
      g.attributes = {
        line: config.label,
        direction: dirName,
        nextStop,
        segment,
        eta: eta ? Math.max(1, Math.round(eta.eta / 60)) : "?",
        source: "Simulated",
        busId: bus.id,
        vehicleId: bus.vehicleId
      };
    });
  }

  async function initBus15Layer(ctx, options = {}) {
    if (!ctx || !ctx.map) return false;
    if (state.lines.size) return true;
    state.widgetEl = document.getElementById("bus15Widget");
    state.startMs = Date.now();

    const lineOverrides = options.lines || {};
    const lineKeys = Object.keys(LINES);
    for (const key of lineKeys) {
      const config = { ...LINES[key], ...(lineOverrides[key] || {}) };
      let lineState = null;
      try {
        lineState = await buildLineState(ctx, config, {});
      } catch (e) {
        console.warn(`Bus ${config.label}: init failed`, e);
      }
      if (!lineState) continue;
      state.lines.set(key, lineState);
    }

    if (!state.lines.size) {
      console.warn("Bus live init: no lines created, will allow retry");
      return false;
    }

    const line15 = state.lines.get("15");
    if (line15) line15.statusEl = document.getElementById("bus15Status");
    const line2 = state.lines.get("2");
    if (line2) line2.statusEl = document.getElementById("bus2Status");

    const toggle15 = document.getElementById("swBus15Live");
    if (toggle15 && line15) {
      toggle15.checked = true;
      line15.enabled = true;
      line15.layer.visible = true;
      toggle15.addEventListener("change", () => {
        line15.enabled = toggle15.checked;
        line15.layer.visible = line15.enabled;
        updateWidget();
      });
    }

    const toggle2 = document.getElementById("swBus2Live");
    if (toggle2 && line2) {
      toggle2.checked = true;
      line2.enabled = true;
      line2.layer.visible = true;
      toggle2.addEventListener("change", () => {
        line2.enabled = toggle2.checked;
        line2.layer.visible = line2.enabled;
        updateWidget();
      });
    }

    if (!state.clickHandle) {
      state.clickHandle = ctx.view.on("immediate-click", (event) => {
        const busLayers = [...state.lines.values()].map((line) => line.layer).filter(Boolean);
        if (!busLayers.length) return;
        ctx.view.hitTest(event, { include: busLayers }).then((hit) => {
          const result = hit.results.find((r) => r?.graphic && busLayers.includes(r.graphic.layer));
          if (!result || !result.graphic) return;
          const g = result.graphic;
          const info = g.attributes || {};
          // Force popup refresh so repeated clicks on the same bus always respond.
          if (ctx.view.popup?.visible && ctx.view.popup?.selectedFeature === g) {
            ctx.view.popup.close();
          }
          updatePopup(ctx.view, g, info);
        }).catch(() => {
          // ignore hit-test race errors
        });
      });
    }

    const tick = () => {
      const now = Date.now();
      state.lines.forEach((lineState) => updateLine(ctx, lineState, now));
      state.lines.forEach((lineState) => {
        if (typeof ctx.map?.reorder === "function") {
          ctx.map.reorder(lineState.layer, ctx.map.layers.length - 1);
        }
      });
      if (now - state.lastStatusUpdate > 1000) {
        state.lastStatusUpdate = now;
        updateWidget();
      }
      state.raf = requestAnimationFrame(tick);
    };
    if (!state.raf) tick();
    return true;
  }

  window.initBus15Layer = initBus15Layer;
  if (window.__pendingBus15InitCtx && !window.__bus15InitDone) {
    Promise.resolve(window.initBus15Layer(window.__pendingBus15InitCtx)).then((ok) => {
      if (ok === false) return;
      window.__bus15InitDone = true;
      window.__pendingBus15InitCtx = null;
    }).catch((err) => {
      console.warn("Deferred bus init failed", err);
    });
  }
})();
