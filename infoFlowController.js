(() => {
  let activeFlow = null;
  let toastTimer = null;

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
    if (typeof window.clearRoute === "function") window.clearRoute();
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
  }

  function clearFlow(flowName) {
    if (!flowName) return;
    if (flowName === "BUS") return clearBusUI();
    if (flowName === "SERVICE") return clearServiceUI();
    if (flowName === "CAR") return clearCarUI();
  }

  function setActiveFlow(nextFlow) {
    if (!nextFlow || activeFlow === nextFlow) return;
    if (nextFlow !== "BUS") clearFlow("BUS");
    if (nextFlow !== "SERVICE") clearFlow("SERVICE");
    if (nextFlow !== "CAR") clearFlow("CAR");
    showToast("Tidigare visning rensades för att visa ny information.");
    activeFlow = nextFlow;
  }

  function clearAllFlows() {
    clearFlow("BUS");
    clearFlow("SERVICE");
    clearFlow("CAR");
    activeFlow = null;
  }

  window.infoFlowController = {
    setActiveFlow,
    clearFlow,
    clearAllFlows
  };
})();
