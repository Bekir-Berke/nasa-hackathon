const { fetchWeather } = require("./weather");
const { buildElevationGrid } = require("./slope");
const { computeFWI } = require("./fwi");

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createRng(seed = 123456789) {
  let s = seed >>> 0;
  return function rng() {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(vec) {
  const length = Math.hypot(vec[0], vec[1]);
  if (!length) return [0, 0];
  return [vec[0] / length, vec[1] / length];
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function buildFuelGrid(size, rng, drynessFactor) {
  const grid = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => rng())
  );

  // simple smoothing
  for (let iter = 0; iter < 3; iter++) {
    const copy = grid.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        let acc = 0;
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
            acc += copy[rr][cc];
            count++;
          }
        }
        grid[r][c] = acc / count;
      }
    }
  }

  // add dry pockets
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (rng() > 0.85) {
        grid[r][c] = clamp(grid[r][c] + 0.3 + rng() * 0.2, 0, 1);
      }
      grid[r][c] = clamp(grid[r][c] * (0.6 + 0.4 * drynessFactor), 0, 1);
    }
  }

  return grid;
}

function buildSlopeMagnitudeGrid(size, slopeVector, slopeStrength) {
  const center = (size - 1) / 2;
  const grid = Array.from({ length: size }, () => new Array(size).fill(slopeStrength));
  if (!slopeVector) return grid;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const dx = (c - center) / (center || 1);
      const dy = (center - r) / (center || 1);
      const projection = dx * slopeVector[0] + dy * slopeVector[1];
      const magnitude = clamp(0.5 + projection * 0.8, 0, 1) * slopeStrength;
      grid[r][c] = magnitude;
    }
  }
  return grid;
}

function buildWindSeries(hourly, hours, summary) {
  const series = [];
  const limit = Math.max(hours + 1, 1);
  for (let h = 0; h < limit; h++) {
    const entry = hourly?.[h] ?? summary ?? {};
    const directionFrom = typeof entry.wind_direction_10m === "number" ? entry.wind_direction_10m : 0;
    const directionTo = (directionFrom + 180) % 360;
    const theta = (directionTo * Math.PI) / 180;
    const east = Math.sin(theta);
    const north = Math.cos(theta);
    const unit = normalize([east, north]);
    series.push({
      speed: typeof entry.wind_speed_10m === "number" ? entry.wind_speed_10m : 0,
      directionFrom,
      directionTo,
      unit
    });
  }
  return series;
}

function simulateSpread({
  gridSize,
  hours,
  fuel,
  slopeVector,
  slopeMag,
  windSeries,
  drynessFactor,
  avgWindSpeed,
  rng
}) {
  const burnedTime = Array.from({ length: gridSize }, () => new Array(gridSize).fill(-1));
  const burning = new Set();
  const center = Math.floor(gridSize / 2);
  const encode = (r, c) => r * gridSize + c;
  const decode = (value) => [Math.floor(value / gridSize), value % gridSize];

  burnedTime[center][center] = 0;
  burning.add(encode(center, center));

  const snapshots = [];
  snapshots.push({ hour: 0, cells: [{ row: center, col: center, probability: 1 }], wind: windSeries[0] });

  const baseBias = -1.2 + drynessFactor * 0.8;
  const avgWind = avgWindSpeed || 0;
  const windWeight = 1.0 + avgWind * 0.15;
  const slopeWeight = 0.8 + (slopeVector ? 1 : 0) * 1.2;
  const drynessWeight = 0.7 + drynessFactor * 0.6;
  const consumption = 0.45;

  for (let t = 1; t <= hours; t++) {
    const wind = windSeries[Math.min(t, windSeries.length - 1)];
    const newCells = new Map();

    burning.forEach((value) => {
      const [r, c] = decode(value);
      fuel[r][c] = Math.max(0, fuel[r][c] - consumption);
      for (let rr = r - 1; rr <= r + 1; rr++) {
        for (let cc = c - 1; cc <= c + 1; cc++) {
          if (rr < 0 || cc < 0 || rr >= gridSize || cc >= gridSize) continue;
          if (rr === r && cc === c) continue;
          if (burnedTime[rr][cc] >= 0) continue;
          if (fuel[rr][cc] <= 0.05) continue;

          const neighVec = normalize([cc - c, r - rr]);
          const windAlign = wind?.unit ? Math.max(0, neighVec[0] * wind.unit[0] + neighVec[1] * wind.unit[1]) : 0;
          const slopeAlign = slopeVector ? Math.max(0, neighVec[0] * slopeVector[0] + neighVec[1] * slopeVector[1]) * slopeMag[rr][cc] : 0;
          const drynessBoost = drynessFactor * (fuel[rr][cc] + 0.15);

          const raw = baseBias + windWeight * windAlign + slopeWeight * slopeAlign + drynessWeight * drynessBoost;
          const probability = sigmoid(raw) * fuel[rr][cc];
          if (rng() < probability) {
            burnedTime[rr][cc] = t;
            const idx = encode(rr, cc);
            newCells.set(idx, { row: rr, col: cc, probability: clamp(probability, 0, 1) });
          }
        }
      }
    });

    newCells.forEach((value, idx) => {
      burning.add(idx);
    });

    snapshots.push({ hour: t, cells: Array.from(newCells.values()), wind });
  }

  return { burnedTime, snapshots };
}

function cellPolygon(lat0, lon0, deltaDeg, row, col) {
  const latMin = lat0 + row * deltaDeg;
  const latMax = lat0 + (row + 1) * deltaDeg;
  const lonMin = lon0 + col * deltaDeg;
  const lonMax = lon0 + (col + 1) * deltaDeg;
  return [
    [lonMin, latMin],
    [lonMax, latMin],
    [lonMax, latMax],
    [lonMin, latMax],
    [lonMin, latMin]
  ];
}

