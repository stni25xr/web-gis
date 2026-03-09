const panel = document.getElementById("bimViewerPanel");
const viewEl = document.getElementById("bimView");
const toggleBtn = document.getElementById("bimViewerToggle");
const fileInput = document.getElementById("bimViewerFile");
const clearFileBtn = document.getElementById("bimViewerClearFile");
const moveBtn = document.getElementById("bimViewerMove");
const rotateBtn = document.getElementById("bimViewerRotate");
const closeBtn = document.getElementById("bimViewerClose");
const resetBtn = document.getElementById("bimViewerReset");
const clearBtn = document.getElementById("bimViewerClear");
const statusEl = document.getElementById("bimViewerStatus");
const clipToggle = document.getElementById("bimClipToggle");
const clipX = document.getElementById("bimClipX");
const clipY = document.getElementById("bimClipY");
const clipZ = document.getElementById("bimClipZ");

let THREE;
let OrbitControls;
let TransformControls;
let GLTFLoader;
let scene;
let camera;
let renderer;
let orbit;
let transform;
let loader;
let modelRoot;
let grid;
let planeX;
let planeY;
let planeZ;
let clippingPlanes;
let currentModelUrl = "";
let initPromise = null;
let clipBounds = null;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || "";
}

async function initThree() {
  if (!panel || !viewEl) return;
  try {
    const importWithFallback = async (urls) => {
      let lastErr = null;
      for (const url of urls) {
        try {
          return await import(url);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    };
    const threeMod = await importWithFallback([
      "https://unpkg.com/three@0.160.0/build/three.module.js",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "https://esm.sh/three@0.160.0"
    ]);
    const orbitMod = await importWithFallback([
      "https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js",
      "https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js"
    ]);
    const transformMod = await importWithFallback([
      "https://unpkg.com/three@0.160.0/examples/jsm/controls/TransformControls.js",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/TransformControls.js",
      "https://esm.sh/three@0.160.0/examples/jsm/controls/TransformControls.js"
    ]);
    const gltfMod = await importWithFallback([
      "https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js",
      "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js",
      "https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js"
    ]);
    THREE = threeMod;
    OrbitControls = orbitMod.OrbitControls;
    TransformControls = transformMod.TransformControls;
    GLTFLoader = gltfMod.GLTFLoader;
  } catch (e) {
    console.error("[BIM] Failed to load Three modules", e);
    setStatus("Kunde inte ladda Three.js.");
    return;
  }

  scene = new THREE.Scene();
  scene.background = null;
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000);
  camera.position.set(6, 6, 10);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x000000, 0);
  renderer.localClippingEnabled = true;
  renderer.clippingPlanes = [];
  viewEl.innerHTML = "";
  viewEl.appendChild(renderer.domElement);

  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;

  transform = new TransformControls(camera, renderer.domElement);
  transform.addEventListener("dragging-changed", (e) => {
    orbit.enabled = !e.value;
  });
  scene.add(transform);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(5, 10, 8);
  scene.add(dir);

  grid = new THREE.GridHelper(20, 20, 0x1f2937, 0x111827);
  scene.add(grid);

  planeX = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  planeY = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  planeZ = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  clippingPlanes = [planeX, planeY, planeZ];

  loader = new GLTFLoader();
  resize();
  animate();

  const modelUrl = window.BIM_MODEL_URL || viewEl.dataset.model;
  if (!modelUrl) {
    setStatus("Ingen standardmodell hittad. Ladda upp en .glb-fil.");
  } else {
    loadModel(modelUrl);
  }
}

function setClipEnabled(enabled) {
  if (!renderer) return;
  renderer.localClippingEnabled = true;
  renderer.clippingPlanes = enabled ? clippingPlanes : [];
  if (modelRoot) {
    modelRoot.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          m.clippingPlanes = enabled ? clippingPlanes : [];
          m.clipIntersection = false;
          m.clipShadows = enabled;
          m.needsUpdate = true;
        });
      }
    });
  }
}

function getBoundsForObject(object) {
  if (!object || !THREE) return null;
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return { box, size, center };
}

function applyAxisClip(plane, axisIndex, sliderValue, bounds) {
  if (!plane || !bounds) return;
  const minVal = axisIndex === 0 ? bounds.box.min.x : axisIndex === 1 ? bounds.box.min.y : bounds.box.min.z;
  const maxVal = axisIndex === 0 ? bounds.box.max.x : axisIndex === 1 ? bounds.box.max.y : bounds.box.max.z;
  const sizeVal = axisIndex === 0 ? bounds.size.x : axisIndex === 1 ? bounds.size.y : bounds.size.z;
  const center = bounds.center;
  const distance = Math.min(Math.abs(sliderValue), Math.max(0, sizeVal));
  const point = center.clone();
  const normal = new THREE.Vector3(0, 0, 0);
  const margin = Math.max(0.1, sizeVal * 0.05);

  if (distance <= 0.0001) {
    normal.set(axisIndex === 0 ? 1 : 0, axisIndex === 1 ? 1 : 0, axisIndex === 2 ? 1 : 0);
    if (axisIndex === 0) point.x = maxVal + margin;
    if (axisIndex === 1) point.y = maxVal + margin;
    if (axisIndex === 2) point.z = maxVal + margin;
    plane.setFromNormalAndCoplanarPoint(normal, point);
    return;
  }

  if (sliderValue > 0) {
    normal.set(axisIndex === 0 ? 1 : 0, axisIndex === 1 ? 1 : 0, axisIndex === 2 ? 1 : 0);
    if (axisIndex === 0) point.x = maxVal - distance;
    if (axisIndex === 1) point.y = maxVal - distance;
    if (axisIndex === 2) point.z = maxVal - distance;
  } else {
    normal.set(axisIndex === 0 ? -1 : 0, axisIndex === 1 ? -1 : 0, axisIndex === 2 ? -1 : 0);
    if (axisIndex === 0) point.x = minVal + distance;
    if (axisIndex === 1) point.y = minVal + distance;
    if (axisIndex === 2) point.z = minVal + distance;
  }
  plane.setFromNormalAndCoplanarPoint(normal, point);
}

