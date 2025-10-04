const firefighters = [
  { id: "FF01", name: "Ahmet", lat: 37.05, lon: 30.48, status: "active" },
  { id: "FF02", name: "Berke", lat: 37.06, lon: 30.5, status: "resting" },
  { id: "FF03", name: "Merve", lat: 37.04, lon: 30.49, status: "in-danger" },
  { id: "FF04", name: "Ayşe", lat: 37.055, lon: 30.52, status: "active" }
];

const drones = [
  { id: 1, name: "Drone-1", lat: 37.053, lon: 30.482, status: "scanning" },
  { id: 2, name: "Drone-2", lat: 37.047, lon: 30.508, status: "returning" }
];

const fireArea = [
  [37.042, 30.475],
  [37.045, 30.495],
  [37.055, 30.495],
  [37.052, 30.47]
];

function randomJitter() {
  firefighters.forEach((f) => {
    f.lat += (Math.random() - 0.5) * 0.0008;
    f.lon += (Math.random() - 0.5) * 0.0008;
  });

  drones.forEach((d) => {
    d.lat += (Math.random() - 0.5) * 0.0005;
    d.lon += (Math.random() - 0.5) * 0.0005;
  });
}

function setFireArea(coords) {
  if (!Array.isArray(coords)) return;
  fireArea.splice(0, fireArea.length, ...coords.map((coord) => [coord[0], coord[1]]));
}

module.exports = {
  firefighters,
  drones,
  fireArea,
  randomJitter,
  setFireArea
};