function buildGeoFeatures(snapshots, { gridSize, lat, lon, cellSize }) {
  const lat0 = lat - (gridSize / 2) * cellSize;
  const lon0 = lon - (gridSize / 2) * cellSize;
  const features = [];
  const burnedCentroids = [];
  const startTime = Date.now();

  snapshots.forEach((snap) => {
    const timestamp = new Date(startTime + snap.hour * 60 * 60 * 1000).toISOString();
    snap.cells.forEach((cell) => {
      const polygon = cellPolygon(lat0, lon0, cellSize, cell.row, cell.col);
      const centerLat = lat0 + (cell.row + 0.5) * cellSize;
      const centerLon = lon0 + (cell.col + 0.5) * cellSize;
      burnedCentroids.push({ lat: centerLat, lon: centerLon });
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [polygon] },
        properties: {
          hour: snap.hour,
          time: timestamp,
          probability: Number(cell.probability.toFixed(2)),
          windSpeed: snap.wind?.speed ?? 0,
          windDirectionFrom: snap.wind?.directionFrom ?? 0
        }
      });
    });
  });

  return { features, burnedCentroids };
}

function convexHull(points) {
  if (points.length <= 1) return points.slice();
  const sorted = points
    .map((p) => ({ lat: p.lat, lon: p.lon }))
    .sort((a, b) => (a.lon === b.lon ? a.lat - b.lat : a.lon - b.lon));

  const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

async function runFireSimulation(options = {}) {
  const lat = options.lat ?? 37.05;
  const lon = options.lon ?? 30.49;
  const hours = options.hours ?? 8;
  const gridSize = options.gridSize ?? 40;
  const cellSize = options.cellSize ?? 0.0005;
  const seed = options.seed ?? 1337;

  const [weather, elevation] = await Promise.all([
    fetchWeather(lat, lon),
    buildElevationGrid(lat, lon)
  ]);

  const fallbackHour = weather.hourly?.[0] || {};
  const summarized = weather.summary ?? {
    at: fallbackHour.time,
    temperature_2m: fallbackHour.temperature_2m,
    wind_speed_10m: fallbackHour.wind_speed_10m,
    wind_direction_10m: fallbackHour.wind_direction_10m,
    relative_humidity_2m: fallbackHour.relative_humidity_2m
  };

  if (typeof summarized.precipitation_24h !== "number") {
    const precs = weather.hourly?.slice(0, 24) ?? [];
    const total = precs.reduce((acc, h) => acc + (h.precipitation || 0), 0);
    summarized.precipitation_24h = Number(total.toFixed(2));
  }

  const currentDate = summarized.at ? new Date(summarized.at) : (fallbackHour.time ? new Date(fallbackHour.time) : new Date());
  const month = currentDate.getUTCMonth() + 1;

  const fwi = computeFWI({
    temperature: summarized.temperature_2m ?? 20,
    relativeHumidity: summarized.relative_humidity_2m ?? 45,
    windSpeed: summarized.wind_speed_10m ?? 3,
    rain: summarized.precipitation_24h ?? 0,
    month
  });

  const drynessFactor = clamp(fwi.fwi / 30, 0.4, 1.8);
  const windSeries = buildWindSeries(weather.hourly, hours, summarized);
  const avgWindSpeed = windSeries.reduce((acc, w) => acc + (w.speed || 0), 0) / windSeries.length || 0;

  const gradients = elevation.slope.gradients;
  const slopeVectorRaw = [-gradients.dzdx, -gradients.dzdy];
  const slopeVectorNorm = normalize(slopeVectorRaw);
  const slopeStrength = clamp(elevation.slope.slopeDegrees / 35, 0, 1);
  const slopeMag = buildSlopeMagnitudeGrid(gridSize, slopeVectorNorm, slopeStrength);

  const rng = createRng(seed);
  const fuel = buildFuelGrid(gridSize, rng, drynessFactor);

  const simulation = simulateSpread({
    gridSize,
    hours,
    fuel,
    slopeVector: slopeVectorNorm,
    slopeMag,
    windSeries,
    drynessFactor,
    avgWindSpeed,
    rng
  });

  const geo = buildGeoFeatures(simulation.snapshots, { gridSize, lat, lon, cellSize });
  const footprintHull = convexHull(geo.burnedCentroids);
  const footprint = footprintHull.length > 2
    ? [...footprintHull, footprintHull[0]].map((p) => [p.lat, p.lon])
    : footprintHull.map((p) => [p.lat, p.lon]);

  return {
    meta: { lat, lon, hours, gridSize, cellSize, seed },
    weather: {
      summary: summarized,
      elevation: {
        matrix: elevation.matrix,
        slopeDegrees: Number(elevation.slope.slopeDegrees.toFixed(2)),
        aspectDegrees: Number(elevation.slope.aspectDegrees.toFixed(2))
      }
    },
    fwi,
    model: {
      drynessFactor: Number(drynessFactor.toFixed(3)),
      slopeVector: slopeVectorNorm,
      slopeStrength: Number(slopeStrength.toFixed(3))
    },
    windSeries: windSeries.map((w, idx) => ({
      hour: idx,
      speed: Number((w.speed ?? 0).toFixed(2)),
      directionFrom: Number((w.directionFrom ?? 0).toFixed(1)),
      directionTo: Number((w.directionTo ?? 0).toFixed(1))
    })),
    features: geo.features,
    footprint
  };
}

module.exports = {
  runFireSimulation
};
