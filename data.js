export const firefighters = [
    { id: "FF01", name: "Ahmet", lat: 37.050, lon: 30.480, status: "active" },
    { id: "FF02", name: "Berke", lat: 37.060, lon: 30.500, status: "resting" },
    { id: "FF03", name: "Merve", lat: 37.040, lon: 30.490, status: "in-danger" },
    { id: "FF04", name: "Ayşe", lat: 37.055, lon: 30.520, status: "active" }
  ];
export const drones = [
    { id: 1, name: "Drone-1", lat: 37.053, lon: 30.482, status: "scanning" },
    { id: 2, name: "Drone-2", lat: 37.047, lon: 30.508, status: "returning" }
]
export let fireArea = [
    [37.042, 30.475],
    [37.045, 30.495],
    [37.055, 30.495],
    [37.052, 30.470]
  ];
  
  // küçük bir jitter ile dummy hareket
export function randomJitter() {
    firefighters.forEach((f) => {
      drones.forEach((d) => {
      f.lat += (Math.random() - 0.5) * 0.0008;
      f.lon += (Math.random() - 0.5) * 0.0008;
      d.lat += (Math.random() - 0.5) * 0.0005;
      d.lon += (Math.random() - 0.5) * 0.0005;
    });
  });
}
// data.js