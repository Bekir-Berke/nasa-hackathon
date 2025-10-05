# FireMesh Dashboard

FireMesh is an integrated situational-awareness platform created for the NASA Space Apps Challenge to keep firefighters informed about one another during fast-evolving forest fires. The dashboard fuses live crew telemetry, peer-to-peer connectivity insights, and environmental intelligence so that every responder can understand where teammates are, how the fire is spreading, and which zones need attention.

## Objectives
- Maintain a single shared map of firefighter and drone locations, ensuring teams stay aware of one another's movements and proximity to danger.
- Visualize mesh-network connectivity so field units know who they can reach directly and where communication gaps appear.
- Enrich crew awareness with Fire Weather Index (FWI), topography, and simulated spread forecasts that highlight emerging risks around each team.
- Support the NASA Space Apps "Wildfire Connections" challenge by strengthening coordination when infrastructure is degraded or absent.

## Key Features
- **Realtime crew presence:** The OpenLayers map streams firefighter and drone positions over Socket.IO, keeping everyone synced on the same tactical picture.
- **Mesh network view:** Computes line-of-sight links between crews and unmanned assets, flagging weak or broken edges that could isolate responders.
- **Proximity + risk alerts:** Smart notifications draw attention to teammates entering hazardous zones and pan the map to their exact coordinates.
- **Environmental intelligence:** Integrates Open-Meteo weather and elevation data to calculate FWI, slope, and wind direction around each crew.
- **Wildfire simulation:** A Rothermel-inspired engine forecasts hourly fire spread rings, highlighting strategic cells relative to firefighter positions.
- **Shared analysis panel:** Summaries of team status, best intervention cells, and current mesh health provide a concise briefing for all responders.

## Architecture & Technologies
- **Server:** Node.js, Express, Socket.IO, dotenv, CORS
- **Client:** OpenLayers, Socket.IO client, vanilla HTML/CSS/JS
- **Services:**
  - `services/weather.js`: Fetches and caches Open-Meteo weather data
  - `services/slope.js`: Builds 3×3 elevation grids and slope metrics
  - `services/fwi.js`: Calculates Canadian Fire Weather Index components
  - `services/fireSimulation.js`: Rothermel-based spread forecasts that respect crew locations
  - `services/fireAnalysis.js`: Scores risk cells and selects the best intervention target for teams
- **Data model:** `data.js` seeds initial firefighter/drone locations and the baseline fire polygon; simulation output updates the in-memory state to keep every client aligned.

## Setup & Run
1. Requirements: Node.js 18+ and npm.
2. Clone the repository or navigate to the project folder.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the development server:
   ```bash
   npm start
   ```
5. Open `http://localhost:5000` in your browser.

> The simulator retrieves weather and elevation data from Open-Meteo APIs, so an active internet connection is required.

## Usage Flow
- When the dashboard loads, it pulls firefighter, drone, and fire-perimeter snapshots through Socket.IO, placing every teammate on the shared map.
- The right-hand panel refreshes wind, FWI, slope, and best-cell metrics to help crews evaluate risks around their colleagues.
- The **Simulation** button generates a forward spread forecast that overlays hourly rings and strategic cells relative to firefighter positions.
- Mesh links animate every five seconds, letting responders confirm that nearby teammates remain reachable and flagging isolated units.
- Alert cards can be clicked to zoom the map to a teammate or hazard location while displaying a blinking danger marker for rapid orientation.

## REST & WebSocket Interfaces
| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/firefighters` | Current list of firefighter units |
| GET | `/api/firefighters/:id` | Details of a single firefighter |
| POST | `/api/firefighters/:id` | Simulated location/status update |
| GET | `/api/drones` | Drone inventory and locations |
| GET | `/api/firearea` | Wildfire polygon coordinates |
| POST | `/api/firearea` | Update the polygon and reset external cells |
| GET | `/api/environment?lat&lon` | Weather, elevation, and FWI summary |
| GET | `/api/fire/analysis` | Polygon analysis with strategic cells |
| POST | `/api/fire/simulation` | Run the wildfire spread simulation |

WebSocket channels (`firefighters:update`, `drones:update`, `firearea:update`, `fire:forecast`, `mesh:update`) keep the crew-awareness layers synchronized across all connected clients.

## NASA Space Apps Alignment
- **Challenge fit:** Directly addresses "Create Your Own Challenge" by prioritizing firefighter-to-firefighter awareness and resilience of field communications.
- **Value proposition:**
  - Creates a single truth source for crew positions, connectivity, and fire behavior.
  - Surfaces at-risk teammates through targeted alerts, improving mutual awareness and rapid support.
  - Provides planning-grade forecasts that highlight where teams should regroup or redeploy to maintain contact.

## Roadmap
- Integrate realtime satellite/thermal imagery and NASA wildfire datasets for richer situational context.
- Add offline-friendly mobile clients so crews can cache the latest teammate positions when connectivity drops.
- Calibrate the simulator using historical fire perimeters to better predict risk corridors around field units.
- Expand mesh analytics with bandwidth/latency estimates and suggested relay drone placements.

## Contributing
Teams aiming to extend FireMesh after NASA Space Apps can open issues or submit pull requests. Please include a short summary of the change and any validation steps you carried out to keep the crew-awareness workflow reliable.
