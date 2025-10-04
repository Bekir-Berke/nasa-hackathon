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

// Rothermel Fire Spread Model Implementation
// Based on Rothermel (1972) and NFFL fuel models
function getFuelModel(drynessFactor) {
  // Using NFFL Fuel Model 3 (tall grass) as baseline, scaled by dryness
  // In a full implementation, this would be chosen based on vegetation type
  return {
    // Fuel load (tons/acre) by size class
    w0_1h: 0.3 * (0.8 + 0.4 * drynessFactor), // 1-hour fuels (fine)
    w0_10h: 0.1 * (0.8 + 0.4 * drynessFactor), // 10-hour fuels
    w0_100h: 0.05, // 100-hour fuels
    // Surface-area-to-volume ratio (ft^-1)
    sigma_1h: 1500,
    sigma_10h: 109,
    sigma_100h: 30,
    // Fuel depth (ft)
    delta: 2.5,
    // Fuel moisture (%, derived from FWI)
    // Higher FWI = drier = lower moisture content
    mf: Math.max(5, 30 - drynessFactor * 15),
    // Dead fuel moisture of extinction (%)
    mx: 25,
    // Heat content (BTU/lb)
    h: 8000,
    // Fuel bed bulk density (lb/ft^3)
    rho_p: 32,
    // Mineral content
    st: 0.0555,
    se: 0.01
  };
}

