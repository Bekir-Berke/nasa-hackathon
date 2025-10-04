const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const SocketIOServer = require("socket.io");
const { firefighters, fireArea, randomJitter, drones, setFireArea } = require("./data");
const { fetchWeather } = require("./services/weather");
const { buildElevationGrid } = require("./services/slope");
const { computeFWI } = require("./services/fwi");
const { runFireSimulation } = require("./services/fireSimulation");
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

// yangın alanını güncelle (ör: genişletme simülasyonu)
app.post("/api/firearea", (req, res) => {
  const { coords } = req.body || {};
  if (!Array.isArray(coords)) return res.status(400).json({ error: "coords required" });
  if (!coords.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number"))) {
    return res.status(400).json({ error: "invalid coords" });
  }
  setFireArea(coords);
  io.emit("firearea:update", fireArea);
  res.json({ ok: true, fireArea });
});

// drone endpointleri
app.get("/api/drones", (req, res) => res.json(drones));

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
      seed: typeof seed === "number" ? seed : undefined
    });

    if (simulation.footprint.length >= 3) {
      setFireArea(simulation.footprint);
      io.emit("firearea:update", fireArea);
    }
    io.emit("fire:forecast", simulation.features);
    res.json(simulation);
  } catch (err) {
    console.error("simulation failed", err);
    res.status(500).json({ error: "simulation failed" });
  }
});

io.on("connection", (socket) => {
  socket.emit("firefighters:init", firefighters);
  socket.emit("firearea:init", fireArea);
  socket.emit("drones:init", drones);
});

setInterval(() => {
  randomJitter();
  io.emit("firefighters:update", firefighters);
  io.emit("drones:update", drones);
}, 5000);

// Port
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🔥 API & WS listening on http://localhost:${PORT}`);
});
