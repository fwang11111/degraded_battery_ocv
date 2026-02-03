from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.interpolate import PchipInterpolator


@dataclass(frozen=True)
class HalfCellCurve:
    sol: np.ndarray
    ocv: np.ndarray
    interp_extrapolate: PchipInterpolator
    sol_min: float
    sol_max: float

    def eval_ocv(self, sol_query: np.ndarray, *, allow_extrapolation: bool) -> np.ndarray:
        y = self.interp_extrapolate(sol_query)
        if allow_extrapolation:
            return y
        mask = (sol_query >= self.sol_min) & (sol_query <= self.sol_max)
        out = np.full_like(y, np.nan, dtype=float)
        out[mask] = y[mask]
        return out


@dataclass(frozen=True)
class PristineCell:
    profile_id: str
    nmc: HalfCellCurve
    gra: HalfCellCurve
    endpoints: dict[str, float]
    x_grid: np.ndarray
    ocv_nmc: np.ndarray
    ocv_gra: np.ndarray
    ocv_cell: np.ndarray
    v_max: float
    v_min: float

    def sol_nmc_from_x(self, x: np.ndarray) -> np.ndarray:
        eoc = self.endpoints['sol_nmc_eoc']
        eod = self.endpoints['sol_nmc_eod']
        return eoc + x * (eod - eoc)

    def sol_gra_from_x(self, x: np.ndarray) -> np.ndarray:
        eoc = self.endpoints['sol_gra_eoc']
        eod = self.endpoints['sol_gra_eod']
        return eoc + x * (eod - eoc)

    def ocv_nmc_from_x(self, x: np.ndarray, *, allow_extrapolation: bool) -> np.ndarray:
        return self.nmc.eval_ocv(self.sol_nmc_from_x(x), allow_extrapolation=allow_extrapolation)

    def ocv_gra_from_x(self, x: np.ndarray, *, allow_extrapolation: bool) -> np.ndarray:
        return self.gra.eval_ocv(self.sol_gra_from_x(x), allow_extrapolation=allow_extrapolation)


def _load_half_cell_csv(csv_path: Path) -> tuple[np.ndarray, np.ndarray]:
    raw = np.genfromtxt(csv_path, delimiter=',', dtype=float)
    if raw.ndim != 2 or raw.shape[1] < 2:
        raise ValueError(f'CSV "{csv_path}" must have at least 2 columns: SOL, OCV')

    sol = raw[:, 0]
    ocv = raw[:, 1]
    mask = np.isfinite(sol) & np.isfinite(ocv)
    sol = sol[mask]
    ocv = ocv[mask]
    if sol.size == 0:
        raise ValueError(f'CSV "{csv_path}" contains no numeric SOL/OCV data')

    idx = np.argsort(sol)
    sol_sorted = sol[idx]
    ocv_sorted = ocv[idx]
    sol_unique, inv = np.unique(sol_sorted, return_inverse=True)

    if sol_unique.size != sol_sorted.size:
        sums = np.zeros(sol_unique.shape, dtype=float)
        counts = np.zeros(sol_unique.shape, dtype=float)
        np.add.at(sums, inv, ocv_sorted)
        np.add.at(counts, inv, 1.0)
        ocv_unique = sums / counts
    else:
        ocv_unique = ocv_sorted

    if sol_unique.size < 2:
        raise ValueError(f'CSV "{csv_path}" must contain at least 2 unique SOL points')

    return sol_unique.astype(float), np.asarray(ocv_unique, dtype=float)


def build_pristine_cell_from_csv(
    *,
    profile_id: str,
    nmc_csv_path: Path,
    gra_csv_path: Path,
    endpoints: dict[str, float],
    num_points: int = 1001,
) -> PristineCell:
    sol_nmc, ocv_nmc = _load_half_cell_csv(nmc_csv_path)
    sol_gra, ocv_gra = _load_half_cell_csv(gra_csv_path)

    interp_nmc = PchipInterpolator(sol_nmc, ocv_nmc, extrapolate=True)
    interp_gra = PchipInterpolator(sol_gra, ocv_gra, extrapolate=True)

    nmc_curve = HalfCellCurve(
        sol=sol_nmc,
        ocv=ocv_nmc,
        interp_extrapolate=interp_nmc,
        sol_min=float(sol_nmc.min()),
        sol_max=float(sol_nmc.max()),
    )
    gra_curve = HalfCellCurve(
        sol=sol_gra,
        ocv=ocv_gra,
        interp_extrapolate=interp_gra,
        sol_min=float(sol_gra.min()),
        sol_max=float(sol_gra.max()),
    )

    x_grid = np.linspace(0.0, 1.0, int(num_points))

    sol_nmc_grid = endpoints['sol_nmc_eoc'] + x_grid * (endpoints['sol_nmc_eod'] - endpoints['sol_nmc_eoc'])
    sol_gra_grid = endpoints['sol_gra_eoc'] + x_grid * (endpoints['sol_gra_eod'] - endpoints['sol_gra_eoc'])

    ocv_nmc_grid = nmc_curve.eval_ocv(sol_nmc_grid, allow_extrapolation=True)
    ocv_gra_grid = gra_curve.eval_ocv(sol_gra_grid, allow_extrapolation=True)
    ocv_cell_grid = ocv_nmc_grid - ocv_gra_grid

    v_max = float(ocv_cell_grid[0])
    v_min = float(ocv_cell_grid[-1])

    return PristineCell(
        profile_id=profile_id,
        nmc=nmc_curve,
        gra=gra_curve,
        endpoints=endpoints,
        x_grid=x_grid,
        ocv_nmc=ocv_nmc_grid,
        ocv_gra=ocv_gra_grid,
        ocv_cell=ocv_cell_grid,
        v_max=v_max,
        v_min=v_min,
    )
