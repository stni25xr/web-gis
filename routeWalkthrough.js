/* First-person route walkthrough (distance-parametrized) */
(() => {
  const DEFAULTS = {
    baseWalkSpeedMps: 1.4,
    lookAheadMeters: 8,
    heightAboveGround: 1.5,
    frameMs: 40
  };

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

      this.speedMultiplier = 1;
      this.baseWalkSpeedMps = DEFAULTS.baseWalkSpeedMps;
      this.lookAheadMeters = DEFAULTS.lookAheadMeters;
      this.heightAboveGround = DEFAULTS.heightAboveGround;
      this.frameMs = DEFAULTS.frameMs;

      this.points = [];
      this.distances = [];
      this.totalDistance = 0;
      this.lastIndex = 0;
      this.elevations = null;

      this.running = false;
      this.paused = false;
      this.startTimeMs = 0;
      this.pausedAccumMs = 0;
      this.pauseStartMs = 0;
      this.lastFrameMs = 0;

      this.rafId = null;
      this.lastViewpoint = null;

      this.walkerLayer = new this.GraphicsLayer({
        elevationInfo: { mode: "relative-to-ground", offset: this.heightAboveGround }
      });
      if (this.view?.map) this.view.map.add(this.walkerLayer);
      this.walkerGraphic = null;
    }

    setSpeed(multiplier) {
      const v = Number(multiplier);
      if (![1, 2, 4].includes(v)) return;
      this.speedMultiplier = v;
    }

    async start(routePolyline, speedMultiplier = 1) {
      if (!routePolyline) return;
      if (this.running) this.cancel(false);
      this.setSpeed(speedMultiplier);

      this.lastViewpoint = this.view?.viewpoint ? this.view.viewpoint.clone() : null;
      await this._prepareRoute(routePolyline);

      this.running = true;
      this.paused = false;
      this.startTimeMs = performance.now();
      this.pausedAccumMs = 0;
      this.pauseStartMs = 0;
      this.lastFrameMs = 0;
      this.lastIndex = 0;

      this._emit();
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

    async _prepareRoute(routePolyline) {
      const dense = this.geometryEngine.densify(routePolyline, 1, "meters");
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

      this.elevations = null;
      if (this.view?.type === "3d" && this.view.ground?.queryElevation) {
        try {
          const geoLine = {
            type: "polyline",
            paths: [geoPoints.map((p) => [p.longitude, p.latitude])],
            spatialReference: { wkid: 4326 }
          };
          const elevated = await this.view.ground.queryElevation(geoLine);
          const epaths = elevated?.paths || [];
          if (epaths.length) {
            this.elevations = epaths[0].map((p) => p[2] || 0);
          }
        } catch (e) {
          this.elevations = null;
        }
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

      if (traveled >= this.totalDistance - 0.01) {
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

    _updateWalker(pos, lookPos, idx) {
      if (!pos || !this.view) return;
      const heading = lookPos ? bearingDeg(pos, lookPos) : 0;
      const groundZ = this.elevations && this.elevations[idx] != null ? this.elevations[idx] : 0;
      const z = groundZ + this.heightAboveGround;

      if (this.view.type === "3d") {
        this.view.camera = {
          position: { longitude: pos.longitude, latitude: pos.latitude, z },
          heading,
          tilt: 85
        };
      } else {
        this.view.center = [pos.longitude, pos.latitude];
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
  }

  window.RouteWalkthrough = RouteWalkthrough;
})();
