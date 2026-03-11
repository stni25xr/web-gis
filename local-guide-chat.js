(function () {
  const STORY_STEPS = [
    "Steg 1/5: Här ser du Öxnehaga i 3D. Börja med att rotera kartan och få en överblick.",
    "Steg 2/5: Öppna Information och testa service, blåljus och närmaste busshållplats med tid/distans.",
    "Steg 3/5: Klicka på en busshållplats för live avgångar och länk till tidtabell.",
    "Steg 4/5: Klicka på en byggnad för att se huset i 3D och öppna byggnadsinfo/BIM.",
    "Steg 5/5: Öppna DIGITAL CITY för vind och moln live, och testa shuttle (Call shuttle + dashboard)."
  ];

  const QUICK_ACTIONS = {
    demoList: { label: "Vad kan vi göra?" },
    overview: { label: "Kort översikt" },
    story: { label: "Starta story" },
    storyNext: { label: "Nästa steg" },
    service: { label: "Service: tid/distans" },
    blueLight: { label: "Blåljustjänster" },
    nearestBus: { label: "Närmaste busshållplats" },
    departures: { label: "Live busstidtabell" },
    callShuttle: { label: "Call shuttle" },
    shuttleDashboard: { label: "Shuttle dashboard" },
    house3d: { label: "Se hus i 3D" },
    uploadHouse: { label: "Ladda husmodell" },
    windLive: { label: "Vind live" },
    cloudLive: { label: "Molnighet live" },
    digital: { label: "Digital City" },
    documents: { label: "Dokument" }
  };

  document.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.getElementById("guideChatToggle");
    const panel = document.getElementById("guideChatPanel");
    const closeBtn = document.getElementById("guideChatClose");
    const messagesEl = document.getElementById("guideChatMessages");
    const quickEl = document.getElementById("guideChatQuick");
    const form = document.getElementById("guideChatForm");
    const input = document.getElementById("guideChatInput");

    if (!toggleBtn || !panel || !closeBtn || !messagesEl || !quickEl || !form || !input) return;

    let greeted = false;
    let storyIndex = -1;

    const openPanelByTab = (tabId) => {
      const tab = document.getElementById(tabId);
      if (tab && typeof tab.click === "function") tab.click();
    };

    const openInfoPanel = () => openPanelByTab("rightTab");
    const openDigitalPanel = () => openPanelByTab("leftTabDigital");
    const openShuttleDashboard = () => openPanelByTab("leftTabShuttle");

    const openInfoSection = (section) => {
      const details = document.querySelector(`#info-panel details[data-section="${section}"]`);
      if (details) details.open = true;
    };

    const clickById = (id) => {
      const el = document.getElementById(id);
      if (el && typeof el.click === "function") el.click();
    };

    const log = (name, value) => {
      try {
        if (typeof window.saveClick === "function") {
          window.saveClick({
            type: "chat",
            name,
            value: value || "",
            timestamp: new Date().toISOString()
          });
        }
      } catch (_err) {
        // Silent fail: chat should work even if analytics is unavailable.
      }
    };

    const scrollToBottom = () => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    };

    const addMessage = (sender, text) => {
      const row = document.createElement("div");
      row.className = "guide-chat-message " + (sender === "bot" ? "is-bot" : "is-user");
      row.textContent = text;
      messagesEl.appendChild(row);
      scrollToBottom();
    };

    const setQuickActions = (keys) => {
      quickEl.innerHTML = "";
      keys.forEach((key) => {
        const def = QUICK_ACTIONS[key];
        if (!def) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = def.label;
        btn.addEventListener("click", () => {
          handleIntent(key, true);
        });
        quickEl.appendChild(btn);
      });
    };

    const ensureGreeting = () => {
      if (greeted) return;
      greeted = true;
      addMessage("bot", "Hej! Jag är en lokal guide utan AI. Skriv 'vad kan vi göra' för att se demo-funktionerna, eller starta story.");
      setQuickActions(["demoList", "story", "service", "departures", "callShuttle", "windLive"]);
    };

    const openChat = () => {
      panel.hidden = false;
      toggleBtn.setAttribute("aria-expanded", "true");
      ensureGreeting();
      input.focus();
      log("chat_open");
    };

    const closeChat = () => {
      panel.hidden = true;
      toggleBtn.setAttribute("aria-expanded", "false");
      log("chat_close");
    };

    const storyReply = () => {
      if (storyIndex < 0) storyIndex = 0;
      if (storyIndex >= STORY_STEPS.length) {
        addMessage("bot", "Storyn är klar. Du kan starta om eller fråga om en specifik del.");
        storyIndex = -1;
        setQuickActions(["demoList", "story", "service", "callShuttle", "house3d", "windLive"]);
        return;
      }

      addMessage("bot", STORY_STEPS[storyIndex]);
      storyIndex += 1;
      setQuickActions(["storyNext", "service", "nearestBus", "house3d", "digital"]);
    };

    const handleIntent = (intent, fromQuick) => {
      if (fromQuick) addMessage("user", QUICK_ACTIONS[intent]?.label || intent);
      log("chat_intent", intent);

      switch (intent) {
        case "demoList":
          addMessage(
            "bot",
            "I demon kan du:\n" +
              "1) Räkna tid/distans till service\n" +
              "2) Se avstånd till blåljustjänster\n" +
              "3) Mäta distans till närmaste busshållplats\n" +
              "4) Se live busstidtabell (klicka hållplats)\n" +
              "5) Call shuttle från kartans popup\n" +
              "6) Öppna Shuttle dashboard\n" +
              "7) Kolla hus i 3D-kartan\n" +
              "8) Ladda husmodell (GLB)\n" +
              "9) Se vindanimation live\n" +
              "10) Se molnighet live"
          );
          setQuickActions(["service", "blueLight", "nearestBus", "departures", "callShuttle", "shuttleDashboard"]);
          return;
        case "overview":
          addMessage("bot", "Sidan visar en interaktiv 3D-karta med serviceanalys, kollektivtrafik, blåljus, hus/BIM och live-lager.");
          setQuickActions(["demoList", "story", "service", "house3d", "digital"]);
          return;
        case "story":
          storyIndex = 0;
          storyReply();
          return;
        case "storyNext":
          storyReply();
          return;
        case "service":
          openInfoPanel();
          openInfoSection("service");
          addMessage("bot", "Öppnade Information > Service nära dig. Klicka 'Mät avstånd' och klicka i kartan för tid/distans till vald service.");
          setQuickActions(["blueLight", "nearestBus", "departures", "overview"]);
          return;
        case "blueLight":
          openInfoPanel();
          openInfoSection("safety");
          openInfoSection("blue");
          addMessage("bot", "Öppnade Information > Blåljus & framkomst. Här kan du mäta avstånd/rutt till polis, ambulans och räddningstjänst.");
          setQuickActions(["service", "nearestBus", "overview"]);
          return;
        case "nearestBus":
          openInfoPanel();
          openInfoSection("bus");
          addMessage("bot", "Öppnade Närmsta busshållplats. Klicka 'Mät avstånd' och sedan i kartan för närmaste hållplats + avstånd.");
          setQuickActions(["departures", "service", "overview"]);
          return;
        case "departures":
          openInfoPanel();
          openInfoSection("departures");
          addMessage("bot", "Öppnade Avgångar. Klicka en busshållplats i kartan så visas live avgångar och länk till tidtabell.");
          setQuickActions(["nearestBus", "service", "overview"]);
          return;
        case "callShuttle":
          addMessage("bot", "För Call shuttle: klicka en byggnad/punkt i kartan och använd popup-knappen 'Call shuttle'. Då startar transportsimuleringen.");
          setQuickActions(["shuttleDashboard", "house3d", "digital", "overview"]);
          return;
        case "shuttleDashboard":
          openShuttleDashboard();
          addMessage("bot", "Jag öppnade Shuttle dashboard med live status, hastighet, batteri och mini-karta.");
          setQuickActions(["callShuttle", "digital", "overview"]);
          return;
        case "house3d":
          openInfoPanel();
          openInfoSection("selected");
          addMessage("bot", "Klicka på ett hus i 3D-kartan. I 'Valt objekt' får du info om huset och fler val.");
          setQuickActions(["uploadHouse", "documents", "overview"]);
          return;
        case "uploadHouse":
          openDigitalPanel();
          clickById("bimViewerToggle");
          addMessage("bot", "Jag öppnade DIGITAL CITY. Under BIM-viewer kan du ladda en egen GLB-husmodell och visa den i vyn.");
          setQuickActions(["house3d", "documents", "digital"]);
          return;
        case "windLive":
          openDigitalPanel();
          addMessage("bot", "Vind live finns i DIGITAL CITY > Luft. Slå på 'Vind (live)' för vindanimation i kartan.");
          setQuickActions(["cloudLive", "digital", "overview"]);
          return;
        case "cloudLive":
          openDigitalPanel();
          addMessage("bot", "Molnighet live finns i DIGITAL CITY > Luft. Slå på 'Moln (satellit)' för live molnlagret.");
          setQuickActions(["windLive", "digital", "overview"]);
          return;
        case "documents":
          openInfoPanel();
          openInfoSection("selected");
          addMessage("bot", "För dokument: klicka på en byggnad och öppna länken i 'Valt objekt' för PDF/byggnadsinformation.");
          setQuickActions(["house3d", "uploadHouse", "overview"]);
          return;
        case "digital":
          openDigitalPanel();
          addMessage("bot", "DIGITAL CITY är öppen: här styr du vind live, moln live, PM2.5, BIM-viewer och export/simuleringar.");
          setQuickActions(["windLive", "cloudLive", "uploadHouse", "overview"]);
          return;
        default:
          addMessage("bot", "Jag förstod inte helt. Testa: vad kan vi göra, service, blåljus, buss, shuttle, hus 3D, vind eller moln.");
          setQuickActions(["demoList", "story", "service", "nearestBus", "callShuttle", "windLive"]);
      }
    };

    const normalize = (value) =>
      value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim();

    const inferIntent = (raw) => {
      const text = normalize(raw);
      if (!text) return null;
      if (/(nasta|fortsatt|fortsattning|more|next)/.test(text)) return "storyNext";
      if (/(story|beratt|guide|tour|rundtur)/.test(text)) return "story";
      if (/(service|tid.*distans|distans.*service|gangtid|gangvag)/.test(text)) return "service";
      if (/(blaljus|blaljustjanst|polis|ambulans|raddning)/.test(text)) return "blueLight";
      if (/(narmaste.*buss|narmaste.*hallplats|busshallplats|hallplats)/.test(text)) return "nearestBus";
      if (/(avgang|tidtabell|live.*buss|busstid)/.test(text)) return "departures";
      if (/(call.*shuttle|boka.*shuttle|bestall.*shuttle)/.test(text)) return "callShuttle";
      if (/(shuttle.*dashboard|dashboard.*shuttle)/.test(text)) return "shuttleDashboard";
      if (/(hus.*3d|3d.*hus|kolla.*hus|mitt hus)/.test(text)) return "house3d";
      if (/(ladda.*hus|ladda.*modell|glb|upload)/.test(text)) return "uploadHouse";
      if (/(vind|wind)/.test(text)) return "windLive";
      if (/(moln|molnighet|cloud)/.test(text)) return "cloudLive";
      if (/(bygg|bim|objekt|modell)/.test(text)) return "house3d";
      if (/(pdf|dok|dokument|byggnadsinfo)/.test(text)) return "documents";
      if (/(digital|simulering|pm2|vind|moln|energi|el)/.test(text)) return "digital";
      if (/(shuttle|autonom)/.test(text)) return "callShuttle";
      if (/(vad|hjalp|help|funktion|kan man gora|vad kan vi gora|demo)/.test(text)) return "demoList";
      if (/(oversikt|overview|visa sidan)/.test(text)) return "overview";
      return null;
    };

    toggleBtn.addEventListener("click", () => {
      if (panel.hidden) openChat();
      else closeChat();
    });

    closeBtn.addEventListener("click", closeChat);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const raw = input.value.trim();
      if (!raw) return;
      addMessage("user", raw);
      log("chat_message", raw);
      input.value = "";

      const intent = inferIntent(raw);
      if (intent) handleIntent(intent, false);
      else handleIntent("unknown", false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) closeChat();
    });
  });
})();
