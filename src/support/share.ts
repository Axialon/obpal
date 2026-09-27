/** Split `amount` by `shares`, in cents, so the parts add up exactly (the remainder goes to the biggest fractions). */
export function split(amount: number, shares: number[]): number[] {
  const total = shares.reduce((s, x) => s + x, 0) || 1
  const cents = Math.round(amount * 100)
  const raw = shares.map((x) => (cents * x) / total)
  const out = raw.map(Math.floor)
  let left = cents - out.reduce((s, c) => s + c, 0)
  for (const i of raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left <= 0) break
    out[i]++
    left--
  }
  return out.map((c) => c / 100)
}
