# Aegis — Safety, Before You Ask

Aegis is a proactive campus safety system that monitors a student's walk home in real time and detects behavioral anomalies — sudden stops, acceleration spikes — before the user has to manually trigger a panic alert. It's a streaming anomaly-detection pipeline, not a reactive panic button: the system watches continuously and escalates on its own if it thinks something is wrong.

Built as a hackathon vertical slice: a React Native mobile client streams telemetry over WebSocket to a Go backend, which runs it through a concurrent risk engine and pushes live updates to a web dashboard.

## How it works

1. **Start a walk.** The mobile app requests location + accelerometer permissions and opens a WebSocket connection to the backend.
2. **Stream telemetry.** Every 2 seconds the app sends `{ sessionId, latitude, longitude, speed, accelerationMagnitude, timestamp }` to the backend.
3. **Evaluate risk.** The backend keeps a 30-second sliding window per session and checks it for:
   - **Sudden stop** — average speed under threshold and <3m of movement over a 20s window.
   - **Acceleration spike** — instantaneous acceleration magnitude above a threshold (possible fall or grab).
   - **Circadian multiplier** — the same anomaly is weighted differently depending on time of day (see table below), since walking at 1 PM and 1 AM are not the same risk.
4. **Warn, then escalate.** If the weighted score crosses a threshold, the backend pushes an "Are you safe?" prompt to the phone and starts a 20-second countdown. If the user doesn't respond, the session flips to `DANGER` and the backend logs a mock emergency dispatch (console/log output — no real SMS integration in this build).
5. **Watch it happen live.** A web dashboard subscribes to the same WebSocket stream and renders the user's live position on a map, the current risk score, active time multiplier, and a running event log.

### Circadian risk multiplier

| Time band | Multiplier |
|---|---|
| 6:00 AM – 6:00 PM | 1.0x |
| 6:00 PM – 10:00 PM | 1.2x |
| 10:00 PM – 2:00 AM | 1.6x |
| 2:00 AM – 6:00 AM | 1.4x |

`Risk Score = Base Event Points × Time Multiplier` (capped at 100).

## Architecture

```
 Mobile Client                          Go Backend
 React Native + Expo      /ws       ┌─────────────────┐
 (expo-location,     ───────────▶   │  Telemetry       │
  expo-sensors)                     │  Gateway         │
                         ◀───────── │  → Risk Engine    │
                     telemetry,     │  → Escalation Svc │
                     risk updates,  └────────┬─────────┘
                     safety prompts          │
                                    broadcast over the
                                    same /ws to every
                                    connected client
                                              │
                                              ▼
                                    ┌─────────────────┐
                                    │  Web Dashboard   │
                                    │  React + Vite +  │
                                    │  Mapbox GL       │
                                    └─────────────────┘
```

- **Telemetry Gateway** (`backend/internal/delivery/http/ws`) — one goroutine per WebSocket connection (`Session`), with context-based cancellation and clean shutdown on server exit.
- **Risk Engine** (`backend/internal/usecase/risk`) — maintains a per-session sliding window, evaluates anomalies, applies the circadian multiplier, and emits a `RiskUpdate`.
- **Escalation Service** (`backend/internal/usecase/escalation`) — listens for risk breaches, prompts the user, runs a 10s response timer, and mock-dispatches an emergency notification (via log/console) if the user doesn't confirm safety in time.
- Every telemetry frame and every risk update is broadcast to **all** connected clients (mobile + dashboard) over the same `/ws` endpoint — the dashboard just filters by payload shape (`accelerationMagnitude` → telemetry, `riskScore` → risk update).

This project intentionally has **no authentication, no persistence layer (Redis/Postgres are described in the spec but not wired up in this slice), and no real SMS/webhook integration** — see [Scope](#scope--whats-not-here) below.

## Tech stack

| Layer | Stack |
|---|---|
| Backend | Go 1.21, [`gorilla/websocket`](https://github.com/gorilla/websocket), standard library `net/http` |
| Mobile | React Native (Expo SDK 54, Expo Router), `expo-location`, `expo-sensors` |
| Dashboard | React 19, Vite, TypeScript, Tailwind CSS v4, Mapbox GL JS, `lucide-react` |

## Repository layout

```
backend/
  cmd/api/main.go                       entrypoint — HTTP server, graceful shutdown
  internal/delivery/http/ws/            WebSocket gateway (Server, Session)
  internal/usecase/risk/                sliding-window risk engine + circadian multiplier
  internal/usecase/escalation/          escalation prompt/timeout/dispatch logic
  internal/domain/                      shared types (Telemetry, RiskUpdate, ClientAction)

dashboard/
  src/AegisDashboard.tsx                main dashboard UI (map, risk panel, event log)

mobile/
  app/index.tsx                         main screen — walk activation, telemetry streaming, safety prompt

AEGIS.prd                               full product & engineering specification
```

## Running it locally

You'll need Go 1.21+, Node.js, and the Expo CLI (via `npx`). All three services run independently — start the backend first, then the dashboard and/or mobile app.

### 1. Backend

```bash
cd backend
go run ./cmd/api
```

Starts an HTTP server on `:8080` with a `/health` check and a `/ws` WebSocket endpoint.

### 2. Dashboard

```bash
cd dashboard
cp .env.example .env      # add your own Mapbox public token as VITE_MAPBOX_TOKEN
npm install
npm run dev
```

The dashboard connects to `ws://<hostname>:8080/ws`. Without a valid Mapbox token the map falls back to a dummy token and won't render tiles, but the risk panel and event log still work.

### 3. Mobile app

```bash
cd mobile
npm install
npx expo start
```

On launch, enter your machine's LAN IP and port (e.g. `192.168.1.5:8080`) in the "Backend Address" field so the phone can reach the backend over WebSocket — `localhost` won't resolve from a physical device or most emulators. Android emulators default to `10.0.2.2:8080`, iOS simulators to `127.0.0.1:8080`.

## Scope — what's not here

This is a deliberately scoped hackathon slice, not a production system. Per the [product spec](AEGIS.prd), the following are explicitly out of scope for this build:

- User accounts / authentication
- Real SMS or push notification integration (emergency dispatch is simulated via console/log output)
- Redis / PostgreSQL persistence (session state currently lives in memory and is lost on backend restart)
- Cloud deployment
- Machine learning models
- Historical analytics, multi-user, or social features

Session IDs are currently hardcoded to `"demo_user"` in both the mobile client and the backend's `SAFE` acknowledgment path — this is a known MVP simplification, not a bug.
