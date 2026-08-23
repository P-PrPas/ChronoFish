const bangkokFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})

const bangkokDisplayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/** Convert a browser datetime-local value to the API's explicit Bangkok offset. */
export function dateTimeLocalToRFC3339(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/[zZ]|[+-]\d\d:\d\d$/.test(trimmed)) return new Date(trimmed).toISOString()
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed) ? `${trimmed}:00` : trimmed
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) throw new Error('Invalid datetime-local value')
  return `${normalized}+07:00`
}

export function rfc3339ToDateTimeLocal(value: string): string {
  if (!value) return ''
  const parts = bangkokFormatter.formatToParts(new Date(value))
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}`
}

export function formatBangkokDateTime(value: string): string {
  return value ? bangkokDisplayFormatter.format(new Date(value)).replace(',', '') : ''
}
