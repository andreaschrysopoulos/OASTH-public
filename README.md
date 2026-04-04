# OASTH map app

React + Vite frontend with a small Express proxy to [OASTH telematics](https://telematics.oasth.gr) (session cookie + CSRF; no Playwright at runtime).

## Project structure

```text
OASTH/
  public/                  Static client assets
  server/                  Express proxy entrypoint
  src/
    app/                   React app shell and entry boundary
    shared/                Logic shared by client and server
    styles/                Global client styles
```

## Setup

```bash
cd OASTH
npm install
cp .env.example .env
# Then set VITE_MAPBOX_ACCESS_TOKEN in .env (Mapbox public token, pk.…)
```

Keep `.env` local only. The repository includes `.env.example` as the safe template to commit.

## Development

Two terminals:

```bash
npm run server   # API proxy → http://localhost:3001
npm run dev      # Vite → http://localhost:5173 (proxies /api to 3001)
```

## Production

Build the UI, then run Node with `NODE_ENV=production` so the same process serves `dist/` and `/api/*`:

```bash
npm run build
NODE_ENV=production npm start
```

Most PaaS set `NODE_ENV=production` for you when running `npm start`.

- Default port: **3001** (override with `PORT`).
- **Health check:** `GET /health` → `{ "ok": true }`.
- If `dist/` is missing in production, only the API is served (a warning is logged).
- **Page password (optional):** set `PAGE_PASSWORD` in the environment. The Express server then requires a successful `POST /api/auth/page-login` (sets an httpOnly cookie) before `/api/*` and the static SPA are served. Omit `PAGE_PASSWORD` for open access (typical local dev).

### CORS

- Same host (recommended): do **not** set `CORS_ORIGIN`; the server disables permissive CORS in production.
- Split hosting (e.g. static on a CDN): set `CORS_ORIGIN` to your site origin(s), comma-separated.

### Environment variables

| Variable | Where | Purpose |
|----------|--------|---------|
| `VITE_MAPBOX_ACCESS_TOKEN` | build time | Mapbox GL token |
| `VITE_MAPBOX_STYLE` | build time | Optional map style URL |
| `PORT` | runtime | Listen port (default 3001) |
| `NODE_ENV` | runtime | Use `production` for static + hardened errors |
| `CORS_ORIGIN` | runtime | Browser origins if API is on another host |
| `PAGE_PASSWORD` | runtime | Optional password gate for the whole app |
