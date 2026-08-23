export type DashboardFilters = {
  batchId?: string
  siteId?: string
  operatorId?: string
  treatmentGroupId?: string
  strain?: string
  dateFrom?: string
  dateTo?: string
  status?: string
  boxId?: string
  condition?: string
  dobFrom?: string
  dobTo?: string
  donorCellLineId?: string
}

const filterKeys = ['batchId', 'siteId', 'operatorId', 'treatmentGroupId', 'strain', 'dateFrom', 'dateTo', 'status', 'boxId', 'condition', 'dobFrom', 'dobTo', 'donorCellLineId'] as const

export function parseFilters(search = window.location.search): DashboardFilters {
  const params = new URLSearchParams(search)
  return Object.fromEntries(filterKeys.flatMap((key) => {
    const value = params.get(key)?.trim()
    return value ? [[key, value]] : []
  })) as DashboardFilters
}

export function filterQuery(filters: DashboardFilters): string {
  const params = new URLSearchParams()
  for (const key of filterKeys) if (filters[key]) params.set(key, filters[key] as string)
  return params.toString()
}

export function withFilters(path: string, filters: DashboardFilters): string {
  const query = filterQuery(filters)
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path
}

export function updateFilterURL(filters: DashboardFilters): void {
  const query = filterQuery(filters)
  const suffix = query ? `?${query}` : ''
  window.history.replaceState(null, '', `${window.location.pathname}${suffix}${window.location.hash}`)
}
