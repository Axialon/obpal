/** Original local velocity-constraint response, NOT a second position/contact integrator.
 * H = W^T P W, P projects mass-whitened velocities into the current constraint nullspace.
 * Native physics alone integrates bodies, solves unilateral/friction contacts and separates colliders.
 */
import { add, sub, scale, dot, cross, norm, rotate, localPoint, type Vec3 } from './math'
import { uniformInertia } from './servo'
import type { Scene, BodyState, ContactSample } from './schema'
export const CONSTRAINT_DEFAULTS = Object.freeze({
  rankTolerance: 1e-10, // dimensionless after row normalisation; numerical rank, not a physical stiffness.
  stickingSpeedMps: .02, // m/s: local response prediction only; native friction remains authoritative.
  maxDynamicBodies: 32, maxJoints: 32, maxContacts: 256, // bounded dense workspace; two 16-body actors fit.
})
const AXES: readonly Vec3[] = [{x:1,y:0,z:0},{x:0,y:1,z:0},{x:0,y:0,z:1}]
const inner = (a: Float64Array, b: Float64Array) => { let s=0; for(let i=0;i<a.length;i++) s+=a[i]*b[i]; return s }
const finiteVector = (v: Vec3) => v && [v.x,v.y,v.z].every(Number.isFinite)
export interface ConstraintResponse {
  matrix: number[][]; gravityAcceleration: number[]; constraintRank: number; contactRows: number; dimensions: number
}
/** Complete owned states and actual native manifold samples only. Does not retain or mutate its arguments. */
export function constraintResponse(scene: Scene, states: readonly BodyState[], contacts: readonly ContactSample[]): ConstraintResponse {
  const dynamic = scene.bodies.filter(b=>!b.fixed), d=dynamic.length*6, n=scene.joints.length*3
  if(dynamic.length>CONSTRAINT_DEFAULTS.maxDynamicBodies || scene.joints.length>CONSTRAINT_DEFAULTS.maxJoints) throw new RangeError('Coupled response workspace exceeded')
  if(contacts.length>CONSTRAINT_DEFAULTS.maxContacts) throw new RangeError('Coupled response contact budget exceeded')
  const byId=new Map(scene.bodies.map(b=>[b.id,b])), current=new Map(states.map(s=>[s.id,s]))
  if(current.size!==states.length || scene.bodies.some(b=>!current.has(b.id))) throw new RangeError('Missing/duplicate coupled body state')
  for(const s of current.values()) {
    // 1e-4 dimensionless unit-vector tolerance matches the native observation envelope.
    const q=s.rotation, qn=q ? Math.hypot(q.x,q.y,q.z,q.w) : NaN
    if(!byId.has(s.id)||![s.position,s.velocity,s.angularVelocity].every(finiteVector)||!Number.isFinite(qn)||Math.abs(qn-1)>1e-4)
      throw new RangeError('Invalid coupled body state')
  }
  const slots = new Map(dynamic.map((b,i)=>{
    const inertia=uniformInertia(b), state=current.get(b.id)!
    return [b.id,{offset:i*6,linear:1/Math.sqrt(b.mass),angular:AXES.map((axis,k)=>
      scale(rotate(state.rotation,axis),1/Math.sqrt([inertia.x,inertia.y,inertia.z][k])))}] as const
  }))
  const basis: { values: Float64Array; indices: number[] }[]=[]
  const insert = (row: Float64Array) => {
    const magnitude=Math.sqrt(inner(row,row)); if(!Number.isFinite(magnitude)) throw new RangeError('Non-finite constraint row')
    if(magnitude===0) return
    for(let i=0;i<d;i++) row[i]/=magnitude
    // Reorthogonalisation makes duplicate/coplanar contact rows benign, without arbitrary compliance or pins.
    for(let pass=0;pass<2;pass++) for(const b of basis) {
      let a=0;for(const i of b.indices) a+=row[i]*b.values[i]
      if(a!==0) for(const i of b.indices) row[i]-=a*b.values[i]
    }
    const residual=Math.sqrt(inner(row,row)); if(residual<=CONSTRAINT_DEFAULTS.rankTolerance) return
    for(let i=0;i<d;i++) row[i]/=residual
    basis.push({ values: row, indices: [...row.keys()].filter(i=>row[i]!==0) })
  }
  const pointRow = (row: Float64Array,id: string,point: Vec3,direction: Vec3,sign: number) => {
    const s=slots.get(id); if(!s) return
    const angular=cross(sub(point,current.get(id)!.position),direction)
    for(let k=0;k<3;k++) { row[s.offset+k]+=sign*[direction.x,direction.y,direction.z][k]*s.linear
      row[s.offset+3+k]+=sign*dot(angular,s.angular[k]) }
  }
  for(const j of scene.joints) {
    const a=current.get(j.parent)!,b=current.get(j.child)!
    const pa=localPoint(a.position,a.rotation,j.anchorParent),pb=localPoint(b.position,b.rotation,j.anchorChild)
    for(const axis of AXES) { const row=new Float64Array(d);pointRow(row,j.parent,pa,axis,-1);pointRow(row,j.child,pb,axis,1);insert(row) }
  }
  const sample = (c: ContactSample) => {
    if(!byId.has(c.a)||!byId.has(c.b)||c.a===c.b||![c.pointA,c.pointB,c.normalOnB].every(finiteVector)||
      !Number.isFinite(c.distance)||!Number.isFinite(c.impulse)||c.impulse<0||Math.abs(norm(c.normalOnB)-1)>1e-4)
      throw new RangeError('Invalid coupled contact sample')
    const a=byId.get(c.a)!,b=byId.get(c.b)!
    if(a.fixed===b.fixed) return null // Dynamic-dynamic impacts are not bilateral supports in this prediction.
    return a.fixed ? {id:b.id,ground:a.id,point:c.pointB,normal:c.normalOnB} : {id:a.id,ground:b.id,point:c.pointA,normal:scale(c.normalOnB,-1)}
  }
  const samples=contacts.map(c=>({c,s:sample(c)})),loaded=new Set<string>()
  const prediction=scene.contact?.predictionDistance??.001 // m: existing F0 narrow-phase default.
  for(const {c,s} of samples) if(s&&c.impulse>0&&c.distance<=prediction) loaded.add(`${s.ground}/${s.id}`)
  let contactRows=0
  for(const {c,s} of samples) {
    if(!s||!loaded.has(`${s.ground}/${s.id}`)||c.distance>prediction) continue
    const state=current.get(s.id)!,v=add(state.velocity,cross(state.angularVelocity,sub(s.point,state.position)))
    const normalSpeed=dot(v,s.normal)
    if(normalSpeed>CONSTRAINT_DEFAULTS.stickingSpeedMps) continue // Already separating: never predict an adhesive floor.
    const row=new Float64Array(d);pointRow(row,s.id,s.point,s.normal,1);insert(row);contactRows++
    const tangent=sub(v,scale(s.normal,normalSpeed))
    if(norm(tangent)>CONSTRAINT_DEFAULTS.stickingSpeedMps||Math.min(byId.get(s.id)!.friction,byId.get(s.ground)!.friction)<=0) continue
    // Project Cartesian directions onto the tangent plane; rank reduction removes the redundant third direction.
    for(const axis of AXES) { const t=sub(axis,scale(s.normal,dot(axis,s.normal)))
      if(norm(t)<1e-10) continue
      const r=new Float64Array(d);pointRow(r,s.id,s.point,t,1);insert(r);contactRows++ }
  }
  const columns: {values: Float64Array; indices: number[]; projections: number[]}[]=[]
  for(const j of scene.joints) for(const axis of AXES) {
    const column=new Float64Array(d)
    for(const [id,sign] of [[j.parent,-1],[j.child,1]] as const) { const s=slots.get(id); if(s) for(let k=0;k<3;k++) column[s.offset+3+k]+=sign*dot(axis,s.angular[k]) }
    // W has at most six nonzeros (two angular body blocks). Do not construct/project 45 dense velocity columns per tick.
    const indices=[...column.keys()].filter(i=>column[i]!==0)
    const projections=basis.map(b=>{let a=0;for(const i of indices) a+=column[i]*b.values[i];return a})
    columns.push({values:column,indices,projections})
  }
  const matrix=Array.from({length:n},()=>Array<number>(n).fill(0)),gravity=new Float64Array(d)
  for(const b of dynamic) { const s=slots.get(b.id)!; for(let k=0;k<3;k++) gravity[s.offset+k]=[scene.gravity.x,scene.gravity.y,scene.gravity.z][k]/s.linear }
  // Schur form W^T W - (Q^T W)^T(Q^T W), algebraically identical to W^T P W.
  // Reorthogonalised Q avoids dense P and redundant per-column projection. Tiny cancellation is numerical, not a compliance term.
  for(let i=0;i<n;i++) for(let j=0;j<=i;j++) {
    const a=columns[i],b=columns[j];let h=0
    for(const k of a.indices) h+=a.values[k]*b.values[k]
    for(let k=0;k<basis.length;k++) h-=a.projections[k]*b.projections[k]
    matrix[i][j]=matrix[j][i]=h
  }
  const projectedGravity=basis.map(b=>{let value=0;for(const i of b.indices) value+=b.values[i]*gravity[i];return value})
  const gravityAcceleration=columns.map(c=>{
    let value=0;for(const i of c.indices) value+=c.values[i]*gravity[i]
    for(let k=0;k<basis.length;k++) value-=c.projections[k]*projectedGravity[k]
    return value
  })
  return {matrix,gravityAcceleration,constraintRank:basis.length,contactRows,dimensions:d}
}
