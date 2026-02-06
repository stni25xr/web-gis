var map = L.map('map').setView([57.7755, 14.2630], 15);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19
}).addTo(map);

// Din kod för marker, GeoJSON, toggla lager...
