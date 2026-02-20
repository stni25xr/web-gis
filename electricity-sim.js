/*
  Front-end only electricity meter simulation for one building object.
  No backend calls. Data persisted in localStorage.
*/
(function () {
  const OBJECT_ID = "e11f4a59-b4e9-4316-8850-3fe72633a93d";
  const STORAGE_KEY = `el_sim_${OBJECT_ID}`;
  const SIM_START_TS = Date.UTC(2026, 0, 1, 0, 0, 0);
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const LIVE_TICK_MS = 1000; // 1 second realtime = 1 simulated minute
  const MAX_WATT_FOR_RING = 10000;

  const svInt = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });
  const sv2 = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const app = {
    state: null,
    chart: null,
    chartCtor: null,
    timer: null,
    activeRange: 5,
    saveCounter: 0,
    initialized: false
  };

  function resolveChartCtor() {
    if (typeof window.Chart === "function") return window.Chart;
    if (window.Chart && typeof window.Chart.Chart === "function") return window.Chart.Chart;
    if (window.ChartJS && typeof window.ChartJS.Chart === "function") return window.ChartJS.Chart;
    return null;
  }

  function nbsToSpace(v) {
    return String(v).replace(/\u00A0/g, " ");
  }

  function fmtW(v) {
    return `${nbsToSpace(svInt.format(Math.max(0, v)))} W`;
  }

  function fmtKwh(v) {
    return `${nbsToSpace(sv2.format(Math.max(0, v)))} kWh`;
  }

  function fmtSek(v) {
    return `${nbsToSpace(sv2.format(Math.max(0, v)))} kr`;
  }

  function fmtHHmm(ts) {
    return new Date(ts).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  }

  function seedFromObjectId(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function rand() {
      t += 0x6D2B79F5;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rand) {
    const u1 = Math.max(rand(), 1e-8);
    const u2 = Math.max(rand(), 1e-8);
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function simulateMinuteWatt(ts) {
    const idx = Math.floor((ts - SIM_START_TS) / MINUTE_MS);
    const seed = seedFromObjectId(OBJECT_ID) + idx;
    const rand = mulberry32(seed);

    const d = new Date(ts);
    const hour = d.getUTCHours() + (d.getUTCMinutes() / 60);

    const base = 220 + (rand() * 120);
    const nightFactor = (hour >= 0 && hour < 5) ? 0.75 : 1.0;

    const morningPeak = 1400 * Math.exp(-0.5 * Math.pow((hour - 7.1) / 1.15, 2));
    const eveningPeak = 1900 * Math.exp(-0.5 * Math.pow((hour - 18.3) / 1.45, 2));

    let spike = 0;
    if (rand() < 0.045) {
      spike = 1500 + (rand() * 2000);
    }

    const noise = gauss(rand) * 70;
    const w = ((base * nightFactor) + morningPeak + eveningPeak + spike + noise);
    return Math.max(180, Math.min(6500, Math.round(w)));
  }

  function floorToMinute(ts) {
    return Math.floor(ts / MINUTE_MS) * MINUTE_MS;
  }

  function floorToHour(ts) {
    return Math.floor(ts / HOUR_MS) * HOUR_MS;
  }

  function floorToDay(ts) {
    return Math.floor(ts / DAY_MS) * DAY_MS;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) throw new Error("no-state");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.m) || !Array.isArray(parsed.h) || !Array.isArray(parsed.d)) {
        throw new Error("bad-state");
      }
      return parsed;
    } catch (_e) {
      return {
        v: 1,
        lastTs: SIM_START_TS - MINUTE_MS,
        m: [], // minute: [ts, watt]
        h: [], // hourly aggregates: [hourTs, wattHour, maxW, maxTs]
        d: []  // daily aggregates: [dayTs, wattHour, maxW, maxTs]
      };
    }
  }

  function saveState(force) {
    app.saveCounter += 1;
    if (!force && app.saveCounter % 10 !== 0) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(app.state));
    } catch (_e) {
      // localStorage quota can be reached; ignore hard failure in UI
    }
  }

  function mergeAggRow(map, keyTs, addWh, watt, sourceTs) {
    const row = map.get(keyTs);
    if (!row) {
      map.set(keyTs, [keyTs, addWh, watt, sourceTs]);
      return;
    }
    row[1] += addWh;
    if (watt > row[2]) {
      row[2] = watt;
      row[3] = sourceTs;
    }
  }

  function compactStorage(nowTs) {
    const minuteCutoff = nowTs - (7 * DAY_MS);
    const hourCutoff = nowTs - (30 * DAY_MS);

    if (app.state.m.length) {
      const hMap = new Map(app.state.h.map((r) => [r[0], [...r]]));
      const keepMinute = [];
      for (const [ts, w] of app.state.m) {
        if (ts >= minuteCutoff) {
          keepMinute.push([ts, w]);
        } else {
          const hourTs = floorToHour(ts);
          const wh = w / 60;
          mergeAggRow(hMap, hourTs, wh, w, ts);
        }
      }
      app.state.m = keepMinute;
      app.state.h = Array.from(hMap.values()).sort((a, b) => a[0] - b[0]);
    }

    if (app.state.h.length) {
      const dMap = new Map(app.state.d.map((r) => [r[0], [...r]]));
      const keepHour = [];
      for (const [hourTs, wh, maxW, maxTs] of app.state.h) {
        if (hourTs >= hourCutoff) {
          keepHour.push([hourTs, wh, maxW, maxTs]);
        } else {
          const dayTs = floorToDay(hourTs);
          mergeAggRow(dMap, dayTs, wh, maxW, maxTs);
        }
      }
      app.state.h = keepHour;
      app.state.d = Array.from(dMap.values()).sort((a, b) => a[0] - b[0]);
    }

    // keep last 365 days in daily aggregates
    const dayKeepCutoff = nowTs - (365 * DAY_MS);
    app.state.d = app.state.d.filter((r) => r[0] >= dayKeepCutoff);
  }

  async function catchUpToNow(onProgress) {
    const nowTs = floorToMinute(Date.now());
    let ts = app.state.lastTs + MINUTE_MS;
    if (ts > nowTs) return;

    let count = 0;
    const total = Math.floor((nowTs - ts) / MINUTE_MS) + 1;

    while (ts <= nowTs) {
      const batchEnd = Math.min(ts + (5000 * MINUTE_MS), nowTs + MINUTE_MS);
      while (ts < batchEnd) {
        const w = simulateMinuteWatt(ts);
        app.state.m.push([ts, w]);
        app.state.lastTs = ts;
        ts += MINUTE_MS;
        count += 1;
      }
      compactStorage(app.state.lastTs);
      saveState(false);
      if (onProgress) onProgress(count, total);
      await new Promise((r) => setTimeout(r, 0));
    }
    saveState(true);
  }

  function getHeaderPrice() {
    const el = document.getElementById("elprice");
    const t = el ? el.textContent : "";
    const m = t.match(/([0-9]+[.,][0-9]+)/);
    if (!m) return 1.8;
    const p = parseFloat(m[1].replace(",", "."));
    return Number.isFinite(p) ? p : 1.8;
  }

  function getRangeMinutes() {
    return app.activeRange;
  }

  function getRecentMinuteRows(minutes) {
    const endTs = app.state.lastTs;
    const startTs = endTs - ((minutes - 1) * MINUTE_MS);
    return app.state.m.filter(([ts]) => ts >= startTs && ts <= endTs);
  }

  function getTodayRows() {
    const dayStart = floorToDay(app.state.lastTs);
    return app.state.m.filter(([ts]) => ts >= dayStart && ts <= app.state.lastTs);
  }

  function sumWhFromMinuteRows(rows) {
    let wh = 0;
    for (const row of rows) wh += row[1] / 60;
    return wh;
  }

  function totalWhAllTime() {
    let wh = 0;
    for (const [, w] of app.state.m) wh += w / 60;
    for (const [, hWh] of app.state.h) wh += hWh;
    for (const [, dWh] of app.state.d) wh += dWh;
    return wh;
  }

  function rangeLabelForLastHour() {
    const end = app.state.lastTs;
    const start = end - (59 * MINUTE_MS);
    return `${fmtHHmm(start)} - ${fmtHHmm(end + MINUTE_MS)}`;
  }

  function updateRing(nowW) {
    const ring = document.getElementById("elsimRing");
    if (!ring) return;
    const p = Math.max(0, Math.min(1, nowW / MAX_WATT_FOR_RING));
    const deg = Math.round(360 * p);
    ring.style.background = `conic-gradient(#2dd4bf 0deg, #2dd4bf ${deg}deg, #263243 ${deg}deg 360deg)`;
  }

  function buildModalHtml() {
    return `
      <div class="elsim-modal" role="dialog" aria-label="El-simulering">
        <div class="elsim-top">
          <div class="elsim-now">
            <div id="elsimRing" class="elsim-ring"></div>
            <div>
              <div class="elsim-now-label">Just nu</div>
              <div id="elsimNow" class="elsim-now-value">0 W</div>
            </div>
          </div>
          <div class="elsim-pill-row">
            <button id="elsimHistoryBtn" class="elsim-pill" type="button">Historik</button>
            <button id="elsimClose" class="elsim-close" type="button">Stäng</button>
          </div>
        </div>

        <div class="elsim-chart">
          <canvas id="elsimChart"></canvas>
        </div>

        <div class="elsim-ranges">
          <button class="elsim-range-btn" data-range="1440" type="button">24 t</button>
          <button class="elsim-range-btn" data-range="360" type="button">6 t</button>
          <button class="elsim-range-btn" data-range="60" type="button">1 t</button>
          <button class="elsim-range-btn active" data-range="5" type="button">5 min</button>
        </div>

        <div class="elsim-kpis">
          <div class="elsim-kpi">
            <div id="elsimHourLabel" class="elsim-kpi-title">11:00 - 12:00</div>
            <div id="elsimHourKwh" class="elsim-kpi-value">0,00 kWh</div>
            <div class="elsim-progress"><span id="elsimHourProgress"></span></div>
          </div>
          <div class="elsim-kpi">
            <div class="elsim-kpi-title">Förbrukat idag</div>
            <div id="elsimTodayKwh" class="elsim-kpi-value">0,00 kWh</div>
            <div id="elsimTodayCost" class="elsim-kpi-sub">0,00 kr</div>
          </div>
          <div class="elsim-kpi">
            <div class="elsim-kpi-title">Högst idag</div>
            <div id="elsimPeakW" class="elsim-kpi-value">0 W</div>
            <div id="elsimPeakTime" class="elsim-kpi-sub">--:--</div>
          </div>
        </div>

        <div class="elsim-controls">
          <button id="elsimStart" class="primary" type="button">Start</button>
          <button id="elsimPause" type="button">Paus</button>
          <button id="elsimReset" type="button">Reset</button>
          <div id="elsimLoading" class="elsim-loading"></div>
        </div>
      </div>
    `;
  }

  function ensureContainerUi() {
    const container = document.getElementById("iotContainer");
    if (!container) return null;
    if (!container.querySelector(".elsim-modal")) {
      container.innerHTML = buildModalHtml();
    }
    return container;
  }

  async function ensureChartJs() {
    app.chartCtor = resolveChartCtor();
    if (app.chartCtor) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    app.chartCtor = resolveChartCtor();
    if (!app.chartCtor) {
      throw new Error("Chart.js kunde inte initieras");
    }
  }

  function initChart() {
    if (app.chart) return;
    const Ctor = app.chartCtor || resolveChartCtor();
    if (!Ctor) throw new Error("Chart.js constructor saknas");
    const ctx = document.getElementById("elsimChart");
    if (!ctx) return;
    app.chart = new Ctor(ctx.getContext("2d"), {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            data: [],
            borderColor: "#2dd4bf",
            backgroundColor: "rgba(45, 212, 191, 0.22)",
            fill: true,
            tension: 0.28,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 0
          },
          {
            data: [],
            borderColor: "#2dd4bf",
            backgroundColor: "#2dd4bf",
            borderWidth: 0,
            pointRadius: 6,
            pointHoverRadius: 6,
            showLine: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(context) {
                return fmtW(context.parsed.y);
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: "rgba(148,163,184,0.15)" },
            ticks: { color: "#94a3b8", maxTicksLimit: 6 }
          },
          y: {
            position: "right",
            beginAtZero: true,
            suggestedMax: 2500,
            grid: { color: "rgba(148,163,184,0.25)" },
            ticks: {
              color: "#94a3b8",
              callback(value) {
                return nbsToSpace(svInt.format(value));
              }
            }
          }
        }
      }
    });
  }

  function renderChart() {
    if (!app.chart) return;
    const rows = getRecentMinuteRows(getRangeMinutes());
    const labels = rows.map((r) => fmtHHmm(r[0]));
    const powers = rows.map((r) => r[1]);
    const last = powers.length ? powers[powers.length - 1] : null;

    app.chart.data.labels = labels;
    app.chart.data.datasets[0].data = powers;
    app.chart.data.datasets[1].data = last === null ? [] : new Array(Math.max(0, powers.length - 1)).fill(null).concat([last]);

    const maxVal = powers.length ? Math.max(...powers) : 2000;
    app.chart.options.scales.y.suggestedMax = Math.max(2000, Math.ceil(maxVal / 500) * 500);
    app.chart.update();
  }

  function renderKpisAndNow() {
    const lastPoint = app.state.m[app.state.m.length - 1];
    const nowW = lastPoint ? lastPoint[1] : 0;
    const price = getHeaderPrice();

    const nowEl = document.getElementById("elsimNow");
    if (nowEl) nowEl.textContent = fmtW(nowW);
    updateRing(nowW);

    const lastHourRows = getRecentMinuteRows(60);
    const hourWh = sumWhFromMinuteRows(lastHourRows);
    const hourKwh = hourWh / 1000;
    const hourLabel = document.getElementById("elsimHourLabel");
    const hourKwhEl = document.getElementById("elsimHourKwh");
    const hourProgress = document.getElementById("elsimHourProgress");
    if (hourLabel) hourLabel.textContent = rangeLabelForLastHour();
    if (hourKwhEl) hourKwhEl.textContent = fmtKwh(hourKwh);
    if (hourProgress) {
      const pct = Math.max(0, Math.min(100, (hourKwh / 5) * 100));
      hourProgress.style.width = `${pct}%`;
    }

    const todayRows = getTodayRows();
    const todayKwh = (sumWhFromMinuteRows(todayRows) / 1000);
    const todayKwhEl = document.getElementById("elsimTodayKwh");
    const todayCostEl = document.getElementById("elsimTodayCost");
    if (todayKwhEl) todayKwhEl.textContent = fmtKwh(todayKwh);
    if (todayCostEl) {
      const totalWh = totalWhAllTime();
      const totalCost = (totalWh / 1000) * price;
      todayCostEl.textContent = `${fmtSek(todayKwh * price)} idag • ${fmtSek(totalCost)} totalt`;
    }

    let peakW = 0;
    let peakTs = app.state.lastTs;
    for (const [ts, w] of todayRows) {
      if (w > peakW) {
        peakW = w;
        peakTs = ts;
      }
    }
    const peakWEl = document.getElementById("elsimPeakW");
    const peakTimeEl = document.getElementById("elsimPeakTime");
    if (peakWEl) peakWEl.textContent = fmtW(peakW);
    if (peakTimeEl) peakTimeEl.textContent = fmtHHmm(peakTs);
  }

  function renderAll() {
    renderChart();
    renderKpisAndNow();
  }

  function tickOneMinute() {
    const nextTs = app.state.lastTs + MINUTE_MS;
    const w = simulateMinuteWatt(nextTs);
    app.state.m.push([nextTs, w]);
    app.state.lastTs = nextTs;
    compactStorage(nextTs);
    saveState(false);
    renderAll();
  }

  function startLive() {
    if (app.timer) return;
    app.timer = setInterval(tickOneMinute, LIVE_TICK_MS);
  }

  function pauseLive() {
    if (!app.timer) return;
    clearInterval(app.timer);
    app.timer = null;
  }

  function resetSimulation() {
    pauseLive();
    app.state = {
      v: 1,
      lastTs: SIM_START_TS - MINUTE_MS,
      m: [],
      h: [],
      d: []
    };
    saveState(true);
    const loading = document.getElementById("elsimLoading");
    if (loading) loading.textContent = "Återställer och bygger historik…";
    catchUpToNow((done, total) => {
      const p = Math.round((done / Math.max(1, total)) * 100);
      if (loading) loading.textContent = `Bygger historik: ${p}%`;
    }).then(() => {
      if (loading) loading.textContent = "";
      renderAll();
      startLive();
    });
  }

  function wireUiEvents(container) {
    container.onclick = (evt) => {
      if (evt.target === container) {
        container.style.display = "none";
      }
    };

    const closeBtn = document.getElementById("elsimClose");
    if (closeBtn) closeBtn.onclick = () => { container.style.display = "none"; };

    const historyBtn = document.getElementById("elsimHistoryBtn");
    if (historyBtn) {
      historyBtn.onclick = () => {
        app.activeRange = 1440;
        setActiveRangeButton();
        renderChart();
      };
    }

    const startBtn = document.getElementById("elsimStart");
    const pauseBtn = document.getElementById("elsimPause");
    const resetBtn = document.getElementById("elsimReset");
    if (startBtn) startBtn.onclick = startLive;
    if (pauseBtn) pauseBtn.onclick = pauseLive;
    if (resetBtn) resetBtn.onclick = resetSimulation;

    const rangeButtons = container.querySelectorAll(".elsim-range-btn");
    rangeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const r = parseInt(btn.getAttribute("data-range"), 10);
        if (!Number.isFinite(r)) return;
        app.activeRange = r;
        setActiveRangeButton();
        renderChart();
      });
    });
  }

  function setActiveRangeButton() {
    document.querySelectorAll(".elsim-range-btn").forEach((btn) => {
      const r = parseInt(btn.getAttribute("data-range"), 10);
      btn.classList.toggle("active", r === app.activeRange);
    });
  }

  async function bootstrapIfNeeded(container) {
    if (app.initialized) return;
    app.initialized = true;

    app.state = loadState();
    const loading = document.getElementById("elsimLoading");
    if (loading) loading.textContent = "Bygger historik…";

    await catchUpToNow((done, total) => {
      const pct = Math.round((done / Math.max(1, total)) * 100);
      if (loading) loading.textContent = `Bygger historik: ${pct}%`;
    });

    await ensureChartJs();
    initChart();
    wireUiEvents(container);
    setActiveRangeButton();
    renderAll();

    if (loading) loading.textContent = "";
    startLive();
  }

  async function openIoTSimulation() {
    const container = ensureContainerUi();
    if (!container) return;
    container.style.display = "flex";
    try {
      await bootstrapIfNeeded(container);
    } catch (err) {
      const loading = document.getElementById("elsimLoading");
      if (loading) loading.textContent = `Fel: ${err && err.message ? err.message : "okänt fel"}`;
    }
  }

  window.openIoTSimulation = openIoTSimulation;

  document.addEventListener("click", (evt) => {
    const btn = evt.target.closest("#iotBox");
    if (!btn) return;
    openIoTSimulation();
  });
})();
