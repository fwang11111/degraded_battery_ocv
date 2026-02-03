from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from api.models.schemas import (
    CurvesRequest,
    CurvesResponse,
    DiagnosticsEstimateRequest,
    DiagnosticsEstimateResponse,
    PoolItemSummary,
    PoolListResponse,
    PoolSaveRequest,
)
from api.services.ocv_degraded import (
    build_plot_axis,
    calculate_degraded_ocv_raw,
    estimate_diagnostics_multistart,
    load_measured_ocv_from_mat,
    MeasuredOcv,
    map_curves_to_plot_x,
)
from api.services.ocv_pristine import build_pristine_cell_from_csv
from api.services.pristine_loader import load_pristine_profiles, resolve_profile_csv_path


API_ROOT = Path(__file__).resolve().parent
DATA_DIR = API_ROOT / 'data'
PRISTINE_DIR = DATA_DIR / 'pristine'
POOL_DIR = DATA_DIR / 'degraded_pool'


app = FastAPI(title='OCV App API')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.get('/health')
def health() -> dict[str, Any]:
    return {'ok': True}


@app.get('/pristine/catalog')
def pristine_catalog() -> dict[str, Any]:
    catalog = load_pristine_profiles(PRISTINE_DIR)
    return {'profiles': [p.model_dump() for p in catalog.profiles.values()]}


def _np_to_list(arr: Any) -> list[float]:
    a = np.asarray(arr, dtype=float)
    # Keep NaNs; frontend uses them to create gaps.
    return [float(x) if np.isfinite(x) else float('nan') for x in a.tolist()]


@app.post('/ocv/curves', response_model=CurvesResponse)
def ocv_curves(req: CurvesRequest) -> CurvesResponse:
    catalog = load_pristine_profiles(PRISTINE_DIR)
    profile = catalog.profiles.get(req.pristine_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f'Unknown pristine_id: {req.pristine_id}')

    n = req.num_points or int((profile.grid or {}).get('num_points', 1001))
    files = profile.files or {}
    nmc_csv = resolve_profile_csv_path(API_ROOT, files.get('nmc_csv', 'api/data/halfcell/NMC.csv'))
    gra_csv = resolve_profile_csv_path(API_ROOT, files.get('gra_csv', 'api/data/halfcell/GRA.csv'))

    pristine = build_pristine_cell_from_csv(
        profile_id=profile.id,
        nmc_csv_path=nmc_csv,
        gra_csv_path=gra_csv,
        endpoints=profile.endpoints,
        num_points=n,
    )

    degraded_raw = calculate_degraded_ocv_raw(
        pristine=pristine,
        lli=req.lli,
        lam_pe=req.lam_pe,
        lam_ne=req.lam_ne,
        num_points=n,
    )

    x_plot = build_plot_axis(pristine.x_grid, degraded_raw, pad=req.include_plot_domain_padding)
    mapped = map_curves_to_plot_x(pristine=pristine, degraded=degraded_raw, x_plot=x_plot)

    def bundle(curve: dict[str, Any]) -> dict[str, Any]:
        return {
            'x': _np_to_list(x_plot),
            'ocv': _np_to_list(curve['ocv']),
            'mask_valid': [bool(v) for v in curve.get('mask_valid', [])]
            if curve.get('mask_valid') is not None
            else None,
        }

    pristine_out = {
        'cell': bundle(mapped['pristine']['cell']),
        'pe': bundle(mapped['pristine']['pe']),
        'ne': bundle(mapped['pristine']['ne']),
    }

    degraded_section = mapped['degraded']
    if not degraded_section.get('valid'):
        degraded_out: dict[str, Any] = {'valid': False}
    else:
        degraded_out = {
            'valid': True,
            'theta': degraded_section['theta'],
            'results': degraded_section['results'],
            'cell': bundle(degraded_section['cell']),
            'pe': bundle(degraded_section['pe']),
            'ne': bundle(degraded_section['ne']),
        }

    return CurvesResponse(
        pristine_id=profile.id,
        theta_deg={'LLI': req.lli, 'LAM_PE': req.lam_pe, 'LAM_NE': req.lam_ne},
        x_axis={
            'kind': 'pristine_normalized_capacity_units',
            'note': 'All curves are mapped onto pristine capacity units; axis range may extend beyond [0,1].',
        },
        pristine=pristine_out,
        degraded=degraded_out,
    )


