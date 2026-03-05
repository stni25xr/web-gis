(() => {
  const DEG2RAD = Math.PI / 180;
  const COLOR = [255, 140, 0, 0.85];
  const RADIUS = 500;
  const BEAM_WIDTH_DEG = 10;
  const Z_OFFSET = 15; // temporary, visible above ground

  let rendererInstance = null;
  let activeView = null;

  function ensureRadarBadge() {
    let badge = document.getElementById("radarStatusBadge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "radarStatusBadge";
      badge.style.cssText = "position:fixed;top:90px;left:16px;z-index:9999;background:#0f172a;color:#fff;padding:6px 10px;border-radius:8px;font:600 12px/1.2 system-ui, sans-serif;box-shadow:0 4px 10px rgba(0,0,0,0.2);";
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
      toast.style.cssText = "position:fixed;top:130px;left:16px;z-index:9999;background:#fff3cd;color:#7c2d12;padding:8px 10px;border-radius:8px;font:600 12px/1.2 system-ui, sans-serif;border:1px solid rgba(124,45,18,0.25);box-shadow:0 4px 10px rgba(0,0,0,0.15);";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = "1";
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.style.opacity = "0";
    }, 2500);
  }

  class RadarRenderer {
    constructor(view, externalRenderers) {
      this.view = view;
      this.externalRenderers = externalRenderers;
      this.center = null;
      this.sweepAngle = 0;
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

    setCenter(point) {
      this.center = point;
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
      const halfWidth = (BEAM_WIDTH_DEG * DEG2RAD) / 2;
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
        positions[idx] = Math.cos(ang) * RADIUS;
        positions[idx + 1] = Math.sin(ang) * RADIUS;
        positions[idx + 2] = 0;
      }

      this._localPositions = positions;
      this._vertexCount = vertexCount;
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
      if (!this.center) return;

      // simple rotation: 2 deg per frame
      this.sweepAngle = (this.sweepAngle + 2 * DEG2RAD) % (2 * Math.PI);

      if (!this._buildLocalGeometry()) return;

      if (!this._renderPositions || this._renderPositions.length !== this._localPositions.length) {
        this._renderPositions = new Float32Array(this._localPositions.length);
      }

      const origin = [this.center.x, this.center.y, (this.center.z || 0) + Z_OFFSET];
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

      gl.drawArrays(gl.TRIANGLE_FAN, 0, this._vertexCount);

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

  function startRadar({ view, externalRenderers, centerPoint }) {
    console.log(`[radar] start called`);
    console.log(`[radar] view type = ${view?.type}`);

    if (!view || view.type !== "3d") {
      showRadarToast("Radar kräver 3D (SceneView) — kan inte visas i 2D-läge.");
      setRadarBadge(false);
      return;
    }

    if (!centerPoint) return;

    activeView = view;

    if (!rendererInstance) {
      rendererInstance = new RadarRenderer(view, externalRenderers);
      externalRenderers.add(view, rendererInstance);
      console.log("[radar] renderer added");
    }

    rendererInstance.setCenter(centerPoint);
    console.log(`[radar] center = ${centerPoint.x},${centerPoint.y},${centerPoint.z ?? 0}`);
    setRadarBadge(true);
    externalRenderers.requestRender(view);
  }

  function stopRadar() {
    if (!rendererInstance || !activeView) {
      setRadarBadge(false);
      return;
    }
    try {
      rendererInstance.externalRenderers.remove(activeView, rendererInstance);
    } catch (e) {
      // ignore
    }
    rendererInstance.dispose();
    rendererInstance = null;
    activeView = null;
    setRadarBadge(false);
  }

  function setCenter(point) {
    if (rendererInstance && point) {
      rendererInstance.setCenter(point);
    }
  }

  window.Radar = {
    start: startRadar,
    stop: stopRadar,
    setCenter
  };
})();
