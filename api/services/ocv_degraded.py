from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from scipy.interpolate import interp1d
from scipy.io import loadmat
from scipy.optimize import minimize
from scipy.optimize import fsolve

from api.services.ocv_pristine import PristineCell


@dataclass(frozen=True)
class DegradedOcvRaw:
    lli: float
    lam_pe: float
    lam_ne: float
    delta_x_eoc: float
    delta_x_eod: float
    x_cell_eoc: float
    x_cell_eod: float
    cell_capacity: float
    x_pe_eoc: float
    x_pe_eod: float
    x_ne_eoc: float
    x_ne_eod: float
    capacity_norm: np.ndarray
    ocv_cell: np.ndarray


def calculate_degraded_ocv_raw(
    *,
    pristine: PristineCell,
    lli: float,
    lam_pe: float,
    lam_ne: float,
    num_points: int,
) -> DegradedOcvRaw | None:
    if (1.0 - lam_pe) <= 0.0 or (1.0 - lam_ne) <= 0.0:
        return None

    v_max = pristine.v_max
    v_min = pristine.v_min

    def ocv_pe_from_x(x: float) -> float:
        return float(pristine.ocv_nmc_from_x(np.asarray([x], dtype=float), allow_extrapolation=True)[0])

    def ocv_ne_from_x(x: float) -> float:
        return float(pristine.ocv_gra_from_x(np.asarray([x], dtype=float), allow_extrapolation=True)[0])

    def equations(vars_: np.ndarray) -> np.ndarray:
        dx_eoc = float(vars_[0])
        dx_eod = float(vars_[1])

        eq_vmax = (
            v_max
            - ocv_pe_from_x(dx_eoc / (1.0 - lam_pe))
            + ocv_ne_from_x((dx_eoc + lli - lam_ne) / (1.0 - lam_ne))
        )
        eq_vmin = (
            v_min
            - ocv_pe_from_x((dx_eod + 1.0 - lli) / (1.0 - lam_pe))
            + ocv_ne_from_x((dx_eod + 1.0 - lam_ne) / (1.0 - lam_ne))
        )
        return np.array([eq_vmax, eq_vmin], dtype=float)

    x0 = np.array([0.0, 0.0], dtype=float)
    try:
        sol, _info, ier, _msg = fsolve(equations, x0=x0, full_output=True, xtol=1e-10, maxfev=2000)
    except Exception:
        return None

    if int(ier) <= 0:
        return None

    delta_x_eoc = float(sol[0])
    delta_x_eod = float(sol[1])

    x_pe_eoc = delta_x_eoc / (1.0 - lam_pe)
    x_pe_eod = (delta_x_eod + 1.0 - lli) / (1.0 - lam_pe)
    x_ne_eoc = (delta_x_eoc + lli - lam_ne) / (1.0 - lam_ne)
    x_ne_eod = (delta_x_eod + 1.0 - lam_ne) / (1.0 - lam_ne)

    x_cell_eoc = delta_x_eoc
    x_cell_eod = 1.0 - lli + delta_x_eod
    if not np.isfinite(x_cell_eoc) or not np.isfinite(x_cell_eod) or x_cell_eod <= x_cell_eoc:
        return None

    capacity_norm = np.linspace(x_cell_eoc, x_cell_eod, int(num_points))
    cell_capacity = float(x_cell_eod - x_cell_eoc)

    frac = (capacity_norm - x_cell_eoc) / (x_cell_eod - x_cell_eoc)
    x_pe = x_pe_eoc + frac * (x_pe_eod - x_pe_eoc)
    x_ne = x_ne_eoc + frac * (x_ne_eod - x_ne_eoc)

    ocv_pe = pristine.ocv_nmc_from_x(x_pe, allow_extrapolation=True)
    ocv_ne = pristine.ocv_gra_from_x(x_ne, allow_extrapolation=True)
    ocv_cell = ocv_pe - ocv_ne

    return DegradedOcvRaw(
        lli=lli,
        lam_pe=lam_pe,
        lam_ne=lam_ne,
        delta_x_eoc=delta_x_eoc,
        delta_x_eod=delta_x_eod,
        x_cell_eoc=x_cell_eoc,
        x_cell_eod=x_cell_eod,
        cell_capacity=cell_capacity,
        x_pe_eoc=float(x_pe_eoc),
        x_pe_eod=float(x_pe_eod),
        x_ne_eoc=float(x_ne_eoc),
        x_ne_eod=float(x_ne_eod),
        capacity_norm=capacity_norm,
        ocv_cell=ocv_cell,
    )


