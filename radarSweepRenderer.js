(() => {
  const DEG2RAD = Math.PI / 180;
  const COLOR = [255, 140, 0, 0.22];
  const DEFAULT_MAX_RAY_DISTANCE = 200;
  const DEFAULT_RAY_STEP_METERS = 2;
  const DEFAULT_RAY_ANGLE_STEP_DEG = 5;
  const STEP_METERS_DEFAULT = 50;
  const RADAR_CENTER_OFFSET_M = 1.7;
  const SWEEP_STEP_DEG = 10;

  let rendererInstance = null;
  let activeView = null;
  let fixedRendererInstance = null;
  let fixedActiveView = null;

  function ensureRadarBadge() {
    let badge = document.getElementById("radarStatusBadge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "radarStatusBadge";
      badge.style.cssText = "position:fixed;top:12px;left:16px;z-index:9999;background:#0f172a;color:#fff;padding:6px 10px;border-radius:8px;font:600 12px/1.2 system-ui, sans-serif;box-shadow:0 4px 10px rgba(0,0,0,0.2);";
      document.body.appendChild(badge);
    }
    return badge;
  }

  function setRadarBadge(state) {
    const badge = ensureRadarBadge();
    if (!badge) return;
    badge.textContent = state ? "RADAR: ON" : "RADAR: OFF";
    badge.style.background = state ? "#ff8c00" : "#0f172a";
  }

  function showRadarToast(message) {
    let toast = document.getElementById("radarToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "radarToast";
      toast.style.cssText = "position:fixed;top:52px;left:16px;z-index:9999;background:#fff3cd;color:#7c2d12;padding:8px 10px;border-radius:8px;font:600 12px/1.2 system-ui, sans-serif;border:1px solid rgba(124,45,18,0.25);box-shadow:0 4px 10px rgba(0,0,0,0.15);";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = "1";
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.style.opacity = "0";
    }, 2500);
  }

  function distanceMeters(a, b) {
    const R = 6371000;
    const lat1 = (a.y ?? a.latitude) * DEG2RAD;
    const lat2 = (b.y ?? b.latitude) * DEG2RAD;
    const dLat = lat2 - lat1;
    const dLon = ((b.x ?? b.longitude) - (a.x ?? a.longitude)) * DEG2RAD;
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function destinationLatLon(lat, lon, bearingRad, distanceMetersValue) {
    const R = 6371000;
    const lat1r = lat * DEG2RAD;
    const lon1r = lon * DEG2RAD;
    const dr = distanceMetersValue / R;
    const sinLat1 = Math.sin(lat1r);
    const cosLat1 = Math.cos(lat1r);
    const sinDr = Math.sin(dr);
    const cosDr = Math.cos(dr);
    const sinLat2 = sinLat1 * cosDr + cosLat1 * sinDr * Math.cos(bearingRad);
    const lat2r = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
    const lon2r = lon1r + Math.atan2(
      Math.sin(bearingRad) * sinDr * cosLat1,
      cosDr - sinLat1 * Math.sin(lat2r)
    );
    return { lat: (lat2r / DEG2RAD), lon: (lon2r / DEG2RAD) };
  }

  function buildStationsFromPolyline(view, webMercatorUtils, polyline, stepMeters) {
    if (!polyline?.paths?.length) return [];
    const step = Math.max(1, stepMeters || STEP_METERS_DEFAULT);
    const path = polyline.paths[0];
    if (!path || path.length < 2) return [];

    const stations = [];
    let carry = 0;
    let prev = { x: path[0][0], y: path[0][1], spatialReference: polyline.spatialReference || view.spatialReference };
    stations.push(prev);

    for (let i = 1; i < path.length; i++) {
      const next = { x: path[i][0], y: path[i][1], spatialReference: polyline.spatialReference || view.spatialReference };
      let seg = distanceMeters(prev, next);
      if (!isFinite(seg) || seg <= 0) {
        prev = next;
        continue;
      }
      while (carry + seg >= step) {
        const t = (step - carry) / seg;
        const x = prev.x + (next.x - prev.x) * t;
        const y = prev.y + (next.y - prev.y) * t;
        const pt = { x, y, spatialReference: prev.spatialReference };
        stations.push(pt);
        seg -= (step - carry);
        prev = pt;
        carry = 0;
      }
      carry += seg;
      prev = next;
    }
    if (stations.length === 1) {
      const last = { x: path[path.length - 1][0], y: path[path.length - 1][1], spatialReference: polyline.spatialReference || view.spatialReference };
      stations.push(last);
    }
    return stations;
  }

  class VisibilityRenderer {
    constructor(view, externalRenderers) {
      this.view = view;
      this.externalRenderers = externalRenderers;
      this.center = null;
      this._gl = null;
      this._program = null;
      this._buffer = null;
      this._aPos = -1;
      this._uView = null;
      this._uProj = null;
      this._uColor = null;
      this._renderPositions = null;
      this._localPositions = null;
      this._vertexCount = 0;
      this._running = false;
      this._stations = [];
      this._stationIndex = 0;
      this._stepMode = false;
      this._sweepAngleDeg = 0;
      this._rayAnglesDeg = [];
      this._rayDistances = null;
      this._raysReady = false;
      this._raysComputing = false;
      this._lastGroundZ = null;
      this._eyeZ = RADAR_CENTER_OFFSET_M;
      this._Point = null;
      this._webMercatorUtils = null;
      this._rayAngleStepDeg = DEFAULT_RAY_ANGLE_STEP_DEG;
      this._rayStepMeters = DEFAULT_RAY_STEP_METERS;
      this._maxRayDistance = DEFAULT_MAX_RAY_DISTANCE;
      this._eyeOffsetMeters = RADAR_CENTER_OFFSET_M;
    }

    setGeoHelpers(Point, webMercatorUtils) {
      this._Point = Point || this._Point;
      this._webMercatorUtils = webMercatorUtils || this._webMercatorUtils;
    }

    setVisibilityConfig({ stepMeters, eyeOffsetMeters, maxRayDistanceMeters, rayStepMeters, rayAngleStepDeg }) {
      if (Number.isFinite(stepMeters)) this._stepMeters = stepMeters;
      if (Number.isFinite(eyeOffsetMeters)) this._eyeOffsetMeters = eyeOffsetMeters;
      if (Number.isFinite(maxRayDistanceMeters)) this._maxRayDistance = maxRayDistanceMeters;
      if (Number.isFinite(rayStepMeters)) this._rayStepMeters = rayStepMeters;
      if (Number.isFinite(rayAngleStepDeg)) this._rayAngleStepDeg = rayAngleStepDeg;
      this._rayAnglesDeg = [];
      this._rayDistances = null;
      this._raysReady = false;
    }

    setCenter(point) {
      this.center = point;
    }

    setStations(stations) {
      this._stations = Array.isArray(stations) ? stations : [];
      this._stationIndex = 0;
      this._sweepAngleDeg = 0;
      if (this._stations.length) {
        this._prepareStation();
      }
    }

    enableStepScan(enabled) {
      this._stepMode = !!enabled;
    }

    start() {
      this._running = true;
    }

    stop() {
      this._running = false;
    }

    setup(context) {
      const gl = context.gl;
      this._gl = gl;

      const vsSource = `
        precision mediump float;
        attribute vec3 a_position;
        uniform mat4 u_view;
        uniform mat4 u_proj;
        void main() {
          gl_Position = u_proj * u_view * vec4(a_position, 1.0);
        }
      `;
      const fsSource = `
        precision mediump float;
        uniform vec4 u_color;
        void main() {
          gl_FragColor = u_color;
        }
      `;

      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
      };

      const vs = compile(gl.VERTEX_SHADER, vsSource);
      const fs = compile(gl.FRAGMENT_SHADER, fsSource);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      this._program = program;
      this._aPos = gl.getAttribLocation(program, "a_position");
      this._uView = gl.getUniformLocation(program, "u_view");
      this._uProj = gl.getUniformLocation(program, "u_proj");
      this._uColor = gl.getUniformLocation(program, "u_color");
      this._buffer = gl.createBuffer();
    }

    _ensureRayAngles() {
      if (this._rayAnglesDeg.length) return;
      const step = Math.max(1, this._rayAngleStepDeg || DEFAULT_RAY_ANGLE_STEP_DEG);
      const angles = [];
      for (let a = 0; a < 360; a += step) angles.push(a);
      this._rayAnglesDeg = angles;
    }

    _buildLocalFanGeometry(sweepAngleDeg) {
      if (!this.center) return false;
      this._ensureRayAngles();
      const totalRays = this._rayAnglesDeg.length;
      if (!totalRays) return false;

      const endIndex = Math.max(1, Math.min(totalRays, Math.floor(sweepAngleDeg / this._rayAngleStepDeg)));
      const verts = [];
      const center = [0, 0, 0];

      const getDist = (idx) => {
        if (this._rayDistances && Number.isFinite(this._rayDistances[idx])) return this._rayDistances[idx];
        return this._maxRayDistance || DEFAULT_MAX_RAY_DISTANCE;
      };

      const points = [];
      for (let i = 0; i <= endIndex; i++) {
        const angleDeg = this._rayAnglesDeg[i % totalRays];
        const ang = angleDeg * DEG2RAD;
        const dist = getDist(i % totalRays);
        points.push([Math.cos(ang) * dist, Math.sin(ang) * dist, 0]);
      }

      for (let i = 0; i < points.length - 1; i++) {
        verts.push(center[0], center[1], center[2]);
        verts.push(points[i][0], points[i][1], points[i][2]);
        verts.push(points[i + 1][0], points[i + 1][1], points[i + 1][2]);
      }

      this._localPositions = new Float32Array(verts);
      this._vertexCount = this._localPositions.length / 3;
      return true;
    }

    _transformLocalToRender(matrix, x, y, z, out, offset) {
      const m = matrix;
      const rx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const ry = m[1] * x + m[5] * y + m[9] * z + m[13];
      const rz = m[2] * x + m[6] * y + m[10] * z + m[14];
      out[offset] = rx;
      out[offset + 1] = ry;
      out[offset + 2] = rz;
    }

    render(context) {
      const gl = context.gl;
      if (!this.center || !this._running) return;

      if (this._stepMode && this._stations.length) {
        if (this._stationIndex >= this._stations.length) {
          this._running = false;
          setRadarBadge(false);
          return;
        }
        if (!this._raysReady && !this._raysComputing) {
          this._prepareStation();
          return;
        }
      } else if (!this._raysReady && !this._raysComputing) {
        this._prepareStation();
      }

      const sweepDeg = this._raysReady ? this._sweepAngleDeg : 0;
      if (!this._buildLocalFanGeometry(sweepDeg)) return;

      if (!this._renderPositions || this._renderPositions.length !== this._localPositions.length) {
        this._renderPositions = new Float32Array(this._localPositions.length);
      }

      const origin = [this.center.x, this.center.y, this._eyeZ || this.center.z || 0];
      const transform = new Float32Array(16);
      this.externalRenderers.renderCoordinateTransformAt(
        this.view,
        origin,
        this.center.spatialReference || this.view.spatialReference,
        transform
      );

      for (let i = 0; i < this._localPositions.length; i += 3) {
        this._transformLocalToRender(
          transform,
          this._localPositions[i],
          this._localPositions[i + 1],
          this._localPositions[i + 2],
          this._renderPositions,
          i
        );
      }

      gl.useProgram(this._program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this._renderPositions, gl.DYNAMIC_DRAW);

      gl.enableVertexAttribArray(this._aPos);
      gl.vertexAttribPointer(this._aPos, 3, gl.FLOAT, false, 0, 0);

      gl.uniformMatrix4fv(this._uView, false, context.camera.viewMatrix);
      gl.uniformMatrix4fv(this._uProj, false, context.camera.projectionMatrix);
      gl.uniform4fv(this._uColor, [COLOR[0] / 255, COLOR[1] / 255, COLOR[2] / 255, COLOR[3]]);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);

      gl.drawArrays(gl.TRIANGLES, 0, this._vertexCount);

      gl.depthMask(true);
      context.resetWebGLState();
      this.externalRenderers.requestRender(this.view);

      if (this._raysReady) {
        this._sweepAngleDeg += SWEEP_STEP_DEG;
        if (this._sweepAngleDeg >= 360) {
          this._sweepAngleDeg = 0;
          if (this._stepMode) {
            this._stationIndex += 1;
            if (this._stationIndex >= this._stations.length) {
              this._running = false;
              setRadarBadge(false);
              return;
            }
            this._prepareStation();
          }
        }
      }
    }

    dispose() {
      const gl = this._gl;
      if (!gl) return;
      if (this._buffer) gl.deleteBuffer(this._buffer);
      if (this._program) gl.deleteProgram(this._program);
    }

    _prepareStation() {
      if (!this._stations.length) return;
      this.center = this._stations[this._stationIndex];
      this._sweepAngleDeg = 0;
      this._rayDistances = null;
      this._raysReady = false;
      this._updateEyeAndRays();
    }

    async _updateEyeAndRays() {
      if (!this.center) return;
      this._raysComputing = true;
      let groundZ = null;
      try {
        groundZ = await this._getGroundZForPoint(this.center);
      } catch (e) {
        groundZ = null;
      }
      if (Number.isFinite(groundZ)) {
        this._lastGroundZ = groundZ;
      }
      const baseGround = Number.isFinite(this._lastGroundZ) ? this._lastGroundZ : 0;
      this._eyeZ = baseGround + (Number.isFinite(this._eyeOffsetMeters) ? this._eyeOffsetMeters : RADAR_CENTER_OFFSET_M);
      window.__radarUpdateDebug?.(Number.isFinite(this._lastGroundZ) ? this._lastGroundZ : null, this._eyeZ);
      this._rayDistances = await this._computeRayDistances(this.center, this._eyeZ);
      this._raysReady = true;
      this._raysComputing = false;
    }

    async _getGroundZForPoint(pointLike) {
      if (!pointLike) return null;
      if (typeof window.__getRadarGroundZ === "function") {
        const z = await window.__getRadarGroundZ(pointLike);
        return Number.isFinite(z) ? z : null;
      }
      return null;
    }

    async _computeRayDistances(center, eyeZ) {
      this._ensureRayAngles();
      const rayDistances = new Array(this._rayAnglesDeg.length).fill(this._maxRayDistance || DEFAULT_MAX_RAY_DISTANCE);
      const originLon = center.longitude ?? center.x;
      const originLat = center.latitude ?? center.y;
      if (!isFinite(originLon) || !isFinite(originLat)) return rayDistances;

      const maxDist = this._maxRayDistance || DEFAULT_MAX_RAY_DISTANCE;
      const step = Math.max(1, this._rayStepMeters || DEFAULT_RAY_STEP_METERS);
      for (let i = 0; i < this._rayAnglesDeg.length; i++) {
        const angleDeg = this._rayAnglesDeg[i];
        const angleRad = angleDeg * DEG2RAD;
        let hitDist = maxDist;
        for (let d = step; d <= maxDist; d += step) {
          const pos = destinationLatLon(originLat, originLon, angleRad, d);
          let terrainZ = null;
          if (typeof window.__getRadarGroundZ === "function") {
            terrainZ = await window.__getRadarGroundZ({ longitude: pos.lon, latitude: pos.lat, spatialReference: { wkid: 4326 } });
          }
          if (Number.isFinite(terrainZ) && terrainZ > eyeZ) {
            hitDist = d;
            break;
          }
        }
        rayDistances[i] = hitDist;
      }
      return rayDistances;
    }
  }

  class FixedVisibilityRenderer {
    constructor(view, externalRenderers) {
      this.view = view;
      this.externalRenderers = externalRenderers;
      this.center = null;
      this.eyeZ = RADAR_CENTER_OFFSET_M;
      this.lengths = null;
      this._gl = null;
      this._program = null;
      this._buffer = null;
      this._aPos = -1;
      this._uView = null;
      this._uProj = null;
      this._uColor = null;
      this._renderPositions = null;
      this._localPositions = null;
      this._vertexCount = 0;
    }

    setup(context) {
      const gl = context.gl;
      this._gl = gl;

      const vsSource = `
        precision mediump float;
        attribute vec3 a_position;
        uniform mat4 u_view;
        uniform mat4 u_proj;
        void main() {
          gl_Position = u_proj * u_view * vec4(a_position, 1.0);
        }
      `;
      const fsSource = `
        precision mediump float;
        uniform vec4 u_color;
        void main() {
          gl_FragColor = u_color;
        }
      `;

      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
      };

      const vs = compile(gl.VERTEX_SHADER, vsSource);
      const fs = compile(gl.FRAGMENT_SHADER, fsSource);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      this._program = program;
      this._aPos = gl.getAttribLocation(program, "a_position");
      this._uView = gl.getUniformLocation(program, "u_view");
      this._uProj = gl.getUniformLocation(program, "u_proj");
      this._uColor = gl.getUniformLocation(program, "u_color");
      this._buffer = gl.createBuffer();
    }

    setData({ center, eyeZ, lengths }) {
      this.center = center;
      this.eyeZ = eyeZ;
      this.lengths = lengths;
      this._buildLocalGeometry();
    }

    _buildBeamRect(x1, y1, x2, y2, z) {
      return [
        x1, y1, z,
        x2, y1, z,
        x2, y2, z,
        x1, y1, z,
        x2, y2, z,
        x1, y2, z
      ];
    }

    _buildLocalGeometry() {
      if (!this.lengths) return false;
      const width = 3;
      const half = width / 2;
      const z = 0;
      const n = Math.max(1, this.lengths.N || 0);
      const e = Math.max(1, this.lengths.E || 0);
      const s = Math.max(1, this.lengths.S || 0);
      const w = Math.max(1, this.lengths.W || 0);

      const verts = [];
      // North (+Y)
      verts.push(...this._buildBeamRect(-half, 0, half, n, z));
      // East (+X)
      verts.push(...this._buildBeamRect(0, -half, e, half, z));
      // South (-Y)
      verts.push(...this._buildBeamRect(-half, -s, half, 0, z));
      // West (-X)
      verts.push(...this._buildBeamRect(-w, -half, 0, half, z));

      this._localPositions = new Float32Array(verts);
      this._vertexCount = this._localPositions.length / 3;
      return true;
    }

    _transformLocalToRender(matrix, x, y, z, out, offset) {
      const m = matrix;
      const rx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const ry = m[1] * x + m[5] * y + m[9] * z + m[13];
      const rz = m[2] * x + m[6] * y + m[10] * z + m[14];
      out[offset] = rx;
      out[offset + 1] = ry;
      out[offset + 2] = rz;
    }

    render(context) {
      const gl = context.gl;
      if (!this.center || !this._localPositions) return;

      if (!this._renderPositions || this._renderPositions.length !== this._localPositions.length) {
        this._renderPositions = new Float32Array(this._localPositions.length);
      }

      const origin = [this.center.x, this.center.y, this.eyeZ || this.center.z || 0];
      const transform = new Float32Array(16);
      this.externalRenderers.renderCoordinateTransformAt(
        this.view,
        origin,
        this.center.spatialReference || this.view.spatialReference,
        transform
      );

      for (let i = 0; i < this._localPositions.length; i += 3) {
        this._transformLocalToRender(
          transform,
          this._localPositions[i],
          this._localPositions[i + 1],
          this._localPositions[i + 2],
          this._renderPositions,
          i
        );
      }

      gl.useProgram(this._program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this._renderPositions, gl.DYNAMIC_DRAW);

      gl.enableVertexAttribArray(this._aPos);
      gl.vertexAttribPointer(this._aPos, 3, gl.FLOAT, false, 0, 0);

      gl.uniformMatrix4fv(this._uView, false, context.camera.viewMatrix);
      gl.uniformMatrix4fv(this._uProj, false, context.camera.projectionMatrix);
      gl.uniform4fv(this._uColor, [COLOR[0] / 255, COLOR[1] / 255, COLOR[2] / 255, COLOR[3]]);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);

      gl.drawArrays(gl.TRIANGLES, 0, this._vertexCount);

      gl.depthMask(true);
      context.resetWebGLState();
      this.externalRenderers.requestRender(this.view);
    }

    dispose() {
      const gl = this._gl;
      if (!gl) return;
      if (this._buffer) gl.deleteBuffer(this._buffer);
      if (this._program) gl.deleteProgram(this._program);
    }
  }

  function startVisibilityAlongRoute({ view, externalRenderers, webMercatorUtils, Point, path, stepMeters, eyeOffsetMeters, maxRayDistanceMeters, rayStepMeters, rayAngleStepDeg }) {
    if (!view || view.type !== "3d") {
      showRadarToast("Radar kräver 3D (SceneView) — kan inte visas i 2D-läge.");
      setRadarBadge(false);
      return;
    }
    if (!path || !path.length) return;

    activeView = view;

    if (!rendererInstance) {
      rendererInstance = new VisibilityRenderer(view, externalRenderers);
      externalRenderers.add(view, rendererInstance);
    }

    rendererInstance.setGeoHelpers(Point, webMercatorUtils);
    rendererInstance.setVisibilityConfig({
      stepMeters,
      eyeOffsetMeters,
      maxRayDistanceMeters,
      rayStepMeters,
      rayAngleStepDeg
    });

    const route = {
      paths: [path],
      spatialReference: { wkid: 4326 }
    };
    const stations = buildStationsFromPolyline(view, webMercatorUtils, route, stepMeters || STEP_METERS_DEFAULT);
    rendererInstance.setStations(stations);
    rendererInstance.enableStepScan(true);
    rendererInstance.start();
    setRadarBadge(true);
    externalRenderers.requestRender(view);
  }

  function stopVisibility() {
    if (!rendererInstance || !activeView) {
      setRadarBadge(false);
      return;
    }
    try {
      rendererInstance.externalRenderers.remove(activeView, rendererInstance);
    } catch (e) {
      // ignore
    }
    rendererInstance.stop();
    rendererInstance.dispose();
    rendererInstance = null;
    activeView = null;
    setRadarBadge(false);
  }

  function startRadar({ view, externalRenderers, centerPoint }) {
    if (!view || view.type !== "3d") {
      showRadarToast("Radar kräver 3D (SceneView) — kan inte visas i 2D-läge.");
      setRadarBadge(false);
      return;
    }
    if (!centerPoint) return;

    activeView = view;

    if (!rendererInstance) {
      rendererInstance = new VisibilityRenderer(view, externalRenderers);
      externalRenderers.add(view, rendererInstance);
    }

    rendererInstance.setCenter(centerPoint);
    rendererInstance.setStations([centerPoint]);
    rendererInstance.enableStepScan(true);
    rendererInstance.start();
    setRadarBadge(true);
    externalRenderers.requestRender(view);
  }

  function stopRadar() {
    stopVisibility();
  }

  function setCenter(point) {
    if (rendererInstance && point) {
      rendererInstance.setCenter(point);
    }
  }

  async function startFixedVisibilityCross({ view, point }) {
    if (!view || view.type !== "3d") {
      showRadarToast("Radar kräver 3D (SceneView) — kan inte visas i 2D-läge.");
      setRadarBadge(false);
      return;
    }
    if (!point) return;

    fixedActiveView = view;

    const ext = rendererInstance?.externalRenderers || window.__externalRenderers;
    if (!ext) {
      showRadarToast("Radar kan inte starta (externa renderare saknas).");
      return;
    }
    if (!fixedRendererInstance) {
      fixedRendererInstance = new FixedVisibilityRenderer(view, ext);
      ext.add(view, fixedRendererInstance);
    }

    let info = null;
    if (typeof window.__fixedVisibilityCompute === "function") {
      info = await window.__fixedVisibilityCompute(point, {
        maxDist: 200,
        step: 2,
        eyeOffset: 1.7
      });
    }

    const lengths = info?.lengths || { N: 200, E: 200, S: 200, W: 200 };
    const eyeZ = Number.isFinite(info?.eyeZ) ? info.eyeZ : RADAR_CENTER_OFFSET_M;
    fixedRendererInstance.setData({ center: point, eyeZ, lengths });
    setRadarBadge(true);
    ext.requestRender(view);
  }

  function stopFixedVisibilityCross() {
    if (!fixedRendererInstance || !fixedActiveView) {
      setRadarBadge(false);
      return;
    }
    try {
      const ext = rendererInstance?.externalRenderers || window.__externalRenderers;
      ext?.remove(fixedActiveView, fixedRendererInstance);
    } catch (e) {
      // ignore
    }
    fixedRendererInstance.dispose();
    fixedRendererInstance = null;
    fixedActiveView = null;
    setRadarBadge(false);
  }

  window.Visibility = {
    startVisibilityAlongRoute,
    stopVisibility
  };

  window.Radar = {
    start: startRadar,
    stop: stopRadar,
    setCenter
  };

  window.FixedVisibility = {
    startFixedVisibilityCross,
    stopFixedVisibilityCross
  };
})();
