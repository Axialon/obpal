/** Original opt-in coupled backward-Euler torque prediction. No root force, state write or native constraint replacement. */
import { constraintResponse } from './constraint-response'
import { add, sub, scale, dot, norm, unit, capped, multiply, conjugate, rotate, rotationVector, clampCone, type Vec3, type Quat } from './math'
import type { Scene, BodyState, ContactSample } from './schema'
export interface CoupledDiagnostics { constraintRank: number; contactRows: number; dimensions: number; saturatedJoints: number; relativeResidual: number; appliedRelativeResidual: number }
function solveSPD(a: number[][], rhs: number[]): number[] {
  const n=rhs.length,l=Array.from({length:n},()=>new Float64Array(n))
  for(let i=0;i<n;i++) for(let j=0;j<=i;j++) {
    let v=a[i][j];for(let k=0;k<j;k++) v-=l[i][k]*l[j][k]
    if(i===j) { if(!Number.isFinite(v)||v<=0) throw new Error('Coupled servo matrix is not positive definite'); l[i][j]=Math.sqrt(v) }
    else l[i][j]=v/l[j][j]
  }
  const y=new Float64Array(n),x=Array<number>(n).fill(0)
  for(let i=0;i<n;i++) { let v=rhs[i];for(let j=0;j<i;j++) v-=l[i][j]*y[j];y[i]=v/l[i][i] }
  for(let i=n-1;i>=0;i--) { let v=y[i];for(let j=i+1;j<n;j++) v-=l[j][i]*x[j];x[i]=v/l[i][i] }
  if(x.some(v=>!Number.isFinite(v))) throw new Error('Non-finite coupled servo solution')
  return x
}
/** H contains cross-joint effects. Solve (H+C^-1) tau=C^-1 rhs; this preserves the non-commuting stop order.
 * C includes motor and outward-only stop damping ONCE. Per-joint torque balls are capped after solving.
 * Coriolis, native friction transitions, future contact impulses and saturation are not solved by this local model.
 */
export function coupledServo(scene: Scene, states: readonly BodyState[], targets: ReadonlyMap<string,Quat>, contacts: readonly ContactSample[], dt: number) {
  if(!Number.isFinite(dt)||dt<=0||dt>.05) throw new RangeError('Invalid coupled servo timestep')
  const response=constraintResponse(scene,states,contacts),current=new Map(states.map(s=>[s.id,s])),n=scene.joints.length*3
  const a=response.matrix.map(row=>[...row]),rhs=Array<number>(n).fill(0)
  for(let i=0;i<scene.joints.length;i++) {
    const j=scene.joints[i],m=j.motor,parent=current.get(j.parent)!,child=current.get(j.child)!
    const frame=multiply(parent.rotation,j.frameParent),relative=multiply(conjugate(frame),multiply(child.rotation,j.frameChild))
    const target=targets.get(j.id)??m.target,error=rotate(frame,rotationVector(multiply(target,conjugate(relative))))
    const g={x:response.gravityAcceleration[3*i],y:response.gravityAcceleration[3*i+1],z:response.gravityAcceleration[3*i+2]}
    const velocity=add(sub(child.angularVelocity,parent.angularVelocity),scale(g,dt))
    const stop=rotate(frame,rotationVector(multiply(clampCone(relative,j.cone),conjugate(relative))))
    const c=m.damping*dt+m.stiffness*dt*dt
    if(!(c>0)||!Number.isFinite(c)) throw new RangeError('Coupled servo requires positive impedance')
    let f=sub(scale(error,m.stiffness),scale(velocity,m.damping+m.stiffness*dt)),direction: Vec3={x:0,y:0,z:0},stopC=0
    if(norm(stop)>1e-8) { direction=unit(stop); const speed=dot(velocity,direction),stopD=speed<0?30:0
      f=add(f,scale(direction,1200*norm(stop)-(stopD+1200*dt)*speed));stopC=stopD*dt+1200*dt*dt }
    const ns=[direction.x,direction.y,direction.z],fv=[f.x,f.y,f.z]
    for(let r=0;r<3;r++) for(let k=0;k<3;k++) {
      const inverse=(r===k?1/c:0)-(stopC/(c*(c+stopC)))*ns[r]*ns[k]
      a[3*i+r][3*i+k]+=inverse;rhs[3*i+r]+=inverse*fv[k]
    }
  }
  const x=solveSPD(a,rhs)
  let residual=0,scaleRhs=1,saturatedJoints=0
  for(let i=0;i<n;i++) { let value=-rhs[i];for(let j=0;j<n;j++) value+=a[i][j]*x[j];residual=Math.max(residual,Math.abs(value));scaleRhs=Math.max(scaleRhs,Math.abs(rhs[i])) }
  const torques=new Map<string,Vec3>()
  for(let i=0;i<scene.joints.length;i++) { const j=scene.joints[i],v={x:x[3*i],y:x[3*i+1],z:x[3*i+2]}
    if(norm(v)>j.motor.maxTorque) saturatedJoints++
    torques.set(j.id,capped(v,j.motor.maxTorque)) }
  // Saturation intentionally breaks the unconstrained implicit solve. Expose that gap; do not hide it behind a small algebra residual.
  const applied=scene.joints.flatMap(j=>{const v=torques.get(j.id)!;return [v.x,v.y,v.z]})
  let appliedResidual=0
  for(let i=0;i<n;i++) {let value=-rhs[i];for(let j=0;j<n;j++) value+=a[i][j]*applied[j];appliedResidual=Math.max(appliedResidual,Math.abs(value))}
  return {torques,diagnostics:{constraintRank:response.constraintRank,contactRows:response.contactRows,dimensions:response.dimensions,
    saturatedJoints,relativeResidual:residual/scaleRhs,appliedRelativeResidual:appliedResidual/scaleRhs} satisfies CoupledDiagnostics}
}
