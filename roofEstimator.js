window.initRoofEstimator = function initRoofEstimator(options) {
  const {
    view,
    buildingLayer,
    oxLayer,
    GraphicsLayer,
    Graphic,
    geometryEngine,
    webMercatorUtils,
    Polyline
  } = options || {};

  if (!view || !buildingLayer || !GraphicsLayer || !Graphic || !geometryEngine || !Polyline) {
    console.warn("Roof estimator init missing dependencies.");
    return;
  }

  const state = {
    selected: null,
    byId: new Map(),
    shadowStart: null,
    measureHandle: null
  };

  const highlightLayer = new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 0 } });
  const shadowLayer = new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 0 } });
  const labelLayer = new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 0 } });
  view.map.addMany([highlightLayer, shadowLayer, labelLayer]);

  const elInput = document.getElementById("roofObjektId");
  const elFetchBtn = document.getElementById("roofFetchBtn");
  const elError = document.getElementById("roofFetchError");
  const elSummary = document.getElementById("roofSelectedSummary");
  const elSolar = document.getElementById("roofSolarElevation");
  const elRoofType = document.getElementById("roofType");
  const elShadowBtn = document.getElementById("roofShadowBtn");
  const elComputeBtn = document.getElementById("roofComputeBtn");
  const elResult = document.getElementById("roofResult");
  const elExportBtn = document.getElementById("roofExportBtn");
  const elExportStatus = document.getElementById("roofExportStatus");

  function setError(msg) {
    if (elError) elError.textContent = msg || "";
  }

  function setResult(html) {
    if (elResult) elResult.innerHTML = html || "";
  }

  function updateSummary() {
    if (!elSummary) return;
    if (!state.selected) {
      elSummary.textContent = "Ingen byggnad vald.";
      return;
    }
    const attrs = state.selected.feature?.attributes || {};
    const parts = [
      `objektidentitet: ${attrs.objektidentitet || state.selected.objektidentitet || "-"}`,
      `objekttyp: ${attrs.objekttyp || "-"}`
    ];
    elSummary.textContent = parts.join(" · ");
  }

  function escapeSql(value) {
    return String(value || "").replace(/'/g, "''");
  }

  function findObjektidentitetField(layer) {
    const fields = layer.fields || [];
    return fields.find((f) => f.name === "objektidentitet")
      || fields.find((f) => (f.name || "").toLowerCase() === "objektidentitet")
      || null;
  }

  async function fetchBuildingByObjektidentitet(id) {
    const field = findObjektidentitetField(buildingLayer);
    if (!field) {
      console.warn("Building layer missing objektidentitet field.");
      setError("Lagret saknar fältet objektidentitet.");
      return null;
    }
    const safe = escapeSql(id);
    const res = await buildingLayer.queryFeatures({
      where: `${field.name} = '${safe}'`,
      outFields: ["*"],
      returnGeometry: true
    });
    const feature = res?.features?.[0] || null;
    if (!feature) {
      setError("Hittar ingen byggnad med denna objektidentitet.");
      return null;
    }
    return feature;
  }

  function highlightFeature(feature) {
    highlightLayer.removeAll();
    if (!feature?.geometry) return;
    highlightLayer.add(new Graphic({
      geometry: feature.geometry,
      symbol: {
        type: "simple-fill",
        color: [0, 0, 0, 0],
        outline: { color: [59, 130, 246, 0.9], width: 2 }
      }
    }));
  }

  function clearShadowMeasure() {
    shadowLayer.removeAll();
    state.shadowStart = null;
    if (state.measureHandle) {
      state.measureHandle.remove();
      state.measureHandle = null;
    }
  }

  function startShadowMeasure() {
    if (!state.selected?.feature) {
      setError("Välj byggnad först.");
      return;
    }
    setError("");
    clearShadowMeasure();
    if (elShadowBtn) elShadowBtn.textContent = "Klicka två punkter…";
    state.measureHandle = view.on("click", (evt) => {
      const mapPoint = evt.mapPoint;
      if (!mapPoint) return;
      if (!state.shadowStart) {
        state.shadowStart = mapPoint;
        shadowLayer.add(new Graphic({
          geometry: mapPoint,
          symbol: { type: "simple-marker", color: [59, 130, 246], size: 6 }
        }));
        return;
      }
      const line = new Polyline({
        paths: [[[state.shadowStart.x, state.shadowStart.y], [mapPoint.x, mapPoint.y]]],
        spatialReference: mapPoint.spatialReference
      });
      const len = geometryEngine.geodesicLength(line, "meters");
      shadowLayer.removeAll();
      shadowLayer.add(new Graphic({
        geometry: line,
        symbol: { type: "simple-line", color: [59, 130, 246, 0.9], width: 2 }
      }));
      state.shadowStart = null;
      if (state.measureHandle) {
        state.measureHandle.remove();
        state.measureHandle = null;
      }
      if (elShadowBtn) elShadowBtn.textContent = "Mät skugga";
      const id = state.selected.objektidentitet;
      const entry = state.byId.get(id) || {};
      entry.shadowLength_m = Number.isFinite(len) ? len : null;
      entry.measuredAt = new Date().toISOString();
      state.byId.set(id, entry);
      setResult(`Skugglängd: ${entry.shadowLength_m?.toFixed(2) || "-"} m`);
    });
  }

  function getSpanMeters(geometry) {
    const extent = geometry?.extent;
    if (!extent) return null;
    const sr = geometry.spatialReference;
    const widthLine = new Polyline({
      paths: [[[extent.xmin, extent.ymin], [extent.xmax, extent.ymin]]],
      spatialReference: sr
    });
    const heightLine = new Polyline({
      paths: [[[extent.xmin, extent.ymin], [extent.xmin, extent.ymax]]],
      spatialReference: sr
    });
    const w = geometryEngine.geodesicLength(widthLine, "meters");
    const h = geometryEngine.geodesicLength(heightLine, "meters");
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    return Math.max(w, h);
  }

  function addResultLabel(text, geometry) {
    labelLayer.removeAll();
    if (!geometry || !text) return;
    let center = geometry.extent?.center || null;
    if (geometryEngine?.centroid) {
      try { center = geometryEngine.centroid(geometry); } catch (e) { /* ignore */ }
    }
    if (!center) return;
    labelLayer.add(new Graphic({
      geometry: center,
      symbol: {
        type: "text",
        text,
        color: "#f59e0b",
        haloColor: "#0f172a",
        haloSize: 1,
        font: { size: 12, weight: "bold" }
      }
    }));
  }

  function computePitch() {
    if (!state.selected?.feature) {
      setError("Välj byggnad först.");
      return;
    }
    const id = state.selected.objektidentitet;
    const entry = state.byId.get(id) || {};
    const shadow = entry.shadowLength_m;
    if (!Number.isFinite(shadow)) {
      setError("Mät skugga först.");
      return;
    }
    const solarDeg = Number(elSolar?.value || 0);
    if (!Number.isFinite(solarDeg) || solarDeg <= 0) {
      setError("Ange giltig solhöjd.");
      return;
    }
    const roofType = elRoofType?.value || "Sadeltak";
    const geom = state.selected.feature.geometry;
    const span = getSpanMeters(geom);
    const height = Math.tan((solarDeg * Math.PI) / 180) * shadow;
    const eavesHeight = 0;
    const pitch = span ? Math.atan2(height, span / 2) * (180 / Math.PI) : null;
    const nowIso = new Date().toISOString();
    Object.assign(entry, {
      roofType,
      pitch_deg: Number.isFinite(pitch) ? pitch : null,
      solarElevation_deg: solarDeg,
      shadowLength_m: shadow,
      estimatedHeight_m: height,
      eavesHeight_m: eavesHeight,
      computedAt: nowIso
    });
    state.byId.set(id, entry);
    const pitchText = Number.isFinite(entry.pitch_deg) ? entry.pitch_deg.toFixed(1) : "-";
    setResult(
      `Takvinkel: ${pitchText}°` +
      `<br>Solhöjd: ${solarDeg.toFixed(1)}°` +
      `<br>Skugglängd: ${shadow.toFixed(2)} m` +
      `<br>Höjd (est.): ${height.toFixed(2)} m`
    );
    addResultLabel(`${pitchText}°`, geom);
    setError("");
  }

  async function getOxnehagaGeometry() {
    if (!oxLayer) return null;
    const res = await oxLayer.queryFeatures({
      where: "1=1",
      outFields: ["*"],
      returnGeometry: true
    });
    const geom = res?.features?.[0]?.geometry || null;
    if (!geom || !webMercatorUtils) return geom;
    const target = buildingLayer.spatialReference;
    if (!target || !geom.spatialReference) return geom;
    const gsr = geom.spatialReference;
    if (gsr.isWGS84 && target.isWebMercator) return webMercatorUtils.geographicToWebMercator(geom);
    if (gsr.isWebMercator && target.isWGS84) return webMercatorUtils.webMercatorToGeographic(geom);
    return geom;
  }

  function toCSV(rows) {
    const escapeCell = (value) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (/[\";\n\r]/.test(str)) {
        return `"${str.replace(/\"/g, "\"\"")}"`;
      }
      return str;
    };
    return rows.map((row) => row.map(escapeCell).join(";")).join("\n");
  }

  async function exportRoofData() {
    if (elExportStatus) elExportStatus.textContent = "Exporterar…";
    try {
      const geom = await getOxnehagaGeometry();
      if (!geom) throw new Error("Ingen Öxnehaga geometri.");
      const res = await buildingLayer.queryFeatures({
        geometry: geom,
        spatialRelationship: "intersects",
        outFields: ["*"],
        returnGeometry: true
      });
      const features = res?.features || [];
      const rows = [[
        "objektidentitet",
        "roofType",
        "pitch_deg",
        "solarElevation_deg",
        "shadowLength_m",
        "eavesHeight_m",
        "estimatedHeight_m",
        "computedAt"
      ]];
      features.forEach((f) => {
        const attrs = f.attributes || {};
        const id = attrs.objektidentitet || "";
        const entry = state.byId.get(id) || {};
        rows.push([
          id,
          entry.roofType || "Sadeltak",
          entry.pitch_deg ?? "",
          entry.solarElevation_deg ?? "",
          entry.shadowLength_m ?? "",
          entry.eavesHeight_m ?? "",
          entry.estimatedHeight_m ?? "",
          entry.computedAt ?? ""
        ]);
      });
      const csv = "\ufeff" + toCSV(rows);
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const filename = `oxnehaga_takdata_${yyyy}-${mm}-${dd}.csv`;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      if (elExportStatus) elExportStatus.textContent = `Exporterat: ${features.length} byggnader`;
    } catch (e) {
      console.error("Roof export failed:", e);
      if (elExportStatus) elExportStatus.textContent = "Export misslyckades.";
    }
  }

  async function handleFetch() {
    setError("");
    const id = (elInput?.value || "").trim();
    if (!id) {
      setError("Ange objektidentitet.");
      return;
    }
    const feature = await fetchBuildingByObjektidentitet(id);
    if (!feature) return;
    state.selected = { objektidentitet: id, feature };
    highlightFeature(feature);
    updateSummary();
    if (feature.geometry?.extent) {
      view.goTo(feature.geometry.extent.expand(2)).catch(() => {});
    }
  }

  if (elFetchBtn) elFetchBtn.addEventListener("click", handleFetch);
  if (elShadowBtn) elShadowBtn.addEventListener("click", startShadowMeasure);
  if (elComputeBtn) elComputeBtn.addEventListener("click", computePitch);
  if (elExportBtn) elExportBtn.addEventListener("click", exportRoofData);
};
