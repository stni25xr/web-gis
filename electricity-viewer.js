(function () {
  const TARGET_GUID = "e11f4a59-b4e9-4316-8850-3fe72633a93d";
  const STYLE_INDEX = {
    wall: 210,
    green: 211,
    orange: 212,
    purple: 213,
    red: 214
  };

  const COLORS = {
    wall: [210, 180, 140, 102], // light brown, ~40% opaque
    green: [34, 197, 94, 255],
    orange: [245, 158, 11, 255],
    purple: [139, 92, 246, 255],
    red: [239, 68, 68, 255]
  };

  const state = {
    targetId: null,
    wallIds: null,
    lastColorKey: null,
    lastW: null,
    lastUpdateTs: 0,
    debounceTimer: null,
    pendingW: null,
    wallStyleApplied: false
  };

  function getViewer() {
    return window.__bimViewer || window.viewer || null;
  }

  function isViewerReady() {
    const v = getViewer();
    return !!(v && !v.empty && typeof v.setStyle === "function");
  }

  function colorKeyForW(w) {
    if (w >= 1500) return "red";
    if (w >= 500) return "purple";
    if (w >= 300) return "orange";
    return "green";
  }

  function findElementIdByGlobalId(globalId) {
    if (state.targetId) return state.targetId;
    const data = window.entitiesExtendedData;
    if (!data || !globalId) return null;

    const target = String(globalId).toLowerCase();
    for (const key in data) {
      const entity = data[key];
      if (!entity) continue;

      const props = entity.Properties;
      if (props) {
        for (const groupName in props) {
          const group = props[groupName];
          if (!Array.isArray(group)) continue;
          for (let i = 0; i < group.length; i += 1) {
            const prop = group[i];
            const name = (prop && prop.Name ? String(prop.Name) : "").toLowerCase();
            if (name === "globalid") {
              const value = prop && prop.Value !== undefined ? String(prop.Value).toLowerCase() : "";
              if (value === target) {
                state.targetId = parseInt(key, 10);
                console.log(`Target element mapped: ${globalId} -> ${state.targetId}`);
                return state.targetId;
              }
            }
          }
        }
      }

      const fallbackName = entity.Name ? String(entity.Name).toLowerCase() : "";
      if (fallbackName === target) {
        state.targetId = parseInt(key, 10);
        console.log(`Target element mapped: ${globalId} -> ${state.targetId}`);
        return state.targetId;
      }
    }

    return null;
  }

  function collectWallIds() {
    const viewer = getViewer();
    if (!viewer || typeof viewer.getProductsOfType !== "function") return [];

    const ids = [];
    if (window.ProductType) {
      if (ProductType.IFCWALL !== undefined) {
        viewer.getProductsOfType(ProductType.IFCWALL).forEach((m) => ids.push(m.productID));
      }
      if (ProductType.IFCWALLSTANDARDCASE !== undefined) {
        viewer.getProductsOfType(ProductType.IFCWALLSTANDARDCASE).forEach((m) => ids.push(m.productID));
      }
    }

    if (!ids.length && window.entitiesExtendedData) {
      for (const key in window.entitiesExtendedData) {
        const entity = window.entitiesExtendedData[key];
        const typeName = entity && entity.PType ? String(entity.PType).toLowerCase() : "";
        if (typeName.includes("ifcwall")) ids.push(parseInt(key, 10));
      }
    }

    const unique = Array.from(new Set(ids.filter((v) => Number.isFinite(v))));
    return unique;
  }

  function applyWallStyle() {
    if (!isViewerReady()) return false;
    const viewer = getViewer();

    if (!state.wallIds) {
      state.wallIds = collectWallIds();
    }

    if (!state.wallIds.length) return false;

    viewer.defineStyle(STYLE_INDEX.wall, COLORS.wall);
    viewer.setStyle(STYLE_INDEX.wall, state.wallIds);
    state.wallStyleApplied = true;
    console.log(`Wall styling applied: ${state.wallIds.length} walls`);

    if (state.lastW !== null) {
      applyTargetColor(state.lastW);
    }

    return true;
  }

  function applyTargetColor(w) {
    if (!isViewerReady()) return;
    const viewer = getViewer();

    const targetId = findElementIdByGlobalId(TARGET_GUID);
    if (!targetId) return;

    const colorKey = colorKeyForW(w);
    state.lastW = w;

    if (colorKey === state.lastColorKey) {
      console.log(`W updated: ${Math.round(w)} => ${colorKey}`);
      return;
    }

    const styleIndex = STYLE_INDEX[colorKey];
    viewer.defineStyle(styleIndex, COLORS[colorKey]);
    viewer.setStyle(styleIndex, [targetId]);
    state.lastColorKey = colorKey;

    console.log(`W updated: ${Math.round(w)} => ${colorKey}`);
  }

  function processPendingUpdate() {
    if (state.pendingW === null || state.pendingW === undefined) return;
    applyTargetColor(state.pendingW);
  }

  function onPowerUpdate(w) {
    if (!Number.isFinite(w)) return;
    state.pendingW = w;

    const now = Date.now();
    const minInterval = 100;

    if (now - state.lastUpdateTs >= minInterval) {
      state.lastUpdateTs = now;
      processPendingUpdate();
      return;
    }

    if (state.debounceTimer) return;
    const delay = Math.max(0, minInterval - (now - state.lastUpdateTs));
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      state.lastUpdateTs = Date.now();
      processPendingUpdate();
    }, delay);
  }

  function startElectricSimulation() {
    const attemptApply = (triesLeft) => {
      if (applyWallStyle()) return;
      if (triesLeft <= 0) return;
      setTimeout(() => attemptApply(triesLeft - 1), 400);
    };

    attemptApply(10);
    findElementIdByGlobalId(TARGET_GUID);
  }

  window.startElectricSimulation = startElectricSimulation;
  window.onPowerUpdate = onPowerUpdate;
  window.applyTargetColor = applyTargetColor;
  window.applyWallStyle = applyWallStyle;
  window.findElementIdByGlobalId = findElementIdByGlobalId;

  window.addEventListener("message", (event) => {
    const data = event && event.data ? event.data : null;
    if (!data || typeof data !== "object") return;
    if (data.type === "electric-start") {
      startElectricSimulation();
      if (Number.isFinite(data.lastW)) onPowerUpdate(data.lastW);
    }
    if (data.type === "power-update") {
      onPowerUpdate(data.W);
    }
  });
})();
