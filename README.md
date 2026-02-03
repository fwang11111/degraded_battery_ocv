# OCV Degradation

This is a Node.js-based web application that implements and visualizes the methodology described in "Degradation diagnostics for lithium ion cells" （Birkl, Christoph R., et al.， Journal of Power Sources 341， 2017).

## Repo layout

- `app/`: React + TypeScript + Vite frontend
- `server/`: Node.js + Express backend (current runnable API)
- `api/`: Python + FastAPI backend (draft/target)

## Prereqs

- Node.js (LTS recommended)
- (Optional) Python 3.10+

## Run (recommended: Node backend + frontend)

1) Start backend (port 8000 by default)

```bash
cd server
npm ci
npm run dev
```

2) Start frontend

```bash
cd app
npm ci
npm run dev
```

If your backend is not on `http://localhost:8000`, set `VITE_API_BASE` before starting the frontend.

## Run (optional: Python API draft)

```bash
python -m pip install -r api/requirements.txt
python -m uvicorn api.main:app --reload --port 8000
```
