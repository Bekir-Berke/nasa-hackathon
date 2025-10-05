const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const SocketIOServer = require("socket.io");
const { firefighters, fireArea, randomJitter, drones, setFireArea, setExternalCells } = require("./data");
const { fetchWeather } = require("./services/weather");
const { buildElevationGrid } = require("./services/slope");
const { computeFWI } = require("./services/fwi");
const { runFireSimulation } = require("./services/fireSimulation");
const { analyzeFirePolygon } = require("./services/fireAnalysis");
const path = require("path");

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer.Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// ---- REST API ----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// tüm itfaiyeciler
app.get("/api/firefighters", (req, res) => {
  res.json(firefighters);
});

// tek itfaiyeci (id ile)
app.get("/api/firefighters/:id", (req, res) => {
  const f = firefighters.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "not found" });
  res.json(f);
});

// konum/status güncelle (dummy POST)
app.post("/api/firefighters/:id", (req, res) => {
  const f = firefighters.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: "not found" });
  const { lat, lon, status, name } = req.body || {};
  if (typeof lat === "number") f.lat = lat;
  if (typeof lon === "number") f.lon = lon;
  if (typeof status === "string") f.status = status;
  if (typeof name === "string") f.name = name;

  io.emit("firefighters:update", firefighters);
  res.json({ ok: true, firefighter: f });
});

// yangın alanı (polygon)
app.get("/api/firearea", (req, res) => {
  res.json(fireArea);
});

app.get("/api/fire/analysis", (req, res) => {
  const cellCount = typeof req.query.cellCount !== "undefined" ? Number(req.query.cellCount) : undefined;
  const searchRadiusFactor = typeof req.query.searchRadiusFactor !== "undefined"
    ? Number(req.query.searchRadiusFactor)
    : undefined;

  const options = {};
  if (Number.isFinite(cellCount) && cellCount > 0) {
    options.count = Math.floor(Math.min(cellCount, 50));
  }
  if (Number.isFinite(searchRadiusFactor) && searchRadiusFactor > 0) {
    options.searchRadiusFactor = searchRadiusFactor;
  }

  const analysis = analyzeFirePolygon(fireArea, options);
  const [centerLat, centerLon] = analysis.center;

  res.json({
    firePolygon: analysis.coords,
    fireCenter: {
      lat: centerLat,
      lon: centerLon
    },
    fireRadius: analysis.radius,
    searchRadius: analysis.searchRadius,
    cells: analysis.cells.map((cell) => ({
      id: cell.cell_id,
      lat: cell.x,
      lon: cell.y,
      fire_power: cell.fire_power,
      spread_prob: cell.spread_prob,
      area: cell.area,
      value_at_risk: cell.value_at_risk,
      crew_risk: cell.crew_risk,
      time_to_impact: cell.time_to_impact,
      dist_to_fire_center: analysis.center.every(Number.isFinite)
        ? Math.hypot(cell.x - centerLat, cell.y - centerLon)
        : null
    })),
    candidates: analysis.candidates.map((cell) => ({
      id: cell.cell_id,
      lat: cell.x,
      lon: cell.y,
      fire_power: cell.fire_power,
      spread_prob: cell.spread_prob,
      area: cell.area,
      value_at_risk: cell.value_at_risk,
      crew_risk: cell.crew_risk,
      time_to_impact: cell.time_to_impact,
      dist_to_fire_center: cell.dist_to_fire_center
    })),
    bestCell: analysis.bestCell
      ? {
          id: analysis.bestCell.cell_id,
          lat: analysis.bestCell.x,
          lon: analysis.bestCell.y,
          fire_power: analysis.bestCell.fire_power,
          spread_prob: analysis.bestCell.spread_prob,
          area: analysis.bestCell.area,
          value_at_risk: analysis.bestCell.value_at_risk,
          crew_risk: analysis.bestCell.crew_risk,
          time_to_impact: analysis.bestCell.time_to_impact,
          dist_to_fire_center: analysis.bestCell.dist_to_fire_center
        }
      : null
  });
});

// yangın alanını güncelle (ör: genişletme simülasyonu)
app.post("/api/firearea", (req, res) => {
  const { coords } = req.body || {};
  if (!Array.isArray(coords)) return res.status(400).json({ error: "coords required" });
  if (!coords.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number"))) {
    return res.status(400).json({ error: "invalid coords" });
  }
  setFireArea(coords);
  setExternalCells([]);
  io.emit("firearea:update", fireArea);
  res.json({ ok: true, fireArea });
});

// drone endpointleri
app.get("/api/drones", (req, res) => res.json(drones));

// Place firefighters strategically before serving initial snapshots
randomJitter();

