(() => {
  let activeFlow = null;
  let toastTimer = null;

  const flowHandles = {
    BUS: { graphics: [], timers: [], domResetFns: [] },
    SERVICE: { graphics: [], timers: [], domResetFns: [] },
    CAR: { graphics: [], timers: [], domResetFns: [] }
  };

  function registerGraphic(flow, graphic) {
    const bucket = flowHandles[flow];
    if (!bucket || !graphic) return;
    bucket.graphics.push(graphic);
  }

  function registerTimer(flow, id) {
    const bucket = flowHandles[flow];
    if (!bucket || !id) return;
    bucket.timers.push(id);
  }

  function registerDomReset(flow, fn) {
    const bucket = flowHandles[flow];
    if (!bucket || typeof fn !== "function") return;
    bucket.domResetFns.push(fn);
  }

  function showToast(message) {
    const el = document.getElementById("infoFlowToast");
    if (!el) return;
    el.textContent = message || "";
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(-4px)";
    }, 2000);
  }

  function clearBusUI() {
    if (typeof window.resetNearest === "function") window.resetNearest();
    if (typeof window.clearDepartures === "function") window.clearDepartures("Klicka på en busshållplats");
  }

  function clearServiceUI() {
    const svcHint = document.getElementById("svcHint");
    const svcList = document.getElementById("svcList");
    if (svcHint) svcHint.textContent = "Klicka på kartan för att räkna avstånd";
    if (svcList) svcList.innerHTML = "";
    if (typeof window.clearRoute === "function") window.clearRoute();
  }

  function clearCarUI() {
    const safeHint = document.getElementById("safeHint");
    const safeList = document.getElementById("safeList");
    if (safeHint) safeHint.textContent = "Välj trygghetstjänst och klicka Mät avstånd";
    if (safeList) safeList.innerHTML = "";
    if (typeof window.clearSafetyRoute === "function") window.clearSafetyRoute();
    if (typeof window.stopPoliceDriveAnimation === "function") window.stopPoliceDriveAnimation();
  }

  function clearFlow(flowName) {
    if (!flowName) return;
    const bucket = flowHandles[flowName];
    if (bucket) {
      const graphics = bucket.graphics.splice(0, bucket.graphics.length);
      graphics.forEach((g) => {
        try { g?.layer?.remove(g); } catch (e) { /* ignore */ }
      });
      const timers = bucket.timers.splice(0, bucket.timers.length);
      timers.forEach((id) => {
        try { clearInterval(id); } catch (e) { /* ignore */ }
      });
      const resets = bucket.domResetFns.splice(0, bucket.domResetFns.length);
      resets.forEach((fn) => {
        try { fn(); } catch (e) { /* ignore */ }
      });
      console.log(`[FLOW] clear ${flowName} removed graphics=${graphics.length} timers=${timers.length}`);
    }
    if (flowName === "BUS") return clearBusUI();
    if (flowName === "SERVICE") return clearServiceUI();
    if (flowName === "CAR") return clearCarUI();
  }

  function activateFlow(nextFlow) {
    if (!nextFlow || activeFlow === nextFlow) return;
    if (nextFlow === "SERVICE") {
      console.log("[FLOW] activate SERVICE -> clearing CAR");
      clearFlow("CAR");
    } else if (nextFlow === "CAR") {
      console.log("[FLOW] activate CAR -> clearing SERVICE");
      clearFlow("SERVICE");
    }
    activeFlow = nextFlow;
    showToast("Tidigare visning rensades för att visa ny information.");
  }

  function clearAllNonBus() {
    clearFlow("SERVICE");
    clearFlow("CAR");
    activeFlow = null;
  }

  window.infoFlowController = {
    activateFlow,
    clearFlow,
    clearAllNonBus,
    registerGraphic,
    registerTimer,
    registerDomReset
  };
  window.flowHandles = flowHandles;
})();
