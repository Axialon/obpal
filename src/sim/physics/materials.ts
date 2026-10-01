/** Play defaults only: not measured coefficients and not inferred from a visual material's name. */
export const MATERIALS = Object.freeze({
  metal: Object.freeze({ friction: .45, restitution: .15 }),
  rubber: Object.freeze({ friction: .9, restitution: .1 }),
  ceramic: Object.freeze({ friction: .35, restitution: .2 }),
  ice: Object.freeze({ friction: .04, restitution: .02 }),
})
export type ContactMaterial = keyof typeof MATERIALS
/** Symmetric geometric-mean friction and the less bouncy restitution. A future engine must apply the same rule. */
export function contactMaterial(a: ContactMaterial, b: ContactMaterial) {
  return { friction: Math.sqrt(MATERIALS[a].friction * MATERIALS[b].friction), restitution: Math.min(MATERIALS[a].restitution, MATERIALS[b].restitution) }
}
