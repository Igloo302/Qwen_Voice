import { canonicalMemorySection, memorySection } from '../../../shared/pwm-inspection-schema.mjs'

function dayBoundary(value, nextDay = false) {
  if (!value) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new RangeError('Invalid date')
  const day = new Date(`${value}T00:00:00`)
  if (!Number.isFinite(day.getTime()) || day.getFullYear() !== Number(value.slice(0, 4))
    || day.getMonth() + 1 !== Number(value.slice(5, 7)) || day.getDate() !== Number(value.slice(8))) {
    throw new RangeError('Invalid date')
  }
  // Use local calendar days, including daylight saving transitions.
  if (nextDay) day.setDate(day.getDate() + 1)
  return day.toISOString()
}

export function memoryListQuery({ section, page = 1, pageSize = 20,
  type = '', scope = 'current', status = '', domain = '', role = '', fromDate = '', toDate = '', origin = '', subjectId = '',
}) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  const canonical = canonicalMemorySection(section)
  const definition = memorySection(section)
  if (!definition) throw new RangeError('Invalid memory section')
  if (canonical === 'user_activity') {
    if (fromDate && toDate && fromDate > toDate) throw new RangeError('Invalid date range')
    query.set('role', role)
    query.set('from', dayBoundary(fromDate))
    query.set('to', dayBoundary(toDate, true))
  } else {
    const values = { type, claimType: type, scope, status, domain, origin, subjectId }
    for (const key of definition.filters) query.set(key, values[key] || '')
  }
  return query
}
