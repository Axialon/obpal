import { expect, it } from 'vitest'

const sources = import.meta.glob<string>(['../src/**/*.{ts,css}', '../extension/src/**/*.{ts,css}', '../packages/host/src/**/*.ts', '../index.html', '../{buttons,catalogue,donate,embed,link,p,privacy,public,sim,sponsor,trust,view}/**/*.html', '../extension/*.html', '!../{node_modules,artifacts,dist}/**', '!../extension/dist/**', '!../packages/*/dist/**', '!../**/*.test.ts'], { eager: true, query: '?raw', import: 'default' })

it('keeps CSS loading rings and text-only Loading states out of product surfaces', () => {
  const failures: string[] = []
  expect(Object.keys(sources).length).toBeGreaterThan(300)
  for (const [path, source] of Object.entries(sources)) {
    if (/class\s*=\s*["'][^"']*\bspinner\b/.test(source) || /\.spinner\s*\{/.test(source)) failures.push(`${path}: plain spinner`)
    if (/animation:\s*(?:spin|[\w-]*(?:loading|load-spin|spinner|shimmer))\b/.test(source)) failures.push(`${path}: CSS busy animation`)
    if (/[^\n]*(?:\[data-[^\]]*(?:ready|connecting|waiting)|aria-busy)[^\n]*animation:[^\n]*pulse/.test(source)) failures.push(`${path}: CSS waiting pulse`)
    // Gyro and gamepad demonstrations rotate in response to input; they are not loading indicators.
    for (const match of source.matchAll(/@keyframes\s+([\w-]+)\s*\{([^\n]+)/g)) {
      if (/rotate\(/.test(match[2]) && !['gyro-spin', 'gp-spin', 'gp-turn'].includes(match[1])) failures.push(`${path}: CSS rotation ${match[1]}`)
    }
    if (/>\s*Loading(?:\s+[^<]*)?(?:\u2026|\.\.\.)?\s*</i.test(source) || /(?:textContent\s*=|h\([^\n]+,)\s*['"]Loading[^'"]*(?:\u2026|\.\.\.)['"]/.test(source)) failures.push(`${path}: text-only loading`)
  }
  expect(failures).toEqual([])
})
