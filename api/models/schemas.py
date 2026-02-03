from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PristineProfile(BaseModel):
    id: str
    name: str
    files: dict[str, str]
    endpoints: dict[str, float]
    grid: dict[str, int] | None = None
    notes: str | None = None
    created_at: str | None = None


class CurvesRequest(BaseModel):
    pristine_id: str
    lli: float = Field(ge=0.0)
    lam_pe: float = Field(ge=0.0)
    lam_ne: float = Field(ge=0.0)
    num_points: int | None = Field(default=None, ge=101, le=5001)
    include_plot_domain_padding: bool = True


class CurveBundle(BaseModel):
    x: list[float]
    ocv: list[float]
    mask_valid: list[bool] | None = None


class CurvesResponse(BaseModel):
    pristine_id: str
    theta_deg: dict[str, float]
    x_axis: dict[str, Any]
    pristine: dict[str, CurveBundle]
    degraded: dict[str, Any]


class PoolSaveRequest(BaseModel):
    pristine_id: str
    lli: float
    lam_pe: float
    lam_ne: float
    label: str | None = None
    include_pristine_snapshot: bool = True
    solver: dict[str, Any] | None = None


class PoolItemSummary(BaseModel):
    id: str
    created_at: str
    label: str | None = None
    pristine_id: str
    lli: float
    lam_pe: float
    lam_ne: float


class PoolListResponse(BaseModel):
    items: list[PoolItemSummary]


class MeasuredOcvPayload(BaseModel):
    capacity: list[float]
    ocv: list[float]


class DiagnosticsEstimateRequest(BaseModel):
    pristine_id: str
    measured: MeasuredOcvPayload | None = None
    mat_path: str | None = None
    num_starts: int = Field(default=100, ge=1, le=5000)
    seed: int | None = None
    num_points: int | None = Field(default=None, ge=101, le=5001)
    gradient_limit: float = Field(default=0.1, gt=0.0)
    maxiter: int = Field(default=200, ge=10, le=20000)


class DiagnosticsEstimateResponse(BaseModel):
    valid: bool
    pristine_id: str
    theta_deg: dict[str, float] | None = None
    rmse_v: float | None = None
    measured: dict[str, Any] | None = None
    predicted: CurveBundle | None = None
    predicted_pristine: CurveBundle | None = None
    debug: dict[str, Any] | None = None
