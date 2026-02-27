const CLOUD_WMS_URL = "https://view.eumetsat.int/geoserver/wms";
const CLOUD_REFRESH_MS = 5 * 60 * 1000;

let cloudState = {
  view: null,
  WMSLayer: null,
  layer: null,
  enabled: false,
  timer: null,
  lastWarn: null
};

function warnOnce(key, err) {
  if (cloudState.lastWarn === key) return;
  cloudState.lastWarn = key;
  console.warn(key, err || "");
}

function setStatus(text, isError = false) {
  const el = document.getElementById("cloudStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ef4444" : "";
}

function scoreLayer(sublayer) {
  const text = `${sublayer.title || ""} ${sublayer.name || ""}`.toLowerCase();
  let score = 0;
  if (text.includes("cloud")) score += 6;
  if (text.includes("cloud top")) score += 4;
  if (text.includes("cloud mask")) score += 4;
  if (text.includes("cloud cover")) score += 4;
  if (text.includes("fog")) score += 2;
  if (text.includes("rgb")) score += 1;
  if (text.includes("night")) score -= 1;
  if (text.includes("ash")) score -= 3;
  if (text.includes("dust")) score -= 3;
  if (text.includes("precip")) score -= 2;
  return score;
}

async function buildLayer() {
  if (!cloudState.WMSLayer || !cloudState.view) return null;
  const layer = new cloudState.WMSLayer({
    url: CLOUD_WMS_URL,
    opacity: 0.6,
    sublayers: []
  });
  try {
    await layer.load();
    const candidates = layer.allSublayers?.toArray?.() || layer.allSublayers || [];
    if (!candidates.length) {
      setStatus("Inga WMS-lager hittades", true);
      return null;
    }
    let best = null;
    let bestScore = -999;
    candidates.forEach((s) => {
      const score = scoreLayer(s);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    });
    if (!best) {
      setStatus("Hittade inga moln-lager", true);
      return null;
    }
    layer.sublayers = [{ name: best.name, title: best.title }];
    return layer;
  } catch (err) {
    warnOnce("Cloud WMS load failed", err);
    setStatus("Moln WMS kunde inte laddas", true);
    return null;
  }
}

async function enableClouds() {
  cloudState.enabled = true;
  setStatus("Laddar moln...");
  if (!cloudState.layer) {
    cloudState.layer = await buildLayer();
    if (!cloudState.layer) return;
    cloudState.view.map.add(cloudState.layer);
  } else {
    cloudState.layer.visible = true;
    cloudState.layer.refresh();
  }
  setStatus(`Senast uppdaterad: ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`);
  if (cloudState.timer) clearInterval(cloudState.timer);
  cloudState.timer = setInterval(() => {
    if (cloudState.layer) cloudState.layer.refresh();
    setStatus(`Senast uppdaterad: ${new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`);
  }, CLOUD_REFRESH_MS);
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
