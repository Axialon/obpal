import { describe, expect, it } from 'vitest'
import { readBytes, readText } from './devtools-node.mjs'

interface Film { id: string; title: string; description: string; file: string; poster: string; duration: number; width: number; height: number; fps: number; frames: number; bytes: number; sha256: string; completeWebEncode: boolean }
const films = (JSON.parse(readText('public/campaign/films/manifest.json')) as { films: Film[] }).films
const html = readText('campaign/index.html')

describe('partner films', () => {
  it('six complete media files match the sanitized manifest and per-file static cap', async () => {
    expect(films).toHaveLength(6)
    expect(new Set(films.map(f => f.id)).size).toBe(6)
    for (const film of films) {
      const bytes = readBytes(`public/campaign/films/${film.file}`)
      expect(bytes.length).toBe(film.bytes)
      expect(bytes.length).toBeLessThan(26_214_400)
      const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
      expect([...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')).toBe(film.sha256)
      expect(film.frames / film.fps).toBeCloseTo(film.duration, 2)
      expect(readBytes(`public/campaign/films/${film.poster}`).length).toBeGreaterThan(1000)
    }
    expect(films[0]).toMatchObject({ duration: 45, width: 1920, height: 1080, fps: 30, frames: 1350, completeWebEncode: true })
    expect(films.filter(f => f.completeWebEncode)).toHaveLength(1)
  })

  it('each film has a named native player, explicit poster, download and permanent fragment without JavaScript', () => {
    for (const film of films) {
      const article = new RegExp(`<article id="${film.id}"[^>]*>([\\s\\S]*?)</article>`).exec(html)?.[1]
      expect(article, film.id).toBeTruthy()
      expect(article).toContain(film.title)
      expect(article).toContain(film.description)
      expect(article).toContain(`controls playsinline preload="none" poster="/campaign/films/${film.poster}"`)
      expect(article).toContain(`aria-label="${film.title}"`)
      expect(article).toContain(`aria-describedby="description-${film.id} disclosure"`)
      expect(article).toContain(`download="${film.file}"`)
      expect(article).toContain(`data-permalink href="/campaign/#${film.id}"`)
      expect(article).toContain(`href="/campaign/films/${film.file}">Open video`)
      expect(article).not.toMatch(/\bautoplay\b|\bloop\b/)
    }
  })

  it('introduces historical work truthfully and keeps sharing explicit and accessible', () => {
    for (const text of ['Historical simulation footage', 'Inputs are scripted', 'controller screens illustrate recorded controls', 'BODY uses seeded joint input', 'Autonomous and experimental shots are labelled', 'Authored procedural audio']) expect(html).toContain(text)
    expect(html).not.toMatch(/private files|nothing has been published|Local review preview|phone-control|mailto:|<form\b/)
    expect(html.match(/role="status" aria-live="polite" aria-atomic="true"/g)).toHaveLength(7)
    expect(html).toContain('data-permalink href="/campaign/"')
    for (const href of ['/', '/view/']) expect(html).toContain(`href="${href}"`)
    expect(readText('src/pages/partner-films.css')).toContain('object-fit: contain')
    expect(readText('src/pages/partner-films.css')).toContain('prefers-reduced-motion: reduce')
  })
})
