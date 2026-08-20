import { describe, expect, it } from 'vitest'
import { filterQuery, parseFilters, withFilters } from '../src/filters'

describe('dashboard filter state', () => {
  it('round-trips supported URL filters and ignores unknown values', () => {
    const filters = parseFilters('?siteId=site-1&dateFrom=2026-01-01&unknown=discard')
    expect(filters).toEqual({ siteId: 'site-1', dateFrom: '2026-01-01' })
    expect(filterQuery(filters)).toBe('siteId=site-1&dateFrom=2026-01-01')
    expect(withFilters('/analytics/kpi', filters)).toBe('/analytics/kpi?siteId=site-1&dateFrom=2026-01-01')
  })
})