def build_plot_axis(pristine_x: np.ndarray, degraded: DegradedOcvRaw | None, *, pad: bool) -> np.ndarray:
    x_min = float(np.nanmin(pristine_x))
    x_max = float(np.nanmax(pristine_x))
    if degraded is not None:
        x_min = min(x_min, float(degraded.x_cell_eoc))
        x_max = max(x_max, float(degraded.x_cell_eod))

    if not pad:
        return np.linspace(x_min, x_max, pristine_x.size)

    span = max(1e-9, x_max - x_min)
    pad_amt = 0.02 * span
    return np.linspace(x_min - pad_amt, x_max + pad_amt, pristine_x.size)


def map_curves_to_plot_x(
    *,
    pristine: PristineCell,
    degraded: DegradedOcvRaw | None,
    x_plot: np.ndarray,
) -> dict[str, Any]:
    out: dict[str, Any] = {}

    # Pristine curves are only defined on [0,1] in pristine-x units.
    mask_pristine = (x_plot >= 0.0) & (x_plot <= 1.0)
    ocv_cell_pr = np.full_like(x_plot, np.nan, dtype=float)
    ocv_pe_pr = np.full_like(x_plot, np.nan, dtype=float)
    ocv_ne_pr = np.full_like(x_plot, np.nan, dtype=float)

    ocv_cell_pr[mask_pristine] = np.interp(x_plot[mask_pristine], pristine.x_grid, pristine.ocv_cell)
    ocv_pe_pr[mask_pristine] = np.interp(x_plot[mask_pristine], pristine.x_grid, pristine.ocv_nmc)
    ocv_ne_pr[mask_pristine] = np.interp(x_plot[mask_pristine], pristine.x_grid, pristine.ocv_gra)

    out['pristine'] = {
        'cell': {'ocv': ocv_cell_pr, 'mask_valid': mask_pristine},
        'pe': {'ocv': ocv_pe_pr, 'mask_valid': mask_pristine},
        'ne': {'ocv': ocv_ne_pr, 'mask_valid': mask_pristine},
    }

    if degraded is None:
        out['degraded'] = {'valid': False}
        return out

    # Degraded full-cell OCV is defined on capacity_norm (in pristine-x units).
    mask_deg_cell = (x_plot >= degraded.x_cell_eoc) & (x_plot <= degraded.x_cell_eod)
    ocv_cell_deg = np.full_like(x_plot, np.nan, dtype=float)
    ocv_cell_deg[mask_deg_cell] = np.interp(x_plot[mask_deg_cell], degraded.capacity_norm, degraded.ocv_cell)

    # Half-cell curves: map x_plot within degraded window to electrode x by linear fraction.
    frac = (x_plot - degraded.x_cell_eoc) / (degraded.x_cell_eod - degraded.x_cell_eoc)
    x_pe = degraded.x_pe_eoc + frac * (degraded.x_pe_eod - degraded.x_pe_eoc)
    x_ne = degraded.x_ne_eoc + frac * (degraded.x_ne_eod - degraded.x_ne_eoc)

    # Compute OCV with extrapolation allowed for math...
    sol_pe = pristine.sol_nmc_from_x(np.asarray(x_pe, dtype=float))
    sol_ne = pristine.sol_gra_from_x(np.asarray(x_ne, dtype=float))
    ocv_pe_all = pristine.nmc.eval_ocv(sol_pe, allow_extrapolation=True)
    ocv_ne_all = pristine.gra.eval_ocv(sol_ne, allow_extrapolation=True)

    # ...but do not plot extrapolated regions.
    mask_pe_domain = (sol_pe >= pristine.nmc.sol_min) & (sol_pe <= pristine.nmc.sol_max) & mask_deg_cell
    mask_ne_domain = (sol_ne >= pristine.gra.sol_min) & (sol_ne <= pristine.gra.sol_max) & mask_deg_cell

    ocv_pe_deg = np.full_like(x_plot, np.nan, dtype=float)
    ocv_ne_deg = np.full_like(x_plot, np.nan, dtype=float)
    ocv_pe_deg[mask_pe_domain] = ocv_pe_all[mask_pe_domain]
    ocv_ne_deg[mask_ne_domain] = ocv_ne_all[mask_ne_domain]

    out['degraded'] = {
        'valid': True,
        'theta': {'LLI': degraded.lli, 'LAM_PE': degraded.lam_pe, 'LAM_NE': degraded.lam_ne},
        'results': {
            'delta_x_eoc': degraded.delta_x_eoc,
            'delta_x_eod': degraded.delta_x_eod,
            'x_cell_eoc': degraded.x_cell_eoc,
            'x_cell_eod': degraded.x_cell_eod,
            'cell_capacity': degraded.cell_capacity,
            'endpoints': {
                'x_pe_eoc': degraded.x_pe_eoc,
                'x_pe_eod': degraded.x_pe_eod,
                'x_ne_eoc': degraded.x_ne_eoc,
                'x_ne_eod': degraded.x_ne_eod,
            },
        },
        'cell': {'ocv': ocv_cell_deg, 'mask_valid': mask_deg_cell},
        'pe': {'ocv': ocv_pe_deg, 'mask_valid': mask_pe_domain},
        'ne': {'ocv': ocv_ne_deg, 'mask_valid': mask_ne_domain},
    }

    return out


