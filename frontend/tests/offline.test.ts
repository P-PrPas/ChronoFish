import { describe, expect, it } from 'vitest'
import { nextAttemptAt, queuedHeaders, retryDelay } from '../src/offline'

describe('offline retry policy', () => {
  it('uses bounded exponential backoff', () => {
    expect(retryDelay(0)).toBe(1_000)
    expect(retryDelay(1)).toBe(2_000)
    expect(retryDelay(10)).toBe(900_000)
    expect(retryDelay(99)).toBe(900_000)
  })

  it('calculates the next attempt from a supplied clock', () => {
    expect(nextAttemptAt(2, 10_000)).toBe(14_000)
  })

  it('replays the original operator, device, and idempotency key', () => {
    expect(queuedHeaders({ contentType: 'application/json', operatorId: 'operator-a', deviceId: 'device-a', key: 'key-a' })).toEqual({ 'Content-Type': 'application/json', 'X-Operator-Id': 'operator-a', 'X-Device-Id': 'device-a', 'X-Idempotency-Key': 'key-a' })
  })
})
