import { describe, expect, it } from 'vitest'
import { checkpointTiming, deviationDisplay } from '../src/pages/due'

describe('checkpoint preview timing', () => {
  it('uses editable observedAt while keeping live T+ separate', () => {
    const timing = checkpointTiming('2026-08-19T17:00:00Z', '2026-08-20T12:00', 5, Date.parse('2026-08-20T17:00:00Z'))
    expect(timing.actual).toBe(12)
    expect(timing.liveMinutes).toBe(1440)
    expect(timing.deviation).toBe(7)
    expect(timing.label).toContain('ช้ากว่าสากล')
  })

  it('renders the exact BR-23 label at the boundary', () => {
    const timing = checkpointTiming('2026-08-19T17:00:00Z', '2026-08-20T05:00', 5, Date.parse('2026-08-19T22:01:00Z'))
    expect(timing.label).toBe('ตรงกับสากล')
  })

  it('formats timing previews as H:MM with the BR-23 hours/minutes form', () => {
    expect(deviationDisplay(1.5)).toBe('ช้ากว่าสากล 1 ชม. 30 นาที')
    expect(deviationDisplay(-0.25)).toBe('เร็วกว่าสากล 15 นาที')
  })
})
