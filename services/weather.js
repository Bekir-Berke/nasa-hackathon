const BASE_URL = "https://api.open-meteo.com/v1/forecast";
const HOUR_MS = 60 * 60 * 1000;

let cachedFetch = typeof fetch === "function" ? fetch.bind(globalThis) : null;

async function fetchWithFallback(url) {
  if (!cachedFetch) {
    const mod = await import("node-fetch");
    cachedFetch = mod.default;
  }
  return cachedFetch(url);
}

const cache = new Map();

function buildParams(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: [
      "temperature_2m",
      "precipitation",
      "wind_speed_10m",
      "wind_direction_10m",
      "soil_temperature_0cm",
      "soil_moisture_1_to_3cm",
      "surface_pressure",
      "cloud_cover",
      "relative_humidity_2m"
    ].join(","),
    forecast_days: "1",
    timezone: "UTC"
  });
  return `${BASE_URL}?${params.toString()}`;
}

function normaliseHourly(response) {
  const times = response.hourly.time;
  return times.map((t, idx) => ({
    time: t,
    temperature_2m: response.hourly.temperature_2m[idx],
    precipitation: response.hourly.precipitation[idx],
    wind_speed_10m: response.hourly.wind_speed_10m[idx],
    wind_direction_10m: response.hourly.wind_direction_10m[idx],
    soil_temperature_0cm: response.hourly.soil_temperature_0cm[idx],
    soil_moisture_1_to_3cm: response.hourly.soil_moisture_1_to_3cm[idx],
    surface_pressure: response.hourly.surface_pressure[idx],
    cloud_cover: response.hourly.cloud_cover[idx],
    relative_humidity_2m: response.hourly.relative_humidity_2m[idx]
  }));
}

function summaryFromHourly(hourly) {
  if (!Array.isArray(hourly) || hourly.length === 0) return null;
  const first = hourly[0];
  const precip = hourly.reduce((sum, h) => sum + (h.precipitation || 0), 0);
  const avg = (key) => hourly.reduce((sum, h) => sum + (h[key] || 0), 0) / hourly.length;
  return {
    at: first.time,
    temperature_2m: first.temperature_2m,
    precipitation_24h: Number(precip.toFixed(2)),
    wind_speed_10m: first.wind_speed_10m,
    wind_direction_10m: first.wind_direction_10m,
    relative_humidity_2m: first.relative_humidity_2m,
    soil_moisture_1_to_3cm_avg: Number(avg("soil_moisture_1_to_3cm").toFixed(4)),
    cloud_cover_avg: Number(avg("cloud_cover").toFixed(2))
  };
}

async function fetchWeather(lat, lon) {
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const entry = cache.get(cacheKey);
  const now = Date.now();
  if (entry && now - entry.timestamp < HOUR_MS) {
    return entry.data;
  }

  const url = buildParams(lat, lon);
  const res = await fetchWithFallback(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed with status ${res.status}`);
  }
  const json = await res.json();
  const hourly = normaliseHourly(json);
  const summary = summaryFromHourly(hourly);
  const payload = {
    latitude: json.latitude,
    longitude: json.longitude,
    elevation: json.elevation,
    hourly,
    summary
  };
  cache.set(cacheKey, { timestamp: now, data: payload });
  return payload;
}

module.exports = {
  fetchWeather
};