@app.post('/pool/save')
def pool_save(req: PoolSaveRequest) -> dict[str, Any]:
    catalog = load_pristine_profiles(PRISTINE_DIR)
    profile = catalog.profiles.get(req.pristine_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f'Unknown pristine_id: {req.pristine_id}')

    POOL_DIR.mkdir(parents=True, exist_ok=True)
    ts = int(time.time())
    item_id = f'deg_{ts}'

    payload: dict[str, Any] = {
        'id': item_id,
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts)),
        'label': req.label,
        'pristine_id': profile.id,
        'pristine_snapshot': profile.model_dump() if req.include_pristine_snapshot else None,
        'degradation': {'LLI': req.lli, 'LAM_PE': req.lam_pe, 'LAM_NE': req.lam_ne},
        'solver': req.solver or {},
    }

    out_path = POOL_DIR / f'{item_id}.json'
    with out_path.open('w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)

    return {'ok': True, 'id': item_id}


@app.get('/pool/list', response_model=PoolListResponse)
def pool_list() -> PoolListResponse:
    if not POOL_DIR.exists():
        return PoolListResponse(items=[])

    items: list[PoolItemSummary] = []
    for path in sorted(POOL_DIR.glob('*.json'), reverse=True):
        try:
            with path.open('r', encoding='utf-8') as f:
                raw = json.load(f)
            deg = raw.get('degradation', {})
            items.append(
                PoolItemSummary(
                    id=str(raw.get('id')),
                    created_at=str(raw.get('created_at')),
                    label=raw.get('label'),
                    pristine_id=str(raw.get('pristine_id')),
                    lli=float(deg.get('LLI')),
                    lam_pe=float(deg.get('LAM_PE')),
                    lam_ne=float(deg.get('LAM_NE')),
                )
            )
        except Exception:
            continue

    return PoolListResponse(items=items)


@app.post('/pool/load')
def pool_load(payload: dict[str, Any]) -> dict[str, Any]:
    item_id = payload.get('id')
    if not item_id:
        raise HTTPException(status_code=400, detail='Missing id')
    path = POOL_DIR / f'{item_id}.json'
    if not path.exists():
        raise HTTPException(status_code=404, detail=f'No pool item: {item_id}')
    with path.open('r', encoding='utf-8') as f:
        raw = json.load(f)
    return raw


def _resolve_repo_path(p: str) -> Path:
    repo_root = API_ROOT.parent
    candidate = (repo_root / p).resolve() if not Path(p).is_absolute() else Path(p).resolve()
    if candidate != repo_root and repo_root not in candidate.parents:
        raise HTTPException(status_code=400, detail='mat_path must be within the repository')
    return candidate


@app.post('/diagnostics/estimate', response_model=DiagnosticsEstimateResponse)
def diagnostics_estimate(req: DiagnosticsEstimateRequest) -> DiagnosticsEstimateResponse:
    catalog = load_pristine_profiles(PRISTINE_DIR)
    profile = catalog.profiles.get(req.pristine_id)
    if profile is None:
        raise HTTPException(status_code=404, detail=f'Unknown pristine_id: {req.pristine_id}')

    n = req.num_points or int((profile.grid or {}).get('num_points', 1001))
    files = profile.files or {}
    nmc_csv = resolve_profile_csv_path(API_ROOT, files.get('nmc_csv', 'api/data/halfcell/NMC.csv'))
    gra_csv = resolve_profile_csv_path(API_ROOT, files.get('gra_csv', 'api/data/halfcell/GRA.csv'))

    pristine = build_pristine_cell_from_csv(
        profile_id=profile.id,
        nmc_csv_path=nmc_csv,
        gra_csv_path=gra_csv,
        endpoints=profile.endpoints,
        num_points=n,
    )

    if req.measured is not None:
        cap = np.asarray(req.measured.capacity, dtype=float)
        ocv = np.asarray(req.measured.ocv, dtype=float)
        measured = MeasuredOcv(capacity=cap, ocv=ocv)
        measured_src = {'kind': 'json', 'note': 'capacity is interpreted in degraded-capacity units (same as MATLAB synthetic_ocv.mat).'}
    elif req.mat_path is not None:
        mat_path = _resolve_repo_path(req.mat_path)
        measured = load_measured_ocv_from_mat(mat_path)
        measured_src = {'kind': 'mat', 'mat_path': str(req.mat_path)}
    else:
        raise HTTPException(status_code=400, detail='Provide either measured or mat_path')

    est = estimate_diagnostics_multistart(
        pristine=pristine,
        measured=measured,
        num_points=int(n),
        num_starts=int(req.num_starts),
        seed=req.seed,
        gradient_limit=float(req.gradient_limit),
        maxiter=int(req.maxiter),
    )
    if est is None:
        return DiagnosticsEstimateResponse(
            valid=False,
            pristine_id=profile.id,
            measured={
                **measured_src,
                'capacity': _np_to_list(measured.capacity),
                'ocv': _np_to_list(measured.ocv),
            },
            debug={'reason': 'optimizer_failed_or_no_flat_region'},
        )

    degraded_best = calculate_degraded_ocv_raw(
        pristine=pristine,
        lli=float(est.theta['LLI']),
        lam_pe=float(est.theta['LAM_PE']),
        lam_ne=float(est.theta['LAM_NE']),
        num_points=int(n),
    )

    predicted_pristine: dict[str, Any] | None = None
    if degraded_best is not None:
        x_pr = pristine.x_grid
        ocv_pr = np.full_like(x_pr, np.nan, dtype=float)
        mask = (x_pr >= degraded_best.x_cell_eoc) & (x_pr <= degraded_best.x_cell_eod)
        ocv_pr[mask] = np.interp(x_pr[mask], degraded_best.capacity_norm, degraded_best.ocv_cell)
        predicted_pristine = {
            'x': _np_to_list(x_pr),
            'ocv': _np_to_list(ocv_pr),
            'mask_valid': [bool(v) for v in mask.tolist()],
        }

    return DiagnosticsEstimateResponse(
        valid=True,
        pristine_id=profile.id,
        theta_deg=est.theta,
        rmse_v=float(est.rmse_v),
        measured={
            **measured_src,
            'capacity': _np_to_list(measured.capacity),
            'ocv': _np_to_list(measured.ocv),
            'mask_flat': [bool(v) for v in est.mask_flat.tolist()],
        },
        predicted={
            'x': _np_to_list(measured.capacity),
            'ocv': _np_to_list(est.predicted_ocv_at_measured),
            'mask_valid': [bool(v) for v in est.mask_flat.tolist()],
        },
        predicted_pristine=predicted_pristine,
        debug={'starts_tried': est.starts_tried, 'starts_success': est.starts_success, 'num_flat': int(np.sum(est.mask_flat))},
    )
