const CLOUD_WMS_BASES = [
  "https://view.eumetsat.int/geoserver/wms",
  "https://view.eumetsat.int/geoserver/ows",
  "https://view.eumetsat.int/geoserver/gwc/service/wms"
];
const CLOUD_REFRESH_MS = 5 * 60 * 1000;

let cloudState = {
  view: null,
  WMSLayer: null,
  layer: null,
  enabled: false,
  timer: null,
  lastWarn: null,
  baseUrl: null,
  layerName: null,
  layerTitle: null
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

function scoreLayerName(name, title) {
  const text = `${title || ""} ${name || ""}`.toLowerCase();
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

async function fetchCapabilities(base, version) {
  const url = `${base}?service=WMS&request=GetCapabilities&version=${version}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GetCapabilities HTTP ${res.status}`);
  return res.text();
}

function findBestLayerFromCapabilities(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const layerNodes = Array.from(doc.getElementsByTagName("Layer"));
  let best = null;
  let bestScore = -999;
  layerNodes.forEach((node) => {
    const name = node.getElementsByTagName("Name")[0]?.textContent || "";
    const title = node.getElementsByTagName("Title")[0]?.textContent || "";
    if (!name) return;
    const score = scoreLayerName(name, title);
    if (score > bestScore) {
      bestScore = score;
      best = { name, title };
    }
  });
  return best;
}

async function resolveCloudLayer() {
  const versions = ["1.3.0", "1.1.1"];
  for (const base of CLOUD_WMS_BASES) {
    for (const v of versions) {
      try {
        const xml = await fetchCapabilities(base, v);
        const best = findBestLayerFromCapabilities(xml);
        if (best && scoreLayerName(best.name, best.title) > 0) {
          cloudState.baseUrl = base;
          cloudState.layerName = best.name;
          cloudState.layerTitle = best.title || best.name;
          return true;
        }
      } catch (err) {
        warnOnce("Cloud WMS capabilities failed", err);
      }
    }
  }
  return false;
}

async function buildLayer() {
  if (!cloudState.WMSLayer || !cloudState.view) return null;
  const ok = await resolveCloudLayer();
  if (!ok || !cloudState.baseUrl || !cloudState.layerName) {
    setStatus("Inga WMS‑molnlagar hittades", true);
    return null;
  }
  const layer = new cloudState.WMSLayer({
    url: cloudState.baseUrl,
    opacity: 0.6,
    sublayers: [{ name: cloudState.layerName, title: cloudState.layerTitle }]
  });
  try {
    await layer.load();
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
