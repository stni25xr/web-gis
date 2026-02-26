(() => {
  const DEFAULTS = {
    updateMs: 5000,
    dwellMs: 5000
  };

  const LINES = {
    "15": {
      lineShortName: "15",
      label: "15",
      stopNames: { a: "Öxnehaga", b: "Esplanaden" },
      headwayMinutes: 10,
      loopMinutes: 30,
      busCount: 3,
      colors: ["#ff6b00", "#10b981", "#2563eb"]
    },
    "2": {
      lineShortName: "2",
      label: "2",
      stopNames: null,
      headwayMinutes: 10,
      loopMinutes: 30,
      busCount: 4,
      colors: ["#f97316", "#14b8a6", "#8b5cf6", "#0ea5e9"]
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

  function statusLine(lineState, text) {
    if (lineState.statusEl) lineState.statusEl.textContent = text;
  }

  function updateWidget() {
    if (!state.widgetEl) return;
    const parts = [];
    state.lines.forEach((line) => {
      if (!line.enabled) return;
      const cfg = line.config;
      parts.push(`Bus ${cfg.label}: Simulated (${cfg.busCount} buses, every ${cfg.headwayMinutes} min, ${cfg.loopMinutes} min loop)`);
    });
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

  async function loadGtfsShapes({ JSZip, key, lineShortName, stopNames }) {
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
    const routes = parseCsv(routesText);
    const trips = parseCsv(tripsText);
    const shapes = parseCsv(shapesText);
    const stops = parseCsv(stopsText);
    const stopTimes = parseCsv(stopTimesText);

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

    return {
      out: { route: toRoute(dir0.shapeId), stops: dir0.stopSeq },
      in: { route: toRoute(dir1.shapeId), stops: dir1.stopSeq }
    };
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
    view.popup.open({
      title: `Line ${info.line || ""}`,
      location: graphic.geometry,
      content: `
        <div><b>Bus:</b> ${info.busId || "-"}</div>
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
        type: "point-3d",
        symbolLayers: [{
          type: "icon",
          resource: { primitive: "circle" },
          size: 10,
          material: { color }
        }]
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
      layer: new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 6 } }),
      routeLayer: new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 2 }, visible: false }),
      routeLayer2: new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 2 }, visible: false }),
      samplers: { out: null, in: null, loop: null },
      stopSeq: { out: [], in: [] },
      loopStops: [],
      loopStopDistances: [],
      graphics: new Map()
    };

    map.addMany([lineState.routeLayer, lineState.routeLayer2, lineState.layer]);

    const key = window.TRAFIKLAB_API_KEY || window.GTFS_STATIC_KEY || "";
    let routes = null;
    if (key && window.JSZip) {
      try {
        routes = await loadGtfsShapes({
          JSZip: window.JSZip,
          key,
          lineShortName: opts.lineShortName,
          stopNames: opts.stopNames
        });
      } catch (e) {
        routes = null;
      }
    }

    if (!routes || !routes.out?.route || !routes.in?.route) {
      statusLine(lineState, `Bus ${opts.label}: Simulating (fallback route)`);
      const res = await ctx.busLayer.queryFeatures({ where: "1=1", outFields: ["Nr", "Hplnamn"], returnGeometry: true });
      const feats = res.features || [];
      const points = feats
        .map((f) => {
          const lon = f.geometry?.longitude ?? f.geometry?.x;
          const lat = f.geometry?.latitude ?? f.geometry?.y;
          return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
        })
        .filter(Boolean);
      if (points.length < 4) {
        statusLine(lineState, `Bus ${opts.label}: Simulating (no route data)`);
        return null;
      }
      const mid = Math.floor(points.length / 2);
      routes = {
        out: { route: points.slice(0, mid), stops: [] },
        in: { route: points.slice(mid).concat(points[0]), stops: [] }
      };
    } else {
      statusLine(lineState, `Bus ${opts.label}: Simulating from timetable (GTFS shapes)`);
    }

    const outLine = new Polyline({ paths: [routes.out.route], spatialReference: { wkid: 4326 } });
    const inLine = new Polyline({ paths: [routes.in.route], spatialReference: { wkid: 4326 } });
    lineState.routeLayer.visible = false;
    lineState.routeLayer2.visible = false;

    lineState.samplers.out = buildSampler(Polyline, webMercatorUtils, routes.out.route);
    lineState.samplers.in = buildSampler(Polyline, webMercatorUtils, routes.in.route);
    const loopRoute = routes.out.route.concat(routes.in.route.slice(1));
    lineState.samplers.loop = buildSampler(Polyline, webMercatorUtils, loopRoute);
    lineState.stopSeq.out = routes.out.stops || [];
    lineState.stopSeq.in = routes.in.stops || [];
    lineState.loopStops = lineState.stopSeq.out.concat(lineState.stopSeq.in.slice(1));

    if (lineState.samplers.loop && lineState.loopStops.length) {
      const wmStops = lineState.loopStops
        .map((s) => {
          if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) return null;
          const wm = webMercatorUtils.geographicToWebMercator({
            type: "point",
            longitude: s.lon,
            latitude: s.lat,
            spatialReference: { wkid: 4326 }
          });
          return wm ? [wm.x, wm.y] : null;
        })
        .filter(Boolean);
      lineState.loopStopDistances = wmStops.map((p) => lineState.samplers.loop.distanceAtPoint(p));
    }

    return lineState;
  }

  function buildBusList(config) {
    const ids = ["A", "B", "C", "D", "E", "F", "G"];
    const offsets = [];
    for (let i = 0; i < config.busCount; i++) {
      offsets.push(i * config.headwayMinutes * 60 * 1000);
    }
    return offsets.map((offsetMs, idx) => ({
      id: ids[idx] || String(idx + 1),
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
      const t = ((now - state.startMs - bus.offsetMs) % loopMs + loopMs) % loopMs;
      let dist = 0;
      if (stopCount >= 2) {
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
        busId: bus.id
      };
    });
  }

  async function initBus15Layer(ctx, options = {}) {
    if (!ctx || !ctx.map) return;
    state.widgetEl = document.getElementById("bus15Widget");
    state.startMs = Date.now();

    const lineOverrides = options.lines || {};
    const lineKeys = Object.keys(LINES);
    for (const key of lineKeys) {
      const config = { ...LINES[key], ...(lineOverrides[key] || {}) };
      const lineState = await buildLineState(ctx, config, {});
      if (!lineState) continue;
      state.lines.set(key, lineState);
    }

    const line15 = state.lines.get("15");
    if (line15) line15.statusEl = document.getElementById("bus15Status");
    const line2 = state.lines.get("2");
    if (line2) line2.statusEl = document.getElementById("bus2Status");

    const toggle15 = document.getElementById("swBus15Live");
    if (toggle15 && line15) {
      line15.enabled = toggle15.checked;
      line15.layer.visible = line15.enabled;
      toggle15.addEventListener("change", () => {
        line15.enabled = toggle15.checked;
        line15.layer.visible = line15.enabled;
        updateWidget();
      });
    }

    const toggle2 = document.getElementById("swBus2Live");
    if (toggle2 && line2) {
      line2.enabled = toggle2.checked;
      line2.layer.visible = line2.enabled;
      toggle2.addEventListener("change", () => {
        line2.enabled = toggle2.checked;
        line2.layer.visible = line2.enabled;
        updateWidget();
      });
    }

    if (!state.clickHandle) {
      state.clickHandle = ctx.view.on("click", (event) => {
        ctx.view.hitTest(event).then((hit) => {
          const result = hit.results.find((r) => {
            return r.graphic && [...state.lines.values()].some((line) => r.graphic.layer === line.layer);
          });
          if (!result) return;
          const g = result.graphic;
          const info = g.attributes || {};
          updatePopup(ctx.view, g, info);
        });
      });
    }

    const tick = () => {
      const now = Date.now();
      state.lines.forEach((lineState) => updateLine(ctx, lineState, now));
      if (now - state.lastStatusUpdate > 1000) {
        state.lastStatusUpdate = now;
        updateWidget();
      }
      state.raf = requestAnimationFrame(tick);
    };
    if (!state.raf) tick();
  }

  window.initBus15Layer = initBus15Layer;
})();
