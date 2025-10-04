const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";

let cachedFetch = typeof fetch === "function" ? fetch.bind(globalThis) : null;

async function fetchWithFallback(url) {
  if (!cachedFetch) {
    const mod = await import("node-fetch");
    cachedFetch = mod.default;
  }
  return cachedFetch(url);
}

const elevationCache = new Map();

function keyFor(lat, lon) {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

async function getElevation(lat, lon) {
  const cacheKey = keyFor(lat, lon);
  if (elevationCache.has(cacheKey)) {
    return elevationCache.get(cacheKey);
  }
  const params = new URLSearchParams({ latitude: String(lat), longitude: String(lon) });
  const res = await fetchWithFallback(`${ELEVATION_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Elevation request failed with status ${res.status}`);
  }
  const json = await res.json();
  const value = Array.isArray(json.elevation) ? json.elevation[0] : null;
  elevationCache.set(cacheKey, value);
  return value;
}

function calculateSlope(elevationMatrix, cellSizeMeters) {
  if (!Array.isArray(elevationMatrix) || elevationMatrix.length !== 3) {
    throw new Error("Elevation matrix must be 3x3");
  }
  const z = elevationMatrix.map((row) => {
    if (!Array.isArray(row) || row.length !== 3) {
      throw new Error("Elevation matrix must be 3x3");
    }
    return row.map((value) => Number(value));
  });

  const dzdx = ((z[0][2] + 2 * z[1][2] + z[2][2]) - (z[0][0] + 2 * z[1][0] + z[2][0])) / (8 * cellSizeMeters);
  const dzdy = ((z[2][0] + 2 * z[2][1] + z[2][2]) - (z[0][0] + 2 * z[0][1] + z[0][2])) / (8 * cellSizeMeters);

  const slopeRadians = Math.atan(Math.hypot(dzdx, dzdy));
  const slopeDegrees = slopeRadians * (180 / Math.PI);

  const aspectRadians = Math.atan2(dzdy, -dzdx);
  const aspectDegrees = (aspectRadians * 180 / Math.PI + 360) % 360;

  return {
    slopeDegrees,
    aspectDegrees,
    gradients: { dzdx, dzdy }
  };
}

async function buildElevationGrid(centerLat, centerLon, deltaDeg = 0.0003) {
  const matrix = [];
  for (const dlat of [-deltaDeg, 0, deltaDeg]) {
    const row = [];
    for (const dlon of [-deltaDeg, 0, deltaDeg]) {
      const lat = centerLat + dlat;
      const lon = centerLon + dlon;
      const elevation = await getElevation(lat, lon);
      row.push(elevation);
    }
    matrix.push(row);
  }

  const latRadians = (centerLat * Math.PI) / 180;
  const cellSizeMeters = 111_320 * deltaDeg * Math.cos(latRadians);

  return {
    matrix,
    cellSizeMeters,
    slope: calculateSlope(matrix, cellSizeMeters)
  };
}

module.exports = {
  getElevation,
  buildElevationGrid,
  calculateSlope
};
