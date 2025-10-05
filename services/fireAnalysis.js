const DEFAULT_CELL_COUNT = 12;
const DEFAULT_SEARCH_RADIUS_FACTOR = 1.5;
const DEFAULT_CENTER = [37.0485, 30.48375];
const DEFAULT_RADIUS = 0.002;
const MIN_GRID_POINTS = 6;
const MAX_GRID_POINTS = 60;
const FRONT_DISTANCE_SCALE = 111000;
const NEARBY_DISTANCE_THRESHOLD = 0.00045;
const POLYGON_BUFFER = 0.0003;

function sanitizePolygon(polygon) {
  if (!Array.isArray(polygon)) return [];
  return polygon
    .filter((pair) => Array.isArray(pair) && pair.length >= 2)
    .map(([lat, lon]) => [Number(lat), Number(lon)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

function centroid(coords) {
  if (!coords.length) return DEFAULT_CENTER.slice();
  const sum = coords.reduce(
    (acc, coord) => {
      acc[0] += coord[0];
      acc[1] += coord[1];
      return acc;
    },
    [0, 0]
  );
  return [sum[0] / coords.length, sum[1] / coords.length];
}

function euclid(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pointInPolygon(point, polygon) {
  if (!polygon || polygon.length < 3) return false;
  const [py, px] = point; // lat, lon
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i]; // lat, lon
    const [yj, xj] = polygon[j];
    const intersects = yi > py !== yj > py
      && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(point, a, b) {
  const [py, px] = point;
  const [ay, ax] = a;
  const [by, bx] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return euclid(point, a);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = clamp(t, 0, 1);
  const closest = [ay + t * dy, ax + t * dx];
  return euclid(point, closest);
}

function distanceToPolygon(point, polygon) {
  if (!polygon || polygon.length < 2) return Infinity;
  const len = polygon.length;
  let minDistance = Infinity;
  for (let i = 0; i < len; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % len];
    const segmentDistance = distanceToSegment(point, a, b);
    if (segmentDistance < minDistance) {
      minDistance = segmentDistance;
    }
  }
  return minDistance;
}

function fireRadius(coords, center) {
  if (!coords.length) return DEFAULT_RADIUS;
  return Math.max(...coords.map((coord) => euclid(coord, center)), DEFAULT_RADIUS);
}

function hashSeed(coords) {
  if (!coords.length) return 123456789;
  let seed = 2166136261 >>> 0;
  coords.forEach(([lat, lon], idx) => {
    const latInt = Math.floor((lat + 90) * 1e6) >>> 0;
    const lonInt = Math.floor((lon + 180) * 1e6) >>> 0;
    seed ^= latInt + idx;
    seed = Math.imul(seed, 16777619);
    seed ^= lonInt + idx * 101;
    seed = Math.imul(seed, 16777619);
  });
  return seed >>> 0;
}

function createRng(seedValue) {
  let state = seedValue >>> 0;
  if (state === 0) state = 123456789;
  return function rng() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function directionAlignment(fireDir, windDir) {
  let diff = Math.abs(fireDir - windDir);
  if (diff > 180) diff = 360 - diff;
  return 1 - diff / 180;
}

function computeScore(row) {
  let score = 0;
  score += row.value_at_risk * 1.0;
  score += row.spread_prob * 1000;
  score += row.area * 0.5;
  if (row.time_to_impact > 0) score += (600 - row.time_to_impact) * 2;
  score += row.danger_multiplier * 500;
  score += row.temperature * 10;
  score += (100 - row.humidity) * 5;
  score += row.slope * 30;
  score -= row.crew_risk * 3000;
  score -= row.fuel_moisture * 2000;
  if (row.front_distance < 50) score -= 2000;
  else if (row.front_distance < 100) score -= 1000;
  if (row.fire_speed > 4) score -= row.fire_speed * 500;
  else score += row.fire_speed * 50;
  return score;
}

function buildCells(center, radius, cellCount, rng, polygonCoords) {
  const cells = [];
  const effectiveRadius = Math.max(radius, DEFAULT_RADIUS);
  const polygon = Array.isArray(polygonCoords) && polygonCoords.length >= 3 ? polygonCoords : null;

  const projectOutside = (lat, lon) => {
    if (!polygon) return [lat, lon];
    if (!pointInPolygon([lat, lon], polygon)) return [lat, lon];

    let projectedLat = lat;
    let projectedLon = lon;
    const maxAttempts = 3;
    for (let iter = 0; iter < maxAttempts; iter++) {
      const dirLat = projectedLat - center[0];
      const dirLon = projectedLon - center[1];
      const magnitude = Math.hypot(dirLat, dirLon) || 1;
      const step = NEARBY_DISTANCE_THRESHOLD * 1.6 + rng() * NEARBY_DISTANCE_THRESHOLD * 0.8;
      projectedLat += (dirLat / magnitude) * step + (rng() - 0.5) * NEARBY_DISTANCE_THRESHOLD * 0.3;
      projectedLon += (dirLon / magnitude) * step + (rng() - 0.5) * NEARBY_DISTANCE_THRESHOLD * 0.3;
      if (!pointInPolygon([projectedLat, projectedLon], polygon)) break;
    }
    return [projectedLat, projectedLon];
  };

  const addCell = (rawLat, rawLon, weight = 1) => {
    const [lat, lon] = projectOutside(rawLat, rawLon);
    const spreadProb = clamp(0.35 + rng() * 0.5 * weight, 0.05, 0.98);
    const firePower = 1 + rng() * 2.8 * weight;
    const baseRisk = rng() * weight;
    const crewRiskBase = clamp(0.04 + baseRisk * 0.35, 0.02, 0.92);
    const fireSpeed = 0.8 + rng() * 4.5;
    const windSpeed = 2.5 + rng() * 11;
    const humidity = clamp(35 + rng() * 40, 15, 85);
    const fuelMoisture = clamp(0.07 + rng() * 0.18, 0.02, 0.35);
    const frontDistanceRaw = polygon
      ? distanceToPolygon([lat, lon], polygon) + rng() * NEARBY_DISTANCE_THRESHOLD
      : euclid([lat, lon], center);
    const frontDistance = frontDistanceRaw * FRONT_DISTANCE_SCALE;
    const timeToImpactBase = 420 - frontDistanceRaw * 900 + rng() * 90;
    const row = {
      cell_id: `C${cells.length + 1}`,
      x: lat,
      y: lon,
      fire_power: Number(firePower.toFixed(2)),
      spread_prob: Number(spreadProb.toFixed(2)),
      area: Math.round(450 + rng() * 260),
      value_at_risk: Math.round(850 + rng() * 2400 * weight),
      crew_risk: Number(crewRiskBase.toFixed(2)),
      time_to_impact: Math.max(45, Math.round(timeToImpactBase)),
      fire_direction: Number((rng() * 360).toFixed(1)),
      fire_speed: Number(fireSpeed.toFixed(2)),
      wind_speed: Number(windSpeed.toFixed(2)),
      wind_dir: Number((rng() * 360).toFixed(1)),
      temperature: Number((21 + rng() * 13).toFixed(1)),
      humidity: Number(humidity.toFixed(1)),
      fuel_moisture: Number(fuelMoisture.toFixed(2)),
      slope: Number((rng() * 26).toFixed(1)),
      front_distance: Number(frontDistance.toFixed(1))
    };
    cells.push(row);
  };

  if (polygon) {
    const lats = polygon.map((p) => p[0]);
    const lons = polygon.map((p) => p[1]);
    const minLat = Math.min(...lats) - POLYGON_BUFFER;
    const maxLat = Math.max(...lats) + POLYGON_BUFFER;
    const minLon = Math.min(...lons) - POLYGON_BUFFER;
    const maxLon = Math.max(...lons) + POLYGON_BUFFER;

    const desiredGrid = clamp(Math.ceil(Math.sqrt(cellCount * 1.4)), MIN_GRID_POINTS, MAX_GRID_POINTS);
    const stepLat = (maxLat - minLat) / Math.max(desiredGrid - 1, 1);
    const stepLon = (maxLon - minLon) / Math.max(desiredGrid - 1, 1);

    for (let i = 0; i < desiredGrid && cells.length < cellCount * 2; i++) {
      for (let j = 0; j < desiredGrid && cells.length < cellCount * 2; j++) {
        const lat = minLat + i * stepLat + (rng() - 0.5) * stepLat * 0.35;
        const lon = minLon + j * stepLon + (rng() - 0.5) * stepLon * 0.35;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const inside = pointInPolygon([lat, lon], polygon);
        const nearBoundary = distanceToPolygon([lat, lon], polygon) < NEARBY_DISTANCE_THRESHOLD;
        if (inside || nearBoundary) {
          const weight = inside ? 1 : 0.6;
          addCell(lat, lon, weight);
        }
      }
    }
  }

  if (!cells.length) {
    const radialCount = Math.max(cellCount, DEFAULT_CELL_COUNT);
    for (let i = 0; i < radialCount; i++) {
      const angleBase = (2 * Math.PI * i) / Math.max(1, radialCount);
      const angle = angleBase + (rng() - 0.5) * 0.45;
      const radialFactor = 0.55 + rng() * 0.75;
      const distance = effectiveRadius * radialFactor;
      const lat = center[0] + distance * Math.cos(angle);
      const lon = center[1] + distance * Math.sin(angle);
      addCell(lat, lon, 0.9);
    }
  }

  return cells.slice(0, Math.max(cellCount, MIN_GRID_POINTS));
}

function analyzeFirePolygon(polygonCoords, options = {}) {
  const coords = sanitizePolygon(polygonCoords);
  const center = centroid(coords);
  const radius = fireRadius(coords, center);
  const cellCount = clamp(
    Number.isFinite(options.count) ? Math.floor(options.count) : DEFAULT_CELL_COUNT,
    3,
    50
  );
  const searchRadiusFactor = clamp(
    Number.isFinite(options.searchRadiusFactor) ? options.searchRadiusFactor : DEFAULT_SEARCH_RADIUS_FACTOR,
    0.5,
    5
  );

  const rng = createRng(hashSeed(coords));
  const cells = buildCells(center, radius, cellCount, rng, coords);

  cells.forEach((cell) => {
    cell.dist_to_fire_center = euclid([cell.x, cell.y], center);
    cell.wind_fire_alignment = directionAlignment(cell.fire_direction, cell.wind_dir);
    cell.danger_multiplier = 1 + (cell.wind_fire_alignment * cell.wind_speed) / 20;
    cell.inside_fire = coords.length ? pointInPolygon([cell.x, cell.y], coords) : false;
    cell.score = computeScore(cell);
  });

  const searchRadius = radius * searchRadiusFactor;
  const candidates = cells.filter(
    (cell) => cell.dist_to_fire_center <= searchRadius
      && cell.crew_risk < 0.45
      && cell.front_distance >= 25
      && !cell.inside_fire
  );

  const outsideCells = cells.filter((cell) => !cell.inside_fire);
  const pool = (candidates.length ? candidates : outsideCells.length ? outsideCells : cells);
  const bestCell = pool.reduce((best, cell) => {
    if (!best || cell.score > best.score) return cell;
    return best;
  }, null);

  return {
    coords: coords.length ? coords : buildCells(center, radius, 4, rng, coords).map((cell) => [cell.x, cell.y]),
    center,
    radius,
    searchRadius,
    cells,
    candidates,
    bestCell
  };
}

module.exports = {
  analyzeFirePolygon
};