function updateClipFromSliders() {
  if (!planeX || !modelRoot) return;
  const bounds = getBoundsForObject(modelRoot);
  if (!bounds) return;
  clipBounds = bounds.box.clone();
  const x = Number(clipX?.value || 0);
  const y = Number(clipY?.value || 0);
  const z = Number(clipZ?.value || 0);
  applyAxisClip(planeX, 0, x, bounds);
  applyAxisClip(planeY, 1, y, bounds);
  applyAxisClip(planeZ, 2, z, bounds);
}

function fitToModel(object) {
  const bounds = getBoundsForObject(object);
  if (!bounds) return;
  const { box, size, center } = bounds;
  clipBounds = box.clone();

  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.5;
  camera.position.set(center.x + dist, center.y + dist, center.z + dist);
  camera.lookAt(center);
  orbit.target.copy(center);
  orbit.update();

  const setupSlider = (slider, axisSize) => {
    if (!slider) return;
    const range = Math.max(1, Math.ceil(axisSize));
    const step = Math.max(0.01, axisSize / 200);
    slider.min = String(-range);
    slider.max = String(range);
    slider.step = String(Number(step.toFixed(3)));
    slider.value = "0";
  };
  setupSlider(clipX, size.x);
  setupSlider(clipY, size.y);
  setupSlider(clipZ, size.z);
  updateClipFromSliders();
}

function applyClipState(state = {}) {
  const enabled = Boolean(state.enabled);
  if (clipToggle) clipToggle.checked = enabled;
  if (clipX && Number.isFinite(Number(state.x))) clipX.value = String(Number(state.x));
  if (clipY && Number.isFinite(Number(state.y))) clipY.value = String(Number(state.y));
  if (clipZ && Number.isFinite(Number(state.z))) clipZ.value = String(Number(state.z));
  updateClipFromSliders();
  setClipEnabled(enabled);
}

async function ensureReady() {
  if (loader) return true;
  if (!initPromise) initPromise = initThree();
  await initPromise;
  return Boolean(loader);
}

function loadModel(url, options = {}) {
  return ensureReady().then((ok) => {
    if (!ok || !url) return null;
    setStatus("Laddar modell…");
    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          if (modelRoot) scene.remove(modelRoot);
          modelRoot = gltf.scene;
          currentModelUrl = url;
          scene.add(modelRoot);
          fitToModel(modelRoot);
          setClipEnabled(Boolean(clipToggle?.checked));
          if (options?.clipState) applyClipState(options.clipState);
          setStatus("Model laddad.");
          if (typeof options?.onLoaded === "function") options.onLoaded(modelRoot);
          resolve(modelRoot);
        },
        undefined,
        (err) => {
          console.error("[BIM] Failed to load model", err);
          setStatus("Kunde inte ladda modellen.");
          reject(err);
        }
      );
    });
  });
}

function ensureModelLoaded(url, options = {}) {
  if (!url) return Promise.resolve(null);
  if (modelRoot && currentModelUrl === url) {
    if (options?.clipState) applyClipState(options.clipState);
    if (typeof options?.onLoaded === "function") options.onLoaded(modelRoot);
    return Promise.resolve(modelRoot);
  }
  return loadModel(url, options);
}

const raycaster = {
  obj: null,
  pointer: null
};

function selectAt(event) {
  if (!modelRoot) return;
  if (!raycaster.obj) {
    raycaster.obj = new THREE.Raycaster();
    raycaster.pointer = new THREE.Vector2();
  }
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  raycaster.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.obj.setFromCamera(raycaster.pointer, camera);
  const targets = [];
  modelRoot.traverse((child) => {
    if (child.isMesh) targets.push(child);
  });
  const hits = raycaster.obj.intersectObjects(targets, true);
  if (hits.length) transform.attach(hits[0].object);
}

function resize() {
  if (!renderer || !camera) return;
  const w = viewEl.clientWidth || 1;
  const h = viewEl.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function animate() {
  if (!renderer) return;
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
}

function clearModel() {
  if (modelRoot) {
    scene.remove(modelRoot);
    modelRoot = null;
  }
  currentModelUrl = "";
  clipBounds = null;
  transform.detach();
  setStatus("Modell borttagen.");
}

toggleBtn?.addEventListener("click", () => {
  panel?.classList.toggle("is-open");
});
closeBtn?.addEventListener("click", () => panel?.classList.remove("is-open"));
fileInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  loadModel(url);
  panel?.classList.add("is-open");
});
clearFileBtn?.addEventListener("click", () => {
  if (fileInput) fileInput.value = "";
  clearModel();
});
resetBtn?.addEventListener("click", () => {
  if (modelRoot) fitToModel(modelRoot);
});
clearBtn?.addEventListener("click", clearModel);
moveBtn?.addEventListener("click", () => transform.setMode("translate"));
rotateBtn?.addEventListener("click", () => transform.setMode("rotate"));
clipToggle?.addEventListener("change", (e) => setClipEnabled(e.target.checked));
clipX?.addEventListener("input", updateClipFromSliders);
clipY?.addEventListener("input", updateClipFromSliders);
clipZ?.addEventListener("input", updateClipFromSliders);

window.addEventListener("resize", resize);
if (viewEl) viewEl.addEventListener("pointerdown", selectAt);

initPromise = initThree();
window.BIMViewer = { loadModel, ensureModelLoaded, applyClipState, clearModel, initThree, ensureReady };
