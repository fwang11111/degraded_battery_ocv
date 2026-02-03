export type PristineProfile = {
  id: string
  name: string
  files: Record<string, string>
  endpoints: Record<string, number>
  grid?: Record<string, number>
  notes?: string
  created_at?: string
}

type NumOrNull = number | null

type CurveBundle = {
  x: NumOrNull[]
  ocv: NumOrNull[]
  mask_valid?: boolean[] | null
}

export type CurvesResponse = {
  pristine_id: string
  theta_deg: Record<string, number>
  x_axis: {
    kind: string
    note?: string
    range?: [number, number]
    [k: string]: unknown
  }
  limits?: {
    v_max?: number
    v_min?: number
    [k: string]: unknown
  }
  pristine: {
    cell: CurveBundle
    pe: CurveBundle
    ne: CurveBundle
  }
  degraded:
    | { valid: false }
    | {
        valid: true
        theta: Record<string, number>
        results: Record<string, unknown>
        cell: CurveBundle
        pe: CurveBundle
        ne: CurveBundle
      }
}

const apiBase = String((import.meta as any).env?.VITE_API_BASE ?? '').trim() || 'http://localhost:8000'

export async function fetchPristineCatalog(): Promise<PristineProfile[]> {
  const res = await fetch(`${apiBase}/pristine/catalog`)
  if (!res.ok) throw new Error(`catalog failed: ${res.status}`)
  const data = (await res.json()) as { profiles: PristineProfile[] }
  return data.profiles
}

export async function createPristineCell(payload: {
  name: string
  pe_csv_text: string
  ne_csv_text: string
  endpoints: {
    sol_nmc_eoc: number
    sol_nmc_eod: number
    sol_gra_eoc: number
    sol_gra_eod: number
  }
}): Promise<{ ok: boolean; profile: PristineProfile }>
{
  const res = await fetch(`${apiBase}/pristine/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`pristine create failed: ${res.status} ${text}`)
  }
  return (await res.json()) as { ok: boolean; profile: PristineProfile }
}

export async function deletePristineCell(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${apiBase}/pristine/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`pristine delete failed: ${res.status} ${text}`)
  }
  return (await res.json()) as { ok: boolean }
}

export async function fetchSampleHalfcellCsvs(): Promise<{ nmc_csv_text: string; gra_csv_text: string }> {
  const res = await fetch(`${apiBase}/halfcell/sample`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`sample halfcell failed: ${res.status} ${text}`)
  }
  const data = (await res.json()) as {
    ok: boolean
    pe_csv_text?: string
    ne_csv_text?: string
    nmc_csv_text?: string
    gra_csv_text?: string
  }

  const pe = String(data.pe_csv_text ?? data.nmc_csv_text ?? '')
  const ne = String(data.ne_csv_text ?? data.gra_csv_text ?? '')
  if (!pe.trim() || !ne.trim()) throw new Error('sample halfcell returned empty CSVs')
  return { nmc_csv_text: pe, gra_csv_text: ne }
}

export async function fetchCurves(params: {
  pristine_id: string
  lli: number
  lam_pe: number
  lam_ne: number
  num_points?: number
}): Promise<CurvesResponse> {
  const res = await fetch(`${apiBase}/ocv/curves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pristine_id: params.pristine_id,
      lli: params.lli,
      lam_pe: params.lam_pe,
      lam_ne: params.lam_ne,
      num_points: params.num_points,
      include_plot_domain_padding: true,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`curves failed: ${res.status} ${text}`)
  }
  return (await res.json()) as CurvesResponse
}

export type PoolItemSummary = {
  id: string
  created_at: string
  label?: string | null
  pristine_id: string
  lli: number
  lam_pe: number
  lam_ne: number
}

export type DiagnosticsSampleResponse = {
  ok: boolean
  data: {
    capacity: number[]
    ocv: number[]
  }
}

export async function parseDiagnosticsMat(payload: { mat_base64: string }): Promise<DiagnosticsSampleResponse> {
  const res = await fetch(`${apiBase}/diagnostics/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`diagnostics parse failed: ${res.status} ${text}`)
  }
  return (await res.json()) as DiagnosticsSampleResponse
}

export type DiagnosticsMeasuredPayload = {
  capacity: number[]
  ocv: number[]
}

export type DiagnosticsEstimateResponse = {
  valid: boolean
  pristine_id: string
  theta_deg?: Record<string, number>
  rmse_v?: number
  measured?: {
    capacity: number[]
    ocv: number[]
    mask_flat?: boolean[]
    x_pristine?: number[]
    capacity_is_normalized?: boolean
    [k: string]: unknown
  }
  predicted?: {
    capacity: number[]
    ocv: NumOrNull[]
    mask_valid?: boolean[]
    [k: string]: unknown
  }
  predicted_pristine?: {
    x: NumOrNull[]
    ocv: NumOrNull[]
    [k: string]: unknown
  }
  debug?: Record<string, unknown>
}

export async function fetchDiagnosticsSample(): Promise<DiagnosticsSampleResponse> {
  const res = await fetch(`${apiBase}/diagnostics/sample`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`diagnostics sample failed: ${res.status} ${text}`)
  }
  return (await res.json()) as DiagnosticsSampleResponse
}

export async function estimateDiagnostics(payload: {
  pristine_id: string
  measured?: DiagnosticsMeasuredPayload
  use_sample?: boolean
  mat_base64?: string
  capacity_is_normalized?: boolean
  num_points?: number
  num_starts?: number
  gradient_limit?: number
  maxiter?: number
  seed?: number
}): Promise<DiagnosticsEstimateResponse> {
  const res = await fetch(`${apiBase}/diagnostics/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`diagnostics estimate failed: ${res.status} ${text}`)
  }
  return (await res.json()) as DiagnosticsEstimateResponse
}

export async function fetchPoolList(): Promise<PoolItemSummary[]> {
  const res = await fetch(`${apiBase}/pool/list`)
  if (!res.ok) throw new Error(`pool list failed: ${res.status}`)
  const data = (await res.json()) as { items: PoolItemSummary[] }
  return data.items
}

export async function saveToPool(payload: {
  pristine_id: string
  lli: number
  lam_pe: number
  lam_ne: number
  label?: string
}): Promise<{ ok: boolean; id: string }>
{
  const res = await fetch(`${apiBase}/pool/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pristine_id: payload.pristine_id,
      lli: payload.lli,
      lam_pe: payload.lam_pe,
      lam_ne: payload.lam_ne,
      label: payload.label,
      include_pristine_snapshot: true,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`pool save failed: ${res.status} ${text}`)
  }
  return (await res.json()) as { ok: boolean; id: string }
}

export async function deleteFromPool(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${apiBase}/pool/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`pool delete failed: ${res.status} ${text}`)
  }
  return (await res.json()) as { ok: boolean }
}
