// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorMessage } from '../src/components'
import { text } from '../src/types'

function render(message: string, lang: string) {
  document.documentElement.lang = lang
  const rootElement = document.createElement('div')
  document.body.append(rootElement)
  act(() => { createRoot(rootElement).render(<ErrorMessage message={message} />) })
  return rootElement.textContent
}

describe('error message', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('translates client sentinel codes instead of showing them raw', () => {
    expect(render('OPERATOR_REQUIRED', 'th')).toBe(text.th.operatorRequired)
    expect(render('OPERATOR_REQUIRED', 'en')).toBe(text.en.operatorRequired)
  })

  it('passes server messages through unchanged', () => {
    expect(render('Site code already exists', 'en')).toBe('Site code already exists')
  })
})
