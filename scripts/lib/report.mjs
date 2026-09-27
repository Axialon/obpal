/**
 * Plain-text output shared by the dev tools (scripts/e2e-all.mjs, scripts/check-live.mjs, scripts/merge-lane.mjs):
 * one aligned table instead of pages of logs, and durations that read at a glance.
 */

/** Terminal colour codes, which the tables measure without. */
const ANSI = /\x1b\[[0-9;]*m/g
export const stripAnsi = (s) => String(s).replace(ANSI, '')

/**
 * An aligned table: a header row, a rule, then one line per row. Cells are strings (anything else is stringified);
 * a cell never spans lines.
 * @param {string[]} headers
 * @param {unknown[][]} rows
 */
export function formatTable(headers, rows) {
  const cells = [headers, ...rows].map((r) => r.map((c) => stripAnsi(c ?? '').replace(/\s*\n\s*/g, ' ')))
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)))
  const line = (r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd()
  return [line(cells[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n')
}

/** 850 ms, 12 s, 3.5 min: whole seconds up to a minute, then minutes to one decimal. */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}
