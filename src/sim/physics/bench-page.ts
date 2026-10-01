/** Entry for the in-memory Playwright bench build only. Not an application route or production entry. */
import { CANDIDATES } from './candidates'
import { measureCandidate, candidateFailures } from './bench'
import { selectEngine, selectAcrossProfiles } from './decision'
import type { EngineId } from './schema'
const bench = { choose: selectEngine, chooseAcrossProfiles: selectAcrossProfiles, failures: candidateFailures, run: (id: EngineId, environment: string) => {
  if (!Object.hasOwn(CANDIDATES, id)) throw new RangeError('Unknown physics candidate')
  return measureCandidate(id, CANDIDATES[id], environment)
} }
Object.defineProperty(window, '__physicsBench', { value: bench, writable: false, configurable: false })
