/** Report action state only when it changes, so the phone tray keeps its focus and scroll position. */
import type { Remote } from '@obpal/host'

const sent = new WeakMap<Remote, Map<string, string>>()

export function syncActionState(remote: Remote, valuesOf: (who: string) => Record<string, boolean>) {
  let cache = sent.get(remote)
  if (!cache) { cache = new Map(); sent.set(remote, cache) }
  const people = remote.participants
  for (const who of cache.keys()) if (!people.some(p => p.id === who)) cache.delete(who)
  for (const person of people) {
    const values = valuesOf(person.id), key = JSON.stringify(values)
    if (cache.get(person.id) === key) continue
    cache.set(person.id, key)
    remote.setValues(values, person.id)
  }
}
