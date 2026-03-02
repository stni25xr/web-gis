/* First-person route walkthrough (distance-parametrized) */
(() => {
  const DEFAULTS = {
    baseWalkSpeedMps: 1.4,
    lookAheadMeters: 8,
    heightAboveGround: 1.5,
    frameMs: 40
  };
  const TILT_ANGLE = 89.9;
  const ELEVATION_SAMPLE_STEP = 10;

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

  function bearingDeg(a, b) {
    const toRad = (v) => (v * Math.PI) / 180;
    const toDeg = (v) => (v * 180) / Math.PI;
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
      - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  class RouteWalkthrough {
    constructor(opts) {
      this.view = opts.view;
      this.geometryEngine = opts.geometryEngine;
      this.webMercatorUtils = opts.webMercatorUtils;
      this.GraphicsLayer = opts.GraphicsLayer;
      this.Graphic = opts.Graphic;
      this.onStateChange = opts.onStateChange || null;
      this.onHint = opts.onHint || null;

      this.speedMultiplier = 1;
      this.baseWalkSpeedMps = DEFAULTS.baseWalkSpeedMps;
      this.lookAheadMeters = DEFAULTS.lookAheadMeters;
      this.heightAboveGround = DEFAULTS.heightAboveGround;
      this.frameMs = DEFAULTS.frameMs;

      this.routePolyline = null;
      this.points = [];
      this.distances = [];
      this.totalDistance = 0;
      this.lastIndex = 0;
      this.elevationSamples = null;
      this.elevationDistances = null;

      this.running = false;
      this.paused = false;
      this.startTimeMs = 0;
      this.pausedAccumMs = 0;
      this.pauseStartMs = 0;
      this.lastFrameMs = 0;

      this.rafId = null;
      this.lastViewpoint = null;
      this.lastTickLogMs = 0;
      this.lastHint = "";

      this.walkerLayer = new this.GraphicsLayer({
        elevationInfo: { mode: "relative-to-ground", offset: this.heightAboveGround }
      });
      if (this.view?.map) this.view.map.add(this.walkerLayer);
      this.walkerGraphic = null;
    }

    setRoute(routePolyline) {
      this.routePolyline = routePolyline || null;
      if (!this.routePolyline) return;
      this._prepareRoute(this.routePolyline);
      this._prefetchElevations();
    }

    setSpeed(multiplier) {
      const v = Number(multiplier);
      if (![1, 2, 4].includes(v)) return;
      this.speedMultiplier = v;
    }

    async start(speedMultiplier = 1) {
      if (!this.routePolyline) {
        console.warn("walkthrough start: no route");
        this._hint("Ingen gångväg att följa");
        return;
      }
      if (this.running) this.cancel(false);
      this.setSpeed(speedMultiplier);

      this.lastViewpoint = this.view?.viewpoint ? this.view.viewpoint.clone() : null;
      if (!this.points.length) {
        this._prepareRoute(this.routePolyline);
        this._prefetchElevations();
      }
      if (!this.points.length || this.totalDistance <= 0) {
        console.warn("walkthrough start: empty route");
        this._hint("Ingen gångväg att följa");
        return;
      }

      this.running = true;
      this.paused = false;
      this.startTimeMs = performance.now();
      this.pausedAccumMs = 0;
      this.pauseStartMs = 0;
      this.lastFrameMs = 0;
      this.lastIndex = 0;
      this.lastTickLogMs = 0;

      console.log("walkthrough start", {
        totalDistance: Math.round(this.totalDistance),
        pointsCount: this.points.length
      });

      this._emit();
      this._jumpToStart();
      this._tick();
    }

    pause() {
      if (!this.running || this.paused) return;
      this.paused = true;
      this.pauseStartMs = performance.now();
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this._emit();
    }

    resume() {
      if (!this.running || !this.paused) return;
      this.paused = false;
      this.pausedAccumMs += performance.now() - this.pauseStartMs;
      this.pauseStartMs = 0;
      this._emit();
      this._tick();
    }

    cancel(restoreView = true) {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.running = false;
      this.paused = false;
      this._clearWalker();
      this._hint("");
      if (restoreView && this.lastViewpoint && this.view) {
        this.view.goTo(this.lastViewpoint, { animate: false });
      }
      this._emit();
    }

    dispose() {
      this.cancel(false);
      if (this.walkerLayer && this.view?.map) {
        this.view.map.remove(this.walkerLayer);
      }
      this.walkerLayer = null;
    }

    _prepareRoute(routePolyline) {
      const dense = this.geometryEngine.densify(routePolyline, 2, "meters");
      let paths = dense?.paths || routePolyline?.paths || [];
      if (!paths.length) return;
      const raw = paths[0];

      // Convert to geographic if needed
      let geoPoints = raw.map((p) => ({ longitude: p[0], latitude: p[1] }));
      const sr = dense.spatialReference || routePolyline.spatialReference;
      if (sr && (sr.isWebMercator || sr.wkid === 3857 || sr.wkid === 102100) && this.webMercatorUtils) {
        const geo = this.webMercatorUtils.webMercatorToGeographic(dense);
        const gpaths = geo?.paths || [];
        if (gpaths.length) {
          geoPoints = gpaths[0].map((p) => ({ longitude: p[0], latitude: p[1] }));
        }
      }

      this.points = geoPoints;
      this.distances = [0];
      let total = 0;
      for (let i = 1; i < this.points.length; i++) {
        const d = haversineMeters(this.points[i - 1], this.points[i]);
        total += d;
        this.distances.push(total);
      }
      this.totalDistance = total;

      this.elevationSamples = null;
      this.elevationDistances = null;
    }

    async _prefetchElevations() {
      if (this.view?.type !== "3d" || !this.view.ground?.queryElevation) return;
      if (!this.totalDistance) return;
      try {
        const samples = [];
        const distances = [];
        for (let d = 0; d <= this.totalDistance; d += ELEVATION_SAMPLE_STEP) {
          const pt = this._getPointAtDistance(d);
          if (pt) {
            samples.push([pt.longitude, pt.latitude]);
            distances.push(d);
          }
        }
        if (!samples.length) return;
        const multipoint = {
          type: "multipoint",
          points: samples,
          spatialReference: { wkid: 4326 }
        };
        const elevated = await this.view.ground.queryElevation(multipoint);
        const epoints = elevated?.geometry?.points || [];
        const zValues = epoints.map((p) => (Number.isFinite(p[2]) ? p[2] : 0));
        if (zValues.length) {
          this.elevationSamples = zValues;
          this.elevationDistances = distances;
        }
      } catch (e) {
        this.elevationSamples = null;
        this.elevationDistances = null;
      }
    }

    _emit() {
      if (typeof this.onStateChange === "function") {
        this.onStateChange({ running: this.running, paused: this.paused });
      }
    }

    _tick() {
      if (!this.running || this.paused) return;
      const now = performance.now();
      if (this.lastFrameMs && now - this.lastFrameMs < this.frameMs) {
        this.rafId = requestAnimationFrame(() => this._tick());
        return;
      }
      this.lastFrameMs = now;

      const elapsedSec = (now - this.startTimeMs - this.pausedAccumMs) / 1000;
      const effectiveSpeed = this.baseWalkSpeedMps * this.speedMultiplier;
      let traveled = elapsedSec * effectiveSpeed;
      if (traveled >= this.totalDistance) {
        traveled = this.totalDistance;
      }

      const idx = this._findIndex(traveled);
      const pos = this._interpolate(idx, traveled);
      const lookPos = this._interpolate(idx, Math.min(traveled + this.lookAheadMeters, this.totalDistance));

      this._updateWalker(pos, lookPos, idx);

      if (!this.lastTickLogMs || now - this.lastTickLogMs >= 1000) {
        this.lastTickLogMs = now;
        console.log("walkthrough tick", Math.round(traveled));
      }

      if (traveled >= this.totalDistance - 0.01) {
        console.log("walkthrough arrived");
        this.cancel(false);
        return;
      }

      this.rafId = requestAnimationFrame(() => this._tick());
    }

    _findIndex(traveled) {
      let i = this.lastIndex;
      while (i < this.distances.length - 2 && this.distances[i + 1] < traveled) i += 1;
      this.lastIndex = i;
      return i;
    }

    _interpolate(i, traveled) {
      const d0 = this.distances[i];
      const d1 = this.distances[i + 1];
      const t = d1 > d0 ? (traveled - d0) / (d1 - d0) : 0;
      const a = this.points[i];
      const b = this.points[i + 1] || a;
      const lon = a.longitude + (b.longitude - a.longitude) * t;
      const lat = a.latitude + (b.latitude - a.latitude) * t;
      return { longitude: lon, latitude: lat };
    }

    _getPointAtDistance(targetMeters) {
      if (!this.distances.length) return null;
      const clamped = Math.max(0, Math.min(targetMeters, this.totalDistance));
      let i = 0;
      while (i < this.distances.length - 2 && this.distances[i + 1] < clamped) i += 1;
      return this._interpolate(i, clamped);
    }

    _getElevationAtDistance(targetMeters) {
      if (!this.elevationSamples || !this.elevationDistances) return 0;
      const dists = this.elevationDistances;
      if (!dists.length) return 0;
      if (targetMeters <= dists[0]) return this.elevationSamples[0] || 0;
      if (targetMeters >= dists[dists.length - 1]) return this.elevationSamples[dists.length - 1] || 0;
      let i = 0;
      while (i < dists.length - 2 && dists[i + 1] < targetMeters) i += 1;
      const d0 = dists[i];
      const d1 = dists[i + 1];
      const z0 = this.elevationSamples[i] || 0;
      const z1 = this.elevationSamples[i + 1] || 0;
      const t = d1 > d0 ? (targetMeters - d0) / (d1 - d0) : 0;
      return z0 + (z1 - z0) * t;
    }

    _updateWalker(pos, lookPos, idx) {
      if (!pos || !this.view) return;
      const heading = lookPos ? bearingDeg(pos, lookPos) : 0;
      const groundZ = this._getElevationAtDistance(this.distances[idx] || 0);
      const z = groundZ + this.heightAboveGround;

      if (this.view.type === "3d") {
        this.view.camera = {
          position: { longitude: pos.longitude, latitude: pos.latitude, z },
          heading,
          tilt: TILT_ANGLE
        };
      } else {
        this.view.goTo({ center: [pos.longitude, pos.latitude] }, { animate: false });
        this._hint("Förstaperson kräver 3D");
      }

      if (!this.walkerGraphic) {
        this.walkerGraphic = new this.Graphic({
          geometry: { type: "point", longitude: pos.longitude, latitude: pos.latitude, spatialReference: { wkid: 4326 } },
          symbol: { type: "simple-marker", color: [59, 130, 246, 0.9], size: 8, outline: { color: [255, 255, 255, 0.9], width: 1 } }
        });
        this.walkerLayer.add(this.walkerGraphic);
      } else {
        this.walkerGraphic.geometry = { type: "point", longitude: pos.longitude, latitude: pos.latitude, spatialReference: { wkid: 4326 } };
      }
    }

    _clearWalker() {
      if (this.walkerLayer) this.walkerLayer.removeAll();
      this.walkerGraphic = null;
    }

    _jumpToStart() {
      if (!this.view || !this.points.length) return;
      const start = this.points[0];
      const next = this.points[1] || start;
      const heading = bearingDeg(start, next);
      const groundZ = this._getElevationAtDistance(0);
      const z = groundZ + this.heightAboveGround;
      if (this.view.type === "3d") {
        this.view.camera = {
          position: { longitude: start.longitude, latitude: start.latitude, z },
          heading,
          tilt: TILT_ANGLE
        };
      } else {
        this.view.goTo({ center: [start.longitude, start.latitude] }, { animate: false });
        this._hint("Förstaperson kräver 3D");
      }
    }

    _hint(message) {
      if (!message) message = "";
      if (message === this.lastHint) return;
      this.lastHint = message;
      if (typeof this.onHint === "function") {
        this.onHint(message);
      }
    }
  }

  window.RouteWalkthrough = RouteWalkthrough;
})();
