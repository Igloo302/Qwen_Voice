import { canonicalMemorySection, memorySection } from '../../../../shared/pwm-inspection-schema.mjs'

function positive(value, fallback, maximum) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null
}

function instant(value) {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null
  const timestamp = Date.parse(value)
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(timestamp) || !Number.isFinite(day.getTime())
    || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return null
  return new Date(timestamp).toISOString()
}

export function memoryInspectionOptions(section, id, query = {}) {
  const definition = memorySection(section)
  if (!definition) return null
  const canonical = canonicalMemorySection(section)
  const options = { section }
  for (const [key, fallback, maximum] of [
    ['page', 1, 1_000_000], ['pageSize', 20, 100],
    ['evidencePage', 1, 1_000_000], ['historyPage', 1, 1_000_000],
    ['sourcePage', 1, 1_000_000], ['derivationPage', 1, 1_000_000], ['premisePage', 1, 1_000_000],
  ]) {
    options[key] = positive(query[key], fallback, maximum)
    if (options[key] === null) return null
  }
  if (query.premiseDerivationId !== undefined) {
    options.premiseDerivationId = positive(query.premiseDerivationId, null, Number.MAX_SAFE_INTEGER)
    if (options.premiseDerivationId === null) return null
  }
  if (id !== undefined) {
    options.id = positive(id, null, Number.MAX_SAFE_INTEGER)
    if (options.id === null) return null
  }
  if (canonical === 'user_activity') {
    if (query.role !== undefined && typeof query.role !== 'string') return null
    options.role = query.role || ''
    if (options.role && !['actor', 'participant', 'contextual'].includes(options.role)) return null
    options.from = instant(query.from)
    options.to = instant(query.to)
    options.sourcePage = positive(query.sourcePage, 1, 1_000_000)
    if (options.from === null || options.to === null || options.sourcePage === null) return null
    if (options.from && options.to && Date.parse(options.from) >= Date.parse(options.to)) return null
    return options
  }
  for (const key of definition.filters) {
    if (key === 'subjectId') {
      if (query[key] !== undefined && query[key] !== '') {
        options[key] = positive(query[key], null, Number.MAX_SAFE_INTEGER)
        if (options[key] === null) return null
      }
      continue
    }
    if (query[key] !== undefined && typeof query[key] !== 'string') return null
    options[key] = query[key] || ''
    if (options[key].length > 80) return null
  }
  if (definition.filters.includes('scope')) {
    options.scope ||= 'current'
    if (!['current', 'history', 'all'].includes(options.scope)) return null
  }
  if (options.type && !definition.types.includes(options.type)) return null
  if (options.claimType && !definition.types.includes(options.claimType)) return null
  if (options.status && !definition.statuses.includes(options.status)) return null
  if (options.origin && !['explicit', 'derived'].includes(options.origin)) return null
  // ownerId and database paths are deliberately never accepted from a client.
  return options
}

export function registerMemoryInspectionRoutes(app, { memory }) {
  const inspect = async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    const options = memoryInspectionOptions(req.params.section, req.params.id, req.query)
    if (!options) return res.status(400).json({ code: 'invalid_inspection_query' })
    if (typeof memory?.inspect !== 'function') {
      return res.status(501).json({ code: 'memory_inspection_unsupported', supported: false })
    }
    try {
      const result = await memory.inspect(req.identity.ownerId, options)
      if (result?.supported === false) {
        return res.status(501).json({ ...result, code: 'memory_inspection_unsupported' })
      }
      if (options.id && result?.available && !result.item) {
        return res.status(404).json({ code: 'memory_record_not_found' })
      }
      return res.json(result)
    } catch {
      // Paths, credentials and raw sidecar stderr must not become UI messages.
      return res.status(503).json({ code: 'memory_inspection_unavailable' })
    }
  }
  app.get('/api/pwm/:section', inspect)
  app.get('/api/pwm/:section/:id', inspect)
}
