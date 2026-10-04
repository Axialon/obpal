/** Experimental fixed-tick stance targets. Not gait, push recovery, get-up or a hardware controller.
 * This module emits only the SAME versioned ActuationFrame consumed by ActuationGate. It cannot touch native bodies.
 */
import { STEP } from '../../physics/schema'
import { ZERO, add, sub, scale, capped, rotate, conjugate, multiply, fromRotationVector, clampCone, angleBetween, type Vec3 } from '../../physics/math'
import type { PhysicalHumanoid } from './model'
import type { Observation } from './observation'
import type { ActuationFrame } from './contract'
/** Original simulation defaults, not manufacturer ratings or measured stability claims. */
export const STANCE_CONTROL = Object.freeze({version:'contact-stance-v1',positionGain:4, // s^-2
  velocityGain:4, // s^-1, a nominal critically-damped 2 rad/s COM feedback, not a closed-loop proof.
  hipTiltGain:.2, // rad target bias / dimensionless torso-up horizontal component.
  maxAnkleBiasRad:.1,maxHipBiasRad:.08, // rad target biases.
  minUp:.8,minHeightFraction:.65, // dimensionless controller envelope; acceptance remains 0.98 / 0.9.
})
function centre(polygon: readonly Vec3[]): Vec3 | null {
  if(polygon.length<3) return null
  let twiceArea=0,x=0,z=0,y=0
  for(let i=0;i<polygon.length;i++) { const a=polygon[i],b=polygon[(i+1)%polygon.length],cross=a.x*b.z-b.x*a.z
    twiceArea+=cross;x+=(a.x+b.x)*cross;z+=(a.z+b.z)*cross;y+=a.y }
  // 1e-10 m^2 twice-area: numerical degeneracy cutoff, not a minimum support area.
  return Math.abs(twiceArea)>1e-10?{x:x/(3*twiceArea),y:y/polygon.length,z:z/(3*twiceArea)}:null
}
const finite = (v: Vec3) => v&&[v.x,v.y,v.z].every(Number.isFinite)
export interface StanceControlDiagnostics {
  version: string; phase: 'supported'|'no-support'|'outside-envelope'; supportCentre: Vec3|null; centreOfPressure: Vec3|null
  requestedMomentNm: Vec3; maxAnkleBiasRad: number; maxHipBiasRad: number
}
export class StanceController {
  private readonly model: PhysicalHumanoid
  private readonly mass: number
  private readonly initialComHeight: number
  constructor(model: PhysicalHumanoid, private readonly generation: number) {
    if(!Number.isSafeInteger(generation)||generation<1) throw new RangeError('Invalid stance generation')
    this.model=structuredClone(model);const dynamic=model.scene.bodies.filter(b=>!b.fixed)
    this.mass=dynamic.reduce((m,b)=>m+b.mass,0);this.initialComHeight=dynamic.reduce((y,b)=>y+b.mass*b.position.y,0)/this.mass
  }
  /** Stateless observation->target calculation: no wall clock, hidden integrator, heading accumulator or action queue.
   * The caller owns tick order, source arbitration and quiet/reset; ActuationGate enforces 4 rad/s and cone limits.
   */
  step(o: Observation): {frame: ActuationFrame;diagnostics: StanceControlDiagnostics} {
    const model=this.model
    // 1e-10 s is a fixed-tick timestamp comparison tolerance, not a freshness allowance.
    if(o.schema_version!==1||o.modelVersion!==model.version||o.profileId!==model.profileId||o.actorId!==model.actorId||o.generation!==this.generation||
      !Number.isSafeInteger(o.stateTick)||o.stateTick<0||o.stateTick===Number.MAX_SAFE_INTEGER||!Number.isFinite(o.timeS)||Math.abs(o.timeS-o.stateTick*STEP)>1e-10||
      !finite(o.com)||!finite(o.comVelocity)||!o.support.polygon.every(finite)) throw new RangeError('Stance observation identity/state mismatch')
    const bodies=new Map(o.bodies.map(b=>[b.id,b]))
    if(bodies.size!==o.bodies.length||model.scene.bodies.some(b=>!b.fixed&&!bodies.has(b.id))) throw new RangeError('Missing stance body')
    for(const b of bodies.values()) { const q=b.rotation;if(!finite(b.position)||!q||!Number.isFinite(Math.hypot(q.x,q.y,q.z,q.w))||Math.abs(Math.hypot(q.x,q.y,q.z,q.w)-1)>1e-4)
      throw new RangeError('Invalid stance body') }
    if(o.feet.length!==model.feet.length||new Set(o.feet.map(f=>f.id)).size!==model.feet.length||o.feet.some(f=>!model.feet.includes(f.id)||
      !Number.isFinite(f.normalImpulseNs)||f.normalImpulseNs<0||(f.normalImpulseNs>0&&!finite(f.centreOfPressure!)))) throw new RangeError('Invalid stance load')
    const targets=Object.fromEntries(model.scene.joints.map(j=>[j.id,{...j.motor.target}]))
    const diagnostics:StanceControlDiagnostics={version:STANCE_CONTROL.version,phase:'no-support',supportCentre:null,centreOfPressure:null,
      requestedMomentNm:{...ZERO},maxAnkleBiasRad:0,maxHipBiasRad:0}
    const frame:ActuationFrame={schema_version:1,profileId:model.profileId,actorId:model.actorId,generation:this.generation,tick:o.stateTick,source:'classical',targets}
    const support=centre(o.support.polygon),load=o.feet.reduce((n,f)=>n+f.normalImpulseNs,0)
    if(!Number.isFinite(load)) throw new RangeError('Stance load overflow')
    if(!support||load<=0) return {frame,diagnostics}
    const cop=scale(o.feet.reduce((v,f)=>f.normalImpulseNs>0?add(v,scale(f.centreOfPressure!,f.normalImpulseNs)):v,{...ZERO}),1/load)
    const up=rotate(bodies.get(model.root)!.rotation,{x:0,y:1,z:0}),height=o.com.y-cop.y
    diagnostics.supportCentre=support;diagnostics.centreOfPressure=cop
    if(up.y<STANCE_CONTROL.minUp||height<STANCE_CONTROL.minHeightFraction*this.initialComHeight) { diagnostics.phase='outside-envelope';return {frame,diagnostics} }
    diagnostics.phase='supported'
    const error=sub(o.com,support),lever=sub(o.com,cop),g=Math.max(0,-model.scene.gravity.y)
    const moment={x:this.mass*(g*lever.z+height*(STANCE_CONTROL.positionGain*error.z+STANCE_CONTROL.velocityGain*o.comVelocity.z)),y:0,
      z:-this.mass*(g*lever.x+height*(STANCE_CONTROL.positionGain*error.x+STANCE_CONTROL.velocityGain*o.comVelocity.x))}
    if(!finite(moment)) throw new RangeError('Stance moment overflow')
    diagnostics.requestedMomentNm=moment
    // Bias finite existing joint targets; all effort still uses the declared gains/caps and native joint reactions.
    for(const f of o.feet) {
      const share=f.normalImpulseNs/load
      for(const [child,bias,maxBias,kind] of [
        [f.id,moment,STANCE_CONTROL.maxAnkleBiasRad,'ankle'],
        [f.id.replace(/_foot$/,'_thigh'),{x:up.z*STANCE_CONTROL.hipTiltGain,y:0,z:-up.x*STANCE_CONTROL.hipTiltGain},STANCE_CONTROL.maxHipBiasRad,'hip'],
      ] as const) {
        const j=model.scene.joints.find(j=>j.child===child);if(!j) throw new RangeError('Missing stance drive')
        // 1e-9 N m/rad is an inverse-gain numerical floor; the pinned ankle gains are strictly positive.
        // Two balances the 1/2 load share of a symmetric two-foot stance; it is not another effort budget.
        const world=capped(scale(bias,kind==='ankle'?share/Math.max(j.motor.stiffness,1e-9):share*2),maxBias)
        const local=rotate(conjugate(multiply(bodies.get(j.parent)!.rotation,j.frameParent)),world)
        targets[j.id]=clampCone(multiply(fromRotationVector(local),j.motor.target),j.cone)
        const applied=angleBetween(targets[j.id],j.motor.target)
        if(kind==='ankle') diagnostics.maxAnkleBiasRad=Math.max(diagnostics.maxAnkleBiasRad,applied)
        else diagnostics.maxHipBiasRad=Math.max(diagnostics.maxHipBiasRad,applied)
      }
    }
    return {frame,diagnostics}
  }
}
