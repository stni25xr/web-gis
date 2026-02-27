const CLOUD_TILE_BASE = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/";
const CLOUD_LAYER_NAME = "MODIS_Terra_CorrectedReflectance_TrueColor";
const CLOUD_MATRIX_SET = "GoogleMapsCompatible_Level9";
const CLOUD_REFRESH_MS = 5 * 60 * 1000;

let cloudState = {
  view: null,
  WebTileLayer: null,
  layer: null,
  enabled: false,
  timer: null
};

function setStatus(text, isError = false) {
  const el = document.getElementById("cloudStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "";
}

function todayUtcDate() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildUrlTemplate(dateStr) {
  return `${CLOUD_TILE_BASE}${CLOUD_LAYER_NAME}/default/${dateStr}/${CLOUD_MATRIX_SET}/{level}/{row}/{col}.jpg`;
}

function ensureLayer(dateStr) {
  if (cloudState.layer || !cloudState.WebTileLayer || !cloudState.view) return;
  cloudState.layer = new cloudState.WebTileLayer({
    urlTemplate: buildUrlTemplate(dateStr),
    opacity: 0.8
  });
  cloudState.view.map.add(cloudState.layer);
}

function refreshLayer() {
  if (!cloudState.layer) return;
  const dateStr = todayUtcDate();
  cloudState.layer.urlTemplate = buildUrlTemplate(dateStr);
  if (typeof cloudState.layer.refresh === "function") cloudState.layer.refresh();
  setStatus(`Senast uppdaterad: ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`);
}

function enableClouds() {
  cloudState.enabled = true;
  setStatus("Laddar moln...");
  const dateStr = todayUtcDate();
  ensureLayer(dateStr);
  if (cloudState.layer) cloudState.layer.visible = true;
  refreshLayer();
  if (cloudState.timer) clearInterval(cloudState.timer);
  cloudState.timer = setInterval(refreshLayer, CLOUD_REFRESH_MS);
}

function disableClouds() {
  cloudState.enabled = false;
  if (cloudState.timer) {
    clearInterval(cloudState.timer);
    cloudState.timer = null;
  }
  if (cloudState.layer) cloudState.layer.visible = false;
  setStatus("Av");
}

window.initCloudWms = (opts) => {
  cloudState.view = opts?.view || null;
  cloudState.WebTileLayer = opts?.WebTileLayer || null;
  const toggle = document.getElementById("cloudToggle");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      enableClouds();
    } else {
      disableClouds();
    }
  });
};
