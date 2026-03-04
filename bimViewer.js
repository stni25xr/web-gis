import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { OrbitControls } from "https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "https://unpkg.com/three@0.160.0/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";

const panel = document.getElementById("bimViewerPanel");
const viewEl = document.getElementById("bimView");
const toggleBtn = document.getElementById("bimViewerToggle");
const fileInput = document.getElementById("bimViewerFile");
if (!panel || !viewEl) {
  console.warn("[BIM] Panel not found");
}

const moveBtn = document.getElementById("bimViewerMove");
const rotateBtn = document.getElementById("bimViewerRotate");
const closeBtn = document.getElementById("bimViewerClose");
const resetBtn = document.getElementById("bimViewerReset");
const clearBtn = document.getElementById("bimViewerClear");
const clipToggle = document.getElementById("bimClipToggle");
const clipX = document.getElementById("bimClipX");
const clipY = document.getElementById("bimClipY");
const clipZ = document.getElementById("bimClipZ");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000);
camera.position.set(6, 6, 10);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.localClippingEnabled = true;
viewEl.appendChild(renderer.domElement);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

const transform = new TransformControls(camera, renderer.domElement);
transform.addEventListener("dragging-changed", (e) => {
  orbit.enabled = !e.value;
});
scene.add(transform);

const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, 0.7);
dir.position.set(5, 10, 8);
scene.add(dir);

const planeX = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
const planeY = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeZ = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const clippingPlanes = [planeX, planeY, planeZ];

let modelRoot = null;

function setClipEnabled(enabled) {
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

const loader = new GLTFLoader();

function loadModel(url) {
  if (!url) return;
  loader.load(
    url,
    (gltf) => {
      if (modelRoot) scene.remove(modelRoot);
      modelRoot = gltf.scene;
      scene.add(modelRoot);
      fitToModel(modelRoot);
      setClipEnabled(Boolean(clipToggle?.checked));
    },
    undefined,
    (err) => {
      console.error("[BIM] Failed to load model", err);
    }
  );
}

const modelUrl = viewEl.dataset.model || "./data/model.glb";
loadModel(modelUrl);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function selectAt(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const targets = [];
  if (modelRoot) {
    modelRoot.traverse((child) => {
      if (child.isMesh) targets.push(child);
    });
  }
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length) {
    transform.attach(hits[0].object);
  }
}

renderer.domElement.addEventListener("pointerdown", selectAt);

moveBtn?.addEventListener("click", () => transform.setMode("translate"));
rotateBtn?.addEventListener("click", () => transform.setMode("rotate"));
closeBtn?.addEventListener("click", () => panel?.classList.remove("is-open"));
toggleBtn?.addEventListener("click", () => {
  panel?.classList.toggle("is-open");
});
fileInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  loadModel(url);
});

resetBtn?.addEventListener("click", () => {
  if (modelRoot) fitToModel(modelRoot);
});

clearBtn?.addEventListener("click", () => {
  if (modelRoot) {
    scene.remove(modelRoot);
    modelRoot = null;
  }
  transform.detach();
});

clipToggle?.addEventListener("change", (e) => setClipEnabled(e.target.checked));
clipX?.addEventListener("input", updateClipFromSliders);
clipY?.addEventListener("input", updateClipFromSliders);
clipZ?.addEventListener("input", updateClipFromSliders);

function resize() {
  const w = viewEl.clientWidth || 1;
  const h = viewEl.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
}
animate();

window.BIMViewer = { loadModel };
