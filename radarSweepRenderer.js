(() => {
  const DEG2RAD = Math.PI / 180;
  const DEFAULT_COLOR = [255, 140, 0, 0.8]; // opaque orange
  const DEFAULT_WALK_SPEED_MPS = 1.4;

  let radarInstance = null;

  function normalizeCenter(center, view, webMercatorUtils) {
    if (!center) return null;
    const sr = center.spatialReference || view?.spatialReference || null;
    const isWgs = sr && (sr.isWGS84 || sr.wkid === 4326);
    const isWebMerc = sr && (sr.isWebMercator || sr.wkid === 3857 || sr.wkid === 102100);
    let x = center.x ?? center.longitude;
    let y = center.y ?? center.latitude;
    let spatialReference = sr || { wkid: 4326 };

    if (isWgs && view?.spatialReference?.isWebMercator && webMercatorUtils?.geographicToWebMercator) {
      const wm = webMercatorUtils.geographicToWebMercator(center?.type === "point"
        ? center
        : { type: "point", x, y, spatialReference });
      return { x: wm.x, y: wm.y, spatialReference: view.spatialReference };
    }

    if (isWebMerc && view?.spatialReference?.isWebMercator) {
      return { x, y, spatialReference: view.spatialReference };
    }

    return { x, y, spatialReference: spatialReference };
  }

  function haversineMeters(a, b) {
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

  class RadarSweepRenderer {
    constructor(opts) {
      this.view = opts.view;
      this.externalRenderers = opts.externalRenderers;
      this.webMercatorUtils = opts.webMercatorUtils;
      this.Point = opts.Point;
      this.radius = opts.radius ?? 500;
      this.beamWidthDeg = 1;
      this.rotationPeriodSec = 1;
      this.sweepAngle = 0;
      this.lastTimeMs = null;
      this.center = null;
      this.beamZ = 1.7;
      this.vertexCount = 0;

      this._gl = null;
      this._program = null;
      this._buffer = null;
      this._aPos = -1;
      this._uView = null;
      this._uProj = null;
      this._uColor = null;
      this._renderPositions = null;
      this._localPositions = null;

      this._pathPoints = null;
      this._pathCum = null;
      this._pathTotal = 0;
      this._pathStartMs = 0;
      this._pathDurationMs = 0;
      this._pathActive = false;
      this._lastZSampleMs = 0;
    }

    updateCenter(center, beamZ, radius) {
      this.radius = radius ?? this.radius;
      this.center = normalizeCenter(center, this.view, this.webMercatorUtils);
      if (Number.isFinite(beamZ)) this.beamZ = beamZ;
    }

    setPath(points, durationSec) {
      if (!Array.isArray(points) || points.length < 2) return;
      const pts = points.map((p) => {
        if (Array.isArray(p)) {
          return { x: p[0], y: p[1], spatialReference: { wkid: 4326 } };
        }
        if (p?.longitude != null || p?.latitude != null) {
          return { x: p.longitude ?? p.x, y: p.latitude ?? p.y, spatialReference: p.spatialReference || { wkid: 4326 } };
        }
        return { x: p.x, y: p.y, spatialReference: p.spatialReference || { wkid: 4326 } };
      });

      const cum = new Float64Array(pts.length);
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const seg = haversineMeters(pts[i - 1], pts[i]);
        total += seg;
        cum[i] = total;
      }

      this._pathPoints = pts;
      this._pathCum = cum;
      this._pathTotal = total;
      this._pathStartMs = performance.now();
      const duration = Number.isFinite(durationSec) && durationSec > 0
        ? durationSec * 1000
        : (total / DEFAULT_WALK_SPEED_MPS) * 1000;
      this._pathDurationMs = Math.max(1000, duration);
      this._pathActive = true;
      this.center = pts[0];
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

    _buildLocalGeometry() {
      if (!this.center) return false;
      const halfWidth = (this.beamWidthDeg * DEG2RAD) / 2;
      const angleStart = this.sweepAngle - halfWidth;
      const angleEnd = this.sweepAngle + halfWidth;
      const segments = 16;
      const vertexCount = segments + 2;
      const positions = new Float32Array(vertexCount * 3);

      positions[0] = 0;
      positions[1] = 0;
      positions[2] = 0;

      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const ang = angleStart + (angleEnd - angleStart) * t;
        const idx = (i + 1) * 3;
        positions[idx] = Math.cos(ang) * this.radius;
        positions[idx + 1] = Math.sin(ang) * this.radius;
        positions[idx + 2] = 0;
      }

      this._localPositions = positions;
      this.vertexCount = vertexCount;
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

    _sampleBeamZ(center) {
      const now = performance.now();
      if (now - this._lastZSampleMs < 500) return;
      this._lastZSampleMs = now;

      const view = this.view;
      const sampler = view?.groundView?.elevationSampler;
      if (!sampler || typeof sampler.sample !== "function") return;

      let pt = center;
      const sr = center?.spatialReference;
      if (view?.spatialReference?.isWebMercator && sr && (sr.isWGS84 || sr.wkid === 4326) && this.webMercatorUtils?.geographicToWebMercator) {
        pt = this.webMercatorUtils.geographicToWebMercator({
          type: "point",
          x: center.x,
          y: center.y,
          spatialReference: sr
        });
      }

      try {
        const res = sampler.sample(pt);
        const z = res?.z ?? res?.geometry?.z;
        if (Number.isFinite(z)) this.beamZ = z + 1.7;
      } catch (e) {
        // ignore sampling errors
      }
    }

    _updatePathCenter() {
      if (!this._pathActive || !this._pathPoints || !this._pathCum) return;
      const now = performance.now();
      const t = (now - this._pathStartMs) / this._pathDurationMs;
      if (t >= 1) {
        this.center = this._pathPoints[this._pathPoints.length - 1];
        this._pathActive = false;
        return;
      }
      const targetDist = t * this._pathTotal;
      const cum = this._pathCum;
      let idx = 1;
      while (idx < cum.length && cum[idx] < targetDist) idx++;
      const prev = this._pathPoints[idx - 1];
      const next = this._pathPoints[idx] || prev;
      const segStart = cum[idx - 1];
      const segEnd = cum[idx] || segStart + 1;
      const segT = segEnd === segStart ? 0 : (targetDist - segStart) / (segEnd - segStart);
      this.center = {
        x: prev.x + (next.x - prev.x) * segT,
        y: prev.y + (next.y - prev.y) * segT,
        spatialReference: prev.spatialReference || { wkid: 4326 }
      };
    }

    render(context) {
      const gl = context.gl;
      if (!this.center) return;

      this._updatePathCenter();
      this._sampleBeamZ(this.center);

      const now = performance.now();
      if (this.lastTimeMs == null) this.lastTimeMs = now;
      const dt = (now - this.lastTimeMs) / 1000;
      this.lastTimeMs = now;

      const angularSpeed = (2 * Math.PI) / this.rotationPeriodSec;
      this.sweepAngle = (this.sweepAngle + angularSpeed * dt) % (2 * Math.PI);

      if (!this._buildLocalGeometry()) return;

      if (!this._renderPositions || this._renderPositions.length !== this._localPositions.length) {
        this._renderPositions = new Float32Array(this._localPositions.length);
      }

      const view = this.view;
      const center = this.center;
      const origin = [center.x, center.y, this.beamZ];
      const transform = new Float32Array(16);
      this.externalRenderers.renderCoordinateTransformAt(
        view,
        origin,
        center.spatialReference || view.spatialReference,
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
      gl.uniform4fv(this._uColor, [
        DEFAULT_COLOR[0] / 255,
        DEFAULT_COLOR[1] / 255,
        DEFAULT_COLOR[2] / 255,
        DEFAULT_COLOR[3]
      ]);

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);

      gl.drawArrays(gl.TRIANGLE_FAN, 0, this.vertexCount);

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

  async function resolveBeamZ(view, center, PointCtor) {
    if (!center) return 1.7;
    try {
      const geom = PointCtor
        ? new PointCtor({ x: center.x, y: center.y, spatialReference: center.spatialReference || view.spatialReference })
        : { type: "point", x: center.x, y: center.y, spatialReference: center.spatialReference || view.spatialReference };

      if (view?.ground && typeof view.ground.queryElevation === "function") {
        const res = await view.ground.queryElevation(geom);
        const z = res?.geometry?.z ?? res?.z;
        if (Number.isFinite(z)) return z + 1.7;
      }

      const sampler = view?.groundView?.elevationSampler;
      if (sampler) {
        if (typeof sampler.queryElevation === "function") {
          const res = sampler.queryElevation(geom);
          const z = res?.z ?? res?.geometry?.z;
          if (Number.isFinite(z)) return z + 1.7;
        }
        if (typeof sampler.sample === "function") {
          const res = sampler.sample(geom);
          const z = res?.z ?? res?.geometry?.z;
          if (Number.isFinite(z)) return z + 1.7;
        }
      }
    } catch (e) {
      // ignore elevation failures
    }
    return 1.7;
  }

  window.startRadarBeam = async function (opts) {
    const view = opts?.view;
    const externalRenderers = opts?.externalRenderers;
    const webMercatorUtils = opts?.webMercatorUtils;
    const Point = opts?.Point;
    const centerRaw = opts?.center;
    const radius = opts?.radius ?? 500;

    if (!view || !externalRenderers || !centerRaw) return;

    const center = normalizeCenter(centerRaw, view, webMercatorUtils);
    if (!center) return;
    const beamZ = await resolveBeamZ(view, center, Point);

    if (!radarInstance) {
      radarInstance = new RadarSweepRenderer({ view, externalRenderers, webMercatorUtils, Point, radius });
      radarInstance.updateCenter(center, beamZ, radius);
      externalRenderers.add(view, radarInstance);
    } else {
      radarInstance.updateCenter(center, beamZ, radius);
    }
    externalRenderers.requestRender(view);
  };

  window.startRadarAlongRoute = async function (opts) {
    const view = opts?.view;
    const externalRenderers = opts?.externalRenderers;
    const webMercatorUtils = opts?.webMercatorUtils;
    const Point = opts?.Point;
    const radius = opts?.radius ?? 500;
    const path = opts?.path;
    const durationSec = opts?.durationSec;

    if (!view || !externalRenderers || !Array.isArray(path) || path.length < 2) return;

    if (!radarInstance) {
      const first = Array.isArray(path[0]) ? { x: path[0][0], y: path[0][1], spatialReference: { wkid: 4326 } } : path[0];
      const beamZ = await resolveBeamZ(view, first, Point);
      radarInstance = new RadarSweepRenderer({ view, externalRenderers, webMercatorUtils, Point, radius });
      radarInstance.updateCenter(first, beamZ, radius);
      externalRenderers.add(view, radarInstance);
    }
    radarInstance.radius = radius;
    radarInstance.setPath(path, durationSec);
    externalRenderers.requestRender(view);
  };

  window.stopRadarBeam = function () {
    if (!radarInstance) return;
    try {
      radarInstance.externalRenderers.remove(radarInstance.view, radarInstance);
    } catch (e) {
      // ignore remove errors
    }
    radarInstance.dispose();
    radarInstance = null;
  };
})();
