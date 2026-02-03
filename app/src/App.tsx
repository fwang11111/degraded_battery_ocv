import { useEffect, useMemo, useRef, useState } from 'react'
import Plot from 'react-plotly.js'

import './App.css'
import {
  createPristineCell,
  deletePristineCell,
  estimateDiagnostics,
  fetchDiagnosticsSample,
  parseDiagnosticsMat,
  fetchSampleHalfcellCsvs,
  fetchCurves,
  deleteFromPool,
  fetchPoolList,
  fetchPristineCatalog,
  saveToPool,
  type CurvesResponse,
  type DiagnosticsEstimateResponse,
  type DiagnosticsMeasuredPayload,
  type PoolItemSummary,
  type PristineProfile,
} from './api/client'

type TabKey = 'pristine' | 'degradation' | 'diagnostics' | 'analysis'

type NumOrNull = number | null

type DegradedInfo = {
  xCellEoc: number
  xCellEod: number
  cellCapacity: number
}

function parseTwoColCsv(text: string): DiagnosticsMeasuredPayload {
  const cap: number[] = []
  const ocv: number[] = []

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  for (const line of lines) {
    const parts = line.split(',')
    if (parts.length < 2) continue
    const a = Number(parts[0])
    const b = Number(parts[1])
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    cap.push(a)
    ocv.push(b)
  }

  if (cap.length < 3) throw new Error('CSV must contain at least 3 numeric rows (capacity, ocv)')

  // sort by capacity
  const idx = cap.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0])
  const capS = idx.map(([, i]) => cap[i])
  const ocvS = idx.map(([, i]) => ocv[i])
  return { capacity: capS, ocv: ocvS }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('Failed to read file'))
    r.onload = () => {
      const s = String(r.result ?? '')
      const parts = s.split(',')
      resolve(parts.length >= 2 ? parts[1] : '')
    }
    r.readAsDataURL(file)
  })
}

function clamp(v: number, lo: number, hi: number) {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function interpAt(x: NumOrNull[], y: NumOrNull[], x0: number): number | null {
  const n = Math.min(x.length, y.length)
  if (n < 2) return null

  let lo = 0
  let hi = n - 2
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const xm = x[mid]
    const xp = x[mid + 1]
    if (!isNum(xm) || !isNum(xp)) return null
    if (x0 < xm) hi = mid - 1
    else if (x0 > xp) lo = mid + 1
    else {
      lo = mid
      break
    }
  }
  const i = Math.min(Math.max(lo, 0), n - 2)
  const x1 = x[i]
  const x2 = x[i + 1]
  const y1 = y[i]
  const y2 = y[i + 1]

  if (isNum(x1) && isNum(x2) && isNum(y1) && isNum(y2) && x2 !== x1) {
    const t = (x0 - x1) / (x2 - x1)
    return y1 + t * (y2 - y1)
  }
  return null
}

function vLine(x: number, color: string, dash: 'dash' | 'dot' | 'solid' = 'dash') {
  return {
    type: 'line',
    xref: 'x',
    yref: 'paper',
    x0: x,
    x1: x,
    y0: 0,
    y1: 1,
    line: { color, width: 1, dash },
  }
}

function fmtPct(x: number) {
  return `${(x * 100).toFixed(1)}%`
}

function fmtNum(x: number, digits = 4) {
  return Number.isFinite(x) ? x.toFixed(digits) : 'n/a'
}

