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
  scene.background = new THREE.Color(0x0b1220);
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000);
  camera.position.set(6, 6, 10);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.localClippingEnabled = true;
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

  const modelUrl = viewEl.dataset.model || "./data/model.glb";
  loadModel(modelUrl);
}

function setClipEnabled(enabled) {
  if (!renderer) return;
  renderer.localClippingEnabled = enabled;
  if (modelRoot) {
    modelRoot.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          m.clippingPlanes = enabled ? clippingPlanes : [];
          m.clipIntersection = true;
          m.needsUpdate = true;
        });
      }
    });
  }
}

function updateClipFromSliders() {
  if (!planeX) return;
  planeX.constant = Number(clipX?.value || 0);
  planeY.constant = Number(clipY?.value || 0);
  planeZ.constant = Number(clipZ?.value || 0);
}

function fitToModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.5;
  camera.position.set(center.x + dist, center.y + dist, center.z + dist);
  camera.lookAt(center);
  orbit.target.copy(center);
  orbit.update();

  const range = Math.max(1, Math.ceil(maxDim));
  [clipX, clipY, clipZ].forEach((slider) => {
    if (!slider) return;
    slider.min = String(-range);
    slider.max = String(range);
    slider.step = String(Math.max(1, Math.round(range / 100)));
    slider.value = "0";
  });
  updateClipFromSliders();
}

function loadModel(url) {
  if (!loader || !url) return;
  setStatus("Laddar modell…");
  loader.load(
    url,
    (gltf) => {
      if (modelRoot) scene.remove(modelRoot);
      modelRoot = gltf.scene;
      scene.add(modelRoot);
      fitToModel(modelRoot);
      setClipEnabled(Boolean(clipToggle?.checked));
      setStatus("Model laddad.");
    },
    undefined,
    (err) => {
      console.error("[BIM] Failed to load model", err);
      setStatus("Kunde inte ladda modellen.");
    }
  );
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

window.BIMViewer = { loadModel, clearModel, initThree };
initThree();
