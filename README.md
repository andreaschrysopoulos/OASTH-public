# OASTH Map App

Interactive map and arrivals app for Thessaloniki bus data, built with React, Vite, and a small Express proxy for the OASTH telematics endpoints.

## Overview

The project has two parts:

- A React client that renders the map UI and bus-stop experience
- An Express server that proxies OASTH telematics requests and serves the built app in production

The proxy exists so the browser does not need to deal directly with the upstream session and CSRF flow used by the OASTH telematics API.

## Stack

- React 19
- Vite
- Express 5
- Mapbox GL via `react-map-gl`

## Project Structure

```text
OASTH-public/
  public/                  Static client assets
  server/                  Express proxy entrypoint
  src/
    app/                   React app shell and main UI
    shared/                Logic shared by client and server
    styles/                Global client styles
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create your local env file

```bash
cp .env.example .env
```

Set `VITE_MAPBOX_ACCESS_TOKEN` in `.env` to a Mapbox public token that starts with `pk.`.

`.env` stays local and should not be committed. The committed template is [`.env.example`](./.env.example).

### 3. Run the app locally

Use two terminals:

```bash
npm run server
```

```bash
npm run dev
```

Local URLs:

- App: `http://localhost:5173`
- API proxy: `http://localhost:3001`

Vite proxies `/api` requests to the local Express server during development.

## Production

Build the frontend and run the Node server in production mode:

```bash
npm run build
NODE_ENV=production npm start
```

In production, the same Express process serves:

- The built frontend from `dist/`
- The `/api/*` proxy endpoints
- `GET /health` for a simple health check

If `dist/` is missing, the server still starts but only the API is available.

## Environment Variables

| Variable | When used | Purpose |
|----------|-----------|---------|
| `VITE_MAPBOX_ACCESS_TOKEN` | build time | Required Mapbox public token for the map |
| `VITE_MAPBOX_STYLE` | build time | Optional custom Mapbox style URL |
| `PORT` | runtime | Express port, defaults to `3001` |
| `NODE_ENV` | runtime | Set to `production` for static asset serving and production behavior |
| `CORS_ORIGIN` | runtime | Optional allowed origin or comma-separated origins when frontend and API are hosted separately |
| `PAGE_PASSWORD` | runtime | Optional password gate for the whole app |
| `OASTH_LEGACY_ROUTE_POLE_MAP` | runtime | Optional fallback route-stop mapping mode |
| `OASTH_FETCH_TIMEOUT_MS` | runtime | Optional upstream request timeout override |
| `OASTH_FETCH_RETRIES` | runtime | Optional number of retry attempts for upstream fetches |
| `OASTH_FETCH_RETRY_BASE_MS` | runtime | Optional base delay for upstream fetch retries |

## Page Password

If `PAGE_PASSWORD` is set, the server requires a successful `POST /api/auth/page-login` before serving the full app experience. This is optional and is mainly useful for private deployments.

If `PAGE_PASSWORD` is not set, the app is open as usual.

## Deployment Notes

- Same-host deployment is the simplest setup: serve the frontend and API from the same Node process.
- If you split the frontend and API across different hosts, set `CORS_ORIGIN` to the frontend origin.
- Many hosting providers already set `NODE_ENV=production` when running `npm start`.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start the Vite development server |
| `npm run server` | Start the Express API proxy |
| `npm run build` | Create a production frontend build |
| `npm start` | Start the Express server |
| `npm run lint` | Run ESLint |
| `npm run preview` | Preview the Vite production build |
