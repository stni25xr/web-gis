(() => {
  const DEG2RAD = Math.PI / 180;
  const DEFAULT_COLOR = [255, 140, 0, 0.8]; // opaque orange

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
      const wm = webMercatorUtils.geographicToWebMercator({ x, y, spatialReference });
      return { x: wm.x, y: wm.y, spatialReference: view.spatialReference };
    }

    if (isWebMerc && view?.spatialReference?.isWebMercator) {
      return { x, y, spatialReference: view.spatialReference };
    }

    return { x, y, spatialReference: spatialReference };
  }

  class RadarSweepRenderer {
    constructor(opts) {
      this.view = opts.view;
      this.externalRenderers = opts.externalRenderers;
      this.webMercatorUtils = opts.webMercatorUtils;
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
      this._positions = null;
      this._renderPositions = null;
    }

    updateCenter(center, beamZ, radius) {
      this.radius = radius ?? this.radius;
      this.center = normalizeCenter(center, this.view, this.webMercatorUtils);
      if (Number.isFinite(beamZ)) this.beamZ = beamZ;
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

    _buildGeometry() {
      if (!this.center) return false;
      const halfWidth = (this.beamWidthDeg * DEG2RAD) / 2;
      const angleStart = this.sweepAngle - halfWidth;
      const angleEnd = this.sweepAngle + halfWidth;
      const segments = 16;
      const vertexCount = segments + 2; // center + arc points
      const positions = new Float64Array(vertexCount * 3);

      const cx = this.center.x;
      const cy = this.center.y;
      const z = this.beamZ;

      positions[0] = cx;
      positions[1] = cy;
      positions[2] = z;

      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const ang = angleStart + (angleEnd - angleStart) * t;
        const idx = (i + 1) * 3;
        positions[idx] = cx + Math.cos(ang) * this.radius;
        positions[idx + 1] = cy + Math.sin(ang) * this.radius;
        positions[idx + 2] = z;
      }

      this._positions = positions;
      this.vertexCount = vertexCount;
      return true;
    }

    render(context) {
      const gl = context.gl;

      if (!this.center) {
        return;
      }

      const now = performance.now();
      if (this.lastTimeMs == null) this.lastTimeMs = now;
      const dt = (now - this.lastTimeMs) / 1000;
      this.lastTimeMs = now;

      const angularSpeed = (2 * Math.PI) / this.rotationPeriodSec;
      this.sweepAngle = (this.sweepAngle + angularSpeed * dt) % (2 * Math.PI);

      if (!this._buildGeometry()) return;

      if (!this._renderPositions || this._renderPositions.length !== this._positions.length) {
        this._renderPositions = new Float32Array(this._positions.length);
      }

      const view = this.view;
      const sr = view?.spatialReference || null;
      const isWebMerc = sr && (sr.isWebMercator || sr.wkid === 3857 || sr.wkid === 102100);
      const isWgs = sr && (sr.isWGS84 || sr.wkid === 4326);

      let points = this._positions;
      if (!isWebMerc && isWgs && this.webMercatorUtils?.webMercatorToGeographic) {
        const converted = new Float64Array(this._positions.length);
        for (let i = 0; i < this._positions.length; i += 3) {
          const wm = { x: this._positions[i], y: this._positions[i + 1], spatialReference: { wkid: 3857 } };
          const geo = this.webMercatorUtils.webMercatorToGeographic(wm);
          converted[i] = geo.x;
          converted[i + 1] = geo.y;
          converted[i + 2] = this._positions[i + 2];
        }
        points = converted;
      }

      this.externalRenderers.toRenderCoordinates(
        view,
        points,
        0,
        this._renderPositions,
        0,
        this.vertexCount,
        context.renderCoordinateSystem
      );

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

  async function resolveBeamZ(view, center) {
    if (!view?.ground || !center) return 1.7;
    try {
      const geom = {
        type: "point",
        x: center.x,
        y: center.y,
        spatialReference: center.spatialReference || view.spatialReference
      };
      const res = await view.ground.queryElevation(geom);
      const z = res?.geometry?.z;
      if (Number.isFinite(z)) return z + 1.7;
    } catch (e) {
      // ignore elevation failures
    }
    return 1.7;
  }

  window.startRadarBeam = async function (opts) {
    const view = opts?.view;
    const externalRenderers = opts?.externalRenderers;
    const webMercatorUtils = opts?.webMercatorUtils;
    const centerRaw = opts?.center;
    const radius = opts?.radius ?? 500;

    if (!view || !externalRenderers || !centerRaw) return;

    const center = normalizeCenter(centerRaw, view, webMercatorUtils);
    if (!center) return;
    const beamZ = await resolveBeamZ(view, center);

    if (!radarInstance) {
      radarInstance = new RadarSweepRenderer({ view, externalRenderers, webMercatorUtils, radius });
      radarInstance.updateCenter(center, beamZ, radius);
      externalRenderers.add(view, radarInstance);
    } else {
      radarInstance.updateCenter(center, beamZ, radius);
    }
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
