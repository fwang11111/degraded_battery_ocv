# OCV Degradation Diagnostics Web App

Interactive web UI for building pristine full-cell OCV curves from half-cell data, simulating degradation (LLI/LAM), fitting degradation parameters from measured OCV, and comparing OCV change of many degraded cells.

This project is inspired by:
Birkl, Christoph R., et al. “Degradation diagnostics for lithium ion cells.” Journal of Power Sources 341 (2017).

## What This App Does

- Build a "pristine" full-cell OCV curve from PE/NE half-cell OCV CSVs and SOL endpoints.
- Simulate degraded full-cell OCV under:
  - `LLI` (loss of lithium inventory)
  - `LAM_PE` (loss of active material in positive electrode)
  - `LAM_NE` (loss of active material in negative electrode)
- Save degraded parameter sets to a local "degraded pool" for later comparison.
- Diagnose (`LLI`, `LAM_PE`, `LAM_NE`) from a measured full-cell OCV curve using multi-start optimization.
- Compare selected degraded pool items and pristine baselines via:
  - Voltage curve overlay
  - `dQ` vs `V`
  - `|dQ/dV|` vs `V` (with configurable smoothing window)

## Repo Layout

- `app/`: React + TypeScript + Vite frontend (single-page UI)
- `server/`: Node.js + Express backend (currently runnable)
- `api/`: Python + FastAPI backend (alternative/draft API)
- `api/data/`: on-disk storage (shared by Node/Python backends)
  - `api/data/pristine/`: pristine profile JSON
  - `api/data/degraded_pool/`: saved degraded pool items

## Prerequisites

- Node.js (LTS recommended)
- npm
- (Optional) Python 3.10+ (for the FastAPI draft)

## Run Locally (Recommended: Node backend + Vite frontend)

1) Start backend (Express; default `http://localhost:8000`)

```bash
cd server
npm ci
npm run dev
```

2) Start frontend (Vite; default `http://localhost:5173`)

```bash
cd app
npm ci
npm run dev
```

Environment variables:

- `PORT` (backend): defaults to `8000`
- `VITE_API_BASE` (frontend): defaults to `http://localhost:8000`

macOS/Linux:

```bash
export VITE_API_BASE=http://localhost:8000
cd app
npm run dev
```

Windows (PowerShell):

```powershell
$env:VITE_API_BASE = "http://localhost:8000"
cd app
npm run dev
```

## Deploy / Run in Production

This repo does not ship Dockerfiles or a hosted deployment pipeline yet, but the simplest single-machine deployment is:

1) Run the backend as a long-lived process (systemd/pm2/etc.):

```bash
cd server
npm ci

# macOS/Linux
export PORT=8000
npm start
```

2) Build and serve the frontend:

```bash
cd app
npm ci

# macOS/Linux
export VITE_API_BASE=http://YOUR_SERVER_HOST:8000
npm run build
npm run preview -- --host 0.0.0.0 --port 5173
```

Notes:

- `VITE_API_BASE` is baked into the built frontend bundle; set it correctly before `npm run build`.
- Persist `api/data/` (profiles + pool) if you redeploy/move the service.

## UI Guide (Tabs)

### Pristine Cells

- Maintain a library of pristine cell profiles.
- Create a new pristine cell by providing:
  - PE half-cell OCV CSV
  - NE half-cell OCV CSV
  - SOL endpoints (EoC/EoD for each electrode)
- Preview pristine PE/NE/cell curves.
- Delete pristine profiles.

### Degradation

- Select a pristine cell profile.
- Adjust degradation parameters (`LLI`, `LAM_PE`, `LAM_NE`) via sliders and numeric inputs.
- Plots update as parameters change.
- Save the current degraded parameter set to the pool.
- Export the degraded full-cell voltage curve to CSV.
- Load/delete saved pool items.

### Diagnostics

- Fit degradation parameters to a measured full-cell OCV curve.
- Input options:
  - Sample `matlab/synthetic_ocv.mat`
  - Upload a `.mat` or `.csv` with measured `capacity` and `ocv`
- Control optimization settings (starts, iterations, gradient-limit mask, seed).
- Outputs:
  - estimated `LLI`, `LAM_PE`, `LAM_NE`
  - fit curve overlay and RMSE

### Analysis

- Pick a pristine cell baseline.
- Select any number of saved degraded pool items.
- Toggle `Self normalization` to compare degraded curves on:
  - Pristine-normalized capacity (default), or
  - Each cell's own 0-1 capacity window

Plots:

- Voltage Curve Comparison: overlay selected degraded curves and pristine baseline.
- dQ vs V: `dQ = Q_degraded(V) - Q_pristine(V)`.
- |dQ/dV| vs V:
  - uses a uniform voltage grid with spacing = `Smooth window (V)`
  - computes average Q in each V bin, then finite-differences adjacent bins
  - plots `abs(dQ/dV)` for all selected curves (pristine + degraded)
