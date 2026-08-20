import { deviceId, mutationHeaders, operatorId, request } from './api/client'

export type QueueStatus = 'pending' | 'rejected'
export type QueuedWrite = {
  path: string
  method: string
  body: unknown
  contentType: string
  key: string
  operatorId: string
  deviceId: string
  createdAt: number
  attempt: number
  nextAttempt: number
  status: QueueStatus
  lastError?: string
}

const databaseName = 'chronofish'
const databaseVersion = 2
const storeName = 'writes'

export function retryDelay(attempt: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.min(Math.max(attempt, 0), 10))
}

export function nextAttemptAt(attempt: number, now = Date.now()): number {
  return now + retryDelay(attempt)
}

export function queuedHeaders(item: Pick<QueuedWrite, 'operatorId' | 'deviceId' | 'key' | 'contentType'>): Record<string, string> {
  return { 'Content-Type': item.contentType || 'application/json', 'X-Operator-Id': item.operatorId, 'X-Device-Id': item.deviceId, 'X-Idempotency-Key': item.key }
}

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, databaseVersion)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(storeName)) open.result.createObjectStore(storeName, { autoIncrement: true })
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => resolve(open.result)
  })
}

function records(db: IDBDatabase): Promise<{ key: IDBValidKey; value: QueuedWrite }[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName)
    const store = tx.objectStore(storeName)
    const values = store.getAll()
    const keys = store.getAllKeys()
    tx.oncomplete = () => resolve((values.result as QueuedWrite[]).map((value, index) => ({ key: keys.result[index], value })))
    tx.onerror = () => reject(tx.error)
  })
}

async function updateQueued(db: IDBDatabase, key: IDBValidKey, value: QueuedWrite): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function queueWrite(item: QueuedWrite): Promise<void> {
  const db = await openQueue()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).add(item)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  localStorage.setItem('chronofish.pending_count', String(Number(localStorage.getItem('chronofish.pending_count') ?? 0) + 1))
  window.dispatchEvent(new CustomEvent('chronofish:queue-enqueued', { detail: item }))
}

export async function queueCount(): Promise<number> {
  return countByStatus('pending')
}

export async function rejectedQueueCount(): Promise<number> {
  return countByStatus('rejected')
}

async function countByStatus(status: QueueStatus): Promise<number> {
  if (!('indexedDB' in window)) return 0
  try {
    const db = await openQueue()
    const count = (await records(db)).filter(({ value }) => value.status === status).length
    db.close()
    return count
  } catch {
    return 0
  }
}

export async function putQueue(path: string, body: unknown, contentType = 'application/json', method = 'POST'): Promise<ApiQueueResult> {
  const key = crypto.randomUUID()
  const headers = mutationHeaders(key)
  const item: QueuedWrite = { path, method, body, contentType, key, operatorId: headers['X-Operator-Id'], deviceId: headers['X-Device-Id'], createdAt: Date.now(), attempt: 0, nextAttempt: Date.now(), status: 'pending' }
  // Durable intent is written before any network attempt. A tab close between
  // fetch() and IndexedDB used to lose the mutation (and its idempotency key).
  if (!('indexedDB' in window)) {
    const serialized = contentType === 'application/json' ? JSON.stringify(body) : String(body)
    return responseValue(await request(path, { method, body: serialized, headers: { ...headers, 'Content-Type': contentType } }))
  }
  await queueWrite(item)
  if (!navigator.onLine) return { queued: true, key }
  const db = await openQueue()
  const record = (await records(db)).find(({ value }) => value.key === key)
  if (!record) { db.close(); return { queued: true, key } }
  try {
    const result = await transmit(db, record)
    db.close()
    return result
  } catch (error) {
    db.close()
    throw error
  }
}

export type ApiQueueResult = { queued?: boolean; key?: string; [key: string]: unknown }

export async function retryRejected(): Promise<void> {
  if (!('indexedDB' in window)) return
  const db = await openQueue()
  for (const record of await records(db)) {
    if (record.value.status === 'rejected') await updateQueued(db, record.key, { ...record.value, status: 'pending', nextAttempt: Date.now(), lastError: undefined })
  }
  db.close()
  await drainQueue(true)
}

export async function drainQueue(force = false): Promise<void> {
  if (!navigator.onLine || !('indexedDB' in window)) return
  try {
    const db = await openQueue()
    for (const record of await records(db)) {
      const item = record.value
      if (item.status !== 'pending' || (!force && item.nextAttempt > Date.now())) continue
      try {
        await transmit(db, record)
      } catch (error) {
        // transmit() persists rejected/next-attempt state before returning.
        void error
      }
    }
    db.close()
  } catch {
    // IndexedDB may be unavailable or full; the next online tick retries.
  }
}

async function transmit(db: IDBDatabase, record: { key: IDBValidKey; value: QueuedWrite }): Promise<ApiQueueResult> {
  const item = record.value
  const contentType = item.contentType || 'application/json'
  const body = contentType === 'application/json' ? JSON.stringify(item.body) : String(item.body)
  const headers = queuedHeaders({ ...item, operatorId: item.operatorId || operatorId(), deviceId: item.deviceId || deviceId(), contentType })
  try {
    const response = await request(item.path, { method: item.method || 'POST', body, headers })
    const result = await responseValue(response)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).delete(record.key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    window.dispatchEvent(new CustomEvent('chronofish:queue-drained', { detail: item }))
    return result
  } catch (error) {
    const status = (error as Error & { status?: number }).status
    if (status && status >= 400 && status < 500) {
      await updateQueued(db, record.key, { ...item, status: 'rejected', lastError: (error as Error).message })
      window.dispatchEvent(new CustomEvent('chronofish:queue-rejected', { detail: { ...item, lastError: (error as Error).message } }))
      throw error
    }
    const attempt = item.attempt + 1
    await updateQueued(db, record.key, { ...item, attempt, nextAttempt: nextAttemptAt(attempt) })
    return { queued: true, key: item.key }
  }
}

async function responseValue(response: Response): Promise<ApiQueueResult> {
  if (response.status === 204) return {}
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('json')) return {}
  const text = await response.text()
  if (!text.trim()) return {}
  try { return JSON.parse(text) as ApiQueueResult } catch { return {} }
}

export function startQueueSync(refresh: () => void): () => void {
  const tick = () => void drainQueue().then(refresh)
  const timer = window.setInterval(tick, 5_000)
  window.addEventListener('online', tick)
  return () => { window.clearInterval(timer); window.removeEventListener('online', tick) }
}
