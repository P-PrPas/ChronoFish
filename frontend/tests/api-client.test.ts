// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { deviceId, mutationHeaders, operatorId } from '../src/api/client'

describe('API write context', () => {
  afterEach(() => { localStorage.clear(); sessionStorage.clear() })

  it('persists one UUID v7 device identifier', () => {
    const first = deviceId()
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(deviceId()).toBe(first)
    expect(localStorage.getItem('chronofish.device_id')).toBe(first)
  })

  it('keeps the selected operator in the browser session and sends both identifiers', () => {
    sessionStorage.setItem('chronofish.operator_id', 'operator-a')
    localStorage.setItem('chronofish.device_id', 'device-a')

    expect(operatorId()).toBe('operator-a')
    expect(mutationHeaders('request-a')).toEqual({
      'X-Operator-Id': 'operator-a',
      'X-Device-Id': 'device-a',
      'X-Idempotency-Key': 'request-a',
    })
  })
})
