// @vitest-environment happy-dom
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { drainQueue, putQueue, queueCount } from '../src/offline'

describe('browser offline replay', () => {
  afterEach(() => { indexedDB.deleteDatabase('chronofish'); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks() })

  it('persists a write through refresh and replays it exactly once online', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const queued = await putQueue('/batches', { batchCode: 'OFFLINE-1' })
    expect(queued.queued).toBe(true)
    expect(await queueCount()).toBe(1)
    // Offline persistence happens before fetch, so a refresh cannot lose it.
    expect(fetchMock).not.toHaveBeenCalled()

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'batch-1' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    await drainQueue()
    expect(await queueCount()).toBe(0)
    const replayHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(replayHeaders['X-Operator-Id']).toBe('operator-a')
    expect(replayHeaders['X-Device-Id']).toBe('device-a')
    expect(replayHeaders['X-Idempotency-Key']).toBeTruthy()
    await drainQueue()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('acknowledges a 204 mutation without attempting JSON parsing', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(putQueue('/fish-observations/fish-1', undefined, 'application/json', 'DELETE')).resolves.toMatchObject({ queued: true })
    await drainQueue(true)
    expect(await queueCount()).toBe(0)
  })
})
