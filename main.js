// Skapa kartan
const map = L.map("map").setView([57.7089, 11.9746], 12); // Göteborg

// Bakgrundskarta (OpenStreetMap)
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap contributors"
}).addTo(map);

// Ladda GeoJSON
fetch("data/example.geojson")
  .then(response => response.json())
  .then(data => {
    L.geoJSON(data, {
      onEachFeature: (feature, layer) => {
        layer.bindPopup(
          `<strong>${feature.properties.name}</strong>`
        );
      },
      style: {
        color: "#2563eb",
        weight: 2
      }
    }).addTo(map);
  });