@dataclass(frozen=True)
class MeasuredOcv:
    capacity: np.ndarray
    ocv: np.ndarray


def load_measured_ocv_from_mat(mat_path: Path) -> MeasuredOcv:
    raw = loadmat(mat_path, squeeze_me=True)
    if 'data' not in raw:
        raise ValueError('MAT file missing "data"')

    data = raw['data']

    def _get_field(obj: Any, name: str) -> Any:
        if isinstance(obj, dict):
            return obj.get(name)
        if hasattr(obj, name):
            return getattr(obj, name)
        try:
            return obj[name]
        except Exception as e:
            raise KeyError(name) from e

    cap = _get_field(data, 'capacity')
    ocv = _get_field(data, 'ocv')

    cap_a = np.asarray(cap, dtype=float).reshape(-1)
    ocv_a = np.asarray(ocv, dtype=float).reshape(-1)
    if cap_a.size != ocv_a.size:
        raise ValueError('capacity and ocv arrays must have the same length')

    mask = np.isfinite(cap_a) & np.isfinite(ocv_a)
    cap_a = cap_a[mask]
    ocv_a = ocv_a[mask]
    if cap_a.size < 3:
        raise ValueError('Measured data must have at least 3 finite points')

    idx = np.argsort(cap_a)
    cap_a = cap_a[idx]
    ocv_a = ocv_a[idx]
    return MeasuredOcv(capacity=cap_a, ocv=ocv_a)


def _gradient_mask(capacity: np.ndarray, ocv: np.ndarray, *, gradient_limit: float) -> np.ndarray:
    soc_diff = np.abs(np.diff(capacity * 100.0))
    ocv_diff = np.abs(np.diff(ocv))
    denom = np.maximum(1e-12, soc_diff)
    grad = ocv_diff / denom
    return np.concatenate([grad < float(gradient_limit), np.array([False], dtype=bool)])


