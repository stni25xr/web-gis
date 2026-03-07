(() => {
  const SHUTTLE_ID = "shuttle-1";
  const SHUTTLE_TYPE = "electric shuttle";
  const SPEED_MPS = 11.11;
  const STATION = { latitude: 57.77101, longitude: 14.26968 };
  const HEALTHCARE = { latitude: 57.77468, longitude: 14.26546 };

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
      + "<rect x='10' y='16' width='44' height='26' rx='8' fill='#0f172a'/>"
      + "<rect x='14' y='20' width='30' height='12' rx='4' fill='#e2e8f0'/>"
      + "<rect x='46' y='20' width='8' height='12' rx='3' fill='#38bdf8'/>"
      + "<circle cx='22' cy='46' r='6' fill='#0f172a'/>"
      + "<circle cx='42' cy='46' r='6' fill='#0f172a'/>"
      + "<circle cx='22' cy='46' r='3' fill='#94a3b8'/>"
      + "<circle cx='42' cy='46' r='3' fill='#94a3b8'/>"
      + "<path d='M50 40 l8 6 -8 6' fill='none' stroke='#38bdf8' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/>"
      + "</svg>"
    );
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

      this.currentState = STATE.IDLE;
      this.currentRequest = null;
      this.shuttleGraphic = null;
      this.shuttleRouteGraphic = null;
      this.shuttleLayer = new GraphicsLayer({ elevationInfo: { mode: "relative-to-ground", offset: 1.7 } });
      this.map.add(this.shuttleLayer);
      this.animation = null;
      this.countdownTimer = null;
      this.pauseTimer = null;

      this.initMarker();

      window.shuttleGraphic = this.shuttleGraphic;
      window.shuttleCurrentRoute = null;
      window.shuttleAnimationState = null;
    }

    initMarker() {
      const icon = createShuttleIcon();
      this.shuttleGraphic = new this.Graphic({
        geometry: {
          type: "point",
          longitude: STATION.longitude,
          latitude: STATION.latitude,
          spatialReference: { wkid: 4326 }
        },
        attributes: {
          id: SHUTTLE_ID,
          type: SHUTTLE_TYPE
        },
        symbol: {
          type: "picture-marker",
          url: icon,
          width: 20,
          height: 20
        }
      });
      this.shuttleLayer.add(this.shuttleGraphic);
    }

    showModal(title, message) {
      const modal = document.getElementById("shuttleModal");
      const titleEl = document.getElementById("shuttleTitle");
      const msgEl = document.getElementById("shuttleMessage");
      if (titleEl) titleEl.textContent = title;
      if (msgEl) msgEl.textContent = message;
      if (modal) modal.style.display = "flex";
    }

    hideModal() {
      const modal = document.getElementById("shuttleModal");
      if (modal) modal.style.display = "none";
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
    }

    async requestPickup(pickupPoint) {
      if (this.isBusy()) {
        this.showModal("Shuttle", "Shuttlen är redan upptagen. Försök igen om en stund.");
        return false;
      }
      const geo = toGeoPoint(pickupPoint, this.webMercatorUtils);
      if (!geo) return false;
      this.currentRequest = { pickup: geo };
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
        this.showModal("Shuttle bokad", `${line1}\n${line2}\n${line3}`);
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
      await this.driveRoute(route, "#22c55e");
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
      await this.driveRoute(route, "#94a3b8");
      this.resetToStation();
    }

    resetToStation() {
      this.clearTimers();
      this.setState(STATE.IDLE);
      this.currentRequest = null;
      if (this.shuttleRouteGraphic) this.shuttleLayer.remove(this.shuttleRouteGraphic);
      this.shuttleRouteGraphic = null;
      if (this.shuttleGraphic) {
        this.shuttleGraphic.geometry = {
          type: "point",
          longitude: STATION.longitude,
          latitude: STATION.latitude,
          spatialReference: { wkid: 4326 }
        };
      }
      window.shuttleCurrentRoute = null;
      window.shuttleAnimationState = null;
    }

    pause(ms) {
      return new Promise((resolve) => {
        this.pauseTimer = setTimeout(resolve, ms);
      });
    }

    async fetchRoute(start, end) {
      const sLon = start.longitude ?? start.x;
      const sLat = start.latitude ?? start.y;
      const eLon = end.longitude ?? end.x;
      const eLat = end.latitude ?? end.y;
      const url = `https://router.project-osrm.org/route/v1/driving/${sLon},${sLat};${eLon},${eLat}?overview=full&geometries=geojson&alternatives=false`;
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        const route = data?.routes?.[0];
        const coords = route?.geometry?.coordinates;
        if (!coords || coords.length < 2) return null;
        return coords;
      } catch (e) {
        return null;
      }
    }

    async driveRoute(coords, color, onTick) {
      this.clearTimers();
      if (this.shuttleRouteGraphic) this.shuttleLayer.remove(this.shuttleRouteGraphic);

      const polyline = new this.Polyline({ paths: [coords], spatialReference: { wkid: 4326 } });
      this.shuttleRouteGraphic = new this.Graphic({
        geometry: polyline,
        symbol: { type: "simple-line", color: color || "#2563eb", width: 3 }
      });
      this.shuttleLayer.add(this.shuttleRouteGraphic);

      const sampler = buildSampler(this.Polyline, this.webMercatorUtils, coords);
      if (!sampler) return;

      const totalMeters = sampler.total;
      const totalSeconds = totalMeters / SPEED_MPS;
      const startTime = performance.now();
      let lastDist = 0;

      window.shuttleCurrentRoute = polyline;
      window.shuttleAnimationState = {
        totalMeters,
        totalSeconds,
        currentMeters: 0,
        currentState: this.currentState
      };

      if (typeof onTick === "function") {
        this.countdownTimer = setInterval(() => {
          const remaining = Math.max(0, totalMeters - lastDist);
          const remainingSeconds = remaining / SPEED_MPS;
          onTick(remaining, remainingSeconds);
        }, 1000);
      }

      await new Promise((resolve) => {
        const step = () => {
          const elapsed = (performance.now() - startTime) / 1000;
          const dist = Math.min(totalMeters, elapsed * SPEED_MPS);
          lastDist = dist;
          const pt = sampler.toGeo(dist);
          if (pt && this.shuttleGraphic) {
            this.shuttleGraphic.geometry = {
              type: "point",
              longitude: pt.longitude,
              latitude: pt.latitude,
              spatialReference: { wkid: 4326 }
            };
          }
          window.shuttleAnimationState.currentMeters = dist;
          if (dist >= totalMeters) {
            resolve();
            return;
          }
          this.animation = requestAnimationFrame(step);
        };
        this.animation = requestAnimationFrame(step);
      });

      this.clearTimers();
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
