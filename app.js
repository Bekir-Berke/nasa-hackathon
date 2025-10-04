const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const SocketIOServer = require("socket.io");
const { firefighters, fireArea, randomJitter, drones } = require("./data");
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
  res.sendFile(__dirname + "/public/index.html");
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

  // anlık yayın (frontend socket alırsa canlı güncellenir)
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
  // coords: [[lat, lon], ...]
  // basit doğrulama
  if (!coords.every(p => Array.isArray(p) && p.length === 2)) {
    return res.status(400).json({ error: "invalid coords" });
  }
  // güncelle
  for (let i = 0; i < coords.length; i++) fireArea[i] = coords[i];
  io.emit("firearea:update", fireArea);
  res.json({ ok: true, fireArea });
});

// drone endpointleri
app.get("/api/drones", (req, res) => res.json(drones));

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

// ---- Socket.IO: canlı yayın ----
io.on("connection", (socket) => {
  // bağlanan kullanıcıya mevcut state’i yolla
  socket.emit("firefighters:init", firefighters);
  socket.emit("firearea:init", fireArea);
});

// periyodik dummy hareket simülasyonu + yayın
setInterval(() => {
  randomJitter();
  io.emit("firefighters:update", firefighters);
}, 5000);

// Port
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🔥 API & WS listening on http://localhost:${PORT}`);
});
