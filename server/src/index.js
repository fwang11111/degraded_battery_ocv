const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const express = require('express')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const API_DATA_ROOT = path.resolve(__dirname, '../../api/data')
const PRISTINE_DIR = path.join(API_DATA_ROOT, 'pristine')
const POOL_DIR = path.join(API_DATA_ROOT, 'degraded_pool')
const HALFCELL_DIR = path.join(API_DATA_ROOT, 'halfcell')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => path.join(dir, f))
}

function loadProfiles() {
  const profiles = new Map()
  for (const file of listJson(PRISTINE_DIR)) {
    const p = readJson(file)
    if (p && p.id) profiles.set(p.id, p)
  }
  return profiles
}

function findPristineProfileFile(id) {
  if (!fs.existsSync(PRISTINE_DIR)) return null
  for (const file of listJson(PRISTINE_DIR)) {
    try {
      const p = readJson(file)
      if (p && p.id === id) return { filePath: file, profile: p }
    } catch {
      // ignore
    }
  }
  return null
}

function resolveDataPath(relOrAbs) {
  if (path.isAbsolute(relOrAbs)) return relOrAbs
  return path.resolve(API_DATA_ROOT, relOrAbs)
}

function safeId(input) {
  const s = String(input || '').trim()
  const normalized = s
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^_+|_+$/g, '')
  return normalized
}

