(function () {
    const params = new URLSearchParams(window.location.search);
    const objectNumber = params.get("objectNumber") || "";
    const subtitle = document.getElementById("objectSubtitle");
    const loading = document.getElementById("loading");
    const content = document.getElementById("content");
    const emptyState = document.getElementById("emptyState");
    const factsGrid = document.getElementById("factsGrid");
    const propertySets = document.getElementById("propertySets");
    const backBtn = document.getElementById("backBtn");
    const downloadBtn = document.getElementById("downloadBtn");

    subtitle.textContent = `Object number: ${objectNumber || "(missing)"}`;

    backBtn.addEventListener("click", () => {
        if (document.referrer) {
            window.location.href = document.referrer;
        } else {
            window.location.href = "index.html";
        }
    });

    function showEmpty(message) {
        loading.style.display = "none";
        content.style.display = "none";
        emptyState.style.display = "block";
        emptyState.textContent = message;
    }

    function normalize(value) {
        return String(value || "").trim().toLowerCase();
    }

    function loadMapping() {
        try {
            return JSON.parse(localStorage.getItem("buildingInfoMapping") || "{}") || {};
        } catch (e) {
            return {};
        }
    }

    function saveMapping(map) {
        try {
            localStorage.setItem("buildingInfoMapping", JSON.stringify(map));
        } catch (e) {
            // ignore
        }
    }

    function findElementByObjectNumber(dataJson, objectNumberValue) {
        const data = JSON.parse(dataJson);
        const entities = data.EntitiesExtendedData || [];
        const target = normalize(objectNumberValue);
        const mapping = loadMapping();
        if (mapping[objectNumberValue]) {
            const cachedId = mapping[objectNumberValue];
            const cached = entities.find((e) => String(e.Id) === String(cachedId));
            if (cached) return { entity: cached, entities };
        }

        const identifierNames = new Set([
            "objektidentitet",
            "objectnumber",
            "object number",
            "id",
            "identifier",
            "uniqueid",
            "unicnumber",
            "buildingnumber",
            "globalid",
        ]);

        let fallback = null;

        for (const entity of entities) {
            const props = entity.Properties || {};
            for (const setName of Object.keys(props)) {
                const entries = props[setName] || [];
                for (const entry of entries) {
                    const name = normalize(entry.Name);
                    const value = normalize(entry.Value);
                    if (!value) continue;
                    if (value === target) {
                        if (identifierNames.has(name)) {
                            mapping[objectNumberValue] = entity.Id;
                            saveMapping(mapping);
                            return { entity, entities };
                        }
                        if (!fallback) fallback = entity;
                    }
                }
            }
        }

        if (fallback) {
            mapping[objectNumberValue] = fallback.Id;
            saveMapping(mapping);
            return { entity: fallback, entities };
        }

        return { entity: null, entities };
    }

    function flattenProperties(entity) {
        const props = entity.Properties || {};
        const items = [];
        for (const setName of Object.keys(props)) {
            const entries = props[setName] || [];
            for (const entry of entries) {
                items.push({
                    set: setName,
                    name: entry.Name,
                    value: entry.Value,
                });
            }
        }
        return items;
    }

    function findByKeywords(items, keywords) {
        const matches = items.filter((item) => {
            const name = normalize(item.name);
            return keywords.some((k) => name.includes(k));
        });
        if (matches.length > 0) return matches[0].value;
        return null;
    }

    function renderFacts(items) {
        const facts = [
            { label: "Site size", value: findByKeywords(items, ["site", "plot", "tomt", "area site"]) },
            { label: "House size", value: findByKeywords(items, ["area", "gross", "net", "boarea", "bruksarea", "bta", "yta"]) },
            { label: "Height", value: findByKeywords(items, ["height", "höjd", "elevation"]) },
            { label: "Roof slope", value: findByKeywords(items, ["roof", "slope", "tak", "lutning"]) },
            { label: "U-value", value: findByKeywords(items, ["u-value", "u value", "u-värde"]) },
            { label: "Year of build", value: findByKeywords(items, ["year", "built", "construction", "byggår"]) },
            { label: "Storeys count", value: findByKeywords(items, ["storey", "storeys", "floors", "våning"]) },
            { label: "Energy / classification", value: findByKeywords(items, ["energy", "classification", "klass", "energ"]) },
        ];

        factsGrid.innerHTML = "";
        facts.forEach((fact) => {
            const card = document.createElement("div");
            card.className = "card";
            const title = document.createElement("h3");
            title.textContent = fact.label;
            const value = document.createElement("p");
            value.textContent = fact.value || "Not available in model";
            card.appendChild(title);
            card.appendChild(value);
            factsGrid.appendChild(card);
        });
    }

    function renderPropertySets(entity) {
        propertySets.innerHTML = "";
        const props = entity.Properties || {};
        const setNames = Object.keys(props);
        if (setNames.length === 0) {
            propertySets.innerHTML = "<div class=\"empty\">No property sets found.</div>";
            return;
        }

        setNames.forEach((setName) => {
            const details = document.createElement("details");
            details.open = false;
            const summary = document.createElement("summary");
            summary.textContent = setName;
            details.appendChild(summary);

            const table = document.createElement("table");
            const headerRow = document.createElement("tr");
            const nameTh = document.createElement("th");
            nameTh.textContent = "Property";
            const valueTh = document.createElement("th");
            valueTh.textContent = "Value";
            headerRow.appendChild(nameTh);
            headerRow.appendChild(valueTh);
            table.appendChild(headerRow);

            (props[setName] || []).forEach((entry) => {
                const row = document.createElement("tr");
                const nameTd = document.createElement("td");
                const valueTd = document.createElement("td");
                nameTd.textContent = entry.Name || "";
                valueTd.textContent = entry.Value != null ? String(entry.Value) : "";
                row.appendChild(nameTd);
                row.appendChild(valueTd);
                table.appendChild(row);
            });

            details.appendChild(table);
            propertySets.appendChild(details);
        });
    }

    function render(entity, exportPayload) {
        loading.style.display = "none";
        content.style.display = "block";
        emptyState.style.display = "none";

        const items = flattenProperties(entity);
        renderFacts(items);
        renderPropertySets(entity);

        downloadBtn.onclick = () => {
            const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `building-info-${objectNumber || "object"}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        };
    }

    function loadData() {
        if (!objectNumber) {
            showEmpty("No object number provided.");
            return;
        }

        const run = async () => {
            const dataJson = window.ifcStorage ? await window.ifcStorage.loadDataJson() : null;
            if (!dataJson) {
                showEmpty("No IFC data found. Open the BIM viewer and load the model first.");
                return;
            }

            const { entity } = findElementByObjectNumber(dataJson, objectNumber);
            if (!entity) {
                showEmpty("Object not found in the current model.");
                return;
            }

            console.log(`Object mapped: ${objectNumber} -> ${entity.Id}`);

            const items = flattenProperties(entity);
            const exportPayload = {
                objectNumber,
                entityId: entity.Id,
                properties: entity.Properties || {},
                keyFacts: {
                    siteSize: findByKeywords(items, ["site", "plot", "tomt", "area site"]) || null,
                    houseSize: findByKeywords(items, ["area", "gross", "net", "boarea", "bruksarea", "bta", "yta"]) || null,
                    height: findByKeywords(items, ["height", "höjd", "elevation"]) || null,
                    roofSlope: findByKeywords(items, ["roof", "slope", "tak", "lutning"]) || null,
                    uValue: findByKeywords(items, ["u-value", "u value", "u-värde"]) || null,
                    yearOfBuild: findByKeywords(items, ["year", "built", "construction", "byggår"]) || null,
                    storeysCount: findByKeywords(items, ["storey", "storeys", "floors", "våning"]) || null,
                    energy: findByKeywords(items, ["energy", "classification", "klass", "energ"]) || null,
                },
            };

            render(entity, exportPayload);
        };

        if ("requestIdleCallback" in window) {
            window.requestIdleCallback(run, { timeout: 2000 });
        } else {
            setTimeout(run, 0);
        }
    }

    loadData();
})();
