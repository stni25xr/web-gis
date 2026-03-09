(() => {
  const SHUTTLE_ID = "shuttle-1";
  const SHUTTLE_TYPE = "electric shuttle";
  const SHUTTLE_DEBUG = true;
  const CRUISE_MIN_MPS = 35 / 3.6;
  const CRUISE_MAX_MPS = 40 / 3.6;
  const ACCEL_MPS2 = 5;
  const DECEL_MPS2 = 5;
  const AVG_SPEED_MPS = (CRUISE_MIN_MPS + CRUISE_MAX_MPS) / 2;
  const CRUISE_WAVE_METERS = 140;
  const SHOW_SHUTTLE_ROUTE = true;
  const STATION = { latitude: 57.77101, longitude: 14.26968 };
  const HEALTHCARE = { latitude: 57.77468, longitude: 14.26546 };
  const HEALTHCARE_LABEL = "Vårdcentralen (57.77468, 14.26546)";
  const CUSTOMER_NAME = "Ingrid Andersson";
  const CUSTOMER_PHONE = "+46 (0)768 333332";
  const CUSTOMER_ID = "SE-2026-0001";

  const STATE = {
    IDLE: "idle_at_station",
    TO_PICKUP: "driving_to_pickup",
    WAIT_PICKUP: "waiting_at_pickup",
    TO_HEALTH: "driving_to_healthcare",
    WAIT_HEALTH: "waiting_at_healthcare",
    RETURN: "returning_to_station"
  };

  function createShuttleIcon() {
    return "data:image/svg+xml;utf8," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'>"
      + "<rect x='8' y='14' width='48' height='28' rx='8' fill='#2563eb'/>"
      + "<rect x='14' y='20' width='36' height='12' rx='4' fill='rgba(255,255,255,0.9)'/>"
      + "<rect x='18' y='36' width='8' height='8' rx='4' fill='#0f172a'/>"
      + "<rect x='38' y='36' width='8' height='8' rx='4' fill='#0f172a'/>"
      + "<path d='M51 18 l5 4 -5 4' fill='none' stroke='#f8fafc' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/>"
      + "</svg>"
    );
  }

  function lonLatFromPoint(point) {
    if (!point) return null;
    const lon = point.longitude ?? point.x;
    const lat = point.latitude ?? point.y;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return [lon, lat];
  }

  function toGeoPoint(pt, webMercatorUtils) {
    if (!pt) return null;
    if (pt.spatialReference && (pt.spatialReference.isWGS84 || pt.spatialReference.wkid === 4326)) return pt;
    if (pt.spatialReference && (pt.spatialReference.isWebMercator || pt.spatialReference.wkid === 3857 || pt.spatialReference.wkid === 102100)) {
      return webMercatorUtils.webMercatorToGeographic(pt);
    }
    if (Number.isFinite(pt.latitude) && Number.isFinite(pt.longitude)) return pt;
    return null;
  }

  function buildSampler(Polyline, webMercatorUtils, routePoints) {
    if (!routePoints || routePoints.length < 2) return null;
    const baseLine = new Polyline({
      paths: [routePoints],
      spatialReference: { wkid: 4326 }
    });
    const wmLine = webMercatorUtils.geographicToWebMercator(baseLine);
    const path = wmLine?.paths?.[0];
    if (!path || path.length < 2) return null;
    const cum = [0];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i][0] - path[i - 1][0];
      const dy = path[i][1] - path[i - 1][1];
      total += Math.hypot(dx, dy);
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

  class ShuttleController {
    constructor({ view, map, GraphicsLayer, Graphic, Polyline, geometryEngine, webMercatorUtils }) {
      this.view = view;
      this.map = map;
      this.GraphicsLayer = GraphicsLayer;
      this.Graphic = Graphic;
      this.Polyline = Polyline;
      this.geometryEngine = geometryEngine;
      this.webMercatorUtils = webMercatorUtils;
      this.elevationSampler = null;
      this.elevationCache = new Map();
      this.lastElevationRequest = 0;
      this.lastDebugLog = 0;

      this.currentState = STATE.IDLE;
      this.currentRequest = null;
      this.shuttleGraphic = null;
      this.shuttleFallbackGraphic = null;
      this.shuttleRouteGraphic = null;
      this.shuttleLayer = new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 6 } });
      this.map.add(this.shuttleLayer);
      if (typeof this.map.reorder === "function") {
        this.map.reorder(this.shuttleLayer, this.map.layers.length - 1);
      }
      this.animation = null;
      this.countdownTimer = null;
      this.pauseTimer = null;
      this.modalMuted = false;
      this.healthcareLegMeters = 0;
      this.requestMeta = null;
      this.currentVisualKey = null;

      this.initMarker();
      if (this.view && typeof this.view.when === "function") {
        this.view.when(() => {
          this.elevationSampler = this.view?.groundView?.elevationSampler || null;
        });
      }

      window.shuttleGraphic = this.shuttleGraphic;
      window.shuttleCurrentRoute = null;
      window.shuttleAnimationState = null;
    }

    initMarker() {
      const is3d = this.view && this.view.type === "3d";
      const startPoint = this.withElevation({
        type: "point",
        longitude: STATION.longitude,
        latitude: STATION.latitude,
        spatialReference: { wkid: 4326 }
      });
      this.shuttleGraphic = new this.Graphic({
        geometry: startPoint,
        attributes: {
          id: SHUTTLE_ID,
          type: SHUTTLE_TYPE
        },
        symbol: is3d ? this.buildShuttleSymbol3D({ moving: false }) : this.buildShuttleSymbol2D({ moving: false }),
        visible: true
      });
      this.shuttleFallbackGraphic = new this.Graphic({
        geometry: startPoint,
        attributes: {
          id: `${SHUTTLE_ID}-fallback`,
          type: SHUTTLE_TYPE
        },
        symbol: this.buildShuttleFallbackSymbol({ moving: false }),
        visible: true
      });
      this.shuttleLayer.addMany([this.shuttleFallbackGraphic, this.shuttleGraphic]);
      this.applyShuttleVisual(false);
    }

    applyShuttleVisual(moving) {
      if (!this.shuttleGraphic) return;
      const is3d = this.view && this.view.type === "3d";
      const visualKey = `${is3d ? "3d" : "2d"}:${moving ? "moving" : "idle"}`;
      if (visualKey === this.currentVisualKey) return;
      this.currentVisualKey = visualKey;
      this.shuttleGraphic.symbol = is3d
        ? this.buildShuttleSymbol3D({ moving })
        : this.buildShuttleSymbol2D({ moving });
      if (this.shuttleFallbackGraphic) {
        this.shuttleFallbackGraphic.symbol = this.buildShuttleFallbackSymbol({ moving });
      }
    }

    showModal(title, message) {
      if (this.modalMuted) return;
      const modal = document.getElementById("shuttleModal");
      const titleEl = document.getElementById("shuttleTitle");
      const msgEl = document.getElementById("shuttleMessage");
      if (titleEl) titleEl.textContent = title;
      if (msgEl) msgEl.innerHTML = this.toModalHtml(message);
      if (modal) modal.style.display = "flex";
    }

    updateModal(message) {
      if (this.modalMuted) return;
      const msgEl = document.getElementById("shuttleMessage");
      if (msgEl) msgEl.innerHTML = this.toModalHtml(message);
    }

    hideModal() {
      const modal = document.getElementById("shuttleModal");
      if (modal) modal.style.display = "none";
      this.modalMuted = true;
    }

    setState(next) {
      this.currentState = next;
      if (window.shuttleAnimationState) {
        window.shuttleAnimationState.currentState = next;
      }
    }

    isBusy() {
      return this.currentState !== STATE.IDLE;
    }

    clearTimers() {
      if (this.countdownTimer) clearInterval(this.countdownTimer);
      this.countdownTimer = null;
      if (this.pauseTimer) clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
      if (this.animation) cancelAnimationFrame(this.animation);
      this.animation = null;
    }

    async requestPickup(pickupPoint) {
      if (this.isBusy()) {
        this.modalMuted = false;
        this.showModal("Shuttle", "Shuttlen är redan upptagen. Försök igen om en stund.");
        return false;
      }
      this.modalMuted = false;
      this.showModal("Calling shuttle", "Kontaktar shuttlen…");
      const geo = toGeoPoint(pickupPoint, this.webMercatorUtils);
      if (!geo) return false;
      this.currentRequest = { pickup: geo };
      this.requestMeta = {
        name: CUSTOMER_NAME,
        phone: CUSTOMER_PHONE,
        customerId: CUSTOMER_ID,
        orderId: this.generateOrderId(),
        calledAt: new Date(),
        pickup: geo
      };
      this.healthcareLegMeters = 0;
      const healthcareRoute = await this.fetchRoute(this.currentRequest.pickup, HEALTHCARE);
      if (healthcareRoute) {
        const sampler = buildSampler(this.Polyline, this.webMercatorUtils, healthcareRoute);
        if (sampler) this.healthcareLegMeters = sampler.total || 0;
      }
      await this.driveToPickup();
      return true;
    }

    async driveToPickup() {
      this.setState(STATE.TO_PICKUP);
      const route = await this.fetchRoute(STATION, this.currentRequest.pickup);
      if (!route) {
        this.showModal("Shuttle", "Kunde inte hitta rutt till upphämtning.");
        this.resetToStation();
        return;
      }
      this.showModal("Shuttle bokad", "Din shuttle är på väg till dig.");
      await this.driveRoute(route, "#2563eb", (remainingMeters, remainingSeconds) => {
        const mins = Math.floor(remainingSeconds / 60);
        const secs = Math.max(0, Math.round(remainingSeconds % 60));
        const line1 = "Din shuttle är på väg till dig.";
        const line2 = `Ankomst om ${mins} min ${secs} sek`;
        const line3 = `Avstånd kvar: ${Math.round(remainingMeters)} m`;
        const totalToHealth = remainingMeters + (this.healthcareLegMeters || 0);
        const healthSeconds = totalToHealth / AVG_SPEED_MPS;
        const hMins = Math.floor(healthSeconds / 60);
        const hSecs = Math.max(0, Math.round(healthSeconds % 60));
        const line4 = `Till vårdcentral: ${hMins} min ${hSecs} sek`;
        const line5 = `Destination: ${HEALTHCARE_LABEL}`;
        const meta = this.formatRequestMeta();
        this.updateModal(this.formatStatusMessage([
          line1, line2, line3, line4, line5
        ], meta));
      });
      this.setState(STATE.WAIT_PICKUP);
      this.showModal("Shuttle framme", "Din shuttle har anlänt.");
      await this.pause(2500);
      await this.driveToHealthcare();
    }

    async driveToHealthcare() {
      this.setState(STATE.TO_HEALTH);
      const route = await this.fetchRoute(this.currentRequest.pickup, HEALTHCARE);
      if (!route) {
        this.showModal("Shuttle", "Kunde inte hitta rutt till vårdcentral.");
        await this.pause(2000);
        return this.returnToStation();
      }
      await this.driveRoute(route, "#22c55e", (remainingMeters, remainingSeconds) => {
        const mins = Math.floor(remainingSeconds / 60);
        const secs = Math.max(0, Math.round(remainingSeconds % 60));
        const line1 = "Shuttlen är på väg till vårdcentralen.";
        const line2 = `Ankomst om ${mins} min ${secs} sek`;
        const line3 = `Avstånd kvar: ${Math.round(remainingMeters)} m`;
        const line4 = `Destination: ${HEALTHCARE_LABEL}`;
        const meta = this.formatRequestMeta();
        this.updateModal(this.formatStatusMessage([
          line1, line2, line3, line4
        ], meta));
      });
      this.setState(STATE.WAIT_HEALTH);
      this.showModal("Framme vid vårdcentral", "Shuttlen har anlänt till vårdcentralen.");
      await this.pause(2500);
      await this.returnToStation();
    }

    async returnToStation() {
      this.setState(STATE.RETURN);
      const route = await this.fetchRoute(HEALTHCARE, STATION);
      if (!route) {
        this.resetToStation();
        return;
      }
      await this.driveRoute(route, "#94a3b8", (remainingMeters, remainingSeconds) => {
        const mins = Math.floor(remainingSeconds / 60);
        const secs = Math.max(0, Math.round(remainingSeconds % 60));
        const line1 = "Shuttlen är på väg tillbaka till hållplatsen.";
        const line2 = `Ankomst om ${mins} min ${secs} sek`;
        const line3 = `Avstånd kvar: ${Math.round(remainingMeters)} m`;
        const line4 = "Destination: Station";
        const meta = this.formatRequestMeta();
        this.updateModal(this.formatStatusMessage([
          line1, line2, line3, line4
        ], meta));
      });
      this.resetToStation();
    }

    resetToStation() {
      this.clearTimers();
      this.setState(STATE.IDLE);
      this.currentRequest = null;
      this.healthcareLegMeters = 0;
      this.requestMeta = null;
      if (this.shuttleRouteGraphic) this.shuttleLayer.remove(this.shuttleRouteGraphic);
      this.shuttleRouteGraphic = null;
      if (this.shuttleGraphic) {
        this.shuttleGraphic.geometry = this.withElevation({
          type: "point",
          longitude: STATION.longitude,
          latitude: STATION.latitude,
          spatialReference: { wkid: 4326 }
        });
        this.applyShuttleVisual(false);
      }
      if (this.shuttleFallbackGraphic) {
        this.shuttleFallbackGraphic.geometry = this.withElevation({
          type: "point",
          longitude: STATION.longitude,
          latitude: STATION.latitude,
          spatialReference: { wkid: 4326 }
        });
        this.shuttleFallbackGraphic.visible = true;
      }
      window.shuttleCurrentRoute = null;
      window.shuttleAnimationState = null;
      this.modalMuted = false;
    }

    cancelRequest() {
      this.clearTimers();
      this.setState(STATE.IDLE);
      this.currentRequest = null;
      this.healthcareLegMeters = 0;
      this.requestMeta = null;
      if (this.shuttleRouteGraphic) this.shuttleLayer.remove(this.shuttleRouteGraphic);
      this.shuttleRouteGraphic = null;
      if (this.shuttleGraphic) {
        this.shuttleGraphic.geometry = this.withElevation({
          type: "point",
          longitude: STATION.longitude,
          latitude: STATION.latitude,
          spatialReference: { wkid: 4326 }
        });
        this.applyShuttleVisual(false);
      }
      if (this.shuttleFallbackGraphic) {
        this.shuttleFallbackGraphic.geometry = this.withElevation({
          type: "point",
          longitude: STATION.longitude,
          latitude: STATION.latitude,
          spatialReference: { wkid: 4326 }
        });
        this.shuttleFallbackGraphic.visible = true;
      }
      window.shuttleCurrentRoute = null;
      window.shuttleAnimationState = null;
      this.hideModal();
    }

    pause(ms) {
      return new Promise((resolve) => {
        this.pauseTimer = setTimeout(resolve, ms);
      });
    }

    formatRequestMeta() {
      if (!this.requestMeta) return "";
      const { name, phone, customerId, orderId, calledAt, pickup } = this.requestMeta;
      const lat = pickup?.latitude ?? pickup?.y;
      const lon = pickup?.longitude ?? pickup?.x;
      const coordLine = (Number.isFinite(lat) && Number.isFinite(lon))
        ? `${lat.toFixed(5)}, ${lon.toFixed(5)}`
        : "—";
      const timeLine = calledAt
        ? calledAt.toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "—";
      return {
        name,
        phone,
        customerId,
        orderId,
        coordLine,
        timeLine
      };
    }

    formatStatusMessage(lines, meta) {
      const safeLines = (lines || []).filter(Boolean);
      if (!meta) return safeLines.join("\n");
      return [
        safeLines.join("\n"),
        "",
        `Namn: ${meta.name}`,
        `Kundnummer: ${meta.customerId}`,
        `Order: ${meta.orderId}`,
        `Adress: ${meta.coordLine}`,
        `Telefon nr.: ${meta.phone}`,
        `Called shuttle time/date: ${meta.timeLine}`
      ].join("\n");
    }

    toModalHtml(message) {
      const text = String(message || "");
      const lines = text.split("\n");
      const topLines = [];
      const metaLines = [];
      let inMeta = false;
      for (const line of lines) {
        if (!line && !inMeta) {
          inMeta = true;
          continue;
        }
        if (!inMeta) {
          topLines.push(line);
        } else if (line) {
          metaLines.push(line);
        }
      }
      const topHtml = topLines.map((l) => `<div class="shuttle-line">${this.escapeHtml(l)}</div>`).join("");
      const metaHtml = metaLines.length
        ? `<div class="shuttle-meta">${metaLines.map((l) => `<div>${this.escapeHtml(l)}</div>`).join("")}</div>`
        : "";
      return `${topHtml}${metaHtml}`;
    }

    escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    generateOrderId() {
      const year = new Date().getFullYear();
      const rand = Math.floor(1000 + Math.random() * 9000);
      return `ORD-${year}-${rand}`;
    }

    async snapToRoad(point) {
      const lon = point.longitude ?? point.x;
      const lat = point.latitude ?? point.y;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return point;
      const url = `https://router.project-osrm.org/nearest/v1/driving/${lon},${lat}?number=1`;
      try {
        const res = await fetch(url);
        if (!res.ok) return point;
        const data = await res.json();
        const loc = data?.waypoints?.[0]?.location;
        if (Array.isArray(loc) && loc.length >= 2) {
          return { longitude: loc[0], latitude: loc[1] };
        }
      } catch (e) {
        return point;
      }
      return point;
    }

    async fetchRoute(start, end) {
      const sSnap = await this.snapToRoad(start);
      const eSnap = await this.snapToRoad(end);
      const sLon = sSnap.longitude ?? sSnap.x;
      const sLat = sSnap.latitude ?? sSnap.y;
      const eLon = eSnap.longitude ?? eSnap.x;
      const eLat = eSnap.latitude ?? eSnap.y;
      const url = `https://router.project-osrm.org/route/v1/driving/${sLon},${sLat};${eLon},${eLat}?overview=full&geometries=geojson&alternatives=false`;
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        const route = data?.routes?.[0];
        const coords = route?.geometry?.coordinates;
        if (!coords || coords.length < 2) return null;
        const routeCoords = coords
          .map((c) => [Number(c[0]), Number(c[1])])
          .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
        if (routeCoords.length < 2) return null;

        const startCoord = lonLatFromPoint(start);
        const endCoord = lonLatFromPoint(end);
        const first = routeCoords[0];
        const last = routeCoords[routeCoords.length - 1];
        if (startCoord && (Math.abs(first[0] - startCoord[0]) > 1e-7 || Math.abs(first[1] - startCoord[1]) > 1e-7)) {
          routeCoords.unshift(startCoord);
        }
        if (endCoord && (Math.abs(last[0] - endCoord[0]) > 1e-7 || Math.abs(last[1] - endCoord[1]) > 1e-7)) {
          routeCoords.push(endCoord);
        }
        return routeCoords;
      } catch (e) {
        return null;
      }
    }

    async driveRoute(coords, color, onTick) {
      this.clearTimers();
      if (typeof this.map.reorder === "function") {
        this.map.reorder(this.shuttleLayer, this.map.layers.length - 1);
        this.debugLog("[shuttle] shuttleLayer reordered to top");
      }
      if (this.shuttleRouteGraphic) this.shuttleLayer.remove(this.shuttleRouteGraphic);

      const polyline = new this.Polyline({ paths: [coords], spatialReference: { wkid: 4326 } });
      if (SHOW_SHUTTLE_ROUTE) {
        this.shuttleRouteGraphic = new this.Graphic({
          geometry: polyline,
          symbol: { type: "simple-line", color: color || "#2563eb", width: 3 }
        });
        this.shuttleLayer.add(this.shuttleRouteGraphic);
      } else {
        this.shuttleRouteGraphic = null;
      }
      this.debugLog("[shuttle] driveRoute started");

      const sampler = buildSampler(this.Polyline, this.webMercatorUtils, coords);
      if (!sampler) return;

      const totalMeters = sampler.total;
      const speedAtDistance = (distMeters) => {
        const dist = Math.max(0, Math.min(totalMeters, distMeters));
        const remaining = Math.max(0, totalMeters - dist);
        const accelLimit = Math.sqrt(Math.max(0, 2 * ACCEL_MPS2 * dist));
        const decelLimit = Math.sqrt(Math.max(0, 2 * DECEL_MPS2 * remaining));
        const wave = 0.5 + 0.5 * Math.sin((dist / CRUISE_WAVE_METERS) * Math.PI * 2);
        const cruiseTarget = CRUISE_MIN_MPS + wave * (CRUISE_MAX_MPS - CRUISE_MIN_MPS);
        return Math.max(0, Math.min(accelLimit, decelLimit, cruiseTarget));
      };
      const estimateRemainingSeconds = (startDist) => {
        let s = Math.max(0, Math.min(totalMeters, startDist));
        let secs = 0;
        const stepMeters = 8;
        while (s < totalMeters) {
          const speed = Math.max(0.5, speedAtDistance(s));
          const ds = Math.min(stepMeters, totalMeters - s);
          secs += ds / speed;
          s += ds;
          if (secs > 6 * 3600) break;
        }
        return secs;
      };
      let distNow = 0;
      let speedNow = 0;
      const totalSeconds = estimateRemainingSeconds(0);
      const remainingAtNow = () => {
        const remaining = Math.max(0, totalMeters - distNow);
        return {
          dist: distNow,
          remaining,
          remainingSeconds: estimateRemainingSeconds(distNow)
        };
      };

      window.shuttleCurrentRoute = polyline;
      window.shuttleAnimationState = {
        totalMeters,
        totalSeconds,
        currentMeters: 0,
        currentSpeedMps: 0,
        currentState: this.currentState
      };
      this.applyShuttleVisual(true);

      if (typeof onTick === "function") {
        const firstTick = remainingAtNow();
        onTick(firstTick.remaining, firstTick.remainingSeconds);
        this.countdownTimer = setInterval(() => {
          const status = remainingAtNow();
          onTick(status.remaining, status.remainingSeconds);
        }, 1000);
      }

      await new Promise((resolve) => {
        let lastFrame = performance.now();
        const step = (now) => {
          const dt = Math.max(0, Math.min(0.2, (now - lastFrame) / 1000));
          lastFrame = now;
          speedNow = speedAtDistance(distNow);
          distNow = Math.min(totalMeters, distNow + speedNow * dt);
          const pt = sampler.toGeo(distNow);
          if (pt && this.shuttleGraphic) {
            const lon = pt.longitude ?? pt.x;
            const lat = pt.latitude ?? pt.y;
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
              this.debugLog("[shuttle] invalid sampled point, skipping tick");
              this.animation = requestAnimationFrame(step);
              return;
            }
            const nextPoint = this.withElevation({
              type: "point",
              longitude: lon,
              latitude: lat,
              spatialReference: { wkid: 4326 }
            });
            this.shuttleGraphic.geometry = nextPoint;
            this.shuttleGraphic.visible = true;
            if (this.shuttleFallbackGraphic) {
              this.shuttleFallbackGraphic.geometry = nextPoint;
              this.shuttleFallbackGraphic.visible = true;
            }
            this.debugTick(pt);
          }
          if (this.view && typeof this.view.requestRender === "function") {
            this.view.requestRender();
          }
          window.shuttleAnimationState.currentMeters = distNow;
          window.shuttleAnimationState.currentSpeedMps = speedNow;
          if (distNow >= totalMeters) {
            window.shuttleAnimationState.currentMeters = totalMeters;
            window.shuttleAnimationState.currentSpeedMps = 0;
            resolve();
            return;
          }
          this.animation = requestAnimationFrame(step);
        };
        this.animation = requestAnimationFrame(step);
      });

      this.clearTimers();
    }

    withElevation(point) {
      if (!point) return point;
      // Keep the marker draped to ground for reliable visibility in 2D/3D.
      // Still prime elevation in the background for future use/debug.
      this.primeElevation(point);
      return point;
    }

    buildShuttleSymbol3D({ moving }) {
      const size = moving ? 10 : 10;
      return {
        type: "point-3d",
        verticalOffset: { screenLength: 30, maxWorldLength: 60, minWorldLength: 10 },
        symbolLayers: [{
          type: "icon",
          resource: { primitive: "circle" },
          size,
          material: { color: [37, 99, 235, 0.98] },
          outline: { color: [255, 255, 255, 0.95], size: 1 }
        }]
      };
    }

    buildShuttleSymbol2D({ moving }) {
      const size = moving ? 8 : 8;
      return {
        type: "simple-marker",
        style: "circle",
        color: [37, 99, 235, 0.98],
        size,
        outline: { color: [255, 255, 255, 0.95], width: 1 }
      };
    }

    buildShuttleFallback2D({ moving }) {
      return {
        type: "simple-marker",
        style: "circle",
        color: [251, 191, 36, 0.95],
        size: moving ? 5 : 5,
        outline: { color: [15, 23, 42, 0.9], width: 1 }
      };
    }

    buildShuttleFallback3D({ moving }) {
      return {
        type: "point-3d",
        verticalOffset: { screenLength: 44, maxWorldLength: 84, minWorldLength: 18 },
        symbolLayers: [{
          type: "icon",
          resource: { primitive: "circle" },
          size: moving ? 6 : 6,
          material: { color: [251, 191, 36, 0.98] },
          outline: { color: [15, 23, 42, 0.95], size: 0.8 }
        }]
      };
    }

    buildShuttleFallbackSymbol({ moving }) {
      const is3d = this.view && this.view.type === "3d";
      return is3d
        ? this.buildShuttleFallback3D({ moving })
        : this.buildShuttleFallback2D({ moving });
    }

    debugTick(point) {
      if (!SHUTTLE_DEBUG) return;
      const now = performance.now();
      if (now - this.lastDebugLog < 1000) return;
      this.lastDebugLog = now;
      const lon = point?.longitude ?? point?.x;
      const lat = point?.latitude ?? point?.y;
      const visible = this.shuttleGraphic ? this.shuttleGraphic.visible : false;
      console.log(`[shuttle] x=${lon?.toFixed?.(6) ?? lon}, y=${lat?.toFixed?.(6) ?? lat}, state=${this.currentState}, visible=${visible}`);
    }

    debugLog(message) {
      if (!SHUTTLE_DEBUG) return;
      console.log(message);
    }

    sampleElevation(point) {
      const sampler = this.elevationSampler;
      if (sampler && this.webMercatorUtils) {
        const sr = point.spatialReference;
        let wmPoint = point;
        if (sr && (sr.isWGS84 || sr.wkid === 4326)) {
          wmPoint = this.webMercatorUtils.geographicToWebMercator(point);
        }
        try {
          const sampled = sampler.sample(wmPoint);
          const z = sampled?.z ?? sampled?.geometry?.z;
          if (Number.isFinite(z)) return z;
        } catch (e) {
          // fall back to cache
        }
      }
      const key = this.elevationKey(point);
      const cached = this.elevationCache.get(key);
      return Number.isFinite(cached) ? cached : null;
    }

    primeElevation(point) {
      const now = performance.now();
      if (now - this.lastElevationRequest < 500) return;
      this.lastElevationRequest = now;
      const key = this.elevationKey(point);
      if (this.elevationCache.has(key)) return;
      const lon = point.longitude ?? point.x;
      const lat = point.latitude ?? point.y;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      if (window.ElevationProvider && typeof window.ElevationProvider.getElevation === "function") {
        window.ElevationProvider.getElevation(lat, lon).then((z) => {
          if (Number.isFinite(z)) this.elevationCache.set(key, z);
        }).catch(() => {});
      }
    }

    elevationKey(point) {
      const lon = point.longitude ?? point.x;
      const lat = point.latitude ?? point.y;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "0,0";
      return `${lat.toFixed(5)},${lon.toFixed(5)}`;
    }
  }

  window.initShuttleSim = function initShuttleSim({ view, map, GraphicsLayer, Graphic, Polyline, geometryEngine, webMercatorUtils }) {
    if (window.ShuttleController) return;
    const controller = new ShuttleController({ view, map, GraphicsLayer, Graphic, Polyline, geometryEngine, webMercatorUtils });
    window.ShuttleController = controller;
    window.requestShuttleToPickup = (pickupPoint) => controller.requestPickup(pickupPoint);

    const closeBtn = document.getElementById("shuttleClose");
    if (closeBtn) closeBtn.addEventListener("click", () => controller.hideModal());
  };
})();
