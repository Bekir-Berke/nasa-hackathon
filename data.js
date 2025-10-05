const { analyzeFirePolygon } = require("./services/fireAnalysis");

const firefighters = [
  { id: "FF01", name: "Ahmet", lat: 37.05, lon: 30.48, status: "active" },
  { id: "FF02", name: "Berke", lat: 37.06, lon: 30.5, status: "resting" },
  { id: "FF03", name: "Merve", lat: 37.04, lon: 30.49, status: "in-danger" },
  { id: "FF04", name: "Ayşe", lat: 37.051, lon: 30.487, status: "active" }
];

const baseFirefighterPositions = firefighters.map((f) => ({ lat: f.lat, lon: f.lon }));
let externalStrategicCells = [];

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

let strategicPlacementFailed = false;

function normalizeCell(cell) {
  if (!cell) return null;
  const lat = Number.isFinite(cell.lat) ? cell.lat : cell.x;
  const lon = Number.isFinite(cell.lon) ? cell.lon : cell.y;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    cell_id: cell.cell_id || cell.id || null,
    x: lat,
    y: lon,
    score: Number.isFinite(cell.score) ? cell.score : 0,
    crew_risk: Number.isFinite(cell.crew_risk) ? cell.crew_risk : 0.3,
    spread_prob: Number.isFinite(cell.spread_prob) ? cell.spread_prob : 0.5,
    value_at_risk: Number.isFinite(cell.value_at_risk) ? cell.value_at_risk : 0,
    front_distance: Number.isFinite(cell.front_distance) ? cell.front_distance : 100
  };
}

function selectStrategicCells(count) {
  const desiredCount = Math.max(count * 2, 12);

  let pool = [];
  if (externalStrategicCells && externalStrategicCells.length) {
    pool = externalStrategicCells
      .map(normalizeCell)
      .filter(Boolean);
  }

  if (!pool.length) {
    const analysis = analyzeFirePolygon(fireArea, { count: desiredCount });
    const source = (analysis.candidates && analysis.candidates.length)
      ? analysis.candidates
      : analysis.cells || [];
    pool = source.map(normalizeCell).filter(Boolean);
  }

  return pool
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function assignCellsToFirefighters(cells) {
  const assignments = new Map();
  const available = new Set(cells.map((_, idx) => idx));

  firefighters.forEach((_, idx) => {
    const base = baseFirefighterPositions[idx];
    let chosenIndex = null;
    let bestDistance = Infinity;
    available.forEach((cellIdx) => {
      const cell = cells[cellIdx];
      const dist = Math.hypot(cell.x - base.lat, cell.y - base.lon);
      if (dist < bestDistance) {
        bestDistance = dist;
        chosenIndex = cellIdx;
      }
    });

    if (chosenIndex === null) {
      chosenIndex = available.values().next().value;
    }
    available.delete(chosenIndex);
    assignments.set(idx, cells[chosenIndex]);
  });

  return assignments;
}

function applyStrategicPlacement() {
  const cells = selectStrategicCells(firefighters.length);
  if (!cells.length) {
    throw new Error("no viable strategic cells");
  }

  const assignments = assignCellsToFirefighters(cells);

  firefighters.forEach((f, idx) => {
    const target = assignments.get(idx) ?? cells[idx % cells.length];
    const base = baseFirefighterPositions[idx];

    const weight = externalStrategicCells.length ? 0.85 : 0.65; // move strongly toward strategic cell when defined
    const latDiff = target.x - base.lat;
    const lonDiff = target.y - base.lon;
    const latLimit = clamp(Math.abs(latDiff) * 0.8 + 0.001, 0.004, 0.02);
    const lonLimit = clamp(Math.abs(lonDiff) * 0.8 + 0.001, 0.004, 0.02);

    const desiredLatShift = latDiff * weight;
    const desiredLonShift = lonDiff * weight;

    const latShift = clamp(desiredLatShift, -latLimit, latLimit);
    const lonShift = clamp(desiredLonShift, -lonLimit, lonLimit);

    const jitterFactor = externalStrategicCells.length ? 0.00025 : 0.0005;
    const jitterLat = (Math.random() - 0.5) * jitterFactor;
    const jitterLon = (Math.random() - 0.5) * jitterFactor;

    f.lat = base.lat + latShift + jitterLat;
    f.lon = base.lon + lonShift + jitterLon;
  });
}

function randomJitter() {
  try {
    applyStrategicPlacement();
    if (strategicPlacementFailed) {
      strategicPlacementFailed = false;
    }
  } catch (err) {
    if (!strategicPlacementFailed) {
      console.warn("strategic firefighter placement failed, falling back", err);
      strategicPlacementFailed = true;
    }
    firefighters.forEach((f, idx) => {
      const base = baseFirefighterPositions[idx];
      f.lat = base.lat + (Math.random() - 0.5) * 0.0006;
      f.lon = base.lon + (Math.random() - 0.5) * 0.0006;
    });
  }

  drones.forEach((d, idx) => {
    const target = firefighters[idx % firefighters.length];
    const angle = (idx / Math.max(1, drones.length)) * Math.PI * 2;
    const baseRadius = 0.0009; // ~100m offset
    const radius = baseRadius + (Math.random() * 0.0004);
    const latOffset = radius * Math.cos(angle);
    const lonOffset = radius * Math.sin(angle) * Math.cos(target.lat * Math.PI / 180);
    const jitterLat = (Math.random() - 0.5) * 0.00025;
    const jitterLon = (Math.random() - 0.5) * 0.00025;
    d.lat = target.lat + latOffset + jitterLat;
    d.lon = target.lon + lonOffset + jitterLon;
  });
}

function setFireArea(coords) {
  if (!Array.isArray(coords)) return;
  fireArea.splice(0, fireArea.length, ...coords.map((coord) => [coord[0], coord[1]]));
}

function setExternalCells(cells) {
  if (!Array.isArray(cells)) {
    externalStrategicCells = [];
    return;
  }
  externalStrategicCells = cells
    .map(normalizeCell)
    .filter(Boolean);
}

module.exports = {
  firefighters,
  drones,
  fireArea,
  randomJitter,
  setFireArea,
  setExternalCells
};
