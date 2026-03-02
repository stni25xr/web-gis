/* Demo-only fire + smoke simulator (visual). Not a certified model. */
(() => {
  const DEFAULTS = {
    gridSize: 80,
    extentMeters: 3000,
    dtSimSeconds: 5,
    snapshotIntervalSeconds: 300,
    maxDurationSeconds: 3600,
    diffusionBase: 0.15,
    decayRate: 0.02,
    sourcePeak: 1.0,
    sourceThreshold: 0.12,
    areaThreshold: 0.25
  };

  class FireSmokeSim {
    constructor(opts) {
      this.view = opts.view;
      this.buildingLayer = opts.buildingLayer;
      this.geometryEngine = opts.geometryEngine;
      this.webMercatorUtils = opts.webMercatorUtils;
      this.GraphicsLayer = opts.GraphicsLayer;
      this.Graphic = opts.Graphic;
      this.FeatureLayer = opts.FeatureLayer;

      this.gridSize = opts.gridSize || DEFAULTS.gridSize;
      this.extentMeters = opts.extentMeters || DEFAULTS.extentMeters;
      this.dtSimSeconds = opts.dtSimSeconds || DEFAULTS.dtSimSeconds;
      this.snapshotIntervalSeconds = DEFAULTS.snapshotIntervalSeconds;
      this.maxDurationSeconds = DEFAULTS.maxDurationSeconds;

      this.diffusionBase = DEFAULTS.diffusionBase;
      this.decayRate = DEFAULTS.decayRate;
      this.sourcePeak = DEFAULTS.sourcePeak;

      this.sourceThreshold = DEFAULTS.sourceThreshold;
      this.areaThreshold = DEFAULTS.areaThreshold;

      this.fireSourceLayer = null;
      this.smokeLayer = null;
      this.affectedLayer = null;

      this.fireFeature = null;
      this.fireGeometry = null;
      this.fireSourcePoint = null;
      this.fireStartSim = null;

      this.gridA = null;
      this.gridB = null;
      this.gridC = null;
      this.grid = null;
      this.snapshots = new Map();

      this.extent = null;
      this.dxUnits = 0;
      this.dyUnits = 0;
      this.metersPerUnitX = 1;
      this.metersPerUnitY = 1;
      this.cellAreaM2 = 0;
      this.sourceIndex = null;

      this.currentSimSeconds = 0;
      this.active = false;
      this.ready = false;

      this.lastRenderTime = 0;
      this.renderTimer = null;

      this.lastWindCheck = 0;
      this.cachedWind = { speed_mps: 1.5, direction_deg_from: 270, updatedAt: null };

      this.ui = {};
      this.blinkTimers = [];
    }

    setUI(ui) {
      this.ui = ui || {};
      if (this.ui.objIdEl) this.ui.objIdEl.textContent = this.objektidentitet || "—";
    }

    async init(objektidentitet) {
      this.objektidentitet = objektidentitet;
      if (this.ui.objIdEl) this.ui.objIdEl.textContent = objektidentitet;
      if (!this.buildingLayer) {
        this.showError("Building layer saknas.");
        return false;
      }
      try {
        if (this.view && typeof this.view.when === "function") {
          await this.view.when();
        }
        await this.buildingLayer.load();
        const safeId = String(objektidentitet).replace(/'/g, "''");
        let feature = null;
        let lastError = null;
        try {
          const result = await this.buildingLayer.queryFeatures({
            where: `objektidentitet = '${safeId}'`,
            outFields: ["objektidentitet", "objekttyp", "andamal1", "b_Hight_m", "geom_Area", "geom_Length"],
            returnGeometry: true
          });
          feature = result?.features?.[0] || null;
        } catch (queryErr) {
          lastError = queryErr;
          console.warn("Fire smoke query failed, fallback to manual search.", queryErr);
        }
        if (!feature && this.view && typeof this.view.whenLayerView === "function") {
          try {
            const layerView = await this.view.whenLayerView(this.buildingLayer);
            if (layerView?.queryFeatures) {
              const result = await layerView.queryFeatures({
                where: `objektidentitet = '${safeId}'`,
                outFields: ["*"],
                returnGeometry: true
              });
              feature = result?.features?.[0] || null;
            }
          } catch (queryErr) {
            lastError = queryErr;
          }
        }
        if (!feature) {
          try {
            const fallback = await this.buildingLayer.queryFeatures({
              where: "1=1",
              outFields: ["*"],
              returnGeometry: true
            });
            feature = (fallback?.features || []).find((f) => String(f.attributes?.objektidentitet) === String(objektidentitet)) || null;
          } catch (queryErr) {
            lastError = queryErr;
          }
        }
        if (!feature) {
          const src = this.buildingLayer.source;
          const list = src?.toArray ? src.toArray() : (Array.isArray(src) ? src : []);
          if (list && list.length) {
            feature = list.find((f) => String(f.attributes?.objektidentitet) === String(objektidentitet)) || null;
          }
        }
        if (!feature || !feature.geometry) {
          if (lastError) {
            const msg = lastError && lastError.message ? lastError.message : String(lastError);
            this.showError(`Kunde inte läsa byggnad. (${msg})`);
          } else {
            this.showError("Byggnaden hittades inte.");
          }
          return false;
        }
        let geom = feature.geometry;
        const viewSR = this.view?.spatialReference;
        if (geom?.spatialReference && viewSR && geom.spatialReference.wkid !== viewSR.wkid) {
          if (geom.spatialReference.isWGS84 && viewSR.isWebMercator && this.webMercatorUtils) {
            geom = this.webMercatorUtils.geographicToWebMercator(geom);
          } else if (geom.spatialReference.isWebMercator && viewSR.isWGS84 && this.webMercatorUtils) {
            geom = this.webMercatorUtils.webMercatorToGeographic(geom);
          }
        }
        this.fireFeature = feature;
        this.fireGeometry = geom;
        try {
          this.fireSourcePoint = this.geometryEngine.centroid(this.fireGeometry);
        } catch (centroidErr) {
          const ext = this.fireGeometry?.extent;
          this.fireSourcePoint = ext?.center || null;
          console.warn("Centroid failed, using extent center.", centroidErr);
        }
        if (!this.fireSourcePoint) {
          this.showError("Kunde inte beräkna centrum för byggnaden.");
          return false;
        }

        this.ensureLayers();
        this.highlightFireBuilding(feature);
        this.buildGridDomain();
        this.resetGrid();
        this.ready = true;
        this.clearError();
        this.updateUIState();
        return true;
      } catch (err) {
        console.warn("Fire smoke init failed", err);
        const msg = err && err.message ? err.message : "Okänt fel";
        this.showError(`Kunde inte läsa byggnad. (${msg})`);
        return false;
      }
    }

    ensureLayers() {
      if (!this.fireSourceLayer) {
        this.fireSourceLayer = new this.GraphicsLayer({
          elevationInfo: { mode: "relative-to-ground", offset: 1 }
        });
        this.view.map.add(this.fireSourceLayer);
      }
      if (!this.smokeLayer) {
        this.smokeLayer = new this.FeatureLayer({
          title: "Smoke (demo)",
          source: [],
          objectIdField: "ObjectID",
          fields: [
            { name: "ObjectID", type: "oid" },
            { name: "weight", type: "double" }
          ],
          geometryType: "point",
          spatialReference: this.view.spatialReference,
          opacity: 0.55,
          elevationInfo: { mode: "on-the-ground" },
          renderer: {
            type: "heatmap",
            field: "weight",
            colorStops: [
              { ratio: 0.0, color: [0, 0, 0, 0] },
              { ratio: 0.2, color: [120, 120, 120, 0.2] },
              { ratio: 0.5, color: [90, 90, 90, 0.45] },
              { ratio: 0.75, color: [60, 60, 60, 0.65] },
              { ratio: 1.0, color: [30, 30, 30, 0.85] }
            ],
            minDensity: 0,
            maxDensity: 0.8
          }
        });
        this.view.map.add(this.smokeLayer);
      }
      if (!this.affectedLayer) {
        this.affectedLayer = new this.GraphicsLayer({
          elevationInfo: { mode: "on-the-ground" }
        });
        this.view.map.add(this.affectedLayer);
      }
    }

    highlightFireBuilding(feature) {
      if (!this.fireSourceLayer) return;
      this.fireSourceLayer.removeAll();
      const height = Number(feature.attributes?.b_Hight_m) || 8;
      const graphic = new this.Graphic({
        geometry: feature.geometry,
        symbol: {
          type: "polygon-3d",
          symbolLayers: [{
            type: "extrude",
            size: height,
            material: { color: [239, 68, 68, 0.85] },
            edges: { type: "solid", color: [255, 255, 255, 0.7], size: 1 }
          }]
        }
      });
      this.fireSourceLayer.add(graphic);
    }

    buildGridDomain() {
      if (!this.fireSourcePoint) return;
      const radiusMeters = this.extentMeters / 2;
      const buffer = this.geometryEngine.geodesicBuffer(this.fireSourcePoint, radiusMeters, "meters");
      this.extent = buffer.extent.clone();

      const nx = this.gridSize;
      const ny = this.gridSize;
      this.dxUnits = this.extent.width / nx;
      this.dyUnits = this.extent.height / ny;

      if (this.view.spatialReference?.isWebMercator || this.view.spatialReference?.wkid === 3857 || this.view.spatialReference?.wkid === 102100) {
        this.metersPerUnitX = 1;
        this.metersPerUnitY = 1;
      } else if (this.view.spatialReference?.isWGS84 || this.view.spatialReference?.wkid === 4326) {
        const lat = this.fireSourcePoint.latitude || this.fireSourcePoint.y || 0;
        const rad = lat * Math.PI / 180;
        this.metersPerUnitY = 111320;
        this.metersPerUnitX = 111320 * Math.cos(rad);
      } else {
        this.metersPerUnitX = 1;
        this.metersPerUnitY = 1;
      }

      this.cellAreaM2 = (this.dxUnits * this.metersPerUnitX) * (this.dyUnits * this.metersPerUnitY);

      const sx = this.fireSourcePoint.x;
      const sy = this.fireSourcePoint.y;
      const ix = Math.floor((sx - this.extent.xmin) / this.dxUnits);
      const iy = Math.floor((sy - this.extent.ymin) / this.dyUnits);
      this.sourceIndex = this.indexFor(ix, iy);

      const total = nx * ny;
      this.gridA = new Float32Array(total);
      this.gridB = new Float32Array(total);
      this.gridC = new Float32Array(total);
      this.grid = this.gridA;
    }

    indexFor(ix, iy) {
      if (ix < 0 || iy < 0 || ix >= this.gridSize || iy >= this.gridSize) return -1;
      return iy * this.gridSize + ix;
    }

    resetGrid() {
      if (!this.gridA) return;
      this.gridA.fill(0);
      this.gridB.fill(0);
      this.gridC.fill(0);
      this.grid = this.gridA;
      this.snapshots.clear();
      this.snapshots.set(0, new Float32Array(this.grid));
      this.currentSimSeconds = 0;
      this.scheduleRender(true);
    }

    start(simNow) {
      if (!this.ready) {
        this.showError("Initiera byggnaden först.");
        return;
      }
      this.active = true;
      this.fireStartSim = new Date(simNow || new Date());
      this.resetGrid();
      this.ensureLayersVisible(true);
      this.updateUIState();
    }

    stop() {
      this.active = false;
      this.fireStartSim = null;
      this.clearBlinkTimers();
      this.clearSmoke();
      this.updateUIState();
    }

    clearSmoke() {
      if (this.smokeLayer?.source) {
        this.smokeLayer.source.removeAll();
      }
      if (this.affectedLayer) {
        this.affectedLayer.removeAll();
      }
      this.ensureLayersVisible(false);
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }
    }

    ensureLayersVisible(visible) {
      if (this.smokeLayer) this.smokeLayer.visible = !!visible;
      if (this.affectedLayer) this.affectedLayer.visible = !!visible;
    }

    onSimTimeChange(simNow, simRunning, simMode) {
      if (!this.active || !this.fireStartSim) return;
      this.tickTo(simNow);
    }

    tickTo(simNow) {
      const targetSeconds = this.clampSeconds((simNow - this.fireStartSim) / 1000);
      if (targetSeconds <= 0) {
        this.resetGrid();
        this.updateUIState(targetSeconds);
        return;
      }

      const delta = targetSeconds - this.currentSimSeconds;
      if (delta >= 0 && delta <= 30) {
        this.stepForward(delta);
      } else {
        const baseSeconds = this.nearestSnapshot(targetSeconds);
        const snapshot = this.snapshots.get(baseSeconds);
        if (snapshot) {
          this.grid.set(snapshot);
          this.currentSimSeconds = baseSeconds;
        } else {
          this.resetGrid();
        }
        this.stepForward(targetSeconds - this.currentSimSeconds);
      }

      this.updateUIState(targetSeconds);
      this.scheduleRender();
    }

    clampSeconds(seconds) {
      if (!Number.isFinite(seconds)) return 0;
      return Math.max(0, Math.min(seconds, this.maxDurationSeconds));
    }

    nearestSnapshot(targetSeconds) {
      const snap = Math.floor(targetSeconds / this.snapshotIntervalSeconds) * this.snapshotIntervalSeconds;
      return Math.max(0, Math.min(snap, this.maxDurationSeconds));
    }

    stepForward(deltaSeconds) {
      let remaining = deltaSeconds;
      while (remaining > 0.01) {
        const dt = Math.min(this.dtSimSeconds, remaining);
        const nextSeconds = this.currentSimSeconds + dt;
        const tMinutes = nextSeconds / 60;
        const wind = this.getWindVector();
        this.applyStep(dt, tMinutes, wind);

        const prevSnapshotBucket = Math.floor((this.currentSimSeconds) / this.snapshotIntervalSeconds);
        const nextSnapshotBucket = Math.floor((nextSeconds) / this.snapshotIntervalSeconds);
        this.currentSimSeconds = nextSeconds;

        if (nextSnapshotBucket > prevSnapshotBucket) {
          this.snapshots.set(nextSnapshotBucket * this.snapshotIntervalSeconds, new Float32Array(this.grid));
        }
        remaining -= dt;
      }
    }

    applyStep(dt, tMinutes, wind) {
      const uUnits = wind.u / this.metersPerUnitX;
      const vUnits = wind.v / this.metersPerUnitY;
      const uCells = (uUnits * dt) / this.dxUnits;
      const vCells = (vUnits * dt) / this.dyUnits;

      this.advect(this.grid, this.gridB, uCells, vCells);
      this.applySource(this.gridB, dt, tMinutes);

      const diffusion = this.getDiffusion(wind.speed);
      this.diffuse(this.gridB, this.gridC, diffusion);

      const decay = Math.exp(-this.decayRate * dt);
      for (let i = 0; i < this.gridC.length; i++) {
        this.gridC[i] *= decay;
      }

      const old = this.gridA;
      this.gridA = this.gridC;
      this.gridC = old;
      this.grid = this.gridA;
    }

    advect(src, dest, uCells, vCells) {
      const nx = this.gridSize;
      const ny = this.gridSize;
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const backX = x - uCells;
          const backY = y - vCells;
          if (backX < 0 || backY < 0 || backX > nx - 1 || backY > ny - 1) {
            dest[y * nx + x] = 0;
            continue;
          }
          const x0 = Math.floor(backX);
          const y0 = Math.floor(backY);
          const x1 = Math.min(x0 + 1, nx - 1);
          const y1 = Math.min(y0 + 1, ny - 1);
          const tx = backX - x0;
          const ty = backY - y0;
          const v00 = src[y0 * nx + x0];
          const v10 = src[y0 * nx + x1];
          const v01 = src[y1 * nx + x0];
          const v11 = src[y1 * nx + x1];
          dest[y * nx + x] =
            v00 * (1 - tx) * (1 - ty) +
            v10 * tx * (1 - ty) +
            v01 * (1 - tx) * ty +
            v11 * tx * ty;
        }
      }
    }

    applySource(grid, dt, tMinutes) {
      if (this.sourceIndex === null || this.sourceIndex < 0) return;
      const rate = this.sourceRate(tMinutes) * this.sourcePeak;
      if (rate <= 0) return;
      const add = rate * dt;
      grid[this.sourceIndex] += add;

      const nx = this.gridSize;
      const ix = this.sourceIndex % nx;
      const iy = Math.floor(this.sourceIndex / nx);
      const neighbors = [
        [ix - 1, iy],
        [ix + 1, iy],
        [ix, iy - 1],
        [ix, iy + 1],
        [ix - 1, iy - 1],
        [ix + 1, iy + 1]
      ];
      neighbors.forEach(([x, y]) => {
        const idx = this.indexFor(x, y);
        if (idx >= 0) grid[idx] += add * 0.35;
      });
    }

    sourceRate(tMinutes) {
      if (tMinutes < 0) return 0;
      if (tMinutes < 10) return tMinutes / 10;
      if (tMinutes < 45) return 1;
      if (tMinutes < 60) return 1 - (tMinutes - 45) / 15;
      return 0;
    }

    diffuse(src, dest, diffusion) {
      const nx = this.gridSize;
      const ny = this.gridSize;
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const idx = y * nx + x;
          const center = src[idx];
          const left = x > 0 ? src[idx - 1] : center;
          const right = x < nx - 1 ? src[idx + 1] : center;
          const down = y > 0 ? src[idx - nx] : center;
          const up = y < ny - 1 ? src[idx + nx] : center;
          const lap = (left + right + up + down) - 4 * center;
          dest[idx] = center + diffusion * lap;
        }
      }
    }

    getDiffusion(speed) {
      const scaled = this.diffusionBase + speed * 0.01;
      return Math.max(0.05, Math.min(scaled, 0.45));
    }

    getWindVector() {
      const now = Date.now();
      if (now - this.lastWindCheck > 5000) {
        this.lastWindCheck = now;
        const live = window.liveWind;
        if (live && typeof live.speed_mps === "number" && typeof live.direction_deg_from === "number") {
          this.cachedWind = {
            speed_mps: live.speed_mps,
            direction_deg_from: live.direction_deg_from,
            updatedAt: live.updatedAt || null
          };
        }
        this.updateWindUI();
      }

      const speed = this.cachedWind?.speed_mps ?? 1.5;
      const fromDeg = this.cachedWind?.direction_deg_from ?? 270;
      const toDeg = (fromDeg + 180) % 360;
      const rad = toDeg * Math.PI / 180;
      const u = speed * Math.sin(rad);
      const v = speed * Math.cos(rad);
      return { u, v, speed };
    }

    updateWindUI() {
      if (!this.ui.windEl) return;
      const speed = this.cachedWind?.speed_mps;
      const fromDeg = this.cachedWind?.direction_deg_from;
      if (typeof speed === "number" && typeof fromDeg === "number") {
        this.ui.windEl.textContent = `${speed.toFixed(1)} m/s, ${Math.round(fromDeg)}° från`;
      } else {
        this.ui.windEl.textContent = "—";
      }
      if (this.ui.windTimeEl) {
        const updatedAt = this.cachedWind?.updatedAt;
        if (updatedAt) {
          const dt = new Date(updatedAt);
          this.ui.windTimeEl.textContent = dt.toLocaleTimeString("sv-SE");
        } else {
          this.ui.windTimeEl.textContent = "—";
        }
      }
    }

    scheduleRender(force = false) {
      const now = Date.now();
      const minInterval = 600;
      if (force || now - this.lastRenderTime >= minInterval) {
        this.render();
        return;
      }
      if (this.renderTimer) return;
      const delay = minInterval - (now - this.lastRenderTime);
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.render();
      }, delay);
    }

    render() {
      if (!this.smokeLayer || !this.extent) return;
      this.lastRenderTime = Date.now();

      const graphics = [];
      const nx = this.gridSize;
      const ny = this.gridSize;
      let oid = 1;
      let affectedCount = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const idx = y * nx + x;
          const value = this.grid[idx];
          if (value <= this.sourceThreshold) continue;
          const px = this.extent.xmin + (x + 0.5) * this.dxUnits;
          const py = this.extent.ymin + (y + 0.5) * this.dyUnits;
          graphics.push(new this.Graphic({
            geometry: {
              type: "point",
              x: px,
              y: py,
              spatialReference: this.view.spatialReference
            },
            attributes: {
              ObjectID: oid++,
              weight: Math.min(value, 1.5)
            }
          }));

          if (value >= this.areaThreshold) {
            affectedCount += 1;
            minX = Math.min(minX, px);
            minY = Math.min(minY, py);
            maxX = Math.max(maxX, px);
            maxY = Math.max(maxY, py);
          }
        }
      }

      if (this.smokeLayer.source) {
        this.smokeLayer.source.removeAll();
        if (graphics.length) this.smokeLayer.source.addMany(graphics);
      }

      this.updateAffectedArea(affectedCount, minX, minY, maxX, maxY);
    }

    updateAffectedArea(affectedCount, minX, minY, maxX, maxY) {
      if (!this.affectedLayer) return;
      this.affectedLayer.removeAll();
      if (!Number.isFinite(minX) || affectedCount === 0) {
        if (this.ui.areaEl) this.ui.areaEl.textContent = "—";
        return;
      }

      const expandX = this.dxUnits * 0.5;
      const expandY = this.dyUnits * 0.5;
      const ring = [
        [minX - expandX, minY - expandY],
        [maxX + expandX, minY - expandY],
        [maxX + expandX, maxY + expandY],
        [minX - expandX, maxY + expandY],
        [minX - expandX, minY - expandY]
      ];
      const areaGraphic = new this.Graphic({
        geometry: {
          type: "polygon",
          rings: [ring],
          spatialReference: this.view.spatialReference
        },
        symbol: {
          type: "simple-fill",
          color: [70, 70, 70, 0.08],
          outline: { color: [80, 80, 80, 0.7], width: 1 }
        }
      });
      this.affectedLayer.add(areaGraphic);

      const areaM2 = affectedCount * this.cellAreaM2;
      if (this.ui.areaEl) {
        this.ui.areaEl.textContent = `${Math.round(areaM2).toLocaleString("sv-SE")} m²`;
      }
    }

    updateUIState(targetSeconds) {
      if (this.ui.elapsedEl && typeof targetSeconds === "number") {
        const total = Math.max(0, Math.min(targetSeconds, this.maxDurationSeconds));
        const mm = Math.floor(total / 60);
        const ss = Math.floor(total % 60);
        this.ui.elapsedEl.textContent = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
      }
      if (this.ui.phaseEl && typeof targetSeconds === "number") {
        const mins = targetSeconds / 60;
        let phase = "—";
        if (mins <= 0) phase = "Start";
        else if (mins < 10) phase = "Growth";
        else if (mins < 45) phase = "Steady";
        else if (mins < 60) phase = "Decay";
        else phase = "Ended";
        this.ui.phaseEl.textContent = phase;
      }
      if (!this.active) {
        if (this.ui.phaseEl) this.ui.phaseEl.textContent = "Stopped";
        if (this.ui.elapsedEl) this.ui.elapsedEl.textContent = "00:00";
      }
      this.updateWindUI();
    }

    showError(message) {
      if (this.ui.errorEl) {
        this.ui.errorEl.textContent = message;
        this.ui.errorEl.style.display = "block";
      }
    }

    clearError() {
      if (this.ui.errorEl) {
        this.ui.errorEl.textContent = "";
        this.ui.errorEl.style.display = "none";
      }
    }

    centerOnSource() {
      if (this.fireSourcePoint && this.view) {
        this.view.goTo({ target: this.fireSourcePoint, zoom: 18 }, { duration: 800 });
      }
    }

    blinkSource() {
      if (!this.fireSourceLayer) return;
      this.clearBlinkTimers();
      const setVis = (v) => {
        if (this.fireSourceLayer) this.fireSourceLayer.visible = v;
      };
      const steps = [
        { t: 0, v: true },
        { t: 150, v: false },
        { t: 300, v: true },
        { t: 450, v: false },
        { t: 600, v: true },
        { t: 1200, v: true }
      ];
      steps.forEach((step) => {
        const id = setTimeout(() => setVis(step.v), step.t);
        this.blinkTimers.push(id);
      });
    }

    clearBlinkTimers() {
      if (!this.blinkTimers.length) return;
      this.blinkTimers.forEach((id) => clearTimeout(id));
      this.blinkTimers = [];
    }

    setDiffusion(value) {
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      this.diffusionBase = Math.max(0.02, Math.min(v, 0.35));
    }

    setSourcePeak(value) {
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      this.sourcePeak = Math.max(0.3, Math.min(v, 2.0));
    }

    dispose() {
      this.stop();
      this.clearBlinkTimers();
      if (this.fireSourceLayer) this.view.map.remove(this.fireSourceLayer);
      if (this.smokeLayer) this.view.map.remove(this.smokeLayer);
      if (this.affectedLayer) this.view.map.remove(this.affectedLayer);
      this.fireSourceLayer = null;
      this.smokeLayer = null;
      this.affectedLayer = null;
    }
  }

  window.FireSmokeSim = FireSmokeSim;
})();