app.get("/api/environment", async (req, res) => {
  const lat = typeof req.query.lat !== "undefined" ? Number(req.query.lat) : fireArea[0]?.[0] ?? 37.05;
  const lon = typeof req.query.lon !== "undefined" ? Number(req.query.lon) : fireArea[0]?.[1] ?? 30.49;

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: "invalid coordinates" });
  }

  try {
    const [weather, elevation] = await Promise.all([
      fetchWeather(lat, lon),
      buildElevationGrid(lat, lon)
    ]);

    const summary = weather.summary ?? weather.hourly?.[0] ?? {};
    const refDate = summary.at ? new Date(summary.at) : (summary.time ? new Date(summary.time) : new Date());
    const month = refDate.getUTCMonth() + 1;
    const fwi = computeFWI({
      temperature: summary.temperature_2m ?? 20,
      relativeHumidity: summary.relative_humidity_2m ?? 45,
      windSpeed: summary.wind_speed_10m ?? 3,
      rain: summary.precipitation_24h ?? 0,
      month
    });

    res.json({
      lat,
      lon,
      weather,
      elevation: {
        matrix: elevation.matrix,
        slopeDegrees: Number(elevation.slope.slopeDegrees.toFixed(2)),
        aspectDegrees: Number(elevation.slope.aspectDegrees.toFixed(2))
      },
      fwi
    });
  } catch (err) {
    console.error("environment fetch failed", err);
    res.status(500).json({ error: "environment fetch failed" });
  }
});

app.post("/api/fire/simulation", async (req, res) => {
  const { lat, lon, hours, gridSize, cellSize, seed } = req.body || {};

  try {
    const simulation = await runFireSimulation({
      lat: typeof lat === "number" ? lat : undefined,
      lon: typeof lon === "number" ? lon : undefined,
      hours: typeof hours === "number" ? hours : undefined,
      gridSize: typeof gridSize === "number" ? gridSize : undefined,
      cellSize: typeof cellSize === "number" ? cellSize : undefined,
      seed: typeof seed === "number" ? seed : undefined,
      basePolygon: Array.isArray(fireArea)
        ? fireArea
            .filter((coord) => Array.isArray(coord) && coord.length >= 2)
            .map(([latValue, lonValue]) => [Number(latValue), Number(lonValue)])
        : undefined
    });

    const strategicCells = collectStrategicCellsFromForecast(
      simulation.forecast,
      Math.max(firefighters.length * 3, 18)
    );
    setExternalCells(strategicCells);
    randomJitter();
    io.emit("firefighters:update", firefighters);
    io.emit("drones:update", drones);

    // Share forecast data with clients while the new polygon/state updates propagate
    io.emit("fire:forecast", simulation.forecast);
    res.json(simulation);
  } catch (err) {
    console.error("simulation failed", err);
    setExternalCells([]);
    res.status(500).json({ error: "simulation failed" });
  }
});

io.on("connection", (socket) => {
  socket.emit("firefighters:init", firefighters);
  socket.emit("firearea:init", fireArea);
  socket.emit("drones:init", drones);
});

// === MESH SİSTEMİ ===
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeMeshLinks(nodes, rangeKm = 2.5) {
  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dist = haversine(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
      links.push({
        from: nodes[i].id,
        to: nodes[j].id,
        distance: +dist.toFixed(2),
        active: dist <= rangeKm
      });
    }
  }
  return links;
}

function normalizeStrategicCell(cell) {
  if (!cell) return null;
  const lat = Number(cell.lat ?? cell.x);
  const lon = Number(cell.lon ?? cell.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: cell.id || cell.cell_id || null,
    lat,
    lon,
    score: Number.isFinite(cell.score) ? cell.score : 0,
    crew_risk: Number.isFinite(cell.crew_risk) ? cell.crew_risk : 0.3,
    spread_prob: Number.isFinite(cell.spread_prob) ? cell.spread_prob : 0.5,
    value_at_risk: Number.isFinite(cell.value_at_risk) ? cell.value_at_risk : 0,
    front_distance: Number.isFinite(cell.front_distance) ? cell.front_distance : 100
  };
}

function collectStrategicCellsFromForecast(forecast, limit) {
  if (!Array.isArray(forecast)) return [];
  const max = Math.max(limit || 0, 1);
  const seen = new Set();
  const collected = [];

  for (const entry of forecast) {
    if (collected.length >= max) break;
    const analysis = entry?.fireAnalysis;
    if (!analysis) continue;
    const sourceCells = [];
    if (analysis.bestCell) sourceCells.push(analysis.bestCell);
    if (Array.isArray(analysis.candidates)) {
      sourceCells.push(...analysis.candidates.slice(0, 6));
    }

    for (const cell of sourceCells) {
      const normalized = normalizeStrategicCell(cell);
      if (!normalized) continue;
      const key = `${normalized.lat.toFixed(5)},${normalized.lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(normalized);
      if (collected.length >= max) break;
    }
  }

  return collected;
}

setInterval(() => {
  randomJitter();
  io.emit("firefighters:update", firefighters);
  io.emit("drones:update", drones);

  const meshNodes = [...firefighters, ...drones];
  const meshLinks = computeMeshLinks(meshNodes, 1.5);
  io.emit("mesh:update", meshLinks);
}, 5000);

// Port
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🔥 API & WS listening on http://localhost:${PORT}`);
});