function parseLooseNumberText(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  // Allow partial decimals like "0." while typing.
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

function downloadTextFile(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function buildTwoColCsv(rows: Array<[number, number]>, header: [string, string] = ['capacity', 'voltage']): string {
  const out: string[] = [`${header[0]},${header[1]}`]
  for (const [a, b] of rows) out.push(`${a},${b}`)
  return `${out.join('\n')}\n`
}
export default function App() {
  const apiBase = String((import.meta as any).env?.VITE_API_BASE ?? '').trim() || 'http://localhost:8000'

  const [tab, setTab] = useState<TabKey>('pristine')

  const [profiles, setProfiles] = useState<PristineProfile[]>([])
  const [pristineId, setPristineId] = useState('')

  const [selectedPristineId, setSelectedPristineId] = useState('')
  const [pristineCurves, setPristineCurves] = useState<CurvesResponse | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createNmcFile, setCreateNmcFile] = useState<File | null>(null)
  const [createGraFile, setCreateGraFile] = useState<File | null>(null)
  const [createNmcText, setCreateNmcText] = useState('')
  const [createGraText, setCreateGraText] = useState('')
  const [createSolNmcEoc, setCreateSolNmcEoc] = useState('')
  const [createSolNmcEod, setCreateSolNmcEod] = useState('')
  const [createSolGraEoc, setCreateSolGraEoc] = useState('')
  const [createSolGraEod, setCreateSolGraEod] = useState('')
  const [creatingPristine, setCreatingPristine] = useState(false)

  const [lli, setLli] = useState(0)
  const [lamPe, setLamPe] = useState(0)
  const [lamNe, setLamNe] = useState(0)

  const [lliPctText, setLliPctText] = useState('0.0')
  const [lamPePctText, setLamPePctText] = useState('0.0')
  const [lamNePctText, setLamNePctText] = useState('0.0')

  const [curves, setCurves] = useState<CurvesResponse | null>(null)
  const [poolItems, setPoolItems] = useState<PoolItemSummary[]>([])

  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [diagnosticsMeasured, setDiagnosticsMeasured] = useState<DiagnosticsMeasuredPayload | null>(null)
  const [diagnosticsMatFile, setDiagnosticsMatFile] = useState<File | null>(null)
  const [diagnosticsMatBase64, setDiagnosticsMatBase64] = useState<string | null>(null)
  const [diagnosticsResult, setDiagnosticsResult] = useState<DiagnosticsEstimateResponse | null>(null)
  const [diagnosticsLoadingSample, setDiagnosticsLoadingSample] = useState(false)
  const [diagnosticsParsingFile, setDiagnosticsParsingFile] = useState(false)
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false)
  const [diagnosticsFileInputKey, setDiagnosticsFileInputKey] = useState(0)
  const [diagnosticsNumStarts, setDiagnosticsNumStarts] = useState(100)
  const [diagnosticsMaxIter, setDiagnosticsMaxIter] = useState(200)
  const [diagnosticsGradientLimit, setDiagnosticsGradientLimit] = useState(0.1)
  const [diagnosticsSeed, setDiagnosticsSeed] = useState(0)

  const [diagnosticsCurves, setDiagnosticsCurves] = useState<CurvesResponse | null>(null)
  const [diagnosticsCurvesLoading, setDiagnosticsCurvesLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [analysisResults, setAnalysisResults] = useState<Array<{ id: string; label: string; curves: CurvesResponse | null }>>([])
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [selectedPoolIds, setSelectedPoolIds] = useState<Set<string>>(new Set())
  const poolCurvesCache = useRef<Map<string, CurvesResponse | null>>(new Map())
  const [analysisSelfNormalize, setAnalysisSelfNormalize] = useState(false)
  const [analysisViewTab, setAnalysisViewTab] = useState<'voltage' | 'dq' | 'dqdv'>('voltage')
  const [analysisDqDvWindowV, setAnalysisDqDvWindowV] = useState(0.005)
  const [analysisDqDvWindowText, setAnalysisDqDvWindowText] = useState('0.005')

  const [analysisTruncateV, setAnalysisTruncateV] = useState(false)
  const [analysisVMaxText, setAnalysisVMaxText] = useState('4.0')
  const [analysisVMinText, setAnalysisVMinText] = useState('3.5')

  const [analysisPristineId, setAnalysisPristineId] = useState('')
  const pristineCurvesCache = useRef<Map<string, CurvesResponse | null>>(new Map())
  const [analysisPristineResults, setAnalysisPristineResults] = useState<Array<{ id: string; label: string; curves: CurvesResponse | null }>>([])

  const lastReqId = useRef(0)

  const pristineLimitsById = useRef<Record<string, { v_max?: number; v_min?: number }>>({})

  async function refreshProfiles() {
    const ps = await fetchPristineCatalog()
    setProfiles(ps)
    if (!pristineId && ps.length > 0) setPristineId(ps[0].id)
    if (!selectedPristineId && ps.length > 0) setSelectedPristineId(ps[0].id)
  }

  async function onDeletePristine(id: string) {
    try {
      await deletePristineCell(id)
      const ps = await fetchPristineCatalog()
      setProfiles(ps)

      // Keep selections stable; if we deleted the selected item, pick the first remaining.
      if (pristineId === id) setPristineId(ps.length > 0 ? ps[0].id : '')
      if (selectedPristineId === id) setSelectedPristineId(ps.length > 0 ? ps[0].id : '')

      // Clear preview if nothing remains.
      if (ps.length === 0) setPristineCurves(null)
    } catch (e) {
      setError(String((e as any)?.message ?? e))
    }
  }

  useEffect(() => {
    let mounted = true

    refreshProfiles().catch((e) => {
      if (!mounted) return
      setError(String(e?.message ?? e))
    })

    fetchPoolList()
      .then((items) => {
        if (!mounted) return
        setPoolItems(items)
      })
      .catch(() => {
        // ignore
      })

    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!pristineId) return
    if (tab !== 'degradation') return

    const reqId = ++lastReqId.current
    setLoading(true)
    setError(null)

    const handle = window.setTimeout(() => {
      fetchCurves({ pristine_id: pristineId, lli, lam_pe: lamPe, lam_ne: lamNe })
        .then((resp) => {
          if (reqId !== lastReqId.current) return
          setCurves(resp)
        })
        .catch((e) => {
          if (reqId !== lastReqId.current) return
          setError(String(e?.message ?? e))
          setCurves(null)
        })
        .finally(() => {
          if (reqId !== lastReqId.current) return
          setLoading(false)
        })
    }, 120)

    return () => window.clearTimeout(handle)
  }, [tab, pristineId, lli, lamPe, lamNe])

  useEffect(() => {
    if (!selectedPristineId) return
    if (tab !== 'pristine') return

    const reqId = ++lastReqId.current
    setLoading(true)
    setError(null)

    const handle = window.setTimeout(() => {
      fetchCurves({ pristine_id: selectedPristineId, lli: 0, lam_pe: 0, lam_ne: 0 })
        .then((resp) => {
          if (reqId !== lastReqId.current) return
          setPristineCurves(resp)

          // cache limits for list display
          pristineLimitsById.current[selectedPristineId] = {
            v_max: (resp.limits as any)?.v_max,
            v_min: (resp.limits as any)?.v_min,
          }
        })
        .catch((e) => {
          if (reqId !== lastReqId.current) return
          setError(String(e?.message ?? e))
          setPristineCurves(null)
        })
        .finally(() => {
          if (reqId !== lastReqId.current) return
          setLoading(false)
        })
    }, 120)

    return () => window.clearTimeout(handle)
  }, [tab, selectedPristineId])

  const degradedInfo: DegradedInfo | null = useMemo(() => {
    if (!curves?.degraded?.valid) return null
    const xCellEoc = Number((curves.degraded.results as any).x_cell_eoc)
    const xCellEod = Number((curves.degraded.results as any).x_cell_eod)
    const cap = xCellEod - xCellEoc
    if (!Number.isFinite(xCellEoc) || !Number.isFinite(xCellEod) || !Number.isFinite(cap)) return null
    return { xCellEoc, xCellEod, cellCapacity: cap }
  }, [curves])

  const diagnosticsDegradedInfo: DegradedInfo | null = useMemo(() => {
    if (!diagnosticsCurves?.degraded?.valid) return null
    const xCellEoc = Number((diagnosticsCurves.degraded.results as any).x_cell_eoc)
    const xCellEod = Number((diagnosticsCurves.degraded.results as any).x_cell_eod)
    const cap = xCellEod - xCellEoc
    if (!Number.isFinite(xCellEoc) || !Number.isFinite(xCellEod) || !Number.isFinite(cap)) return null
    return { xCellEoc, xCellEod, cellCapacity: cap }
  }, [diagnosticsCurves])

  const mainPlot = useMemo(() => {
    if (!curves) return null

    const xRange = Array.isArray(curves.x_axis?.range) && curves.x_axis.range.length === 2 ? curves.x_axis.range : null
    const xMin = xRange ? xRange[0] : undefined
    const xMax = xRange ? xRange[1] : undefined

    const vMax = isNum(curves.limits?.v_max) ? Number(curves.limits?.v_max) : null
    const vMin = isNum(curves.limits?.v_min) ? Number(curves.limits?.v_min) : null

    const traces: any[] = []

    const addCurve = (
      name: string,
      x: NumOrNull[],
      y: NumOrNull[],
      color: string,
      dash?: 'solid' | 'dot' | 'dash',
    ) => {
      traces.push({
        x,
        y,
        type: 'scatter',
        mode: 'lines',
        name,
        line: { color, width: 2, dash: dash ?? 'solid' },
      })
    }

    addCurve('PE (Pristine)', curves.pristine.pe.x, curves.pristine.pe.ocv, '#2563eb', 'solid')
    addCurve('NE (Pristine)', curves.pristine.ne.x, curves.pristine.ne.ocv, '#dc2626', 'solid')
    addCurve('Cell (Pristine)', curves.pristine.cell.x, curves.pristine.cell.ocv, '#0f172a', 'solid')

    if (curves.degraded.valid) {
      addCurve('PE (Degraded)', curves.degraded.pe.x, curves.degraded.pe.ocv, '#2563eb', 'dot')
      addCurve('NE (Degraded)', curves.degraded.ne.x, curves.degraded.ne.ocv, '#dc2626', 'dot')
      addCurve('Cell (Degraded)', curves.degraded.cell.x, curves.degraded.cell.ocv, '#0f172a', 'dot')
    }

    if (isNum(xMin) && isNum(xMax) && vMax !== null) {
      traces.push({
        x: [xMin, xMax],
        y: [vMax, vMax],
        type: 'scatter',
        mode: 'lines',
        name: `v_max (${vMax.toFixed(2)}V)`,
        line: { color: 'rgba(100,116,139,0.8)', width: 1, dash: 'dot' },
        hoverinfo: 'skip',
      })
    }
    if (isNum(xMin) && isNum(xMax) && vMin !== null) {
      traces.push({
        x: [xMin, xMax],
        y: [vMin, vMin],
        type: 'scatter',
        mode: 'lines',
        name: `v_min (${vMin.toFixed(2)}V)`,
        line: { color: 'rgba(100,116,139,0.8)', width: 1, dash: 'dot' },
        hoverinfo: 'skip',
      })
    }

    // Endpoint markers for cell curve.
    const yPr0 = interpAt(curves.pristine.cell.x, curves.pristine.cell.ocv, 0)
    const yPr1 = interpAt(curves.pristine.cell.x, curves.pristine.cell.ocv, 1)
    if (yPr0 !== null && yPr1 !== null) {
      traces.push({
        x: [0, 1],
        y: [yPr0, yPr1],
        type: 'scatter',
        mode: 'markers',
        showlegend: false,
        marker: { size: 10, color: '#0f172a', line: { width: 1, color: '#fff' } },
        hoverinfo: 'skip',
      })
    }

    // Endpoint markers for half-cells (pristine).
    const yPe0 = interpAt(curves.pristine.pe.x, curves.pristine.pe.ocv, 0)
    const yPe1 = interpAt(curves.pristine.pe.x, curves.pristine.pe.ocv, 1)
    if (yPe0 !== null && yPe1 !== null) {
      traces.push({
        x: [0, 1],
        y: [yPe0, yPe1],
        type: 'scatter',
        mode: 'markers',
        showlegend: false,
        marker: { size: 10, color: '#2563eb', line: { width: 1, color: '#fff' } },
        hoverinfo: 'skip',
      })
    }
    const yNe0 = interpAt(curves.pristine.ne.x, curves.pristine.ne.ocv, 0)
    const yNe1 = interpAt(curves.pristine.ne.x, curves.pristine.ne.ocv, 1)
    if (yNe0 !== null && yNe1 !== null) {
      traces.push({
        x: [0, 1],
        y: [yNe0, yNe1],
        type: 'scatter',
        mode: 'markers',
        showlegend: false,
        marker: { size: 10, color: '#dc2626', line: { width: 1, color: '#fff' } },
        hoverinfo: 'skip',
      })
    }
    if (curves.degraded.valid && degradedInfo) {
      const yD0 = interpAt(curves.degraded.cell.x, curves.degraded.cell.ocv, degradedInfo.xCellEoc)
      const yD1 = interpAt(curves.degraded.cell.x, curves.degraded.cell.ocv, degradedInfo.xCellEod)
      if (yD0 !== null && yD1 !== null) {
        traces.push({
          x: [degradedInfo.xCellEoc, degradedInfo.xCellEod],
          y: [yD0, yD1],
          type: 'scatter',
          mode: 'markers',
          showlegend: false,
          marker: { size: 12, color: '#0f172a', symbol: 'diamond', line: { width: 1, color: '#fff' } },
          hoverinfo: 'skip',
        })
      }

      // Endpoint markers for half-cells (degraded).
      const yDPe0 = interpAt(curves.degraded.pe.x, curves.degraded.pe.ocv, degradedInfo.xCellEoc)
      const yDPe1 = interpAt(curves.degraded.pe.x, curves.degraded.pe.ocv, degradedInfo.xCellEod)
      if (yDPe0 !== null && yDPe1 !== null) {
        traces.push({
          x: [degradedInfo.xCellEoc, degradedInfo.xCellEod],
          y: [yDPe0, yDPe1],
          type: 'scatter',
          mode: 'markers',
          showlegend: false,
          marker: { size: 12, color: '#2563eb', symbol: 'diamond', line: { width: 1, color: '#fff' } },
          hoverinfo: 'skip',
        })
      }
      const yDNe0 = interpAt(curves.degraded.ne.x, curves.degraded.ne.ocv, degradedInfo.xCellEoc)
      const yDNe1 = interpAt(curves.degraded.ne.x, curves.degraded.ne.ocv, degradedInfo.xCellEod)
      if (yDNe0 !== null && yDNe1 !== null) {
        traces.push({
          x: [degradedInfo.xCellEoc, degradedInfo.xCellEod],
          y: [yDNe0, yDNe1],
          type: 'scatter',
          mode: 'markers',
          showlegend: false,
          marker: { size: 12, color: '#dc2626', symbol: 'diamond', line: { width: 1, color: '#fff' } },
          hoverinfo: 'skip',
        })
      }
    }

    const shapes: any[] = [vLine(0, 'rgba(148,163,184,0.7)', 'dash'), vLine(1, 'rgba(148,163,184,0.7)', 'dash')]
    if (degradedInfo) {
      shapes.push(vLine(degradedInfo.xCellEoc, 'rgba(59,130,246,0.75)', 'dash'))
      shapes.push(vLine(degradedInfo.xCellEod, 'rgba(59,130,246,0.75)', 'dash'))
    }

    return {
      data: traces,
      layout: {
        title: { text: '' },
        xaxis: {
          title: { text: 'Pristine Cell Normalized Capacity' },
          range: xRange ? [xRange[0], xRange[1]] : undefined,
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        yaxis: {
          title: { text: 'Voltage (V)' },
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        margin: { l: 70, r: 20, t: 20, b: 60 },
        legend: { x: 1.02, y: 1, xanchor: 'left' as const, yanchor: 'top' as const },
        shapes,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(255,255,255,1)',
      },
    }
  }, [curves, degradedInfo])

  const pristinePlot = useMemo(() => {
    if (!pristineCurves) return null

    const xRange =
      Array.isArray(pristineCurves.x_axis?.range) && pristineCurves.x_axis.range.length === 2 ? pristineCurves.x_axis.range : null
    const xMin = xRange ? xRange[0] : undefined
    const xMax = xRange ? xRange[1] : undefined

    const vMax = isNum(pristineCurves.limits?.v_max) ? Number(pristineCurves.limits?.v_max) : null
    const vMin = isNum(pristineCurves.limits?.v_min) ? Number(pristineCurves.limits?.v_min) : null

    const traces: any[] = []

    const addCurve = (name: string, x: NumOrNull[], y: NumOrNull[], color: string) => {
      traces.push({
        x,
        y,
        type: 'scatter',
        mode: 'lines',
        name,
        line: { color, width: 2 },
      })
    }

    addCurve('PE (Pristine)', pristineCurves.pristine.pe.x, pristineCurves.pristine.pe.ocv, '#2563eb')
    addCurve('NE (Pristine)', pristineCurves.pristine.ne.x, pristineCurves.pristine.ne.ocv, '#dc2626')
    addCurve('Cell (Pristine)', pristineCurves.pristine.cell.x, pristineCurves.pristine.cell.ocv, '#0f172a')

    if (isNum(xMin) && isNum(xMax) && vMax !== null) {
      traces.push({
        x: [xMin, xMax],
        y: [vMax, vMax],
        type: 'scatter',
        mode: 'lines',
        name: `v_max (${vMax.toFixed(2)}V)`,
        line: { color: 'rgba(100,116,139,0.8)', width: 1, dash: 'dot' },
        hoverinfo: 'skip',
      })
    }
    if (isNum(xMin) && isNum(xMax) && vMin !== null) {
      traces.push({
        x: [xMin, xMax],
        y: [vMin, vMin],
        type: 'scatter',
        mode: 'lines',
        name: `v_min (${vMin.toFixed(2)}V)`,
        line: { color: 'rgba(100,116,139,0.8)', width: 1, dash: 'dot' },
        hoverinfo: 'skip',
      })
    }

    const shapes: any[] = [vLine(0, 'rgba(148,163,184,0.7)', 'dash'), vLine(1, 'rgba(148,163,184,0.7)', 'dash')]

    return {
      data: traces,
      layout: {
        title: { text: '' },
        xaxis: {
          title: { text: 'Pristine Cell Normalized Capacity' },
          range: xRange ? [xRange[0], xRange[1]] : undefined,
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        yaxis: {
          title: { text: 'Voltage (V)' },
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        margin: { l: 70, r: 20, t: 20, b: 60 },
        legend: { x: 1.02, y: 1, xanchor: 'left' as const, yanchor: 'top' as const },
        shapes,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(255,255,255,1)',
      },
    }
  }, [pristineCurves])
  async function refreshPool() {
    try {
      const items = await fetchPoolList()
      setPoolItems(items)
    } catch {
      // ignore
    }
  }

  async function onDeletePoolItem(id: string) {
    try {
      await deleteFromPool(id)
      await refreshPool()
    } catch (e) {
      setError(String((e as any)?.message ?? e))
    }
  }

  function onSelectPoolItem(it: PoolItemSummary) {
    setError(null)
    setPristineId(it.pristine_id)
    const lli0 = clamp(it.lli, 0, 0.6)
    const pe0 = clamp(it.lam_pe, 0, 0.6)
    const ne0 = clamp(it.lam_ne, 0, 0.6)
    setLli(lli0)
    setLamPe(pe0)
    setLamNe(ne0)
    setLliPctText((lli0 * 100).toFixed(1))
    setLamPePctText((pe0 * 100).toFixed(1))
    setLamNePctText((ne0 * 100).toFixed(1))
  }

  async function readFileAsText(file: File): Promise<string> {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.readAsText(file)
    })
  }

  async function onLoadSample() {
    try {
      const { nmc_csv_text, gra_csv_text } = await fetchSampleHalfcellCsvs()
      setCreateNmcText(nmc_csv_text)
      setCreateGraText(gra_csv_text)
      setCreateNmcFile(null)
      setCreateGraFile(null)
      if (!createName) setCreateName('New')
      setCreateOpen(true)
    } catch (e) {
      setError(String((e as any)?.message ?? e))
    }
  }

  function resetCreateForm() {
    setCreateName('')
    setCreateNmcFile(null)
    setCreateGraFile(null)
    setCreateNmcText('')
    setCreateGraText('')
    setCreateSolNmcEoc('')
    setCreateSolNmcEod('')
    setCreateSolGraEoc('')
    setCreateSolGraEod('')
  }

  async function onCreatePristine() {
    const name = createName.trim()
    if (!name) {
      setError('Missing cell name')
      return
    }

    const sol_nmc_eoc = Number(createSolNmcEoc)
    const sol_nmc_eod = Number(createSolNmcEod)
    const sol_gra_eoc = Number(createSolGraEoc)
    const sol_gra_eod = Number(createSolGraEod)
    if (!Number.isFinite(sol_nmc_eoc) || !Number.isFinite(sol_nmc_eod) || !Number.isFinite(sol_gra_eoc) || !Number.isFinite(sol_gra_eod)) {
      setError('Missing SOL endpoints')
      return
    }

    setCreatingPristine(true)
    try {
      const nmcText = createNmcText || (createNmcFile ? await readFileAsText(createNmcFile) : '')
      const graText = createGraText || (createGraFile ? await readFileAsText(createGraFile) : '')
      if (!nmcText.trim()) throw new Error('Missing Positive Electrode (PE) CSV')
      if (!graText.trim()) throw new Error('Missing Negative Electrode (NE) CSV')

      const resp = await createPristineCell({
        name,
        pe_csv_text: nmcText,
        ne_csv_text: graText,
        endpoints: {
          sol_nmc_eoc,
          sol_nmc_eod,
          sol_gra_eoc,
          sol_gra_eod,
        },
      })

      await refreshProfiles()
      setSelectedPristineId(resp.profile.id)
      setCreateOpen(false)
      setTab('pristine')
    } catch (e) {
      setError(String((e as any)?.message ?? e))
    } finally {
      setCreatingPristine(false)
    }
  }

  async function onSave() {
    if (!pristineId) return
    setSaving(true)
    try {
      const profileName = profiles.find((p) => p.id === pristineId)?.name ?? pristineId
      const label = `${profileName}_${fmtPct(lli)}_${fmtPct(lamPe)}_${fmtPct(lamNe)}`
      await saveToPool({ pristine_id: pristineId, lli, lam_pe: lamPe, lam_ne: lamNe, label })
      await refreshPool()
    } catch (e) {
      setError(String((e as any)?.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  function onSaveCsv() {
    if (!curves) {
      setError('Nothing to export yet. Run a degradation simulation first.')
      return
    }
    if (!curves.degraded.valid || !degradedInfo) {
      setError('Degraded cell is invalid; cannot export CSV.')
      return
    }

    const xs = curves.degraded.cell.x
    const ys = curves.degraded.cell.ocv
    const n = Math.min(xs.length, ys.length)

    const x0 = degradedInfo.xCellEoc
    const x1 = degradedInfo.xCellEod
    const capMax = degradedInfo.cellCapacity
    const eps = 1e-10

    const xf: number[] = []
    const yf: number[] = []
    for (let i = 0; i < n; i++) {
      const x = xs[i]
      const y = ys[i]
      if (!isNum(x) || !isNum(y)) continue
      xf.push(x)
      yf.push(y)
    }

    const interpFinite = (xArr: number[], yArr: number[], xq: number): number | null => {
      if (xArr.length < 2) return null
      for (let i = 0; i < xArr.length - 1; i++) {
        const xa = xArr[i]
        const xb = xArr[i + 1]
        const ya = yArr[i]
        const yb = yArr[i + 1]
        if (!Number.isFinite(xa) || !Number.isFinite(xb) || !Number.isFinite(ya) || !Number.isFinite(yb)) continue
        if ((xq < xa && xq < xb) || (xq > xa && xq > xb)) continue
        const dx = xb - xa
        if (dx === 0) continue
        const t = (xq - xa) / dx
        return ya + t * (yb - ya)
      }
      return null
    }

    const y0 = interpFinite(xf, yf, x0) ?? (yf.length > 0 ? yf[0] : null)
    const y1 = interpFinite(xf, yf, x1) ?? (yf.length > 0 ? yf[yf.length - 1] : null)
    if (!isNum(y0) || !isNum(y1)) {
      setError('Not enough finite degraded points to export endpoints.')
      return
    }

    const rows: Array<[number, number]> = []
    for (let i = 0; i < n; i++) {
      const x = xs[i]
      const y = ys[i]
      if (!isNum(x) || !isNum(y)) continue
      if (x < x0 - eps || x > x1 + eps) continue
      let cap = x - x0
      if (Math.abs(cap) < eps) cap = 0
      if (Math.abs(cap - capMax) < eps) cap = capMax
      if (cap < 0 - eps || cap > capMax + eps) continue
      rows.push([cap, y])
    }
    if (rows.length < 3) {
      setError('Not enough finite degraded points to export.')
      return
    }

    rows.sort((a, b) => a[0] - b[0])

    // Ensure exported range includes endpoints exactly.
    if (rows[0][0] > eps) rows.unshift([0, y0])
    else {
      rows[0][0] = 0
      rows[0][1] = y0
    }

    const last = rows[rows.length - 1]
    if (last[0] < capMax - eps) rows.push([capMax, y1])
    else {
      last[0] = capMax
      last[1] = y1
    }

    const profileName = profiles.find((p) => p.id === curves.pristine_id)?.name ?? curves.pristine_id
    const base = `${profileName}_${fmtPct(lli)}_${fmtPct(lamPe)}_${fmtPct(lamNe)}`
    const csv = buildTwoColCsv(rows, ['capacity_pristine_norm_offset0', 'voltage_v'])
    downloadTextFile(`${base}.csv`, csv, 'text/csv')
  }

  function onReset() {
    setLli(0)
    setLamPe(0)
    setLamNe(0)
    setLliPctText('0.0')
    setLamPePctText('0.0')
    setLamNePctText('0.0')
  }

  async function onLoadDiagnosticsSample() {
    setDiagnosticsLoadingSample(true)
    setError(null)
    try {
      const resp = await fetchDiagnosticsSample()
      setDiagnosticsMeasured(resp.data)
      setDiagnosticsMatFile(null)
      setDiagnosticsMatBase64(null)
      setDiagnosticsResult(null)
      setDiagnosticsCurves(null)
      await ensureDiagnosticsPristineCurves()
    } catch (e) {
      setError(String((e as any)?.message ?? e))
    } finally {
      setDiagnosticsLoadingSample(false)
    }
  }

  function onDiagnosticsReset() {
    setError(null)
    setDiagnosticsMeasured(null)
    setDiagnosticsMatFile(null)
    setDiagnosticsMatBase64(null)
    setDiagnosticsResult(null)
    setDiagnosticsCurves(null)
    setDiagnosticsFileInputKey((k) => k + 1)
    setDiagnosticsNumStarts(100)
    setDiagnosticsMaxIter(200)
    setDiagnosticsGradientLimit(0.1)
    setDiagnosticsSeed(0)
  }

  useEffect(() => {
    if (tab !== 'diagnostics') return
    if (!pristineId) return
    if (diagnosticsCurves) return
    void ensureDiagnosticsPristineCurves()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, pristineId])

  useEffect(() => {
    if (tab !== 'analysis') return

    // Identify items that are selected but not yet cached
    const missingIds = poolItems
      .filter((it) => selectedPoolIds.has(it.id) && !poolCurvesCache.current.has(it.id))
      .map((it) => it.id)

    // Helper to update results from cache
    const updateResults = () => {
      const results = poolItems
        .filter((it) => selectedPoolIds.has(it.id))
        .map((it) => ({
          id: it.id,
          label: it.label ?? it.id,
          curves: poolCurvesCache.current.get(it.id) ?? null,
        }))
      setAnalysisResults(results)
    }

    if (missingIds.length === 0) {
      updateResults()
      return
    }

    const reqId = ++lastReqId.current
    setAnalysisLoading(true)
    setError(null)

    async function fetchMissing() {
      await Promise.all(
        missingIds.map(async (id) => {
          const item = poolItems.find((p) => p.id === id)
          if (!item) return
          try {
            const c = await fetchCurves({ pristine_id: item.pristine_id, lli: item.lli, lam_pe: item.lam_pe, lam_ne: item.lam_ne })
            poolCurvesCache.current.set(id, c)
          } catch (e) {
            console.error('Failed to load curve for', id, e)
            poolCurvesCache.current.set(id, null)
          }
        }),
      )

      if (reqId !== lastReqId.current) return
      setAnalysisLoading(false)
      updateResults()
    }

    void fetchMissing()
  }, [tab, poolItems, selectedPoolIds])

  useEffect(() => {
    if (tab !== 'analysis') return

    if (!analysisPristineId) {
      setAnalysisPristineResults([])
      return
    }

    const missingIds = !pristineCurvesCache.current.has(analysisPristineId) ? [analysisPristineId] : []

    const updateResults = () => {
      const p = profiles.find((x) => x.id === analysisPristineId)
      setAnalysisPristineResults([
        {
          id: analysisPristineId,
          label: p?.name ?? analysisPristineId,
          curves: pristineCurvesCache.current.get(analysisPristineId) ?? null,
        },
      ])
    }

    if (missingIds.length === 0) {
      updateResults()
      return
    }

    const reqId = ++lastReqId.current
    setAnalysisLoading(true)
    setError(null)

    async function fetchMissing() {
      await Promise.all(
        missingIds.map(async (id) => {
          try {
            const c = await fetchCurves({ pristine_id: id, lli: 0, lam_pe: 0, lam_ne: 0 })
            pristineCurvesCache.current.set(id, c)
          } catch (e) {
            console.error('Failed to load pristine curve for', id, e)
            pristineCurvesCache.current.set(id, null)
          }
        }),
      )

      if (reqId !== lastReqId.current) return
      setAnalysisLoading(false)
      updateResults()
    }

    void fetchMissing()
  }, [tab, analysisPristineId, profiles])

  useEffect(() => {
    if (tab !== 'analysis') return
    if (analysisPristineId) return
    if (profiles.length === 0) return
    setAnalysisPristineId(profiles[0].id)
  }, [tab, analysisPristineId, profiles])

  async function ensureDiagnosticsPristineCurves() {
    if (!pristineId) return
    setDiagnosticsCurvesLoading(true)
    setError(null)
    try {
      const resp = await fetchCurves({ pristine_id: pristineId, lli: 0, lam_pe: 0, lam_ne: 0 })
      setDiagnosticsCurves(resp)
    } catch (e) {
      setDiagnosticsCurves(null)
      setError(String((e as any)?.message ?? e))
    } finally {
      setDiagnosticsCurvesLoading(false)
    }
  }

  async function onDiagnosticsFileSelected(file: File | null) {
    setDiagnosticsMatFile(file)
    setDiagnosticsResult(null)
    setDiagnosticsCurves(null)
    setError(null)
    if (!file) {
      setDiagnosticsMeasured(null)
      setDiagnosticsMatBase64(null)
      return
    }

    const name = file.name.toLowerCase()
    setDiagnosticsParsingFile(true)
    try {
      if (name.endsWith('.csv')) {
        const txt = await readFileAsText(file)
        const parsed = parseTwoColCsv(txt)
        setDiagnosticsMeasured(parsed)
        setDiagnosticsMatBase64(null)
        setDiagnosticsResult(null)
        setDiagnosticsCurves(null)
        await ensureDiagnosticsPristineCurves()
        return
      }

      if (name.endsWith('.mat')) {
        const b64 = await readFileAsBase64(file)
        if (!b64) throw new Error('Failed to read MAT as base64')
        setDiagnosticsMatBase64(b64)
        setDiagnosticsResult(null)
        setDiagnosticsCurves(null)

        // Also parse it server-side so we can plot the measured points immediately.
        const resp = await parseDiagnosticsMat({ mat_base64: b64 })
        setDiagnosticsMeasured(resp.data)
        await ensureDiagnosticsPristineCurves()
        return
      }

      throw new Error('Unsupported file type; select a .mat or .csv')
    } catch (e) {
      setDiagnosticsMeasured(null)
      setDiagnosticsMatBase64(null)
      setError(String((e as any)?.message ?? e))
    } finally {
      setDiagnosticsParsingFile(false)
    }
  }

  async function onRunDiagnosticsEstimate() {
    if (!pristineId) return
    setDiagnosticsRunning(true)
    setError(null)
    try {
      const resp = await estimateDiagnostics({
        pristine_id: pristineId,
        measured: diagnosticsMeasured ?? undefined,
        mat_base64: diagnosticsMatBase64 ?? undefined,
        capacity_is_normalized: false,
        use_sample: diagnosticsMeasured || diagnosticsMatBase64 ? undefined : true,
        num_points: undefined,
        num_starts: diagnosticsNumStarts,
        gradient_limit: diagnosticsGradientLimit,
        maxiter: diagnosticsMaxIter,
        seed: diagnosticsSeed,
      })
      setDiagnosticsResult(resp)

      if (resp.valid && resp.theta_deg) {
        const lliEst = Number(resp.theta_deg.LLI)
        const lamPeEst = Number(resp.theta_deg.LAM_PE)
        const lamNeEst = Number(resp.theta_deg.LAM_NE)
        const curvesResp = await fetchCurves({ pristine_id: pristineId, lli: lliEst, lam_pe: lamPeEst, lam_ne: lamNeEst })
        setDiagnosticsCurves(curvesResp)
      } else {
        setDiagnosticsCurves(null)
      }
    } catch (e) {
      setError(String((e as any)?.message ?? e))
      setDiagnosticsResult(null)
      setDiagnosticsCurves(null)
    } finally {
      setDiagnosticsRunning(false)
    }
  }

  const activePristineProfile = useMemo(
    () => profiles.find((p) => p.id === selectedPristineId) ?? null,
    [profiles, selectedPristineId],
  )

  const pristineLimits = useMemo(() => {
    if (!activePristineProfile) return null
    const cached = pristineLimitsById.current[activePristineProfile.id]
    const vMax = cached?.v_max
    const vMin = cached?.v_min
    if (!Number.isFinite(Number(vMax)) || !Number.isFinite(Number(vMin))) return null
    return { v_max: Number(vMax), v_min: Number(vMin) }
  }, [activePristineProfile, pristineCurves])

  const diagnosticsPlot = useMemo(() => {
    const hasEstimate = Boolean(diagnosticsResult?.valid && diagnosticsResult.theta_deg)

    // Pre-fit: only show the loaded measured curve on its native capacity axis.
    if (!hasEstimate) {
      const measured = diagnosticsMeasured
      if (!measured) return null
      const cap = measured.capacity
      const ocv = measured.ocv
      if (!Array.isArray(cap) || !Array.isArray(ocv) || cap.length < 2 || cap.length !== ocv.length) return null

      const traces: any[] = [
        {
          x: cap,
          y: ocv,
          type: 'scatter',
          mode: 'lines+markers',
          name: 'Measured',
          line: { color: '#f59e0b', width: 2 },
          marker: { size: 7, color: '#f59e0b', line: { width: 1, color: '#fff' } },
        },
      ]

      return {
        data: traces,
        layout: {
          title: { text: 'Loaded OCV (measured capacity axis)' },
          xaxis: {
            title: { text: 'Measured Capacity (original units)' },
            zeroline: false,
            gridcolor: 'rgba(148,163,184,0.25)',
          },
          yaxis: {
            title: { text: 'Voltage (V)' },
            zeroline: false,
            gridcolor: 'rgba(148,163,184,0.25)',
          },
          margin: { l: 70, r: 20, t: 60, b: 60 },
          legend: { x: 1.02, y: 1, xanchor: 'left' as const, yanchor: 'top' as const },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(255,255,255,1)',
        },
      }
    }

    // Post-fit: show everything on pristine normalized capacity axis.
    if (!diagnosticsCurves) return null

    const xRange = Array.isArray(diagnosticsCurves.x_axis?.range) && diagnosticsCurves.x_axis.range.length === 2 ? diagnosticsCurves.x_axis.range : null
    const vMax = isNum(diagnosticsCurves.limits?.v_max) ? Number(diagnosticsCurves.limits?.v_max) : null
    const vMin = isNum(diagnosticsCurves.limits?.v_min) ? Number(diagnosticsCurves.limits?.v_min) : null

    const traces: any[] = []

    const addCurve = (
      name: string,
      x: NumOrNull[],
      y: NumOrNull[],
      color: string,
      dash?: 'solid' | 'dot' | 'dash',
    ) => {
      traces.push({
        x,
        y,
        type: 'scatter',
        mode: 'lines',
        name,
        line: { color, width: 2, dash: dash ?? 'solid' },
      })
    }

    addCurve('PE (Pristine)', diagnosticsCurves.pristine.pe.x, diagnosticsCurves.pristine.pe.ocv, '#2563eb', 'solid')
    addCurve('NE (Pristine)', diagnosticsCurves.pristine.ne.x, diagnosticsCurves.pristine.ne.ocv, '#dc2626', 'solid')
    addCurve('Cell (Pristine)', diagnosticsCurves.pristine.cell.x, diagnosticsCurves.pristine.cell.ocv, '#0f172a', 'solid')

    if (hasEstimate && diagnosticsCurves.degraded.valid) {
      addCurve('PE (Estimated)', diagnosticsCurves.degraded.pe.x, diagnosticsCurves.degraded.pe.ocv, '#2563eb', 'dot')
      addCurve('NE (Estimated)', diagnosticsCurves.degraded.ne.x, diagnosticsCurves.degraded.ne.ocv, '#dc2626', 'dot')
      addCurve('Cell (Estimated)', diagnosticsCurves.degraded.cell.x, diagnosticsCurves.degraded.cell.ocv, '#0f172a', 'dot')
    }

    if (xRange && vMax !== null) {
      traces.push({
        x: [xRange[0], xRange[1]],
        y: [vMax, vMax],
        type: 'scatter',
        mode: 'lines',
        name: `v_max (${vMax.toFixed(2)}V)`,
        line: { color: 'rgba(100,116,139,0.8)', width: 1, dash: 'dot' },
        hoverinfo: 'skip',
      })
    }
    if (xRange && vMin !== null) {
      traces.push({
        x: [xRange[0], xRange[1]],
        y: [vMin, vMin],
        type: 'scatter',
        mode: 'lines',
        name: `v_min (${vMin.toFixed(2)}V)`,
        line: { color: 'rgba(100,116,139,0.8)', width: 1, dash: 'dot' },
        hoverinfo: 'skip',
      })
    }

    // Endpoint markers for pristine curves.
    const yPr0 = interpAt(diagnosticsCurves.pristine.cell.x, diagnosticsCurves.pristine.cell.ocv, 0)
    const yPr1 = interpAt(diagnosticsCurves.pristine.cell.x, diagnosticsCurves.pristine.cell.ocv, 1)
    if (yPr0 !== null && yPr1 !== null) {
      traces.push({
        x: [0, 1],
        y: [yPr0, yPr1],
        type: 'scatter',
        mode: 'markers',
        showlegend: false,
        marker: { size: 10, color: '#0f172a', line: { width: 1, color: '#fff' } },
        hoverinfo: 'skip',
      })
    }

    const yPe0 = interpAt(diagnosticsCurves.pristine.pe.x, diagnosticsCurves.pristine.pe.ocv, 0)
    const yPe1 = interpAt(diagnosticsCurves.pristine.pe.x, diagnosticsCurves.pristine.pe.ocv, 1)
    if (yPe0 !== null && yPe1 !== null) {
      traces.push({
        x: [0, 1],
        y: [yPe0, yPe1],
        type: 'scatter',
        mode: 'markers',
        showlegend: false,
        marker: { size: 10, color: '#2563eb', line: { width: 1, color: '#fff' } },
        hoverinfo: 'skip',
      })
    }

    const yNe0 = interpAt(diagnosticsCurves.pristine.ne.x, diagnosticsCurves.pristine.ne.ocv, 0)
    const yNe1 = interpAt(diagnosticsCurves.pristine.ne.x, diagnosticsCurves.pristine.ne.ocv, 1)
    if (yNe0 !== null && yNe1 !== null) {
      traces.push({
        x: [0, 1],
        y: [yNe0, yNe1],
        type: 'scatter',
        mode: 'markers',
        showlegend: false,
        marker: { size: 10, color: '#dc2626', line: { width: 1, color: '#fff' } },
        hoverinfo: 'skip',
      })
    }

    // Endpoint markers for estimated (degraded) utilization window.
    if (hasEstimate && diagnosticsCurves.degraded.valid && diagnosticsDegradedInfo) {
      const yD0 = interpAt(diagnosticsCurves.degraded.cell.x, diagnosticsCurves.degraded.cell.ocv, diagnosticsDegradedInfo.xCellEoc)
      const yD1 = interpAt(diagnosticsCurves.degraded.cell.x, diagnosticsCurves.degraded.cell.ocv, diagnosticsDegradedInfo.xCellEod)
      if (yD0 !== null && yD1 !== null) {
        traces.push({
          x: [diagnosticsDegradedInfo.xCellEoc, diagnosticsDegradedInfo.xCellEod],
          y: [yD0, yD1],
          type: 'scatter',
          mode: 'markers',
          showlegend: false,
          marker: { size: 12, color: '#0f172a', symbol: 'diamond', line: { width: 1, color: '#fff' } },
          hoverinfo: 'skip',
        })
      }
    }

    // Overlay measured points as markers on pristine-x by shifting by x_cell_eoc.
    const measured = diagnosticsResult?.measured ?? diagnosticsMeasured
    if (measured) {
      const cap = measured.capacity
      const ocv = measured.ocv
      if (Array.isArray(cap) && Array.isArray(ocv) && cap.length === ocv.length) {
        let xPts: number[]

        if (hasEstimate && Array.isArray(diagnosticsResult?.measured?.x_pristine)) {
          xPts = diagnosticsResult?.measured?.x_pristine ?? []
        } else if (hasEstimate && diagnosticsDegradedInfo) {
          xPts = cap.map((c) => c + diagnosticsDegradedInfo.xCellEoc)
        } else {
          xPts = cap
        }

        traces.push({
          x: xPts,
          y: ocv,
          type: 'scatter',
          mode: 'markers',
          name: 'Measured',
          marker: { size: 7, color: '#f59e0b', line: { width: 1, color: '#fff' } },
        })
      }
    }

    const shapes: any[] = [vLine(0, 'rgba(148,163,184,0.7)', 'dash'), vLine(1, 'rgba(148,163,184,0.7)', 'dash')]
    if (hasEstimate && diagnosticsDegradedInfo) {
      shapes.push(vLine(diagnosticsDegradedInfo.xCellEoc, 'rgba(59,130,246,0.75)', 'dash'))
      shapes.push(vLine(diagnosticsDegradedInfo.xCellEod, 'rgba(59,130,246,0.75)', 'dash'))
    }

    const rmseMv = Number.isFinite(Number(diagnosticsResult?.rmse_v)) ? Number(diagnosticsResult?.rmse_v) * 1000 : null
    const title = rmseMv != null ? `Diagnostics Fit (RMSE ${rmseMv.toFixed(3)} mV)` : diagnosticsCurvesLoading ? 'Diagnostics (loading pristine...)' : 'Diagnostics'

    return {
      data: traces,
      layout: {
        title: { text: title },
        xaxis: {
          title: { text: 'Pristine Cell Normalized Capacity' },
          range: xRange ? [xRange[0], xRange[1]] : undefined,
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        yaxis: {
          title: { text: 'Voltage (V)' },
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        margin: { l: 70, r: 20, t: 60, b: 60 },
        legend: { x: 1.02, y: 1, xanchor: 'left' as const, yanchor: 'top' as const },
        shapes,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(255,255,255,1)',
      },
    }
  }, [diagnosticsCurves, diagnosticsCurvesLoading, diagnosticsDegradedInfo, diagnosticsMeasured, diagnosticsResult])

  const analysisVoltagePlot = useMemo(() => {
    if (tab !== 'analysis') return null
    if (analysisResults.length === 0 && analysisPristineResults.length === 0) return null

    const traces: any[] = []
    let validCount = 0

    let yMin = Number.POSITIVE_INFINITY
    let yMax = Number.NEGATIVE_INFINITY
    const pushY = (y: unknown) => {
      if (typeof y !== 'number') return
      if (!Number.isFinite(y)) return
      const yy = y
      if (yy < yMin) yMin = yy
      if (yy > yMax) yMax = yy
    }

    const defaultVisible = analysisResults.length > 40 ? 'legendonly' : true

    const userVMax = analysisTruncateV ? parseLooseNumberText(analysisVMaxText) : null
    const userVMin = analysisTruncateV ? parseLooseNumberText(analysisVMinText) : null
    const truncateEnabled = Boolean(analysisTruncateV && userVMax != null && userVMin != null)

    const getVBounds = (q: NumOrNull[], v: NumOrNull[], qMin: number, qMax: number) => {
      let vLo = Number.POSITIVE_INFINITY
      let vHi = Number.NEGATIVE_INFINITY
      const n = Math.min(q.length, v.length)
      for (let i = 0; i < n; i++) {
        const qi = q[i]
        const vi = v[i]
        if (!isNum(qi) || !isNum(vi)) continue
        if (qi < qMin || qi > qMax) continue
        if (vi < vLo) vLo = vi
        if (vi > vHi) vHi = vi
      }
      if (!Number.isFinite(vLo) || !Number.isFinite(vHi)) return null
      return { vMin: vLo, vMax: vHi }
    }

    const truncParams = (q: NumOrNull[], v: NumOrNull[], qMin: number, qMax: number) => {
      if (!truncateEnabled || userVMax == null || userVMin == null) return null
      const bounds = getVBounds(q, v, qMin, qMax)
      if (!bounds) return null

      const vMaxEff = userVMax >= bounds.vMin && userVMax <= bounds.vMax ? userVMax : bounds.vMax
      const vMinEff = userVMin >= bounds.vMin && userVMin <= bounds.vMax ? userVMin : bounds.vMin
      if (!(vMaxEff > vMinEff)) return null

      const q0 = interpXAtY(q, v, vMaxEff, qMin, qMax)
      const q1 = interpXAtY(q, v, vMinEff, qMin, qMax)
      if (!isNum(q0) || !isNum(q1) || !(q1 > q0)) return null

      const capWin = q1 - q0
      if (!(capWin > 0)) return null

      const endX = analysisSelfNormalize ? 1 : capWin
      const mapQ = (qi: number) => (analysisSelfNormalize ? (qi - q0) / capWin : qi - q0)
      return { q0, q1, endX, mapQ }
    }

    for (const item of analysisPristineResults) {
      if (!item.curves?.pristine?.cell) continue
      const cell = item.curves.pristine.cell

      const tp = truncParams(cell.x, cell.ocv, 0, 1)
      if (tp) {
        const n = Math.min(cell.x.length, cell.ocv.length)
        const xPlot: number[] = []
        const yPlot: number[] = []
        for (let i = 0; i < n; i++) {
          const q = cell.x[i]
          const y = cell.ocv[i]
          if (!isNum(q) || !isNum(y)) continue
          if (q < tp.q0 || q > tp.q1) continue
          const x = tp.mapQ(q)
          if (x < 0 || x > 1) continue
          xPlot.push(x)
          yPlot.push(y)
        }

        const eps = 1e-10
        const y0 = interpAt(cell.x, cell.ocv, tp.q0)
        const y1 = interpAt(cell.x, cell.ocv, tp.q1)
        if (y0 !== null) {
          if (xPlot.length === 0 || xPlot[0] > eps) {
            xPlot.unshift(0)
            yPlot.unshift(y0)
          } else {
            xPlot[0] = 0
            yPlot[0] = y0
          }
        }
        if (y1 !== null) {
          const lastIdx = xPlot.length - 1
          if (lastIdx < 0 || xPlot[lastIdx] < tp.endX - eps) {
            xPlot.push(tp.endX)
            yPlot.push(y1)
          } else {
            xPlot[lastIdx] = tp.endX
            yPlot[lastIdx] = y1
          }
        }

        if (xPlot.length < 2) continue
        for (const y of yPlot) pushY(y)

        traces.push({
          x: xPlot,
          y: yPlot,
          type: 'scatter',
          mode: 'lines',
          name: `Pristine: ${item.label}`,
          line: { width: 3, dash: 'dash' },
          opacity: 0.9,
        })
        continue
      }

      // Only include points visible in the x-range [0, 1] when computing y-range.
      const n = Math.min(cell.x.length, cell.ocv.length)
      for (let i = 0; i < n; i++) {
        const x = cell.x[i]
        const y = cell.ocv[i]
        if (typeof x !== 'number' || !Number.isFinite(x)) continue
        if (x < 0 || x > 1) continue
        pushY(y)
      }

      traces.push({
        x: cell.x,
        y: cell.ocv,
        type: 'scatter',
        mode: 'lines',
        name: `Pristine: ${item.label}`,
        line: { width: 3, dash: 'dash' },
        opacity: 0.9,
      })
    }

    for (const item of analysisResults) {
      if (!item.curves?.degraded?.valid) continue
      const deg = item.curves.degraded
      const xCellEoc = Number((deg.results as any).x_cell_eoc)
      const xCellEod = Number((deg.results as any).x_cell_eod)
      if (!Number.isFinite(xCellEoc) || !Number.isFinite(xCellEod)) continue

      const cap = xCellEod - xCellEoc
      if (!(cap > 0)) continue

      validCount++

      const xs = deg.cell.x
      const ys = deg.cell.ocv
      const n = Math.min(xs.length, ys.length)

      const xPlot: number[] = []
      const yPlot: number[] = []

      const qMax = analysisSelfNormalize ? 1 : Math.min(1, cap)
      if (!(qMax > 0)) continue

      const qArr: Array<number | null> = []
      for (let i = 0; i < n; i++) {
        const x = xs[i]
        if (!isNum(x)) {
          qArr.push(null)
          continue
        }
        if (analysisSelfNormalize) {
          if (x < xCellEoc || x > xCellEod) {
            qArr.push(null)
            continue
          }
          qArr.push((x - xCellEoc) / cap)
        } else {
          qArr.push(x - xCellEoc)
        }
      }

      const tp = truncParams(qArr, ys, 0, qMax)
      if (tp) {
        for (let i = 0; i < n; i++) {
          const q = qArr[i]
          const y = ys[i]
          if (!isNum(q) || !isNum(y)) continue
          if (q < tp.q0 || q > tp.q1) continue
          const x = tp.mapQ(q)
          if (x < 0 || x > 1) continue
          xPlot.push(x)
          yPlot.push(y)
        }

        const eps = 1e-10
        const y0 = interpAt(qArr, ys, tp.q0)
        const y1 = interpAt(qArr, ys, tp.q1)
        if (y0 !== null) {
          if (xPlot.length === 0 || xPlot[0] > eps) {
            xPlot.unshift(0)
            yPlot.unshift(y0)
          } else {
            xPlot[0] = 0
            yPlot[0] = y0
          }
        }
        if (y1 !== null) {
          const lastIdx = xPlot.length - 1
          if (lastIdx < 0 || xPlot[lastIdx] < tp.endX - eps) {
            xPlot.push(tp.endX)
            yPlot.push(y1)
          } else {
            xPlot[lastIdx] = tp.endX
            yPlot[lastIdx] = y1
          }
        }

        if (xPlot.length < 2) continue
      } else {
        if (analysisSelfNormalize) {
          for (let i = 0; i < n; i++) {
            const q = qArr[i]
            const y = ys[i]
            if (!isNum(q) || !isNum(y)) continue
            if (q < 0 || q > 1) continue
            xPlot.push(q)
            yPlot.push(y)
          }
        } else {
          const endX = qMax
          for (let i = 0; i < n; i++) {
            const q = qArr[i]
            const y = ys[i]
            if (!isNum(q) || !isNum(y)) continue
            if (q < 0 || q > endX) continue
            xPlot.push(q)
            yPlot.push(y)
          }

          const eps = 1e-10
          const y0 = interpAt(qArr, ys, 0)
          const y1 = interpAt(qArr, ys, endX)
          if (y0 !== null) {
            if (xPlot.length === 0 || xPlot[0] > eps) {
              xPlot.unshift(0)
              yPlot.unshift(y0)
            } else {
              xPlot[0] = 0
              yPlot[0] = y0
            }
          }
          if (y1 !== null) {
            const lastIdx = xPlot.length - 1
            if (lastIdx < 0 || xPlot[lastIdx] < endX - eps) {
              xPlot.push(endX)
              yPlot.push(y1)
            } else {
              xPlot[lastIdx] = endX
              yPlot[lastIdx] = y1
            }
          }

          if (xPlot.length < 2) continue
        }
      }

      for (const y of yPlot) pushY(y)

      traces.push({
        x: xPlot,
        y: yPlot,
        type: 'scatter',
        mode: 'lines',
        name: item.label,
        line: { width: 2 },
        opacity: 0.5,
        visible: defaultVisible,
      })
    }

    const shapes: any[] = [vLine(0, 'rgba(148,163,184,0.7)', 'dash'), vLine(1, 'rgba(148,163,184,0.7)', 'dash')]

    const yRange = Number.isFinite(yMin) && Number.isFinite(yMax)
      ? (() => {
          const span = yMax - yMin
          const safeSpan = span > 0 ? span : 0.05
          const pad = Math.max(0.02, safeSpan * 0.05)
          return [yMin - pad, yMax + pad] as [number, number]
        })()
      : undefined

    return {
      validCount,
      data: traces,
      layout: {
        title: { text: 'Voltage Curve Comparison' },
        xaxis: {
          title: { text: analysisSelfNormalize ? 'Self-normalized capacity (0-1)' : 'Degraded capacity (pristine-normalized, offset)' },
          range: [0, 1],
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        yaxis: {
          title: { text: 'Voltage (V)' },
          range: yRange,
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        margin: { l: 70, r: 20, t: 60, b: 60 },
        legend: { x: 1.02, y: 1, xanchor: 'left' as const, yanchor: 'top' as const },
        shapes,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(255,255,255,1)',
      },
    }
  }, [
    analysisResults,
    analysisPristineResults,
    analysisSelfNormalize,
    analysisTruncateV,
    analysisVMaxText,
    analysisVMinText,
    tab,
    poolItems.length,
  ])

  const analysisDqPlot = useMemo(() => {
    if (tab !== 'analysis') return null

    const pri = analysisPristineResults.length === 1 ? analysisPristineResults[0] : null
    const priCell = pri?.curves?.pristine?.cell
    if (!priCell) return { missingPristine: true as const, data: [], layout: { title: { text: 'dQ vs V' } } }

    if (analysisResults.length === 0) return null

    const priX = priCell.x
    const priV = priCell.ocv

    const userVMax = analysisTruncateV ? parseLooseNumberText(analysisVMaxText) : null
    const userVMin = analysisTruncateV ? parseLooseNumberText(analysisVMinText) : null
    const truncateEnabled = Boolean(analysisTruncateV && userVMax != null && userVMin != null)

    const getVBounds = (q: NumOrNull[], v: NumOrNull[], qMin: number, qMax: number) => {
      let vLo = Number.POSITIVE_INFINITY
      let vHi = Number.NEGATIVE_INFINITY
      const n = Math.min(q.length, v.length)
      for (let i = 0; i < n; i++) {
        const qi = q[i]
        const vi = v[i]
        if (!isNum(qi) || !isNum(vi)) continue
        if (qi < qMin || qi > qMax) continue
        if (vi < vLo) vLo = vi
        if (vi > vHi) vHi = vi
      }
      if (!Number.isFinite(vLo) || !Number.isFinite(vHi)) return null
      return { vMin: vLo, vMax: vHi }
    }

    const truncForCurve = (q: NumOrNull[], v: NumOrNull[], qMin: number, qMax: number) => {
      if (!truncateEnabled || userVMax == null || userVMin == null) return null
      const bounds = getVBounds(q, v, qMin, qMax)
      if (!bounds) return null
      const vMaxEff = userVMax >= bounds.vMin && userVMax <= bounds.vMax ? userVMax : bounds.vMax
      const vMinEff = userVMin >= bounds.vMin && userVMin <= bounds.vMax ? userVMin : bounds.vMin
      if (!(vMaxEff > vMinEff)) return null
      const q0 = interpXAtY(q, v, vMaxEff, qMin, qMax)
      const q1 = interpXAtY(q, v, vMinEff, qMin, qMax)
      if (!isNum(q0) || !isNum(q1) || !(q1 > q0)) return null
      return { q0, q1, capWin: q1 - q0 }
    }

    const priTr = truncForCurve(priX, priV, 0, 1)
    const priMapQ = (q: number) => {
      if (!priTr) return q
      if (analysisSelfNormalize) return (q - priTr.q0) / priTr.capWin
      return q - priTr.q0
    }

    const traces: any[] = []
    let xMin = Number.POSITIVE_INFINITY
    let xMax = Number.NEGATIVE_INFINITY
    let yMin = Number.POSITIVE_INFINITY
    let yMax = Number.NEGATIVE_INFINITY

    const pushStats = (dq: unknown, v: unknown) => {
      if (typeof dq === 'number' && Number.isFinite(dq)) {
        if (dq < xMin) xMin = dq
        if (dq > xMax) xMax = dq
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < yMin) yMin = v
        if (v > yMax) yMax = v
      }
    }

    // Reference pristine baseline at dQ=0.
    {
      const n = Math.min(priX.length, priV.length)
      const x0: Array<number | null> = []
      const y0: Array<number | null> = []
      for (let i = 0; i < n; i++) {
        const x = priX[i]
        const v = priV[i]
        if (!isNum(x) || x < 0 || x > 1 || !isNum(v)) {
          if (x0.length > 0 && x0[x0.length - 1] !== null) {
            x0.push(null)
            y0.push(null)
          }
          continue
        }
        x0.push(0)
        y0.push(v)
        pushStats(0, v)
      }

      traces.push({
        x: x0,
        y: y0,
        type: 'scatter',
        mode: 'lines',
        name: `Pristine dQ=0: ${pri?.label ?? pri?.id ?? ''}`,
        line: { width: 3, dash: 'dash' },
        opacity: 0.9,
        hoverinfo: 'skip',
      })
    }

    const defaultVisible = analysisResults.length > 40 ? 'legendonly' : true
    const eps = 1e-10

    for (const item of analysisResults) {
      if (!item.curves?.degraded?.valid) continue
      const deg = item.curves.degraded
      const xCellEoc = Number((deg.results as any).x_cell_eoc)
      const xCellEod = Number((deg.results as any).x_cell_eod)
      if (!Number.isFinite(xCellEoc) || !Number.isFinite(xCellEod)) continue

      const cap = xCellEod - xCellEoc
      if (!(cap > 0)) continue

      const xs = deg.cell.x
      const vs = deg.cell.ocv
      const n = Math.min(xs.length, vs.length)

      const xPlot: Array<number | null> = []
      const yPlot: Array<number | null> = []

      const qMaxDeg = analysisSelfNormalize ? 1 : Math.min(1, cap)
      if (!(qMaxDeg > 0)) continue

      const qDegArr: Array<number | null> = []
      for (let i = 0; i < n; i++) {
        const x = xs[i]
        if (!isNum(x)) {
          qDegArr.push(null)
          continue
        }
        if (analysisSelfNormalize) {
          if (x < xCellEoc - eps || x > xCellEod + eps) {
            qDegArr.push(null)
            continue
          }
          qDegArr.push((x - xCellEoc) / cap)
        } else {
          qDegArr.push(x - xCellEoc)
        }
      }

      const degTr = truncForCurve(qDegArr, vs, 0, qMaxDeg)
      const degMapQ = (q: number) => {
        if (!degTr) return q
        if (analysisSelfNormalize) return (q - degTr.q0) / degTr.capWin
        return q - degTr.q0
      }

      let hadPoint = false
      for (let i = 0; i < n; i++) {
        const v = vs[i]
        const q = qDegArr[i]
        if (!isNum(q) || !isNum(v)) {
          if (hadPoint && xPlot[xPlot.length - 1] !== null) {
            xPlot.push(null)
            yPlot.push(null)
          }
          continue
        }

        if (q < -eps || q > qMaxDeg + eps) {
          if (hadPoint && xPlot[xPlot.length - 1] !== null) {
            xPlot.push(null)
            yPlot.push(null)
          }
          continue
        }

        if (degTr && (q < degTr.q0 - eps || q > degTr.q1 + eps)) {
          if (hadPoint && xPlot[xPlot.length - 1] !== null) {
            xPlot.push(null)
            yPlot.push(null)
          }
          continue
        }

        const qPri = interpXAtY(priX, priV, v, 0, 1)
        if (!isNum(qPri)) {
          if (hadPoint && xPlot[xPlot.length - 1] !== null) {
            xPlot.push(null)
            yPlot.push(null)
          }
          continue
        }

        if (priTr && (qPri < priTr.q0 - eps || qPri > priTr.q1 + eps)) {
          if (hadPoint && xPlot[xPlot.length - 1] !== null) {
            xPlot.push(null)
            yPlot.push(null)
          }
          continue
        }

        const dq = degMapQ(clamp(q, 0, qMaxDeg)) - priMapQ(clamp(qPri, 0, 1))
        xPlot.push(dq)
        yPlot.push(v)
        pushStats(dq, v)
        hadPoint = true
      }

      if (xPlot.length < 2) continue

      traces.push({
        x: xPlot,
        y: yPlot,
        type: 'scatter',
        mode: 'lines',
        name: item.label,
        line: { width: 2 },
        opacity: 0.6,
        visible: defaultVisible,
      })
    }

    if (traces.length === 0) return null

    const xRange = Number.isFinite(xMin) && Number.isFinite(xMax)
      ? (() => {
          const span = xMax - xMin
          const safeSpan = span > 0 ? span : 0.1
          const pad = Math.max(0.02, safeSpan * 0.08)
          return [xMin - pad, xMax + pad] as [number, number]
        })()
      : undefined

    const yRange = Number.isFinite(yMin) && Number.isFinite(yMax)
      ? (() => {
          const span = yMax - yMin
          const safeSpan = span > 0 ? span : 0.05
          const pad = Math.max(0.02, safeSpan * 0.05)
          return [yMin - pad, yMax + pad] as [number, number]
        })()
      : undefined

    const shapes: any[] = [
      {
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: 0,
        x1: 0,
        y0: 0,
        y1: 1,
        line: { color: 'rgba(148,163,184,0.7)', width: 1, dash: 'dash' },
      },
    ]

    return {
      missingPristine: false as const,
      data: traces,
      layout: {
        title: { text: 'dQ vs V' },
        xaxis: {
          title: { text: analysisSelfNormalize ? 'dQ (self-normalized)' : 'dQ (pristine-normalized, offset)' },
          range: xRange,
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        yaxis: {
          title: { text: 'Voltage (V)' },
          range: yRange,
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        margin: { l: 70, r: 20, t: 60, b: 60 },
        legend: { x: 1.02, y: 1, xanchor: 'left' as const, yanchor: 'top' as const },
        shapes,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(255,255,255,1)',
      },
    }
  }, [
    analysisPristineResults,
    analysisResults,
    analysisSelfNormalize,
    analysisDqDvWindowV,
    analysisDqDvWindowText,
    analysisTruncateV,
    analysisVMaxText,
    analysisVMinText,
    tab,
  ])

  const analysisOriginalVRange = useMemo(() => {
    if (tab !== 'analysis') return null

    let vMin = Number.POSITIVE_INFINITY
    let vMax = Number.NEGATIVE_INFINITY

    const pushV = (v: unknown) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return
      if (v < vMin) vMin = v
      if (v > vMax) vMax = v
    }

    const pushCurve = (q: NumOrNull[], v: NumOrNull[], qMin: number, qMax: number) => {
      const n = Math.min(q.length, v.length)
      for (let i = 0; i < n; i++) {
        const qi = q[i]
        const vi = v[i]
        if (!isNum(qi) || !isNum(vi)) continue
        if (qi < qMin || qi > qMax) continue
        pushV(vi)
      }
    }

    for (const item of analysisPristineResults) {
      const cell = item.curves?.pristine?.cell
      if (!cell) continue
      pushCurve(cell.x, cell.ocv, 0, 1)
    }

    for (const item of analysisResults) {
      const deg = item.curves?.degraded
      if (!deg || !deg.valid) continue
      const xCellEoc = Number((deg.results as any).x_cell_eoc)
      const xCellEod = Number((deg.results as any).x_cell_eod)
      if (!Number.isFinite(xCellEoc) || !Number.isFinite(xCellEod)) continue
      const cap = xCellEod - xCellEoc
      if (!(cap > 0)) continue

      const qMax = analysisSelfNormalize ? 1 : Math.min(1, cap)
      if (!(qMax > 0)) continue

      const xs = deg.cell.x
      const vs = deg.cell.ocv
      const n = Math.min(xs.length, vs.length)
      const qArr: Array<number | null> = []
      for (let i = 0; i < n; i++) {
        const x = xs[i]
        if (!isNum(x)) {
          qArr.push(null)
          continue
        }
        if (analysisSelfNormalize) {
          if (x < xCellEoc || x > xCellEod) {
            qArr.push(null)
            continue
          }
          qArr.push((x - xCellEoc) / cap)
        } else {
          qArr.push(x - xCellEoc)
        }
      }
      pushCurve(qArr, vs, 0, qMax)
    }

    if (!Number.isFinite(vMin) || !Number.isFinite(vMax) || !(vMax > vMin)) return null
    return { vMin, vMax }
  }, [tab, analysisPristineResults, analysisResults, analysisSelfNormalize])

  useEffect(() => {
    if (tab !== 'analysis') return
    if (!analysisOriginalVRange) return

    const vmax = parseLooseNumberText(analysisVMaxText)
    if (vmax != null) {
      const clamped = clamp(vmax, analysisOriginalVRange.vMin, analysisOriginalVRange.vMax)
      if (clamped !== vmax) setAnalysisVMaxText(clamped.toFixed(3))
    }

    const vmin = parseLooseNumberText(analysisVMinText)
    if (vmin != null) {
      const clamped = clamp(vmin, analysisOriginalVRange.vMin, analysisOriginalVRange.vMax)
      if (clamped !== vmin) setAnalysisVMinText(clamped.toFixed(3))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, analysisOriginalVRange, analysisVMaxText, analysisVMinText])

  const analysisDqdvPlot = useMemo(() => {
    if (tab !== 'analysis') return null

    if (analysisResults.length === 0 && analysisPristineResults.length === 0) return null

    const pri = analysisPristineResults.length === 1 ? analysisPristineResults[0] : null
    const priCell = pri?.curves?.pristine?.cell ?? null

    const traces: any[] = []
    // x = V, y = dQ/dV
    let xMin = Number.POSITIVE_INFINITY
    let xMax = Number.NEGATIVE_INFINITY
    let yMin = Number.POSITIVE_INFINITY
    let yMax = Number.NEGATIVE_INFINITY

    const pushStats = (dqdv: unknown, v: unknown) => {
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < xMin) xMin = v
        if (v > xMax) xMax = v
      }
      if (typeof dqdv === 'number' && Number.isFinite(dqdv)) {
        if (dqdv < yMin) yMin = dqdv
        if (dqdv > yMax) yMax = dqdv
      }
    }

    const eps = 1e-10

    const dvIn = parseLooseNumberText(analysisDqDvWindowText) ?? analysisDqDvWindowV
    const dv = Math.max(1e-6, Number(dvIn) || 0.001)

    // Compute dQ/dV by:
    // 1) averaging Q within a fixed voltage window (bin) of width dv on a uniform V grid
    // 2) differencing adjacent averaged Q values: dQ / dv
    function computeDqdvFromVGrid(
      q: NumOrNull[],
      v: NumOrNull[],
      qMin: number,
      qMax: number,
      vStart: number,
      vEnd: number,
    ): { x: Array<number | null>; y: Array<number | null> } {
      if (!(vEnd > vStart) || !(dv > 0)) return { x: [], y: [] }

      const half = dv / 2
      const centers: number[] = []
      for (let vc = vStart + half; vc <= vEnd - half + 1e-12; vc += dv) centers.push(vc)
      if (centers.length < 3) return { x: [], y: [] }

      const qAvg: Array<number | null> = []
      for (const vc of centers) {
        const q1 = interpXAtY(q, v, vc - half, qMin, qMax)
        const q2 = interpXAtY(q, v, vc + half, qMin, qMax)
        if (isNum(q1) && isNum(q2)) qAvg.push((q1 + q2) / 2)
        else qAvg.push(null)
      }

      const xOut: Array<number | null> = []
      const yOut: Array<number | null> = []
      for (let i = 0; i < qAvg.length - 1; i++) {
        const a = qAvg[i]
        const b = qAvg[i + 1]
        const vMid = centers[i] + dv / 2
        if (isNum(a) && isNum(b)) {
          xOut.push(vMid)
          yOut.push(Math.abs((b - a) / dv))
        } else {
          if (xOut.length > 0 && xOut[xOut.length - 1] !== null) {
            xOut.push(null)
            yOut.push(null)
          }
        }
      }

      return { x: xOut, y: yOut }
    }

    const userVMax = analysisTruncateV ? parseLooseNumberText(analysisVMaxText) : null
    const userVMin = analysisTruncateV ? parseLooseNumberText(analysisVMinText) : null
    const truncateEnabled = Boolean(analysisTruncateV && userVMax != null && userVMin != null)

    const getVBounds = (q: NumOrNull[], v: NumOrNull[], qMin: number, qMax: number) => {
      let vLo = Number.POSITIVE_INFINITY
      let vHi = Number.NEGATIVE_INFINITY
      const n = Math.min(q.length, v.length)
      for (let i = 0; i < n; i++) {
        const qi = q[i]
        const vi = v[i]
        if (!isNum(qi) || !isNum(vi)) continue
        if (qi < qMin || qi > qMax) continue
        if (vi < vLo) vLo = vi
        if (vi > vHi) vHi = vi
      }
      if (!Number.isFinite(vLo) || !Number.isFinite(vHi)) return null
      return { vMin: vLo, vMax: vHi }
    }

    const buildLine = (name: string, q: NumOrNull[], v: NumOrNull[], qMin: number, qMax: number, style: any) => {
      const bounds = getVBounds(q, v, qMin, qMax)
      if (!bounds) return

      let vMaxEff = bounds.vMax
      let vMinEff = bounds.vMin
      if (truncateEnabled && userVMax != null && userVMin != null) {
        vMaxEff = userVMax >= bounds.vMin && userVMax <= bounds.vMax ? userVMax : bounds.vMax
        vMinEff = userVMin >= bounds.vMin && userVMin <= bounds.vMax ? userVMin : bounds.vMin
        if (!(vMaxEff > vMinEff)) {
          vMaxEff = bounds.vMax
          vMinEff = bounds.vMin
        }
      }

      let qArr = q
      let qMaxUse = qMax
      if (truncateEnabled && userVMax != null && userVMin != null) {
        const q0 = interpXAtY(q, v, vMaxEff, qMin, qMax)
        const q1 = interpXAtY(q, v, vMinEff, qMin, qMax)
        if (isNum(q0) && isNum(q1) && q1 > q0) {
          const capWin = q1 - q0
          qArr = q.map((qi) => (isNum(qi) ? (analysisSelfNormalize ? (qi - q0) / capWin : qi - q0) : null))
          qMaxUse = analysisSelfNormalize ? 1 : capWin
        }
      }

      if ((vMaxEff - vMinEff) / dv > 5000) return
      const line = computeDqdvFromVGrid(qArr, v, 0, qMaxUse, vMinEff, vMaxEff)
      if (line.x.length < 2) return

      for (let i = 0; i < line.x.length; i++) pushStats(line.y[i], line.x[i])
      traces.push({
        x: line.x,
        y: line.y,
        type: 'scatter',
        mode: 'lines',
        name,
        ...style,
      })
    }

    if (priCell) {
      buildLine(`Pristine: ${pri?.label ?? pri?.id ?? ''}`, priCell.x, priCell.ocv, 0, 1, { line: { width: 3, dash: 'dash' }, opacity: 0.9 })
    }

    const defaultVisible = analysisResults.length > 40 ? 'legendonly' : true

    for (const item of analysisResults) {
      if (!item.curves?.degraded?.valid) continue
      const deg = item.curves.degraded
      const xCellEoc = Number((deg.results as any).x_cell_eoc)
      const xCellEod = Number((deg.results as any).x_cell_eod)
      if (!Number.isFinite(xCellEoc) || !Number.isFinite(xCellEod)) continue

      const cap = xCellEod - xCellEoc
      if (!(cap > 0)) continue

      const xs = deg.cell.x
      const vs = deg.cell.ocv
      const qMax = analysisSelfNormalize ? 1 : Math.min(1, cap)
      if (!(qMax > 0)) continue

      const qDeg: Array<number | null> = []
      const n = Math.min(xs.length, vs.length)
      for (let i = 0; i < n; i++) {
        const x = xs[i]
        if (!isNum(x)) {
          qDeg.push(null)
          continue
        }
        if (analysisSelfNormalize) {
          if (x < xCellEoc - eps || x > xCellEod + eps) {
            qDeg.push(null)
            continue
          }
          qDeg.push((x - xCellEoc) / cap)
        } else {
          qDeg.push(x - xCellEoc)
        }
      }

      buildLine(item.label, qDeg, vs, 0, qMax, { line: { width: 2 }, opacity: 0.6, visible: defaultVisible })
    }

    if (traces.length === 0) return null

    const xRange = Number.isFinite(xMin) && Number.isFinite(xMax)
      ? (() => {
          const span = xMax - xMin
          const safeSpan = span > 0 ? span : 0.2
          const pad = Math.max(0.02, safeSpan * 0.05)
          return [xMin - pad, xMax + pad] as [number, number]
        })()
      : undefined

    const yRange = Number.isFinite(yMin) && Number.isFinite(yMax)
      ? (() => {
          const span = yMax - yMin
          const safeSpan = span > 0 ? span : 0.5
          const pad = Math.max(0.05, safeSpan * 0.08)
          return [yMin - pad, yMax + pad] as [number, number]
        })()
      : undefined

    const shapes: any[] = [
      {
        type: 'line',
        xref: 'paper',
        yref: 'y',
        x0: 0,
        x1: 1,
        y0: 0,
        y1: 0,
        line: { color: 'rgba(148,163,184,0.7)', width: 1, dash: 'dash' },
      },
    ]

    return {
      data: traces,
      layout: {
        title: { text: 'dQ/dV vs V' },
        xaxis: {
          title: { text: 'Voltage (V)' },
          range: xRange,
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        yaxis: {
          title: { text: analysisSelfNormalize ? 'dQ/dV (self-normalized)' : 'dQ/dV (pristine-normalized, offset)' },
          range: yRange,
          zeroline: false,
          gridcolor: 'rgba(148,163,184,0.25)',
        },
        margin: { l: 70, r: 20, t: 60, b: 60 },
        legend: { x: 1.02, y: 1, xanchor: 'left' as const, yanchor: 'top' as const },
        shapes,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(255,255,255,1)',
      },
    }
  }, [
    analysisPristineResults,
    analysisResults,
    analysisSelfNormalize,
    analysisTruncateV,
    analysisVMaxText,
    analysisVMinText,
    tab,
  ])

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">OCV Degradation Analysis</div>
      </div>

      <div className="tabs">
        <button className={tab === 'pristine' ? 'tab tabActive' : 'tab'} onClick={() => setTab('pristine')}>
          Pristine Cells
        </button>
        <button className={tab === 'degradation' ? 'tab tabActive' : 'tab'} onClick={() => setTab('degradation')}>
          Degradation
        </button>
        <button className={tab === 'diagnostics' ? 'tab tabActive' : 'tab'} onClick={() => setTab('diagnostics')}>
          Diagnostics
        </button>
        <button className={tab === 'analysis' ? 'tab tabActive' : 'tab'} onClick={() => setTab('analysis')}>
          Analysis
        </button>
      </div>

      <div className="content" style={tab === 'analysis' ? { gridTemplateColumns: '400px 1fr' } : undefined}>
        {tab === 'pristine' ? (
          <>
            <aside className="sidebar">
              <div className="libraryHeader">
                <div className="libraryTitle">Cell Library</div>
                <button
                  className="btn btnPrimary"
                  type="button"
                  onClick={() => {
                    resetCreateForm()
                    setCreateName('New')
                    setCreateOpen(true)
                  }}
                >
                  + New
                </button>
              </div>

              <div className="cellList">
                {profiles.map((p) => {
                  const active = p.id === selectedPristineId
                  const lim = pristineLimitsById.current[p.id]
                  const vLine = lim?.v_min != null && lim?.v_max != null ? `V: ${Number(lim.v_min).toFixed(2)} - ${Number(lim.v_max).toFixed(2)} V` : 'V: -'
                  return (
                    <div key={p.id} className={active ? 'cellCard cellCardActive' : 'cellCard'}>
                      <button type="button" className="cellCardSelect" onClick={() => setSelectedPristineId(p.id)}>
                        <div className="cellCardName">{p.name}</div>
                        <div className="cellCardMeta">{vLine}</div>
                      </button>
                      <button className="poolDelete" type="button" onClick={() => onDeletePristine(p.id)} aria-label="Delete pristine cell">
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>

              {createOpen ? (
                <div className="createCard">
                  <div className="createTitle">Create New Cell</div>

                  <div className="formField">
                    <div className="formLabel">Cell Name</div>
                    <input className="textInput" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Enter cell name" />
                  </div>

                  <div className="formField">
                    <div className="formLabel">Positive Electrode (PE) CSV</div>
                    <input
                      className="fileInput"
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => {
                        const f = e.target.files && e.target.files[0] ? e.target.files[0] : null
                        setCreateNmcFile(f)
                        setCreateNmcText('')
                      }}
                    />
                  </div>

                  <div className="formField">
                    <div className="formLabel">Negative Electrode (NE) CSV</div>
                    <input
                      className="fileInput"
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => {
                        const f = e.target.files && e.target.files[0] ? e.target.files[0] : null
                        setCreateGraFile(f)
                        setCreateGraText('')
                      }}
                    />
                  </div>

                  <button className="linkBtn" type="button" onClick={onLoadSample}>
                    Load sample data (PE/NE)
                  </button>

                  <div className="formField">
                    <div className="formLabel">SOL Endpoints</div>
                    <div className="formGrid">
                      <div className="formField">
                        <div className="formLabel">PE EoC</div>
                        <input
                          className="textInput"
                          type="text"
                          inputMode="decimal"
                          value={createSolNmcEoc}
                          onChange={(e) => setCreateSolNmcEoc(e.target.value)}
                          placeholder="required"
                        />
                      </div>
                      <div className="formField">
                        <div className="formLabel">PE EoD</div>
                        <input
                          className="textInput"
                          type="text"
                          inputMode="decimal"
                          value={createSolNmcEod}
                          onChange={(e) => setCreateSolNmcEod(e.target.value)}
                          placeholder="required"
                        />
                      </div>
                      <div className="formField">
                        <div className="formLabel">NE EoC</div>
                        <input
                          className="textInput"
                          type="text"
                          inputMode="decimal"
                          value={createSolGraEoc}
                          onChange={(e) => setCreateSolGraEoc(e.target.value)}
                          placeholder="required"
                        />
                      </div>
                      <div className="formField">
                        <div className="formLabel">NE EoD</div>
                        <input
                          className="textInput"
                          type="text"
                          inputMode="decimal"
                          value={createSolGraEod}
                          onChange={(e) => setCreateSolGraEod(e.target.value)}
                          placeholder="required"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="btnRow">
                    <button className="btn btnPrimary" type="button" onClick={onCreatePristine} disabled={creatingPristine}>
                      {creatingPristine ? 'Creating...' : 'Create'}
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        setCreateOpen(false)
                        resetCreateForm()
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="apiHint">API: {apiBase}</div>
            </aside>

            <section className="main">
              <div className="mainHeader">
                <div>
                  <div className="mainTitle">{activePristineProfile?.name ?? 'Pristine Cell'}</div>
                  <div className="mainStatus">
                    {pristineLimits ? `v_max: ${pristineLimits.v_max.toFixed(3)}V | v_min: ${pristineLimits.v_min.toFixed(3)}V` : ''}
                  </div>
                </div>
                <div className="mainStatus">{loading ? 'Updating...' : 'Ready'}</div>
              </div>

              {error ? <div className="error">{error}</div> : null}

              <div className="plotWrap">
                {pristinePlot ? (
                  <Plot data={pristinePlot.data} layout={pristinePlot.layout} style={{ width: '100%', height: '100%' }} config={{ responsive: true }} />
                ) : (
                  <div className="plotPlaceholder">Select a pristine cell to preview.</div>
                )}
              </div>
            </section>
          </>
        ) : tab === 'degradation' ? (
          <>
            <aside className="sidebar">
              <div className="panel">
                <div className="panelTitle">Pristine Cell</div>
                <select className="select" value={pristineId} onChange={(e) => setPristineId(e.target.value)}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="panel">
                <div className="panelTitle">Degradation Parameters</div>

                <div className="sliderRow">
                  <div className="sliderLabel">LLI (Loss of Li Inventory)</div>
                  <div className="paramRight">
                    <div className="sliderVal">{fmtPct(lli)}</div>
                    <input
                      className="paramInput"
                      type="text"
                      inputMode="decimal"
                      value={lliPctText}
                      onChange={(e) => {
                        const raw = e.target.value
                        setLliPctText(raw)
                        const pct = parseLooseNumberText(raw)
                        if (pct === null) return
                        setLli(clamp(pct / 100, 0, 0.6))
                      }}
                      onBlur={() => {
                        const pct = Number(lliPctText)
                        if (!Number.isFinite(pct)) {
                          setLliPctText((lli * 100).toFixed(1))
                          return
                        }
                        const next = clamp(pct / 100, 0, 0.6)
                        setLli(next)
                        setLliPctText((next * 100).toFixed(1))
                      }}
                    />
                  </div>
                  <input
                    className="slider"
                    type="range"
                    min={0}
                    max={0.6}
                    step={0.001}
                    value={lli}
                    onChange={(e) => {
                      const next = clamp(Number(e.target.value), 0, 0.6)
                      setLli(next)
                      setLliPctText((next * 100).toFixed(1))
                    }}
                  />
                </div>

                <div className="sliderRow">
                  <div className="sliderLabel">LAM_PE (Loss of Active Materials in PE)</div>
                  <div className="paramRight">
                    <div className="sliderVal">{fmtPct(lamPe)}</div>
                    <input
                      className="paramInput"
                      type="text"
                      inputMode="decimal"
                      value={lamPePctText}
                      onChange={(e) => {
                        const raw = e.target.value
                        setLamPePctText(raw)
                        const pct = parseLooseNumberText(raw)
                        if (pct === null) return
                        setLamPe(clamp(pct / 100, 0, 0.6))
                      }}
                      onBlur={() => {
                        const pct = Number(lamPePctText)
                        if (!Number.isFinite(pct)) {
                          setLamPePctText((lamPe * 100).toFixed(1))
                          return
                        }
                        const next = clamp(pct / 100, 0, 0.6)
                        setLamPe(next)
                        setLamPePctText((next * 100).toFixed(1))
                      }}
                    />
                  </div>
                  <input
                    className="slider"
                    type="range"
                    min={0}
                    max={0.6}
                    step={0.001}
                    value={lamPe}
                    onChange={(e) => {
                      const next = clamp(Number(e.target.value), 0, 0.6)
                      setLamPe(next)
                      setLamPePctText((next * 100).toFixed(1))
                    }}
                  />
                </div>

                <div className="sliderRow">
                  <div className="sliderLabel">LAM_NE (Loss of Active Materials in NE)</div>
                  <div className="paramRight">
                    <div className="sliderVal">{fmtPct(lamNe)}</div>
                    <input
                      className="paramInput"
                      type="text"
                      inputMode="decimal"
                      value={lamNePctText}
                      onChange={(e) => {
                        const raw = e.target.value
                        setLamNePctText(raw)
                        const pct = parseLooseNumberText(raw)
                        if (pct === null) return
                        setLamNe(clamp(pct / 100, 0, 0.6))
                      }}
                      onBlur={() => {
                        const pct = Number(lamNePctText)
                        if (!Number.isFinite(pct)) {
                          setLamNePctText((lamNe * 100).toFixed(1))
                          return
                        }
                        const next = clamp(pct / 100, 0, 0.6)
                        setLamNe(next)
                        setLamNePctText((next * 100).toFixed(1))
                      }}
                    />
                  </div>
                  <input
                    className="slider"
                    type="range"
                    min={0}
                    max={0.6}
                    step={0.001}
                    value={lamNe}
                    onChange={(e) => {
                      const next = clamp(Number(e.target.value), 0, 0.6)
                      setLamNe(next)
                      setLamNePctText((next * 100).toFixed(1))
                    }}
                  />
                </div>

                <div className="btnRow">
                  <button className="btn" onClick={onReset}>
                    Reset
                  </button>
                  <button className="btn btnPrimary" onClick={onSave} disabled={saving || !pristineId}>
                    {saving ? 'Saving...' : 'Save to Pool'}
                  </button>
                </div>

                <div className="btnRow">
                  <button className="btn" onClick={onSaveCsv} disabled={loading || !curves?.degraded?.valid}>
                    Save to CSV
                  </button>
                </div>

                <div className="miniStat">
                  <div className="miniStatKey">Degraded cell capacity</div>
                  <div className="miniStatVal">{degradedInfo ? `${(degradedInfo.cellCapacity * 100).toFixed(1)}%` : 'n/a'}</div>
                  {degradedInfo ? (
                    <div className="miniStatSub">
                      x_cell_eoc={fmtNum(degradedInfo.xCellEoc, 4)}; x_cell_eod={fmtNum(degradedInfo.xCellEod, 4)}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="panel">
                <div className="panelTitle">Saved Degraded Cells ({poolItems.length})</div>
                <div className="poolList">
                  {poolItems.length === 0 ? <div className="poolEmpty">No saved items yet.</div> : null}
                  {poolItems.map((it) => (
                    <div key={it.id} className="poolItem">
                      <div className="poolHeader">
                        <div className="poolName">{it.label ?? it.id}</div>
                        <div className="poolActions">
                          <button
                            className="poolLoad"
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onSelectPoolItem(it)
                            }}
                            aria-label="Load saved cell"
                          >
                            <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                              <path d="M5.25 7.5L10 12.25L14.75 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                          <button
                            className="poolDelete"
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void onDeletePoolItem(it.id)
                            }}
                            aria-label="Delete saved cell"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      <div className="poolMeta">
                        LLI: {fmtPct(it.lli)} | LAM_PE: {fmtPct(it.lam_pe)} | LAM_NE: {fmtPct(it.lam_ne)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="apiHint">API: {apiBase}</div>
            </aside>

            <section className="main">
              <div className="mainHeader">
                <div className="mainTitle">Degradation Simulation</div>
                <div className="mainStatus">{loading ? 'Updating...' : 'Ready'}</div>
              </div>

              {error ? <div className="error">{error}</div> : null}

              <div className="plotWrap">
                {mainPlot ? (
                  <Plot data={mainPlot.data} layout={mainPlot.layout} style={{ width: '100%', height: '100%' }} config={{ responsive: true }} />
                ) : (
                  <div className="plotPlaceholder">Select a pristine profile to begin.</div>
                )}
              </div>
            </section>
          </>
        ) : tab === 'diagnostics' ? (
          <>
            <aside className="sidebar">
              <div className="panel">
                <div className="panelTitle">Pristine Cell</div>
                <select className="select" value={pristineId} onChange={(e) => setPristineId(e.target.value)}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="panel">
                <div className="panelTitle">Measured OCV</div>

                <div className="formField">
                  <div className="formLabel">Load file (.mat or .csv)</div>
                  <input
                    key={diagnosticsFileInputKey}
                    className="fileInput"
                    type="file"
                    accept=".mat,.csv,text/csv,application/octet-stream"
                    onChange={(e) => {
                      const f = e.target.files && e.target.files[0] ? e.target.files[0] : null
                      void onDiagnosticsFileSelected(f)
                    }}
                  />
                  {diagnosticsMatFile ? <div className="miniStatSub">Selected: {diagnosticsMatFile.name}</div> : null}
                  {diagnosticsParsingFile ? <div className="miniStatSub">Parsing file...</div> : null}
                </div>

                <button className="linkBtn" type="button" onClick={onLoadDiagnosticsSample} disabled={diagnosticsLoadingSample}>
                  {diagnosticsLoadingSample ? 'Loading sample...' : 'Load sample (MAT synthetic_ocv.mat)'}
                </button>

                <div className="btnRow">
                  <button
                    className="btn btnPrimary"
                    type="button"
                    onClick={onRunDiagnosticsEstimate}
                    disabled={diagnosticsRunning || diagnosticsParsingFile || diagnosticsLoadingSample || !pristineId}
                  >
                    {diagnosticsRunning ? 'Running...' : 'Run estimate'}
                  </button>
                </div>

                <div className="btnRow">
                  <button
                    className="btn"
                    type="button"
                    onClick={onDiagnosticsReset}
                    disabled={diagnosticsRunning || diagnosticsParsingFile || diagnosticsLoadingSample}
                  >
                    Reset
                  </button>
                </div>

                <div className="miniStat">
                  <div className="miniStatKey">Measured points</div>
                  <div className="miniStatVal">{diagnosticsMeasured ? diagnosticsMeasured.capacity.length : diagnosticsResult?.measured?.capacity?.length ?? 'n/a'}</div>
                  {Array.isArray(diagnosticsResult?.measured?.mask_flat) ? (
                    <div className="miniStatSub">flat-mask points={diagnosticsResult?.measured?.mask_flat?.filter(Boolean).length}</div>
                  ) : null}
                </div>
              </div>

              <div className="panel">
                <div className="panelTitle">Optimizer</div>
                <div className="formField">
                  <div className="formLabel">Starts</div>
                  <input
                    className="paramInput"
                    type="number"
                    min={1}
                    max={5000}
                    step={1}
                    value={diagnosticsNumStarts}
                    onChange={(e) => setDiagnosticsNumStarts(Math.max(1, Math.min(5000, Math.floor(Number(e.target.value)))))}
                  />
                </div>
                <div className="formField">
                  <div className="formLabel">Max iterations</div>
                  <input
                    className="paramInput"
                    type="number"
                    min={20}
                    max={20000}
                    step={10}
                    value={diagnosticsMaxIter}
                    onChange={(e) => setDiagnosticsMaxIter(Math.max(20, Math.min(20000, Math.floor(Number(e.target.value)))))}
                  />
                </div>
                <div className="formField">
                  <div className="formLabel">Gradient limit (V / SoC%)</div>
                  <input
                    className="paramInput"
                    type="number"
                    min={0.001}
                    max={1}
                    step={0.001}
                    value={diagnosticsGradientLimit}
                    onChange={(e) => setDiagnosticsGradientLimit(clamp(Number(e.target.value), 0.001, 1))}
                  />
                </div>
                <div className="formField">
                  <div className="formLabel">Seed</div>
                  <input className="paramInput" type="number" step={1} value={diagnosticsSeed} onChange={(e) => setDiagnosticsSeed(Math.floor(Number(e.target.value) || 0))} />
                </div>
              </div>

              <div className="panel">
                <div className="panelTitle">Result</div>
                {diagnosticsResult?.valid && diagnosticsResult.theta_deg ? (
                  <>
                    <div className="miniStat">
                      <div className="miniStatKey">LLI</div>
                      <div className="miniStatVal">{fmtPct(Number(diagnosticsResult.theta_deg.LLI ?? 0))}</div>
                    </div>
                    <div className="miniStat">
                      <div className="miniStatKey">LAM_PE</div>
                      <div className="miniStatVal">{fmtPct(Number(diagnosticsResult.theta_deg.LAM_PE ?? 0))}</div>
                    </div>
                    <div className="miniStat">
                      <div className="miniStatKey">LAM_NE</div>
                      <div className="miniStatVal">{fmtPct(Number(diagnosticsResult.theta_deg.LAM_NE ?? 0))}</div>
                    </div>
                    <div className="miniStat">
                      <div className="miniStatKey">RMSE</div>
                      <div className="miniStatVal">{Number.isFinite(Number(diagnosticsResult.rmse_v)) ? `${(Number(diagnosticsResult.rmse_v) * 1000).toFixed(3)} mV` : 'n/a'}</div>
                    </div>
                  </>
                ) : diagnosticsResult && !diagnosticsResult.valid ? (
                  <div className="miniStatSub">Estimate invalid (see console/debug).</div>
                ) : (
                  <div className="miniStatSub">Run an estimate to see parameters.</div>
                )}
              </div>

              <div className="apiHint">API: {apiBase}</div>
            </aside>

            <section className="main">
              <div className="mainHeader">
                <div className="mainTitle">Diagnostics</div>
                <div className="mainStatus">{diagnosticsRunning ? 'Running...' : 'Ready'}</div>
              </div>

              {error ? <div className="error">{error}</div> : null}

              <div className="plotWrap">
                {diagnosticsPlot ? (
                  <Plot data={diagnosticsPlot.data} layout={diagnosticsPlot.layout} style={{ width: '100%', height: '100%' }} config={{ responsive: true }} />
                ) : (
                  <div className="plotPlaceholder">Load a sample and run an estimate to view the fit.</div>
                )}
              </div>
            </section>
          </>
        ) : (
          <>
            <aside className="sidebar" style={{ width: '400px', maxWidth: '40vw' }}>
              <div className="panel">
                <div className="panelTitle">Pristine Cell</div>
                <select className="select" value={analysisPristineId} onChange={(e) => setAnalysisPristineId(e.target.value)}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="panel">
                <div className="panelTitle">Analysis Selection</div>

                {analysisViewTab === 'dqdv' ? (
                  <div className="miniStat" style={{ marginTop: 0, marginBottom: '10px' }}>
                    <div className="miniStatKey">Smooth window (V)</div>
                    <input
                      className="paramInput"
                      type="text"
                      inputMode="decimal"
                      value={analysisDqDvWindowText}
                      onChange={(e) => {
                        const raw = e.target.value
                        setAnalysisDqDvWindowText(raw)
                        const v = parseLooseNumberText(raw)
                        if (v === null) return
                        setAnalysisDqDvWindowV(clamp(v, 0.0001, 0.02))
                      }}
                      onBlur={() => {
                        const v = Number(analysisDqDvWindowText)
                        if (!Number.isFinite(v)) {
                          setAnalysisDqDvWindowText(String(analysisDqDvWindowV))
                          return
                        }
                        const next = clamp(v, 0.0001, 0.02)
                        setAnalysisDqDvWindowV(next)
                        setAnalysisDqDvWindowText(String(next))
                      }}
                    />
                    <div className="miniStatSub">Average Q in a uniform V grid, then dQ/dV.</div>
                  </div>
                ) : null}

                <div className="miniStat" style={{ marginBottom: '10px' }}>
                  <div className="miniStatKey">Selected / Total</div>
                  <div className="miniStatVal">
                    {selectedPoolIds.size} / {poolItems.length}
                  </div>
                </div>

                <div className="btnRow" style={{ marginTop: 0, marginBottom: '10px', gridTemplateColumns: '1fr 1fr' }}>
                  <button className="btn" type="button" onClick={() => setSelectedPoolIds(new Set(poolItems.map((i) => i.id)))}>
                    Select All
                  </button>
                  <button className="btn" type="button" onClick={() => setSelectedPoolIds(new Set())}>
                    Clear
                  </button>
                </div>

                <div className="poolList" style={{ maxHeight: '260px', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '8px', background: '#fff' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                        <th style={{ padding: '4px' }}></th>
                        <th style={{ padding: '4px' }}>Label</th>
                        <th style={{ padding: '4px' }}>Pristine</th>
                        <th style={{ padding: '4px' }}>LLI</th>
                        <th style={{ padding: '4px' }}>PE</th>
                        <th style={{ padding: '4px' }}>NE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poolItems.map((it) => {
                        const isSel = selectedPoolIds.has(it.id)
                        return (
                          <tr key={it.id} style={{ borderBottom: '1px solid var(--line)', background: isSel ? 'var(--blue-weak)' : 'transparent' }}>
                            <td style={{ padding: '4px' }}>
                              <input
                                type="checkbox"
                                checked={isSel}
                                onChange={(e) => {
                                  const next = new Set(selectedPoolIds)
                                  if (e.target.checked) next.add(it.id)
                                  else next.delete(it.id)
                                  setSelectedPoolIds(next)
                                }}
                              />
                            </td>
                            <td style={{ padding: '4px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.label ?? it.id}>
                              {it.label ?? it.id}
                            </td>
                            <td style={{ padding: '4px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.pristine_id}>
                              {it.pristine_id}
                            </td>
                            <td style={{ padding: '4px' }}>{fmtPct(it.lli)}</td>
                            <td style={{ padding: '4px' }}>{fmtPct(it.lam_pe)}</td>
                            <td style={{ padding: '4px' }}>{fmtPct(it.lam_ne)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="miniStat" style={{ marginTop: '10px' }}>
                  <div className="miniStatKey">Truncate voltage window</div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
                    <button
                      className={analysisTruncateV ? 'toggleBtn toggleBtnOn' : 'toggleBtn'}
                      type="button"
                      onClick={() => setAnalysisTruncateV((v) => !v)}
                      aria-pressed={analysisTruncateV}
                    >
                      <span className="toggleKnob" />
                      <span className="toggleLabel">{analysisTruncateV ? 'On' : 'Off'}</span>
                    </button>
                    {analysisOriginalVRange ? (
                      <div className="miniStatSub" style={{ marginTop: 0 }}>
                        Original: {analysisOriginalVRange.vMin.toFixed(3)} - {analysisOriginalVRange.vMax.toFixed(3)} V
                      </div>
                    ) : (
                      <div className="miniStatSub" style={{ marginTop: 0 }}>Original: n/a</div>
                    )}
                  </div>

                  {analysisTruncateV ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                      <div>
                        <div className="miniStatKey">V max</div>
                        <input
                          className="paramInput"
                          type="text"
                          inputMode="decimal"
                          value={analysisVMaxText}
                          onChange={(e) => {
                            const raw = e.target.value
                            setAnalysisVMaxText(raw)
                            if (!analysisOriginalVRange) return
                            const v = parseLooseNumberText(raw)
                            if (v === null) return
                            const c = clamp(v, analysisOriginalVRange.vMin, analysisOriginalVRange.vMax)
                            if (c !== v) setAnalysisVMaxText(c.toFixed(3))
                          }}
                          onBlur={() => {
                            if (!analysisOriginalVRange) return
                            const v = Number(analysisVMaxText)
                            if (!Number.isFinite(v)) {
                              setAnalysisVMaxText(analysisOriginalVRange.vMax.toFixed(3))
                              return
                            }
                            setAnalysisVMaxText(clamp(v, analysisOriginalVRange.vMin, analysisOriginalVRange.vMax).toFixed(3))
                          }}
                        />
                      </div>
                      <div>
                        <div className="miniStatKey">V min</div>
                        <input
                          className="paramInput"
                          type="text"
                          inputMode="decimal"
                          value={analysisVMinText}
                          onChange={(e) => {
                            const raw = e.target.value
                            setAnalysisVMinText(raw)
                            if (!analysisOriginalVRange) return
                            const v = parseLooseNumberText(raw)
                            if (v === null) return
                            const c = clamp(v, analysisOriginalVRange.vMin, analysisOriginalVRange.vMax)
                            if (c !== v) setAnalysisVMinText(c.toFixed(3))
                          }}
                          onBlur={() => {
                            if (!analysisOriginalVRange) return
                            const v = Number(analysisVMinText)
                            if (!Number.isFinite(v)) {
                              setAnalysisVMinText(analysisOriginalVRange.vMin.toFixed(3))
                              return
                            }
                            setAnalysisVMinText(clamp(v, analysisOriginalVRange.vMin, analysisOriginalVRange.vMax).toFixed(3))
                          }}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="apiHint">API: {apiBase}</div>
            </aside>
            <section className="main">
              <div style={{ display: 'flex', gap: 14, padding: '0 0 10px', borderBottom: '1px solid var(--line)', alignItems: 'baseline' }}>
                <button className={analysisViewTab === 'voltage' ? 'tab tabActive' : 'tab'} type="button" onClick={() => setAnalysisViewTab('voltage')}>
                  Voltage Curve Comparison
                </button>
                <button className={analysisViewTab === 'dq' ? 'tab tabActive' : 'tab'} type="button" onClick={() => setAnalysisViewTab('dq')}>
                  dQ vs V
                </button>
                <button className={analysisViewTab === 'dqdv' ? 'tab tabActive' : 'tab'} type="button" onClick={() => setAnalysisViewTab('dqdv')}>
                  dQ/dV vs V
                </button>
                <div className="mainStatus" style={{ marginLeft: 'auto' }}>
                  {analysisLoading ? 'Loading...' : 'Ready'}
                </div>
              </div>

              <div style={{ padding: '10px 0 10px' }}>
                <button
                  className={analysisSelfNormalize ? 'toggleBtn toggleBtnOn' : 'toggleBtn'}
                  type="button"
                  onClick={() => setAnalysisSelfNormalize((v) => !v)}
                  disabled={analysisResults.length === 0 && analysisPristineResults.length === 0}
                  aria-pressed={analysisSelfNormalize}
                >
                  <span className="toggleKnob" />
                  <span className="toggleLabel">Self normalization</span>
                </button>
              </div>
              {error ? <div className="error">{error}</div> : null}
              <div className="plotWrap">
                {(() => {
                  const pick =
                    analysisViewTab === 'voltage'
                      ? analysisVoltagePlot
                      : analysisViewTab === 'dq'
                        ? analysisDqPlot
                        : analysisDqdvPlot
                  if (pick && (pick as any).data?.length > 0) {
                    const plotKey = `analysis-${analysisViewTab}-${analysisSelfNormalize ? 1 : 0}-${analysisViewTab === 'dqdv' ? analysisDqDvWindowText : ''}-${analysisTruncateV ? 1 : 0}-${analysisVMaxText}-${analysisVMinText}`
                    return (
                      <Plot
                        key={plotKey}
                        data={(pick as any).data}
                        layout={(pick as any).layout}
                        style={{ width: '100%', height: '100%' }}
                        config={{ responsive: true }}
                      />
                    )
                  }

                  if (analysisViewTab === 'dq' && (pick as any)?.missingPristine) {
                    return <div className="plotPlaceholder">Select a pristine profile to compute dQ.</div>
                  }

                  return (
                    <div className="plotPlaceholder">
                      {analysisLoading
                        ? 'Loading curves...'
                        : selectedPoolIds.size === 0 && !analysisPristineId
                          ? 'Select one or more cells to plot.'
                        : (analysisViewTab === 'dq' || analysisViewTab === 'dqdv') && selectedPoolIds.size === 0
                            ? 'Select one or more degraded cells to compute dQ.'
                            : 'No valid curves to display.'}
                    </div>
                  )
                })()}
              </div>
            </section>
          </>
        )}
      </div>

      <div className="footerHint">API base: {apiBase}</div>
    </div>
  )
}

function interpXAtY(x: NumOrNull[], y: NumOrNull[], y0: number, xMin = -Infinity, xMax = Infinity): number | null {
  const n = Math.min(x.length, y.length)
  if (n < 2) return null

  for (let i = 0; i < n - 1; i++) {
    const x1 = x[i]
    const x2 = x[i + 1]
    const y1 = y[i]
    const y2 = y[i + 1]

    if (!isNum(x1) || !isNum(x2) || !isNum(y1) || !isNum(y2)) continue
    if (x1 < xMin || x1 > xMax || x2 < xMin || x2 > xMax) continue

    const lo = Math.min(y1, y2)
    const hi = Math.max(y1, y2)
    if (y0 < lo || y0 > hi) continue
    if (y2 === y1) continue

    const t = (y0 - y1) / (y2 - y1)
    return x1 + t * (x2 - x1)
  }

  return null
}
