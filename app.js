require([
  "esri/Map",
  "esri/views/SceneView",
  "esri/layers/GraphicsLayer",
  "esri/Graphic"
], function(Map, SceneView, GraphicsLayer, Graphic) {

  // 1️⃣ Create the 3D map
  var map = new Map({
    basemap: "streets",
    ground: "world-elevation"
  });

  var view = new SceneView({
    container: "viewDiv",
    map: map,
    camera: {
      position: [14.26299, 57.77549, 500], // longitude, latitude, height
      tilt: 70
    }
  });

  // 2️⃣ Marker data
  var markersData = [
    {name: "Öxnehagaskolan", coords: [14.264435086506042, 57.774355430786756]},
    {name: "Bra Liv, Öxnehaga vårdcentral", coords: [14.265454325908154, 57.774896080613715]},
    {name: "Kohagens förskola", coords: [14.262321505792743, 57.77374039598473]},
    {name: "Öxnehaga IP", coords: [14.255866087552105, 57.77297837973305]},
    {name: "Höjdens Öxnehaga", coords: [14.262918822101097, 57.77489633859385]}
  ];

  var layerControlDiv = document.getElementById("layerControl");
  var markerLayers = [];

  // 3️⃣ Create a separate GraphicsLayer for each marker
  markersData.forEach(function(m, index){
    var layer = new GraphicsLayer();

    var point = {
      type: "point",
      longitude: m.coords[0],
      latitude: m.coords[1],
      z: 0
    };

    var markerSymbol = {
      type: "point-3d",
      symbolLayers: [{
        type: "icon",
        resource: { primitive: "cylinder" },
        size: 20,
        material: { color: "blue" }
      }]
    };

    var graphic = new Graphic({
      geometry: point,
      symbol: markerSymbol,
      attributes: { name: m.name },
      popupTemplate: { title: "{name}" }
    });

    layer.add(graphic);
    map.add(layer); // initially visible
    markerLayers.push({name: m.name, layer: layer});

    // 4️⃣ Create checkbox
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.id = "marker"+index;
    checkbox.onchange = function(){
      if(this.checked) map.add(layer);
      else map.remove(layer);
    };

    var label = document.createElement("label");
    label.htmlFor = "marker"+index;
    label.textContent = m.name;

    layerControlDiv.appendChild(checkbox);
    layerControlDiv.appendChild(label);
  });

});

