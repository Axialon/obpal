/** Articulation partition contracts; native impacts and stance are covered by the world and F1a2 suites. */
import { it, expect } from 'vitest'
import { constraintIslands, constraintResponse } from '../src/sim/physics/constraint-response'
import { coupledServo } from '../src/sim/physics/coupled-servo'
import { buildHumanoid } from '../src/sim/humanoid/physics/model'
import { validateScene, STEP, type ContactSample } from '../src/sim/physics/schema'
import { fromRotationVector } from '../src/sim/physics/math'
import { bodyStates, rodInput } from './humanoid-balance-cases'

function actors() {
  const a=buildHumanoid('keel-v1','seat1'),b=buildHumanoid('morrow-v1','seat2')
  const scene=validateScene({...a.scene,bodies:[...a.scene.bodies,...b.scene.bodies.filter(b=>!b.fixed)
    .map(b=>({...b,position:{...b.position,x:b.position.x+2}}))],joints:[...a.scene.joints,...b.scene.joints]})
  return {scene,states:bodyStates(scene),a,b}
}
function contact(a:string,b:string):ContactSample {
  return {a,b,pointA:{x:0,y:0,z:0},pointB:{x:0,y:0,z:0},normalOnB:{x:0,y:1,z:0},distance:0,impulse:1}
}
it('two full actors use two 96-dimensional responses, preserving dense diagonal blocks and floor rows',()=>{
  const {scene,states,a,b}=actors(),contacts=[contact('floor',a.feet[0]),contact('floor',b.feet[1])]
  const dense=constraintResponse(scene,states,contacts),islands=constraintIslands(scene,states,contacts)
  expect(islands).toHaveLength(2)
  let rank=0,rows=0
  for(let block=0;block<2;block++) {
    const island=islands[block],r=constraintResponse(island.scene,island.states,island.contacts)
    expect(r.dimensions).toBe(96);expect(island.scene.joints).toHaveLength(15);expect(island.contacts).toHaveLength(1)
    rank+=r.constraintRank;rows+=r.contactRows
    for(let i=0;i<45;i++) for(let j=0;j<45;j++) expect(r.matrix[i][j]).toBeCloseTo(dense.matrix[45*block+i][45*block+j],11)
    for(let i=0;i<45;i++) expect(r.gravityAcceleration[i]).toBeCloseTo(dense.gravityAcceleration[45*block+i],11)
  }
  expect(rank).toBe(dense.constraintRank);expect(rows).toBe(dense.contactRows)
  for(let i=0;i<45;i++) for(let j=45;j<90;j++) expect(dense.matrix[i][j]).toBe(0)
})
it('two-actor solve gives identical per-actor torques to separate solves with stops and saturation',()=>{
  const {scene,states,a,b}=actors(),contacts=[contact('floor',a.feet[0]),contact('floor',b.feet[1])]
  for(const s of states) if(s.id!=='floor') {s.rotation=fromRotationVector({x:.15,y:.2,z:-.1});s.angularVelocity={x:3,y:-2,z:4}}
  const targets=new Map(scene.joints.map(j=>[j.id,fromRotationVector({x:.3,y:0,z:.1})]))
  const combined=coupledServo(scene,states,targets,contacts,STEP),separate=constraintIslands(scene,states,contacts)
    .map(i=>coupledServo(i.scene,i.states,targets,i.contacts,STEP))
  expect(combined.diagnostics.saturatedJoints).toBeGreaterThan(0)
  for(const r of separate) for(const [id,torque] of r.torques) expect(combined.torques.get(id)).toEqual(torque)
  expect(combined.diagnostics.constraintRank).toBe(separate.reduce((n,r)=>n+r.diagnostics.constraintRank,0))
  expect(combined.diagnostics.dimensions).toBe(192);expect(combined.diagnostics.relativeResidual).toBeLessThan(1e-8)
})
it('a shared fixed anchor does not join independent dynamic articulations',()=>{
  const input=rodInput();input.bodies.push({...input.bodies[1],id:'other',position:{x:2,y:-1,z:0}})
  input.joints!.push({...input.joints![0],id:'other_joint',child:'other',anchorParent:{x:2,y:0,z:0}})
  const scene=validateScene(input),islands=constraintIslands(scene,bodyStates(scene),[])
  expect(islands).toHaveLength(2);expect(islands.map(i=>i.scene.joints.length)).toEqual([1,1])
  for(const island of islands) expect(island.scene.bodies.some(b=>b.id==='base')).toBe(true)
})
it('inter-actor impacts remain native and cannot become bilateral support constraints',()=>{
  const {scene,states,a,b}=actors(),impact=contact(a.feet[0],b.feet[0])
  const before=coupledServo(scene,states,new Map(),[],STEP),during=coupledServo(scene,states,new Map(),[impact],STEP)
  expect(during).toEqual(before);expect(constraintIslands(scene,states,[impact])).toHaveLength(2)
  expect(()=>coupledServo(scene,states,new Map(),[{...impact,impulse:NaN}],STEP)).toThrow(/contact sample/)
  expect(()=>coupledServo(scene,states,new Map(),[{...impact,b:'unknown'}],STEP)).toThrow(/contact sample/)
  expect(()=>coupledServo(scene,[...states,states[1]],new Map(),[],STEP)).toThrow(/state/)
})
it('a joint between dynamic branches produces one coupled island',()=>{
  const input=rodInput();input.bodies.push({...input.bodies[1],id:'tip',position:{x:0,y:-3,z:0}})
  input.joints!.push({...input.joints![0],id:'elbow',parent:'rod',child:'tip',anchorParent:{x:0,y:-1,z:0}})
  const scene=validateScene(input),states=bodyStates(scene),islands=constraintIslands(scene,states,[])
  expect(islands).toHaveLength(1);expect(islands[0].scene).toBe(scene);expect(islands[0].states).toBe(states)
  expect(constraintResponse(scene,states,[]).matrix[0][3]).not.toBe(0)
})