function calculateRothermelROS(fuel, windSpeedMph, slopeDegrees, windAlign, slopeAlign) {
  // Rothermel (1972) rate of spread model

  // Convert inputs
  const slopeRadians = (slopeDegrees * Math.PI) / 180;
  const tanSlope = Math.tan(slopeRadians);

  // Fuel bed properties
  const w0_total = fuel.w0_1h + fuel.w0_10h + fuel.w0_100h;
  const sigma_weighted = (fuel.w0_1h * fuel.sigma_1h + fuel.w0_10h * fuel.sigma_10h + fuel.w0_100h * fuel.sigma_100h) / w0_total;
  const rho_b = (w0_total / fuel.delta) * 2000 / 43560; // Convert to lb/ft^3
  const beta = rho_b / fuel.rho_p; // Packing ratio
  const beta_opt = 3.348 * Math.pow(sigma_weighted, -0.8189); // Optimal packing ratio

  // Moisture damping coefficient
  const mf_ratio = fuel.mf / fuel.mx;
  const eta_M = 1 - 2.59 * mf_ratio + 5.11 * Math.pow(mf_ratio, 2) - 3.52 * Math.pow(mf_ratio, 3);

  // Mineral damping coefficient
  const eta_s = 0.174 * Math.pow(fuel.se, -0.19);

  // Reaction intensity (BTU/ft^2/min)
  const gamma_max = Math.pow(sigma_weighted, 1.5) / (495 + 0.0594 * Math.pow(sigma_weighted, 1.5));
  const A = 133 * Math.pow(sigma_weighted, -0.7913);
  const gamma = gamma_max * Math.pow(beta / beta_opt, A) * Math.exp(A * (1 - beta / beta_opt));
  const IR = gamma * w0_total * fuel.h * eta_M * eta_s;

  // Propagating flux ratio
  const xi = Math.exp((0.792 + 0.681 * Math.pow(sigma_weighted, 0.5)) * (beta + 0.1)) / (192 + 0.2595 * sigma_weighted);

  // Wind coefficient (using directional alignment)
  const C = 7.47 * Math.exp(-0.133 * Math.pow(sigma_weighted, 0.55));
  const B = 0.02526 * Math.pow(sigma_weighted, 0.54);
  const E = 0.715 * Math.exp(-3.59e-4 * sigma_weighted);
  const effectiveWind = windSpeedMph * Math.max(0, windAlign); // Only consider wind in spread direction
  const phi_w = C * Math.pow(effectiveWind, B) * Math.pow(beta / beta_opt, -E);

  // Slope coefficient (using directional alignment)
  const effectiveSlope = tanSlope * Math.max(0, slopeAlign); // Only upslope spread
  const phi_s = 5.275 * Math.pow(beta, -0.3) * Math.pow(effectiveSlope, 2);

  // Rate of spread (ft/min)
  const ros_ft_min = (IR * xi * (1 + phi_w + phi_s)) / (rho_b * 0.3 * (250 + 1116 * fuel.mf / 100));

  // Convert to our grid units (cells per hour)
  // Assuming 1 cell ≈ 50m, 1 ft/min = 0.018288 km/h
  const ros_km_h = ros_ft_min * 0.018288;
  const cellSize_km = 0.05; // 50m cells
  const ros_cells_h = ros_km_h / cellSize_km;

  return Math.max(0, ros_cells_h);
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
  rng,
  seeds
}) {
  const burnedTime = Array.from({ length: gridSize }, () => new Array(gridSize).fill(-1));
  const burning = new Set();
  const center = Math.floor(gridSize / 2);
  const encode = (r, c) => r * gridSize + c;
  const decode = (value) => [Math.floor(value / gridSize), value % gridSize];

  const seedsArray = Array.isArray(seeds) && seeds.length ? seeds : [{ row: center, col: center }];
  const initialCells = [];
  seedsArray.forEach(({ row, col }) => {
    const r = Math.max(0, Math.min(gridSize - 1, row));
    const c = Math.max(0, Math.min(gridSize - 1, col));
    burnedTime[r][c] = 0;
    burning.add(encode(r, c));
    initialCells.push({ row: r, col: c, probability: 1 });
  });

  const snapshots = [];
  snapshots.push({ hour: 0, cells: initialCells, wind: windSeries[0] });

  // Get Rothermel fuel model based on dryness
  const fuelModel = getFuelModel(drynessFactor);
  const consumption = 0.45;

  for (let t = 1; t <= hours; t++) {
    const wind = windSeries[Math.min(t, windSeries.length - 1)];
    const windSpeedMph = (wind?.speed || 0) * 2.23694; // m/s to mph
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

          // Calculate spread direction and alignment
          const neighVec = normalize([cc - c, r - rr]);
          const windAlign = wind?.unit ? Math.max(0, neighVec[0] * wind.unit[0] + neighVec[1] * wind.unit[1]) : 0;
          const slopeAlign = slopeVector ? Math.max(0, neighVec[0] * slopeVector[0] + neighVec[1] * slopeVector[1]) : 0;
          const slopeDegrees = slopeMag[rr][cc] * 35; // Convert back to degrees

          // Calculate Rothermel rate of spread
          const ros = calculateRothermelROS(fuelModel, windSpeedMph, slopeDegrees, windAlign, slopeAlign);

          // Convert ROS to ignition probability
          // Higher ROS = higher probability, modulated by fuel availability
          const baseProb = Math.min(0.95, ros / 10); // Scale ROS to probability
          const fuelFactor = fuel[rr][cc]; // Available fuel
          const randomFactor = 0.85 + rng() * 0.15; // Add stochasticity (15% variation)
          const probability = baseProb * fuelFactor * randomFactor;

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

function normalizePolygon(polygon) {
  if (!Array.isArray(polygon)) return [];
  const cleaned = polygon
    .filter((coord) => Array.isArray(coord) && coord.length >= 2)
    .map(([lat, lon]) => [Number(lat), Number(lon)]);
  if (cleaned.length < 3) return [];
  const closed = cleaned.slice();
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    closed.push([first[0], first[1]]);
  }
  return closed;
}

function polygonCentroid(polygon) {
  if (!polygon || polygon.length < 3) return null;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length - 1; i++) {
    const [lat0, lon0] = polygon[i];
    const [lat1, lon1] = polygon[i + 1];
    const f = lat0 * lon1 - lat1 * lon0;
    twiceArea += f;
    cx += (lat0 + lat1) * f;
    cy += (lon0 + lon1) * f;
  }
  if (!twiceArea) return { lat: polygon[0][0], lon: polygon[0][1] };
  const area = twiceArea * 0.5;
  return {
    lat: cx / (6 * area),
    lon: cy / (6 * area)
  };
}

