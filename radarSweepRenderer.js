(() => {
  const DEG2RAD = Math.PI / 180;
  const ORANGE = [1.0, 0.549, 0.0, 0.85];
  const RADIUS = 500;
  const BEAM_WIDTH_DEG = 10;
  const HEIGHT_OFFSET = 15;
  const SEGMENTS = 12;

  let activeRenderer = null;
  let activeView = null;

  function logCenter(point) {
    if (!point) return;
    const x = Number.isFinite(point.x) ? point.x : 0;
    const y = Number.isFinite(point.y) ? point.y : 0;
    const z = Number.isFinite(point.z) ? point.z : 0;
    console.log(`[radar] center = ${x},${y},${z}`);
  }

  function setStatus(on) {
    const el = document.getElementById("radarStatus");
    if (!el) return;
    el.textContent = on ? "RADAR: ON" : "RADAR: OFF";
    el.classList.toggle("is-on", !!on);
  }

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(info || "Shader compile failed");
    }
    return shader;
  }

  function createProgram(gl, vsSource, fsSource) {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(info || "Program link failed");
    }
    return program;
  }

  function multiplyMat4Vec3(out, m, x, y, z) {
    const w = 1;
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    return out;
  }

  function buildLocalFan(angleDeg) {
    const start = (angleDeg - BEAM_WIDTH_DEG / 2) * DEG2RAD;
    const end = (angleDeg + BEAM_WIDTH_DEG / 2) * DEG2RAD;
    const step = (end - start) / SEGMENTS;
    const verts = new Float32Array((SEGMENTS + 2) * 3);
    let idx = 0;
    verts[idx++] = 0;
    verts[idx++] = 0;
    verts[idx++] = 0;
    for (let i = 0; i <= SEGMENTS; i += 1) {
      const a = start + step * i;
      const x = Math.cos(a) * RADIUS;
      const y = Math.sin(a) * RADIUS;
      verts[idx++] = x;
      verts[idx++] = y;
      verts[idx++] = 0;
    }
    return verts;
  }

  function createRenderer(view, centerPoint) {
    const externalRenderers = window.__externalRenderers;
    if (!externalRenderers) {
      console.warn("[radar] externalRenderers not available");
      return null;
    }

    return {
      view,
      centerPoint: centerPoint ? centerPoint.clone() : null,
      sweepAngle: 0,
      program: null,
      vertexBuffer: null,
      attribPosition: -1,
      uView: null,
      uProj: null,
      uColor: null,

      setCenter(point) {
        this.centerPoint = point ? point.clone() : this.centerPoint;
      },

      setup(context) {
        const gl = context.gl;
        const vs = `
          precision highp float;
          attribute vec3 a_position;
          uniform mat4 u_view;
          uniform mat4 u_proj;
          void main() {
            gl_Position = u_proj * u_view * vec4(a_position, 1.0);
          }
        `;
        const fs = `
          precision highp float;
          uniform vec4 u_color;
          void main() {
            gl_FragColor = u_color;
          }
        `;
        this.program = createProgram(gl, vs, fs);
        this.attribPosition = gl.getAttribLocation(this.program, "a_position");
        this.uView = gl.getUniformLocation(this.program, "u_view");
        this.uProj = gl.getUniformLocation(this.program, "u_proj");
        this.uColor = gl.getUniformLocation(this.program, "u_color");
        this.vertexBuffer = gl.createBuffer();
      },

      render(context) {
        const gl = context.gl;
        if (!this.centerPoint) return;

        const origin = this.centerPoint.clone();
        const baseZ = Number.isFinite(origin.z) ? origin.z : 0;
        origin.z = baseZ + HEIGHT_OFFSET;

        const transform = new Float64Array(16);
        externalRenderers.renderCoordinateTransformAt(
          this.view,
          origin,
          this.view.spatialReference,
          transform
        );

        const localVerts = buildLocalFan(this.sweepAngle);
        const renderVerts = new Float32Array(localVerts.length);
        const tmp = [0, 0, 0];
        for (let i = 0; i < localVerts.length; i += 3) {
          multiplyMat4Vec3(tmp, transform, localVerts[i], localVerts[i + 1], localVerts[i + 2]);
          renderVerts[i] = tmp[0];
          renderVerts[i + 1] = tmp[1];
          renderVerts[i + 2] = tmp[2];
        }

        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, renderVerts, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.attribPosition);
        gl.vertexAttribPointer(this.attribPosition, 3, gl.FLOAT, false, 0, 0);

        gl.uniformMatrix4fv(this.uView, false, context.camera.viewMatrix);
        gl.uniformMatrix4fv(this.uProj, false, context.camera.projectionMatrix);
        gl.uniform4fv(this.uColor, ORANGE);

        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.drawArrays(gl.TRIANGLE_FAN, 0, renderVerts.length / 3);

        externalRenderers.requestRender(this.view);
        this.sweepAngle = (this.sweepAngle + 2) % 360;
        context.resetWebGLState();
      },

      dispose(context) {
        const gl = context.gl;
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
        if (this.program) gl.deleteProgram(this.program);
        this.vertexBuffer = null;
        this.program = null;
      }
    };
  }

  function start({ view, centerPoint }) {
    console.log("[radar] start called");
    if (!view || !centerPoint) return;

    const externalRenderers = window.__externalRenderers;
    if (!externalRenderers) {
      console.warn("[radar] externalRenderers not available");
      return;
    }

    if (activeRenderer && activeView === view) {
      activeRenderer.setCenter(centerPoint);
      setStatus(true);
      logCenter(centerPoint);
      return;
    }

    stop();
    const renderer = createRenderer(view, centerPoint);
    if (!renderer) return;
    activeRenderer = renderer;
    activeView = view;

    externalRenderers.add(view, renderer);
    console.log("[radar] renderer added");
    logCenter(centerPoint);
    setStatus(true);
  }

  function stop() {
    const externalRenderers = window.__externalRenderers;
    if (activeRenderer && activeView && externalRenderers) {
      try {
        externalRenderers.remove(activeView, activeRenderer);
      } catch (e) {
        // ignore remove errors
      }
    }
    activeRenderer = null;
    activeView = null;
    setStatus(false);
  }

  function setCenter(point) {
    if (activeRenderer) activeRenderer.setCenter(point);
    logCenter(point);
  }

  window.Radar = {
    start,
    stop,
    setCenter
  };
})();
