/**
 * Every kind of arm the sim has (./kinds.ts lists them for pages; these are the arms themselves, with three.js).
 */
import type { ArmKind } from '../kin'
import type { ArmKindId } from '../kinds'
import { arm5 } from './arm5'
import { delta } from './delta'
import { desk } from './desk'
import { scara } from './scara'
import { six } from './six'
import { so101 } from './so101'

export const KINDS: Record<ArmKindId, ArmKind> = { arm5, so101, six, scara, delta, desk }

/** The kind by its id (?kind=), the five-axis arm for none or one it doesn't know. */
export const kindFrom = (id: string | null | undefined): ArmKind => (id && Object.prototype.hasOwnProperty.call(KINDS, id) ? KINDS[id as ArmKindId] : arm5)
