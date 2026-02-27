const CLOUD_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const CLOUD_LAYER_NAME = "MODIS_Terra_Cloud_Top_Temp_Day";
const CLOUD_REFRESH_MS = 5 * 60 * 1000;

let cloudState = {
  view: null,
  WMSLayer: null,
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

function ensureLayer() {
  if (cloudState.layer || !cloudState.WMSLayer || !cloudState.view) return;
  cloudState.layer = new cloudState.WMSLayer({
    url: CLOUD_WMS_URL,
    sublayers: [{ name: CLOUD_LAYER_NAME }],
    opacity: 0.6
  });
  cloudState.view.map.add(cloudState.layer);
}

function refreshLayer() {
  if (!cloudState.layer) return;
  cloudState.layer.customParameters = {
    TIME: todayUtcDate()
  };
  cloudState.layer.refresh();
  setStatus(`Senast uppdaterad: ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`);
}

function enableClouds() {
  cloudState.enabled = true;
  setStatus("Laddar moln...");
  ensureLayer();
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
  cloudState.WMSLayer = opts?.WMSLayer || null;
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