function nowIsoNoMs() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function requireFiniteNumber(v, name) {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}`)
  return n
}

function readHalfCellCsv(csvPath) {
  const txt = fs.readFileSync(csvPath, 'utf-8')
  return readHalfCellCsvText(txt, csvPath)
}

function readHalfCellCsvText(txt, debugName) {
  const rows = txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const sol = []
  const ocv = []

  for (const row of rows) {
    const parts = row.split(',')
    if (parts.length < 2) continue
    const x = Number(parts[0])
    const y = Number(parts[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    sol.push(x)
    ocv.push(y)
  }

  // sort and de-duplicate sol by averaging
  const idx = sol.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const solSorted = idx.map(([_, i]) => sol[i])
  const ocvSorted = idx.map(([_, i]) => ocv[i])

  const solU = []
  const ocvU = []
  let i = 0
  while (i < solSorted.length) {
    const s = solSorted[i]
    let sum = ocvSorted[i]
    let cnt = 1
    i += 1
    while (i < solSorted.length && solSorted[i] === s) {
      sum += ocvSorted[i]
      cnt += 1
      i += 1
    }
    solU.push(s)
    ocvU.push(sum / cnt)
  }

  if (solU.length < 2) throw new Error(`CSV must contain at least 2 unique SOL points: ${debugName || 'csv'}`)

  return { sol: solU, ocv: ocvU }
}

function normalizeEndpoints(raw) {
  const e = raw || {}
  const solPeEoc = e.sol_pe_eoc ?? e.sol_nmc_eoc
  const solPeEod = e.sol_pe_eod ?? e.sol_nmc_eod
  const solNeEoc = e.sol_ne_eoc ?? e.sol_gra_eoc
  const solNeEod = e.sol_ne_eod ?? e.sol_gra_eod

  return {
    sol_pe_eoc: solPeEoc,
    sol_pe_eod: solPeEod,
    sol_ne_eoc: solNeEoc,
    sol_ne_eod: solNeEod,
  }
}

// PCHIP implementation (Fritsch-Carlson) + linear extrapolation
function pchipInit(x, y) {
  const n = x.length
  if (n !== y.length) throw new Error('pchip x/y size mismatch')
  if (n < 2) throw new Error('pchip requires at least 2 points')

  const h = new Array(n - 1)
  const delta = new Array(n - 1)
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i]
    if (!(h[i] > 0)) throw new Error('pchip requires strictly increasing x')
    delta[i] = (y[i + 1] - y[i]) / h[i]
  }

  const d = new Array(n)
  if (n === 2) {
    d[0] = delta[0]
    d[1] = delta[0]
  } else {
    d[0] = ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1])
    if (Math.sign(d[0]) !== Math.sign(delta[0])) d[0] = 0
    else if (Math.sign(delta[0]) !== Math.sign(delta[1]) && Math.abs(d[0]) > Math.abs(3 * delta[0])) d[0] = 3 * delta[0]

    d[n - 1] = ((2 * h[n - 2] + h[n - 3]) * delta[n - 2] - h[n - 2] * delta[n - 3]) / (h[n - 2] + h[n - 3])
    if (Math.sign(d[n - 1]) !== Math.sign(delta[n - 2])) d[n - 1] = 0
    else if (Math.sign(delta[n - 2]) !== Math.sign(delta[n - 3]) && Math.abs(d[n - 1]) > Math.abs(3 * delta[n - 2])) d[n - 1] = 3 * delta[n - 2]

    for (let i = 1; i <= n - 2; i++) {
      if (delta[i - 1] === 0 || delta[i] === 0 || Math.sign(delta[i - 1]) !== Math.sign(delta[i])) {
        d[i] = 0
      } else {
        const w1 = 2 * h[i] + h[i - 1]
        const w2 = h[i] + 2 * h[i - 1]
        d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i])
      }
    }
  }

  function evalAt(xq) {
    if (xq <= x[0]) return y[0] + (xq - x[0]) * delta[0]
    if (xq >= x[n - 1]) return y[n - 1] + (xq - x[n - 1]) * delta[n - 2]

    let lo = 0
    let hi = n - 2
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (xq < x[mid]) hi = mid - 1
      else if (xq > x[mid + 1]) lo = mid + 1
      else {
        lo = mid
        break
      }
    }
    const i = Math.min(Math.max(lo, 0), n - 2)
    const hseg = x[i + 1] - x[i]
    const t = (xq - x[i]) / hseg

    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1
    const h10 = t ** 3 - 2 * t ** 2 + t
    const h01 = -2 * t ** 3 + 3 * t ** 2
    const h11 = t ** 3 - t ** 2

    return h00 * y[i] + h10 * hseg * d[i] + h01 * y[i + 1] + h11 * hseg * d[i + 1]
  }

  return { evalAt }
}

function linspace(a, b, n) {
  const out = new Array(n)
  if (n === 1) {
    out[0] = a
    return out
  }
  const step = (b - a) / (n - 1)
  for (let i = 0; i < n; i++) out[i] = a + step * i
  return out
}

function clamp01(x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  return x
}

function makeRng(seed) {
  let t = (Number(seed) >>> 0) || 0x12345678
  return function rand() {
    // mulberry32
    t += 0x6d2b79f5
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function interp1Linear(xs, ys, xq) {
  const n = xs.length
  if (n < 2) return NaN
  if (xq <= xs[0]) {
    const t = (xq - xs[0]) / (xs[1] - xs[0])
    return ys[0] + t * (ys[1] - ys[0])
  }
  if (xq >= xs[n - 1]) {
    const t = (xq - xs[n - 2]) / (xs[n - 1] - xs[n - 2])
    return ys[n - 2] + t * (ys[n - 1] - ys[n - 2])
  }

  let lo = 0
  let hi = n - 2
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (xq < xs[mid]) hi = mid - 1
    else if (xq > xs[mid + 1]) lo = mid + 1
    else {
      lo = mid
      break
    }
  }
  const i = Math.min(Math.max(lo, 0), n - 2)
  const x0 = xs[i]
  const x1 = xs[i + 1]
  const y0 = ys[i]
  const y1 = ys[i + 1]
  const t = (xq - x0) / (x1 - x0)
  return y0 + t * (y1 - y0)
}

function readMatV5(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let curBuf = buf
  let off = 0
  const vars = {}

  function align8(n) {
    return (n + 7) & ~7
  }

  function readTag() {
    const a = curBuf.readUInt32LE(off)
    const b = curBuf.readUInt32LE(off + 4)
    if ((a & 0xffff0000) !== 0) {
      // small data element format: [size<<16 | type], data in next 4 bytes
      const type = a & 0xffff
      const size = a >>> 16
      off += 8
      return { type, size, small: true, smallData: curBuf.slice(off - 4, off - 4 + size) }
    }
    const type = a
    const size = b
    off += 8
    return { type, size, small: false }
  }

  function readBytes(n) {
    const out = curBuf.slice(off, off + n)
    off += n
    const pad = align8(n) - n
    off += pad
    return out
  }

  function readElement() {
    const tag = readTag()
    if (tag.small) {
      return { type: tag.type, data: tag.smallData }
    }
    const data = readBytes(tag.size)
    return { type: tag.type, data }
  }

  function parseMatrix(dataBuf) {
    let o = 0
    const align = (n) => (n + 7) & ~7

    function readTagAt() {
      const a = dataBuf.readUInt32LE(o)
      const b = dataBuf.readUInt32LE(o + 4)
      if ((a & 0xffff0000) !== 0) {
        const type = a & 0xffff
        const size = a >>> 16
        const payload = dataBuf.slice(o + 4, o + 4 + size)
        o += 8
        return { type, size, payload, small: true }
      }
      const type = a
      const size = b
      o += 8
      const payload = dataBuf.slice(o, o + size)
      o += align(size)
      return { type, size, payload, small: false }
    }

    const miMATRIX = 14
    const miINT8 = 1
    const miINT32 = 5
    const miUINT32 = 6
    const miDOUBLE = 9

    // array flags
    const flagsEl = readTagAt()
    if (flagsEl.type !== miUINT32 || flagsEl.payload.length < 8) throw new Error('MAT: invalid flags')
    const flags0 = flagsEl.payload.readUInt32LE(0)
    const cls = flags0 & 0xff

    // dims
    const dimsEl = readTagAt()
    if (dimsEl.type !== miINT32 || dimsEl.payload.length < 8) throw new Error('MAT: invalid dims')
    const dims = []
    for (let i = 0; i < dimsEl.payload.length; i += 4) dims.push(dimsEl.payload.readInt32LE(i))

    // name
    const nameEl = readTagAt()
    if (nameEl.type !== miINT8) throw new Error('MAT: invalid name')
    const name = nameEl.payload.toString('utf-8')

    const mxSTRUCT = 2
    const mxDOUBLE = 6

    if (cls === mxDOUBLE) {
      const realEl = readTagAt()
      if (realEl.type !== miDOUBLE) throw new Error('MAT: expected double data')
      const out = []
      for (let i = 0; i < realEl.payload.length; i += 8) out.push(realEl.payload.readDoubleLE(i))
      return { name, dims, value: out }
    }

    if (cls === mxSTRUCT) {
      const fieldLenEl = readTagAt()
      if (fieldLenEl.type !== miINT32 || fieldLenEl.payload.length < 4) throw new Error('MAT: bad fieldlen')
      const fieldNameLen = fieldLenEl.payload.readInt32LE(0)
      const fieldNamesEl = readTagAt()
      if (fieldNamesEl.type !== miINT8) throw new Error('MAT: bad fieldnames')
      const fieldNamesRaw = fieldNamesEl.payload
      const nFields = Math.floor(fieldNamesRaw.length / fieldNameLen)
      const fieldNames = []
      for (let i = 0; i < nFields; i++) {
        const start = i * fieldNameLen
        const s = fieldNamesRaw.slice(start, start + fieldNameLen).toString('utf-8').replace(/\x00+$/, '')
        fieldNames.push(s)
      }

      const nElems = (dims[0] || 1) * (dims[1] || 1)
      if (nElems !== 1) throw new Error('MAT: only supports 1x1 struct')

      const obj = {}
      for (const fname of fieldNames) {
        const fieldEl = readTagAt()
        if (fieldEl.type !== miMATRIX) throw new Error('MAT: expected miMATRIX for field')
        const parsed = parseMatrix(fieldEl.payload)
        obj[fname] = parsed.value
      }
      return { name, dims, value: obj }
    }

    throw new Error(`MAT: unsupported class ${cls}`)
  }

  function parseElements(buf2, startOff) {
    curBuf = buf2
    off = startOff
    while (off + 8 <= buf2.length) {
      const el = readElement()
      if (el.type === 15) {
        const inflated = zlib.inflateSync(el.data)
        parseElements(inflated, 0)
        continue
      }
      if (el.type !== 14) continue
      const m = parseMatrix(el.data)
      vars[m.name] = m.value
    }
  }

  // Parse top-level elements (skip 128-byte header).
  parseElements(buf, 128)
  return vars
}

function loadSyntheticOcvFromMat(filePath) {
  const vars = readMatV5(fs.readFileSync(filePath))
  const data = vars.data
  if (!data || !Array.isArray(data.capacity) || !Array.isArray(data.ocv)) throw new Error('MAT missing data.capacity/data.ocv')
  if (data.capacity.length !== data.ocv.length) throw new Error('capacity/ocv length mismatch')
  return { capacity: data.capacity, ocv: data.ocv }
}

function loadOcvFromMatBuffer(buf) {
  const vars = readMatV5(buf)
  const data = vars.data
  if (!data || !Array.isArray(data.capacity) || !Array.isArray(data.ocv)) throw new Error('MAT missing data.capacity/data.ocv')
  if (data.capacity.length !== data.ocv.length) throw new Error('capacity/ocv length mismatch')
  return { capacity: data.capacity, ocv: data.ocv }
}

function solve2(fun, x0) {
  let x = [x0[0], x0[1]]
  let f = fun(x)
  const norm = (v) => Math.hypot(v[0], v[1])

  const tol = 1e-10
  for (let iter = 0; iter < 60; iter++) {
    const fn = norm(f)
    if (!Number.isFinite(fn)) return null
    if (fn < tol) return x

    const eps = 1e-6
    const f0 = f
    const fDx0 = fun([x[0] + eps, x[1]])
    const fDx1 = fun([x[0], x[1] + eps])

    const j00 = (fDx0[0] - f0[0]) / eps
    const j10 = (fDx0[1] - f0[1]) / eps
    const j01 = (fDx1[0] - f0[0]) / eps
    const j11 = (fDx1[1] - f0[1]) / eps

    const det = j00 * j11 - j01 * j10
    if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null

    const dx0 = (-j11 * f0[0] + j01 * f0[1]) / det
    const dx1 = (j10 * f0[0] - j00 * f0[1]) / det

    let alpha = 1.0
    let improved = false
    while (alpha >= 1e-3) {
      const xn = [x[0] + alpha * dx0, x[1] + alpha * dx1]
      const fnv = fun(xn)
      const fnn = norm(fnv)
      if (Number.isFinite(fnn) && fnn < fn) {
        x = xn
        f = fnv
        improved = true
        break
      }
      alpha *= 0.5
    }

    if (!improved) return null
  }

  return null
}
function buildPristine(profile) {
  const hasEmbedded = Boolean(profile.halfcell_csv && (profile.halfcell_csv.pe_csv_text || profile.halfcell_csv.ne_csv_text))

  let pe
  let ne
  if (hasEmbedded) {
    pe = readHalfCellCsvText(String(profile.halfcell_csv.pe_csv_text || ''), `${profile.id}:pe_csv_text`)
    ne = readHalfCellCsvText(String(profile.halfcell_csv.ne_csv_text || ''), `${profile.id}:ne_csv_text`)
  } else {
    const pePath = resolveDataPath(profile.files.nmc_csv || profile.files.pe_csv)
    const nePath = resolveDataPath(profile.files.gra_csv || profile.files.ne_csv)
    pe = readHalfCellCsv(pePath)
    ne = readHalfCellCsv(nePath)
  }

  const peInterp = pchipInit(pe.sol, pe.ocv)
  const neInterp = pchipInit(ne.sol, ne.ocv)

  const endpoints = normalizeEndpoints(profile.endpoints)
  const numPoints = (profile.grid && profile.grid.num_points) || 1001

  const xGrid = linspace(0, 1, numPoints)

  function solFromX(eoc, eod, x) {
    return eoc + x * (eod - eoc)
  }

  function ocvPeFromX(x) {
    const sol = solFromX(endpoints.sol_pe_eoc, endpoints.sol_pe_eod, x)
    return peInterp.evalAt(sol)
  }

  function ocvNeFromX(x) {
    const sol = solFromX(endpoints.sol_ne_eoc, endpoints.sol_ne_eod, x)
    return neInterp.evalAt(sol)
  }

  const ocvPe = xGrid.map(ocvPeFromX)
  const ocvNe = xGrid.map(ocvNeFromX)
  const ocvCell = ocvPe.map((v, i) => v - ocvNe[i])

  const vMax = ocvCell[0]
  const vMin = ocvCell[ocvCell.length - 1]

  const xBoundsForSol = (solMin, solMax, solEoc, solEod) => {
    const denom = solEod - solEoc
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-15) return { xMin: NaN, xMax: NaN }
    const x1 = (solMin - solEoc) / denom
    const x2 = (solMax - solEoc) / denom
    return { xMin: Math.min(x1, x2), xMax: Math.max(x1, x2) }
  }

  const peSolMin = Math.min(...pe.sol)
  const peSolMax = Math.max(...pe.sol)
  const neSolMin = Math.min(...ne.sol)
  const neSolMax = Math.max(...ne.sol)

  const peX = xBoundsForSol(peSolMin, peSolMax, endpoints.sol_pe_eoc, endpoints.sol_pe_eod)
  const neX = xBoundsForSol(neSolMin, neSolMax, endpoints.sol_ne_eoc, endpoints.sol_ne_eod)

  return {
    profile_id: profile.id,
    xGrid,
    ocvPe,
    ocvNe,
    ocvCell,
    vMax,
    vMin,
    endpoints,
    pe: {
      ...pe,
      solMin: peSolMin,
      solMax: peSolMax,
      xMin: peX.xMin,
      xMax: peX.xMax,
      interp: peInterp,
    },
    ne: {
      ...ne,
      solMin: neSolMin,
      solMax: neSolMax,
      xMin: neX.xMin,
      xMax: neX.xMax,
      interp: neInterp,
    },
  }
}

function calcDegraded(pristine, lli, lamPe, lamNe, numPoints) {
  if (1 - lamPe <= 0 || 1 - lamNe <= 0) return null

  const Vmax = pristine.vMax
  const Vmin = pristine.vMin

  function ocvPeFromX(x) {
    const sol = pristine.endpoints.sol_pe_eoc + x * (pristine.endpoints.sol_pe_eod - pristine.endpoints.sol_pe_eoc)
    return pristine.pe.interp.evalAt(sol)
  }

  function ocvNeFromX(x) {
    const sol = pristine.endpoints.sol_ne_eoc + x * (pristine.endpoints.sol_ne_eod - pristine.endpoints.sol_ne_eoc)
    return pristine.ne.interp.evalAt(sol)
  }

  const fun = (vars) => {
    const dxEoc = vars[0]
    const dxEod = vars[1]

    const eqVmax = Vmax - ocvPeFromX(dxEoc / (1 - lamPe)) + ocvNeFromX((dxEoc + lli - lamNe) / (1 - lamNe))
    const eqVmin = Vmin - ocvPeFromX((dxEod + 1 - lli) / (1 - lamPe)) + ocvNeFromX((dxEod + 1 - lamNe) / (1 - lamNe))
    return [eqVmax, eqVmin]
  }

  const sol = solve2(fun, [0, 0])
  if (!sol) return null

  const deltaX_eoc = sol[0]
  const deltaX_eod = sol[1]

  const xPeEoc = deltaX_eoc / (1 - lamPe)
  const xPeEod = (deltaX_eod + 1 - lli) / (1 - lamPe)
  const xNeEoc = (deltaX_eoc + lli - lamNe) / (1 - lamNe)
  const xNeEod = (deltaX_eod + 1 - lamNe) / (1 - lamNe)

  const xCellEoc = deltaX_eoc
  const xCellEod = 1 - lli + deltaX_eod
  if (!Number.isFinite(xCellEoc) || !Number.isFinite(xCellEod) || xCellEod <= xCellEoc) return null

  const capacityNorm = linspace(xCellEoc, xCellEod, numPoints)
  const frac = capacityNorm.map((x) => (x - xCellEoc) / (xCellEod - xCellEoc))

  const xPe = frac.map((f) => xPeEoc + f * (xPeEod - xPeEoc))
  const xNe = frac.map((f) => xNeEoc + f * (xNeEod - xNeEoc))

  const ocvPe = xPe.map(ocvPeFromX)
  const ocvNe = xNe.map(ocvNeFromX)
  const ocvCell = ocvPe.map((v, i) => v - ocvNe[i])

  return {
    lli,
    lamPe,
    lamNe,
    deltaX_eoc,
    deltaX_eod,
    xCellEoc,
    xCellEod,
    cellCapacity: xCellEod - xCellEoc,
    xPeEoc,
    xPeEod,
    xNeEoc,
    xNeEod,
    capacityNorm,
    ocvCell,
  }
}

function diagnosticsGradientMask(measuredCapacity, measuredOcv, gradientLimit) {
  const n = measuredCapacity.length
  const out = new Array(n).fill(false)
  for (let i = 0; i < n - 1; i++) {
    const socDiff = Math.abs((measuredCapacity[i + 1] - measuredCapacity[i]) * 100)
    const ocvDiff = Math.abs(measuredOcv[i + 1] - measuredOcv[i])
    const denom = Math.max(1e-12, socDiff)
    const g = ocvDiff / denom
    out[i] = g < gradientLimit
  }
  out[n - 1] = false
  return out
}

function normalizeCapacityForGradientMask(capacity, capacityIsNormalized) {
  if (capacityIsNormalized) return capacity
  const max = Math.max(...capacity)
  if (!Number.isFinite(max) || max <= 0) return capacity
  return capacity.map((x) => x / max)
}

function rmseOnMask(pred, meas, mask) {
  let sum = 0
  let cnt = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const e = pred[i] - meas[i]
    if (!Number.isFinite(e)) continue
    sum += e * e
    cnt += 1
  }
  if (cnt === 0) return null
  return Math.sqrt(sum / cnt)
}

function nelderMead(obj, x0, opts) {
  const maxIter = Math.max(20, Number(opts.maxIter || 200))
  const tol = Number(opts.tol || 1e-6)
  const step = Number(opts.step || 0.08)

  const n = x0.length
  const simplex = []
  simplex.push(x0.slice())
  for (let i = 0; i < n; i++) {
    const v = x0.slice()
    v[i] = clamp01(v[i] + step)
    simplex.push(v)
  }

  const f = simplex.map((x) => obj(x))

  const alpha = 1
  const gamma = 2
  const rho = 0.5
  const sigma = 0.5

  function sortSimplex() {
    const idx = simplex.map((_v, i) => i).sort((a, b) => f[a] - f[b])
    const s2 = idx.map((i) => simplex[i])
    const f2 = idx.map((i) => f[i])
    for (let i = 0; i < simplex.length; i++) simplex[i] = s2[i]
    for (let i = 0; i < f.length; i++) f[i] = f2[i]
  }

  function centroid(excludeLast) {
    const m = excludeLast ? simplex.length - 1 : simplex.length
    const c = new Array(n).fill(0)
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) c[j] += simplex[i][j]
    }
    for (let j = 0; j < n; j++) c[j] /= m
    return c
  }

  function addScaled(a, b, k) {
    const out = new Array(n)
    for (let i = 0; i < n; i++) out[i] = clamp01(a[i] + k * (a[i] - b[i]))
    return out
  }

  for (let iter = 0; iter < maxIter; iter++) {
    sortSimplex()

    const fBest = f[0]
    const fWorst = f[f.length - 1]
    if (!Number.isFinite(fBest) || !Number.isFinite(fWorst)) break
    if (Math.abs(fWorst - fBest) < tol) break

    const c = centroid(true)
    const xWorst = simplex[simplex.length - 1]

    const xr = addScaled(c, xWorst, alpha)
    const fr = obj(xr)

    if (fr < f[0]) {
      const xe = addScaled(c, xWorst, gamma)
      const fe = obj(xe)
      if (fe < fr) {
        simplex[simplex.length - 1] = xe
        f[f.length - 1] = fe
      } else {
        simplex[simplex.length - 1] = xr
        f[f.length - 1] = fr
      }
      continue
    }

    if (fr < f[f.length - 2]) {
      simplex[simplex.length - 1] = xr
      f[f.length - 1] = fr
      continue
    }

    // contraction
    const xc = addScaled(c, xWorst, -rho)
    const fc = obj(xc)
    if (fc < fWorst) {
      simplex[simplex.length - 1] = xc
      f[f.length - 1] = fc
      continue
    }

    // shrink
    for (let i = 1; i < simplex.length; i++) {
      for (let j = 0; j < n; j++) simplex[i][j] = clamp01(simplex[0][j] + sigma * (simplex[i][j] - simplex[0][j]))
      f[i] = obj(simplex[i])
    }
  }

  sortSimplex()
  return { x: simplex[0], fun: f[0] }
}

function estimateDiagnostics(pristine, measured, opts) {
  const cap = measured.capacity
  const ocv = measured.ocv

  const capForMask = normalizeCapacityForGradientMask(cap, Boolean(opts.capacityIsNormalized))
  const maskFlat = diagnosticsGradientMask(capForMask, ocv, opts.gradientLimit)
  if (!maskFlat.some(Boolean)) return { ok: false, reason: 'no_flat_region', maskFlat }

  const nGrid = opts.numPoints
  const penalty = 1e6

  function objective(theta) {
    const lli = clamp01(theta[0])
    const lamPe = clamp01(theta[1])
    const lamNe = clamp01(theta[2])
    const degraded = calcDegraded(pristine, lli, lamPe, lamNe, nGrid)
    if (!degraded || !(degraded.cellCapacity > 0) || !Number.isFinite(degraded.cellCapacity)) return penalty

    const predCap = degraded.capacityNorm.map((x) => x - degraded.xCellEoc)
    const predOcv = degraded.ocvCell

    const capQ = Boolean(opts.capacityIsNormalized) ? cap.map((x) => x * degraded.cellCapacity) : cap
    const predAt = capQ.map((x) => interp1Linear(predCap, predOcv, x))
    const rmse = rmseOnMask(predAt, ocv, maskFlat)
    if (rmse === null || !Number.isFinite(rmse)) return penalty
    return rmse
  }

  const rand = makeRng(opts.seed)
  const numStarts = Math.max(1, Math.floor(opts.numStarts))
  let best = { x: [0.1, 0.1, 0.1], fun: objective([0.1, 0.1, 0.1]) }
  let startsSuccess = Number.isFinite(best.fun) ? 1 : 0

  for (let i = 0; i < numStarts; i++) {
    const x0 = [rand(), rand(), rand()]
    const res = nelderMead(objective, x0, { maxIter: opts.maxIter, tol: opts.tol })
    if (Number.isFinite(res.fun)) startsSuccess += 1
    if (Number.isFinite(res.fun) && res.fun < best.fun) best = res
  }

  if (!Number.isFinite(best.fun)) return { ok: false, reason: 'optimizer_failed', maskFlat }

  const theta = { LLI: clamp01(best.x[0]), LAM_PE: clamp01(best.x[1]), LAM_NE: clamp01(best.x[2]) }
  const degradedBest = calcDegraded(pristine, theta.LLI, theta.LAM_PE, theta.LAM_NE, nGrid)
  if (!degradedBest) return { ok: false, reason: 'invalid_best', maskFlat }

  const predCap = degradedBest.capacityNorm.map((x) => x - degradedBest.xCellEoc)
  const capQFinal = Boolean(opts.capacityIsNormalized) ? cap.map((x) => x * degradedBest.cellCapacity) : cap
  const predAt = capQFinal.map((x) => interp1Linear(predCap, degradedBest.ocvCell, x))

  return {
    ok: true,
    theta,
    rmseV: best.fun,
    maskFlat,
    predictedAtMeasured: predAt,
    degraded: degradedBest,
    startsTried: numStarts + 1,
    startsSuccess,
  }
}

function buildPlotAxis(pristine, degraded, pad) {
  const pristineX = pristine.xGrid
  let xmin = Math.min(...pristineX)
  let xmax = Math.max(...pristineX)

  // Extend x-range to show the full valid plotting range of half-cell curves,
  // even if that means x < 0 or x > 1. We still avoid plotting extrapolated
  // half-cell OCV by masking out-of-domain SOL later.
  //
  // For pristine: x == electrode-x, and SOL(x) is linear.
  // For degraded: electrode-x is linear in cell-x over the degraded window;
  // we extrapolate that linear mapping only to compute a plot axis extent.
  const addBounds = (a, b) => {
    if (Number.isFinite(a)) xmin = Math.min(xmin, a)
    if (Number.isFinite(b)) xmax = Math.max(xmax, b)
  }

  const linMapXForSolRange = (solEoc, solEod, solMin, solMax) => {
    const denom = solEod - solEoc
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-15) return null
    const x1 = (solMin - solEoc) / denom
    const x2 = (solMax - solEoc) / denom
    return [Math.min(x1, x2), Math.max(x1, x2)]
  }

  // Pristine half-cell ranges (in cell-x units).
  const prPeX = Number.isFinite(pristine.pe?.xMin) && Number.isFinite(pristine.pe?.xMax) ? [pristine.pe.xMin, pristine.pe.xMax] : null
  const prNeX = Number.isFinite(pristine.ne?.xMin) && Number.isFinite(pristine.ne?.xMax) ? [pristine.ne.xMin, pristine.ne.xMax] : null
  if (prPeX) addBounds(prPeX[0], prPeX[1])
  if (prNeX) addBounds(prNeX[0], prNeX[1])

  if (degraded) {
    // Always include degraded full-cell utilization window.
    addBounds(degraded.xCellEoc, degraded.xCellEod)

    const mapElectrodeXToCellX = (xElec, xElecEoc, xElecEod, xCellEoc, xCellEod) => {
      const denom = xElecEod - xElecEoc
      if (!Number.isFinite(denom) || Math.abs(denom) < 1e-15) return null
      const t = (xElec - xElecEoc) / denom
      return xCellEoc + t * (xCellEod - xCellEoc)
    }

    // Degraded half-cell ranges, converted to cell-x using the linear mapping.
    if (prPeX) {
      const a = mapElectrodeXToCellX(prPeX[0], degraded.xPeEoc, degraded.xPeEod, degraded.xCellEoc, degraded.xCellEod)
      const b = mapElectrodeXToCellX(prPeX[1], degraded.xPeEoc, degraded.xPeEod, degraded.xCellEoc, degraded.xCellEod)
      if (a !== null && b !== null) addBounds(Math.min(a, b), Math.max(a, b))
    }
    if (prNeX) {
      const a = mapElectrodeXToCellX(prNeX[0], degraded.xNeEoc, degraded.xNeEod, degraded.xCellEoc, degraded.xCellEod)
      const b = mapElectrodeXToCellX(prNeX[1], degraded.xNeEoc, degraded.xNeEod, degraded.xCellEoc, degraded.xCellEod)
      if (a !== null && b !== null) addBounds(Math.min(a, b), Math.max(a, b))
    }
  }

  const n = pristineX.length
  if (!pad) return linspace(xmin, xmax, n)
  const span = Math.max(1e-9, xmax - xmin)
  const padAmt = 0.02 * span
  return linspace(xmin - padAmt, xmax + padAmt, n)
}

function mapCurves(pristine, degraded, xPlot) {
  const out = {}
  const isIn = (x, a, b) => x >= a && x <= b

  // Pristine: evaluate across the full xPlot range, but do not show any
  // extrapolation beyond the half-cell CSV interpolation domains.
  const solPePr = xPlot.map(
    (x) => pristine.endpoints.sol_pe_eoc + x * (pristine.endpoints.sol_pe_eod - pristine.endpoints.sol_pe_eoc),
  )
  const solNePr = xPlot.map(
    (x) => pristine.endpoints.sol_ne_eoc + x * (pristine.endpoints.sol_ne_eod - pristine.endpoints.sol_ne_eoc),
  )
  const prPeMask = solPePr.map((s) => s >= pristine.pe.solMin && s <= pristine.pe.solMax)
  const prNeMask = solNePr.map((s) => s >= pristine.ne.solMin && s <= pristine.ne.solMax)

  const prPe = solPePr.map((s, i) => (prPeMask[i] ? pristine.pe.interp.evalAt(s) : null))
  const prNe = solNePr.map((s, i) => (prNeMask[i] ? pristine.ne.interp.evalAt(s) : null))

  const prCellMask = prPeMask.map((v, i) => Boolean(v && prNeMask[i]))
  const prCell = prPe.map((v, i) => (prCellMask[i] ? v - prNe[i] : null))

  out.pristine = {
    cell: { x: xPlot, ocv: prCell, mask_valid: prCellMask },
    pe: { x: xPlot, ocv: prPe, mask_valid: prPeMask },
    ne: { x: xPlot, ocv: prNe, mask_valid: prNeMask },
  }

  if (!degraded) {
    out.degraded = { valid: false }
    return out
  }

  const degMask = xPlot.map((x) => isIn(x, degraded.xCellEoc, degraded.xCellEod))

  const frac = xPlot.map((x) => (x - degraded.xCellEoc) / (degraded.xCellEod - degraded.xCellEoc))
  const xPe = frac.map((f) => degraded.xPeEoc + f * (degraded.xPeEod - degraded.xPeEoc))
  const xNe = frac.map((f) => degraded.xNeEoc + f * (degraded.xNeEod - degraded.xNeEoc))

  const solPe = xPe.map((x) => pristine.endpoints.sol_pe_eoc + x * (pristine.endpoints.sol_pe_eod - pristine.endpoints.sol_pe_eoc))
  const solNe = xNe.map((x) => pristine.endpoints.sol_ne_eoc + x * (pristine.endpoints.sol_ne_eod - pristine.endpoints.sol_ne_eoc))

  const peOcvAll = solPe.map((s) => pristine.pe.interp.evalAt(s))
  const neOcvAll = solNe.map((s) => pristine.ne.interp.evalAt(s))

  // no extrapolated plotting
  // For visualization, allow degraded curves to extend beyond x_cell_eoc/eod.
  // We still never plot half-cell extrapolation: only show points where SOL
  // is within the CSV domain.
  const peMask = solPe.map((s) => s >= pristine.pe.solMin && s <= pristine.pe.solMax)
  const neMask = solNe.map((s) => s >= pristine.ne.solMin && s <= pristine.ne.solMax)

  const degPe = peOcvAll.map((v, i) => (peMask[i] ? v : null))
  const degNe = neOcvAll.map((v, i) => (neMask[i] ? v : null))

  // Degraded full-cell curve for plotting: derived from PE/NE and masked to
  // avoid showing extrapolated half-cell regions.
  const degCellMask = peMask.map((v, i) => Boolean(v && neMask[i]))
  const degCell = peOcvAll.map((v, i) => (degCellMask[i] ? v - neOcvAll[i] : null))

  out.degraded = {
    valid: true,
    theta: { LLI: degraded.lli, LAM_PE: degraded.lamPe, LAM_NE: degraded.lamNe },
    results: {
      delta_x_eoc: degraded.deltaX_eoc,
      delta_x_eod: degraded.deltaX_eod,
      x_cell_eoc: degraded.xCellEoc,
      x_cell_eod: degraded.xCellEod,
      cell_capacity: degraded.cellCapacity,
      endpoints: {
        x_pe_eoc: degraded.xPeEoc,
        x_pe_eod: degraded.xPeEod,
        x_ne_eoc: degraded.xNeEoc,
        x_ne_eod: degraded.xNeEod,
      },
    },
    cell: { x: xPlot, ocv: degCell, mask_valid: degCellMask },
    pe: { x: xPlot, ocv: degPe, mask_valid: peMask },
    ne: { x: xPlot, ocv: degNe, mask_valid: neMask },
  }

  return out
}
app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('/pristine/catalog', (_req, res) => {
  const profiles = [...loadProfiles().values()]
  res.json({ profiles })
})

app.get('/halfcell/sample', (_req, res) => {
  try {
    const nmcPath = path.join(HALFCELL_DIR, 'NMC.csv')
    const graPath = path.join(HALFCELL_DIR, 'GRA.csv')
    if (!fs.existsSync(nmcPath) || !fs.existsSync(graPath)) return res.status(404).send('Sample CSVs not found')
    const nmc = fs.readFileSync(nmcPath, 'utf-8')
    const gra = fs.readFileSync(graPath, 'utf-8')
    return res.json({
      ok: true,
      pe_csv_text: nmc,
      ne_csv_text: gra,
      // Backward compatibility
      nmc_csv_text: nmc,
      gra_csv_text: gra,
    })
  } catch (e) {
    return res.status(500).send(String(e && e.message ? e.message : e))
  }
})

app.post('/pristine/create', (req, res) => {
  try {
    const body = req.body || {}

    const name = String(body.name || '').trim()
    if (!name) return res.status(400).send('Missing name')

    const endpoints = body.endpoints || {}
    const normEndpoints = normalizeEndpoints(endpoints)
    const sol_pe_eoc = requireFiniteNumber(normEndpoints.sol_pe_eoc, 'sol_pe_eoc (or sol_nmc_eoc)')
    const sol_pe_eod = requireFiniteNumber(normEndpoints.sol_pe_eod, 'sol_pe_eod (or sol_nmc_eod)')
    const sol_ne_eoc = requireFiniteNumber(normEndpoints.sol_ne_eoc, 'sol_ne_eoc (or sol_gra_eoc)')
    const sol_ne_eod = requireFiniteNumber(normEndpoints.sol_ne_eod, 'sol_ne_eod (or sol_gra_eod)')

    const peCsvText = String(body.pe_csv_text || body.nmc_csv_text || '')
    const neCsvText = String(body.ne_csv_text || body.gra_csv_text || '')
    if (!peCsvText.trim()) return res.status(400).send('Missing pe_csv_text')
    if (!neCsvText.trim()) return res.status(400).send('Missing ne_csv_text')

    ensureDir(PRISTINE_DIR)

    const ts = Math.floor(Date.now() / 1000)
    const base = safeId(name) || `cell_${ts}`
    let id = `${base}_${ts}`
    let jsonPath = path.join(PRISTINE_DIR, `${id}.json`)
    let tries = 0
    while (fs.existsSync(jsonPath) && tries < 10) {
      tries += 1
      id = `${base}_${ts}_${tries}`
      jsonPath = path.join(PRISTINE_DIR, `${id}.json`)
    }

    // Validate the CSVs are parseable.
    readHalfCellCsvText(peCsvText, `${id}:pe_csv_text`)
    readHalfCellCsvText(neCsvText, `${id}:ne_csv_text`)

    const profile = {
      id,
      name,
      files: {},
      halfcell_csv: {
        pe_csv_text: peCsvText,
        ne_csv_text: neCsvText,
      },
      endpoints: {
        sol_pe_eoc,
        sol_pe_eod,
        sol_ne_eoc,
        sol_ne_eod,
        // Backward compatibility
        sol_nmc_eoc: sol_pe_eoc,
        sol_nmc_eod: sol_pe_eod,
        sol_gra_eoc: sol_ne_eoc,
        sol_gra_eod: sol_ne_eod,
      },
      grid: {
        num_points: 1001,
      },
      created_at: nowIsoNoMs(),
    }

    fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2), 'utf-8')
    return res.json({ ok: true, profile })
  } catch (e) {
    return res.status(500).send(String(e && e.message ? e.message : e))
  }
})

app.post('/pristine/delete', (req, res) => {
  const id = String(req.body?.id || '')
  if (!id) return res.status(400).send('Missing id')
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).send('Invalid id')

  const found = findPristineProfileFile(id)
  if (!found) return res.status(404).send(`Unknown pristine id: ${id}`)

  const { filePath, profile } = found

  try {
    fs.unlinkSync(filePath)
  } catch (e) {
    return res.status(500).send(String(e && e.message ? e.message : e))
  }

  // Best-effort cleanup: only delete per-profile CSVs that clearly belong to this id.
  const maybeCsvRefs = []
  const files = profile?.files || {}
  for (const k of ['nmc_csv', 'gra_csv', 'pe_csv', 'ne_csv']) {
    if (typeof files[k] === 'string' && files[k].trim()) maybeCsvRefs.push(files[k])
  }

  for (const ref of maybeCsvRefs) {
    try {
      const abs = resolveDataPath(ref)
      const relToHalfcell = path.relative(HALFCELL_DIR, abs)
      if (relToHalfcell.startsWith('..') || path.isAbsolute(relToHalfcell)) continue
      const base = path.basename(abs)
      if (!base.startsWith(`${id}_`) || !base.toLowerCase().endsWith('.csv')) continue
      if (fs.existsSync(abs)) fs.unlinkSync(abs)
    } catch {
      // ignore
    }
  }

  return res.json({ ok: true })
})

app.post('/ocv/curves', (req, res) => {
  try {
    const body = req.body || {}
    const pristineId = String(body.pristine_id || '')
    const lli = Number(body.lli)
    const lamPe = Number(body.lam_pe)
    const lamNe = Number(body.lam_ne)

    const profiles = loadProfiles()
    const profile = profiles.get(pristineId)
    if (!profile) return res.status(404).send(`Unknown pristine_id: ${pristineId}`)

    const pristine = buildPristine(profile)
    const n = Number.isFinite(body.num_points)
      ? Math.max(101, Math.min(5001, Number(body.num_points)))
      : pristine.xGrid.length

    const degraded = calcDegraded(pristine, lli, lamPe, lamNe, n)
    const xPlot = buildPlotAxis(pristine, degraded, Boolean(body.include_plot_domain_padding))

    const mapped = mapCurves(pristine, degraded, xPlot)

    res.json({
      pristine_id: profile.id,
      theta_deg: { LLI: lli, LAM_PE: lamPe, LAM_NE: lamNe },
      x_axis: {
        kind: 'pristine_normalized_capacity_units',
        note: 'All curves mapped onto pristine capacity units; axis may extend beyond [0,1].',
        range: [xPlot[0], xPlot[xPlot.length - 1]],
      },
      limits: {
        v_max: pristine.vMax,
        v_min: pristine.vMin,
      },
      pristine: mapped.pristine,
      degraded: mapped.degraded,
    })
  } catch (e) {
    res.status(500).send(String(e && e.message ? e.message : e))
  }
})

app.get('/diagnostics/sample', (_req, res) => {
  try {
    const repoRoot = path.resolve(__dirname, '../..')
    const matPath = path.resolve(repoRoot, 'matlab/synthetic_ocv.mat')
    if (!fs.existsSync(matPath)) return res.status(404).send('matlab/synthetic_ocv.mat not found')
    const data = loadSyntheticOcvFromMat(matPath)
    return res.json({ ok: true, data })
  } catch (e) {
    return res.status(500).send(String(e && e.message ? e.message : e))
  }
})

app.post('/diagnostics/parse', (req, res) => {
  try {
    const body = req.body || {}
    if (typeof body.mat_base64 !== 'string' || !String(body.mat_base64).trim()) return res.status(400).send('Missing mat_base64')
    const buf = Buffer.from(String(body.mat_base64).trim(), 'base64')
    const data = loadOcvFromMatBuffer(buf)
    return res.json({ ok: true, data })
  } catch (e) {
    return res.status(500).send(String(e && e.message ? e.message : e))
  }
})

app.post('/diagnostics/estimate', (req, res) => {
  try {
    const body = req.body || {}
    const pristineId = String(body.pristine_id || '')
    if (!pristineId) return res.status(400).send('Missing pristine_id')

    const profiles = loadProfiles()
    const profile = profiles.get(pristineId)
    if (!profile) return res.status(404).send(`Unknown pristine_id: ${pristineId}`)

    const pristine = buildPristine(profile)

    let measured = body.measured
    if (!measured && body.use_sample) {
      const repoRoot = path.resolve(__dirname, '../..')
      const matPath = path.resolve(repoRoot, 'matlab/synthetic_ocv.mat')
      measured = loadSyntheticOcvFromMat(matPath)
    }
    if (!measured && typeof body.mat_base64 === 'string' && body.mat_base64.trim()) {
      const raw = String(body.mat_base64).trim()
      const buf = Buffer.from(raw, 'base64')
      measured = loadOcvFromMatBuffer(buf)
    }

    const cap = Array.isArray(measured?.capacity) ? measured.capacity.map(Number) : null
    const ocv = Array.isArray(measured?.ocv) ? measured.ocv.map(Number) : null
    if (!cap || !ocv) return res.status(400).send('Missing measured.capacity/measured.ocv (or set use_sample=true or provide mat_base64)')
    if (cap.length !== ocv.length) return res.status(400).send('measured.capacity and measured.ocv length mismatch')

    const maskFinite = cap.map((x, i) => Number.isFinite(x) && Number.isFinite(ocv[i]))
    const capF = []
    const ocvF = []
    for (let i = 0; i < maskFinite.length; i++) {
      if (!maskFinite[i]) continue
      capF.push(cap[i])
      ocvF.push(ocv[i])
    }
    if (capF.length < 3) return res.status(400).send('Need at least 3 finite measured points')

    // sort by capacity
    const idx = capF.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
    const capS = idx.map(([_, i]) => capF[i])
    const ocvS = idx.map(([_, i]) => ocvF[i])

    const numPoints = Number.isFinite(body.num_points) ? Math.max(101, Math.min(5001, Number(body.num_points))) : pristine.xGrid.length
    const numStarts = Number.isFinite(body.num_starts) ? Math.max(1, Math.min(5000, Math.floor(Number(body.num_starts)))) : 100
    const gradientLimit = Number.isFinite(body.gradient_limit) ? Number(body.gradient_limit) : 0.1
    const maxIter = Number.isFinite(body.maxiter) ? Math.max(20, Math.min(20000, Math.floor(Number(body.maxiter)))) : 200
    const seed = body.seed == null ? 0 : Number(body.seed)
    const capacityIsNormalized = Boolean(body.capacity_is_normalized)

    const est = estimateDiagnostics(pristine, { capacity: capS, ocv: ocvS }, { numPoints, numStarts, gradientLimit, maxIter, seed, tol: 1e-6, capacityIsNormalized })
    if (!est.ok) {
      return res.json({
        valid: false,
        pristine_id: pristineId,
        measured: { capacity: capS, ocv: ocvS, mask_flat: est.maskFlat },
        debug: { reason: est.reason },
      })
    }

    const xPristine = pristine.xGrid
    const yPristine = new Array(xPristine.length).fill(null)
    const deg = est.degraded
    for (let i = 0; i < xPristine.length; i++) {
      const x = xPristine[i]
      if (x < deg.xCellEoc || x > deg.xCellEod) continue
      yPristine[i] = interp1Linear(deg.capacityNorm, deg.ocvCell, x)
    }

    // For UI plotting on pristine-x: map measured capacity axis to pristine-x by shifting by x_cell_eoc.
    // If the measurement is normalized (0..1), first scale by the degraded cell capacity.
    const capForPlot = capacityIsNormalized ? capS.map((x) => x * deg.cellCapacity) : capS
    const measXPristine = capForPlot.map((x) => x + deg.xCellEoc)

    return res.json({
      valid: true,
      pristine_id: pristineId,
      theta_deg: est.theta,
      rmse_v: est.rmseV,
      measured: { capacity: capS, ocv: ocvS, mask_flat: est.maskFlat, capacity_is_normalized: capacityIsNormalized, x_pristine: measXPristine },
      predicted: { capacity: capS, ocv: est.predictedAtMeasured, mask_valid: est.maskFlat },
      predicted_pristine: { x: xPristine, ocv: yPristine },
      debug: { starts_tried: est.startsTried, starts_success: est.startsSuccess },
    })
  } catch (e) {
    return res.status(500).send(String(e && e.message ? e.message : e))
  }
})

app.post('/pool/save', (req, res) => {
  try {
    const body = req.body || {}
    const profiles = loadProfiles()
    const pristineId = String(body.pristine_id || '')
    const profile = profiles.get(pristineId)
    if (!profile) return res.status(404).send(`Unknown pristine_id: ${pristineId}`)

    const ts = Math.floor(Date.now() / 1000)
    const id = `deg_${ts}`
    if (!fs.existsSync(POOL_DIR)) fs.mkdirSync(POOL_DIR, { recursive: true })

    const payload = {
      id,
      created_at: new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      label: body.label ?? null,
      pristine_id: profile.id,
      pristine_snapshot: body.include_pristine_snapshot === false ? null : profile,
      degradation: {
        LLI: Number(body.lli),
        LAM_PE: Number(body.lam_pe),
        LAM_NE: Number(body.lam_ne),
      },
      solver: body.solver ?? {},
    }

    fs.writeFileSync(path.join(POOL_DIR, `${id}.json`), JSON.stringify(payload, null, 2), 'utf-8')
    res.json({ ok: true, id })
  } catch (e) {
    res.status(500).send(String(e && e.message ? e.message : e))
  }
})

app.get('/pool/list', (_req, res) => {
  if (!fs.existsSync(POOL_DIR)) return res.json({ items: [] })
  const items = []
  for (const file of fs.readdirSync(POOL_DIR).filter((f) => f.endsWith('.json')).sort().reverse()) {
    try {
      const raw = readJson(path.join(POOL_DIR, file))
      items.push({
        id: raw.id,
        created_at: raw.created_at,
        label: raw.label ?? null,
        pristine_id: raw.pristine_id,
        lli: raw.degradation?.LLI,
        lam_pe: raw.degradation?.LAM_PE,
        lam_ne: raw.degradation?.LAM_NE,
      })
    } catch (_e) {
      // ignore
    }
  }
  res.json({ items })
})

app.post('/pool/load', (req, res) => {
  const id = String(req.body?.id || '')
  if (!id) return res.status(400).send('Missing id')
  const file = path.join(POOL_DIR, `${id}.json`)
  if (!fs.existsSync(file)) return res.status(404).send(`No pool item: ${id}`)
  res.json(readJson(file))
})

app.post('/pool/delete', (req, res) => {
  const id = String(req.body?.id || '')
  if (!id) return res.status(400).send('Missing id')
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).send('Invalid id')

  const file = path.join(POOL_DIR, `${id}.json`)
  if (!fs.existsSync(file)) return res.status(404).send(`No pool item: ${id}`)

  try {
    fs.unlinkSync(file)
  } catch (e) {
    return res.status(500).send(String(e && e.message ? e.message : e))
  }

  return res.json({ ok: true })
})

const PORT = Number(process.env.PORT || 8000)
app.listen(PORT, () => {
  console.log(`OCV server listening on http://localhost:${PORT}`)
})