@dataclass(frozen=True)
class DiagnosticsEstimate:
    theta: dict[str, float]
    rmse_v: float
    mask_flat: np.ndarray
    predicted_ocv_at_measured: np.ndarray
    starts_tried: int
    starts_success: int


def estimate_diagnostics_multistart(
    *,
    pristine: PristineCell,
    measured: MeasuredOcv,
    num_points: int,
    num_starts: int,
    seed: int | None,
    gradient_limit: float,
    maxiter: int,
) -> DiagnosticsEstimate | None:
    cap = np.asarray(measured.capacity, dtype=float).reshape(-1)
    ocv = np.asarray(measured.ocv, dtype=float).reshape(-1)
    if cap.size < 3:
        return None

    mask_flat = _gradient_mask(cap, ocv, gradient_limit=gradient_limit)
    if not bool(np.any(mask_flat)):
        return None

    bounds = [(0.0, 1.0), (0.0, 1.0), (0.0, 1.0)]
    rng = np.random.default_rng(seed)
    starts = rng.random((int(num_starts), 3), dtype=float)

    penalty = 1e6

    def objective(theta: np.ndarray) -> float:
        lli = float(theta[0])
        lam_pe = float(theta[1])
        lam_ne = float(theta[2])
        degraded = calculate_degraded_ocv_raw(
            pristine=pristine,
            lli=lli,
            lam_pe=lam_pe,
            lam_ne=lam_ne,
            num_points=int(num_points),
        )
        if degraded is None or not np.isfinite(degraded.cell_capacity) or degraded.cell_capacity <= 0.0:
            return penalty

        pred_capacity = degraded.capacity_norm - float(degraded.x_cell_eoc)
        pred_ocv = degraded.ocv_cell
        if pred_capacity.size < 2:
            return penalty

        try:
            f = interp1d(pred_capacity, pred_ocv, kind='linear', fill_value='extrapolate', assume_sorted=True)
            pred_at_meas = np.asarray(f(cap), dtype=float)
        except Exception:
            return penalty

        err = pred_at_meas[mask_flat] - ocv[mask_flat]
        rmse = float(np.sqrt(np.mean(err * err)))
        if not np.isfinite(rmse):
            return penalty
        return rmse

    best_x: np.ndarray | None = None
    best_rmse = float('inf')
    starts_success = 0

    for x0 in starts:
        try:
            res = minimize(
                objective,
                x0=np.asarray(x0, dtype=float),
                bounds=bounds,
                method='SLSQP',
                options={'maxiter': int(maxiter), 'ftol': 1e-12, 'disp': False},
            )
        except Exception:
            continue

        if res.fun is None:
            continue

        fun = float(res.fun)
        if np.isfinite(fun):
            starts_success += 1
            if fun < best_rmse:
                best_rmse = fun
                best_x = np.asarray(res.x, dtype=float)

    if best_x is None or not np.isfinite(best_rmse):
        return None

    degraded_best = calculate_degraded_ocv_raw(
        pristine=pristine,
        lli=float(best_x[0]),
        lam_pe=float(best_x[1]),
        lam_ne=float(best_x[2]),
        num_points=int(num_points),
    )
    if degraded_best is None:
        return None

    pred_capacity = degraded_best.capacity_norm - float(degraded_best.x_cell_eoc)
    f = interp1d(pred_capacity, degraded_best.ocv_cell, kind='linear', fill_value='extrapolate', assume_sorted=True)
    pred_at_meas = np.asarray(f(cap), dtype=float)

    return DiagnosticsEstimate(
        theta={'LLI': float(best_x[0]), 'LAM_PE': float(best_x[1]), 'LAM_NE': float(best_x[2])},
        rmse_v=float(best_rmse),
        mask_flat=mask_flat,
        predicted_ocv_at_measured=pred_at_meas,
        starts_tried=int(num_starts),
        starts_success=int(starts_success),
    )
