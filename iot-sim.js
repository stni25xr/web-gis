/* IoT simulation module */
(function () {
  if (window.__iotModuleLoaded) return;
  window.__iotModuleLoaded = true;

  function readHeaderElPrice() {
    const el = document.getElementById("elprice");
    const txt = el ? el.textContent : "";
    const m = txt.match(/([0-9]+[.,][0-9]+)/);
    if (!m) return 1.8;
    return parseFloat(m[1].replace(",", "."));
  }

  function ensureChartJs() {
    if (window.Chart) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/chart.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function computePower(minute) {
    const hour = (minute % 1440) / 60;
    const base = 220 + Math.random() * 80;
    const morning = 650 * Math.exp(-0.5 * Math.pow((hour - 7) / 1.1, 2));
    const evening = 900 * Math.exp(-0.5 * Math.pow((hour - 18) / 1.4, 2));
    const spike = Math.random() < 0.06 ? (1500 + Math.random() * 2000) : 0;
    const noise = gaussian() * 40;
    return Math.max(120, base + morning + evening + spike + noise);
  }

  function makeIotUI(container) {
    if (container.dataset.ready === "1" && container.querySelector("#iotChart")) return;
    container.innerHTML = `
      <div class="iot-modal" role="dialog" aria-label="Live el‑simulering">
        <div class="iot-header">
          <h4>Live El‑simulering</h4>
          <button id="iotClose" type="button" class="iot-close">Stäng</button>
        </div>
        <div class="iot-row">
          <div class="iot-metric" style="flex:1; min-width:100%; font-size:16px;">
            Just nu: <b id="iotPower">–</b> W
          </div>
        </div>
        <div class="iot-row">
          <div class="iot-metric">Energi: <b id="iotEnergy">–</b> kWh</div>
          <div class="iot-metric">Kostnad: <b id="iotCost">–</b> SEK</div>
        </div>
        <div class="iot-row">
          <button id="iotStart">Start</button>
          <button id="iotPause" class="secondary">Paus</button>
          <button id="iotReset" class="secondary">Reset</button>
        </div>
        <canvas id="iotChart"></canvas>
      </div>
    `;
    container.dataset.ready = "1";
    const closeBtn = document.getElementById("iotClose");
    if (closeBtn) closeBtn.onclick = () => { container.style.display = "none"; };
  }

  async function openIoTSimulation() {
    const container = document.getElementById("iotContainer");
    if (!container) return;
    makeIotUI(container);
    container.style.display = container.style.display === "flex" ? "none" : "flex";
    if (!document.getElementById("iotChart")) {
      container.dataset.ready = "0";
      makeIotUI(container);
    }
    try {
      await ensureChartJs();
    } catch (e) {
      const modal = container.querySelector(".iot-modal");
      if (modal) {
        modal.insertAdjacentHTML("beforeend", "<div style=\"margin-top:8px;color:#fca5a5;font-size:12px;\">Kunde inte ladda Chart.js (nätverk).</div>");
      }
      return;
    }
    if (!window.Chart) {
      const modal = container.querySelector(".iot-modal");
      if (modal) {
        modal.insertAdjacentHTML("beforeend", "<div style=\"margin-top:8px;color:#fca5a5;font-size:12px;\">Chart.js är inte tillgängligt.</div>");
      }
      return;
    }

    if (!window.__iotChart) {
      const ctx = document.getElementById("iotChart").getContext("2d");
      const labels = [];
      const powerData = [];
      const costData = [];

      window.__iotMinute = 0;
      window.__iotEnergy = 0;
      window.__iotCost = 0;

      window.__iotChart = new Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [
            { label: "Effekt (W)", data: powerData, yAxisID: "y1", borderColor: "#34d399", backgroundColor: "rgba(16,185,129,0.25)", tension: 0.25, fill: true, pointRadius: 0 },
            { label: "Kostnad (SEK)", data: costData, yAxisID: "y2", borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,0.15)", tension: 0.25, fill: false, pointRadius: 0 }
          ]
        },
        options: {
          responsive: true,
          animation: false,
          scales: {
            y1: { type: "linear", position: "left", ticks: { color: "#e2e8f0" }, grid: { color: "rgba(148,163,184,0.15)" } },
            y2: { type: "linear", position: "right", ticks: { color: "#e2e8f0" }, grid: { drawOnChartArea: false } },
            x: { ticks: { color: "#94a3b8", maxTicksLimit: 6 } }
          },
          plugins: { legend: { labels: { color: "#e2e8f0" } } }
        }
      });

      const powerEl = document.getElementById("iotPower");
      const energyEl = document.getElementById("iotEnergy");
      const costEl = document.getElementById("iotCost");

      function tick() {
        const p = computePower(window.__iotMinute);
        const energyKwh = p / 1000 / 60;
        const price = readHeaderElPrice();

        window.__iotEnergy += energyKwh;
        window.__iotCost += energyKwh * price;

        powerEl.textContent = Math.round(p);
        energyEl.textContent = window.__iotEnergy.toFixed(3);
        costEl.textContent = window.__iotCost.toFixed(2);

        labels.push(window.__iotMinute % 1440);
        powerData.push(p);
        costData.push(window.__iotCost);

        if (labels.length > 180) {
          labels.shift();
          powerData.shift();
          costData.shift();
        }

        window.__iotChart.update();
        window.__iotMinute += 1;
      }

      window.__iotTick = tick;

      document.getElementById("iotStart").onclick = () => {
        if (window.__iotTimer) return;
        window.__iotTimer = setInterval(tick, 1000);
      };
      document.getElementById("iotPause").onclick = () => {
        clearInterval(window.__iotTimer);
        window.__iotTimer = null;
      };
      document.getElementById("iotReset").onclick = () => {
        clearInterval(window.__iotTimer);
        window.__iotTimer = null;
        window.__iotMinute = 0;
        window.__iotEnergy = 0;
        window.__iotCost = 0;
        labels.length = 0; powerData.length = 0; costData.length = 0;
        powerEl.textContent = "–";
        energyEl.textContent = "–";
        costEl.textContent = "–";
        window.__iotChart.update();
      };
    }

    if (!window.__iotTimer) window.__iotTimer = setInterval(window.__iotTick, 1000);
  }

  window.openIoTSimulation = openIoTSimulation;

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#iotBox");
    if (!btn) return;
    openIoTSimulation();
  });
})();
