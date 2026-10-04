/** Native Rapier one-tick constraint-response audit. No mocks, skips or expected failures.
 * Analytical values are independent uniform-link mass matrices; these fixtures do NOT replace the 30 s humanoid gates.
 */
import { it, expect } from 'vitest'
import { emitMeasurement } from './humanoid-physics-node.mjs'
import { rodInput } from './humanoid-balance-cases'
import { createSelectedSimulation } from '../src/sim/physics/selection'
import { STEP } from '../src/sim/physics/schema'
import { fromRotationVector } from '../src/sim/physics/math'
it('Rapier one- and two-link anchor response agrees with independent inertia and prints JSON before assertion',async()=>{
  const rows: {kind:string;pass:boolean;error:string|null;expectedRadps?:number[];actualRadps?:number[];absoluteErrorsRadps?:number[];metadata?:unknown;torquesNm?:number[]}[]=[]
  for(const kind of ['one-link','two-link']) {
    const input=rodInput();input.gravity={x:0,y:0,z:0}
    input.contact={solverIterations:16,allowedLinearError:.0002,predictionDistance:.001}
    if(kind==='two-link') {
      input.bodies.push({...input.bodies[1],id:'tip',position:{x:0,y:-3,z:0}})
      input.joints!.push({...input.joints![0],id:'elbow',parent:'rod',child:'tip',anchorParent:{x:0,y:-1,z:0}})
    }
    const row:typeof rows[number]={kind,pass:false,error:null};rows.push(row)
    let simulation:Awaited<ReturnType<typeof createSelectedSimulation>>|undefined
    try {
      simulation=await createSelectedSimulation(input);row.metadata=simulation.metadata()
      simulation.setMotorTargets({hinge:fromRotationVector({x:.1,y:0,z:0}),...(kind==='two-link'?{elbow:fromRotationVector({x:-.05,y:0,z:0})}:{})})
      simulation.advance(STEP)
      const torque=simulation.diagnostics().forces.motorTorques
      // Both target signs are prescribed; on this first, motionless, zero-gravity tick damping/stops cannot reverse them.
      const t1=torque.hinge,t2=kind==='two-link'?-torque.elbow:0
      const det=32.08*4.04-10.04**2
      const expected=kind==='one-link'?[STEP*t1/4.04]:[STEP*(4.04*t1-10.04*t2)/det,STEP*(-10.04*t1+32.08*t2)/det]
      const states=simulation.snapshot(),w1=states.find(s=>s.id==='rod')!.angularVelocity.x
      const actual=kind==='one-link'?[w1]:[w1,states.find(s=>s.id==='tip')!.angularVelocity.x-w1]
      const errors=actual.map((v,i)=>Math.abs(v-expected[i]))
      Object.assign(row,{expectedRadps:expected,actualRadps:actual,absoluteErrorsRadps:errors,torquesNm:kind==='one-link'?[t1]:[t1,t2]})
      // 2% relative +1e-5 rad/s numerical tolerance for one native discrete solve, not a stance/contact gate change.
      row.pass=simulation.diagnostics().tick===1&&errors.every((e,i)=>Number.isFinite(e)&&e<=.02*Math.abs(expected[i])+1e-5)
    } catch(e) {row.error=String(e instanceof Error?e.message:e)}
    finally {if(simulation) {try {simulation.dispose()} catch(e) {row.pass=false;row.error=`disposal: ${String(e)}`}}}
  }
  emitMeasurement({schema_version:1,kind:'humanoid-f1a2-native-anchor-response',stepS:STEP,rows,
    tolerance:'2% relative +1e-5 rad/s, independent anchored-link fixture only; not humanoid stance acceptance'})
  expect(rows).toHaveLength(2);expect(rows.every(r=>r.pass&&!r.error)).toBe(true)
},30_000)