function pointInPolygon(point, polygon) {
  if (!polygon || polygon.length < 3) return false;
  const x = point.lon;
  const y = point.lat;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][1];
    const yi = polygon[i][0];
    const xj = polygon[j][1];
    const yj = polygon[j][0];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function buildForecastPolygons(snapshots, { gridSize, lat, lon, cellSize, basePolygon }) {
  const lat0 = lat - (gridSize / 2) * cellSize;
  const lon0 = lon - (gridSize / 2) * cellSize;
  const burnedCentroids = [];
  const startTime = Date.now();
  const forecast = [];

  // Track points per hour separately to create non-overlapping rings
  const hourlyPoints = [];

  // Store base polygon points that must always be included
  const basePolygonPoints = [];
  const normalizedBase = normalizePolygon(basePolygon);
  if (normalizedBase.length >= 3) {
    for (let i = 0; i < normalizedBase.length - 1; i++) {
      const [latP, lonP] = normalizedBase[i];
      const point = { lat: latP, lon: lonP };
      basePolygonPoints.push(point);
      burnedCentroids.push({ lat: latP, lon: lonP });
    }
    const baseCoords = normalizedBase.map(([latP, lonP]) => [lonP, latP]);
    forecast.push({
      hour: 0,
      coordinates: baseCoords,
      stats: { probability: 1, cells: 0, time: new Date(startTime).toISOString() },
      isRing: false
    });
    hourlyPoints.push(basePolygonPoints);
  } else {
    hourlyPoints.push([]);
  }

  snapshots.forEach((snap) => {
    const timestamp = new Date(startTime + snap.hour * 60 * 60 * 1000).toISOString();
    const skipForecastEntry = normalizedBase.length >= 3 && snap.hour === 0;

    if (skipForecastEntry) return;

    const currentHourPoints = [];
    snap.cells.forEach((cell) => {
      const polygon = cellPolygon(lat0, lon0, cellSize, cell.row, cell.col);
      const centerLat = lat0 + (cell.row + 0.5) * cellSize;
      const centerLon = lon0 + (cell.col + 0.5) * cellSize;
      burnedCentroids.push({ lat: centerLat, lon: centerLon });
      currentHourPoints.push(...polygon.slice(0, -1).map(([lonV, latV]) => ({ lat: latV, lon: lonV })));
    });

    if (!currentHourPoints.length) {
      hourlyPoints.push([]);
      return;
    }

    // Compute cumulative hull for this hour (all points up to now)
    const allPointsUpToNow = [...basePolygonPoints];
    for (let i = 0; i < hourlyPoints.length; i++) {
      allPointsUpToNow.push(...hourlyPoints[i]);
    }
    allPointsUpToNow.push(...currentHourPoints);

    const hullPoints = convexHull(allPointsUpToNow);
    let polygonCoords;
    if (hullPoints.length >= 3) {
      polygonCoords = hullPoints.map((p) => [p.lon, p.lat]);
      if (polygonCoords.length) {
        polygonCoords.push(polygonCoords[0]);
      }
    } else {
      polygonCoords = [[lon, lat], [lon + cellSize, lat], [lon, lat + cellSize], [lon, lat]];
    }

    const probabilityAvg = snap.cells.length
      ? snap.cells.reduce((acc, cell) => acc + (cell.probability ?? 0), 0) / snap.cells.length
      : 0;

    // Get previous hour's polygon for ring calculation
    const previousHourPolygon = forecast.length > 0 ? forecast[forecast.length - 1].coordinates : null;

    forecast.push({
      hour: snap.hour,
      coordinates: polygonCoords,
      previousPolygon: previousHourPolygon ? previousHourPolygon.map(p => [p[0], p[1]]) : null,
      stats: {
        probability: Number(probabilityAvg.toFixed(2)),
        cells: snap.cells.length,
        time: timestamp
      },
      isRing: true
    });

    hourlyPoints.push(currentHourPoints);
  });

  return { forecast, burnedCentroids };
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

function seedCellsFromPolygon(basePolygon, { lat0, lon0, cellSize, gridSize }) {
  const seeds = [];
  if (!Array.isArray(basePolygon) || basePolygon.length < 3) return seeds;
  for (let r = 0; r < gridSize; r++) {
    const centerLat = lat0 + (r + 0.5) * cellSize;
    for (let c = 0; c < gridSize; c++) {
      const centerLon = lon0 + (c + 0.5) * cellSize;
      const minLat = lat0 + r * cellSize;
      const maxLat = minLat + cellSize;
      const minLon = lon0 + c * cellSize;
      const maxLon = minLon + cellSize;
      const centerInside = pointInPolygon({ lat: centerLat, lon: centerLon }, basePolygon);
      const corners = [
        { lat: minLat, lon: minLon },
        { lat: minLat, lon: maxLon },
        { lat: maxLat, lon: maxLon },
        { lat: maxLat, lon: minLon }
      ];
      const cellCornerInside = !centerInside && corners.some((corner) => pointInPolygon(corner, basePolygon));
      const polygonVertexInside = !centerInside && !cellCornerInside && basePolygon.some(([latP, lonP]) => (
        latP >= minLat && latP <= maxLat && lonP >= minLon && lonP <= maxLon
      ));

      if (centerInside || cellCornerInside || polygonVertexInside) {
        seeds.push({ row: r, col: c });
      }
    }
  }
  return seeds;
}

async function runFireSimulation(options = {}) {
  const basePolygon = normalizePolygon(options.basePolygon);
  let lat = options.lat ?? 37.05;
  let lon = options.lon ?? 30.49;
  const hours = options.hours ?? 8;
  const gridSize = options.gridSize ?? 40;
  const cellSize = options.cellSize ?? 0.0005;
  const seed = options.seed ?? 1337;

  if (basePolygon.length >= 3) {
    const centroid = polygonCentroid(basePolygon);
    if (centroid) {
      lat = centroid.lat;
      lon = centroid.lon;
    }
  }

  let effectiveCellSize = cellSize;
  if (basePolygon.length >= 3) {
    const lats = basePolygon.map(([latValue]) => latValue);
    const lons = basePolygon.map(([, lonValue]) => lonValue);
    const latSpan = Math.max(...lats) - Math.min(...lats);
    const lonSpan = Math.max(...lons) - Math.min(...lons);
    const latNeeded = latSpan > 0 ? latSpan / Math.max(1, gridSize * 0.6) : 0;
    const lonNeeded = lonSpan > 0 ? lonSpan / Math.max(1, gridSize * 0.6) : 0;
    effectiveCellSize = Math.max(cellSize, latNeeded, lonNeeded);
  }

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

  const lat0 = lat - (gridSize / 2) * effectiveCellSize;
  const lon0 = lon - (gridSize / 2) * effectiveCellSize;
  let seeds = seedCellsFromPolygon(basePolygon, { lat0, lon0, cellSize: effectiveCellSize, gridSize });
  if (!seeds.length) {
    const centerRow = Math.floor(gridSize / 2);
    const centerCol = Math.floor(gridSize / 2);
    seeds = [{ row: centerRow, col: centerCol }];
  }

  const simulation = simulateSpread({
    gridSize,
    hours,
    fuel,
    slopeVector: slopeVectorNorm,
    slopeMag,
    windSeries,
    drynessFactor,
    avgWindSpeed,
    rng,
    seeds
  });

  const geo = buildForecastPolygons(simulation.snapshots, { gridSize, lat, lon, cellSize: effectiveCellSize, basePolygon });
  const footprintHull = convexHull(geo.burnedCentroids);
  const footprint = footprintHull.length > 2
    ? [...footprintHull, footprintHull[0]].map((p) => [p.lat, p.lon])
    : footprintHull.map((p) => [p.lat, p.lon]);

  return {
    meta: { lat, lon, hours, gridSize, cellSize: effectiveCellSize, seed },
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
    forecast: geo.forecast,
    features: geo.forecast,
    footprint
  };
}

module.exports = {
  runFireSimulation
};
