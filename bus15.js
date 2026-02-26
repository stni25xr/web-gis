(() => {
  const DEFAULTS = {
    lineShortName: "15",
    stopNames: {
      a: "Öxnehaga",
      b: "Esplanaden"
    },
    serviceStartHour: 5,
    serviceEndHour: 23,
    headwayMinutes: 60,
    travelMinutes: 23,
    layoverMinutes: 3,
    updateMs: 5000
  };

  const state = {
    enabled: true,
    mode: "simulated",
    lastRealtimeOk: false,
    realtimeTimer: null,
    simTimer: null,
    raf: null,
    lastUpdate: 0,
    samplers: { out: null, in: null },
    stopSeq: { out: [], in: [] },
    buses: new Map(),
    layer: null,
    routeLayer: null,
    routeLayer2: null,
    statusEl: null,
    widgetEl: null,
    movingOffsets: new Map(),
    lastTick: 0
  };

  function status(text) {
    if (state.statusEl) state.statusEl.textContent = text;
    if (state.widgetEl) state.widgetEl.textContent = text;
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
    return {
      total,
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

    const matchStopIds = (needle) => {
      const ids = [];
      stops.forEach((s) => {
        const name = String(s.stop_name || "").toLowerCase();
        if (name.includes(needle.toLowerCase())) ids.push(s.stop_id);
      });
      return ids;
    };
    const stopAIds = matchStopIds(stopNames.a);
    const stopBIds = matchStopIds(stopNames.b);
    if (!stopAIds.length || !stopBIds.length) return null;

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
      const hasA = stopsForTrip.some((s) => stopAIds.includes(s.stop_id));
      const hasB = stopsForTrip.some((s) => stopBIds.includes(s.stop_id));
      if (!hasA || !hasB) return;
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

  function buildDepartures(now, opts) {
    const list = [];
    const start = new Date(now);
    start.setHours(opts.serviceStartHour, 0, 0, 0);
    const end = new Date(now);
    end.setHours(opts.serviceEndHour, 59, 0, 0);
    const headwayMs = opts.headwayMinutes * 60 * 1000;
    for (let t = start.getTime(); t <= end.getTime(); t += headwayMs) {
      list.push(new Date(t));
    }
    return list;
  }

  function computeSimulatedBuses(now, opts, direction, departures) {
    const travelMs = opts.travelMinutes * 60 * 1000;
    const active = departures
      .map((d) => ({ dep: d, elapsed: now - d.getTime() }))
      .filter((x) => x.elapsed >= 0 && x.elapsed <= travelMs);
    if (active.length) return active;
    return [{ dep: new Date(now - travelMs / 2), elapsed: travelMs / 2 }];
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
      title: "Line 15",
      location: graphic.geometry,
      content: `
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

  async function initBus15Layer(ctx, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const { map, view, GraphicsLayer, Graphic, Polyline, webMercatorUtils } = ctx;
    state.statusEl = document.getElementById("bus15Status");
    state.widgetEl = document.getElementById("bus15Widget");

    state.layer = new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 6 } });
    state.routeLayer = new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 2 }, visible: false });
    state.routeLayer2 = new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 2 }, visible: false });
    map.addMany([state.routeLayer, state.routeLayer2, state.layer]);

    const key = window.TRAFIKLAB_API_KEY || window.GTFS_STATIC_KEY || "";
    let routes = null;
    if (key && window.JSZip) {
      try {
        routes = await loadGtfsShapes({ JSZip: window.JSZip, key, lineShortName: opts.lineShortName, stopNames: opts.stopNames });
      } catch (e) {
        routes = null;
      }
    }
    if (!routes || !routes.out?.route || !routes.in?.route) {
      status("Bus 15: Simulating from timetable (fallback route)");
      // Fallback: build a simple loop from local bus stop points
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
        status("Bus 15: Simulating (no route data)");
        return;
      }
      // split into two directions by simple half split
      const mid = Math.floor(points.length / 2);
      routes = {
        out: { route: points.slice(0, mid), stops: [] },
        in: { route: points.slice(mid).concat(points[0]), stops: [] }
      };
    } else {
      status("Bus 15: Simulating from timetable (GTFS shapes)");
    }

    const outLine = new Polyline({ paths: [routes.out.route], spatialReference: { wkid: 4326 } });
    const inLine = new Polyline({ paths: [routes.in.route], spatialReference: { wkid: 4326 } });
    // Keep route layers hidden (no visible line)
    state.routeLayer.visible = false;
    state.routeLayer2.visible = false;

    state.samplers.out = buildSampler(Polyline, webMercatorUtils, routes.out.route);
    state.samplers.in = buildSampler(Polyline, webMercatorUtils, routes.in.route);
    state.stopSeq.out = routes.out.stops || [];
    state.stopSeq.in = routes.in.stops || [];

    const toggle = document.getElementById("swBus15Live");
    if (toggle) {
      toggle.addEventListener("change", () => {
        state.enabled = toggle.checked;
        state.layer.visible = state.enabled;
      });
    }

    view.on("click", (event) => {
      if (!state.enabled) return;
      view.hitTest(event).then((hit) => {
        const result = hit.results.find((r) => r.graphic && r.graphic.layer === state.layer);
        if (!result) return;
        const g = result.graphic;
        const info = g.attributes || {};
        updatePopup(view, g, info);
      });
    });

    const departures = buildDepartures(new Date(), opts);
    state.lastUpdate = Date.now();
    state.mode = "Simulated";

    const tick = () => {
      if (!state.enabled) {
        state.raf = requestAnimationFrame(tick);
        return;
      }
      const now = Date.now();
      if (now - state.lastUpdate >= opts.updateMs) {
        state.lastUpdate = now;
      }
      state.layer.removeAll();
      let count = 0;

      const directions = [
        { key: "out", name: "Outbound", color: "#ff6b00" },
        { key: "in", name: "Inbound", color: "#10b981" }
      ];
      const travelSec = opts.travelMinutes * 60;
      const headwaySec = opts.headwayMinutes * 60;
      const perDirCount = Math.max(1, Math.round((travelSec + opts.layoverMinutes * 60) / headwaySec));
      const dt = Math.max(0.5, (now - state.lastTick) / 1000);
      state.lastTick = now;

      directions.forEach((dir) => {
        const sampler = state.samplers[dir.key];
        if (!sampler) return;
        const speed = (sampler.total / travelSec) * 6;
        for (let i = 0; i < perDirCount; i++) {
          const id = `${dir.key}-${i}`;
          let offset = state.movingOffsets.get(id);
          if (offset == null) {
            offset = (i / perDirCount) * sampler.total;
          }
          offset = (offset + speed * dt) % sampler.total;
          state.movingOffsets.set(id, offset);
          const progress = offset / sampler.total;
          const pt = sampler.toGeo(offset);
          if (!pt) continue;
          const seq = state.stopSeq[dir.key] || [];
          const eta = etaToNextStop(progress, seq.length, opts.travelMinutes);
          const nextStop = eta && seq[eta.nextIdx] ? seq[eta.nextIdx].name : "Okänd";
          const segment = eta && seq[eta.nextIdx - 1] && seq[eta.nextIdx]
            ? `${seq[eta.nextIdx - 1].name} → ${seq[eta.nextIdx].name}`
            : "Okänd";
          const g = createBusGraphic(Graphic, pt, dir.color);
          g.attributes = {
            direction: dir.name,
            nextStop,
            segment,
            eta: eta ? Math.max(1, Math.round(eta.eta / 60)) : "?",
            source: state.mode
          };
          state.layer.add(g);
          count += 1;
        }
      });

      status(`Bus 15: Simulating from timetable (no realtime feed) • ${count} buses`);
      state.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  window.initBus15Layer = initBus15Layer;
})();
