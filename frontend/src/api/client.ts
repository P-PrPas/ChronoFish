import type { components } from './schema'

export type ApiRecord = Partial<components['schemas']['Site'] & components['schemas']['Operator'] & components['schemas']['Batch'] & components['schemas']['DueCheckpoint'] & components['schemas']['CloneFish'] & components['schemas']['PromotionCandidate'] & components['schemas']['ControlArmCount'] & {
  id: string
  batchId: string
  fishCode: string
  operatorId: string
  clientUuid: string
  stageCode: string
  stageLabel: string
  stageOrder: number
  expectedHpa: number
  code: string
  label: string
  defaultCondition: string
  minutesLate: number
  condition: string
  observedOn: string
  outcome: string
  stage1: { nActivated?: number; nPromoted?: number; nBatches?: number }
  stage2: { nAlive?: number }
  status: string
  queued: boolean
  nNormal: number
  nAbnormal: number
  fishId: string
  alreadyRecorded: boolean
  recordId: string
  tableName: string
  action: string
  occurredAt: string
  operatorName: string
  error: string
  pendingPromotionCount: number
  riskSet: number
  alive: number
  nPrev: number
  nDead: number
  surv: number
  pctOfDevelopment: number
  pctOfActivated: number
  n: number
  meanDeviationH: number
  medianDeviationH: number
  sdDeviationH: number
  minDeviationH: number
  maxDeviationH: number
  date: string
  count: number
  dead: number
  batchCode: string
  lotNo: string
  lastObservedOn: string
  missedDays: number
}> & { [key: string]: unknown }

export interface ApiItem extends ApiRecord {
  items?: ApiItem[]
  overdue?: ApiItem[]
  upcoming?: ApiItem[]
  embryos?: ApiItem[]
  injectionLots?: ApiItem[]
  entries?: ApiItem[]
  results?: ApiItem[]
}

export const apiBase = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'
const demoOperator = '00000000-0000-7000-8000-000000000001'

export function deviceId(): string {
  const key = 'chronofish.device_id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(key, id)
  }
  return id
}

export function operatorId(): string {
  return localStorage.getItem('chronofish.operator_id') ?? demoOperator
}

export function mutationHeaders(key = crypto.randomUUID()): Record<string, string> {
  return { 'X-Operator-Id': operatorId(), 'X-Device-Id': deviceId(), 'X-Idempotency-Key': key }
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(method !== 'GET' && method !== 'HEAD' ? mutationHeaders() : {}),
    ...(init.headers as Record<string, string> | undefined ?? {}),
  }
  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return response
}

export async function get(path: string): Promise<ApiItem> {
  return await (await request(path)).json() as ApiItem
}
