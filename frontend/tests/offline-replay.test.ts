// @vitest-environment happy-dom
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discardRejected, drainQueue, putQueue, queueCount, rejectedQueueCount, rejectedQueueItems, retryRejected } from '../src/offline'

describe('browser offline replay', () => {
  afterEach(() => { if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase('chronofish'); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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

  it('reuses the pending key for a repeated logical write', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')

    const [first, second] = await Promise.all([
      putQueue('/batches', { batchCode: 'DUPLICATE-CLICK' }),
      putQueue('/batches', { batchCode: 'DUPLICATE-CLICK' }),
    ])

    expect(second.key).toBe(first.key)
    expect(await queueCount()).toBe(1)
  })

  it('keeps 429 responses pending for retry', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'Content-Type': 'application/json' } })))

    await putQueue('/batches', { batchCode: 'RATE-LIMITED' })
    await drainQueue(true)

    expect(await queueCount()).toBe(1)
    expect(await rejectedQueueCount()).toBe(0)
  })

  it('marks a business rejection instead of retrying it', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'invalid business state' } }), { status: 422, headers: { 'Content-Type': 'application/json' } })))

    await putQueue('/batches', { batchCode: 'REJECTED' })
    await drainQueue(true)

    expect(await queueCount()).toBe(0)
    expect(await rejectedQueueCount()).toBe(1)
  })

  it('does not discard a rejected write after it has been moved back to pending', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'invalid business state' } }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    )))
    await putQueue('/batches', { batchCode: 'REVIEW-FIRST' })
    await drainQueue(true)
    const [rejected] = await rejectedQueueItems()

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await retryRejected()
    await discardRejected(rejected.id)

    expect(await queueCount()).toBe(1)
    expect(await rejectedQueueCount()).toBe(0)
  })

  it('retries an uncertain response with the original idempotency key', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('request timed out'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'batch-1' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await putQueue('/batches', { batchCode: 'UNCERTAIN' })
    await drainQueue(true)
    expect(await queueCount()).toBe(1)
    await drainQueue(true)

    expect(await queueCount()).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].headers['X-Idempotency-Key']).toBe(fetchMock.mock.calls[1][1].headers['X-Idempotency-Key'])
  })

  it('continues draining after one item is rejected', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')
    await Promise.all([
      putQueue('/batches', { batchCode: 'REJECT-ME' }),
      putQueue('/batches', { batchCode: 'SEND-ME' }),
    ])
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'invalid business state' } }), { status: 422, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'batch-2' }), { status: 201, headers: { 'Content-Type': 'application/json' } })))

    await drainQueue(true)

    expect(await queueCount()).toBe(0)
    expect(await rejectedQueueCount()).toBe(1)
  })

  it('does not report a save when IndexedDB cannot open', async () => {
    vi.stubGlobal('indexedDB', undefined)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    localStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')

    await expect(putQueue('/batches', { batchCode: 'NO-DATABASE' })).rejects.toThrow()
  })
})
